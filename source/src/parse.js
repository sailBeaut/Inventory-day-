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

// Takes decoded barcodes [{format,text}] -> { boxCode, item, primary, has2D }
export function interpret(codes) {
  let boxCode = null, partRef = null;
  const partCodes = [];
  for (const c of codes) {
    const txt = normalize(c.text).trim();
    if (!txt) continue;
    if (txt.toUpperCase().startsWith(BOX_PREFIX)) { boxCode = txt.slice(BOX_PREFIX.length).trim().toUpperCase(); continue; }
    if (txt.toUpperCase().startsWith(PART_PREFIX)) { partRef = txt.slice(PART_PREFIX.length).trim(); continue; }
    partCodes.push({ format: c.format, text: txt });
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
  // Mouser part number appears as 1D like "710-150060RS86000"
  if (item.mpn && !item.supplierPn) {
    const sp = oneD.find((t) => /^\d{2,4}-/.test(t) && t.toUpperCase().endsWith(item.mpn.toUpperCase().slice(-6)));
    if (sp) { item.supplierPn = sp; if (!item.supplier) item.supplier = "Mouser"; }
  }
  if (!primary) primary = twoD[0]?.text || oneD.join(" | ");
  return { boxCode, partRef, item, primary, has2D: twoD.length > 0, oneD, all: partCodes };
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
