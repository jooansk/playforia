// Realistic shot physics, after Evan Kiefl's "pooltool" model
// (https://ekiefl.github.io/2020/04/24/pooltool-theory/).
//
// Each ball carries a planar velocity v and a full 3-D angular velocity ω, and is always in
// one of four motion states whose equations of motion have closed-form solutions:
//   sliding   — contact point slips: v and ω both change under sliding friction μs,
//               until the slip u = v + R ẑ×ω reaches zero after τ = 2|u|/(7 μs g);
//   rolling   — u = 0: v decays under rolling friction μr, ω_xy follows v;
//   spinning  — v = 0, only the vertical spin ω_z decays under spinning friction μsp;
//   stationary.
// The vertical spin ω_z decays independently in every state. Events on top of that:
//   cue strike   — Leckie & Greenspan impulse (tip offset a,b + cue elevation θ → v, ω);
//   ball–ball    — instantaneous, frictionless, equal masses (normal velocities exchange,
//                  spin is kept — which is what makes draw / follow / stun work);
//   ball–cushion — Han (2005) impulse model at the cushion's contact height, so side spin
//                  ("english") changes the rebound angle and topspin/backspin interacts
//                  with the rail.
// Integration is a fixed-step march (each step advances every ball analytically through
// any state change inside the step), so results don't depend on the frame rate.
//
// Scope: local modes only. ONLINE games keep the original Java-ported engine, because every
// client (and the server's replay) must simulate a shot bit-for-bit identically.
//
// This module swaps the engine's global startPhysics/stepPhysics (classic-script functions in
// game.js) for wrappers, and drives the same engine state the rules read: balls[i].x/y,
// active/falling, firstHit, pocketed, cueScratch, and the per-ball cueStruck/banked flags.

import { buildTable, pocketAt } from './tablegeom.js';

const KEY = 'pool-physics';
const G = 9.81;                         // m/s²
const M_BALL = 0.170, M_CUE = 0.567;    // kg
const R_POOL = 0.028575, R_SNOOKER = 0.02625;   // m (2¼" pool ball, 52.5 mm snooker ball)
const MU_S = 0.2;                       // sliding friction
const MU_R = 0.012;                     // rolling friction
const MU_SP_PER_R = 10 * 2 / 5 / 9;     // spinning friction μsp = this × R (pooltool default)
const E_BALL = 0.95;                    // ball–ball restitution
const E_CUSHION = 0.8, F_CUSHION = 0.2;     // Han 2005: cushion restitution & friction
const CUSHION_H = 1.28;                 // cushion contact height / R (pooltool: 0.64 · 2R)
const SPIN_OFFSET = 0.5;                // full spin-panel deflection → tip offset of 0.5 R
const SUBSTEPS = 24;                    // integration steps per 1/60 s frame
const FRAME = 1 / 60;
const FALL_FRAMES = 12;                 // pocket drop animation length (frames)
const CLASSIC_V = 300;                  // px/s → the classic engine's velocity units (sound)
// Regulation tables: Playforia's cloth area is kept and the balls shrink to real proportions
// (play area ≈ 44 × 22 ball widths for a 9 ft pool table, ≈ 68 × 34 for a 12 ft snooker table).
const REAL_BALL_SCALE = { pool: 0.635, snooker: 0.66 };

let enabled = loadPref();
let installed = false;
let classic = null;      // { start, step } — the engine's own functions
let sim = null;          // running shot (null when idle)
let geomCache = null;    // tablegeom.buildTable() for the current mode

function loadPref() {
  try { return localStorage.getItem(KEY) !== 'classic'; } catch (_) { return true; }
}

/** Is the realistic model in use for the current mode? (online always uses classic) */
export function activeNow() { return enabled && gameMode !== 'online'; }
export function isEnabled() { return enabled; }
export function setEnabled(on) {
  enabled = !!on;
  try { localStorage.setItem(KEY, enabled ? 'real' : 'classic'); } catch (_) {}
}

