import { readBarcodes, prepareZXingModule } from "zxing-wasm/reader";
import wasmBin from "../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm";
import { jsPDF } from "jspdf";
import qrcode from "qrcode-generator";
import * as XLSX from "xlsx";
import { interpret, printable, BOX_PREFIX, PART_PREFIX, parseOrderRows, guessCategory, parseLabelText, resolveBarcodes, classifyCaption, parseFarnellBarcode, captionValues, WH_CATEGORIES } from "./parse.js";
import { sheetStore } from "./sheet.js";
import { findLabelRegion, blankStripes } from "./region.js";
import SCRIPT_SOURCE from "./Code.gs";

prepareZXingModule({
  overrides: { wasmBinary: wasmBin.buffer.slice(wasmBin.byteOffset, wasmBin.byteOffset + wasmBin.byteLength) },
  fireImmediately: true,
});

/* ================= helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const ls = {
  get(k, d) { try { const v = localStorage.getItem("inv:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("inv:" + k, JSON.stringify(v)); } catch {} },
};
function toast(msg, kind = "") {
  const t = h("div", { class: "toast " + kind }, msg);
  $("#toasts").append(t);
  setTimeout(() => t.classList.add("out"), 2800);
  setTimeout(() => t.remove(), 3300);
}
const pad = (n) => String(n).padStart(3, "0");
const today = () => new Date().toISOString().slice(0, 10);
const fmtTime = (ms) => new Date(ms).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const U = (s) => String(s || "").trim().toUpperCase();
const SPN = (s) => U(s).replace(/[\s\-]/g, ""); // 155-1908 = 1551908
// barcode types that appear on part and bag labels (leaving out exotic ones that cause false reads, e.g. DX film edge)
const LABEL_FORMATS = ["DataMatrix", "QRCode", "MicroQRCode", "PDF417", "Aztec", "Code128", "Code39", "Code93", "Codabar", "ITF", "EAN-13", "EAN-8", "UPC-A", "UPC-E", "DataBar", "DataBarExpanded"];
const is2DFormat = (f) => /DataMatrix|QR|PDF417|Aztec|MaxiCode/.test(f || "");
const FIELD_LABEL = { mpn: "MPN", qty: "qty", supplierPn: "supplier PN", description: "description", manufacturer: "manufacturer", lot: "lot", dateCode: "date code", line: "line", po: "PO", order: "order", coo: "country" };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function fileInput(opts, onFiles) {
  return h("input", { type: "file", accept: "image/*", class: "hidden", ...opts, onchange: (e) => { const f = [...e.target.files]; e.target.value = ""; if (f.length) onFiles(f); } });
}

const CATEGORIES = ["Resistor", "Capacitor", "Inductor", "Diode/LED", "Transistor/MOSFET", "IC", "Microcontroller", "Connector", "Cable/Wire", "Crystal/Oscillator", "Fuse/Protection", "Switch/Button", "Sensor", "Module/PCB", "Mechanical", "Other"];
// Two separate lists: electrical / PCB parts, and wiring-harness (WH) parts. Each has its own boxes (B001… / W001…).
const LISTS = { el: { name: "Electrical", prefix: "B" }, wh: { name: "Wiring harness (WH)", prefix: "W" } };
const listOf = (x) => (x && x.list === "wh" ? "wh" : "el");
const catsFor = (l) => (l === "wh" ? WH_CATEGORIES : CATEGORIES);
const FIELDS = [
  ["description", "Description"], ["category", "Category"], ["manufacturer", "Manufacturer"], ["mpn", "Manufacturer PN"],
  ["supplier", "Supplier"], ["supplierPn", "Supplier PN"], ["qty", "Label qty (not verified)"], ["notes", "Notes"],
];

/* ================= store ================= */
const state = { items: [], boxes: [], catalogChunks: [], me: null, mode: "starting", readOnly: false, names: {}, peers: [] };
let store = null;
let renderQueued = false;
function emit() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); }

function localStore() {
  const cols = ["items", "boxes", "catalog", "photos"];
  const data = Object.fromEntries(cols.map((c) => [c, c === "photos" ? {} : ls.get("local:" + c, {})]));
  const subs = Object.fromEntries(cols.map((c) => [c, []]));
  const list = (c) => Object.entries(data[c]).map(([id, d]) => ({ id, ...d }));
  const push = (c) => { if (c !== "photos") ls.set("local:" + c, data[c]); subs[c].forEach((cb) => cb(list(c))); };
  return {
    listen(c, cb) { subs[c].push(cb); setTimeout(() => cb(list(c)), 0); },
    async get(c, id) { return data[c][id] ? { ...data[c][id] } : null; },
    async set(c, id, d) { data[c][id] = { ...d }; push(c); },
    async update(c, id, d) { data[c][id] = { ...(data[c][id] || {}), ...d }; push(c); },
    async del(c, id) { delete data[c][id]; push(c); },
    async exists(c, id) { return !!data[c][id]; },
  };
}
function sharedStore(db) {
  return {
    listen(c, cb, onErr) { return db.collection(c).onSnapshot((s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() })), s.metadata), onErr); },
    async get(c, id) { const s = await db.collection(c).doc(id).get(); return s.exists ? s.data() : null; },
    set: (c, id, d) => db.collection(c).doc(id).set(d),
    update: (c, id, d) => db.collection(c).doc(id).update(d),
    del: (c, id) => db.collection(c).doc(id).delete(),
    async exists(c, id) { return (await db.collection(c).doc(id).get()).exists; },
  };
}
async function write(fn, quiet) {
  try { await fn(); return true; }
  catch (e) {
    const code = e?.code;
    if (code === "invalid_argument" && state.mode === "shared") {
      state.readOnly = true; emit();
      toast("You can view this list but not change it — see the Setup tab.", "err");
    } else if (code === "quota_exceeded") toast("Storage is full: " + (e.message || ""), "err");
    else if (!quiet) toast("Could not save" + (code ? ` (${code})` : ""), "err");
    return false;
  }
}

/* ================= capabilities ================= */
let downloads = null, sample = null, userCap = null, room = null, canImages = false;

/* ---- standalone (no Claude) config ---- */
const INCLAUDE = !!window.claude;
let cfg = ls.get("cfg", {});
let dev = ls.get("dev", "");
if (!dev) { dev = newId(); ls.set("dev", dev); }
(function readInvite() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get("api") && q.get("key")) {
      cfg = { ...cfg, api: q.get("api"), key: q.get("key") };
      ls.set("cfg", cfg);
      history.replaceState(null, "", location.pathname + location.hash);
    }
  } catch {}
})();
state.sheetStatus = {};

async function init() {
  render();
  if (!INCLAUDE) return initStandalone();
  const c = window.claude;
  const [db, dl, sm, us, rm] = c ? await Promise.all(["db", "downloads", "sample", "user", "room"].map((n) => c.use(n).catch(() => null))) : [];
  downloads = dl || null; sample = sm || null; userCap = us || null; room = rm || null;
  if (sample) { try { canImages = !!(await sample.limits())?.images; } catch { canImages = false; } }
  if (userCap) {
    try { state.me = await userCap.id(); } catch {}
    try { if (userCap.can?.("data.write") === false) state.readOnly = true; } catch {}
    try { state.isOwner = !!userCap.isOwner?.(); } catch {}
  }
  if (db) {
    store = sharedStore(db); state.mode = "shared";
    let got = false;
    const timer = setTimeout(() => { if (!got) { state.slow = true; emit(); } }, 10000);
    const onErr = (e) => { clearTimeout(timer); state.dbError = e?.code || "error"; emit(); };
    store.listen("items", (docs, meta) => { if (!meta?.fromCache) { got = true; clearTimeout(timer); state.slow = false; } state.items = docs; resolveNames(docs.map((i) => i.by)); emit(); }, onErr);
    store.listen("boxes", (docs) => { state.boxes = docs; emit(); }, onErr);
    store.listen("catalog", (docs) => { state.catalogChunks = docs; buildCatalog(); emit(); }, onErr);
  } else {
    store = localStore(); state.mode = "local";
    store.listen("items", (docs) => { state.items = docs; emit(); });
    store.listen("boxes", (docs) => { state.boxes = docs; emit(); });
    store.listen("catalog", (docs) => { state.catalogChunks = docs; buildCatalog(); emit(); });
  }
  if (room) {
    room.onPeers(({ peers }) => { state.peers = peers; resolveNames(peers.map((p) => p.by || p.presence?.me)); emit(); }, () => { state.peers = []; emit(); });
    sendPresence();
  }
  emit();
}

function initStandalone() {
  if (cfg.api && cfg.key && cfg.name) {
    state.mode = "sheet"; state.me = cfg.name;
    store = sheetStore({
      api: cfg.api, key: cfg.key,
      onStatus: (st) => { state.sheetStatus = st; emit(); },
      onPresence: (list) => {
        state.peers = list.map((p) => ({ kind: "viewer", peer: p.dev, by: p.name || "Someone", isMe: p.dev === dev, presence: { box: p.box, n: p.n }, updatedAt: p.at }));
        emit();
      },
      getMe: () => ({ dev, name: cfg.name, box: currentBox || "", n: sessionCount }),
    });
    store.listen("items", (docs) => { state.items = docs; emit(); });
    store.listen("boxes", (docs) => { state.boxes = docs; emit(); });
    store.listen("catalog", (docs) => { state.catalogChunks = docs; buildCatalog(); emit(); });
    store.start();
  } else {
    state.mode = cfg.api && cfg.key ? "join" : "local";
    if (state.mode === "join") tab = "scan";
    store = localStore();
    store.listen("items", (docs) => { state.items = docs; emit(); });
    store.listen("boxes", (docs) => { state.boxes = docs; emit(); });
    store.listen("catalog", (docs) => { state.catalogChunks = docs; buildCatalog(); emit(); });
  }
  emit();
}
async function connectSheet(api, key, name, btn) {
  api = String(api || "").trim(); key = String(key || "").trim(); name = String(name || "").trim();
  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(api) && !/^http:\/\/localhost[:/]/.test(api)) { toast("Paste the Web app URL — it starts with https://script.google.com/", "err"); return; }
  if (!key || !name) { toast("Fill in the team code and your name.", "err"); return; }
  if (btn) { btn.disabled = true; btn.textContent = "Connecting…"; }
  try {
    const t = sheetStore({ api, key });
    const j = await t.ping();
    cfg = { api, key, name, sheet: j.sheet || "", url: j.url || "" };
    ls.set("cfg", cfg);
    location.reload();
  } catch (e) {
    toast(e?.code === "bad_key" ? "Wrong team code." : "Couldn't reach the sheet. Check the URL and that access is set to “Anyone”.", "err");
    if (btn) { btn.disabled = false; btn.textContent = "Connect"; }
  }
}
const inviteUrl = () => location.origin + location.pathname + "?api=" + encodeURIComponent(cfg.api || "") + "&key=" + encodeURIComponent(cfg.key || "");

async function resolveNames(ids) {
  if (!userCap?.profiles) return;
  const need = [...new Set(ids.filter(Boolean))].filter((id) => !(id in state.names));
  if (!need.length) return;
  need.forEach((id) => (state.names[id] = ""));
  try { const ps = await userCap.profiles(need); for (const id of need) state.names[id] = ps?.[id]?.name || ""; emit(); } catch {}
}
const nameOf = (id) => (id && id === state.me ? "You" : (id && state.names[id]) || (id ? "Teammate" : ""));
const realName = (id) => (id && state.names[id]) || (state.mode === "sheet" && id) || (id === state.me ? "Me" : id ? "Teammate" : "");

/* ================= presence (who is counting now) ================= */
let sessionCount = 0;
function sendPresence() { room?.presence({ box: currentBox || null, n: sessionCount, me: state.me || null, tab }).catch(() => {}); if (state.mode === "sheet") { clearTimeout(sendPresence.t); sendPresence.t = setTimeout(() => store.syncNow?.(), 800); } }
function teamNow() {
  const byPerson = new Map();
  for (const p of state.peers) {
    if (p.kind !== "viewer") continue;
    const id = p.by || p.presence?.me || p.peer;
    const cur = byPerson.get(id) || { id, isMe: p.isMe, boxes: new Set(), n: 0, at: 0 };
    if (p.presence?.box) cur.boxes.add(String(p.presence.box).slice(0, 12));
    cur.n += Number(p.presence?.n) || 0;
    cur.at = Math.max(cur.at, p.updatedAt || 0);
    cur.isMe = cur.isMe || p.isMe;
    byPerson.set(id, cur);
  }
  return [...byPerson.values()].sort((a, b) => (b.isMe ? 1 : 0) - (a.isMe ? 1 : 0));
}

/* ================= boxes ================= */
const boxByCode = (code) => state.boxes.find((b) => b.id === code);
let currentBox = ls.get("currentBox", "");
let currentList = ls.get("list", "el") === "wh" ? "wh" : "el";
function setList(l) {
  currentList = l === "wh" ? "wh" : "el"; ls.set("list", currentList);
  if (currentBox && listOf(boxByCode(currentBox)) !== currentList) { currentBox = ""; ls.set("currentBox", ""); }
  filterBox = ""; sendPresence(); emit();
}
function setCurrentBox(code) {
  currentBox = code; ls.set("currentBox", code);
  const b = boxByCode(code);
  if (b && listOf(b) !== currentList) { currentList = listOf(b); ls.set("list", currentList); toast(`Switched to the ${LISTS[currentList].name} list`, "ok"); }
  sendPresence(); emit();
}
const listForBoxCode = (code) => (/^W\d+$/i.test(code || "") ? "wh" : "el");
const itemListNow = () => (currentBox && boxByCode(currentBox) ? listOf(boxByCode(currentBox)) : currentList);
function maxBoxNum(prefix) { let m = 0; for (const b of state.boxes) { const x = new RegExp("^" + prefix + "(\\d+)$").exec(b.id); if (x) m = Math.max(m, Number(x[1])); } return m; }
async function addBoxes(names) {
  const made = [];
  const prefix = LISTS[currentList].prefix;
  let n = maxBoxNum(prefix);
  for (let i = 0; i < names.length; i++) {
    let code;
    do { n++; code = prefix + pad(n); } while (state.boxes.some((b) => b.id === code) || ((state.mode === "shared" || state.mode === "sheet") && (await store.exists("boxes", code))));
    const ok = await write(() => store.set("boxes", code, { name: names[i] || "", location: "", printed: false, createdAt: Date.now(), by: state.me || "", list: currentList }));
    if (!ok) break;
    made.push(code);
  }
  return made;
}
function suggestBoxName(code) {
  const counts = {};
  for (const i of state.items) if (i.box === code && i.category) counts[i.category] = (counts[i.category] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c.replace("/", " & ")).join(", ");
}

