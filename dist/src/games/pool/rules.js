// Pure pool rules & racking — no DOM, no canvas. Runnable on client (prediction/UX)
// AND server (authority). First module extracted from pool.html during the refactor.
//
// Racking faithfully follows the Java source (SPanel_Sub32_Sub1.method2657 / method2726):
//   8-ball   : triangle, 1 at apex, 8 in centre, rest random
//   9-ball   : DIAMOND (rows 1,2,3,2,1), 1 at front apex, 9 in the exact centre, 2–8 random
//   rotation : triangle, 1 at apex, 8 in centre (var1=2,var2=0)
// NOTE: fouls/scoring/win enforcement were server-side in the original and are NOT in
// the decompiled client — implement those here (and run them server-side) as we go.

import { shuffle } from '../../shared/rng.js';

// Pool table geometry (pool variant — SPanel_Sub32_Sub1.method2650)
export const POOL_GEOMETRY = { TW: 620, TH: 330, BALL_D: 20, BALL_R: 10 };
const ROWSP = Math.sqrt(300);  // aDouble4869 ≈ 17.32 (rack row x-spacing)

/** Standard triangle rack slots (apex toward the foot spot). Up to 15. */
export function trianglePositions(count = 15) {
  const pos = [];
  for (let row = 0; row < 5 && pos.length < count; row++) {
    const n = row + 1;
    const rx = 445 + row * (ROWSP + 0.9);
    let ry = (165 - Math.floor((n - 1) / 2) * 20) - (n / 2) * 0.9;
    if (n % 2 === 0) ry -= 10;
    for (let c = 0; c < n && pos.length < count; c++) pos.push({ x: rx, y: ry + c * 20.9 });
  }
  return pos;
}

/** 9-ball diamond slots (rows 1,2,3,2,1). index 0 = front apex, index 4 = exact centre. */
export function diamondPositions() {
  const rows = [1, 2, 3, 2, 1];
  const pos = [];
  let x = 445;
  for (const n of rows) {
    let y = 165 - ((n - 1) * 20.9) / 2;
    for (let c = 0; c < n; c++) { pos.push({ x, y }); y += 20.9; }
    x += ROWSP + 0.9;
  }
  return pos;
}

const place = (ids, pos) => ids.map((id, i) => ({ id, x: pos[i].x, y: pos[i].y }));
function fill(ids, fixed, pool, rng) {
  const rest = shuffle(pool, rng);
  let r = 0;
  for (let i = 0; i < ids.length; i++) if (ids[i] === undefined) ids[i] = rest[r++];
  return ids;
}

/** 8-ball: 1 apex, 8 centre, rest random. → [{id,x,y}] */
export function rack8(rng = Math.random) {
  const pos = trianglePositions(15);
  const ids = new Array(15); ids[0] = 1; ids[4] = 8;
  fill(ids, [0, 4], [2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15], rng);
  return place(ids, pos);
}

/** 9-ball: DIAMOND, 1 front apex, 9 dead centre, 2–8 random. → [{id,x,y}] */
export function rack9(rng = Math.random) {
  const pos = diamondPositions();
  const ids = new Array(9); ids[0] = 1; ids[4] = 9;
  fill(ids, [0, 4], [2, 3, 4, 5, 6, 7, 8], rng);
  return place(ids, pos);
}

/** Rotation: triangle, 1 apex, 8 centre, rest random. → [{id,x,y}] */
export function rackRotation(rng = Math.random) {
  const pos = trianglePositions(15);
  const ids = new Array(15); ids[0] = 1; ids[4] = 8;
  fill(ids, [0, 4], [2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15], rng);
  return place(ids, pos);
}

export function rack(mode, rng = Math.random) {
  if (mode === '9ball') return rack9(rng);
  if (mode === 'rotation') return rackRotation(rng);
  return rack8(rng);
}

// Mode metadata (rules summary; enforcement is server-authoritative).
export const MODES = {
  '8ball':     { title: 'Kasapallo',  win: 'pot your group, then the 8-ball' },
  '9ball':     { title: 'Ysipallo',   win: 'hit lowest first; legally pot the 9' },
  'rotation':  { title: 'Rotaatio',   win: 'hit lowest first; each ball scores its value (120 total, win past 61)' },
  'pistepallo':{ title: 'Pistepallo', win: 'pot any ball = 1 point; most points wins' },
  'snooker':   { title: 'Snooker',    win: 'reds(1) then colours in order; highest score' },
};