/** Swap the engine's startPhysics/stepPhysics for mode-aware wrappers. Idempotent. */
export function install() {
  if (installed) return;
  installed = true;
  classic = { start: window.startPhysics, step: window.stepPhysics };
  window.startPhysics = function (cx, cy, pwr) {
    sim = null;
    if (!activeNow()) {
      for (const b of balls) b.rq = null;   // no spin state: the 3D view falls back to rolling
      return classic.start(cx, cy, pwr);
    }
    return startReal(cx, cy, pwr);
  };
  window.stepPhysics = function () {
    if (!sim) return classic.step();
    return stepReal();
  };
  // Table size follows the physics model, decided per rack (a size change mid-rack would
  // leave balls overlapping or apart).
  const resetGame = window.resetGame;
  window.resetGame = function (mode) {
    const m = mode || gameMode;
    const real = enabled && m !== 'online';
    setBallScale(real ? REAL_BALL_SCALE[m === 'snooker' ? 'snooker' : 'pool'] : 1);
    return resetGame(mode);
  };
}

// ─── table geometry (cushion segments + pocket holes, shared with the 3D view) ────────────
function geometry() {
  const mode = gameMode === 'snooker' ? 'snooker' : 'pool';
  if (!geomCache || geomCache.mode !== mode || geomCache.TW !== TW || geomCache.R !== BALL_R) {
    geomCache = buildTable({ mode, TW, TH, R: BALL_R });
  }
  return geomCache;
}

// ─── shot setup ─────────────────────────────────────────────────────────────────────────
// Internally we use pooltool's right-handed frame: X = table x, Y = −(table y), Z up.
function startReal(cx, cy, pwr) {
  const cu = balls[0];
  const dx = cx - cu.x, dy = cy - cu.y;
  if (Math.hypot(dx, dy) < 1) return false;

  const Rm = gameMode === 'snooker' ? R_SNOOKER : R_POOL;
  const s = BALL_R / Rm;                         // px per metre
  const R = BALL_R;
  const P = {
    R, s, g: G * s,
    musp: MU_SP_PER_R * Rm,
    table: geometry(),
    segs: geometry().segs,
    dt: FRAME / SUBSTEPS,
    t: 0,
  };

  const st = balls.map((b) => ({
    x: b.x, y: -b.y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0,
    q: b.rq || (b.rq = [0, 0, 0, 1]),
  }));

  // Cue strike. a = side offset (+ = shooter's left), b = height offset (+ = above centre),
  // both as fractions of R; the engine's spin panel gives spinX (+ = right), spinY (+ = low).
  const a = -spinX * SPIN_OFFSET, b = -spinY * SPIN_OFFSET;
  // Cue elevation: the 3D view publishes the effective angle (raised to clear the rail);
  // without it (2D board) the cue is level.
  const cue = window.poolCue || {};
  const theta = Math.max(0, Math.min(80, cue.effective || 0)) * Math.PI / 180;
  // Cue speed. Quadratic so the low end of the power bar is fine-grained (with real cloth even
  // 1 m/s rolls most of a 9 ft table). Full power ≈ 4.7 m/s cue → ≈ 7 m/s cue ball: a hard break.
  const V0 = (0.1 + 4.6 * (pwr / 100) ** 2) * s;
  const phi = Math.atan2(-dy, dx);
  strike(st[0], P, V0, phi, theta, a, b);

  for (let k = 0; k < balls.length; k++) {
    balls[k].moving = (k === 0); balls[k].banked = false; balls[k].cueStruck = false;
  }
  firstHit = -1; pocketed = []; cueScratch = false;
  Sound.strike(pwr);
  sim = { P, st };
  return true;
}

