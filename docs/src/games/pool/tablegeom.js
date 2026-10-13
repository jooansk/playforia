// Table geometry traced from the engine's collision mask (pool-table-mask.gif /
// snooker-table-mask.gif: green = play, red = cushion/rail, black = pocket).
//
// Both the 3D view and the realistic physics build on this, so the cushions you see, the
// cushions balls bounce off and the 2D board's own mask are one and the same shape.
// PURE: no DOM, no engine globals — the caller passes a per-pixel classifier.
//
// Coordinates are table pixels (same as game.js): pixel (ix,iy) covers the square
// [ix-0.5, ix+0.5] × [iy-0.5, iy+0.5] because game.js samples the mask with Math.round().

export const PLAY = 0, RAIL = 1, POCKET = 2;

/**
 * @param {object} o
 * @param {number} o.w            table width  (TW)
 * @param {number} o.h            table height (TH)
 * @param {(x:number,y:number)=>number} o.cell   PLAY | RAIL | POCKET for integer pixel (x,y)
 * @param {number} o.cushionWidth width of the cloth-covered cushion band (pixels)
 */
export function traceTable({ w, h, cell, cushionWidth }) {
  const n = w * h;
  const grid = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grid[y * w + x] = cell(x, y);
  // Only "pocket" pixels that open onto the cloth are pockets: the mask GIFs have transparent
  // corners, which read back as black and would otherwise become phantom holes in the rail.
  for (const c of components(w, h, i => grid[i] === POCKET)) {
    let opens = false;
    for (let i = 0; i < n && !opens; i++) {
      if (c.lab[i] !== c.id) continue;
      const x = i % w;
      opens = (x > 0 && grid[i - 1] === PLAY) || (x < w - 1 && grid[i + 1] === PLAY) ||
              (i >= w && grid[i - w] === PLAY) || (i < n - w && grid[i + w] === PLAY);
    }
    if (!opens) for (let i = 0; i < n; i++) if (c.lab[i] === c.id) grid[i] = RAIL;
  }

  const distG = chamfer(grid, w, h, PLAY);
  const distP = chamfer(grid, w, h, POCKET);
  // Cushion = the rail band next to the cloth, stopping short of the pocket cut-outs
  // (around a pocket the rail is leather/wood, not cushion).
  const isCush = new Uint8Array(n);
  for (let i = 0; i < n; i++) isCush[i] = grid[i] === RAIL && distG[i] <= cushionWidth && distP[i] >= 3.5 ? 1 : 0;

  const felt = largest(components(w, h, i => grid[i] === PLAY));
  const pockets = components(w, h, i => grid[i] === POCKET).filter(c => c.size >= 20);
  const cushions = components(w, h, i => isCush[i] === 1).filter(c => c.size >= 30);
  const opening = largest(components(w, h, i => grid[i] !== RAIL || isCush[i] === 1));

  const ring = (c, tol = 0.75) => simplifyClosed(contour(w, h, c), tol).map(([x, y]) => [x - 0.5, y - 0.5]);
  // Visual rings: round off the leftover pixel staircase on curves (short edges only, so
  // straight cushion faces and their corners stay exact).
  const smooth = (c) => smoothShort(ring(c, 0.5), 3.5, 3);
  const feltRing = ring(felt);

  // Collision segments: the edges of the cloth outline that border rail (not pocket mouths).
  const at = (x, y) => {
    const ix = Math.round(x), iy = Math.round(y);
    return ix < 0 || iy < 0 || ix >= w || iy >= h ? RAIL : grid[iy * w + ix];
  };
  const segs = [];
  for (let i = 0; i < feltRing.length; i++) {
    const p = feltRing[i], q = feltRing[(i + 1) % feltRing.length];
    const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    let nx = dy / len, ny = -dx / len;                 // candidate outward normal
    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    if (at(mx + nx * 1.2, my + ny * 1.2) === PLAY) { nx = -nx; ny = -ny; }
    if (at(mx + nx * 1.5, my + ny * 1.5) === POCKET) continue;   // pocket mouth: no cushion
    segs.push({ x1: p[0], y1: p[1], x2: q[0], y2: q[1] });
  }

  return {
    w, h, grid, distP, isCush, at,
    felt: feltRing,
    feltVisual: smooth(felt),
    pockets: pockets.map(smooth),
    cushions: cushions.map(c => ring(c, 1)),
    opening: smooth(opening),
    segs,
  };
}