/* ================= order-history catalog ================= */
let catalog = { byMpn: new Map(), bySpn: new Map(), rows: [], imports: [] };
function buildCatalog() {
  const byMpn = new Map(), bySpn = new Map(), rows = [], imports = new Map();
  for (const ch of state.catalogChunks) {
    const imp = imports.get(ch.imp) || { imp: ch.imp, file: ch.file, supplier: ch.supplier, at: ch.at, by: ch.by, n: 0, chunks: [] };
    imp.n += (ch.rows || []).length; imp.chunks.push(ch.id); imports.set(ch.imp, imp);
    for (const r of ch.rows || []) {
      rows.push(r);
      if (r.m && !byMpn.has(U(r.m))) byMpn.set(U(r.m), r);
      if (r.sp && !bySpn.has(U(r.sp))) bySpn.set(U(r.sp), r);
      if (r.sp && !bySpn.has(SPN(r.sp))) bySpn.set(SPN(r.sp), r);
    }
  }
  catalog = { byMpn, bySpn, rows, imports: [...imports.values()].sort((a, b) => (b.at || 0) - (a.at || 0)) };
}
function catalogMatch(it) { return (it.mpn && catalog.byMpn.get(U(it.mpn))) || (it.supplierPn && (catalog.bySpn.get(U(it.supplierPn)) || catalog.bySpn.get(SPN(it.supplierPn)))) || null; }
function fillFromCatalog(it) {
  const r = catalogMatch(it);
  if (!r) return it;
  const out = { ...it, fromOrder: true };
  if (!out.description && r.d) out.description = r.d;
  if (!out.manufacturer && r.mf) out.manufacturer = r.mf;
  if (!out.mpn && r.m) out.mpn = r.m;
  if (!out.supplierPn && r.sp) out.supplierPn = r.sp;
  if (!out.supplier && r.s) out.supplier = r.s;
  if (!out.category) out.category = guessCategory(out.description, out.list) || "";
  return out;
}
async function importOrderFile(file) {
  const buf = await file.arrayBuffer();
  let rows;
  try {
    const wb = XLSX.read(buf, { type: "array" });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: "" });
  } catch { toast("Couldn't open that file. Use the .csv or .xlsx export of your order.", "err"); return; }
  const res = parseOrderRows(rows, file.name);
  if (res.error) { toast(res.error, "err"); return; }
  if (!res.rows.length) { toast("No part lines found in that file.", "err"); return; }
  const imp = newId();
  const CH = 400;
  let ok = true;
  for (let i = 0; i < res.rows.length && ok; i += CH) {
    ok = await write(() => store.set("catalog", `${imp}-${i / CH}`, { imp, file: file.name.slice(0, 80), supplier: res.supplier || "", at: Date.now(), by: state.me || "", rows: res.rows.slice(i, i + CH) }));
  }
  if (!ok) return;
  toast(`Imported ${plural(res.rows.length, "order line")}${res.supplier ? " from " + res.supplier : ""}`, "ok");
  // backfill items that match
  setTimeout(backfillFromCatalog, 600);
}
async function backfillFromCatalog() {
  let n = 0;
  for (const it of state.items) {
    if (it.description && it.supplierPn && it.manufacturer) continue;
    const filled = fillFromCatalog(it);
    const upd = {};
    for (const k of ["description", "manufacturer", "mpn", "supplierPn", "supplier", "category"]) if (filled[k] && !it[k]) upd[k] = filled[k];
    if (Object.keys(upd).length) { upd.fromOrder = true; if (await write(() => store.update("items", it.id, upd), true)) n++; }
  }
  if (n) toast(`Filled in ${plural(n, "counted part")} from your orders`, "ok");
}

