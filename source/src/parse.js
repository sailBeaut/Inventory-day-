// Parsing of supplier barcodes into inventory fields.
export const BOX_PREFIX = "FZBOX:";
export const PART_PREFIX = "FZPART:";

const GS = "\x1D", RS = "\x1E", EOT = "\x04";
export function normalize(t) {
  return String(t || "")
    .replace(/␝/g, GS).replace(/␞/g, RS).replace(/␄/g, EOT);
}

const TWO_D = new Set(["DataMatrix", "QRCode", "MicroQRCode", "rMQRCode", "PDF417", "Aztec", "MaxiCode"]);
export const is2D = (fmt) => TWO_D.has(fmt);

// ECIA / ANSI MH10.8.2 (ISO 15434) — used by Mouser, DigiKey, Würth, TME, Huawei...
export function parseECIA(text) {
  const t = normalize(text);
  if (!t.includes("[)>")) return null;
  let body = t.slice(t.indexOf("[)>") + 3).replace(/^[\x1E]?\d\d/, "");
  const parts = body.split(/[\x1D\x1E\x04]/).map((s) => s.trim()).filter(Boolean);
  const f = {};
  for (const p of parts) {
    const m = /^(\d{0,3}[A-Z])(.*)$/s.exec(p);
    if (m && !(m[1] in f)) f[m[1]] = m[2].trim();
  }
  return f;
}

export function eciaToItem(f) {
  const it = {};
  if (f["1P"]) it.mpn = f["1P"];
  if (f["Q"] && /^\d+(\.\d+)?$/.test(f["Q"])) it.qty = Number(f["Q"]);
  if (f["K"]) it.po = f["K"];
  if (f["14K"]) it.line = f["14K"];
  if (f["10K"] || f["11K"]) it.invoice = f["10K"] || f["11K"];
  if (f["1K"]) it.order = f["1K"];
  if (f["1T"]) it.lot = f["1T"];
  if (f["9D"] || f["10D"]) it.dateCode = f["9D"] || f["10D"];
  if (f["4L"]) it.coo = f["4L"];
  if (f["1V"]) it.manufacturer = f["1V"];
  if (f["S"]) it.serial = f["S"];
  const isDigiKey = f["30P"] || f["1K"] || f["11Z"] || f["12Z"] || f["13Z"] || f["20Z"];
  const isMouser = !isDigiKey && f["14K"] && f["11K"] && f["1P"];
  if (isDigiKey) { it.supplier = "DigiKey"; it.supplierPn = f["30P"] || f["P"] || ""; }
  else if (isMouser) it.supplier = "Mouser";
  else if (f["P"]) it.supplierPn = f["P"];
  return it;
}