// Leckie & Greenspan cue–ball impulse as used by pooltool's cue_strike().
function strike(c, P, V0, phi, theta, a, b) {
  const R = P.R, m = M_BALL, M = M_CUE;
  a *= R; b *= R;
  const cc = Math.sqrt(Math.max(R * R - a * a - b * b, 0));
  const ct = Math.cos(theta), stt = Math.sin(theta);
  const temp = a * a + (b * ct - cc * stt) ** 2;
  const F = (2 * M * V0) / (1 + m / M + (5 / (2 * R * R)) * temp);
  const I = (2 / 5) * m * R * R;
  // Ball frame (ball travels along −y_B), then rotate by phi + π/2 into the table frame.
  const vB = [0, (-F / m) * ct, 0];            // no jumping: vertical component dropped
  const wB = [(F / I) * (-cc * stt + b * ct), (F / I) * (a * stt), (F / I) * (-a * ct)];
  const r = phi + Math.PI / 2, cr = Math.cos(r), sr = Math.sin(r);
  c.vx = vB[0] * cr - vB[1] * sr; c.vy = vB[0] * sr + vB[1] * cr;
  c.wx = wB[0] * cr - wB[1] * sr; c.wy = wB[0] * sr + wB[1] * cr; c.wz = wB[2];
}

// ─── per-frame stepping ─────────────────────────────────────────────────────────────────
function stepReal() {
  const { P, st } = sim;
  for (let n = 0; n < SUBSTEPS; n++) {
    for (let i = 0; i < st.length; i++) {
      const b = balls[i];
      if (!b.active || b.falling) continue;
      evolve(st[i], P, P.dt);
    }
    collideBalls(st, P);
    collideCushions(st, P);
    checkPockets(st, P);
    P.t += P.dt;
  }
  advanceFall();

  // Mirror into the engine's ball objects (positions in table px; velocities in the classic
  // engine's units so anything reading vx/vy sees familiar magnitudes).
  let moving = false;
  for (let i = 0; i < st.length; i++) {
    const b = balls[i], k = st[i];
    if (!b.active) continue;
    if (!b.falling) {
      b.x = k.x; b.y = -k.y;
      b.vx = k.vx / CLASSIC_V; b.vy = -k.vy / CLASSIC_V;
      if (k.vx !== 0 || k.vy !== 0) moving = true;
    } else if (b.fp < PCAPT) moving = true;
  }
  if (!moving || P.t > 60) {
    for (const b of balls) { b.vx = b.vy = 0; }
    sim = null;
    return true;
  }
  return false;
}

// Advance one ball by dt through whatever state changes happen inside the step.
function evolve(k, P, dt) {
  const R = P.R, g = P.g;
  for (let guard = 0; dt > 1e-12 && guard < 4; guard++) {
    const ux = k.vx - R * k.wy, uy = k.vy + R * k.wx;     // slip at the contact point
    const u = Math.hypot(ux, uy), v = Math.hypot(k.vx, k.vy);
    let t;
    if (u > 1e-6 * P.s) {
      // SLIDING: friction opposes the slip; it slows v and torques ω toward rolling.
      const tau = (2 * u) / (7 * MU_S * g);
      t = Math.min(dt, tau);
      const hx = ux / u, hy = uy / u, acc = MU_S * g;
      k.x += k.vx * t - 0.5 * acc * t * t * hx;
      k.y += k.vy * t - 0.5 * acc * t * t * hy;
      k.vx -= acc * t * hx; k.vy -= acc * t * hy;
      const dw = ((5 * MU_S * g) / (2 * R)) * t;            // dω = dw · (ẑ × û)
      k.wx += -dw * hy; k.wy += dw * hx;
      if (t >= tau) { k.wx = -k.vy / R; k.wy = k.vx / R; }  // snap onto the rolling constraint
    } else if (v > 0) {
      // ROLLING: decelerate along v; ω_xy stays locked to v.
      const tau = v / (MU_R * g);
      t = Math.min(dt, tau);
      const hx = k.vx / v, hy = k.vy / v, acc = MU_R * g;
      k.x += k.vx * t - 0.5 * acc * t * t * hx;
      k.y += k.vy * t - 0.5 * acc * t * t * hy;
      if (t >= tau) { k.vx = 0; k.vy = 0; }
      else { k.vx -= acc * t * hx; k.vy -= acc * t * hy; }
      k.wx = -k.vy / R; k.wy = k.vx / R;
    } else {
      // SPINNING / STATIONARY: only the vertical spin is left.
      t = dt;
      k.vx = k.vy = 0; k.wx = k.wy = 0;
    }
    // Vertical spin decays under spinning friction in every state.
    const dz = ((5 * P.musp * g) / (2 * R)) * t;
    k.wz = Math.abs(k.wz) <= dz ? 0 : k.wz - Math.sign(k.wz) * dz;
    rotate(k, t);
    dt -= t;
  }
}

