// Find the printed label in a photo (a large, bright, low-colour, mostly rectangular area) so OCR reads only the label.
// Works on RGBA pixel data. Returns { x, y, w, h } in pixels, or null.
export function findLabelRegion(data, W, H) {
  const G = 96; // grid cells along the long side
  const cell = Math.max(4, Math.round(Math.max(W, H) / G));
  const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
  const luma = new Float32Array(gw * gh), sat = new Float32Array(gw * gh), edge = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let sl = 0, ss = 0, se = 0, n = 0;
    const y1 = Math.min(H, (gy + 1) * cell), x1 = Math.min(W, (gx + 1) * cell);
    for (let y = gy * cell; y < y1; y += 2) for (let x = gx * cell; x < x1; x += 2) {
      const i = (y * W + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      sl += l; ss += Math.max(r, g, b) - Math.min(r, g, b);
      if (x + 2 < x1) { const j = i + 8; se += Math.abs(l - (0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2])); }
      n++;
    }
    const k = gy * gw + gx; luma[k] = sl / n; sat[k] = ss / n; edge[k] = se / n;
  }
  // "paper" threshold relative to this photo's brightness
  const sorted = Float32Array.from(luma).sort();
  const thr = Math.max(120, sorted[Math.floor(sorted.length * 0.6)] * 0.95);
  const paper = new Uint8Array(gw * gh);
  for (let k = 0; k < paper.length; k++) paper[k] = luma[k] >= thr && sat[k] < 60 ? 1 : 0;
  // close small gaps (printed text/barcodes make holes in the paper)
  const closed = new Uint8Array(paper);
  for (let gy = 1; gy < gh - 1; gy++) for (let gx = 1; gx < gw - 1; gx++) {
    const k = gy * gw + gx;
    if (paper[k]) continue;
    let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += paper[k + dy * gw + dx];
    if (s >= 5) closed[k] = 1;
  }
  // connected components; score = area × rectangularity × text-ness (edges inside)
  const lab = new Int32Array(gw * gh).fill(-1);
  let best = null;
  for (let k0 = 0; k0 < closed.length; k0++) {
    if (!closed[k0] || lab[k0] >= 0) continue;
    const q = [k0]; lab[k0] = k0;
    let x0 = gw, y0 = gh, x1 = 0, y1 = 0, area = 0, ed = 0;
    while (q.length) {
      const k = q.pop(), x = k % gw, y = (k / gw) | 0;
      area++; ed += edge[k];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const nk = ny * gw + nx;
        if (closed[nk] && lab[nk] < 0) { lab[nk] = k0; q.push(nk); }
      }
    }
    const boxA = (x1 - x0 + 1) * (y1 - y0 + 1), fill = area / boxA, frac = area / (gw * gh);
    if (frac < 0.02 || frac > 0.9 || fill < 0.45) continue;
    // a label has print on it: average edge strength inside
    const score = area * fill * Math.min(1, ed / area / 6 + 0.2);
    if (!best || score > best.score) best = { score, x0, y0, x1, y1 };
  }
  if (!best) return null;
  const m = 1; // one cell of margin
  const x = Math.max(0, (best.x0 - m) * cell), y = Math.max(0, (best.y0 - m) * cell);
  const w = Math.min(W, (best.x1 + 1 + m) * cell) - x, h = Math.min(H, (best.y1 + 1 + m) * cell) - y;
  return { x, y, w, h };
}

// White out barcode stripe bands (tall, narrow dark bars, also dotted dot-matrix ones) so OCR doesn't read them as text.
// Works in place on RGBA ImageData-like { data, width, height }.
export function blankStripes(im, frac = 0.12) {
  const W = im.width, H = im.height, d = im.data, N = W * H;
  const L = new Uint8Array(N);
  for (let i = 0; i < N; i++) L[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
  // smooth along columns so dotted bars become solid (running mean)
  const R = Math.max(2, Math.round(H * 0.006)), S = new Uint8Array(N);
  for (let x = 0; x < W; x++) {
    let acc = 0, n = 0;
    for (let y = 0; y < Math.min(H, R); y++) { acc += L[y * W + x]; n++; }
    for (let y = 0; y < H; y++) {
      if (y + R < H) { acc += L[(y + R) * W + x]; n++; }
      if (y - R - 1 >= 0) { acc -= L[(y - R - 1) * W + x]; n--; }
      S[y * W + x] = acc / n;
    }
  }
  const hs = Uint8Array.from(S).sort(), thr = hs[Math.floor(N * 0.85)] * 0.72, minRun = Math.round(H * frac);
  const mask = new Uint8Array(N);
  for (let x = 0; x < W; x++) { let y = 0; while (y < H) { if (S[y * W + x] < thr) { let y2 = y; while (y2 < H && S[y2 * W + x] < thr) y2++; if (y2 - y >= minRun) for (let k = y; k < y2; k++) mask[k * W + x] = 1; y = y2; } else y++; } }
  // bars are narrow: drop wide dark areas (background, hands)
  const maxW = Math.max(3, Math.round(W * 0.02));
  for (let y = 0; y < H; y++) { let x = 0; while (x < W) { if (S[y * W + x] < thr) { let x2 = x; while (x2 < W && S[y * W + x2] < thr) x2++; if (x2 - x > maxW) for (let k = x; k < x2; k++) mask[y * W + k] = 0; x = x2; } else x++; } }
  const rows = new Uint32Array(H);
  for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) n += mask[y * W + x]; rows[y] = n; }
  const bands = [];
  let y = 0;
  while (y < H) {
    if (rows[y] <= W * 0.03) { y++; continue; }
    let y2 = y; while (y2 < H && rows[y2] > W * 0.03) y2++;
    if (y2 - y >= minRun * 0.8) {
      const colN = new Uint32Array(W);
      for (let yy = y; yy < y2; yy++) for (let x = 0; x < W; x++) colN[x] += mask[yy * W + x];
      let x0 = W, x1 = -1;
      for (let x = 0; x < W; x++) if (colN[x] >= (y2 - y) * 0.5) { if (x < x0) x0 = x; x1 = x; }
      if (x1 - x0 > W * 0.15) {
        const pad = Math.round(H * 0.01);
        bands.push([x0, x1, y, y2]);
        for (let yy = Math.max(0, y - pad); yy < Math.min(H, y2 + pad); yy++) for (let x = Math.max(0, x0 - pad); x <= Math.min(W - 1, x1 + pad); x++) { const k = (yy * W + x) * 4; d[k] = d[k + 1] = d[k + 2] = 255; }
      }
    }
    y = y2;
  }
  return bands;
}