// LCSC QR: {pbn:PICK..,on:SO..,pc:C2040,pm:RP2040,qty:10,...}
export function parseLCSC(text) {
  const t = String(text).trim();
  if (!/^\{.*\bpc:.*\}$/s.test(t)) return null;
  const o = {};
  for (const kv of t.slice(1, -1).split(",")) {
    const i = kv.indexOf(":");
    if (i > 0) o[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  const it = { supplier: "LCSC" };
  if (o.pc) it.supplierPn = o.pc;
  if (o.pm) it.mpn = o.pm;
  if (o.qty && /^\d+$/.test(o.qty)) it.qty = Number(o.qty);
  if (o.on) it.po = o.on;
  return it;
}

// TME QR: QTY:100 PN:... PO:... MFR:... MPN:...
export function parseTME(text) {
  const t = String(text);
  if (!/\bQTY:/.test(t) || !/\b(PN|MPN):/.test(t)) return null;
  const o = {};
  for (const m of t.matchAll(/\b(QTY|PN|PO|CPO|MFR|MPN):(\S+)/g)) o[m[1]] = m[2];
  const it = { supplier: "TME" };
  if (o.PN) it.supplierPn = o.PN;
  if (o.MPN) it.mpn = o.MPN;
  if (o.MFR) it.manufacturer = o.MFR;
  if (o.QTY && /^\d+$/.test(o.QTY)) it.qty = Number(o.QTY);
  if (o.PO || o.CPO) it.po = o.PO || o.CPO;
  return it;
}

// Farnell / element14 / Newark / CPC bag label: Code128 "LG1" + 9-digit order number + 3-digit line
export function parseFarnellBarcode(t) {
  const m = /^LG\d(\d{9})(\d{3})$/.exec(String(t || "").trim());
  return m ? { supplier: "Farnell", order: m[1], line: m[2] } : null;
}

// Printed label text (from on-device OCR) -> fields. Tuned for Farnell-style labels:
//   1858946            Qty:290
//   SI2377EDS-T1-GE3:MOSFET,P CH,20V,4.4A,DI
//   Line017  008576744
export function parseLabelText(raw) {
  const text = String(raw || "").replace(/[‘’`´]/g, "'").replace(/[|]/g, "I");
  const lines = text.split(/\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const it = {};
  const q = /\b[QO0]\s*[tTlI1]\s*[yYvV]\s*[:.;]?\s*([0-9OoIl][0-9OoIl,.]*)/.exec(text);
  if (q) { const n = Number(q[1].replace(/[Oo]/g, "0").replace(/[Il]/g, "1").replace(/[,.]/g, "")); if (Number.isFinite(n) && n > 0 && n < 1e7) it.qty = n; }
  for (const l of lines) {
    if (/^(qty|line|rohs|mod|date|lot|tel|fax|www|\d{6,9}\b)/i.test(l)) continue;
    const m = /^([A-Z0-9][A-Z0-9\-\/.#+_\[\]]{4,40})\s*(?:[:;]\s*|\s+)(.{3,})$/i.exec(l);
    if (!m) continue;
    const tok = m[1].replace(/\[/g, "I").replace(/\]/g, "I");
    if ((tok.match(/\d/g) || []).length >= 2 && (tok.match(/[A-Z]/gi) || []).length >= 2) {
      it.mpn = tok.toUpperCase();
      it.description = m[2].replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").trim().slice(0, 160);
      break;
    }
  }
  const code = lines.map((l) => /^(\d{6,8})\b/.exec(l)).find(Boolean);
  if (code) it.supplierPn = code[1];
  const ln = /\bLine\s*0*(\d{1,4})/i.exec(text);
  if (ln) it.line = ln[1].padStart(3, "0");
  return it;
}

// Takes decoded barcodes [{format,text}] -> { boxCode, item, primary, has2D }
export function interpret(codes) {
  let boxCode = null, partRef = null;
  const partCodes = [];
  for (const c of codes) {
    const txt = normalize(c.text).trim();
    if (!txt) continue;
    if (txt.toUpperCase().startsWith(BOX_PREFIX)) { boxCode = txt.slice(BOX_PREFIX.length).trim().toUpperCase(); continue; }
    if (txt.toUpperCase().startsWith(PART_PREFIX)) { partRef = txt.slice(PART_PREFIX.length).trim(); continue; }
    if (partCodes.some((p) => p.text === txt && p.format === c.format)) continue; // same code seen twice
    partCodes.push({ ...c, text: txt });
  }
  if (!partCodes.length) return { boxCode, partRef, item: null, primary: "", has2D: false };

  let item = {};
  let primary = "";
  const twoD = partCodes.filter((c) => is2D(c.format));
  for (const c of twoD) {
    const e = parseECIA(c.text);
    const parsed = e ? eciaToItem(e) : parseLCSC(c.text) || parseTME(c.text);
    if (parsed && Object.keys(parsed).length) {
      item = { ...parsed, ...item };
      if (!primary) primary = c.text;
    }
  }
  const oneD = partCodes.filter((c) => !is2D(c.format)).map((c) => c.text);
  let known1D = false, multi = null;
  for (const t of oneD) {
    const f = parseFarnellBarcode(t);
    if (f) { item = { ...f, ...item }; known1D = true; if (!primary && !twoD.length) primary = t; }
  }
  // several plain barcodes and no 2D supplier code: work out which barcode is which field from the layout
  const oneDCodes = partCodes.filter((c) => !is2D(c.format) && !parseFarnellBarcode(c.text));
  if (!Object.keys(item).length && oneDCodes.length >= 2) {
    multi = resolveBarcodes(oneDCodes);
    if (multi.fields.mpn || multi.fields.supplierPn) {
      item = { ...multi.fields };
      known1D = true;
      primary = ["L", item.supplierPn, item.mpn, item.lot, item.dateCode, item.qty].map((x) => x ?? "").join("|");
    }
  }
  // Mouser part number appears as 1D like "710-150060RS86000"
  if (item.mpn && !item.supplierPn) {
    const sp = oneD.find((t) => /^\d{2,4}-/.test(t) && t.toUpperCase().endsWith(item.mpn.toUpperCase().slice(-6)));
    if (sp) { item.supplierPn = sp; if (!item.supplier) item.supplier = "Mouser"; }
  }
  if (!primary) primary = twoD[0]?.text || oneD.join(" | ");
  return { boxCode, partRef, item, primary, has2D: twoD.length > 0, known1D, multi, oneD, all: partCodes };
}

export function printable(t) {
  return String(t || "").replace(/\x1D/g, "␝").replace(/\x1E/g, "␞").replace(/\x04/g, "␄");
}

// ---- order-history import (Mouser / DigiKey / LCSC / TME / Farnell exports) ----
const COLS = {
  mpn: [/manufactur\w*\s*part\s*(number|no|#)/i, /^mfr\.?\s*(part\s*)?(#|no|number|p\/?n)/i, /^mpn$/i, /mfg\.?\s*part/i, /^manufacturer\s*p\/?n/i, /^mfr\s*#/i],
  supplierPn: [/(mouser|digi-?key|lcsc|tme|farnell|newark|rs|arrow)\s*(part|#|no|p\/?n|product|order code|stock)/i, /^(sku|order\s*code|symbol|product\s*code)$/i, /^part\s*(number|#|no)$/i, /^supplier\s*(part|p\/?n|#)/i],
  description: [/desc/i, /^product\s*name$/i, /^title$/i],
  manufacturer: [/^(manufacturer|manufacture|mfr\.?|mfg\.?|brand|maker)(\s*name)?$/i],
  qty: [/^(qty|quantity)\b/i, /(order(ed)?|ship(ped)?)\s*(qty|quantity)/i, /^quantity/i],
};
export function detectColumns(header) {
  const idx = {};
  for (const [key, res] of Object.entries(COLS)) {
    for (const re of res) {
      const i = header.findIndex((h, j) => re.test(String(h || "").trim()) && !Object.values(idx).includes(j));
      if (i >= 0) { idx[key] = i; break; }
    }
  }
  return idx;
}
export function supplierFromText(t) {
  const s = String(t || "").toLowerCase();
  if (/mouser/.test(s)) return "Mouser";
  if (/digi-?key/.test(s)) return "DigiKey";
  if (/lcsc/.test(s)) return "LCSC";
  if (/\btme\b/.test(s)) return "TME";
  if (/farnell|newark/.test(s)) return "Farnell";
  if (/\brs\b|rs-online|rs components/.test(s)) return "RS";
  return "";
}
export function parseOrderRows(rows, filename) {
  let hi = -1, cols = null;
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const c = detectColumns(rows[r] || []);
    if ((c.mpn != null || c.supplierPn != null) && (c.description != null || c.qty != null || (c.mpn != null && c.supplierPn != null))) { hi = r; cols = c; break; }
  }
  if (hi < 0) return { error: "Couldn't find columns like “Manufacturer Part Number” and “Description” in that file." };
  const header = rows[hi];
  const supplier = supplierFromText(cols.supplierPn != null ? header[cols.supplierPn] : "") || supplierFromText(filename) || supplierFromText(header.join(" "));
  const out = [];
  for (const row of rows.slice(hi + 1)) {
    const g = (k) => (cols[k] != null ? String(row?.[cols[k]] ?? "").trim() : "");
    const m = g("mpn"), sp = g("supplierPn");
    if (!m && !sp) continue;
    const q = Number(String(g("qty")).replace(/[^0-9.]/g, ""));
    out.push({ s: supplier, sp: sp.slice(0, 80), m: m.slice(0, 80), mf: g("manufacturer").slice(0, 60), d: g("description").slice(0, 200), q: Number.isFinite(q) && q > 0 ? q : null });
  }
  return { rows: out, supplier, columns: Object.keys(cols) };
}

const CAT_RULES = [
  ["Microcontroller", /microcontroller|\bmcu\b|stm32|atmega|attiny|esp32|esp8266|rp2040|\bpic\d|nrf52|samd\d/i],
  ["Connector", /connector|header|terminal|crimp|socket|plug|receptacle|housing|micro-?fit|molex|jst|deutsch|d-sub|usb[- ]?c?\b.*(conn|recept)/i],
  ["Cable/Wire", /\bcable\b|\bwire\b|harness|\bawg\b/i],
  ["Resistor", /resistor|\bres\b|\bohm|Ω|\bkohm|thermistor|ntc|ptc thermistor/i],
  ["Capacitor", /capacitor|\bcap\b|mlcc|\b\d+(\.\d+)?\s*(uf|µf|nf|pf)\b|electrolytic|tantalum/i],
  ["Inductor", /inductor|ferrite|choke|\b\d+(\.\d+)?\s*(uh|µh|nh|mh)\b/i],
  ["Fuse/Protection", /fuse|polyfuse|\bptc\b|varistor|\btvs\b|\besd\b|gas discharge/i],
  ["Diode/LED", /\bleds?\b|led's|diode|schottky|zener|rectifier|photodiode/i],
  ["Transistor/MOSFET", /mosfet|transistor|\bbjt\b|\bigbt\b|\bfet\b|gan\b/i],
  ["Crystal/Oscillator", /crystal|oscillator|resonator|\bxtal\b/i],
  ["Switch/Button", /switch|button|tactile|\bdip\b.*switch|relay/i],
  ["Sensor", /sensor|accelerometer|gyro|\bimu\b|hall effect|pressure|humidity/i],
  ["Module/PCB", /module|breakout|dev(elopment)?\s*(kit|board)|evaluation|\bpcb\b|\bboard\b|transceiver module|qsfp|sfp/i],
  ["IC", /\bic\b|amplifier|op-?amp|regulator|\bldo\b|converter|driver|transceiver|comparator|\badc\b|\bdac\b|logic|eeprom|flash|memory|controller|interface|isolator|optocoupler|\bcan\b/i],
  ["Mechanical", /screw|\bnut\b|standoff|spacer|enclosure|heat ?sink|washer|bracket|cable tie/i],
];
export function guessCategory(text) {
  const t = String(text || "");
  if (!t) return "";
  for (const [c, re] of CAT_RULES) if (re.test(t)) return c;
  return "";
}

// ---- labels with one plain barcode per field (new Farnell / element14, RS, many distributors) ----
// Which field a printed caption belongs to (EN / NL / DE / FR). Fuzzy, because OCR often gets a letter or two wrong.
const CAPTION_WORDS = [
  ["mpn", ["fabrikant", "manufacturer", "hersteller", "fabricant", "mfr", "mfg", "manuf"]],
  ["custPn", ["klant", "customer", "kunde", "client", "cust"]],
  ["qty", ["hoeveelheid", "quantity", "menge", "anzahl", "aantal", "qty", "quantite"]],
  ["dateCode", ["datumcode", "datecode", "date", "datum"]],
  ["lot", ["lotcode", "lot", "charge", "batch"]],
  ["luid", ["luid", "lu-id"]],
  ["supplierPn", ["onderdeelnr", "onderdeel", "partno", "part", "bestellnr", "bestellnummer", "ordercode", "stockno"]],
  ["line", ["artikelnr", "artikel", "line", "lineitem", "item", "pos", "position"]],
];
function editDistance(a, b) {
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
export function classifyCaption(t) {
  const words = String(t || "").toLowerCase().replace(/[^a-z0-9äöüéè\- ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3);
  const hit = (kw) => words.some((w) => {
    const ww = w.replace(/nr$|no$/, "");
    if (w === kw || ww === kw) return true;
    if (kw.length < 5) return false;
    const tol = kw.length >= 9 ? 2 : 1;
    return editDistance(ww, kw) <= tol || editDistance(w, kw) <= tol || (w.length >= kw.length && w.includes(kw));
  });
  const found = CAPTION_WORDS.filter(([, kws]) => kws.some(hit)).map(([f]) => f);
  if (found.includes("custPn")) return /order|bestel|auftrag|comman/.test(words.join(" ")) || found.includes("line") === false && found.includes("supplierPn") === false && /ordernr|ordern/.test(words.join(" ")) ? "po" : "custPn";
  if (/ordernr|ordern\b/.test(words.join(" ")) && found.includes("custPn")) return "po";
  return found[0] || null;
}
// does a barcode value fit the field a caption says it is?
export function fitsField(f, v) {
  const t = String(v || "");
  switch (f) {
    case "line": return /^\d{1,4}$/.test(t);
    case "qty": return /^\d{1,7}$/.test(t);
    case "dateCode": return /^\d{4}$/.test(t) || /^\d{2}[A-Z0-9]{2,4}$/i.test(t);
    case "supplierPn": return /^[A-Z0-9][A-Z0-9\-]{3,20}$/i.test(t);
    case "mpn": return /[A-Z]/i.test(t) && t.length >= 3;
    case "lot": return /^[A-Z0-9][A-Z0-9\-]{2,}$/i.test(t);
    default: return true;
  }
}

// codes: 1D barcodes [{text, pos}] (pos from relPos, incl. aspect `ar`); captions[i]: field from OCR or null.
// Returns { fields, src } where src[field] is "caption" (barcode + its printed caption) or "pattern" (barcode, field guessed from layout).
export function resolveBarcodes(codes, captions = []) {
  const list = codes.map((c, i) => ({ ...c, i, field: captions[i] || null, used: null }));
  const P = (c, k) => ({ x: c.pos[k].x * (c.pos.ar || 1), y: c.pos[k].y });
  let v = { x: 0, y: 1 };
  const posd = list.filter((c) => c.pos);
  if (posd.length) {
    const wd = (c) => { const a = P(c, "tl"), b = P(c, "tr"); return Math.hypot(b.x - a.x, b.y - a.y); };
    const w = posd.reduce((m, c) => (wd(c) > wd(m) ? c : m));
    const a = P(w, "tl"), b = P(w, "tr"), n = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    v = { x: -(b.y - a.y) / n, y: (b.x - a.x) / n };
  }
  const key = (c) => { if (!c.pos) return 0; const a = P(c, "tl"), b = P(c, "br"); return ((a.x + b.x) / 2) * v.x + ((a.y + b.y) / 2) * v.y; };
  const ord = [...list].sort((a, b) => key(a) - key(b));
  const F = {}, src = {};
  const take = (f, c, how) => { if (F[f] == null && c && !c.used) { F[f] = c.text; c.used = f; src[f] = how; } };
  for (const c of ord) if (c.field && !["luid", "custPn"].includes(c.field)) { if (fitsField(c.field, c.text)) take(c.field, c, "caption"); else c.field = null; }
  for (const c of ord) if (c.field === "luid" || c.field === "custPn") c.used = c.field;
  const idx = (f) => ord.findIndex((x) => x.used === f);
  const isAlnum = (t) => /[A-Z]/i.test(t) && /\d/.test(t) && t.length >= 4;
  if (F.supplierPn == null) take("supplierPn", ord.find((c) => !c.used && /^\d{6,8}$/.test(c.text)), "pattern");
  if (F.line == null && F.supplierPn != null) take("line", ord.slice(0, idx("supplierPn")).find((c) => !c.used && /^\d{1,4}$/.test(c.text)), "pattern");
  // the MPN is the first plain barcode after the supplier code; if that one is a number, the MPN barcode wasn't read — leave it empty rather than guess
  if (F.mpn == null) { const c = ord.slice(idx("supplierPn") + 1).find((c) => !c.used && !c.field); if (c && isAlnum(c.text)) take("mpn", c, "pattern"); }
  if (F.qty == null && (F.mpn != null || F.supplierPn != null)) take("qty", ord.slice(Math.max(idx("mpn"), idx("supplierPn")) + 1).find((c) => !c.used && !c.field && /^\d{1,6}$/.test(c.text)), "pattern");
  if (F.dateCode == null && F.qty != null) { const c = ord[idx("qty") + 1]; if (c && !c.field && /^\d{4}$/.test(c.text)) take("dateCode", c, "pattern"); }
  if (F.lot == null && F.dateCode != null) { const c = ord[idx("dateCode") + 1]; if (c && !c.field && /^[A-Z0-9][A-Z0-9\-]{3,}$/i.test(c.text)) take("lot", c, "pattern"); }
  if (F.qty != null) { const n = Number(F.qty); if (Number.isFinite(n)) F.qty = n; else delete F.qty; }
  return { fields: F, src, order: ord.map((c) => c.i) };
}

// "Caption: value" lines from OCR text -> { field: value }. Value is cleaned up to what that field can look like.
export function captionValues(text) {
  const out = {};
  for (const raw of String(text || "").split(/\n/)) {
    const l = raw.replace(/\s+/g, " ").trim();
    const m = /^(.{3,40}?)\s*[:;.]\s*([A-Za-z0-9][A-Za-z0-9 .\-\/+#]*)$/.exec(l);
    if (!m) continue;
    const f = classifyCaption(m[1]);
    if (!f || f in out || f === "luid" || f === "custPn") continue;
    let v = m[2].trim();
    if (f === "qty") { const n = /^\d[\d.,]*/.exec(v.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1")); if (!n) continue; v = n[0].replace(/[.,]/g, ""); }
    else if (["mpn", "lot", "supplierPn", "dateCode", "line"].includes(f)) v = v.split(" ")[0].toUpperCase();
    if (v) out[f] = v;
  }
  return out;
}