// Two-pass chamfer distance (in pixels) to the nearest cell of value v.
function chamfer(grid, w, h, v) {
  const d = new Float32Array(w * h), D = Math.SQRT2;
  for (let i = 0; i < w * h; i++) d[i] = grid[i] === v ? 0 : 1e6;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; let m = d[i]; if (m === 0) continue;
    if (x > 0) m = Math.min(m, d[i - 1] + 1);
    if (y > 0) {
      m = Math.min(m, d[i - w] + 1);
      if (x > 0) m = Math.min(m, d[i - w - 1] + D);
      if (x < w - 1) m = Math.min(m, d[i - w + 1] + D);
    }
    d[i] = m;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; let m = d[i]; if (m === 0) continue;
    if (x < w - 1) m = Math.min(m, d[i + 1] + 1);
    if (y < h - 1) {
      m = Math.min(m, d[i + w] + 1);
      if (x < w - 1) m = Math.min(m, d[i + w + 1] + D);
      if (x > 0) m = Math.min(m, d[i + w - 1] + D);
    }
    d[i] = m;
  }
  return d;
}

// 4-connected components of the cells matching pred. The first cell of each component is
// its raster-first cell, which is where contour() starts tracing.
function components(w, h, pred) {
  const lab = new Int32Array(w * h).fill(-1), out = [], stack = [];
  for (let i = 0; i < w * h; i++) {
    if (lab[i] !== -1 || !pred(i)) continue;
    const id = out.length; let size = 0;
    lab[i] = id; stack.push(i);
    while (stack.length) {
      const j = stack.pop(); size++;
      const x = j % w, y = (j - x) / w;
      if (x > 0     && lab[j - 1] === -1 && pred(j - 1)) { lab[j - 1] = id; stack.push(j - 1); }
      if (x < w - 1 && lab[j + 1] === -1 && pred(j + 1)) { lab[j + 1] = id; stack.push(j + 1); }
      if (y > 0     && lab[j - w] === -1 && pred(j - w)) { lab[j - w] = id; stack.push(j - w); }
      if (y < h - 1 && lab[j + w] === -1 && pred(j + w)) { lab[j + w] = id; stack.push(j + w); }
    }
    out.push({ id, start: i, size, lab });
  }
  return out;
}

const largest = cs => cs.reduce((a, b) => (b.size > a.size ? b : a));

// Marching-squares outline of one component (port of d3.geom.contour, BSD-3). Returns
// pixel-corner points; corner (x,y) is the top-left corner of pixel (x,y).
const CDX = [1, 0, 1, 1, -1, 0, -1, 1, 0, 0, 0, 0, -1, 0, -1, NaN];
const CDY = [0, -1, 0, 0, 0, -1, 0, 0, 1, -1, 1, 1, 0, -1, 0, NaN];
function contour(w, h, c) {
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && c.lab[y * w + x] === c.id;
  const sx = c.start % w, sy = (c.start - sx) / w;
  const pts = [];
  let x = sx, y = sy, dx = 0, dy = 0, pdx = NaN, pdy = NaN, guard = 0;
  do {
    let i = 0;
    if (inside(x - 1, y - 1)) i += 1;
    if (inside(x, y - 1)) i += 2;
    if (inside(x - 1, y)) i += 4;
    if (inside(x, y)) i += 8;
    if (i === 6) { dx = pdy === -1 ? -1 : 1; dy = 0; }
    else if (i === 9) { dx = 0; dy = pdx === 1 ? -1 : 1; }
    else { dx = CDX[i]; dy = CDY[i]; }
    if (dx !== pdx && dy !== pdy) { pts.push([x, y]); pdx = dx; pdy = dy; }
    x += dx; y += dy;
  } while ((x !== sx || y !== sy) && ++guard < 1e6);
  return pts;
}

// Laplacian-smooth vertices whose both edges are short (pixel staircases on curves).
function smoothShort(r, maxLen, iters) {
  let pts = r;
  for (let k = 0; k < iters; k++) {
    const L = pts.length;
    pts = pts.map((p, i) => {
      const a = pts[(i - 1 + L) % L], b = pts[(i + 1) % L];
      if (Math.hypot(p[0] - a[0], p[1] - a[1]) > maxLen || Math.hypot(b[0] - p[0], b[1] - p[1]) > maxLen) return p;
      return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4];
    });
  }
  return pts;
}

// Douglas–Peucker on a closed ring: the pixel staircase collapses into straight cushion
// faces and 45° jaws, curves (pocket rims) into short chords.
function simplifyClosed(pts, tol) {
  if (pts.length < 5) return pts;
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const a = dp(pts.slice(0, far + 1), tol);
  const b = dp(pts.slice(far).concat([pts[0]]), tol);
  return a.slice(0, -1).concat(b.slice(0, -1));
}
function dp(pts, tol) {
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [ax, ay] = pts[s], [bx, by] = pts[e];
    const L = Math.hypot(bx - ax, by - ay) || 1e-9;
    let idx = -1, md = tol;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L;
      if (d > md) { md = d; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}