// Accumulate the ball's orientation (quaternion, pooltool frame) — the 3D view reads it.
function rotate(k, t) {
  const w = Math.hypot(k.wx, k.wy, k.wz);
  if (w < 1e-9) return;
  const h = (w * t) / 2, s = Math.sin(h) / w;
  const ax = k.wx * s, ay = k.wy * s, az = k.wz * s, aw = Math.cos(h);
  const q = k.q, [bx, by, bz, bw] = q;
  q[0] = aw * bx + ax * bw + ay * bz - az * by;
  q[1] = aw * by - ax * bz + ay * bw + az * bx;
  q[2] = aw * bz + ax * by - ay * bx + az * bw;
  q[3] = aw * bw - ax * bx - ay * by - az * bz;
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  q[0] /= n; q[1] /= n; q[2] /= n; q[3] /= n;
}

function collideBalls(st, P) {
  const D = 2 * P.R;
  for (let i = 0; i < st.length - 1; i++) {
    const bi = balls[i];
    if (!bi.active || bi.falling) continue;
    const a = st[i];
    for (let j = i + 1; j < st.length; j++) {
      const bj = balls[j];
      if (!bj.active || bj.falling) continue;
      const c = st[j];
      const dx = c.x - a.x, dy = c.y - a.y;
      if (Math.abs(dx) >= D || Math.abs(dy) >= D) continue;
      const d = Math.hypot(dx, dy);
      if (d >= D || d === 0) continue;
      const nx = dx / d, ny = dy / d;
      const van = a.vx * nx + a.vy * ny, vcn = c.vx * nx + c.vy * ny;
      // Push apart so the pair never sticks, then resolve only if still approaching.
      const push = (D - d) / 2;
      a.x -= nx * push; a.y -= ny * push; c.x += nx * push; c.y += ny * push;
      if (van - vcn <= 0) continue;
      const rel = Math.hypot(a.vx - c.vx, a.vy - c.vy);
      const mid = (van + vcn) / 2, half = (E_BALL * (van - vcn)) / 2;
      const na = mid - half, nc = mid + half;
      a.vx += (na - van) * nx; a.vy += (na - van) * ny;
      c.vx += (nc - vcn) * nx; c.vy += (nc - vcn) * ny;
      bi.moving = bj.moving = true;
      if (i === 0) bj.cueStruck = true;
      if (firstHit === -1 && i === 0) firstHit = j;
      if (!replaying) Sound.collision(rel / CLASSIC_V);
    }
  }
}

function collideCushions(st, P) {
  const R = P.R, edge = R + 40;
  for (let i = 0; i < st.length; i++) {
    const b = balls[i];
    if (!b.active || b.falling) continue;
    const k = st[i], x = k.x, y = -k.y;           // segments are in table px
    if (x > edge && x < TW - edge && y > edge && y < TH - edge) continue;
    let best = null, bd = R;
    for (const s of P.segs) {
      const sx = s.x2 - s.x1, sy = s.y2 - s.y1, L2 = sx * sx + sy * sy;
      let t = ((x - s.x1) * sx + (y - s.y1) * sy) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = s.x1 + sx * t, py = s.y1 + sy * t;
      const d = Math.hypot(x - px, y - py);
      if (d < bd) { bd = d; best = { px, py, d }; }
    }
    if (!best) continue;
    // Normal from the ball centre toward the contact point, in the pooltool frame (Y flipped).
    const d = best.d || 1e-6;
    const nx = (best.px - x) / d, ny = -(best.py - y) / d;
    k.x -= nx * (R - d); k.y -= ny * (R - d);     // resolve penetration
    if (k.vx * nx + k.vy * ny <= 0) continue;     // already leaving the cushion
    const speed = Math.hypot(k.vx, k.vy);
    hanCushion(k, nx, ny, R);
    b.banked = true; b.moving = true;
    if (!replaying) Sound.wall(speed / CLASSIC_V);
  }
}

