# Inventory Day

A phone web page for counting electronics and PCB components. No account needed.

- Reading order for every scan: 1) QR / square code (DataMatrix, QR) → 2) stripe barcodes → 3) printed text → 4) manual entry with the photo attached. Each step only fills fields the earlier ones left empty, and each part records what came from where.
- Scan supplier barcodes (Mouser, DigiKey, LCSC, TME and other ECIA DataMatrix/QR codes) by live camera or photo.
- Labels with plain barcodes (Farnell / element14 old and new style, and similar): every barcode is decoded, the caption printed above each one (in English, Dutch, German or French) says which field it is, and the printed text fills in what has no barcode (description, manufacturer). Per field, a barcode value always beats text, because barcodes have a built-in check and text reading doesn't. Text reading is Tesseract.js OCR, downloaded once from jsDelivr. Imported order history fixes any text that was misread. Each part records where every field was read from.
- RS Components labels: stock number (e.g. 205-1899), part number and country of origin are read from the printed text when the barcode can't be decoded.
- Labels with no readable barcode (NXP, Farnell dot-matrix like 155-1908, …): the app finds the white label in the photo and reads it at two sizes; fields most reads agree on win. NXP 12NC, TYPE and quantity are read; dot-matrix part numbers are often misread, so check them (order history fixes them). Faded labels go to manual entry with the photo. Tip: fill the frame with the label.
- Counting: after each scan the app suggests counting the bag (or "Can't count" / "Later"). Counted quantity is stored separately from the label quantity, which is never treated as stock. 0 removes a bag scanned by mistake. Identical codes are separate bags.
- Two lists: Electrical and Wiring harness (WH), each with its own boxes (B001… / W001…) and categories.
- Print QR labels for boxes and for unmarked parts.
- Import order history from Mouser, DigiKey, LCSC, TME or Farnell to fill in part descriptions.
- Several people can count at once. A Google Sheet holds the shared list (`Code.gs` is its Apps Script backend).
- Export to Excel: a "Read me" sheet, one sheet per list with COUNTED QTY (actual) next to the unverified label quantity, a "By part" sheet with counted totals and whether the count is complete, plus boxes and team sheets.

Setup: open the page → **Setup** tab, and follow the steps there.

## Hosting
GitHub Pages: Settings → Pages → Deploy from a branch → `main` / root. The page is `index.html`.

## Rebuilding
The page is built from `source/` into one self-contained file: `cd source && npm install && npm run build`.