/* ================= image + barcode reading ================= */
async function loadBitmap(file) {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    const url = URL.createObjectURL(file);
    try { const img = new Image(); img.src = url; await img.decode(); return img; }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
}
function toCanvas(src, maxSide) {
  const W = src.width || src.naturalWidth, H = src.height || src.naturalHeight;
  const s = Math.min(1, maxSide / Math.max(W, H));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(W * s)); c.height = Math.max(1, Math.round(H * s));
  c.getContext("2d", { willReadFrequently: true }).drawImage(src, 0, 0, c.width, c.height);
  return c;
}
const canvasBlob = (c, q = 0.85) => new Promise((r) => c.toBlob(r, "image/jpeg", q));
async function decodeFile(file, { decode = true } = {}) {
  const bmp = await loadBitmap(file);
  const seen = new Map();
  let first = null;
  if (decode) {
    for (const side of [2000, 3200]) {
      const c = toCanvas(bmp, side);
      if (!first) first = c;
      const res = await readBarcodes(c.getContext("2d").getImageData(0, 0, c.width, c.height), { tryHarder: true, maxNumberOfSymbols: 40, formats: LABEL_FORMATS });
      for (const r of res) if (r.isValid !== false && r.text) seen.set(r.format + "|" + r.text, { format: r.format, text: r.text, pos: relPos(r.position, c.width, c.height) });
      const has2D = [...seen.values()].some((r) => /DataMatrix|QR|PDF417|Aztec/.test(r.format));
      if (has2D || Math.max(bmp.width || 0, bmp.height || 0) <= side) break;
    }
    // stripe barcodes only: look again close-up around each one — neighbours with thin bars (Code 39 on TE/Deutsch
    // bags, behind glare) often only decode from an enlarged crop
    const all = [...seen.values()];
    if (all.length && all.length < 6 && !all.some((r) => /DataMatrix|QR|PDF417|Aztec/.test(r.format))) {
      const BW = bmp.width, BH = bmp.height, done = [];
      for (const r of all.filter((x) => x.pos).slice(0, 3)) {
        const xs = ["tl", "tr", "br", "bl"].map((k) => r.pos[k].x * BW), ys = ["tl", "tr", "br", "bl"].map((k) => r.pos[k].y * BH);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const bw = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 0.15 * Math.min(BW, BH));
        if (done.some(([x, y]) => Math.abs(x - cx) < bw * 0.5 && Math.abs(y - cy) < bw * 0.5)) continue;
        done.push([cx, cy]);
        const x0 = Math.max(0, cx - 1.5 * bw), y0 = Math.max(0, cy - 0.9 * bw), x1 = Math.min(BW, cx + 1.5 * bw), y1 = Math.min(BH, cy + 0.9 * bw);
        const sc = 2000 / (x1 - x0), c = document.createElement("canvas");
        c.width = 2000; c.height = Math.max(8, Math.round((y1 - y0) * sc));
        c.getContext("2d", { willReadFrequently: true }).drawImage(bmp, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
        const res = await readBarcodes(c.getContext("2d").getImageData(0, 0, c.width, c.height), { tryHarder: true, maxNumberOfSymbols: 20, formats: LABEL_FORMATS });
        for (const q of res) {
          if (q.isValid === false || !q.text || seen.has(q.format + "|" + q.text)) continue;
          const P = (pt) => ({ x: (x0 + pt.x / sc) / BW, y: (y0 + pt.y / sc) / BH });
          const p = q.position;
          seen.set(q.format + "|" + q.text, { format: q.format, text: q.text, pos: p?.topLeft ? { tl: P(p.topLeft), tr: P(p.topRight), bl: P(p.bottomLeft), br: P(p.bottomRight), ar: BW / BH } : null });
        }
      }
    }
  } else first = toCanvas(bmp, 2000);
  const ocrCanvas = ocrAvailable() ? toCanvas(bmp, 2600) : null;
  const photo = await canvasBlob(toCanvas(first, 1600));
  let thumb = "";
  for (const [side, q] of [[520, 0.72], [480, 0.6], [420, 0.55], [360, 0.5], [300, 0.45]]) {
    thumb = toCanvas(first, side).toDataURL("image/jpeg", q);
    if (thumb.length <= 40000) break;
  }
  bmp.close?.();
  return { codes: [...seen.values()], photo, thumb, ocrCanvas };
}
function editDist(a, b) {
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function relPos(p, w, h) {
  if (!p?.topLeft) return null;
  const f = (q) => ({ x: q.x / w, y: q.y / h });
  return { tl: f(p.topLeft), tr: f(p.topRight), bl: f(p.bottomLeft), br: f(p.bottomRight), ar: w / h };
}

/* ================= on-device text reading (OCR) — normal web page only ================= */
// Reads printed labels whose barcode holds no part data (e.g. Farnell). Downloads ~7 MB once, then cached by the browser.
const OCR_PATHS = {
  workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/worker.min.js",
  corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0",
  langPath: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int",
};
const ocrAvailable = () => !INCLAUDE && typeof Worker !== "undefined";
let ocrWorkerP = null, ocrLoading = false, ocrBusy = 0;
function getOcr() {
  if (!ocrWorkerP) {
    ocrLoading = true; emit();
    ocrWorkerP = (async () => {
      const T = await import("tesseract.js");
      const w = await T.createWorker("eng", 1, { ...OCR_PATHS, ...(window.__OCR_PATHS || {}), gzip: true });
      await w.setParameters({ tessedit_pageseg_mode: String(window.__OCR_PSM || 6), preserve_interword_spaces: "1" });
      return w;
    })().catch((e) => { ocrWorkerP = null; throw e; }).finally(() => { ocrLoading = false; emit(); });
  }
  return ocrWorkerP;
}
// grayscale + contrast stretch (helps faded thermal labels and glare)
function enhance(c) {
  if (window.__NOENH) return;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const im = ctx.getImageData(0, 0, c.width, c.height), d = im.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) { const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; d[i] = y; hist[y]++; }
  const n = d.length / 4; let lo = 0, hi = 255, acc = 0;
  for (; lo < 255; lo++) { acc += hist[lo]; if (acc > n * 0.02) break; }
  acc = 0; for (; hi > 0; hi--) { acc += hist[hi]; if (acc > n * 0.10) break; }
  const span = Math.max(30, hi - lo);
  for (let i = 0; i < d.length; i += 4) { let v = ((d[i] - lo) * 255) / span; v = v < 0 ? 0 : v > 255 ? 255 : v; d[i] = d[i + 1] = d[i + 2] = v; }
  ctx.putImageData(im, 0, 0);
}
// Read the printed label around its barcodes. Straightens it using the barcodes' angle and returns: the text, the caption
// printed above each barcode (-> which field that barcode is), the value printed after each caption, and text-only fields.
async function readLabel(src, codes, opt = {}) {
  const opts = opt;
  ocrBusy++; emit();
  try {
    const w = await getOcr();
    const psm = (m) => w.setParameters({ tessedit_pageseg_mode: String(m) });
    const W = src.width, H = src.height;
    const withPos = codes.filter((c) => c.pos);
    if (!withPos.length) {
      // no barcode to anchor on: read the whole photo, and the printed label found in it at two sizes (small print
      // needs a big image, big dot-matrix print reads better small). Each read is parsed on its own; per field the
      // value most reads agree on wins.
      const reads = [];
      const take = async (cv, mode) => {
        await psm(mode);
        const t = (await w.recognize(cv)).data?.text || "";
        const f = { ...textExtras(t, []), ...parseLabelText(t), ...captionValues(t) };
        reads.push({ t, f, cv, hits: ["mpn", "supplierPn", "qty"].filter((x) => f[x] != null && f[x] !== "").length });
      };
      const small = toCanvas(src, 1500);
      const reg = findLabelRegion(small.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, small.width, small.height).data, small.width, small.height);
      const full = toCanvas(src, 2000); enhance(full);
      await take(full, 11);
      if (reg && reg.w * reg.h < 0.85 * small.width * small.height && !(opts.quick && reads[0].hits >= 2)) {
        const k = W / small.width, cw = reg.w * k, ch = reg.h * k;
        for (const [target, mode] of [[1800, 11], [650, 6]]) {
          const sc = Math.min(3, target / cw), cv = document.createElement("canvas");
          cv.width = Math.round(cw * sc); cv.height = Math.round(ch * sc);
          const cx = cv.getContext("2d", { willReadFrequently: true });
          cx.drawImage(src, reg.x * k, reg.y * k, cw, ch, 0, 0, cv.width, cv.height);
          const im = cx.getImageData(0, 0, cv.width, cv.height); blankStripes(im); cx.putImageData(im, 0, 0);
          enhance(cv);
          await take(cv, mode);
          if (opts.quick && Math.max(...reads.map((r) => r.hits)) >= 2) break;
        }
      }
      // print straight on the bag (no separate label to find): the whole photo, smaller, read as one block
      if (Math.max(...reads.map((r) => r.hits)) < 2 && !opts.quick) { const mid = toCanvas(src, 1300); await take(mid, 6); }
      const order = reads.map((r, i) => ({ ...r, i })).sort((a, b) => b.hits - a.hits || a.i - b.i);
      const norm = (v) => String(v).replace(/[^A-Z0-9]/gi, "").toUpperCase();
      const fields = {};
      for (const key of new Set(order.flatMap((r) => Object.keys(r.f)))) {
        const vals = order.map((r) => r.f[key]).filter((v) => v != null && v !== "" && (key !== "description" || (String(v).match(/[A-Za-z]/g) || []).length >= 4));
        if (!vals.length) continue;
        const votes = new Map();
        for (const v of vals) votes.set(norm(v), (votes.get(norm(v)) || 0) + 1);
        const top = Math.max(...votes.values());
        fields[key] = vals.find((v) => votes.get(norm(v)) === top);
      }
      // a supplier guess only stands with the part number it came from
      if (fields.supplier && !order.some((r) => r.f.supplier === fields.supplier && norm(r.f.supplierPn || "") === norm(fields.supplierPn || ""))) delete fields.supplier;
      const text = order.map((r) => r.t).join("\n");
      if (window.__OCR_DEBUG) { window.__crop = order[0].cv.toDataURL("image/png"); window.__cropText = text; window.__reads = order.map((r) => r.f); window.__readTexts = order.map((r) => r.t); }
      return { text, captions: [], values: {}, extra: {}, fields };
    }
    const pts = (c) => ["tl", "tr", "br", "bl"].map((k) => ({ x: c.pos[k].x * W, y: c.pos[k].y * H }));
    const wid = (c) => { const [a, b] = pts(c); return Math.hypot(b.x - a.x, b.y - a.y); };
    const big = withPos.reduce((m, c) => (wid(c) > wid(m) ? c : m));
    const [ta, tb] = pts(big), n = Math.hypot(tb.x - ta.x, tb.y - ta.y) || 1;
    const u = { x: (tb.x - ta.x) / n, y: (tb.y - ta.y) / n }, v = { x: -u.y, y: u.x };
    const geo = codes.map((c) => {
      if (!c.pos) return null;
      const P = pts(c).map((p) => ({ a: p.x * u.x + p.y * u.y, b: p.x * v.x + p.y * v.y }));
      return { a0: Math.min(...P.map((p) => p.a)), a1: Math.max(...P.map((p) => p.a)), b: P.reduce((s2, p) => s2 + p.b, 0) / 4 };
    });
    const G = geo.filter(Boolean), maxW = Math.max(...G.map((g) => g.a1 - g.a0));
    const single = G.length === 1;
    const condensed = codes.some((c) => parseFarnellBarcode(c.text)); // old Farnell labels: tall, narrow font
    // render any rectangle of the label (in label coordinates) upright onto a canvas
    const render = (A0, A1, B0, B1, width, sx = 1) => {
      const sc = Math.min(3, width / (A1 - A0));
      const cv = document.createElement("canvas");
      cv.width = Math.max(8, Math.round((A1 - A0) * sc * sx)); cv.height = Math.max(8, Math.round((B1 - B0) * sc));
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.setTransform(sc * sx * u.x, sc * v.x, sc * sx * u.y, sc * v.y, -A0 * sc * sx, -B0 * sc);
      ctx.drawImage(src, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return { cv, X: (a) => (a - A0) * sc * sx, Y: (b) => (b - B0) * sc, sc };
    };
    const A0 = Math.min(...G.map((g) => g.a0)) - 0.2 * maxW, A1 = Math.max(...G.map((g) => g.a1)) + (single ? 1.0 : 0.75) * maxW;
    const B0 = Math.min(...G.map((g) => g.b)) - 0.45 * maxW, B1 = Math.max(...G.map((g) => g.b)) + (single ? 0.7 : 0.25) * maxW;
    const page = render(A0, A1, B0, B1, 2400, condensed ? 1.35 : 1);
    if (single && condensed) { // blank out the stripes so they aren't read as text
      const g = G[0], hb = 0.072 * maxW, ctx = page.cv.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(page.X(g.a0 - 0.02 * maxW), page.Y(g.b - hb), (g.a1 - g.a0 + 0.04 * maxW) * page.sc * 1.35, 2 * hb * page.sc);
    }
    enhance(page.cv);
    await psm(single ? 6 : 11);
    const { data } = await w.recognize(page.cv);
    let text = data?.text || "";
    const captions = codes.map(() => null), stripText = [];
    if (!single && opt.strips !== false) {
      // one clean line per barcode: its caption (and printed value) sits just above the stripes
      const SP = { top: 0.105, bot: 0.033, width: 1400, psm: 7, ...(window.__STRIP || {}) };
      await psm(SP.psm);
      if (window.__OCR_DEBUG) window.__strips = [];
      for (let i = 0; i < codes.length; i++) {
        const g = geo[i]; if (!g) continue;
        const strip = render(g.a0 - 0.05 * maxW, g.a0 + Math.max(g.a1 - g.a0, 0.8 * maxW), g.b - SP.top * maxW, g.b - SP.bot * maxW, SP.width);
        enhance(strip.cv);
        const t = ((await w.recognize(strip.cv)).data?.text || "").trim();
        if (window.__OCR_DEBUG) (window.__strips = window.__strips || []).push(strip.cv.toDataURL("image/png"));
        stripText[i] = t;
        captions[i] = classifyCaption(t.split(/[:;]/)[0]);
      }
      text = stripText.filter(Boolean).join("\n") + "\n" + text;
    }
    const extra = textExtras(text, []);
    // description: the plain text line just below the supplier part-number barcode (new-style labels)
    const sp = captions.indexOf("supplierPn");
    if (sp >= 0 && geo[sp]) {
      const g = geo[sp];
      const strip = render(g.a0 - 0.05 * maxW, g.a0 + 1.1 * maxW, g.b + 0.035 * maxW, g.b + 0.11 * maxW, 1600);
      enhance(strip.cv);
      const t = ((await w.recognize(strip.cv)).data?.text || "").replace(/\s+/g, " ").trim();
      if ((t.match(/[A-Za-z]/g) || []).length >= 4 && !classifyCaption(t.split(":")[0])) extra.description = t.replace(/\s*,\s*/g, ", ").slice(0, 160);
    }
    if (window.__OCR_DEBUG) { window.__crop = page.cv.toDataURL("image/png"); window.__cropText = text; window.__captions = codes.map((c, i) => [c.text, captions[i], stripText[i] || ""]); }
    return { text, captions, values: captionValues(text), extra };
  } finally { ocrBusy--; emit(); }
}
function textExtras(txt, _lines) {
  const extra = {};
  if (/farnell|element ?14|newark/i.test(txt)) extra.supplier = "Farnell";
  else if (/mouser/i.test(txt)) extra.supplier = "Mouser";
  else if (/digi-?key/i.test(txt)) extra.supplier = "DigiKey";
  else if (/\bRS\b.*(components|stock)|rs-online/i.test(txt)) extra.supplier = "RS";
  const ls2 = txt.split(/\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  for (let i = 0; i < ls2.length; i++) {
    const m = /(?:^|\s)(fabrikant|manufacturer|hersteller|fabricant)\s*:?\s*([A-Za-z][A-Za-z0-9 &.\-]{1,30})?$/i.exec(ls2[i]);
    if (!m || /nr|part|no\b/i.test(ls2[i].slice(0, m.index + 1))) continue;
    const val = (m[2] || ls2[i + 1] || "").trim();
    if (/^[A-Za-z][A-Za-z0-9 &.\-]{1,30}$/.test(val) && !classifyCaption(val)) { extra.manufacturer = val; break; }
  }
  return extra;
}
function dataUrlToBlob(u) {
  const [head, b64] = u.split(","); const bin = atob(b64); const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return new Blob([a], { type: /data:([^;]+)/.exec(head)?.[1] || "image/jpeg" });
}
async function savePhoto(key, thumb) { return write(() => store.set("photos", key, { data: thumb, at: Date.now(), by: state.me || "" }), true); }

/* ================= Claude: read labels / identify unmarked parts ================= */
const aiQueue = [];
let aiBusy = false, aiPaused = false;
const aiAvailable = () => !!(sample && canImages);
const aiOn = () => aiAvailable() && ls.get("useClaude", true);
function queueAI(id, photo, known, mode) { aiQueue.push({ id, photo, known, mode }); pumpAI(); emit(); }
function aiPrompt(known, mode, cats = CATEGORIES) {
  return `You are helping a student racing team count their electronics stock. ${mode === "loose"
    ? "The photo shows a component or loose parts WITHOUT a supplier label (maybe on a reel, in a tray, bare, or in an unlabelled bag)."
    : "The photo shows a bag, reel or box of components, usually with a supplier label."}
Barcodes decoded from the photo and matches from the team's order history (trust these over anything you read): ${JSON.stringify(known)}
Work out what the part is. Read any printed label first. If there is no label, identify it from what you can see: chip or package markings (read them exactly), SMD resistor/capacitor codes, colour bands, connector series and pitch, size and package.
Reply with only one JSON object with these keys:
{"description": short plain description incl. value and package, e.g. "10 kΩ resistor, 0603" or "Red LED, 0603 SMD",
 "category": one of ${JSON.stringify(cats)},
 "manufacturer": "", "mpn": "" (only when printed or marked on it — never guess), "supplier": "", "supplierPn": "",
 "qty": number or null (only when printed),
 "confidence": "high" | "medium" | "low",
 "seen": short note of the text or markings you based this on}
Use "" or null for anything you cannot see.`;
}
async function pumpAI() {
  if (aiBusy || aiPaused || !aiQueue.length) return;
  aiBusy = true;
  const job = aiQueue.shift();
  emit();
  try {
    const jobItem = state.items.find((i) => i.id === job.id);
    const cats = catsFor(listOf(jobItem));
    const r = await sample.json(aiPrompt(job.known, job.mode, cats), { images: [job.photo], modelTier: job.mode === "loose" ? "default" : "quick" });
    const it = state.items.find((i) => i.id === job.id) || (await store.get("items", job.id));
    if (it && r && typeof r === "object") {
      const upd = { ai: "done" };
      for (const k of ["description", "category", "manufacturer", "mpn", "supplier", "supplierPn"]) {
        const v = typeof r[k] === "string" ? r[k].trim() : "";
        if (v && !it[k]) upd[k] = v.slice(0, 200);
      }
      if ((it.qty == null || it.qty === "") && r.qty != null && r.qty !== "" && Number.isFinite(Number(r.qty))) upd.qty = Number(r.qty);
      if (upd.category && !cats.includes(upd.category)) upd.category = "Other";
      const conf = ["high", "medium", "low"].includes(r.confidence) ? r.confidence : "";
      if (conf) upd.aiConfidence = conf;
      if (typeof r.seen === "string" && r.seen.trim()) upd.aiSeen = r.seen.trim().slice(0, 200);
      if (!it.raw && conf !== "high") upd.needsCheck = true;
      // a newly read MPN may now match an order line
      const merged = fillFromCatalog({ ...it, ...upd });
      for (const k of ["description", "manufacturer", "supplierPn", "supplier"]) if (merged[k] && !it[k] && !upd[k]) upd[k] = merged[k];
      await write(() => store.update("items", job.id, upd), true);
    }
  } catch (e) {
    const code = e?.code;
    if (["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed", "images_unavailable"].includes(code)) {
      canImages = false; aiQueue.length = 0;
      toast("Claude can't read photos in this view — barcodes still work.");
    } else if (code === "rate_limited") {
      aiQueue.unshift(job); aiPaused = true;
      toast("Claude is busy — tap “Resume Claude” in a minute.", "err");
    } else {
      await write(() => store.update("items", job.id, { ai: "failed" }), true);
    }
  } finally { aiBusy = false; emit(); pumpAI(); }
}

/* ================= scanning flow ================= */
const recent = [];
let processing = 0;
let lastFound = null; // existing item found by its part label
async function handleFiles(files, mode = "bag") {
  if (state.readOnly) { toast("This list is view-only for you — see the Setup tab.", "err"); return; }
  const list = [...files].sort((a, b) => (a.lastModified || 0) - (b.lastModified || 0));
  processing += list.length; emit();
  for (const file of list) {
    let out = null;
    try { out = await handleOne(file, mode); }
    catch (e) { console.error(e); toast("Could not read that photo.", "err"); }
    finally { processing--; emit(); }
    // one photo at a time: suggest counting the bag before the next one (batches are counted later on the Parts tab)
    if (out?.kind === "added" && list.length === 1 && askCountOn()) await countPrompt(out.item, { sameBags: out.sameBags });
  }
}
async function handleOne(file, mode) {
  const { codes, photo, thumb, ocrCanvas } = await decodeFile(file);
  return handleDecoded(codes, { photo, thumb, ocrCanvas }, mode);
}
async function handleDecoded(codes, media, mode, opts = {}) {
  const photo = media?.photo, thumb = media?.thumb;
  const r = interpret(codes);
  if (r.boxCode) {
    if (!boxByCode(r.boxCode)) await write(() => store.set("boxes", r.boxCode, { name: "", location: "", printed: true, createdAt: Date.now(), by: state.me || "", list: listForBoxCode(r.boxCode) }));
    setCurrentBox(r.boxCode);
    if (!r.item && !r.partRef) { if (!opts.live) toast(`Now filling box ${r.boxCode}`, "ok"); return { kind: "box", text: `Now filling ${r.boxCode}` }; }
  }
  if (r.partRef) {
    const it = state.items.find((i) => i.id === r.partRef);
    if (!it) { toast("That part label isn't in the list (was it deleted?)", "err"); return { kind: "err", text: "Unknown part label" }; }
    lastFound = it.id; expanded.add(it.id);
    if (!recent.includes(it.id)) recent.unshift(it.id);
    toast(it.box === currentBox || !currentBox ? `Found: ${it.description || it.mpn || "part"} (${it.box || "no box"})` : `Found in ${it.box || "no box"} — tap “Move to ${currentBox}” if it lives here now`, "ok");
    emit(); return { kind: "found", text: `Found: ${it.description || it.mpn || "part"} (${it.box || "no box"})` };
  }
  // ===== Priority: 1) QR / square code  2) stripe barcodes  3) printed text (RS labels, descriptions)  4) manual entry =====
  // Each step only fills fields the steps before it left empty.
  const same = (a, b) => String(a).replace(/[^A-Z0-9]/gi, "").toUpperCase() === String(b).replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const merged = {}, src = {};
  const put = (fields, how) => {
    for (const [k, v] of Object.entries(fields || {})) {
      if (v == null || v === "" || (typeof v === "number" && Number.isNaN(v))) continue;
      if (merged[k] == null || merged[k] === "") { merged[k] = v; src[k] = how; }
      else if (how === "text" && same(merged[k], v) && !src[k].includes("+")) src[k] += " + text";
    }
  };
  put(r.fields2D, "QR code");
  put(r.fields1D, "barcode");
  let ocrUsed = false;
  const needText = () => !merged.mpn || merged.qty == null || (!opts.live && !merged.description);
  if (mode !== "loose" && ocrAvailable() && media?.ocrCanvas && needText()) {
    const oneD = (r.all || []).filter((c) => !is2DFormat(c.format));
    const plain = oneD.filter((c) => !parseFarnellBarcode(c.text));
    try {
      const L = await readLabel(media.ocrCanvas, oneD, { strips: !r.has2DData, quick: !!opts.live });
      if (!r.has2DData) {
        const capOf = new Map(oneD.map((c, i) => [c, L.captions[i]]));
        if (plain.length >= 2 || (plain.length === 1 && capOf.get(plain[0]))) {
          const res = resolveBarcodes(plain, plain.map((c) => capOf.get(c)));
          // the printed captions say which barcode is which: they replace the layout guesses
          for (const k of Object.keys(r.multi?.fields || {})) if (src[k] === "barcode") { delete merged[k]; delete src[k]; }
          put(res.fields, "barcode");
          r.captionsSeen = Object.values(res.src).includes("caption");
        }
      }
      let t = L.fields ? { ...L.fields } : { ...L.extra, ...parseLabelText(L.text), ...L.values };
      // the barcodes didn't lead to the printed text (it sits elsewhere on the label): read the label itself too
      const hits = (f) => ["mpn", "supplierPn", "qty", "lot", "description"].filter((k) => f[k] != null && f[k] !== "").length;
      if (!L.fields && !opts.live && (hits(t) < 2 || !(t.mpn || merged.mpn))) {
        const L2 = await readLabel(media.ocrCanvas, [], {});
        t = hits(L2.fields) >= hits(t) ? { ...t, ...L2.fields } : { ...L2.fields, ...t };
      }
      if (t.qty != null) t.qty = Number(t.qty);
      // a plain barcode that repeats a printed value (P/N, batch, …) confirms it — and fixes small text misreads
      for (const c of plain) {
        const v = String(c.text).trim();
        for (const f of ["mpn", "lot", "supplierPn", "po", "invoice", "dateCode", "serial"]) {
          if (t[f] == null || t[f] === "") continue;
          const a = String(t[f]).replace(/[^A-Z0-9]/gi, "").toUpperCase(), b = v.replace(/[^A-Z0-9]/gi, "").toUpperCase();
          if (a !== b && !(b.length >= 6 && editDist(a, b) <= Math.min(2, Math.floor(b.length / 5)))) continue;
          // the layout guess put this barcode in another field: the printed caption wins
          for (const k of Object.keys(merged)) if (k !== f && src[k] === "barcode" && String(merged[k]) === v && !r.captionsSeen) { delete merged[k]; delete src[k]; }
          if (src[f] !== "QR code") { merged[f] = v; src[f] = "barcode + text"; }
          delete t[f];
          break;
        }
      }
      put(t, "text");
      if (merged.supplierPn && src.supplierPn === "text" && U(merged.supplierPn) === U(merged.mpn)) { delete merged.supplierPn; delete src.supplierPn; }
      // still no part number: a stripe barcode that looks like one (letters + digits, e.g. Code 39 *ASX602-06SN-HE-R*)
      if (!merged.mpn) {
        const used = new Set(Object.values(merged).map(String));
        const pn = plain.map((c) => String(c.text).trim()).find((v) => !used.has(v) && v.length >= 6 && v.length <= 40 && (v.match(/[A-Z]/gi) || []).length >= 2 && (v.match(/\d/g) || []).length >= 2 && /^[A-Z0-9][A-Z0-9\-\/.#+_]+$/i.test(v));
        if (pn) { merged.mpn = pn; src.mpn = "barcode"; }
      }
      ocrUsed = Object.values(src).some((v) => v.includes("text")) || !!r.captionsSeen;
    } catch (e) { console.warn("ocr", e); if (!opts.live) toast("Couldn't load the text reader — using the barcodes only.", "err"); }
  }
  if (!merged.supplier && /^\d{7}$/.test(merged.supplierPn || "") && (merged.mpn || merged.order)) { merged.supplier = "Farnell"; src.supplier = src.supplierPn; }
  if (Object.keys(merged).length && (!r.primary || r.primary.startsWith("L|") || (!r.has2DData && !r.known1D)))
    r.primary = ["L", merged.supplierPn, merged.mpn, merged.lot, merged.dateCode, merged.qty].map((x) => x ?? "").join("|");
  const readFrom = Object.keys(src).length ? src : null;
  // a read from codes always counts; text alone must give at least two part fields (a stray word on the bag is not a part)
  const fromCode = Object.values(src).some((v) => /QR|barcode/.test(v));
  const textHits = ["mpn", "supplierPn", "qty", "description"].filter((k) => merged[k] != null && merged[k] !== "").length;
  const found = fromCode ? !!(merged.mpn || merged.supplierPn || merged.description || merged.order) : textHits >= 2;

  // 4) nothing readable: manual entry (photo kept so it can be typed from it later)
  let loose = mode === "loose";
  if (!found && !loose) {
    if (opts.live) return null;
    if (aiOn()) loose = true; // Claude version: let Claude identify it from the photo
    else {
      const id = newId();
      const ok = await write(() => store.set("items", id, { box: currentBox || "", list: itemListNow(), at: Date.now(), by: state.me || "", raw: "", codes: (r.all || []).slice(0, 12).map((c) => printable(`${c.format}: ${c.text}`).slice(0, 300)), source: "manual", needsLabel: true, hasPhoto: !!thumb }));
      if (!ok) return;
      if (thumb) savePhoto(id, thumb);
      for (const x of recent) expanded.delete(x);
      recent.unshift(id); expanded.add(id); sessionCount++; sendPresence(); emit();
      toast("Couldn't read this label — type the part in (the photo is saved with it).", "err");
      setTimeout(() => $(`[data-id="${id}"] input[name=description]`)?.focus(), 120);
      return { kind: "manual", text: "Couldn't read it — type it in" };
    }
  }
  r.item = found ? merged : null;
  const rawKey = printable(r.primary || "");
  const dupe = rawKey && (r.has2DData || r.known1D) ? state.items.find((i) => printable(i.raw) === rawKey) : null;
  const sameBags = rawKey && (r.has2DData || r.known1D) ? state.items.filter((i) => printable(i.raw) === rawKey).length : 0;
  if (dupe && !opts.live) toast(`Another bag of this part (bag ${sameBags + 1}) — added separately.`, "ok");
  const id = newId();
  let item = {
    box: currentBox || "", list: itemListNow(), ...(r.item || {}),
    raw: rawKey, codes: (r.all || []).slice(0, 12).map((c) => printable(`${c.format}: ${c.text}`).slice(0, 300)),
    at: Date.now(), by: state.me || "", source: loose ? "photo" : ocrUsed ? "label-text" : "barcode", needsLabel: !r.has2DData && !r.known1D,
  };
  if (ocrUsed && item.supplierPn) {
    // the supplier order code is short and digits-only, so it reads reliably — trust your order history over the OCR'd text
    const row = catalog.bySpn.get(U(item.supplierPn)) || catalog.bySpn.get(SPN(item.supplierPn));
    if (row) {
      for (const [k, rk] of [["mpn", "m"], ["description", "d"], ["manufacturer", "mf"], ["supplier", "s"]]) {
        if (!row[rk] || /QR|barcode/.test(String(readFrom?.[k] || ""))) continue; // never replace a value read from a code
        item[k] = row[rk]; if (readFrom) readFrom[k] = "order history";
      }
      item.fromOrder = true;
    }
  }
  item = fillFromCatalog(item);
  if (readFrom) {
    const fromText = Object.entries(readFrom).filter(([, v]) => v === "text").map(([k]) => k);
    if (Number.isNaN(item.qty)) delete item.qty;
    // e.g. "QR code: MPN, qty · barcode: supplier PN · text: description"
    const groups = {};
    for (const [k, v] of Object.entries(readFrom)) if (FIELD_LABEL[k]) (groups[v] = groups[v] || []).push(FIELD_LABEL[k]);
    item.readFrom = Object.entries(groups).map(([how, ks]) => `${how}: ${ks.join(", ")}`).join(" · ");
    if (!item.fromOrder && (fromText.includes("mpn") || fromText.includes("qty") || (fromText.includes("supplierPn") && !item.mpn))) item.needsCheck = true;
    if (r.multi && !item.fromOrder && !item.mpn) item.needsCheck = true;
  }
  if (!item.category && item.description) item.category = guessCategory(item.description, item.list);
  const wantAI = !!photo && aiOn() && (!item.description || loose);
  if (wantAI) item.ai = "pending";
  if (loose || (ocrUsed && thumb)) item.hasPhoto = true;
  if (!wantAI && loose && !item.raw) item.needsCheck = true;
  const ok = await write(() => store.set("items", id, item));
  if (!ok) return;
  if ((loose || ocrUsed) && thumb) savePhoto(id, thumb);
  for (const x of recent) expanded.delete(x);
  recent.unshift(id); if (recent.length > 40) recent.pop();
  expanded.add(id); sessionCount++; sendPresence();
  const label = `${item.mpn || item.description || (loose ? "Unmarked part" : "Part")} → ${item.box || "no box"}`;
  if (!opts.live) toast(label, "ok");
  if (wantAI) queueAI(id, photo, { ...(r.item || {}), ...(item.fromOrder ? { orderHistory: catalogMatch(item) } : {}) }, loose ? "loose" : "bag");
  emit();
  return { kind: "added", text: label, item: { ...item, id }, sameBags };
}

/* ================= counting (actual quantities) ================= */
// count = what someone actually counted; qty = what the label says (not verified). countStatus: "counted" | "skipped" | "" (not yet)
const askCountOn = () => ls.get("askCount", true);
async function removeItem(id, why) {
  const it = state.items.find((i) => i.id === id);
  expanded.delete(id);
  const i = recent.indexOf(id); if (i >= 0) recent.splice(i, 1);
  await write(() => store.del("items", id));
  if (it?.hasPhoto) write(() => store.del("photos", id), true);
  toast(why || "Removed", "ok");
}
async function setCount(id, n) {
  if (n === 0) return removeItem(id, "Removed — counted 0 (scanned by mistake).");
  await write(() => store.update("items", id, { count: n, countStatus: "counted", countedBy: state.me || "", countedAt: Date.now() }));
}
async function skipCount(id) {
  await write(() => store.update("items", id, { count: "", countStatus: "skipped", countedBy: state.me || "", countedAt: Date.now() }));
}
async function saveCountField(id, v) {
  const it = state.items.find((i) => i.id === id);
  if (!it) return;
  if (v === "") { if (it.count != null && it.count !== "") await write(() => store.update("items", id, { count: "", countStatus: "" })); return; }
  const n = Math.round(Number(String(v).replace(",", ".")));
  if (!Number.isFinite(n) || n < 0) return;
  if (n === 0) { modal("Remove this bag?", "A count of 0 means it was scanned by mistake, so it is removed from the list.", "Delete", () => removeItem(id, "Removed.")); return; }
  if (it.count === n && it.countStatus === "counted") return;
  await setCount(id, n);
}
// "Count this bag" — shown after a scan. A suggestion: count, say it can't be counted, or do it later.
function countPrompt(it, opt = {}) {
  return new Promise((resolve) => {
    const inp = h("input", { type: "number", inputmode: "numeric", min: "0", class: "countin", placeholder: "How many?", enterkeyhint: "done", "aria-label": "Counted quantity" });
    const finish = async (fn) => { wrap.remove(); try { await fn(); } finally { resolve(); } };
    const save = () => {
      const v = inp.value.trim();
      if (v === "") { inp.focus(); return; }
      const n = Math.round(Number(v.replace(",", ".")));
      if (!Number.isFinite(n) || n < 0) { inp.focus(); return; }
      finish(async () => { await setCount(it.id, n); if (n > 0) toast(`Counted ${n}`, "ok"); });
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); save(); } });
    const wrap = h("div", { class: "modal-wrap count-wrap" },
      h("div", { class: "modal count" },
        h("div", { class: "count-title" }, it.description || it.mpn || "This bag"),
        h("div", { class: "small" }, [it.mpn && it.description ? it.mpn : "", it.box || "no box", opt.sameBags ? `bag ${opt.sameBags + 1} of this part` : ""].filter(Boolean).join(" · ")),
        h("label", { class: "count-label" }, "How many parts are in this bag?", inp),
        it.qty != null && it.qty !== "" ? h("button", { class: "btnlink", onclick: () => { inp.value = String(it.qty); inp.focus(); } }, `Label says ${it.qty} (not verified) — use as starting point`) : null,
        h("div", { class: "small" }, "0 = scanned by mistake (removes this bag)."),
        h("div", { class: "count-btns" },
          h("button", { class: "btn primary", onclick: save }, "Save count"),
          h("button", { class: "btn", onclick: () => finish(async () => { await skipCount(it.id); toast("Marked as can't count", "ok"); }) }, "Can't count"),
          h("button", { class: "btn ghost", onclick: () => finish(async () => {}) }, "Later"))));
    document.body.append(wrap);
    inp.focus();
    setTimeout(() => { if (document.activeElement !== inp && document.contains(inp)) inp.focus(); }, 60);
  });
}

