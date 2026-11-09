// Shared store backed by a Google Sheet (Apps Script web app). No Claude account needed.
const BOOL = ["needsCheck", "needsLabel", "labelPrinted", "hasPhoto", "fromOrder", "printed", "deleted"];
const NUM = ["qty", "at", "updatedAt", "createdAt"];
const TABLE = { items: "items", boxes: "boxes" };

function lsGet(k, d) { try { const v = localStorage.getItem("inv:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem("inv:" + k, JSON.stringify(v)); } catch {} }

function norm(r) {
  const o = {};
  for (const [k, v] of Object.entries(r || {})) {
    if (v === "" || v == null) continue;
    if (BOOL.includes(k)) { const b = v === true || String(v).toLowerCase() === "true"; if (b) o[k] = true; continue; }
    if (NUM.includes(k)) { const n = Number(v); if (Number.isFinite(n)) o[k] = n; continue; }
    if (k === "codes") { try { const a = JSON.parse(v); if (Array.isArray(a)) o[k] = a; } catch {} continue; }
    o[k] = String(v);
  }
  return o;
}

export function sheetStore({ api, key, onStatus, onPresence, getMe }) {
  const cache = { items: new Map(), boxes: new Map() };
  const subs = { items: [], boxes: [], catalog: [] };
  let catalogDocs = [];
  let since = 0, ov = null, busy = false, flushing = false, timer = null;
  let outbox = lsGet("outbox", []);
  const status = { online: null, error: "", pending: outbox.length, lastSync: 0 };
  const report = () => { status.pending = outbox.length; onStatus?.({ ...status }); };

  async function call(op, body = {}) {
    const r = await fetch(api, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ key, op, ...body }), redirect: "follow" });
    if (!r.ok) throw { code: "http", message: "HTTP " + r.status };
    const j = await r.json();
    if (j.error) throw { code: j.error === "wrong team code" ? "bad_key" : "server", message: j.error };
    return j;
  }

  const visible = (c) => [...cache[c].values()].filter((d) => !d.deleted);
  const push = (c) => { const list = c === "catalog" ? catalogDocs : visible(c); subs[c].forEach((cb) => cb(list)); };
  function applyLocal(op) {
    if (op.op === "upsert") for (const r of op.rows) cache[op.table].set(r.id, { ...(cache[op.table].get(r.id) || { id: r.id }), ...r });
    if (op.op === "delete") for (const id of op.ids) { const d = cache[op.table].get(id); if (d) cache[op.table].set(id, { ...d, deleted: true }); }
  }
  function enqueue(op) {
    // coalesce with a waiting upsert of the same table
    const last = outbox[outbox.length - 1];
    if (op.op === "upsert" && last && last.op === "upsert" && last.table === op.table && !last.sending && last.rows.length < 40) {
      for (const r of op.rows) {
        const i = last.rows.findIndex((x) => x.id === r.id);
        if (i >= 0) last.rows[i] = { ...last.rows[i], ...r }; else last.rows.push(r);
      }
    } else outbox.push(op);
    applyLocal(op);
    lsSet("outbox", outbox.filter((o) => o.op !== "setPhoto"));
    push(op.table || "items"); report();
    flush();
  }
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (outbox.length) {
        const op = outbox[0];
        op.sending = true;
        try {
          if (op.op === "upsert") await call("upsert", { table: TABLE[op.table], rows: op.rows });
          else if (op.op === "delete") await call("delete", { table: TABLE[op.table], ids: op.ids });
          else if (op.op === "setPhoto") await call("setPhoto", { id: op.id, data: op.data });
          else if (op.op === "addOrders") await call("addOrders", { rows: op.rows });
          else if (op.op === "delOrders") await call("delOrders", { imp: op.imp });
          outbox.shift();
          lsSet("outbox", outbox.filter((o) => o.op !== "setPhoto"));
          status.online = true; status.error = ""; report();
        } catch (e) {
          op.sending = false;
          status.online = false; status.error = e?.code === "bad_key" ? "bad_key" : "offline"; report();
          break;
        }
      }
    } finally { flushing = false; }
    if (!outbox.length) setTimeout(sync, 400);
  }
  async function sync() {
    if (busy) return;
    busy = true;
    try {
      const j = await call("sync", { since: since ? since - 4000 : 0, me: getMe?.() });
      let changed = { items: false, boxes: false };
      for (const c of ["items", "boxes"]) for (const raw of j[c] || []) { const d = norm(raw); if (!d.id) continue; cache[c].set(d.id, d); changed[c] = true; }
      for (const op of outbox) applyLocal(op); // keep unsent edits on top
      since = j.now;
      status.online = true; if (status.error !== "bad_key") status.error = ""; status.lastSync = Date.now(); report();
      if (changed.items || !status.loadedOnce) push("items");
      if (changed.boxes || !status.loadedOnce) push("boxes");
      status.loadedOnce = true;
      onPresence?.(j.presence || [], j.now);
      if (j.ov !== ov) { ov = j.ov; loadOrders(); }
    } catch (e) {
      status.online = false; status.error = e?.code === "bad_key" ? "bad_key" : "offline"; report();
    } finally { busy = false; }
    if (outbox.length) flush();
  }
  async function loadOrders() {
    try {
      const j = await call("orders");
      const byImp = new Map();
      for (const r of j.rows || []) {
        const imp = String(r.imp || "");
        const doc = byImp.get(imp) || { id: imp + "-0", imp, file: String(r.file || ""), supplier: String(r.supplier || ""), at: Number(r.at) || 0, by: String(r.by || ""), rows: [] };
        doc.rows.push({ s: String(r.s || ""), sp: String(r.sp || ""), m: String(r.m || ""), mf: String(r.mf || ""), d: String(r.d || ""), q: r.q === "" ? null : Number(r.q) });
        byImp.set(imp, doc);
      }
      catalogDocs = [...byImp.values()];
      push("catalog");
    } catch {}
  }
  function loop() {
    clearTimeout(timer);
    const delay = document.visibilityState === "visible" ? 6000 : 30000;
    timer = setTimeout(async () => { await sync(); loop(); }, delay);
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { sync(); loop(); } });

  const api_ = {
    kind: "sheet",
    status,
    ping: () => call("ping"),
    listen(c, cb) { subs[c].push(cb); setTimeout(() => cb(c === "catalog" ? catalogDocs : visible(c)), 0); },
    async get(c, id) {
      if (c === "photos") {
        const pend = outbox.find((o) => o.op === "setPhoto" && o.id === id);
        if (pend) return { data: pend.data };
        const j = await call("photo", { id }); return j.data ? { data: j.data } : null;
      }
      return cache[c]?.get(id) || null;
    },
    async set(c, id, d) {
      if (c === "photos") { outbox.push({ op: "setPhoto", id, data: d.data }); report(); flush(); return; }
      if (c === "catalog") { enqueueOrders(d); return; }
      enqueue({ op: "upsert", table: c, rows: [{ ...d, id, deleted: false }] });
    },
    async update(c, id, d) { enqueue({ op: "upsert", table: c, rows: [{ ...d, id }] }); },
    async del(c, id) {
      if (c === "photos") return;
      if (c === "catalog") { const imp = String(id).replace(/-\d+$/, ""); catalogDocs = catalogDocs.filter((x) => x.imp !== imp); push("catalog"); outbox.push({ op: "delOrders", imp }); flush(); return; }
      enqueue({ op: "delete", table: c, ids: [id] });
    },
    async exists(c, id) { const d = cache[c]?.get(id); return !!(d && !d.deleted); },
    syncNow: sync,
    start() { sync(); loop(); if (outbox.length) flush(); },
  };
  function enqueueOrders(doc) {
    const rows = (doc.rows || []).map((r) => ({ imp: doc.imp, file: doc.file, supplier: doc.supplier, at: doc.at, by: doc.by, ...r }));
    const existing = catalogDocs.find((x) => x.imp === doc.imp);
    if (existing) existing.rows.push(...doc.rows); else catalogDocs.push({ ...doc, id: doc.imp + "-0", rows: [...doc.rows] });
    push("catalog");
    outbox.push({ op: "addOrders", rows });
    lsSet("outbox", outbox.filter((o) => o.op !== "setPhoto"));
    report(); flush();
  }
  return api_;
}
