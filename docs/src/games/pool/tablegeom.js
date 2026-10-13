// Table geometry, defined analytically: straight cushion faces, angled pocket jaws and round
// pocket holes. Shared by the 3D view (what you see) and the realistic physics (what balls
// bounce off and drop into), so the two always agree. PURE: no DOM, no engine globals.
//
// Coordinates are table pixels, as in game.js (x right, y down). Cushion-face positions are
// measured from the original collision masks, so the cloth area matches the 2D board; the
// pockets are our own, sized like a real table (the 2D masks' mouths are barely one ball wide
// and rely on the classic engine pulling balls in).
//
// Each pocket: a hole of radius r centred at (x,y). Its two jaws run from the cushion face
// (jaw point J) into the rail, converging slightly, and are tangent to the hole. A ball is
// pocketed once its centre is over the hole.

const DEG = Math.PI / 180;

// Face positions in px (the cloth area, as in the 2D masks); pocket sizes in ball radii so
// they stay right when the balls are scaled to regulation size.
//   k: corner hole centre beyond the face corner; e: side hole centre beyond the face
//   cm/sm: corner/side mouth half-sizes along the face; jaw convergence angles (deg)
const SPECS = {
  pool:    { L: 30.5, Rr: 31.5, T: 30.5, Bb: 31.5, k: 0.25, e: 1.25, cm: 2.7, sm: 2.15, betaC: 7, betaS: 14 },
  snooker: { L: 29.5, Rr: 30.5, T: 29.5, Bb: 30.5, k: 0.67, e: 1.5, cm: 2.33, sm: 1.92, betaC: 7, betaS: 14 },
};

/**
 * @param {object} o
 * @param {'pool'|'snooker'} o.mode
 * @param {number} o.TW  table width (px)
 * @param {number} o.TH  table height (px)
 * @param {number} o.R   ball radius (px)
 */
export function buildTable({ mode, TW, TH, R }) {
  const sp = SPECS[mode] || SPECS.pool;
  const s = { ...sp, k: sp.k * R, e: sp.e * R, cm: sp.cm * R, sm: sp.sm * R };
  const L = s.L, Rx = TW - s.Rr, T = s.T, B = TH - s.Bb, cx = (L + Rx) / 2;
  const cw = Math.max(7, R * 1.1);                 // cushion depth (face → back line)
  const n = Math.SQRT1_2;

  // Clockwise around the table (screen coords): TL, TS, TR, BR, BS, BL.
  // jin = jaw we arrive at walking clockwise, jout = jaw we leave from; nf = face's outward normal.
  const defs = [
    { c: [L - s.k, T - s.k], a: [-n, -n], beta: s.betaC, jin: [L, T + s.cm], nin: [-1, 0], jout: [L + s.cm, T], nout: [0, -1] },
    { c: [cx, T - s.e],      a: [0, -1],  beta: s.betaS, jin: [cx - s.sm, T], nin: [0, -1], jout: [cx + s.sm, T], nout: [0, -1] },
    { c: [Rx + s.k, T - s.k], a: [n, -n], beta: s.betaC, jin: [Rx - s.cm, T], nin: [0, -1], jout: [Rx, T + s.cm], nout: [1, 0] },
    { c: [Rx + s.k, B + s.k], a: [n, n],  beta: s.betaC, jin: [Rx, B - s.cm], nin: [1, 0], jout: [Rx - s.cm, B], nout: [0, 1] },
    { c: [cx, B + s.e],      a: [0, 1],   beta: s.betaS, jin: [cx + s.sm, B], nin: [0, 1], jout: [cx - s.sm, B], nout: [0, 1] },
    { c: [L - s.k, B + s.k], a: [-n, n],  beta: s.betaC, jin: [L + s.cm, B], nin: [0, 1], jout: [L, B - s.cm], nout: [-1, 0] },
  ];

  const pockets = defs.map((d) => {
    const [px, py] = d.c, [ax, ay] = d.a;
    const jaw = (J, nf) => {
      const vx = px - J[0], vy = py - J[1];
      const along = vx * ax + vy * ay;
      let wx = vx - along * ax, wy = vy - along * ay;              // J → pocket axis
      const wl = Math.hypot(wx, wy) || 1; wx /= wl; wy /= wl;
      const cb = Math.cos(d.beta * DEG), sb = Math.sin(d.beta * DEG);
      const dx = ax * cb + wx * sb, dy = ay * cb + wy * sb;         // jaw direction (into the rail)
      const tTan = vx * dx + vy * dy;                               // foot of the hole centre
      const r = Math.abs(vx * dy - vy * dx);                        // hole radius: jaw is tangent
      let tBack = cw / (dx * nf[0] + dy * nf[1]);                   // where the jaw meets the back line
      tBack = Math.min(tBack, tTan - 0.5);
      return { J, d: [dx, dy], r, tan: [J[0] + dx * tTan, J[1] + dy * tTan], back: [J[0] + dx * tBack, J[1] + dy * tBack] };
    };
    const jin = jaw(d.jin, d.nin), jout = jaw(d.jout, d.nout);
    const r = Math.min(jin.r, jout.r);
    // Near arc (facing the cloth) and far arc (inside the rail) between the tangent points.
    const ang = (p) => Math.atan2(p[1] - py, p[0] - px);
    const a0 = ang(jin.tan);
    let sweep = ang(jout.tan) - a0;
    sweep = ((sweep % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);  // ccw sweep in [0, 2π)
    const mid = a0 + sweep / 2;
    const ccwIsNear = Math.cos(mid) * -ax + Math.sin(mid) * -ay > 0;
    const arc = (near) => {
      const sw = (near === ccwIsNear) ? sweep : sweep - 2 * Math.PI;
      const steps = Math.max(6, Math.ceil(Math.abs(sw) * r / 2));
      const pts = [];
      for (let i = 1; i < steps; i++) {
        const t = a0 + (sw * i) / steps;
        pts.push([px + Math.cos(t) * r, py + Math.sin(t) * r]);
      }
      return pts;
    };
    return { x: px, y: py, r, jin, jout, nearArc: arc(true), farArc: arc(false), side: d.beta === s.betaS };
  });

  const felt = [], opening = [], cushions = [], segs = [];
  const seg = (p, q) => segs.push({ x1: p[0], y1: p[1], x2: q[0], y2: q[1] });
  pockets.forEach((p, i) => {
    felt.push(p.jin.J, p.jin.tan, ...p.nearArc, p.jout.tan, p.jout.J);
    opening.push(p.jin.back, p.jin.tan, ...p.farArc, p.jout.tan, p.jout.back);
    const q = pockets[(i + 1) % pockets.length];
    cushions.push([p.jout.J, q.jin.J, q.jin.back, p.jout.back]);
    seg(p.jout.J, q.jin.J);          // cushion face
    seg(p.jin.J, p.jin.tan);         // jaws, from the cushion nose to the hole
    seg(p.jout.J, p.jout.tan);
  });

  return { mode, TW, TH, R, faces: { L, R: Rx, T, B }, cushionWidth: cw, pockets, felt, opening, cushions, segs };
}

/** Index of the pocket whose hole is under (x,y), or −1. */
export function pocketAt(t, x, y) {
  for (let i = 0; i < t.pockets.length; i++) {
    const p = t.pockets[i];
    if ((x - p.x) ** 2 + (y - p.y) ** 2 < p.r * p.r) return i;
  }
  return -1;
}

/** Even–odd point-in-polygon. */
export function inPoly(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