// Han (2005) ball–cushion impulse, as implemented in pooltool. (nx,ny) points into the
// cushion; we rotate into the cushion frame (normal = +x), apply, and rotate back.
function hanCushion(k, nx, ny, R) {
  const m = M_BALL, e = E_CUSHION, mu = F_CUSHION;
  let vx = k.vx * nx + k.vy * ny, vy = -k.vx * ny + k.vy * nx;
  let wx = k.wx * nx + k.wy * ny, wy = -k.wx * ny + k.wy * nx, wz = k.wz;
  const ta = Math.asin(CUSHION_H - 1), sa = Math.sin(ta), ca = Math.cos(ta);
  const phi = Math.atan2(vy, vx);
  const sx = vx * sa + R * wy;                    // (v_z = 0)
  const sy = -vy - R * wz * ca + R * wx * sa;
  const c = vx * ca;
  const I = (2 / 5) * m * R * R, A = 7 / (2 * m), B = 1 / m;
  const PzE = ((1 + e) * c) / B, PzS = Math.hypot(sx, sy) / A;
  let PX, PY, PZ;
  if (PzS <= PzE) {          // sliding then sticking
    PX = (-sx / A) * sa - ((1 + e) * c / B) * ca;
    PY = sy / A;
    PZ = (sx / A) * ca - ((1 + e) * c / B) * sa;
  } else {                   // forward sliding throughout
    const j = (mu * (1 + e) * c) / B;
    PX = -j * Math.cos(phi) * sa - ((1 + e) * c / B) * ca;
    PY = j * Math.sin(phi);
    PZ = j * Math.cos(phi) * ca - ((1 + e) * c / B) * sa;
  }
  vx += PX / m; vy += PY / m;
  wx += (-R / I) * PY * sa;
  wy += (R / I) * (PX * sa - PZ * ca);
  wz += (R / I) * PY * ca;
  k.vx = vx * nx - vy * ny; k.vy = vx * ny + vy * nx;
  k.wx = wx * nx - wy * ny; k.wy = wx * ny + wy * nx; k.wz = wz;
}

// A ball drops once its centre is over a pocket hole, then plays the classic fall
// animation (b.fp → PCAPT) toward the hole centre.
function checkPockets(st, P) {
  for (let i = 0; i < st.length; i++) {
    const b = balls[i], k = st[i];
    if (!b.active || b.falling) continue;
    const x = k.x, y = -k.y;
    const pi = pocketAt(P.table, x, y);
    if (pi < 0) continue;
    const pk = P.table.pockets[pi];
    b.x = x; b.y = y;
    b.falling = true; b.fp = 0.01; b.vx = b.vy = 0;
    b.fpx = pk.x; b.fpy = pk.y;
    k.vx = k.vy = k.wx = k.wy = k.wz = 0;
    Sound.pocket();
    if (i === 0) cueScratch = true;
    else pocketed.push(i);
  }
}

function advanceFall() {
  for (const b of balls) {
    if (!b.active || !b.falling || b.fp >= PCAPT) continue;
    b.fp = Math.min(PCAPT, b.fp + PCAPT / FALL_FRAMES);
    const dx = b.fpx - b.x, dy = b.fpy - b.y, d = Math.hypot(dx, dy);
    if (d > 0.5) { const step = Math.min(d, 2.2); b.x += (dx / d) * step; b.y += (dy / d) * step; }
  }
}
