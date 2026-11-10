# Inventory Day

A phone web page for counting electronics and PCB components. No account needed.

- Scan supplier barcodes (Mouser, DigiKey, LCSC, TME and other ECIA DataMatrix/QR codes) by live camera or photo.
- Farnell / element14 bag labels: the barcode gives the order and line; the printed text (order code, MPN, description, qty) is read on the phone with OCR (Tesseract.js, downloaded once from jsDelivr). Imported Farnell order history corrects any misread characters.
- Print QR labels for boxes and for unmarked parts.
- Import order history from Mouser, DigiKey, LCSC, TME or Farnell to fill in part descriptions.
- Several people can count at once. A Google Sheet holds the shared list (`Code.gs` is its Apps Script backend).
- Export to Excel.

Setup: open the page → **Setup** tab, and follow the steps there.

## Hosting
GitHub Pages: Settings → Pages → Deploy from a branch → `main` / root. The page is `index.html`.

## Rebuilding
The page is built from `source/` into one self-contained file: `cd source && npm install && npm run build`.