/* ================= live camera scanning (normal web page only) ================= */
const liveAvailable = () => !INCLAUDE && !!navigator.mediaDevices?.getUserMedia && state.mode !== "join";
let actx = null;
function beep(f = 880) {
  try { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; g.gain.value = 0.08; o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.09); } catch {}
  try { navigator.vibrate?.(f < 400 ? [40, 60, 40] : 60); } catch {}
}
async function openLive() {
  if (state.readOnly || document.querySelector(".liveov")) return;
  document.activeElement?.blur?.();
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume?.(); } catch {}
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }); }
  catch { toast("Camera not available — allow camera access, or use “Snap a photo”.", "err"); return; }
  const video = h("video", { playsinline: true, muted: true, autoplay: true });
  video.srcObject = stream;
  const info = h("div", { class: "live-info" });
  const last = h("div", { class: "live-last" }, "Point at the square code on a label, or at a box label");
  let stop = false, count = 0, frameNo = 0;
  const close = () => { stop = true; stream.getTracks().forEach((t) => t.stop()); ov.remove(); emit(); };
  const ov = h("div", { class: "liveov" }, video, h("div", { class: "live-frame" }),
    h("div", { class: "live-top" }, info, h("button", { class: "btn", onclick: close }, "Done")), last);
  document.body.append(ov);
  const updInfo = () => { const b = boxByCode(currentBox); info.textContent = currentBox ? `${currentBox}${b?.name ? " · " + b.name : ""} — ${plural(state.items.filter((i) => i.box === currentBox).length, "bag")}${count ? ` · ${count} this run` : ""}` : "No box yet — scan a box label first"; };
  updInfo();
  try { await video.play(); } catch {}
  const c = document.createElement("canvas"); const ctx = c.getContext("2d", { willReadFrequently: true });
  const lastSeen = new Map(); // code -> last time it was in view; the same label only counts again after it left the view
  const codeOwner = new Map(); // barcode text -> label it was last seen on
  let lastLive = null;
  const flash = (text, kind) => { last.textContent = text; last.className = "live-last " + (kind || ""); };
  while (!stop) {
    await new Promise((r) => setTimeout(r, 150));
    if (stop || !video.videoWidth) continue;
    frameNo++;
    const zoom = [1, 0.72, 1.3][frameNo % 3]; // vary scale between frames: thin 1D barcodes decode at some scales and not others
    const sc = Math.min(1.3, (1600 / Math.max(video.videoWidth, video.videoHeight)) * zoom);
    c.width = Math.round(video.videoWidth * sc); c.height = Math.round(video.videoHeight * sc);
    ctx.drawImage(video, 0, 0, c.width, c.height);
    let res;
    try { res = await readBarcodes(ctx.getImageData(0, 0, c.width, c.height), { tryHarder: true, maxNumberOfSymbols: 6, formats: ["DataMatrix", "QRCode", "MicroQRCode", "PDF417", "Aztec", "Code128"] }); } catch { continue; }
    const codes = res.filter((x) => x.isValid !== false && x.text).map((x) => ({ format: x.format, text: x.text, pos: relPos(x.position, c.width, c.height) }));
    if (window.__LIVE_DEBUG) { window.__liveLog = (window.__liveLog || []).concat([[c.width, codes.map((x) => x.text).join(",")]]).slice(-12); if (!window.__frame) window.__frame = c.toDataURL("image/png"); }
    if (!codes.length) continue;
    const r = interpret(codes);
    const key = r.boxCode && !r.item ? "box:" + r.boxCode : r.partRef ? "part:" + r.partRef : r.primary;
    if (!key) continue;
    const now = Date.now();
    // a frame that only caught some of a label's barcodes (e.g. the stripes on a Mouser label, without its square code)
    // belongs to the label seen a moment ago, not to a new bag
    if (!r.boxCode && !r.partRef) {
      const texts = codes.map((x) => x.text);
      if (!r.has2DData) {
        const owners = texts.map((t) => codeOwner.get(t)).filter((o) => o && now - o.at < 6000 && o.key !== key);
        if (owners.length && owners.length >= Math.ceil(texts.length / 2)) { lastSeen.set(owners[0].key, now); for (const o of owners) o.at = now; continue; }
      }
      else for (const t of texts) codeOwner.set(t, { key, at: now }); // a square code with data = a complete label
    }
    const prev = lastSeen.get(key);
    if (window.__LIVE_DEBUG) (window.__keys = window.__keys || []).push([now % 100000, key.slice(0, 40), prev ? now - prev : null]);
    lastSeen.set(key, now);
    if (prev && now - prev < 2500) continue; // still the same bag in view
    if (r.boxCode && !r.item && !r.partRef) {
      if (r.boxCode !== currentBox) { await handleDecoded(codes, null, "bag", { live: true }); beep(660); flash(`Now filling ${r.boxCode}`, "box"); updInfo(); }
      continue;
    }
    if (!r.partRef && !r.has2DData && !r.known1D) continue;
    if (r.multi && !(r.multi.fields.mpn && r.multi.fields.qty != null)) {
      const f = r.multi.fields;
      const same = lastLive && f.supplierPn && lastLive.supplierPn === f.supplierPn && (!f.lot || lastLive.lot === f.lot);
      flash(same ? "✓ Done — show the next bag" : `Hold still — ${plural(codes.length, "barcode")} found, looking for the rest…`, same ? "ok" : "box");
      lastSeen.delete(key); continue;
    }
    let media = null;
    if (!r.has2DData && r.known1D) {
      flash("Hold still — reading label text…", "box");
      const snap = document.createElement("canvas"); snap.width = video.videoWidth; snap.height = video.videoHeight;
      snap.getContext("2d").drawImage(video, 0, 0);
      media = { ocrCanvas: snap };
    }
    const out = await handleDecoded(codes, media, "bag", { live: true });
    if (out?.kind === "added") {
      count++; beep(880); flash("✓ " + out.text, "ok"); lastLive = out.item;
      for (const x of codes) codeOwner.set(x.text, { key, at: Date.now() }); // later partial reads of this label are the same bag
      if (askCountOn()) { await countPrompt(out.item, { sameBags: out.sameBags }); lastSeen.set(key, Date.now()); flash("Show the next bag", "box"); }
    }
    else if (out) { beep(500); flash(out.text, out.kind === "err" ? "warn" : "ok"); }
    updInfo();
  }
}
async function addFromCatalog(row) {
  const id = newId();
  const list = itemListNow();
  const item = { box: currentBox || "", list, at: Date.now(), by: state.me || "", raw: "", codes: [], source: row ? "order" : "manual", needsLabel: true,
    ...(row ? { mpn: row.m || "", supplierPn: row.sp || "", supplier: row.s || "", manufacturer: row.mf || "", description: row.d || "", category: guessCategory(row.d, list), fromOrder: true } : {}) };
  const ok = await write(() => store.set("items", id, item));
  if (!ok) return;
  for (const x of recent) expanded.delete(x);
  recent.unshift(id); expanded.add(id); sessionCount++; sendPresence(); emit();
  setTimeout(() => $(`[data-id="${id}"] input[name=${row ? "count" : "description"}]`)?.focus(), 80);
}
function addByHandDialog() {
  if (state.readOnly) return;
  let q = "";
  const results = h("div", { class: "picklist" });
  const close = () => wrap.remove();
  const draw = () => {
    results.replaceChildren();
    const t = q.trim().toUpperCase();
    const pool = [];
    const seen = new Set();
    for (const r of catalog.rows) {
      const key = U(r.m || r.sp); if (seen.has(key)) continue;
      if (!t || [r.m, r.sp, r.d, r.mf].some((v) => U(v).includes(t))) { pool.push({ kind: "order", r }); seen.add(key); }
      if (pool.length >= 40) break;
    }
    if (t) for (const i of state.items) {
      const key = U(i.mpn || i.description); if (!key || seen.has(key)) continue;
      if ([i.mpn, i.description, i.supplierPn].some((v) => U(v).includes(t))) { pool.push({ kind: "item", r: { m: i.mpn, sp: i.supplierPn, s: i.supplier, mf: i.manufacturer, d: i.description } }); seen.add(key); }
      if (pool.length >= 60) break;
    }
    if (!catalog.rows.length && !t) results.append(h("p", { class: "hint" }, "Tip: import your Mouser/DigiKey/LCSC order history on the Setup tab and you can pick parts from it here."));
    for (const p of pool) results.append(h("button", { class: "pick", onclick: () => { close(); addFromCatalog(p.r); } },
      h("b", {}, p.r.m || p.r.sp || "—"), h("span", {}, [p.r.d, p.r.s].filter(Boolean).join(" · ")), p.kind === "item" ? h("em", {}, "already counted elsewhere") : null));
    if (t && !pool.length) results.append(h("p", { class: "hint" }, "No match in your orders."));
  };
  const input = h("input", { type: "search", placeholder: "Search your orders: MPN, Mouser #, description…", oninput: (e) => { q = e.target.value; draw(); } });
  const wrap = h("div", { class: "modal-wrap", onclick: (e) => { if (e.target === wrap) close(); } },
    h("div", { class: "modal tall" }, h("h3", {}, "Add a part by hand"), input, results,
      h("div", { class: "row between" }, h("button", { class: "btn ghost", onclick: close }, "Cancel"), h("button", { class: "btn", onclick: () => { close(); addFromCatalog(null); } }, "Blank entry"))));
  document.body.append(wrap); draw(); setTimeout(() => input.focus(), 50);
}
async function addPhotoTo(it, file, identify) {
  const { photo, thumb } = await decodeFile(file, { decode: false });
  await savePhoto(it.id, thumb);
  photoCache.delete(it.id);
  const upd = { hasPhoto: true };
  if (identify && aiOn()) upd.ai = "pending";
  await write(() => store.update("items", it.id, upd));
  if (identify && aiOn()) queueAI(it.id, photo, { mpn: it.mpn, supplierPn: it.supplierPn, description: it.description }, it.raw ? "bag" : "loose");
}
async function identifyAgain(it) {
  const p = await getPhoto(it.id);
  if (!p) return;
  const fresh = {};
  for (const k of ["description", "category", "manufacturer", "mpn", "supplierPn"]) if (!it.raw) fresh[k] = "";
  await write(() => store.update("items", it.id, { ...fresh, ai: "pending" }));
  queueAI(it.id, dataUrlToBlob(p), it.raw ? { mpn: it.mpn, supplierPn: it.supplierPn } : {}, it.raw ? "bag" : "loose");
}
const photoCache = new Map();
async function getPhoto(id) {
  if (photoCache.has(id)) return photoCache.get(id);
  const d = await store.get("photos", id).catch(() => null);
  const v = d?.data && String(d.data).startsWith("data:image/") ? d.data : null;
  photoCache.set(id, v);
  return v;
}

