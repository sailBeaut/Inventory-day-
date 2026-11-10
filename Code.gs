/**
 * Inventory Day — shared backend in a Google Sheet.
 * 1. Change TEAM_CODE below to something only your team knows.
 * 2. Deploy → New deployment → type "Web app" → Execute as: Me → Who has access: Anyone → Deploy.
 * 3. Copy the Web app URL into the inventory page (Setup tab).
 */
const TEAM_CODE = 'change-me';

const T = {
  Items: ['id', 'box', 'category', 'description', 'manufacturer', 'mpn', 'supplier', 'supplierPn', 'qty', 'notes', 'po', 'invoice', 'line', 'lot', 'dateCode', 'coo', 'serial', 'order',
    'source', 'needsCheck', 'needsLabel', 'labelPrinted', 'hasPhoto', 'fromOrder', 'ai', 'aiConfidence', 'aiSeen', 'by', 'at', 'updatedAt', 'deleted', 'raw', 'codes', 'readFrom'], // new columns only ever go at the end
  Boxes: ['id', 'name', 'location', 'printed', 'hasPhoto', 'by', 'createdAt', 'updatedAt', 'deleted'],
  Orders: ['imp', 'file', 'supplier', 'at', 'by', 's', 'sp', 'm', 'mf', 'd', 'q'],
  Photos: ['id', 'data', 'at'],
};
const NUMERIC = { qty: 1, q: 1 };

function doGet() {
  return json({ ok: true, app: 'inventory-day', note: 'This is the backend. Paste this URL into the inventory page.' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json({ error: 'bad request' }); }
  if (String(req.key || '') !== TEAM_CODE) return json({ error: 'wrong team code' });
  try { return json(handle(req)); } catch (err) { return json({ error: String(err && err.message || err) }); }
}

function handle(req) {
  switch (req.op) {
    case 'ping': return { ok: true, sheet: SpreadsheetApp.getActive().getName(), url: SpreadsheetApp.getActive().getUrl() };
    case 'sync': return sync(req);
    case 'upsert': return locked(() => upsert(table(req.table), req.rows || []));
    case 'delete': return locked(() => upsert(table(req.table), (req.ids || []).map((id) => ({ id: id, deleted: 'true' }))));
    case 'orders': return { rows: readAll('Orders').map(strip) };
    case 'addOrders': return locked(() => addOrders(req.rows || []));
    case 'delOrders': return locked(() => delOrders(String(req.imp || '')));
    case 'photo': { const r = readAll('Photos').find((x) => x.id === String(req.id)); return { data: r ? r.data : null }; }
    case 'setPhoto': return locked(() => upsert('Photos', [{ id: String(req.id), data: String(req.data || '').slice(0, 49000), at: Date.now() }], true));
    default: throw new Error('unknown op');
  }
}

function table(t) { const m = { items: 'Items', boxes: 'Boxes' }; if (!m[t]) throw new Error('unknown table'); return m[t]; }
function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function locked(fn) { const l = LockService.getScriptLock(); l.waitLock(25000); try { return fn(); } finally { l.releaseLock(); } }
function strip(r) { const o = Object.assign({}, r); delete o._row; return o; }

function sheet(name) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    const cols = T[name];
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    cols.forEach((c, i) => { if (NUMERIC[c]) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('General'); });
    const extra = ss.getSheetByName('Sheet1') || ss.getSheetByName('Blad1');
    if (extra && extra.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(extra);
  } else {
    // sheet made by an older version of this script: add any new header columns (always appended at the end)
    const cols = T[name], have = sh.getRange(1, 1, 1, cols.length).getValues()[0];
    if (String(have[cols.length - 1]) !== cols[cols.length - 1]) {
      sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
      sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
      cols.forEach((c, i) => { if (NUMERIC[c]) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('General'); });
    }
  }
  return sh;
}

function readAll(name) {
  const sh = sheet(name), cols = T[name], n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, cols.length).getValues().map((r, i) => {
    const o = { _row: i + 2 };
    cols.forEach((c, j) => { o[c] = r[j]; });
    return o;
  });
}

