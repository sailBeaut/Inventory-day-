// Shared store backed by a Google Sheet (Apps Script web app). No Claude account needed.
const BOOL = ["needsCheck", "needsLabel", "labelPrinted", "hasPhoto", "fromOrder", "printed", "deleted"];
const NUM = ["qty", "at", "updatedAt", "createdAt", "count", "countedAt"];
const TABLE = { items: "items", boxes: "boxes" };
// Fields an outdated sheet script (before version 3) silently drops. They are also kept on this phone until the sheet
// returns them, and sent again once the script is updated — so a count typed in is never lost.
const HELD = ["count", "countStatus", "countedBy", "countedAt", "list", "readFrom"];

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
  // held[table][id] = { fields…, _t } — fields the sheet hasn't confirmed yet
  const held = lsGet("held", { items: {}, boxes: {} });
  const srv = { items: new Map(), boxes: new Map() }; // rows exactly as the sheet last sent them
  const saveHeld = () => lsSet("held", held);
  function hold(table, r) {
    const f = {};
    for (const k of HELD) if (k in r) f[k] = r[k];
    if (!Object.keys(f).length) return;
    held[table] = held[table] || {};
    held[table][r.id] = { ...(held[table][r.id] || {}), ...f, _t: Date.now(), _sent: 0 };
    saveHeld();
  }
  const same = (a, b) => (a ?? "") === (b ?? "") || (a != null && b != null && String(a) === String(b));
  // after a sync: drop what the sheet confirms, keep the rest on top, and re-send it if the script can store it now
  function reconcile(c, d) {
    const h = held[c]?.[d.id];
    if (!h) return d;
    const left = Object.keys(h).filter((k) => !k.startsWith("_") && !same(d[k], h[k]));
    if (!left.length) { delete held[c][d.id]; saveHeld(); return d; }
    if (status.version >= 3 && Date.now() - (h._sent || 0) > 60000 && !outbox.some((o) => o.op === "upsert" && o.table === c && o.rows.some((r) => r.id === d.id))) {
      h._sent = Date.now(); saveHeld();
      const row = { id: d.id }; for (const k of left) row[k] = h[k];
      outbox.push({ op: "upsert", table: c, rows: [row] });
    }
    const o = { ...d }; for (const k of left) o[k] = h[k];
    return o;
  }
  const heldCount = () => Object.values(held).reduce((n, t) => n + Object.keys(t || {}).length, 0);

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
    if (op.op === "upsert") for (const r of op.rows) hold(op.table, r);
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
      status.version = Number(j.version) || 1;
      status.oldScript = status.version < 3;
      for (const c of ["items", "boxes"]) for (const raw of j[c] || []) { const d = norm(raw); if (!d.id) continue; srv[c].set(d.id, d); cache[c].set(d.id, reconcile(c, d)); changed[c] = true; }
      // rows that haven't changed on the sheet still need their held fields re-sent after a script update
      if (status.version >= 3) for (const c of ["items", "boxes"]) for (const id of Object.keys(held[c] || {})) { const d = srv[c].get(id); if (d) { cache[c].set(id, reconcile(c, d)); for (const op of outbox) if (op.op === "upsert" && op.table === c && op.rows.some((r) => r.id === id)) applyLocal(op); } }
      status.held = heldCount();
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