/* ================= PDF labels ================= */
const LAYOUTS = {
  s24: { name: "24 per A4 — 70×37 mm stickers", cols: 3, rows: 8, w: 70, h: 37, x0: 0, y0: 0.5, qr: 29, code: 20, nameSize: 9 },
  s8: { name: "8 per A4 — 105×74 mm (big, for crates)", cols: 2, rows: 4, w: 105, h: 74, x0: 0, y0: 0.5, qr: 56, code: 30, nameSize: 13 },
  p12: { name: "12 per A4 on plain paper (cut out)", cols: 3, rows: 4, w: 62, h: 62, x0: 12, y0: 24.5, qr: 40, code: 22, nameSize: 10, border: true, stacked: true },
};
const PART_LAYOUTS = {
  s65: { name: "65 per A4 — 38×21 mm small stickers", cols: 5, rows: 13, w: 38.1, h: 21.2, x0: 4.65, y0: 10.7, gapX: 2.5, qr: 17 },
  s24: { name: "24 per A4 — 70×37 mm stickers", cols: 3, rows: 8, w: 70, h: 37, x0: 0, y0: 0.5, gapX: 0, qr: 28 },
  p40: { name: "40 per A4 on plain paper (cut out)", cols: 4, rows: 10, w: 48, h: 26, x0: 9, y0: 18.5, gapX: 0, qr: 21, border: true },
};
function drawQR(doc, text, x, y, size) {
  const q = qrcode(0, "M"); q.addData(text); q.make();
  const n = q.getModuleCount(), quiet = 1, cell = size / (n + quiet * 2);
  doc.setFillColor(0, 0, 0);
  for (let r = 0; r < n; r++) {
    let run = -1;
    for (let c = 0; c <= n; c++) {
      const dark = c < n && q.isDark(r, c);
      if (dark && run < 0) run = c;
      if (!dark && run >= 0) { doc.rect(x + (quiet + run) * cell, y + (quiet + r) * cell, (c - run) * cell + 0.01, cell + 0.01, "F"); run = -1; }
    }
  }
}
function buildBoxLabelsPDF(boxes, layoutKey, skip) {
  const L = LAYOUTS[layoutKey];
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const per = L.cols * L.rows;
  let slot = Math.max(0, Math.min(per - 1, skip | 0));
  boxes.forEach((b, i) => {
    if (i > 0 && slot % per === 0) doc.addPage();
    const s = slot % per, col = s % L.cols, row = Math.floor(s / L.cols);
    const x = L.x0 + col * L.w, y = L.y0 + row * L.h;
    const sub = [b.name, b.location].filter(Boolean).join(" — ");
    if (L.border) { doc.setDrawColor(190); doc.setLineDashPattern([1, 1], 0); doc.rect(x, y, L.w, L.h); doc.setLineDashPattern([], 0); }
    doc.setTextColor(0);
    if (L.stacked) {
      drawQR(doc, BOX_PREFIX + b.id, x + (L.w - L.qr) / 2, y + 2, L.qr);
      doc.setFont("helvetica", "bold"); doc.setFontSize(L.code);
      doc.text(b.id, x + L.w / 2, y + L.qr + 9, { align: "center" });
      doc.setFont("helvetica", "normal"); doc.setFontSize(L.nameSize);
      doc.text(doc.splitTextToSize(sub, L.w - 6).slice(0, 2), x + L.w / 2, y + L.qr + 14.5, { align: "center" });
    } else {
      const p = (L.h - L.qr) / 2;
      drawQR(doc, BOX_PREFIX + b.id, x + p * 0.6, y + p, L.qr);
      const tx = x + p * 0.6 + L.qr + 2, tw = L.w - (tx - x) - 3;
      doc.setFont("helvetica", "bold"); doc.setFontSize(L.code);
      doc.text(b.id, tx, y + p + L.code * 0.32);
      doc.setFont("helvetica", "normal"); doc.setFontSize(L.nameSize);
      doc.text(doc.splitTextToSize(sub, tw).slice(0, layoutKey === "s8" ? 5 : 3), tx, y + p + L.code * 0.32 + L.nameSize * 0.5 + 1.5);
      doc.setFontSize(6); doc.setTextColor(120);
      doc.text("Scan to file parts here", tx, y + L.h - p + 0.5);
    }
    slot++;
  });
  return doc.output("arraybuffer");
}
function buildPartLabelsPDF(items, layoutKey, skip) {
  const L = PART_LAYOUTS[layoutKey];
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const per = L.cols * L.rows;
  let slot = Math.max(0, Math.min(per - 1, skip | 0));
  items.forEach((it, i) => {
    if (i > 0 && slot % per === 0) doc.addPage();
    const s = slot % per, col = s % L.cols, row = Math.floor(s / L.cols);
    const x = L.x0 + col * (L.w + L.gapX), y = L.y0 + row * L.h;
    if (L.border) { doc.setDrawColor(190); doc.setLineDashPattern([1, 1], 0); doc.rect(x, y, L.w, L.h); doc.setLineDashPattern([], 0); }
    const p = (L.h - L.qr) / 2;
    drawQR(doc, PART_PREFIX + it.id, x + 0.8, y + p, L.qr);
    const tx = x + L.qr + 1.8, tw = L.w - L.qr - 3;
    const small = layoutKey === "s65";
    doc.setTextColor(0);
    doc.setFont("helvetica", "bold");
    const title = it.mpn || it.description || "Part";
    let fs = small ? 6.5 : 9;
    doc.setFontSize(fs);
    if (it.mpn) while (fs > 4.5 && doc.getTextWidth(title) > tw) { fs -= 0.25; doc.setFontSize(fs); }
    const titleLines = doc.splitTextToSize(title, tw).slice(0, 2);
    let ty = y + p + (small ? 2.4 : 3.4);
    doc.text(titleLines, tx, ty); ty += titleLines.length * (small ? 2.6 : 3.6);
    doc.setFont("helvetica", "normal"); doc.setFontSize(small ? 5.5 : 7.5);
    if (it.mpn && it.description) { const d = doc.splitTextToSize(it.description, tw).slice(0, small ? 2 : 3); doc.text(d, tx, ty); ty += d.length * (small ? 2.2 : 3); }
    doc.setFontSize(small ? 5.5 : 7); doc.setTextColor(90);
    doc.text([it.box, it.qty != null && it.qty !== "" ? `${it.qty} pcs` : ""].filter(Boolean).join(" · "), tx, y + L.h - p - 0.3);
    slot++;
  });
  return doc.output("arraybuffer");
}