function cell(c, v) {
  if (v === null || v === undefined) return '';
  if (NUMERIC[c]) return v === '' || isNaN(Number(v)) ? '' : Number(v);
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 49000);
  return String(v).slice(0, 49000);
}

function writeNew(sh, cols, rows) {
  if (!rows.length) return;
  const start = sh.getLastRow() + 1;
  if (start + rows.length > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 200);
  const rg = sh.getRange(start, 1, rows.length, cols.length);
  rg.setNumberFormat('@');
  cols.forEach((c, i) => { if (NUMERIC[c]) sh.getRange(start, i + 1, rows.length, 1).setNumberFormat('General'); });
  rg.setValues(rows);
}

function upsert(name, rows, quiet) {
  const sh = sheet(name), cols = T[name];
  const idx = {};
  readAll(name).forEach((r) => { idx[String(r.id)] = r; });
  const now = Date.now();
  const fresh = [];
  rows.forEach((r) => {
    if (!r || !r.id) return;
    const id = String(r.id);
    const cur = idx[id];
    const merged = Object.assign({}, cur || {}, r);
    if (name !== 'Photos') merged.updatedAt = now;
    delete merged._row;
    const line = cols.map((c) => cell(c, merged[c]));
    if (cur) sh.getRange(cur._row, 1, 1, cols.length).setValues([line]);
    else { fresh.push(line); idx[id] = Object.assign({ _row: -1 }, merged); }
  });
  writeNew(sh, cols, fresh);
  if (!quiet) bump('v', now);
  return { ok: true, now: now };
}

function addOrders(rows) {
  const sh = sheet('Orders'), cols = T.Orders;
  writeNew(sh, cols, rows.map((r) => cols.map((c) => cell(c, r[c]))));
  bump('ov', Date.now());
  return { ok: true };
}

function delOrders(imp) {
  const sh = sheet('Orders'), cols = T.Orders;
  const keep = readAll('Orders').filter((r) => String(r.imp) !== imp).map((r) => cols.map((c) => r[c]));
  const n = sh.getLastRow();
  if (n > 1) sh.getRange(2, 1, n - 1, cols.length).clearContent();
  if (keep.length) sh.getRange(2, 1, keep.length, cols.length).setValues(keep);
  bump('ov', Date.now());
  return { ok: true };
}

function bump(k, v) {
  CacheService.getScriptCache().put(k, String(v), 21600);
  PropertiesService.getScriptProperties().setProperty(k, String(v));
}
function getV(k) {
  const c = CacheService.getScriptCache().get(k);
  if (c) return Number(c);
  return Number(PropertiesService.getScriptProperties().getProperty(k) || 0);
}

function sync(req) {
  const now = Date.now();
  const cache = CacheService.getScriptCache();
  let pres = {};
  try { pres = JSON.parse(cache.get('presence') || '{}'); } catch (e) { pres = {}; }
  if (req.me && req.me.dev) {
    pres[String(req.me.dev).slice(0, 40)] = {
      name: String(req.me.name || '').slice(0, 40), box: String(req.me.box || '').slice(0, 12), n: Number(req.me.n) || 0, at: now,
    };
  }
  Object.keys(pres).forEach((k) => { if (now - pres[k].at > 90000) delete pres[k]; });
  cache.put('presence', JSON.stringify(pres), 21600);

  const since = Number(req.since || 0);
  const v = getV('v');
  let items = [], boxes = [];
  if (!since || v >= since) {
    items = readAll('Items').filter((r) => Number(r.updatedAt || 0) >= since).map(strip);
    boxes = readAll('Boxes').filter((r) => Number(r.updatedAt || 0) >= since).map(strip);
  }
  return {
    now: now, items: items, boxes: boxes, ov: getV('ov'),
    presence: Object.keys(pres).map((k) => Object.assign({ dev: k }, pres[k])),
  };
}