/* ================= Excel ================= */
function buildWorkbook() {
  const box = (c) => boxByCode(c) || {};
  const status = (i) => (i.countStatus === "counted" && i.count !== "" && i.count != null ? "Counted" : i.countStatus === "skipped" ? "Can't count" : "Not counted yet");
  const rowOf = (i) => ({
    List: LISTS[listOf(i)].name, Box: i.box || "", "Box name": box(i.box).name || "", Location: box(i.box).location || "", Category: i.category || "", Description: i.description || "",
    Manufacturer: i.manufacturer || "", "Manufacturer PN": i.mpn || "", Supplier: i.supplier || "", "Supplier PN": i.supplierPn || "",
    "COUNTED QTY (actual)": status(i) === "Counted" ? Number(i.count) : "", "Count status": status(i),
    "Counted by": i.countedBy && status(i) !== "Not counted yet" ? realName(i.countedBy) : "", "Counted at": i.countedAt && status(i) !== "Not counted yet" ? new Date(i.countedAt).toLocaleString() : "",
    "Label qty (scanned, NOT verified)": i.qty === "" || i.qty == null ? "" : Number(i.qty),
    "PO / order": i.po || i.order || "", Invoice: i.invoice || "", Line: i.line || "",
    Lot: i.lot || "", "Date code": i.dateCode || "", "Country of origin": i.coo || "", Serial: i.serial || "", Notes: i.notes || "",
    "How identified": i.source === "label-text" ? "Codes + label text" : i.raw ? "Supplier code" : i.source === "order" ? "Picked from orders" : i.source === "photo" ? (i.aiConfidence ? `Claude from photo (${i.aiConfidence} confidence)` : "Photo") : "By hand",
    "Read from": i.readFrom || "", "Needs check": i.needsCheck ? "yes" : "", "Own label": i.labelPrinted ? PART_PREFIX + i.id : "",
    "Scanned by": realName(i.by), "Scanned at": i.at ? new Date(i.at).toLocaleString() : "", "Raw barcode": printable(i.raw),
  });
  const WIDTHS = [18, 6, 18, 16, 16, 36, 16, 20, 10, 18, 12, 15, 14, 16, 14, 12, 12, 6, 10, 9, 8, 22, 24, 18, 30, 8, 18, 14, 16, 40];
  const sheetOf = (rows) => {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ List: "" }]);
    ws["!cols"] = WIDTHS.map((w) => ({ wch: w }));
    if (rows.length) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: Object.keys(rows[0]).length - 1 } }) };
    return ws;
  };
  const sorted = [...state.items].sort((a, b) => (a.box || "~").localeCompare(b.box || "~") || (a.at || 0) - (b.at || 0));
  const wb = XLSX.utils.book_new();
  const readme = XLSX.utils.aoa_to_sheet([
    ["Inventory export", new Date().toLocaleString()],
    [],
    ["COUNTED QTY (actual)", "What someone physically counted in that bag. This is the real stock."],
    ["Count status", "Counted / Can't count (counting not possible) / Not counted yet"],
    ["Label qty (scanned, NOT verified)", "What the supplier label says. Not checked — do not use as stock."],
    ["Electrical / Wiring harness", "One sheet per list. 'By part' totals per part, per list."],
    ["By part → Counted total", "Sum of counted bags only. 'Count complete' says whether every bag of that part was counted."],
  ]);
  readme["!cols"] = [{ wch: 34 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, readme, "Read me");
  for (const l of ["el", "wh"]) XLSX.utils.book_append_sheet(wb, sheetOf(sorted.filter((i) => listOf(i) === l).map(rowOf)), l === "el" ? "Electrical" : "Wiring harness");

  const agg = new Map();
  for (const i of state.items) {
    const key = listOf(i) + "|" + U(i.mpn || i.description || i.supplierPn || "(unknown)");
    const a = agg.get(key) || { List: LISTS[listOf(i)].name, "Manufacturer PN": i.mpn || "", Description: i.description || "", Category: i.category || "", Manufacturer: i.manufacturer || "",
      "COUNTED total (actual)": 0, "Bags counted": 0, "Bags can't count": 0, "Bags not counted yet": 0, Bags: 0, "Count complete": "", "Label qty total (NOT verified)": 0, Boxes: new Set() };
    const st = status(i);
    if (st === "Counted") { a["COUNTED total (actual)"] += Number(i.count) || 0; a["Bags counted"]++; }
    else if (st === "Can't count") a["Bags can't count"]++; else a["Bags not counted yet"]++;
    a.Bags++; a["Label qty total (NOT verified)"] += Number(i.qty) || 0; if (i.box) a.Boxes.add(i.box);
    if (!a.Description && i.description) a.Description = i.description;
    if (!a.Category && i.category) a.Category = i.category;
    agg.set(key, a);
  }
  const byPart = [...agg.values()].map((a) => ({ ...a, "Count complete": a["Bags counted"] === a.Bags ? "yes" : a["Bags counted"] ? "partly" : "no", Boxes: [...a.Boxes].sort().join(", ") }))
    .sort((a, b) => a.List.localeCompare(b.List) || (a.Category || "~").localeCompare(b.Category || "~") || String(a["Manufacturer PN"]).localeCompare(String(b["Manufacturer PN"])));
  const ws2 = XLSX.utils.json_to_sheet(byPart.length ? byPart : [{ List: "" }]);
  ws2["!cols"] = [18, 22, 40, 16, 18, 14, 8, 10, 12, 6, 10, 14, 30].map((w) => ({ wch: w }));
  if (byPart.length) ws2["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: byPart.length, c: 12 } }) };
  XLSX.utils.book_append_sheet(wb, ws2, "By part");

  const boxes = [...state.boxes].sort((a, b) => a.id.localeCompare(b.id)).map((b) => {
    const its = state.items.filter((i) => i.box === b.id);
    return { List: LISTS[listOf(b)].name, Box: b.id, Name: b.name || "", Location: b.location || "", Bags: its.length, "Bags counted": its.filter((i) => status(i) === "Counted").length };
  });
  const ws3 = XLSX.utils.json_to_sheet(boxes.length ? boxes : [{ Box: "" }]);
  ws3["!cols"] = [{ wch: 18 }, { wch: 8 }, { wch: 36 }, { wch: 22 }, { wch: 6 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws3, "Boxes");

  const people = new Map();
  for (const i of state.items) {
    const p = people.get(i.by || "") || { s: 0, c: 0 }; p.s++; people.set(i.by || "", p);
    if (status(i) === "Counted" && i.countedBy != null) { const q = people.get(i.countedBy || "") || { s: 0, c: 0 }; q.c++; people.set(i.countedBy || "", q); }
  }
  const ws4 = XLSX.utils.json_to_sheet([...people.entries()].map(([id, p]) => ({ Person: realName(id) || "Unknown", "Bags scanned": p.s, "Bags counted": p.c })));
  XLSX.utils.book_append_sheet(wb, ws4, "Team");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}
async function saveFile(filename, data) {
  if (!downloads) {
    if (!INCLAUDE) {
      const type = filename.endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      const url = URL.createObjectURL(new Blob([data], { type }));
      const a = h("a", { href: url, download: filename }); document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return true;
    }
    toast("Downloads aren't available here.", "err"); return false;
  }
  try { await downloads.save({ filename, data }); return true; }
  catch (e) { if (e?.code !== "declined") toast("Couldn't save the file" + (e?.code ? ` (${e.code})` : ""), "err"); return false; }
}

/* ================= rendering ================= */
const TABS = ["scan", "items", "boxes", "setup"];
const expanded = new Set();
let tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "scan";
let filterBox = "", filterWho = "", filterFlag = "", search = "";
window.addEventListener("hashchange", () => { const t = location.hash.slice(1); if (TABS.includes(t)) { tab = t; sendPresence(); render(); } });

function bannerEl() {
  let msg = "";
  const st = state.sheetStatus || {};
  if (state.mode === "local") msg = INCLAUDE ? "Saved on this device only — open this page inside Claude to share the list with your team." : "Saved on this phone only. To count together, connect a team Google Sheet on the Setup tab (or open your team's invite link).";
  else if (state.mode === "sheet" && st.error === "bad_key") msg = "The team code is wrong — open the invite link again or fix it on the Setup tab.";
  else if (state.mode === "sheet" && st.online === false) msg = `Offline — ${st.pending ? plural(st.pending, "change") + " will upload" : "changes will upload"} when the connection is back. Keep scanning.`;
  else if (state.dbError) msg = "Lost connection to the shared list. Reload the page to reconnect.";
  else if (state.slow) msg = "Can't reach the shared list yet — what you see may be out of date.";
  else if (state.readOnly) msg = "View only — you can't add scans yet. See the Setup tab for how to get access.";
  return msg ? h("div", { class: "banner" }, msg) : null;
}
function statusEl() {
  const bits = [];
  if (processing > 0) bits.push(h("span", { class: "pill busy" }, `Reading ${plural(processing, "photo")}…`));
  const pending = aiQueue.length + (aiBusy ? 1 : 0);
  if (pending) bits.push(h("span", { class: "pill busy" }, `Claude identifying ${pending}…`));
  if (state.mode === "sheet" && state.sheetStatus?.pending && state.sheetStatus?.online !== false) bits.push(h("span", { class: "pill busy" }, `Uploading ${state.sheetStatus.pending}…`));
  if (ocrLoading) bits.push(h("span", { class: "pill busy" }, "Loading text reader (first time only)…"));
  else if (ocrBusy) bits.push(h("span", { class: "pill busy" }, "Reading label text…"));
  if (aiPaused) bits.push(h("button", { class: "pill btnlink", onclick: () => { aiPaused = false; pumpAI(); emit(); } }, "Resume Claude"));
  return h("div", { class: "status" }, ...bits);
}
function boxSelect(value, onchange, opts = {}) {
  const sel = h("select", { onchange: (e) => { e.target.blur(); onchange(e.target.value); }, class: opts.class || "", disabled: opts.disabled },
    h("option", { value: "" }, opts.empty || "— no box —"),
    ...[...state.boxes].filter((b) => listOf(b) === (opts.list || currentList) || b.id === value).sort((a, b) => a.id.localeCompare(b.id)).map((b) => h("option", { value: b.id }, b.id + (b.name ? " · " + b.name : "") + (b.location ? " (" + b.location + ")" : ""))));
  sel.value = value || "";
  return sel;
}
function chip(text, cls = "") { return h("span", { class: "tag " + cls }, text); }
function listSwitch() {
  const n = (l) => state.items.filter((i) => listOf(i) === l).length;
  return h("div", { class: "seg", role: "tablist", "aria-label": "Which list" },
    ...["el", "wh"].map((l) => h("button", { class: currentList === l ? "on" : "", role: "tab", "aria-selected": currentList === l ? "true" : "false", onclick: () => setList(l) },
      LISTS[l].name, h("span", { class: "n" }, n(l) ? ` ${n(l)}` : ""))));
}

function photoEl(id) {
  const img = h("img", { class: "photo", alt: "Photo of the part", onerror: () => wrap.remove() });
  const wrap = h("div", { class: "photo-wrap", hidden: true }, img);
  getPhoto(id).then((src) => { if (src) { img.src = src; wrap.hidden = false; } else wrap.remove(); });
  return wrap;
}

function itemCard(it) {
  const open = expanded.has(it.id);
  const title = it.description || it.mpn || (it.ai === "pending" ? "Claude is identifying…" : "Unnamed part");
  const counted = it.countStatus === "counted" && it.count !== "" && it.count != null;
  const cnt = counted ? `${it.count} counted` : it.countStatus === "skipped" ? "can't count" : it.qty != null && it.qty !== "" ? `label ${it.qty} · not counted` : "not counted";
  const sub = [it.mpn && it.description ? it.mpn : "", cnt, it.supplier || "", it.box || "no box"].filter(Boolean).join(" · ");
  const flags = [
    !counted && it.countStatus !== "skipped" ? chip("count?", "count") : null,
    it.ai === "pending" ? h("span", { class: "dot" }) : null,
    it.needsCheck ? chip("check", "warn") : null,
    it.needsLabel && !it.labelPrinted ? chip("no label") : null,
  ];
  const head = h("button", { class: "card-head", onclick: () => { open ? expanded.delete(it.id) : expanded.add(it.id); emit(); } },
    h("div", { class: "card-title" }, h("span", { class: "t" }, title), ...flags),
    h("div", { class: "card-sub" }, sub));
  const card = h("div", { class: "card" + (open ? " open" : "") + (lastFound === it.id ? " found" : ""), "data-id": it.id }, head);
  if (!open) return card;
  const ro = state.readOnly;
  const save = async (field, raw) => {
    let v = raw;
    if (field === "qty") v = raw === "" ? "" : Number(raw);
    if ((it[field] ?? "") === v) return;
    const upd = { [field]: v };
    if (field === "description" && !it.category) { const g = guessCategory(v, listOf(it)); if (g) upd.category = g; }
    if (field === "box" && v && boxByCode(v)) upd.list = listOf(boxByCode(v));
    await write(() => store.update("items", it.id, upd));
  };
  const form = h("div", { class: "form" });
  const countIn = h("input", bound(it.id + ":count", counted ? it.count : "", (v) => saveCountField(it.id, v), { name: "count", type: "number", inputmode: "numeric", min: "0", placeholder: it.countStatus === "skipped" ? "can't count" : "not counted yet", enterkeyhint: "done", disabled: ro }));
  form.append(h("div", { class: "countrow wide" },
    h("label", {}, h("span", {}, "Counted qty (actual)"), countIn),
    h("div", { class: "countside" },
      h("span", { class: "small" }, counted ? `by ${nameOf(it.countedBy) || "?"}${it.countedAt ? " · " + fmtTime(it.countedAt) : ""}` : it.countStatus === "skipped" ? "marked as can't count" : "0 removes a mis-scan"),
      ro ? null : it.countStatus === "skipped"
        ? h("button", { class: "btnlink", onclick: () => write(() => store.update("items", it.id, { countStatus: "" })) }, "Count it after all")
        : h("button", { class: "btnlink", onclick: () => skipCount(it.id) }, "Can't count"))));
  form.append(h("label", {}, h("span", {}, "Box"), boxSelect(it.box, (v) => save("box", v), { disabled: ro, list: listOf(it) })));
  for (const [k, label] of FIELDS) {
    let input;
    if (k === "category") {
      const cats = catsFor(listOf(it)), opts2 = it[k] && !cats.includes(it[k]) ? [...cats, it[k]] : cats;
      input = h("select", { name: k, onchange: (e) => { e.target.blur(); save(k, e.target.value); }, disabled: ro }, h("option", { value: "" }, "—"), ...opts2.map((c) => h("option", { value: c }, c)));
      input.value = it[k] || "";
    } else {
      const live = k === "description" || k === "mpn" ? () => { // keep the card title in step while typing
        const d = card.querySelector('input[name="description"]')?.value.trim(), m = card.querySelector('input[name="mpn"]')?.value.trim();
        const t = card.querySelector(".card-title .t"); if (t) t.textContent = d || m || "Unnamed part";
      } : null;
      input = h("input", bound(it.id + ":" + k, it[k], (v) => saveItemField(it.id, k, v), { name: k, type: k === "qty" ? "number" : "text", inputmode: k === "qty" ? "numeric" : null, autocomplete: "off", enterkeyhint: "done", disabled: ro, oninput: live }));
    }
    form.append(h("label", { class: k === "description" || k === "notes" ? "wide" : "" }, h("span", {}, label), input));
  }
  const meta = [it.order && `Order ${it.order}`, it.po && `PO ${it.po}`, it.dateCode && `Date code ${it.dateCode}`, it.invoice && `Invoice ${it.invoice}`, it.line && `Line ${it.line}`, it.lot && `Lot ${it.lot}`, it.coo && `Made in ${it.coo}`, it.serial && `S/N ${it.serial}`].filter(Boolean).join(" · ");
  const q = encodeURIComponent(it.mpn || it.supplierPn || it.description || "");
  const addPh = fileInput({ capture: "environment" }, (f) => addPhotoTo(it, f[0], !it.description));
  const actions = h("div", { class: "row actions" },
    currentBox && it.box !== currentBox && !ro ? h("button", { class: "btn small primary", onclick: () => { write(() => store.update("items", it.id, { box: currentBox })); toast(`Moved to ${currentBox}`, "ok"); } }, `Move to ${currentBox}`) : null,
    it.needsCheck && !ro ? h("button", { class: "btn small", onclick: () => write(() => store.update("items", it.id, { needsCheck: false })) }, "Checked ✓") : null,
    ro ? null : h("button", { class: "btn small", onclick: () => addPh.click() }, it.hasPhoto ? "New photo" : "Add photo"), addPh,
    it.hasPhoto && aiOn() && !ro && it.ai !== "pending" ? h("button", { class: "btn small", onclick: () => identifyAgain(it) }, "Ask Claude again") : null,
    q ? h("a", { class: "btn small ghost", href: `https://octopart.com/search?q=${q}`, target: "_blank", rel: "noopener" }, "Look up ↗") : null,
    it.supplier === "Farnell" && /^\d{6,8}$/.test(it.supplierPn || "") ? h("a", { class: "btn small ghost", href: `https://nl.farnell.com/search?st=${it.supplierPn}`, target: "_blank", rel: "noopener" }, "Farnell ↗") : null,
    it.supplier === "RS" && it.supplierPn ? h("a", { class: "btn small ghost", href: `https://nl.rs-online.com/web/c/?searchTerm=${encodeURIComponent(it.supplierPn)}`, target: "_blank", rel: "noopener" }, "RS ↗") : null,
    ro ? null : h("button", { class: "btn small ghost danger", onclick: () => confirmDelete(it) }, "Delete"));
  card.append(...[
    it.hasPhoto ? photoEl(it.id) : null,
    it.aiSeen || it.aiConfidence ? h("div", { class: "aiNote" + (it.aiConfidence === "low" ? " low" : "") }, `Claude (${it.aiConfidence || "?"} confidence): ${it.aiSeen || ""}`) : null,
    form,
    meta ? h("div", { class: "meta" }, meta) : null,
    it.readFrom ? h("div", { class: "meta" }, "Read from — " + it.readFrom) : null,
    h("div", { class: "meta" }, `Counted ${it.at ? fmtTime(it.at) : ""}${it.by ? " by " + nameOf(it.by) : ""}${it.fromOrder ? " · matched your order history" : ""}${it.ai === "failed" ? " · Claude couldn't identify it" : ""}${it.labelPrinted ? " · has own label" : ""}`),
    it.codes?.length ? h("details", { class: "raw" }, h("summary", {}, `${plural(it.codes.length, "barcode")} read`), h("pre", {}, it.codes.map(printable).join("\n"))) : null,
    actions].filter(Boolean));
  return card;
}
function confirmDelete(it) {
  modal(`Delete “${it.description || it.mpn || "this part"}”?`, "It will be removed from the list for everyone.", "Delete", async () => {
    expanded.delete(it.id);
    await write(() => store.del("items", it.id));
    if (it.hasPhoto) write(() => store.del("photos", it.id), true);
  });
}
function modal(title, body, okLabel, onOk, extra) {
  const close = () => wrap.remove();
  const wrap = h("div", { class: "modal-wrap", onclick: (e) => { if (e.target === wrap) close(); } },
    h("div", { class: "modal" }, h("h3", {}, title), body ? h("p", {}, body) : null, extra || null,
      h("div", { class: "row end" }, h("button", { class: "btn ghost", onclick: close }, "Cancel"),
        h("button", { class: "btn " + (okLabel === "Delete" ? "danger" : "primary"), onclick: async () => { close(); await onOk(); } }, okLabel))));
  document.body.append(wrap);
}

function teamStrip(compact) {
  const team = teamNow();
  if ((!room && state.mode !== "sheet") || team.length < 1) return null;
  const others = team.filter((p) => !p.isMe);
  const clash = currentBox && others.filter((p) => p.boxes.has(currentBox));
  return h("div", { class: "team" + (compact ? " compact" : "") },
    h("div", { class: "team-head" }, h("span", { class: "live" }), others.length ? `Counting now: ${team.length} people` : "Only you right now"),
    h("div", { class: "team-list" }, ...team.map((p) => h("span", { class: "who" + (p.isMe ? " me" : "") },
      h("b", {}, p.isMe ? "You" : realName(p.id) || "Teammate"), p.boxes.size ? ` · ${[...p.boxes].join(", ")}` : " · no box", p.n ? ` · ${p.n} today` : ""))),
    clash?.length ? h("div", { class: "clash" }, `${clash.map((p) => realName(p.id) || "A teammate").join(" & ")} ${clash.length > 1 ? "are" : "is"} also filling ${currentBox} — split the box or pick another.`) : null);
}

function viewJoin() {
  const nameIn = h("input", { type: "text", "data-f": "joinname", placeholder: "Your name", autocomplete: "name", value: cfg.name || "" });
  const btn = h("button", { class: "btn primary huge", onclick: () => connectSheet(cfg.api, cfg.key, nameIn.value, btn) }, "Join");
  return h("section", { class: "panel join" },
    h("h2", {}, "Join the team inventory"),
    h("p", { class: "small" }, "No Claude account needed. Your name shows next to what you count."),
    nameIn, btn,
    h("button", { class: "btnlink", onclick: () => { cfg = {}; ls.set("cfg", cfg); location.reload(); } }, "Not now — use on this phone only"));
}

function viewScan() {
  if (state.mode === "join") return viewJoin();
  const box = boxByCode(currentBox);
  const camBag = fileInput({ capture: "environment", "data-k": "bag" }, (f) => handleFiles(f, "bag"));
  const camLoose = fileInput({ capture: "environment", "data-k": "loose" }, (f) => handleFiles(f, "loose"));
  const lib = fileInput({ multiple: true, "data-k": "lib" }, (f) => handleFiles(f, "bag"));
  const camBox = fileInput({ capture: "environment" }, async (f) => { const { thumb } = await decodeFile(f[0], { decode: false }); await savePhoto("box-" + currentBox, thumb); photoCache.delete("box-" + currentBox); await write(() => store.update("boxes", currentBox, { hasPhoto: true })); toast("Box photo saved", "ok"); });
  const recentItems = recent.map((id) => state.items.find((i) => i.id === id)).filter(Boolean).slice(0, 10);
  const inBox = currentBox ? state.items.filter((i) => i.box === currentBox).length : 0;
  const ro = state.readOnly;
  const newBoxBtn = h("button", { class: "btnlink", disabled: ro, onclick: async () => { const m = await addBoxes([""]); if (m[0]) { setCurrentBox(m[0]); toast(`New box ${m[0]} — name it below, print its label later`, "ok"); setTimeout(() => $("#boxname")?.focus(), 80); } } }, "+ New box");
  return h("div", {},
    listSwitch(),
    teamStrip(true),
    h("section", { class: "boxbar" },
      h("div", { class: "row between" }, h("div", { class: "boxbar-label" }, "Filling box"), ro ? null : newBoxBtn),
      boxSelect(currentBox, setCurrentBox, { class: "big", empty: "Pick a box (or scan its label)" }),
      currentBox && box ? h("div", { class: "boxedit" },
        h("input", bound("box:" + currentBox + ":name", box.name, (v) => saveBoxField(box.id, "name", v), { id: "boxname", type: "text", placeholder: suggestBoxName(currentBox) ? `Name, e.g. ${suggestBoxName(currentBox)}` : "Name this box", disabled: ro, enterkeyhint: "done" })),
        h("input", bound("box:" + currentBox + ":loc", box.location, (v) => saveBoxField(box.id, "location", v), { type: "text", placeholder: "Where is it? e.g. Cabinet 2, shelf 3", disabled: ro, enterkeyhint: "done" }))) : null,
      h("div", { class: "row between boxbar-sub" },
        h("span", {}, currentBox ? `${plural(inBox, "bag")} in ${currentBox}${box && !box.printed ? " · label not printed yet" : ""}` : "Scan a box label, pick one, or start a new box."),
        currentBox && !ro ? h("button", { class: "btnlink", onclick: () => camBox.click() }, box?.hasPhoto ? "Retake box photo" : "Photo of box") : null), camBox),
    liveAvailable() ? h("div", { class: "scanbtns" }, camBag, camLoose, lib,
      h("button", { class: "btn primary huge", disabled: ro, onclick: openLive }, h("span", { class: "ico" }, cameraIcon()), "Live scan"),
      h("div", { class: "grid2" },
        h("button", { class: "btn", disabled: ro, onclick: () => camBag.click() }, h("b", {}, "Snap a photo"), h("small", {}, "Labels with only stripes")),
        h("button", { class: "btn", disabled: ro, onclick: () => camLoose.click() }, h("b", {}, "Unmarked part"), h("small", {}, aiOn() ? "Claude identifies it" : "Saved with a photo")),
        h("button", { class: "btn", disabled: ro, onclick: addByHandDialog }, h("b", {}, "Add by hand"), h("small", {}, catalog.rows.length ? "Pick from orders" : "Type it in")),
        h("button", { class: "btn", disabled: ro, onclick: () => lib.click() }, h("b", {}, "Pick photos"), h("small", {}, "Many at once")))) :
    h("div", { class: "scanbtns" }, camBag, camLoose, lib,
      h("button", { class: "btn primary huge", disabled: ro, onclick: () => camBag.click() }, h("span", { class: "ico" }, cameraIcon()), "Snap a labelled bag"),
      h("div", { class: "grid3" },
        h("button", { class: "btn", disabled: ro, onclick: () => camLoose.click() }, h("b", {}, "Unmarked part"), h("small", {}, aiOn() ? "Claude identifies it" : "Saved with a photo")),
        h("button", { class: "btn", disabled: ro, onclick: addByHandDialog }, h("b", {}, "Add by hand"), h("small", {}, catalog.rows.length ? "Pick from orders" : "Type it in")),
        h("button", { class: "btn", disabled: ro, onclick: () => lib.click() }, h("b", {}, "Pick photos"), h("small", {}, "Many at once")))),
    h("details", { class: "hint tips" }, h("summary", {}, "Tips for speed"),
      h("ul", {},
        liveAvailable() ? h("li", {}, "Live scan: hold the camera over the square code on each bag; it beeps when counted. Scanning a box label switches box.") : null,
        h("li", {}, "Photograph a box label, then its bags — the box switches automatically."),
        h("li", {}, "Fastest: shoot everything with your camera app (box label, its bags, next box label…), then add them all with “Pick photos”. They're filed in the order you took them."),
        h("li", {}, "No label on a bag or part? Use “Unmarked part”, then print it its own QR sticker from the Parts tab. Next time it scans like any other bag."),
        h("li", {}, "Split up: give each person their own boxes. You'll see who is in which box above."))),
    statusEl(),
    recentItems.length ? h("h2", { class: "sect" }, "Just counted") : null,
    ...recentItems.map(itemCard));
}

function filteredItems() {
  const qs = search.trim().toLowerCase();
  let items = state.items.filter((i) => listOf(i) === currentList && (!filterBox || (filterBox === "__none" ? !i.box : i.box === filterBox)));
  if (filterFlag === "uncounted") items = items.filter((i) => !(i.countStatus === "counted" && i.count !== "" && i.count != null) && i.countStatus !== "skipped");
  if (filterFlag === "skipped") items = items.filter((i) => i.countStatus === "skipped");
  if (filterWho) items = items.filter((i) => (filterWho === "__me" ? i.by === state.me : i.by === filterWho));
  if (filterFlag === "check") items = items.filter((i) => i.needsCheck || i.ai === "failed");
  if (filterFlag === "label") items = items.filter((i) => i.needsLabel && !i.labelPrinted);
  if (filterFlag === "nodesc") items = items.filter((i) => !i.description);
  if (qs) items = items.filter((i) => [i.description, i.mpn, i.manufacturer, i.supplierPn, i.category, i.notes, i.box].some((v) => String(v || "").toLowerCase().includes(qs)));
  return items.sort((a, b) => (b.at || 0) - (a.at || 0));
}
function itemsBody() {
  const items = filteredItems();
  const countedBags = items.filter((i) => i.countStatus === "counted" && i.count !== "" && i.count != null);
  const total = countedBags.reduce((s2, i) => s2 + (Number(i.count) || 0), 0);
  return h("div", { id: "itemsbody" },
    h("div", { class: "row between summary" }, h("span", {}, `${plural(items.length, "bag")} · ${countedBags.length} counted · ${total.toLocaleString()} pcs counted`),
      h("div", { class: "row" },
        h("button", { class: "btn", disabled: !items.length, onclick: async () => { await commitAll(); partLabelDialog(filteredItems(), filteredItems().filter((i) => i.needsLabel && !i.labelPrinted)); } }, "Part labels"),
        h("button", { class: "btn primary", disabled: !state.items.length, onclick: async (e) => { e.target.disabled = true; try { await commitAll(); await saveFile(`inventory-${today()}.xlsx`, new Uint8Array(buildWorkbook())); } finally { e.target.disabled = false; } } }, "Export to Excel"))),
    items.length ? null : h("p", { class: "empty" }, state.items.length ? "Nothing matches." : "Nothing counted yet — start on the Scan tab."),
    ...items.slice(0, 250).map(itemCard),
    items.length > 250 ? h("p", { class: "hint" }, `Showing 250 of ${items.length}. Search or filter to narrow down; the export contains everything.`) : null);
}
function viewItems() {
  const qs = search.trim().toLowerCase();
  let items = state.items.filter((i) => listOf(i) === currentList && (!filterBox || (filterBox === "__none" ? !i.box : i.box === filterBox)));
  if (filterFlag === "uncounted") items = items.filter((i) => !(i.countStatus === "counted" && i.count !== "" && i.count != null) && i.countStatus !== "skipped");
  if (filterFlag === "skipped") items = items.filter((i) => i.countStatus === "skipped");
  if (filterWho) items = items.filter((i) => (filterWho === "__me" ? i.by === state.me : i.by === filterWho));
  if (filterFlag === "check") items = items.filter((i) => i.needsCheck || i.ai === "failed");
  if (filterFlag === "label") items = items.filter((i) => i.needsLabel && !i.labelPrinted);
  if (filterFlag === "nodesc") items = items.filter((i) => !i.description);
  if (qs) items = items.filter((i) => [i.description, i.mpn, i.manufacturer, i.supplierPn, i.category, i.notes, i.box].some((v) => String(v || "").toLowerCase().includes(qs)));
  items.sort((a, b) => (b.at || 0) - (a.at || 0));
  const total = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);
  const boxSel = boxSelect(filterBox, (v) => { filterBox = v; emit(); }, { empty: "All boxes" });
  boxSel.append(h("option", { value: "__none" }, "Not in a box")); boxSel.value = filterBox;
  const people = [...new Set(state.items.map((i) => i.by).filter(Boolean))];
  const whoSel = h("select", { onchange: (e) => { e.target.blur(); filterWho = e.target.value; emit(); } }, h("option", { value: "" }, "Everyone"), h("option", { value: "__me" }, "Counted by me"),
    ...people.filter((p) => p !== state.me).map((p) => h("option", { value: p }, realName(p) || "Teammate")));
  whoSel.value = filterWho;
  const flagSel = h("select", { onchange: (e) => { e.target.blur(); filterFlag = e.target.value; emit(); } }, h("option", { value: "" }, "All parts"), h("option", { value: "uncounted" }, "Not counted yet"), h("option", { value: "skipped" }, "Can't count"), h("option", { value: "check" }, "Needs checking"), h("option", { value: "label" }, "Needs own label"), h("option", { value: "nodesc" }, "No description"));
  flagSel.value = filterFlag;
  const searchInput = h("input", { type: "search", id: "search", "data-f": "search", placeholder: "Search part, MPN, category…", value: search, enterkeyhint: "search", oninput: (e) => { search = e.target.value; clearTimeout(viewItems.t); viewItems.t = setTimeout(() => { const b = $("#itemsbody"); if (b) b.replaceWith(itemsBody()); }, 200); } });
  const unlabelled = items.filter((i) => i.needsLabel && !i.labelPrinted);
  return h("div", {},
    listSwitch(),
    h("div", { class: "toolbar" }, searchInput, h("div", { class: "filters" }, boxSel, whoSel, flagSel)),
    itemsBody());
}
function partLabelDialog(inView, unlabelled) {
  let which = unlabelled.length ? "unlabelled" : "view";
  const layoutSel = h("select", {}, ...Object.entries(PART_LAYOUTS).map(([k, l]) => h("option", { value: k }, l.name)));
  layoutSel.value = ls.get("partLayout", "s65"); layoutSel.onchange = () => ls.set("partLayout", layoutSel.value);
  const skipIn = h("input", { type: "number", min: "0", max: "64", value: "0", inputmode: "numeric", class: "num" });
  const radio = (v, label, n) => h("label", { class: "radio" }, h("input", { type: "radio", name: "which", value: v, checked: which === v, disabled: !n, onchange: () => (which = v) }), `${label} (${n})`);
  const body = h("div", { class: "stackgap" },
    h("p", { class: "small" }, "Each sticker gets a QR code that opens this exact part when scanned — handy for unmarked bags, reels and trays."),
    radio("unlabelled", "Unmarked parts without their own label", unlabelled.length),
    radio("view", "Everything currently shown", inView.length),
    h("label", { class: "stack" }, h("span", {}, "Sticker sheet"), layoutSel),
    h("label", { class: "row small nowrap" }, h("span", {}, "Skip"), skipIn, h("span", {}, "used stickers on sheet 1")));
  modal("Print part labels", "", "Download PDF", async () => {
    const list = (which === "unlabelled" ? unlabelled : inView).slice().sort((a, b) => (a.box || "").localeCompare(b.box || ""));
    if (!list.length) return;
    const ok = await saveFile(`part-labels-${today()}.pdf`, new Uint8Array(buildPartLabelsPDF(list, layoutSel.value, Number(skipIn.value) || 0)));
    if (ok && !state.readOnly) for (const it of list) if (!it.labelPrinted) await write(() => store.update("items", it.id, { labelPrinted: true }), true);
  }, body);
}

const pickedForPrint = new Set(ls.get("picked", []));
function viewBoxes() {
  const boxes = [...state.boxes].filter((b) => listOf(b) === currentList).sort((a, b) => a.id.localeCompare(b.id));
  const ro = state.readOnly;
  const nameIn = h("input", { type: "text", "data-f": "newbox", placeholder: "e.g. Resistors 0603, Connectors…", autocomplete: "off" });
  const countIn = h("input", { type: "number", "data-f": "count", min: "1", max: "100", value: "10", inputmode: "numeric", class: "num" });
  const layoutSel = h("select", {}, ...Object.entries(LAYOUTS).map(([k, l]) => h("option", { value: k }, l.name)));
  layoutSel.value = ls.get("layout", "s24"); layoutSel.onchange = () => ls.set("layout", layoutSel.value);
  const skipIn = h("input", { type: "number", "data-f": "skip", min: "0", max: "23", value: "0", inputmode: "numeric", class: "num" });
  const toPrint = boxes.filter((b) => pickedForPrint.has(b.id));
  const savePick = () => ls.set("picked", [...pickedForPrint]);
  return h("div", {},
    listSwitch(),
    ro ? null : h("section", { class: "panel" },
      h("h2", {}, "Add boxes"),
      h("div", { class: "row" }, nameIn, h("button", { class: "btn primary", onclick: async () => {
        const made = await addBoxes([nameIn.value.trim()]);
        if (made.length) { made.forEach((c) => pickedForPrint.add(c)); savePick(); toast(`Added ${made[0]}`, "ok"); }
      } }, "Add")),
      h("div", { class: "row small nowrap" }, h("span", {}, "Or add"), countIn, h("span", {}, "empty boxes (name later)"),
        h("button", { class: "btn", onclick: async () => {
          const n = Math.max(1, Math.min(100, Number(countIn.value) || 0));
          const made = await addBoxes(Array(n).fill(""));
          made.forEach((c) => pickedForPrint.add(c)); savePick();
          if (made.length) toast(`Added ${made[0]}–${made[made.length - 1]}`, "ok");
        } }, "Add"))),
    h("section", { class: "panel" },
      h("h2", {}, "Print box labels"),
      h("label", { class: "stack" }, h("span", {}, "Label sheet"), layoutSel),
      h("label", { class: "row small nowrap" }, h("span", {}, "Skip"), skipIn, h("span", {}, "used stickers on sheet 1")),
      h("div", { class: "row between" },
        h("span", { class: "small" }, `${toPrint.length} selected below`),
        h("button", { class: "btn primary", disabled: !toPrint.length, onclick: async (e) => {
          e.target.disabled = true;
          try {
            const ok = await saveFile(`box-labels-${today()}.pdf`, new Uint8Array(buildBoxLabelsPDF(toPrint, layoutSel.value, Number(skipIn.value) || 0)));
            if (ok && !ro) for (const b of toPrint) if (!b.printed) await write(() => store.update("boxes", b.id, { printed: true }), true);
          } finally { e.target.disabled = false; }
        } }, "Download labels PDF")),
      h("p", { class: "hint" }, "Print at 100% / actual size (not “fit to page”). Name and location are printed under the code.")),
    h("div", { class: "row between sect" }, h("h2", {}, `Boxes (${boxes.length})`),
      boxes.length ? h("div", { class: "row small" },
        h("button", { class: "btnlink", onclick: () => { boxes.forEach((b) => pickedForPrint.add(b.id)); savePick(); emit(); } }, "All"),
        h("button", { class: "btnlink", onclick: () => { pickedForPrint.clear(); boxes.filter((b) => !b.printed).forEach((b) => pickedForPrint.add(b.id)); savePick(); emit(); } }, "Unprinted"),
        h("button", { class: "btnlink", onclick: () => { pickedForPrint.clear(); savePick(); emit(); } }, "None")) : null),
    boxes.length ? null : h("p", { class: "empty" }, "No boxes yet. Add one above, print its label and stick it on."),
    ...boxes.map((b) => {
      const n = state.items.filter((i) => i.box === b.id).length;
      const sug = !b.name ? suggestBoxName(b.id) : "";
      const filling = teamNow().filter((p) => p.boxes.has(b.id)).map((p) => (p.isMe ? "you" : realName(p.id) || "teammate"));
      return h("div", { class: "boxrow" },
        h("input", { type: "checkbox", checked: pickedForPrint.has(b.id), "aria-label": "Select " + b.id + " for printing", onchange: (e) => { e.target.checked ? pickedForPrint.add(b.id) : pickedForPrint.delete(b.id); savePick(); emit(); } }),
        h("div", { class: "boxcode" }, b.id),
        h("div", { class: "boxfields" },
          h("input", bound("box:" + b.id + ":name", b.name, (v) => saveBoxField(b.id, "name", v), { type: "text", placeholder: sug ? `Suggest: ${sug}` : "Name this box", disabled: ro, enterkeyhint: "done" })),
          h("input", bound("box:" + b.id + ":loc", b.location, (v) => saveBoxField(b.id, "location", v), { type: "text", class: "loc", placeholder: "Location", disabled: ro, enterkeyhint: "done" }))),
        h("div", { class: "boxside" },
          h("div", { class: "boxmeta" }, plural(n, "bag"), b.printed ? "" : chip("no label"), filling.length ? chip("● " + filling.join(", "), "live") : null),
          h("div", { class: "row" },
            sug && !ro ? h("button", { class: "btnlink", onclick: () => write(() => store.update("boxes", b.id, { name: sug })) }, "Use name") : null,
            ro ? null : h("button", { class: "btnlink", onclick: () => { setCurrentBox(b.id); location.hash = "scan"; } }, "Fill"),
            ro || n ? null : h("button", { class: "btnlink danger", "aria-label": "Delete " + b.id, onclick: () => modal(`Delete box ${b.id}?`, "It has no parts in it.", "Delete", () => write(() => store.del("boxes", b.id))) }, "✕"))));
    }));
}

function connectPanel() {
  const apiIn = h("input", { type: "url", "data-f": "api", placeholder: "https://script.google.com/macros/s/…/exec", value: cfg.api || "" });
  const keyIn = h("input", { type: "text", "data-f": "key", placeholder: "Team code (the one you put in the script)", value: cfg.key || "" });
  const nameIn = h("input", { type: "text", "data-f": "name", placeholder: "Your name", value: cfg.name || "" });
  const btn = h("button", { class: "btn primary", onclick: () => connectSheet(apiIn.value, keyIn.value, nameIn.value, btn) }, "Connect");
  const ta = h("textarea", { class: "code", readonly: true, rows: "8" }, SCRIPT_SOURCE);
  return h("section", { class: "panel" },
    h("h2", {}, "Count together — no Claude account needed"),
    h("p", { class: "small" }, "One person sets up a free Google Sheet as the shared list (5 minutes, easiest on a laptop). Everyone else just scans the invite QR code."),
    h("ol", { class: "steps" },
      h("li", {}, "Make a new Google Sheet: ", h("a", { href: "https://sheets.new", target: "_blank", rel: "noopener" }, "sheets.new"), "."),
      h("li", {}, "In the sheet: Extensions → Apps Script. Delete what's there and paste the script below."),
      h("li", {}, "In the script, change ", h("code", {}, "change-me"), " on line 7 to your own team code. Save."),
      h("li", {}, "Deploy → New deployment → gear icon → Web app. Execute as: Me. Who has access: Anyone. Deploy, allow access, copy the Web app URL."),
      h("li", {}, "Paste the URL and team code here, add your name, Connect. Then share the invite QR code from this tab.")),
    h("div", { class: "row" }, h("button", { class: "btn", onclick: async (e) => { try { await navigator.clipboard.writeText(SCRIPT_SOURCE); e.target.textContent = "Copied ✓"; } catch { ta.select(); } } }, "Copy script")),
    h("details", {}, h("summary", {}, "Show script"), ta),
    h("label", { class: "stack" }, h("span", {}, "Web app URL"), apiIn),
    h("label", { class: "stack" }, h("span", {}, "Team code"), keyIn),
    h("label", { class: "stack" }, h("span", {}, "Your name"), nameIn),
    btn);
}
function sheetPanel() {
  const st = state.sheetStatus || {};
  const url = inviteUrl();
  const q = qrcode(0, "M"); q.addData(url); q.make();
  const qr = h("div", { class: "qr" }); qr.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  const nameIn = h("input", bound("myname", cfg.name, (v) => { if (!v || v === cfg.name) return; cfg = { ...cfg, name: v }; ls.set("cfg", cfg); state.me = v; toast("Name saved", "ok"); sendPresence(); }, { type: "text", enterkeyhint: "done" }));
  return h("section", { class: "panel" },
    h("h2", {}, "Team sheet"),
    h("div", { class: "row between small" },
      h("span", {}, st.online === false ? "● Offline" : st.online ? "● Connected" : "Connecting…", cfg.sheet ? ` to “${cfg.sheet}”` : "", st.pending ? ` · ${st.pending} waiting to upload` : ""),
      cfg.url ? h("a", { href: cfg.url, target: "_blank", rel: "noopener" }, "Open sheet ↗") : null),
    h("label", { class: "stack" }, h("span", {}, "Your name"), nameIn),
    h("h2", {}, "Invite helpers"),
    h("p", { class: "small" }, "Let teammates scan this with their phone camera, or send them the link. They type their name and can start counting. No account needed. Anyone with the link can add to the list, so only share it with the team."),
    qr,
    h("div", { class: "row" },
      h("button", { class: "btn primary", onclick: async (e) => { try { await navigator.clipboard.writeText(url); e.target.textContent = "Link copied ✓"; } catch { toast(url); } } }, "Copy invite link"),
      navigator.share ? h("button", { class: "btn", onclick: () => navigator.share({ title: "Inventory Day", text: "Join the inventory count", url }).catch(() => {}) }, "Share…") : null),
    h("button", { class: "btnlink danger", onclick: () => modal("Disconnect this phone?", "Your counted parts stay in the sheet. You can rejoin with the invite link.", "Disconnect", () => { cfg = {}; ls.set("cfg", cfg); location.reload(); }) }, "Disconnect this phone"));
}

function viewSetup() {
  const ro = state.readOnly;
  const counts = new Map();
  for (const i of state.items) counts.set(i.by || "", (counts.get(i.by || "") || 0) + 1);
  const orderIn = h("input", { type: "file", accept: ".csv,.xlsx,.xls,.tsv,text/csv", class: "hidden", multiple: true, onchange: async (e) => { const f = [...e.target.files]; e.target.value = ""; for (const x of f) await importOrderFile(x); } });
  if (state.mode === "join") return viewJoin();
  return h("div", {},
    h("section", { class: "panel" },
      h("h2", {}, "Counting"),
      h("label", { class: "toggle" }, h("input", { type: "checkbox", checked: askCountOn(), onchange: (e) => { ls.set("askCount", e.target.checked); emit(); } }),
        h("span", {}, "After each scan, ask how many parts are in the bag (you can always choose “Can't count” or “Later”).")),
      h("p", { class: "small" }, "The label quantity is never treated as stock. Only counted bags add up to the counted total. Find bags still to count with the “Not counted yet” filter on the Parts tab.")),
    state.mode === "sheet" ? sheetPanel() : null,
    !INCLAUDE && state.mode === "local" ? connectPanel() : null,
    h("section", { class: "panel" },
      h("h2", {}, "Team"),
      teamStrip(false) || h("p", { class: "small" }, state.mode === "shared" || state.mode === "sheet" ? "Live view of who's counting appears here when teammates open the page." : "Connect a team sheet above to count together."),
      counts.size ? h("div", { class: "leader" }, ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => h("div", { class: "row between" }, h("span", {}, id === state.me ? "You" : realName(id) || "Unknown"), h("b", {}, plural(n, "bag"))))) : null,
      !INCLAUDE ? null : h("details", { class: "howto", open: state.isOwner && counts.size <= 1 }, h("summary", {}, "How to add helpers"),
        h("ol", {},
          h("li", {}, "Open this page on claude.ai on a computer and tap Share (top right). The phone app can't change sharing."),
          h("li", {}, "Pro/Max plan: type each helper's email under “Invite people by email”, choose “Can edit”, then Invite. Keep “Who has access” on “Only you” — a public link would make everyone view-only."),
          h("li", {}, "Team/Enterprise plan: add colleagues from your organization and give them edit (or Contributor) access."),
          h("li", {}, "Helpers need a (free) Claude account with that exact email. They accept the invite email, then open the page on their phone. Everyone sees the same list live; each person takes their own boxes.")),
        h("p", { class: "small" }, "Helpers invited by email can scan, add and edit everything, but Claude photo reading only works for the owner (and Team-plan colleagues). Their unmarked parts are saved with a photo — open them later and tap “Ask Claude again”.")),
      ro ? h("p", { class: "banner" }, "You're viewing only. Ask the owner to give you Editor access (personal plan) or Contributor access (Team plan).") : null),
    h("section", { class: "panel" },
      h("h2", {}, "Order history"),
      h("p", { class: "small" }, "Import order exports from Mouser (Order History → Export), DigiKey (Order → Download CSV), LCSC, TME or Farnell. Scanned parts then get their description automatically, and parts with no label can be picked from what you ordered."),
      orderIn,
      ro ? null : h("button", { class: "btn primary", onclick: () => orderIn.click() }, "Import .csv / .xlsx"),
      catalog.imports.length ? h("div", { class: "imports" }, ...catalog.imports.map((imp) => h("div", { class: "row between" },
        h("span", {}, h("b", {}, imp.supplier || "Order"), ` · ${imp.file} · ${plural(imp.n, "line")}`),
        ro ? null : h("button", { class: "btnlink danger", onclick: () => modal("Remove this import?", imp.file, "Delete", async () => { for (const c of imp.chunks) await write(() => store.del("catalog", c)); }) }, "Remove")))) : h("p", { class: "small" }, "Nothing imported yet."),
      catalog.imports.length && !ro ? h("button", { class: "btnlink", onclick: backfillFromCatalog }, "Fill in already-counted parts from orders") : null),
    !INCLAUDE ? null : h("section", { class: "panel" },
      h("h2", {}, "Claude"),
      aiAvailable() ? h("label", { class: "toggle" }, h("input", { type: "checkbox", checked: ls.get("useClaude", true), onchange: (e) => { ls.set("useClaude", e.target.checked); emit(); } }),
        h("span", {}, "Let Claude read labels and identify unmarked parts from photos (uses your own Claude usage; you're asked once).")) : h("p", { class: "small" }, "Claude photo reading isn't available in this view. Barcodes, order history and manual entry still work."),
      h("p", { class: "small" }, "Claude reads markings like “103”, colour bands, chip markings and connector types. Parts it isn't sure about are flagged “check” — filter for them on the Parts tab.")));
}

function cameraIcon() {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", "22"); s.setAttribute("height", "22");
  s.innerHTML = '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/>';
  return s;
}

/* ---- text fields: keep every keystroke and save it, independent of re-renders ---- */
const drafts = new Map(), draftTimers = new Map(), draftSavers = new Map();
function bound(key, current, saveFn, extra = {}) {
  draftSavers.set(key, saveFn);
  return {
    ...extra, "data-f": key, value: drafts.has(key) ? drafts.get(key) : current ?? "",
    oninput: (e) => { drafts.set(key, e.target.value); clearTimeout(draftTimers.get(key)); draftTimers.set(key, setTimeout(() => commitDraft(key), 800)); extra.oninput?.(e); },
    onchange: () => commitDraft(key),
    onblur: () => commitDraft(key),
  };
}
async function commitDraft(key) {
  clearTimeout(draftTimers.get(key)); draftTimers.delete(key);
  if (!drafts.has(key)) return;
  const v = drafts.get(key), fn = draftSavers.get(key);
  try { if (fn) await fn(String(v).trim()); } catch {}
  if (drafts.get(key) === v) drafts.delete(key); // keep it if the person typed more meanwhile
}
const commitAll = () => Promise.all([...drafts.keys()].map(commitDraft));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") commitAll(); });
window.addEventListener("pagehide", () => { commitAll(); });
async function saveItemField(id, field, raw) {
  const it = state.items.find((i) => i.id === id);
  if (!it) return;
  let v = raw;
  if (field === "qty") { v = raw === "" ? "" : Number(String(raw).replace(",", ".")); if (Number.isNaN(v)) return; }
  if ((it[field] ?? "") === v) return;
  const upd = { [field]: v };
  if (field === "description" && !it.category) { const g = guessCategory(v, listOf(it)); if (g) upd.category = g; }
  await write(() => store.update("items", id, upd));
}
async function saveBoxField(id, field, v) {
  const b = boxByCode(id);
  if (!b || (b[field] ?? "") === v) return;
  await write(() => store.update("boxes", id, { [field]: v }));
}

function render() {
  const a = document.activeElement;
  // never swap out a field the person is typing in (on phones that closes the keyboard); render once they leave it
  if (a && a.tagName === "INPUT" && a.closest?.("#view") && !["checkbox", "radio", "file", "button"].includes(a.type)) { render.pending = true; return; }
  if (a && a.tagName === "SELECT" && a.closest?.("#view")) { render.pending = true; return; }
  if (document.querySelector(".modal-wrap")) { render.pending = true; return; }
  render.pending = false;
  let keep = null;
  if (a && a.closest?.("#view") && a.dataset?.f) { keep = { f: a.dataset.f, v: a.value, s: null, e: null }; try { keep.s = a.selectionStart; keep.e = a.selectionEnd; } catch {} }
  const counts = { scan: "", items: state.items.filter((i) => listOf(i) === currentList).length || "", boxes: state.boxes.filter((b) => listOf(b) === currentList).length || "", setup: "" };
  for (const t of TABS) { const b = $(`#tab-${t}`); b.classList.toggle("on", tab === t); b.querySelector(".n").textContent = counts[t] ? " " + counts[t] : ""; }
  const others = teamNow().filter((p) => !p.isMe).length;
  $("#tab-setup .n").textContent = others ? ` ●${others + 1}` : "";
  const v = $("#view");
  const y = window.scrollY;
  v.replaceChildren(bannerEl() || "", tab === "scan" ? viewScan() : tab === "items" ? viewItems() : tab === "boxes" ? viewBoxes() : viewSetup());
  window.scrollTo(0, y);
  if (keep) {
    const el = v.querySelector(`[data-f="${CSS.escape(keep.f)}"]`);
    if (el) { el.value = keep.v; el.focus({ preventScroll: true }); try { if (keep.s != null) el.setSelectionRange(keep.s, keep.e); } catch {} }
  }
}
document.addEventListener("focusout", () => setTimeout(() => { if (render.pending) render(); }, 0));
new MutationObserver(() => { if (render.pending && !document.querySelector(".modal-wrap")) render(); }).observe(document.body, { childList: true });
for (const t of TABS) $(`#tab-${t}`).addEventListener("click", () => { location.hash = t; tab = t; sendPresence(); render(); });

init();
