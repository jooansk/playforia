'use strict';

// ─── CONSTANTS (from Java source) ───────────────────────────────────────────
// Geometry is mode-dependent: pool (SPanel_Sub32_Sub1) vs snooker (SPanel_Sub32_Sub2).
// setGeometry(mode) swaps these to the values from each subclass's method2650().
const TH = 330;            // table height (same for both)
const BORDER  = 30;        // table margin        (anInt4128)
const STEPS   = 50;        // inner steps/frame
const ITFRIC  = 0.912;     // collision damping   (method1498: vx,vy *= 0.912)
const WDAMP   = 0.81;      // wall energy loss    (method1500)
const ROWSP   = Math.sqrt(300);      // pool rack row spacing (aDouble4869 ≈ 17.32)

let TW = 620;              // table width         (anInt4123)
let BALL_D  = 20;          // collision diameter  (anInt4125)
let BALL_R  = 10;          // ball radius         (anInt4126)
let STRIKE  = 10;          // force multiplier    (anInt4129)
let FRIC    = 0.9935;      // rolling friction base (aDouble4134: pool 0.9935 / snooker 0.995)
let STOPV   = 0.09;        // stop threshold        (aDouble4135: pool 0.09 / snooker 0.08)
let PCAPT   = 3.0;         // pocket capture radius (aDouble4132)
let PDET    = 2.1;         // pocket detect radius  (aDouble4133)
let WDIAG   = Math.sqrt(50) + 0.5; // diagonal probe (aDouble4136 ≈ 7.57)

// Pocket centres (anIntArray4130/4131) — pool defaults
let PX = [26, 310, 593, 26, 310, 593];
let PY = [26,  21,  26,305, 310, 305];

// Snooker "D" geometry (SPanel_Sub32_Sub2 method2678): semicircle on baulk line
const SNK_BAULK_X = 138.79715691634772;
const SNK_D_CY    = 165.0;
const SNK_D_R     = 43.12910284463895;

function setGeometry(mode){
  if(mode==='snooker'){
    // SPanel_Sub32_Sub2.method2650()
    TW=600; BALL_D=12; BALL_R=6; STRIKE=9;
    FRIC=0.995; STOPV=0.08;
    PCAPT=2.0; PDET=1.5; WDIAG=Math.sqrt(18)+0.5;
    PX=[23,300,576, 23,300,576];   // anIntArray4880
    PY=[24, 19, 24,306,311,306];   // anIntArray4881
  } else {
    // SPanel_Sub32_Sub1.method2650()
    TW=620; BALL_D=20; BALL_R=10; STRIKE=10;
    FRIC=0.9935; STOPV=0.09;
    PCAPT=3.0; PDET=2.1; WDIAG=Math.sqrt(50)+0.5;
    PX=[26,310,593, 26,310,593];
    PY=[26, 21, 26,305,310,305];
  }
  if(typeof canvas!=='undefined' && canvas) canvas.width=TW;
  // Keep the top info bar aligned with table width + side panel (135px)
  const ib=document.getElementById('infobar');
  if(ib) ib.style.width=(TW+135)+'px';
}

// ─── STATE ──────────────────────────────────────────────────────────────────
const S = { INIT:0, PLACE:1, AIM:3, SHOOT:5, DONE:6 };
let gState = S.INIT;
let gameMode = 'hotseat'; // 'hotseat' | 'practice' | 'online' | 'count'

// Count mode state
let countPoints = 0;
let countShots  = 0;
let countTarget = 99;
// Jatkumo (streak) state — pot a ball on every shot; a miss/scratch ends the run.
let jatkumoStreak = 0;
let jatkumoShots = 0;
let jatkumoBest = (() => { try { return +(localStorage.getItem('pool-jatkumo-best') || 0); } catch (_) { return 0; } })();
let snookerBreak = 0;
let snookerScore = 0;
let snookerShots = 0;
let snookerPhase = 'red';       // 'red' | 'color' | 'endgame'
let snookerEndColorIdx = 0;     // 0=yellow … 5=black during endgame
// Display/option toggles (Äänet = sounds, Varjot = shadows)
let soundOn = true, shadowsOn = true;
// Shot clock (Aika) — multiplayer per-turn countdown
let shotClockMax = 60, shotClockLeft = 60, shotClockTimer = null, prevClockState = -1;
// Rack zone bounding box (ball centres must fall inside to trigger re-rack rules)
const RACK_ZONE = { x1:430, y1:105, x2:535, y2:220 };

// Ball objects: id, x, y, vx, vy, svx, svy, mass, active, falling, fp, fpx, fpy
let balls = [];

// Game
let curP = 0;
let group = [-1,-1];   // -1=unknown, 0=solid(1-7), 1=stripe(9-15)
let firstHit = -1;
let pocketed = [];     // ball ids pocketed this turn
let cueScratch = false;
let winner = -1;
let freeBall = false;  // ball in hand anywhere (after foul)

// Input
let mx = -1, my = -1;
let mdown = false;
let power = 5;
let shiftHeld = false;   // hold Shift while aiming for fine (slowed) aim adjustment
let pwrTimer = null;
let shooting = false;
let isViewer = false;    // true when spectating (no input; sees only the active aim line)

// Spin (set via spin panel, range approx -1..1 each axis)
let spinX = 0, spinY = 0;

// Images & mask
const imgs = {};
let loaded = 0;
const NEED = 10; // 5 pool + 5 snooker assets

// ─── AUDIO ───────────────────────────────────────────────────────────────────
// Faithful port of the Java sound model (SPanel_Sub32 + Class68/Class69). The .au
// originals were converted to .mp3 (browsers can't play .au). Played LOCALLY on every
// client — since the lockstep sim is identical, all clients (and viewers) hear the same.
//   strike-0..3   cue strike, by power            (once per shot)
//   collision-0..9 ball-ball, by impact speed     (√speed, 330ms per-index cooldown)
//   wall-0..2     cushion, by speed               (speed×0.4, 160ms cooldown)
//   pocket / game-win / game-lose / game-draw
const COLL_SCALE = 1.0;   // tune by ear: relative impact speed → collision index (Java: √speed)
const WALL_SCALE = 0.4;   // mirrors Java method1530 (index = speed × 0.4)
let replaying = false;    // true during spectator catch-up — suppress the sound flood
const Sound = {
  ctx: null, buffers: {}, ready: false, _cool: {},
  DIR: 'assets/res/APool/sound/',
  NAMES: ['strike-0','strike-1','strike-2','strike-3',
          'collision-0','collision-1','collision-2','collision-3','collision-4',
          'collision-5','collision-6','collision-7','collision-8','collision-9',
          'wall-0','wall-1','wall-2','pocket','game-win','game-lose','game-draw'],
  async load() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      for (const n of this.NAMES) {                    // decode ONE clip at a time (no CPU spike)
        const buf = await (await fetch(this.DIR + n + '.mp3')).arrayBuffer();
        this.buffers[n] = await this.ctx.decodeAudioData(buf);
        await new Promise(r => setTimeout(r, 0));       // yield to the render loop between clips
      }
      this.ready = true;
    } catch (e) { console.warn('audio load failed', e); }
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  _play(name, cooldownMs) {
    if (!soundOn || !this.ready || replaying) return false;
    const b = this.buffers[name]; if (!b) return false;
    const now = performance.now();
    if (cooldownMs && this._cool[name] && now - this._cool[name] < cooldownMs) return false;
    this._cool[name] = now;
    const src = this.ctx.createBufferSource();
    src.buffer = b; src.connect(this.ctx.destination); src.start();
    return true;
  },
  // Neighbour-fallback like Class68/69: if the chosen index is on cooldown, try idx∓1.
  _playIdx(prefix, idx, max, cooldown) {
    if (this._play(`${prefix}-${idx}`, cooldown)) return;
    if (idx - 1 >= 0 && this._play(`${prefix}-${idx - 1}`, cooldown)) return;
    if (idx + 1 <= max) this._play(`${prefix}-${idx + 1}`, cooldown);
  },
  strike(power) { this._play('strike-' + Math.min(3, Math.max(0, Math.floor(power / 26))), 0); },
  collision(speed) { this._playIdx('collision', Math.min(9, Math.max(0, Math.floor(Math.sqrt(speed * COLL_SCALE)))), 9, 330); },
  wall(speed) { this._playIdx('wall', Math.min(2, Math.max(0, Math.floor(speed * WALL_SCALE))), 2, 160); },
  pocket() { this._play('pocket', 0); },
  end(name) { this._play(name, 0); },
};
// Load audio only on the FIRST user gesture (also when the AudioContext may resume), so the
// fetch/decode never competes with the first game's frame rate on a cold page load.
let _audioStarted = false;
window.addEventListener('pointerdown', () => {
  if (!_audioStarted) { _audioStarted = true; Sound.load().then(() => Sound.resume()); }
  else Sound.resume();
});

function loadImg(key, src, isMask) {
  const img = new Image();
  const finish = () => {
    if (isMask) {
      // Draw at the mask's NATIVE size (pool=620×330, snooker=600×330) so the
      // pixel grid matches that mode's TW; maskIs() indexes using the stored width.
      const w = img.naturalWidth || TW, h = img.naturalHeight || TH;
      const oc = document.createElement('canvas');
      oc.width = w; oc.height = h;
      const ox = oc.getContext('2d');
      ox.drawImage(img, 0, 0);
      try {
        const d = ox.getImageData(0, 0, w, h).data;
        // A valid mask has GREEN "play" pixels. If the read came back blank (a cold-load
        // decode race), leave imgs[key] unset → maskIs() uses the geometric fallback. A
        // blank/all-black mask would otherwise classify every cushion as a pocket, so balls
        // would vanish into the rails on the first game until a refresh warms the cache.
        let ok = false;
        for (let i = 0; i < d.length; i += 4) { if (d[i] < 64 && d[i + 1] > 128) { ok = true; break; } }
        if (ok) imgs[key] = { d, w, h };
      } catch (e) {}
    } else {
      imgs[key] = img;
    }
    if (++loaded >= NEED) start();
  };
  img.onerror = () => { if (++loaded >= NEED) start(); };
  // Wait for a real DECODE (not just onload) before reading pixels / first draw — img.decode()
  // guarantees the bitmap is ready, which onload does not.
  img.onload = () => { (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(finish); };
  img.src = src;
}

const P = 'assets/res/APool/picture/game/';
loadImg('table',        P+'pool-table.png');
loadImg('balls',        P+'pool-balls.png');
loadImg('stick0',       P+'pool-stick-0.png');
loadImg('stick1',       P+'pool-stick-1.png');
loadImg('mask',         P+'pool-table-mask.gif',    true);
loadImg('snookerTable', P+'snooker-table.png');
loadImg('snookerBalls', P+'snooker-balls.png');
loadImg('snookerStick0',P+'snooker-stick-0.png');
loadImg('snookerStick1',P+'snooker-stick-1.png');
loadImg('snookerMask',  P+'snooker-table-mask.gif', true);

// ─── MASK / COLLISION GEOMETRY ──────────────────────────────────────────────
// Returns true if pixel at (px,py) matches type: 0=play,1=wall,2=pocket
function maskIs(px, py, type) {
  const ix = Math.round(px), iy = Math.round(py);
  // Central zone: always playfield
  if (iy >= 45 && iy < TH-45 && ix >= 45 && ix < TW-45) return type === 0;
  if (ix < 0 || ix >= TW || iy < 0 || iy >= TH) return type < 0;
  const mask = gameMode === 'snooker' ? imgs.snookerMask : imgs.mask;
  if (!mask) return fallbackMask(px, py, type);
  const i = (iy*mask.w+ix)*4;
  const r=mask.d[i], g=mask.d[i+1], b=mask.d[i+2];
  let t = -1;
  if (r<64 && g<64 && b<64)   t = 2; // black = pocket
  if (r>192 && g<64 && b<64)  t = 1; // red   = wall
  if (r<64 && g>192 && b<64)  t = 0; // green = play
  return t === type;
}

function fallbackMask(px, py, type) {
  // Geometric fallback when mask image is unavailable
  if (type === 2) {
    // Pocket: check distance to known pocket centres
    for (let i=0;i<6;i++){
      const dx=px-PX[i], dy=py-PY[i];
      if (dx*dx+dy*dy <= 13*13) return true;
    }
    return false;
  }
  if (type === 1) {
    // Wall: rectangular boundary, but NOT near pocket openings
    const inPlay = px>=BORDER && px<TW-BORDER && py>=BORDER && py<TH-BORDER;
    if (inPlay) return false;
    for (let i=0;i<6;i++){
      const dx=px-PX[i], dy=py-PY[i];
      if (dx*dx+dy*dy <= 20*20) return false; // pocket area, not a wall
    }
    return true;
  }
  return false;
}

// 8 wall probe points (method2705)
function wallProbes(b) {
  const x=b.x, y=b.y, d=WDIAG;
  return [false,
    maskIs(x-0.5,   y-BALL_R,      1),
    maskIs(x+d-1,   y-d,           1),
    maskIs(x+BALL_R-1, y-0.5,      1),
    maskIs(x+d-1,   y+d-1,         1),
    maskIs(x-0.5,   y+BALL_R-1,    1),
    maskIs(x-d,     y+d-1,         1),
    maskIs(x-BALL_R, y-0.5,        1),
    maskIs(x-d,     y-d,           1)];
}

// 9 pocket probe points (method2707)
function pocketProbes(b) {
  const x=b.x, y=b.y, r=PDET, d=Math.sqrt(r*r/2);
  const p=[
    maskIs(x,   y,   2),
    maskIs(x,   y-r, 2),
    maskIs(x+d, y-d, 2),
    maskIs(x+r, y,   2),
    maskIs(x+d, y+d, 2),
    maskIs(x,   y+r, 2),
    maskIs(x-d, y+d, 2),
    maskIs(x-r, y,   2),
    maskIs(x-d, y-d, 2),
    false];
  p[9]=p[0]||p[1]||p[2]||p[3]||p[4]||p[5]||p[6]||p[7]||p[8];
  return p;
}

// Nearest pocket index by quadrant (method2711)
function nearPocket(x, y) {
  const row = y < TH/2 ? 0 : 1;
  const col = x < TW/3 ? 0 : (x < 2*TW/3 ? 1 : 2);
  return row*3+col;
}

// Filter wall directions (method1499)
function filterWall(wp, vx, vy) {
  const v = wp.slice();
  if(v[8]&&v[1]&&v[2]){v[8]=v[2]=false;}
  if(v[2]&&v[3]&&v[4]){v[2]=v[4]=false;}
  if(v[4]&&v[5]&&v[6]){v[4]=v[6]=false;}
  if(v[6]&&v[7]&&v[8]){v[6]=v[8]=false;}
  if(v[2]) v[2]=vx>0&&vy<0||vx<0&&vy<0&&-vy>-vx||vx>0&&vy>0&&vx>vy;
  if(v[4]) v[4]=vx>0&&vy>0||vx>0&&vy<0&&vx>-vy||vx<0&&vy>0&&vy>-vx;
  if(v[6]) v[6]=vx<0&&vy>0||vx>0&&vy>0&&vy>vx||vx<0&&vy<0&&-vx>-vy;
  if(v[8]) v[8]=vx<0&&vy<0||vx<0&&vy>0&&-vx>vy||vx>0&&vy<0&&-vy>vx;
  if(v[1]) v[1]=vy<0;
  if(v[5]) v[5]=vy>0;
  if(v[3]) v[3]=vx>0;
  if(v[7]) v[7]=vx<0;
  if(v[2]||v[4]||v[6]||v[8]){v[1]=v[3]=v[5]=v[7]=false;}
  return v;
}

// ─── PHYSICS ────────────────────────────────────────────────────────────────

// Elastic collision (Java method2704). The velocity DECOMPOSITION uses the per-iteration
// SNAPSHOT (svx/svy, frozen at the start of the outer iteration); the result is written to
// the LIVE velocities. This is what lets a pack spread instead of chain-collapsing.
function collide(i, j) {
  const a=balls[i], b=balls[j];
  let dx=b.x-a.x, dy=b.y-a.y;
  let dist=Math.sqrt(dx*dx+dy*dy);
  if(dist > BALL_D) return false;
  if(dist===0){dx=0.01;dy=0.01;b.x+=dx;b.y+=dy;dist=Math.sqrt(0.0002);}
  const nx=dx/dist, ny=dy/dist;
  const v1n = a.svx*nx + a.svy*ny;
  const v2n = b.svx*nx + b.svy*ny;
  if(v1n - v2n <= 0) return false;   // moving apart (by snapshot), no collision
  const v1t = -a.svx*ny + a.svy*nx;
  const v2t = -b.svx*ny + b.svy*nx;
  const ms  = a.mass + b.mass;
  const n1  = v1n*(a.mass-b.mass)/ms + v2n*2*b.mass/ms;
  const n2  = v1n*2*a.mass/ms        + v2n*(b.mass-a.mass)/ms;
  a.vx = n1*nx - v1t*ny;  a.vy = n1*ny + v1t*nx;
  b.vx = n2*nx - v2t*ny;  b.vy = n2*ny + v2t*nx;
  return true;
}

// Wall reflection (method1500)
function wallBounce(b, v) {
  if(v[1]||v[5]) b.vy=-b.vy;
  if(v[3]||v[7]) b.vx=-b.vx;
  if(v[2]||v[6]){const t=b.vx; b.vx= b.vy; b.vy= t;}
  if(v[4]||v[8]){const t=b.vx; b.vx=-b.vy; b.vy=-t;}
  b.vx*=WDAMP; b.vy*=WDAMP;
}

// Rolling friction (method1501)
function rollingFric(b) {
  const spd=Math.sqrt(b.vx*b.vx+b.vy*b.vy);
  const f=FRIC+(1-FRIC)*(0.75*spd/10);
  b.vx*=f; b.vy*=f;
}

// Angle of incidence between the ball's path and the cushion it just hit (method1519).
// `walls` is the filtered wall-flag array; returns an angle in [0, PI/2].
function wallIncidence(b, walls) {
  const x=b.x, y=b.y;
  const nx=x+b.vx, ny=y+b.vy;       // projected next position
  let cx=0, cy=0;                    // a point 1px into the contacted cushion
  if(walls[2]||walls[3]||walls[4]) cx=x+1;
  if(walls[6]||walls[7]||walls[8]) cx=x-1;
  if(walls[4]||walls[5]||walls[6]) cy=y+1;
  if(walls[8]||walls[1]||walls[2]) cy=y-1;
  // Slopes of the velocity line and the line to the cushion point (Java uses
  // Double.MIN_VALUE / MAX_VALUE as ±0⁺ / huge sentinels for vertical lines)
  const s1 = (x-nx)===0 ? ((y-ny)<0 ? Number.MIN_VALUE : Number.MAX_VALUE) : (y-ny)/(x-nx);
  const s2 = (x-cx)===0 ? ((y-cy)<0 ? Number.MIN_VALUE : Number.MAX_VALUE) : (y-cy)/(x-cx);
  return s1*s2===-1 ? Math.PI/2 : Math.atan(Math.abs((s1-s2)/(1+s1*s2)));
}

// Side spin (English) on a cushion: rotate the post-bounce velocity by an angle
// proportional to spin × incidence, preserving speed (method1504). `spin` = spinX.
function applySideSpin(b, spin, walls) {
  let ang = b.vx!==0 ? Math.atan(b.vy/b.vx) : (b.vy<0?-1:1)*Math.PI*0.5;
  if(b.vx<0) ang += Math.PI;
  const inc = wallIncidence(b, walls);
  ang -= spin * 0.8975979010256552 * (inc / (Math.PI/2));
  const spd = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
  b.vx = Math.cos(ang) * spd;
  b.vy = Math.sin(ang) * spd;
}

// Check & process pockets
function checkPockets() {
  for(let i=0;i<balls.length;i++){
    const b=balls[i];
    if(!b.active||b.falling) continue;
    const near = b.x-BALL_R<45||b.x+BALL_R>=TW-45||b.y-BALL_R<45||b.y+BALL_R>=TH-45;
    if(!near) continue;
    const pp=pocketProbes(b);
    if(!pp[9]) continue;
    const pi=nearPocket(b.x,b.y);
    // Drift toward pocket centre
    if(b.x < PX[pi]-3) b.x+=0.85;
    if(b.x > PX[pi]+3) b.x-=0.85;
    if(b.y < PY[pi]-3) b.y+=0.85;
    if(b.y > PY[pi]+3) b.y-=0.85;
    if(pp[0]&&!b.falling){
      b.falling=true; b.fp=0.01; b.vx=b.vy=0;
      b.fpx=PX[pi]; b.fpy=PY[pi];
      Sound.pocket();
      if(i===0) cueScratch=true;
      else pocketed.push(i);
    }
  }
}

// Advance pocket fall animation
function advanceFall() {
  for(let i=0;i<balls.length;i++){
    const b=balls[i];
    if(!b.active||!b.falling) continue;
    if(b.fp<PCAPT) b.fp+=0.18;
    if(b.x<b.fpx-3) b.x+=0.85;
    if(b.x>b.fpx+3) b.x-=0.85;
    if(b.y<b.fpy-3) b.y+=0.85;
    if(b.y>b.fpy+3) b.y-=0.85;
  }
}

// Complete stop check (returns true when everything stopped)
function checkStop(gx, gy) {
  if(Math.sqrt(gx*gx+gy*gy) >= STOPV) return false;
  for(let i=0;i<balls.length;i++){
    const b=balls[i];
    if(!b.active) continue;
    if(b.falling && b.fp<PCAPT) return false;
    if(!b.falling && Math.sqrt(b.vx*b.vx+b.vy*b.vy) >= STOPV) return false;
    if(!b.falling && Math.sqrt(b.vx*b.vx+b.vy*b.vy)<STOPV){b.vx=b.vy=0;}
  }
  return true;
}

// Physics driven by rAF – state persists across frames
let physState = null;
const OUTER_PER_FRAME = 5; // outer iterations per frame (= 250 inner steps at 60 fps)

function startPhysics(cx, cy, pwr) {
  const cu = balls[0];
  const dx = cx - cu.x, dy = cy - cu.y;
  const dist = Math.sqrt(dx*dx + dy*dy);
  if (dist < 1) return false;

  // Off-centre hits (spin) put less energy into forward motion.
  // Java method2701: var9 = 1 - sqrt(spinX² + spinY²) * 0.45; strike *= var9
  const spinMag = Math.sqrt(spinX*spinX + spinY*spinY);
  const spinDamp = 1 - spinMag * 0.45;
  const sf = (pwr * STRIKE) / (dist * 100) * spinDamp;
  cu.vx = dx*sf; cu.vy = dy*sf;
  // Only the cue is "activated" at strike; others activate when struck (Java method1505).
  // Also reset per-shot classification flags (bank / combo detection).
  for (let k = 0; k < balls.length; k++) { balls[k].moving = (k === 0); balls[k].banked = false; balls[k].cueStruck = false; }
  Sound.strike(pwr);   // cue strike (strike-0..3 by power)

  firstHit = -1; pocketed = []; cueScratch = false;

  // gx/gy = backspin/topspin force PARALLEL to shot direction (Java method2701 lines 902-903)
  // spinY: panel up = topspin (negative dy → spinY<0 → force forward)
  //        panel down = backspin (positive dy → spinY>0 → force backward)
  // Side spin (spinX) only affects cushion deflection, not continuous force
  physState = {
    gx: -cu.vx * spinY * 0.006,
    gy: -cu.vy * spinY * 0.006,
    sideSpinX: spinX,   // stored for future cushion effect
    cueHit: false,      // flips decay rate once cue ball first hits a ball
    iter: 0,
    MAX: 3000
  };
  return true;
}

// Run OUTER_PER_FRAME outer iterations per call. Returns true when done.
function stepPhysics() {
  if (!physState) return true;

  for (let f = 0; f < OUTER_PER_FRAME; f++) {
    if (physState.iter >= physState.MAX) { physState = null; return true; }

    // Snapshot velocities once per outer iteration (Java method1507). Every collision
    // this iteration resolves from these FROZEN values (method1512/1513) — so momentum
    // spreads through a pack one layer per iteration instead of chaining instantly
    // forward through it. This is what gives a break its natural spread.
    for (let i = 0; i < balls.length; i++) { balls[i].svx = balls[i].vx; balls[i].svy = balls[i].vy; }

    // ── 50 inner steps ──────────────────────────────────────────────────
    for (let s = 0; s < STEPS; s++) {
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (!b.active || b.falling) continue;
        // Read physState directly so wall-hit halvings apply mid-iteration (matches Java var12/14)
        if (i === 0) { b.vx += physState.gx/STEPS; b.vy += physState.gy/STEPS; }
        b.x += b.vx/STEPS; b.y += b.vy/STEPS;
      }

      // Ball-ball collisions
      for (let i = 0; i < balls.length - 1; i++) {
        const a = balls[i];
        if (!a.active || a.falling) continue;
        for (let j = i+1; j < balls.length; j++) {
          const b = balls[j];
          if (!b.active || b.falling) continue;
          if (!a.moving && !b.moving) continue;   // only an already-struck ball initiates (method1509)
          const relSpeed = Math.hypot(a.vx - b.vx, a.vy - b.vy);   // impact speed (pre-collision)
          if (collide(i, j)) {
            a.vx *= ITFRIC; a.vy *= ITFRIC;
            b.vx *= ITFRIC; b.vy *= ITFRIC;
            a.moving = b.moving = true;            // both become active (method1508)
            if (i === 0) b.cueStruck = true;       // direct cue contact (else a combo)
            if (j === 0) a.cueStruck = true;
            Sound.collision(relSpeed);
            if (firstHit === -1 && (i === 0 || j === 0)) {
              firstHit = (i === 0) ? j : i;
              physState.cueHit = true;
            }
          }
        }
      }

      // Wall collisions
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (!b.active || b.falling) continue;
        const nb = b.x-BALL_R<45 || b.x+BALL_R>=TW-45 || b.y-BALL_R<45 || b.y+BALL_R>=TH-45;
        if (!nb) continue;
        const wp = wallProbes(b);
        const rv = filterWall(wp, b.vx, b.vy);
        if (rv[1]||rv[2]||rv[3]||rv[4]||rv[5]||rv[6]||rv[7]||rv[8]) {
          Sound.wall(Math.hypot(b.vx, b.vy));   // cushion hit (wall-0..2 by speed)
          b.banked = true;                       // touched a cushion → eligible as a bank shot
          wallBounce(b, rv);
          if (i === 0) {
            // Topspin/backspin force halved on each cushion hit (Java line 971-972)
            physState.gx *= 0.5; physState.gy *= 0.5;
            // Side spin (English): rotate post-bounce velocity (Java line 973-977)
            if (Math.abs(physState.sideSpinX) >= 0.01) {
              applySideSpin(b, physState.sideSpinX, rv);
            }
            physState.sideSpinX *= 0.3;  // English mostly spent on each cushion
          }
        }
      }
    }
    // ── end inner steps ─────────────────────────────────────────────────

    // Rolling friction
    for (let i = 0; i < balls.length; i++) {
      if (balls[i].active && !balls[i].falling) rollingFric(balls[i]);
    }
    // Top/back-spin force decay: slow before cue hits a ball, faster after (Java lines 991-996)
    const spinDecay = physState.cueHit ? 0.988 : 0.9989;
    physState.gx *= spinDecay; physState.gy *= spinDecay;
    // Side spin (English) bleeds off continuously too (Java line 998: aDouble4169 *= 0.999)
    physState.sideSpinX *= 0.999;
    // Zero spin if cue ball is pocketed
    if (balls[0].falling) { physState.gx = 0; physState.gy = 0; }

    checkPockets();
    advanceFall();
    physState.iter++;

    if (checkStop(physState.gx, physState.gy)) { physState = null; return true; }
  }
  return false; // still running
}

// ─── GAME SETUP ─────────────────────────────────────────────────────────────
function mkBall(id){
  return {id,x:0,y:0,vx:0,vy:0,
          svx:0,svy:0,            // per-iteration velocity snapshot (Java method1507)
          moving:false,           // "activated" — has been struck this shot (Java aBoolean1243)
          banked:false,           // hit a cushion this shot (→ bank-shot classification)
          cueStruck:false,        // struck DIRECTLY by the cue this shot (else combo)
          mass:id===0?1.2:1.0, active:false,
          falling:false,fp:0,fpx:0,fpy:0};
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function rack9ball() {
  for (let i = 10; i <= 15; i++) balls[i].active = false;
  const others = shuffle([2,3,4,5,6,7,8]);
  const pos = rackPositions(9);
  // 1 at apex (pos[0]), 9 at center (pos[4]), rest random
  const layout = [1, others[0], others[1], others[2], 9, others[3], others[4], others[5], others[6]];
  layout.forEach((id, i) => {
    const b = balls[id];
    b.x = pos[i].x; b.y = pos[i].y;
    b.vx = b.vy = 0; b.active = true; b.falling = false; b.fp = 0;
  });
}

function rack10ball() {
  for (let i = 11; i <= 15; i++) balls[i].active = false;
  const others = shuffle([2,3,4,5,6,7,8,9]);
  const pos = rackPositions(10);
  // 1 at apex (pos[0]), 10 at center (pos[5]), rest random
  const layout = [1, others[0], others[1], others[2], others[3], 10, others[4], others[5], others[6], others[7]];
  layout.forEach((id, i) => {
    const b = balls[id];
    b.x = pos[i].x; b.y = pos[i].y;
    b.vx = b.vy = 0; b.active = true; b.falling = false; b.fp = 0;
  });
}

function rackSnooker() {
  // Reds triangle — exact math from SPanel_Sub32_Sub2.method2657()
  const gap = 0.4;                       // var13
  const side = BALL_D + gap;             // var15 = 12.4
  const half = BALL_R + gap * 0.5;       // var17 = 6.2
  const rowDx = Math.sqrt(side*side - half*half); // var19 ≈ 10.739 (row x-spacing)
  let id = 1;
  let rx = 449.0;                        // var23 (apex x = pink 435 + 2 + 12)
  for (let row = 0; row < 5; row++) {
    const n = row + 1;
    let y = 165.0 - Math.floor((n-1)/2) * BALL_D - (n/2) * gap; // var26
    if (n % 2 === 0) y -= BALL_R;
    for (let col = 0; col < n; col++) {
      const b = balls[id++];
      b.x = rx; b.y = y;
      b.vx = b.vy = 0; b.active = true; b.falling = false; b.fp = 0;
      y += side;
    }
    rx += rowDx;
  }
  // Colour balls at their spots
  for (let cid = 16; cid <= 21; cid++) {
    const sp = SNOOKER_SPOTS[cid];
    balls[cid].x = sp.x; balls[cid].y = sp.y;
    balls[cid].vx = balls[cid].vy = 0; balls[cid].active = true;
    balls[cid].falling = false; balls[cid].fp = 0;
  }
}

// Is (x,y) clear of every active ball except `id`? (within one ball diameter)
function snookerSpotClear(id, x, y) {
  for (const b of balls) {
    if (!b.active || b.id === id) continue;
    if (Math.hypot(b.x - x, b.y - y) < BALL_D) return false;
  }
  return true;
}
function tryPlaceSnooker(id, x, y) {
  if (!snookerSpotClear(id, x, y)) return false;
  balls[id].x = x; balls[id].y = y; balls[id].vx = balls[id].vy = 0;
  balls[id].active = true; balls[id].falling = false; balls[id].fp = 0;
  return true;
}
// After a turn ends (miss/foul), the next ball-on is a red if any remain,
// otherwise the lowest-value colour still on the table (endgame).
function snookerResetPhase() {
  const redsLeft = balls.slice(1, 16).filter(b => b.active).length;
  if (redsLeft > 0) {
    snookerPhase = 'red';
  } else {
    snookerPhase = 'endgame';
    snookerEndColorIdx = 0;
    while (snookerEndColorIdx < 6 && !balls[16 + snookerEndColorIdx].active) snookerEndColorIdx++;
  }
}

// Re-spot a potted colour — mirrors method2679/method2730:
// own spot → highest free colour spot → nudge up-table → nudge down-table.
function respotSnookerBall(id) {
  const sp = SNOOKER_SPOTS[id];
  if (!sp) return;
  if (tryPlaceSnooker(id, sp.x, sp.y)) return;
  for (let s = 21; s >= 16; s--) {
    const o = SNOOKER_SPOTS[s];
    if (tryPlaceSnooker(id, o.x, o.y)) return;
  }
  for (let x = sp.x + 1; x < 562; x++) if (tryPlaceSnooker(id, x, sp.y)) return;
  for (let x = sp.x - 1; x > BORDER + BALL_R; x--) if (tryPlaceSnooker(id, x, sp.y)) return;
}

// Foot/"8-ball" spot — centre of the rack (where the 8 sits). Balls picked up after a
// foul are re-spotted here, or to the nearest free spot if it's occupied (Aapeli rule).
const POOL_FOOT_X = 481, POOL_FOOT_Y = 165;
function respotPool(id){
  const b = balls[id];
  const fits = (x,y) => {
    if(x < BORDER+BALL_R || x > TW-BORDER-BALL_R || y < BORDER+BALL_R || y > TH-BORDER-BALL_R) return false;
    for(let i=0;i<balls.length;i++){
      if(i===id || !balls[i].active || balls[i].falling) continue;
      const dx=balls[i].x-x, dy=balls[i].y-y;
      if(dx*dx+dy*dy < BALL_D*BALL_D) return false;
    }
    return true;
  };
  let x=POOL_FOOT_X, y=POOL_FOOT_Y;
  if(!fits(x,y)){                       // occupied → spiral outward to the first free spot
    outer: for(let r=BALL_D; r<240; r+=4){
      for(let a=0;a<360;a+=15){
        const tx=POOL_FOOT_X+r*Math.cos(a*Math.PI/180), ty=POOL_FOOT_Y+r*Math.sin(a*Math.PI/180);
        if(fits(tx,ty)){ x=tx; y=ty; break outer; }
      }
    }
  }
  b.x=x; b.y=y; b.vx=b.vy=0; b.active=true; b.falling=false; b.fp=0;
}

function resetGame(mode){
  if(mode) gameMode=mode;
  setGeometry(gameMode);   // swap table size / ball size / pockets for snooker vs pool
  const ballCount = gameMode==='snooker' ? 22 : 16;
  balls=Array.from({length:ballCount},(_,i)=>mkBall(i));
  curP=0; group=[-1,-1]; winner=-1; freeBall=false;
  if(gameMode==='count'){ countPoints=0; countShots=0; }
  if(gameMode==='jatkumo'){ jatkumoStreak=0; jatkumoShots=0; }
  if(gameMode==='9ball'||gameMode==='10ball'){ countShots=0; }
  if(gameMode==='snooker'){
    snookerBreak=0; snookerScore=0; snookerShots=0;
    snookerPhase='red'; snookerEndColorIdx=0;
    rackSnooker();
  } else if(gameMode==='9ball') rack9ball();
  else if(gameMode==='10ball') rack10ball();
  else rack();
  // Cue ball starts inactive — player places it
  balls[0].active=false;
  gState=S.PLACE;
  updateUI();
}

// Seeded PRNG (mulberry32) for deterministic online rack
function mkRng(seed) {
  return () => { seed|=0; seed=seed+0x6D2B79F5|0; let t=Math.imul(seed^seed>>>15,1|seed); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; };
}

function rackSeeded(seed) {
  const rng = mkRng(seed);
  const pool=[1,2,3,4,5,6,7,9,10,11,12,13,14,15];
  for(let i=pool.length-1;i>0;i--){
    const j=Math.floor(rng()*(i+1));
    [pool[i],pool[j]]=[pool[j],pool[i]];
  }
  const layout=[
    [pool[0]],
    [pool[1], pool[2]],
    [pool[3], 8,       pool[4]],
    [pool[5], pool[6], pool[7], pool[8]],
    [pool[9], pool[10],pool[11],pool[12],pool[13]]
  ];
  for(let row=0;row<5;row++){
    const n=row+1;
    const rx=445+row*(ROWSP+0.9);
    let ry=(165-(Math.floor((n-1)/2)*20))-(n/2)*0.9;
    if(n%2===0) ry-=10;
    for(let col=0;col<n;col++){
      const id=layout[row][col];
      const b=balls[id];
      b.x=rx; b.y=ry+col*20.9;
      b.vx=b.vy=0; b.active=true; b.falling=false; b.fp=0;
    }
  }
}

function rack(){
  // Shuffle 1-15, 8-ball fixed to center of row 3
  const pool=[1,2,3,4,5,6,7,9,10,11,12,13,14,15];
  for(let i=pool.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [pool[i],pool[j]]=[pool[j],pool[i]];
  }
  // Make sure corners of row5 are one solid, one stripe
  // row5 positions [0] and [4]: ensure one <=7 and one >=9
  // (simplified: just shuffle and trust it)

  const layout=[
    [pool[0]],
    [pool[1], pool[2]],
    [pool[3], 8,       pool[4]],
    [pool[5], pool[6], pool[7], pool[8]],
    [pool[9], pool[10],pool[11],pool[12],pool[13]]
  ];

  for(let row=0;row<5;row++){
    const n=row+1;
    const rx=445+row*(ROWSP+0.9);
    // method2657 startY formula
    let ry=(165-(Math.floor((n-1)/2)*20))-(n/2)*0.9;
    if(n%2===0) ry-=10;
    for(let col=0;col<n;col++){
      const id=layout[row][col];
      const b=balls[id];
      b.x=rx; b.y=ry+col*20.9;
      b.vx=b.vy=0; b.active=true; b.falling=false; b.fp=0;
    }
  }
}

// Generate up to 15 rack positions in triangle order (apex first)
function rackPositions(count) {
  const pos = [];
  for (let row = 0; row < 5 && pos.length < count; row++) {
    const n   = row + 1;
    const rx  = 445 + row * (ROWSP + 0.9);
    let   ry  = (165 - (Math.floor((n-1)/2) * 20)) - (n/2) * 0.9;
    if (n % 2 === 0) ry -= 10;
    for (let col = 0; col < n && pos.length < count; col++) {
      pos.push({ x: rx, y: ry + col * 20.9 });
    }
  }
  return pos;
}

// Re-rack (Pussitus / Jatkumo):
//   • ONE ball left (`lastBall`): it STAYS exactly where it is; the other 14 re-rack into
//     the triangle WITHOUT the apex (top slot left empty).
//   • ALL potted (`lastBall` null): all 15 re-rack into the full triangle (apex filled).
function checkRerack(lastBall, status) {
  const pos = rackPositions(15);   // pos[0] = apex (top), pos[1..14] = the rest

  if (lastBall) {
    const others = balls.slice(1).filter(b => b.id !== lastBall.id);   // the 14 non-remaining balls
    others.forEach((b, i) => {
      b.x = pos[i + 1].x; b.y = pos[i + 1].y;     // fill pos[1..14]; apex pos[0] stays empty
      b.vx = b.vy = 0; b.falling = false; b.fp = 0; b.active = true;
    });
    // lastBall keeps its current position (already active where it stopped)
  } else {
    balls.slice(1).forEach((b, i) => {            // full re-rack: all 15 into pos[0..14]
      b.x = pos[i].x; b.y = pos[i].y;
      b.vx = b.vy = 0; b.falling = false; b.fp = 0; b.active = true;
    });
  }

  pocketed = []; firstHit = -1; cueScratch = false;

  // If the cue stopped inside the rack footprint it would be buried — hand it back.
  const inZone = b => b.x >= RACK_ZONE.x1 && b.x <= RACK_ZONE.x2 &&
                      b.y >= RACK_ZONE.y1 && b.y <= RACK_ZONE.y2;
  const cueInZone = balls[0].active && inZone(balls[0]);
  const info = status || `${countPoints}/${countTarget} pts · ${countShots} shots`;
  if (cueInZone) {
    balls[0].active = false;
    freeBall = true;
    gState = S.PLACE;
    showMsg(`Re-rack! Ball in hand — ${info}`, 2000);
  } else {
    gState = balls[0].active ? S.AIM : S.PLACE;
    showMsg(`Re-rack! ${info}`, 2000);
  }
  updateUI();
}

// End a Jatkumo run: persist the best streak and show the result.
function endJatkumo(reason){
  if(jatkumoStreak > jatkumoBest){
    jatkumoBest = jatkumoStreak;
    try { localStorage.setItem('pool-jatkumo-best', jatkumoBest); } catch(_){}
  }
  pocketed=[]; firstHit=-1; cueScratch=false;
  winner=0; gState=S.DONE; updateUI();
  showGameOver(`${reason} Streak ended.`,
    `Streak: ${jatkumoStreak}  ·  Best: ${jatkumoBest}  ·  ${jatkumoShots} shot${jatkumoShots===1?'':'s'}`);
}

// ─── 8-BALL RULES ───────────────────────────────────────────────────────────
function endTurn(){
  if(winner>=0) return;

  // 9-ball / 10-ball (Rotaatiopussitus): hit the lowest ball first; pocket the 9/10 to win.
  if(gameMode==='9ball' || gameMode==='10ball'){
    const targetBall = gameMode==='9ball' ? 9 : 10;
    countShots++;

    // The "ball on" is the lowest number that was on the table AT THE START of this shot —
    // include balls potted this shot (they were active when struck). Computing it from the
    // post-shot active set falsely fouls you for legally potting the on-ball.
    const onNow = balls.slice(1, targetBall+1).filter(b => b.active).map(b => b.id);
    const pottedLow = pocketed.filter(id => id >= 1 && id <= targetBall);
    const lowestOn = Math.min(...onNow, ...pottedLow, Infinity);

    // Foul: scratch, no contact, or hit something other than the on-ball first.
    const foul = cueScratch || firstHit === -1 || firstHit !== lowestOn;

    if(foul){
      for(const id of pocketed) if(id >= 1) respotPool(id);   // foul + pot → ball goes back
      const reason = cueScratch ? 'Scratch!'
        : firstHit === -1 ? 'No contact — foul!'
        : `Must hit the ${lowestOn}-ball first — foul!`;
      showMsg(`${reason} Ball in hand.`, 2500);
      freeBall=true; balls[0].active=false;
      firstHit=-1; pocketed=[]; cueScratch=false;
      gState=S.PLACE; updateUI(); return;
    }

    // Legal shot — win if the target ball dropped (directly or on a combination).
    if(pocketed.includes(targetBall)){
      gState=S.DONE; winner=0;
      updateUI();
      showGameOver(
        gameMode==='9ball' ? '9-Ball Cleared!' : '10-Ball Cleared!',
        `Finished in ${countShots} shot${countShots===1?'':'s'}`
      );
      return;
    }

    firstHit=-1; pocketed=[]; cueScratch=false;
    gState=S.AIM;
    updateUI(); return;
  }

  // ─── SNOOKER ───────────────────────────────────────────────────────────────
  if(gameMode==='snooker'){
    snookerShots++;
    const pottedReds   = pocketed.filter(id=>id>=1&&id<=15);
    const pottedColors = pocketed.filter(id=>id>=16&&id<=21);

    // Foul detection
    let foul=false, foulMsg='';
    if(firstHit===-1){
      foul=true; foulMsg='No contact — foul!';
    } else if(cueScratch){
      foul=true; foulMsg='Scratch — foul!';
    } else if(snookerPhase==='red' && (firstHit<1||firstHit>15)){
      foul=true; foulMsg='Must hit a red first!';
    } else if(snookerPhase==='color' && (firstHit<16||firstHit>21)){
      foul=true; foulMsg='Must hit a colour ball first!';
    } else if(snookerPhase==='endgame'){
      const need=16+snookerEndColorIdx;
      if(firstHit!==need) { foul=true; foulMsg=`Must hit ${SNKNAM[need]} first!`; }
    }

    if(foul){
      snookerBreak=0;
      snookerResetPhase();
      firstHit=-1; pocketed=[]; cueScratch=false;
      freeBall=true; balls[0].active=false;
      showMsg(`Foul! ${foulMsg} Break reset.`, 2500);
      gState=S.PLACE; updateUI(); return;
    }

    // Score & phase logic
    let pts=0;
    if(snookerPhase==='red'){
      pts=pottedReds.length;
      // Re-spot any colours accidentally potted
      for(const id of pottedColors) respotSnookerBall(id);
      if(pottedReds.length>0) snookerPhase='color';
    } else if(snookerPhase==='color'){
      if(pottedColors.length>0){
        const id=pottedColors[0]; pts=SNKVAL[id];
        // Re-spot any extra colours potted
        for(const id2 of pottedColors.slice(1)) respotSnookerBall(id2);
        const redsLeft=balls.slice(1,16).filter(b=>b.active).length;
        if(redsLeft>0){
          respotSnookerBall(id);  // re-spot the potted colour
          snookerPhase='red';
        } else {
          // Last red already gone — don't re-spot; start endgame from first remaining colour
          snookerPhase='endgame'; snookerEndColorIdx=0;
          while(snookerEndColorIdx<6 && !balls[16+snookerEndColorIdx].active) snookerEndColorIdx++;
        }
      } else {
        // Missed colour — turn over; next ball-on reverts to a red (or endgame)
        snookerBreak=0;
        snookerResetPhase();
      }
    } else { // endgame
      const need=16+snookerEndColorIdx;
      if(pottedColors.includes(need)){
        pts=SNKVAL[need];
        snookerEndColorIdx++;
        while(snookerEndColorIdx<6 && !balls[16+snookerEndColorIdx].active) snookerEndColorIdx++;
        if(snookerEndColorIdx>=6){
          // All colours potted — game over
          snookerBreak+=pts; snookerScore+=pts;
          firstHit=-1; pocketed=[]; cueScratch=false;
          gState=S.DONE; updateUI();
          showGameOver('Snooker Cleared!',
            `Break: ${snookerBreak}  ·  Total: ${snookerScore}  ·  ${snookerShots} shots`);
          return;
        }
      } else {
        // Didn't pot the right colour — turn over
        snookerBreak=0;
      }
    }

    snookerBreak+=pts; snookerScore+=pts;
    const continueTurn=pts>0;
    if(!continueTurn) snookerBreak=0;
    firstHit=-1; pocketed=[]; cueScratch=false;
    gState=balls[0].active?S.AIM:S.PLACE;
    updateUI(); return;
  }

  // Practice: no rules — if cue ball pocketed, player places it anywhere (ball-in-hand)
  if(gameMode==='practice'){
    firstHit=-1; pocketed=[]; cueScratch=false;
    if(!balls[0].active){
      freeBall=true;           // allow placement anywhere (no head-string restriction)
      balls[0].active=false;
      gState=S.PLACE;
    } else {
      gState=S.AIM;
    }
    updateUI(); return;
  }

  // Count mode (Pussitus) — pot as many as possible in the fewest shots. Foul (scratch):
  // any ball potted on the foul is picked back up onto the foot spot, not scored, −1 pt.
  if(gameMode==='count'){
    countShots++;
    if(cueScratch){
      for(const id of pocketed) if(id >= 1) respotPool(id);   // foul + pot → ball returns
      countPoints = Math.max(0, countPoints - 1);
      balls[0].active=false; freeBall=true;
      showMsg(`Scratch! -1 pt — ${countPoints}/${countTarget}`, 1800);
      pocketed=[]; firstHit=-1; cueScratch=false;
      gState=S.PLACE; updateUI(); return;
    }

    countPoints += pocketed.length;

    // Win: reached target
    if(countPoints >= countTarget){
      gState=S.DONE;
      updateUI();
      showGameOver(`${countTarget} pts reached!`, `Finished in ${countShots} shots`);
      return;
    }

    // Re-rack when 1 ball remains (it stays, 14 re-rack apex-empty) or all are potted (full rack).
    const remaining=balls.slice(1).filter(b=>b.active);
    if(remaining.length<=1){
      checkRerack(remaining.length===1 ? remaining[0] : null);
      return;
    }

    pocketed=[]; firstHit=-1; cueScratch=false;
    gState=balls[0].active?S.AIM:S.PLACE;
    updateUI(); return;
  }

  // Jatkumo (streak) — every shot must legally pot a ball; a miss or scratch ends the run.
  if(gameMode==='jatkumo'){
    jatkumoShots++;
    if(cueScratch){
      for(const id of pocketed) if(id>=1) respotPool(id);   // foul + pot → ball returns
      endJatkumo('Scratch — foul!'); return;
    }
    if(pocketed.length===0){ endJatkumo('Missed!'); return; }
    jatkumoStreak += pocketed.length;
    const remaining=balls.slice(1).filter(b=>b.active);
    if(remaining.length<=1){                               // table runs low → re-rack to keep going
      checkRerack(remaining.length===1 ? remaining[0] : null, `Streak: ${jatkumoStreak}`);
      return;
    }
    pocketed=[]; firstHit=-1; cueScratch=false;
    gState=balls[0].active?S.AIM:S.PLACE;
    updateUI(); return;
  }

  const eightPocketed = pocketed.includes(8);

  // Assign groups on first pocket (if unassigned)
  if(group[0]===-1 && pocketed.length>0 && !eightPocketed){
    const fid=pocketed.find(id=>id!==8);
    if(fid){
      const g=fid<=7?0:1;
      group[curP]=g; group[1-curP]=1-g;
    }
  }

  // Determine if first contact was legal
  let foul=false;
  if(firstHit===-1){
    foul=true; // miss or no hit
  } else if(group[curP]!==-1){
    const myG=group[curP];
    const myBalls=myG===0?[1,2,3,4,5,6,7]:[9,10,11,12,13,14,15];
    const allMyGone=myBalls.every(id=>!balls[id].active && !pocketed.includes(id));
    if(allMyGone){
      if(firstHit!==8) foul=true;
    } else {
      const hit8=(firstHit===8);
      const hitMine=myG===0?(firstHit>=1&&firstHit<=7):(firstHit>=9&&firstHit<=15);
      if(!hitMine&&!hit8) foul=true;
    }
  }

  // 8-ball pocketed
  if(eightPocketed){
    const myG=group[curP];
    const myBalls=myG===-1?[]:myG===0?[1,2,3,4,5,6,7]:[9,10,11,12,13,14,15];
    const allGone=myBalls.every(id=>!balls[id].active);
    if(!allGone||foul||cueScratch){
      winner=1-curP;
      showMsg(`${displayName(winner)} wins!`,3000);
      showGameOver(displayName(winner) + ' Wins!', displayName(curP) + ' pocketed the 8-ball illegally');
    } else {
      winner=curP;
      showMsg(`${displayName(winner)} wins!`,3000);
      showGameOver(displayName(winner) + ' Wins!', 'The 8-ball was potted legally');
    }
    gState=S.DONE; updateUI(); return;
  }

  if(cueScratch){
    const np=1-curP;
    freeBall=true;
    showMsg(`Scratch! P${np+1} places ball anywhere.`,2000);
    balls[0].active=false;
    curP=np; gState=S.PLACE; updateUI(); return;
  }

  if(foul){
    const np=1-curP;
    freeBall=true;
    showMsg(`Foul! P${np+1} gets ball in hand.`,2000);
    balls[0].active=false;
    curP=np; gState=S.PLACE; updateUI(); return;
  }

  // Count pocketed own balls (to decide if turn continues)
  let ownPocketed=false;
  if(group[curP]!==-1){
    const myG=group[curP];
    for(const id of pocketed){
      if(id===8) continue;
      if(myG===0&&id>=1&&id<=7) ownPocketed=true;
      if(myG===1&&id>=9&&id<=15) ownPocketed=true;
    }
  } else {
    ownPocketed=pocketed.length>0;
  }

  if(!ownPocketed){
    curP=1-curP;
  }

  gState=balls[0].active?S.AIM:S.PLACE;
  updateUI();
}

// ─── RENDERING ──────────────────────────────────────────────────────────────
const canvas=document.getElementById('gc');
const ctx=canvas.getContext('2d');

// Ball colors for fallback rendering
const BCLR=['#fff','#f5d800','#0050c8','#e00','#6a0','#f80','#6600aa','#8B0000','#222',
            '#f5d800','#0050c8','#e00','#6a0','#f80','#6600aa','#222','#888'];

// Snooker ball colours (ids 16-21: yellow, green, brown, blue, pink, black)
const SNKCLR = ['#e8d84a','#1a8a1a','#7B3F00','#0044dd','#ff8faf','#111111'];
const SNKVAL = [0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,2,3,4,5,6,7];
const SNKNAM = ['','','','','','','','','','','','','','','','',
                'Yellow','Green','Brown','Blue','Pink','Black'];
// Colour ball spots — exact values from SPanel_Sub32_Sub2.method2657()
const SNOOKER_SPOTS = {
  16:{x:138.79715691634772, y:208.12910284463896}, // yellow (baulk, bottom)
  17:{x:138.79715691634772, y:121.87089715536105}, // green  (baulk, top)
  18:{x:138.79715691634772, y:165.0},              // brown  (baulk centre)
  19:{x:300.0, y:165.0},                            // blue   (centre spot)
  20:{x:435.0, y:165.0},                            // pink   (pyramid spot)
  21:{x:524.0896664844178, y:165.0},                // black
};

function drawBall(id,x,y,alpha=1,scale=1){
  ctx.save();
  ctx.globalAlpha=alpha;
  const isSnooker = gameMode==='snooker';
  if(isSnooker && imgs.snookerBalls){
    // 8-frame sprite: 0=cue, 1=red, 2=yellow, 3=green, 4=brown, 5=blue, 6=pink, 7=black
    const frame = id===0 ? 0 : (id<=15 ? 1 : id-14);
    const iw=imgs.snookerBalls.width, ih=imgs.snookerBalls.height;
    const sw=iw/8;
    ctx.drawImage(imgs.snookerBalls, frame*sw,0,sw,ih, x-BALL_R*scale,y-BALL_R*scale,BALL_D*scale,BALL_D*scale);
    ctx.restore(); return;
  }
  const useSprite = imgs.balls && id < 16;
  if(useSprite){
    const iw=imgs.balls.width, ih=imgs.balls.height;
    const sw=iw/16;
    ctx.drawImage(imgs.balls, id*sw,0,sw,ih, x-BALL_R*scale,y-BALL_R*scale,BALL_D*scale,BALL_D*scale);
  } else {
    let col;
    if(id===0)           col='#e8e8e8';          // cue ball
    else if(id<=15)      col=isSnooker?'#cc1111':(BCLR[id]||'#888'); // red in snooker
    else                 col=SNKCLR[id-16];       // snooker colour ball
    ctx.beginPath();
    ctx.arc(x,y,BALL_R*scale,0,Math.PI*2);
    ctx.fillStyle=col; ctx.fill();
    // Highlight sheen
    ctx.beginPath();
    ctx.arc(x-BALL_R*scale*0.28,y-BALL_R*scale*0.28,BALL_R*scale*0.38,0,Math.PI*2);
    ctx.fillStyle='rgba(255,255,255,0.22)'; ctx.fill();
    ctx.beginPath();
    ctx.arc(x,y,BALL_R*scale,0,Math.PI*2);
    ctx.strokeStyle='rgba(0,0,0,0.35)';ctx.lineWidth=1;ctx.stroke();
    // Label
    if(id>0){
      let label='', textCol='#fff';
      if(isSnooker && id<=15)      { label=''; }           // reds: no number
      else if(id>=16)              { label=String(SNKVAL[id]); if(id===21||id===17)textCol='#ddd'; }
      else                         { label=String(id); }
      if(label){
        ctx.fillStyle=textCol;
        ctx.font=`bold ${Math.round(7*scale)}px Arial`;
        ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText(label,x,y);
      }
    }
  }
  ctx.restore();
}

function drawTable(){
  const timg = gameMode==='snooker' ? (imgs.snookerTable||imgs.table) : imgs.table;
  if(timg){
    ctx.drawImage(timg,0,0,TW,TH);
  } else {
    ctx.fillStyle='#1a7a1a'; ctx.fillRect(0,0,TW,TH);
    ctx.strokeStyle='#5a2d00'; ctx.lineWidth=30;
    ctx.strokeRect(15,15,TW-30,TH-30);
    for(let i=0;i<6;i++){
      ctx.beginPath(); ctx.arc(PX[i],PY[i],14,0,Math.PI*2);
      ctx.fillStyle='#000'; ctx.fill();
    }
  }
}

function drawBalls(){
  for(let i=0;i<balls.length;i++){
    const b=balls[i];
    if(!b||!b.active) continue;
    if(b.falling){
      const prog=Math.min(b.fp/PCAPT,1);
      drawBall(i,b.x,b.y,1-prog*0.8,1-prog*0.85);
    } else {
      drawBall(i,b.x,b.y);
    }
  }
}

// Ray-cast aim direction to table boundary (ball-center boundary = BORDER+BALL_R)
function aimLineEnd(sx, sy, dx, dy) {
  const L = BORDER + BALL_R, R = TW - BORDER - BALL_R;
  const T = BORDER + BALL_R, B = TH  - BORDER - BALL_R;
  let t = 2000;
  if (dx < 0 && sx > L) t = Math.min(t, (L - sx) / dx);
  if (dx > 0 && sx < R) t = Math.min(t, (R - sx) / dx);
  if (dy < 0 && sy > T) t = Math.min(t, (T - sy) / dy);
  if (dy > 0 && sy < B) t = Math.min(t, (B - sy) / dy);
  return [sx + dx * t, sy + dy * t];
}

// ─── AIM ASSIST / GUIDE (CHEAT MODE) ────────────────────────────────────────
let cheatMode = false;
let aimRailBounces = 2;        // max rail bounces drawn on the guide lines (prepared for X; start at 2)
// Assist (aim-lock cheat) modes, increasing help:
//   0 OFF · 1 Magnet (pot the ball nearest your aim) · 2 Best Shot (easiest pot anywhere)
//   3 Combo (2-ball combination) · 4 Bank (one-rail pot when no direct line)
let assistMode = 0;
let assistChain = null;        // extra geometry to draw for combo/bank shots
const ASSIST_NAMES  = ['OFF', 'Magnet', 'Best Shot', 'Combo', 'Bank'];
const ASSIST_ASSETS = [null, 'magnet', 'best', 'combo', 'bank'];   // index → store asset id

// Assists are PRACTICE-ONLY for now (online/hotseat stay clean & fair).
function assistsAllowed() { return gameMode !== 'online' && gameMode !== 'hotseat'; }
// You may use an asset only if you own it (dev fallback: allow all if no progression layer).
function assetOwned(id) { return !id || !window.Progression || window.Progression.owns(id); }

function toggleCheat() {
  cheatMode = !cheatMode;
  const btn = document.getElementById('cheatBtn');
  if (btn) {
    btn.textContent = cheatMode ? '◓ Guide ON' : '◓ Guide OFF';
    btn.style.color  = cheatMode ? '#4ad8f8' : '#7ab';
    btn.style.borderColor = cheatMode ? '#2aace0' : '#1e4060';
  }
}

function cycleAssist() {
  const btn = document.getElementById('assistBtn');
  if (!assistsAllowed()) {                          // practice-only
    assistMode = 0;
    if (btn) { btn.textContent = '🧲 N/A (practice only)'; btn.style.color = '#7ab'; btn.style.borderColor = '#1e4060'; }
    return;
  }
  // Advance to the next OWNED mode (skip assets you haven't bought).
  let next = assistMode;
  for (let k = 0; k < ASSIST_NAMES.length; k++) {
    next = (next + 1) % ASSIST_NAMES.length;
    if (next === 0 || assetOwned(ASSIST_ASSETS[next])) break;
  }
  assistMode = next;
  if (assistMode && !cheatMode) toggleCheat();       // show the guide so the lock is visible
  if (btn) {
    btn.textContent = '🧲 ' + ASSIST_NAMES[assistMode];
    btn.style.color = assistMode ? '#ff9ad0' : '#7ab';
    btn.style.borderColor = assistMode ? '#e060a0' : '#1e4060';
  }
}

// ─── PROGRESSION UI (tokens / toast / store) ─────────────────────────────────
function updateTokenHUD() {
  const el = document.getElementById('tokenHUD');
  if (el && window.Progression) el.textContent = window.Progression.getTokens();
}

function showProgressToast(earned) {
  if (!earned || (!earned.tokens && !earned.badges.length)) return;
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div'); host.id = 'toast-host';
    host.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:300;display:flex;flex-direction:column;gap:6px;align-items:flex-end;pointer-events:none';
    document.body.appendChild(host);
  }
  const lines = earned.badges.map(b => `🏅 ${b.name}!`);
  if (earned.tokens) lines.push(`🎟️ +${earned.tokens} tokens`);
  const t = document.createElement('div');
  t.style.cssText = 'background:rgba(10,30,16,.95);border:1px solid #2f7a36;border-radius:8px;color:#cfe;padding:8px 12px;font:12px Arial;box-shadow:0 6px 20px rgba(0,0,0,.5);opacity:0;transform:translateY(8px);transition:all .25s';
  t.innerHTML = lines.join('<br>');
  host.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; });
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2600);
}

function openStore() {
  if (!window.Progression) return;
  let ov = document.getElementById('store-overlay');
  if (!ov) {
    ov = document.createElement('div'); ov.id = 'store-overlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(2,8,4,.72);z-index:260;display:flex;align-items:center;justify-content:center;font:13px Arial';
    document.body.appendChild(ov);
    ov.addEventListener('click', e => { if (e.target === ov) closeStore(); });
  }
  renderStore(ov);
  ov.style.display = 'flex';
}
function closeStore() { const ov = document.getElementById('store-overlay'); if (ov) ov.style.display = 'none'; }

function renderStore(ov) {
  const P = window.Progression;
  const items = P.STORE.map(it => {
    const owned = P.owns(it.id);
    const can = !owned && P.getTokens() >= it.price;
    const right = (it.price === 0 || owned)
      ? `<span style="color:#7ec98a;font-weight:700">${owned ? 'Owned' : 'Free'}</span>`
      : `<button data-buy="${it.id}" ${can ? '' : 'disabled'} style="background:${can ? 'linear-gradient(#5cc832,#2e8a10)' : '#3a4a3a'};border:0;border-radius:4px;color:#fff;padding:4px 10px;cursor:${can ? 'pointer' : 'default'};font-weight:700">🎟️ ${it.price}</button>`;
    return `<div style="display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid #143"><div style="flex:1"><div style="color:#cfe;font-weight:700">${it.name}</div><div style="color:#7aa;font-size:11px">${it.blurb}</div></div>${right}</div>`;
  }).join('');
  const badges = Object.keys(P.SHOT_TYPES).map(t => {
    const top = P.topTier(t);
    return `<span style="display:inline-block;margin:2px;padding:2px 7px;border-radius:10px;font-size:10px;background:${top ? '#1c5a2c' : '#10241a'};color:${top ? '#9fe0a8' : '#567'}">${P.SHOT_TYPES[t].name}: ${top ? top.name : '—'} (${P.statOf(t)})</span>`;
  }).join('');
  ov.innerHTML = `<div style="width:420px;max-width:94vw;background:#0c2414;border:1px solid #2f7a36;border-radius:10px;overflow:hidden;box-shadow:0 14px 50px rgba(0,0,0,.6)">
    <div style="background:linear-gradient(#176a2a,#0c3a17);padding:9px 14px;display:flex;justify-content:space-between;align-items:center"><b style="color:#fff">🎖️ Store &amp; Badges</b><span style="color:#bfe6c6">🎟️ ${P.getTokens()} <button data-close style="margin-left:10px;background:#3a0d0d;border:1px solid #7a2a2a;color:#f0a0a0;border-radius:4px;cursor:pointer;padding:3px 9px">✕</button></span></div>
    <div style="padding:10px 14px"><div style="color:#7ec98a;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Assist assets (practice)</div>${items}
      <div style="color:#7ec98a;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin:10px 0 4px">Badges</div><div>${badges}</div>
      <div style="color:#5a8a6a;font-size:10px;margin-top:8px">Earn tokens by potting — bank, combo &amp; multi-ball shots pay more. Assists are practice-only.</div></div></div>`;
  ov.querySelector('[data-close]').onclick = closeStore;
  ov.querySelectorAll('[data-buy]').forEach(b => b.onclick = () => { if (P.buy(b.dataset.buy)) { renderStore(ov); updateTokenHUD(); } });
}

// How close the ball's rail-arrival point must be to a pocket centre to count as potted.
// Pocket centres sit beyond the cushion line, so a ball reaching the rail near one drops.
const POCKET_MOUTH = () => BALL_R * 2.6;   // pool ≈ 26px, snooker ≈ 15.6px (BALL_R is mode-set)

// Which pocket (if any) is within a mouth's reach of point (x,y)?
function pocketAt(x, y) {
  const m = POCKET_MOUTH();
  for (let i = 0; i < 6; i++) if (Math.hypot(x - PX[i], y - PY[i]) < m) return i;
  return -1;
}

// SCRATCH check: starting from the cue's contact point (gx,gy), travelling along its
// post-collision deflection (dx,dy), which pocket would the CUE BALL drop into? Returns
// the pocket index (a scratch → ball-in-hand) or -1 if it's stopped by a ball first or
// reaches a plain rail. `targetIdx` is the ball it just struck (ignored).
function cueScratchPocket(gx, gy, dx, dy, targetIdx) {
  const wh = rayHitWall(gx, gy, dx, dy);
  for (let i = 1; i < balls.length; i++) {
    if (i === targetIdx) continue;
    const b = balls[i]; if (!b.active || b.falling) continue;
    const fx = b.x - gx, fy = b.y - gy;
    const t = fx * dx + fy * dy;
    if (t <= 0 || t >= wh.t) continue;
    if (Math.abs(fx * -dy + fy * dx) < BALL_D) return -1;   // another ball stops the cue first
  }
  return pocketAt(gx + dx * wh.t, gy + dy * wh.t);
}

// The cue's post-contact heading isn't a single line: with stun it leaves on the TANGENT,
// with follow it carries toward its INCOMING direction. Scan that whole stun→follow fan and
// return the first pocket the cue would scratch into (or -1). Catches follow-scratches the
// pure tangent misses. `inDx,inDy` = cue incoming dir, `nx,ny` = contact normal (toward target).
function cueScratchScan(gx, gy, inDx, inDy, nx, ny, targetIdx) {
  const d = inDx * nx + inDy * ny;
  let tx = inDx - d * nx, ty = inDy - d * ny;          // tangent (stun) component
  const tl = Math.hypot(tx, ty);
  if (tl < 0.001) return cueScratchPocket(gx, gy, inDx, inDy, targetIdx);  // dead-straight → follows on
  tx /= tl; ty /= tl;
  for (let f = 0; f <= 1.0; f += 0.2) {                 // blend tangent (f=0) → incoming/follow (f=1)
    const bx = tx * (1 - f) + inDx * f, by = ty * (1 - f) + inDy * f;
    const bl = Math.hypot(bx, by); if (bl < 0.001) continue;
    const pk = cueScratchPocket(gx, gy, bx / bl, by / bl, targetIdx);
    if (pk !== -1) return pk;
  }
  return -1;
}

// Trace a ray through up to `maxBounces` rail reflections, EXTENDING the final segment to
// the table border. Stops early at: the first object ball (stopAtBall), or a pocket the
// ball drops into (stopAtPocket — detected when the rail-arrival point is within a pocket
// mouth; no bounce past it). With spinDeflect, English rotates the post-bounce heading.
// Returns { segs:[{x1,y1,x2,y2}], dots:[{x,y}], hit|null, pocket:-1|0..5, potX, potY }.
function traceRay(ox, oy, rdx, rdy, maxBounces, opts = {}) {
  const { stopAtBall = false, stopAtPocket = false, spinDeflect = false } = opts;
  let spin = opts.spin || 0;
  const segs = [], dots = [];
  let bouncesLeft = maxBounces;
  for (let guard = 0; guard < 32; guard++) {
    const wh = rayHitWall(ox, oy, rdx, rdy);
    const bh = stopAtBall ? rayHitBall(ox, oy, rdx, rdy) : null;
    if (bh && bh.t < wh.t) {                              // hit an object ball before the rail
      const ex = ox + rdx * bh.t, ey = oy + rdy * bh.t;
      segs.push({ x1: ox, y1: oy, x2: ex, y2: ey });
      return { segs, dots, hit: { gx: ex, gy: ey, ball: bh.ball, rdx, rdy }, pocket: -1 };
    }
    if (wh.t === Infinity) {                              // shouldn't happen (closed table)
      const [ex, ey] = aimLineEnd(ox, oy, rdx, rdy);
      segs.push({ x1: ox, y1: oy, x2: ex, y2: ey });
      return { segs, dots, hit: null, pocket: -1 };
    }
    const ex = ox + rdx * wh.t, ey = oy + rdy * wh.t;
    if (stopAtPocket) {                                   // reaches the rail near a pocket → potted
      const pk = pocketAt(ex, ey);
      if (pk !== -1) { segs.push({ x1: ox, y1: oy, x2: ex, y2: ey }); return { segs, dots, hit: null, pocket: pk, potX: ex, potY: ey }; }
    }
    segs.push({ x1: ox, y1: oy, x2: ex, y2: ey });
    if (bouncesLeft <= 0) return { segs, dots, hit: null, pocket: -1 };   // ends at the rail
    dots.push({ x: ex, y: ey });
    if (wh.nx !== 0) rdx = -rdx;
    if (wh.ny !== 0) rdy = -rdy;
    if (spinDeflect && Math.abs(spin) >= 0.01) {
      const inc = wh.ny !== 0 ? Math.atan2(Math.abs(rdy), Math.abs(rdx))
                              : Math.atan2(Math.abs(rdx), Math.abs(rdy));
      let a = Math.atan2(rdy, rdx);
      a -= spin * 0.8975979010256552 * (inc / (Math.PI / 2));
      rdx = Math.cos(a); rdy = Math.sin(a);
      spin *= 0.3;
    }
    ox = ex; oy = ey; bouncesLeft--;
  }
  return { segs, dots, hit: null, pocket: -1 };
}

// ── ASSIST (aim-lock cheats) ────────────────────────────────────────────────
// Shared geometry helpers, then one solver per mode. Each solver returns
// { aimX, aimY, chain? } or null; applyAssist() locks mx,my onto it.

// Is the straight path (x1,y1)→(x2,y2) clear of every active ball except `ignore` ids?
function pathClear(x1, y1, x2, y2, ignore) {
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
  if (len < 1) return true;
  const ux = dx / len, uy = dy / len;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (!b.active || b.falling || ignore.includes(i)) continue;
    const fx = b.x - x1, fy = b.y - y1;
    const t = fx * ux + fy * uy;
    if (t <= 0 || t >= len) continue;
    if (Math.abs(fx * -uy + fy * ux) < BALL_D) return false;   // a ball straddles the line
  }
  return true;
}

// Evaluate potting object ball `bi` into pocket `p` from a shooter at (sx,sy).
// Returns { ghostX, ghostY, cut, dist } or null if not a clear, makeable pot.
function evalPot(sx, sy, bi, p) {
  const b = balls[bi];
  const pdx = PX[p] - b.x, pdy = PY[p] - b.y, pl = Math.hypot(pdx, pdy);
  if (pl < 1) return null;
  const pnx = pdx / pl, pny = pdy / pl;
  const ghostX = b.x - pnx * BALL_D, ghostY = b.y - pny * BALL_D;
  const gdx = ghostX - sx, gdy = ghostY - sy, gl = Math.hypot(gdx, gdy);
  if (gl < 1) return null;
  const inDx = gdx / gl, inDy = gdy / gl;             // cue incoming direction
  const cut = inDx * pnx + inDy * pny;                 // straightness (1 = dead straight)
  if (cut <= 0.18) return null;                         // cut steeper than ~80° → unreliable
  if (!pathClear(sx, sy, ghostX, ghostY, [0, bi])) return null;   // cue → ghost clear
  if (!pathClear(b.x, b.y, PX[p], PY[p], [bi])) return null;      // ball → pocket clear
  // VERIFY: roll the target along the contact normal — it must actually drop into pocket p
  // (no rail bounce). This rejects "straight cut" picks whose line really misses the pocket.
  const v = traceRay(b.x, b.y, pnx, pny, 0, { stopAtPocket: true });
  if (v.pocket !== p) return null;
  // margin = how centrally the ball enters (small = clean drop, large = rail-skimming near-miss).
  const margin = Math.hypot(v.potX - PX[p], v.potY - PY[p]);
  // Reject SCRATCHES across the stun→follow fan — the cue must not be potted (ball-in-hand).
  if (cueScratchScan(ghostX, ghostY, inDx, inDy, pnx, pny, bi) !== -1) return null;
  return { ghostX, ghostY, cut, dist: gl + pl, margin };
}

// Mode 1 — Magnet: the ball nearest your aim ray, into its straightest makeable pocket.
function assistMagnet() {
  const cu = balls[0];
  const adx = mx - cu.x, ady = my - cu.y, al = Math.hypot(adx, ady);
  if (al < 5) return null;
  const ax = adx / al, ay = ady / al;
  let ti = -1, bestPerp = BALL_D * 2.4;
  for (let i = 1; i < balls.length; i++) {
    const b = balls[i]; if (!b.active || b.falling) continue;
    const fx = b.x - cu.x, fy = b.y - cu.y;
    if (fx * ax + fy * ay <= 0) continue;
    const perp = Math.abs(fx * -ay + fy * ax);
    if (perp < bestPerp) { bestPerp = perp; ti = i; }
  }
  if (ti < 0) return null;
  // Pick the pocket that pots most cleanly: straight cut AND a central drop (low margin).
  let best = null, bestScore = -1e9;
  for (let p = 0; p < 6; p++) {
    const r = evalPot(cu.x, cu.y, ti, p);
    if (!r) continue;
    const score = r.cut - r.margin * 0.04;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best ? { aimX: best.ghostX, aimY: best.ghostY } : null;
}

// Mode 2 — Best Shot: the easiest makeable direct pot anywhere — straightest cut, central
// drop (penalise rail-skimmers), and nearer preferred.
function assistBest() {
  const cu = balls[0]; let best = null;
  for (let i = 1; i < balls.length; i++) {
    if (!balls[i].active || balls[i].falling) continue;
    for (let p = 0; p < 6; p++) {
      const r = evalPot(cu.x, cu.y, i, p);
      if (!r) continue;
      const score = r.cut - r.margin * 0.04 - r.dist * 0.0006;
      if (!best || score > best.score) best = { aimX: r.ghostX, aimY: r.ghostY, score };
    }
  }
  return best;
}

// Mode 3 — Combo: cue → ball A → ball B → pocket (a 2-ball combination).
function assistCombo() {
  const cu = balls[0]; let best = null;
  for (let bi = 1; bi < balls.length; bi++) {
    const B = balls[bi]; if (!B.active || B.falling) continue;
    for (let p = 0; p < 6; p++) {
      const pdx = PX[p] - B.x, pdy = PY[p] - B.y, pl = Math.hypot(pdx, pdy);
      if (pl < 1) continue;
      const pnx = pdx / pl, pny = pdy / pl;
      const gBx = B.x - pnx * BALL_D, gBy = B.y - pny * BALL_D;          // contact to send B into P
      if (!pathClear(B.x, B.y, PX[p], PY[p], [bi])) continue;
      if (traceRay(B.x, B.y, pnx, pny, 0, { stopAtPocket: true }).pocket !== p) continue;
      for (let ai = 1; ai < balls.length; ai++) {
        if (ai === bi) continue;
        const A = balls[ai]; if (!A.active || A.falling) continue;
        const dax = gBx - A.x, day = gBy - A.y, dal = Math.hypot(dax, day);
        if (dal < 1 || dal > BALL_D * 6) continue;                       // A must be near B
        const anx = dax / dal, any = day / dal;
        if (anx * pnx + any * pny < 0.6) continue;                       // A's push ≈ B→P
        const gAx = A.x - anx * BALL_D, gAy = A.y - any * BALL_D;        // cue contact to push A
        const gdx = gAx - cu.x, gdy = gAy - cu.y, gl = Math.hypot(gdx, gdy);
        if (gl < 1) continue;
        const cut = (gdx / gl) * anx + (gdy / gl) * any;
        if (cut <= 0.2) continue;
        if (!pathClear(cu.x, cu.y, gAx, gAy, [0, ai])) continue;
        if (!pathClear(A.x, A.y, gBx, gBy, [ai, bi])) continue;
        // reject scratches: cue deflects off A across the stun→follow fan
        if (cueScratchScan(gAx, gAy, gdx / gl, gdy / gl, anx, any, ai) !== -1) continue;
        const score = cut * (anx * pnx + any * pny) - (gl + dal + pl) * 0.0004;
        if (!best || score > best.score) best = {
          aimX: gAx, aimY: gAy, score,
          chain: [{ x: A.x, y: A.y }, { x: B.x, y: B.y }, { x: PX[p], y: PY[p] }],
        };
      }
    }
  }
  return best;
}

// Mode 4 — Bank: cue banks off ONE rail, then pots a ball that has no direct line.
// Mirror the cue across each rail; the straight line from the MIRROR to the ball's ghost
// crosses that rail at the bank point, and the cue→bankPoint→ghost path is its reflection.
function assistBank() {
  const cu = balls[0]; let best = null;
  const L = BORDER + BALL_R, R = TW - BORDER - BALL_R, T = BORDER + BALL_R, Bm = TH - BORDER - BALL_R;
  const mirrors = [
    { x: cu.x, y: 2 * T - cu.y, vert: false, rv: T }, { x: cu.x, y: 2 * Bm - cu.y, vert: false, rv: Bm },
    { x: 2 * L - cu.x, y: cu.y, vert: true, rv: L },  { x: 2 * R - cu.x, y: cu.y, vert: true, rv: R },
  ];
  for (const m of mirrors) {
    for (let i = 1; i < balls.length; i++) {
      const b = balls[i]; if (!b.active || b.falling) continue;
      for (let p = 0; p < 6; p++) {
        const pdx = PX[p] - b.x, pdy = PY[p] - b.y, pl = Math.hypot(pdx, pdy);
        if (pl < 1) continue;
        const pnx = pdx / pl, pny = pdy / pl;
        const ghostX = b.x - pnx * BALL_D, ghostY = b.y - pny * BALL_D;
        const adx = ghostX - m.x, ady = ghostY - m.y, al = Math.hypot(adx, ady);
        if (al < 1) continue;
        const cut = (adx / al) * pnx + (ady / al) * pny;
        if (cut <= 0.12) continue;
        // Bank point = line(mirror → ghost) ∩ rail.
        let bx, by, s;
        if (m.vert) { s = (m.rv - m.x) / (adx === 0 ? 1e-6 : adx); bx = m.rv; by = m.y + ady * s; }
        else        { s = (m.rv - m.y) / (ady === 0 ? 1e-6 : ady); by = m.rv; bx = m.x + adx * s; }
        if (s <= 0 || bx < L || bx > R || by < T || by > Bm) continue;
        if (!pathClear(cu.x, cu.y, bx, by, [0, i])) continue;          // cue → bank point
        if (!pathClear(bx, by, ghostX, ghostY, [0, i])) continue;      // bank point → ghost (real)
        if (!pathClear(b.x, b.y, PX[p], PY[p], [i])) continue;         // ball → pocket
        if (traceRay(b.x, b.y, pnx, pny, 0, { stopAtPocket: true }).pocket !== p) continue;
        const aimX = cu.x + (bx - cu.x) * 100, aimY = cu.y + (by - cu.y) * 100;  // aim at the rail
        const score = cut - (al + pl) * 0.0008;
        if (!best || score > best.score) best = {
          aimX, aimY, score,
          chain: [{ x: bx, y: by }, { x: b.x, y: b.y }, { x: PX[p], y: PY[p] }],
        };
      }
    }
  }
  return best;
}

// Apply the active assist: lock mx,my (and assistChain for the overlay). No-op when off.
function applyAssist() {
  assistChain = null;
  if (!assistMode || gState !== S.AIM || !balls[0].active || !assistsAllowed()) return;
  let r = null;
  if (assistMode === 1) r = assistMagnet();
  else if (assistMode === 2) r = assistBest();
  else if (assistMode === 3) r = assistCombo();
  else if (assistMode === 4) r = assistBank();
  if (r) { mx = r.aimX; my = r.aimY; assistChain = r.chain || null; }
}

// Minimum distance from point (px,py) to line segment (x1,y1)→(x2,y2)
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2-x1, dy = y2-y1;
  const lenSq = dx*dx + dy*dy;
  if (lenSq === 0) return Math.hypot(px-x1, py-y1);
  const t = Math.max(0, Math.min(1, ((px-x1)*dx + (py-y1)*dy) / lenSq));
  return Math.hypot(px - (x1 + t*dx), py - (y1 + t*dy));
}

// Returns pocket index (0-5) if the segment from (x1,y1)→(x2,y2) passes within
// BALL_R of a pocket centre (i.e. the ball would drop in), otherwise -1.
function segHitsPocket(x1, y1, x2, y2) {
  for (let i = 0; i < 6; i++) {
    if (distToSeg(PX[i], PY[i], x1, y1, x2, y2) <= BALL_R + 4) return i;
  }
  return -1;
}

// Ray vs axis-aligned wall boundary — returns {t, nx, ny} of nearest hit (t=Infinity if none)
function rayHitWall(ox, oy, rdx, rdy) {
  const L=BORDER+BALL_R, R=TW-BORDER-BALL_R;
  const T=BORDER+BALL_R, B=TH-BORDER-BALL_R;
  let tMin=Infinity, wnx=0, wny=0;
  const chk=(t,nx,ny)=>{ if(t>0.5&&t<tMin){tMin=t;wnx=nx;wny=ny;} };
  if(rdx<0) chk((L-ox)/rdx, 1, 0);
  if(rdx>0) chk((R-ox)/rdx,-1, 0);
  if(rdy<0) chk((T-oy)/rdy, 0, 1);
  if(rdy>0) chk((B-oy)/rdy, 0,-1);
  return {t:tMin, nx:wnx, ny:wny};
}

// Ray vs object balls — returns {t, ball} of nearest hit, or null
function rayHitBall(ox, oy, rdx, rdy) {
  let tMin=Infinity, hit=null;
  for(let i=1;i<balls.length;i++){
    const b=balls[i];
    if(!b||!b.active||b.falling) continue;
    const fx=ox-b.x, fy=oy-b.y;
    const bv=fx*rdx+fy*rdy;
    const c=fx*fx+fy*fy-BALL_D*BALL_D;
    const disc=bv*bv-c;
    if(disc<0) continue;
    const t=-bv-Math.sqrt(disc);
    if(t>0.5&&t<tMin){tMin=t;hit=b;}
  }
  return hit?{t:tMin,ball:hit}:null;
}

function drawAimAssist() {
  if(!cheatMode||gState!==S.AIM||mx<0||!balls[0].active) return;
  const cu=balls[0];
  const adx=cu.x-mx, ady=cu.y-my;
  const alen=Math.sqrt(adx*adx+ady*ady);
  if(alen<5) return;

  // Unit aim direction: from cue ball toward mouse
  let rdx=-adx/alen, rdy=-ady/alen;
  let ox=cu.x, oy=cu.y;

  ctx.save();

  const hasSideSpin  = Math.abs(spinX) > 0.05;
  const hasSpinY     = Math.abs(spinY) > 0.05;
  const PATH_C   = hasSideSpin ? 'rgba(180,255,120,0.65)' : 'rgba(255,255,255,0.55)';
  const TARGET_C = 'rgba(255,185,50,0.85)';
  const CUE_C    = hasSpinY    ? 'rgba(255,140,60,0.85)'  : 'rgba(60,210,255,0.80)';

  // Cue-ball path: trace to the first ball, bouncing off rails up to aimRailBounces times,
  // with the final segment extended to the table border.
  const cueTrace = traceRay(ox, oy, rdx, rdy, aimRailBounces,
                            { stopAtBall: true, spin: spinX, spinDeflect: hasSideSpin });
  ctx.setLineDash([]); ctx.lineWidth = 1.5; ctx.strokeStyle = PATH_C;
  for(const s of cueTrace.segs){
    ctx.beginPath(); ctx.moveTo(s.x1,s.y1); ctx.lineTo(s.x2,s.y2); ctx.stroke();
  }
  for(const p of cueTrace.dots){
    ctx.beginPath(); ctx.arc(p.x,p.y,3,0,Math.PI*2);
    ctx.fillStyle = hasSideSpin ? 'rgba(200,255,80,0.8)' : 'rgba(255,255,255,0.5)';
    ctx.fill();
  }

  if(!cueTrace.hit){ ctx.restore(); return; }

  const {gx,gy,ball,rdx:hrdx,rdy:hrdy}=cueTrace.hit;

  // Ghost ball outline at contact position
  ctx.beginPath(); ctx.arc(gx,gy,BALL_R,0,Math.PI*2);
  ctx.strokeStyle='rgba(255,255,255,0.65)'; ctx.lineWidth=1.5; ctx.stroke();

  // Contact normal: from ghost-ball center to target ball center
  const cnx=ball.x-gx, cny=ball.y-gy;
  const cnLen=Math.sqrt(cnx*cnx+cny*cny);
  if(cnLen<0.5){ctx.restore();return;}
  const nx=cnx/cnLen, ny=cny/cnLen;

  // ── Target ball path: roll along the contact normal, bouncing off rails up to
  //    aimRailBounces times — but STOP at the pocket if the ball will drop. ───────
  const tgt = traceRay(ball.x, ball.y, nx, ny, aimRailBounces, { stopAtPocket: true });
  const potted = tgt.pocket !== -1;
  ctx.strokeStyle=TARGET_C; ctx.lineWidth=1.5; ctx.setLineDash([7,4]);
  for(const s of tgt.segs){
    ctx.beginPath(); ctx.moveTo(s.x1,s.y1); ctx.lineTo(s.x2,s.y2); ctx.stroke();
  }
  ctx.setLineDash([]);
  for(const p of tgt.dots){
    ctx.beginPath(); ctx.arc(p.x,p.y,3,0,Math.PI*2); ctx.fillStyle=TARGET_C; ctx.fill();
  }
  if (potted) {
    // Where the ball drops: a filled marker at the pot point + a strong glow on the pocket.
    ctx.save();
    ctx.fillStyle = 'rgba(120,255,140,0.95)';
    ctx.beginPath(); ctx.arc(tgt.potX, tgt.potY, 4, 0, Math.PI*2); ctx.fill();
    ctx.shadowColor = '#3cff78'; ctx.shadowBlur = 22;
    ctx.strokeStyle = 'rgba(90,255,120,0.95)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(PX[tgt.pocket], PY[tgt.pocket], 15, 0, Math.PI*2); ctx.stroke();
    ctx.shadowBlur = 9; ctx.strokeStyle = 'rgba(160,255,180,0.6)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(PX[tgt.pocket], PY[tgt.pocket], 9, 0, Math.PI*2); ctx.stroke();
    ctx.restore();
  } else {
    // Not potting: arrowhead at the end of the rolled path.
    const tl = tgt.segs[tgt.segs.length-1];
    const dX = tl.x2-tl.x1, dY = tl.y2-tl.y1, dL = Math.hypot(dX,dY)||1;
    const anx = dX/dL, any = dY/dL;
    ctx.beginPath();
    ctx.moveTo(tl.x2, tl.y2);
    ctx.lineTo(tl.x2 - anx*9 + any*5, tl.y2 - any*9 - anx*5);
    ctx.lineTo(tl.x2 - anx*9 - any*5, tl.y2 - any*9 + anx*5);
    ctx.closePath(); ctx.fillStyle=TARGET_C; ctx.fill();
  }

  // ── Cue ball post-collision path (cyan, or orange when topspin/backspin active) ─
  const dot = hrdx*nx + hrdy*ny;
  let px = hrdx - dot*nx, py = hrdy - dot*ny;

  // Topspin/backspin modifies the cue's post-collision direction:
  //   backspin (spinY>0): cue draws back along the normal (reversal)
  //   topspin  (spinY<0): cue follows through toward the target
  // spinInfluence = -spinY * dot * 0.7; dot is positive so this opposes/aids normal
  if(hasSpinY){
    const spinInfluence = -spinY * dot * 0.7;
    px += spinInfluence * nx;
    py += spinInfluence * ny;
  }

  const pLen2=px*px+py*py;
  if(pLen2>0.001){
    const pLen=Math.sqrt(pLen2);
    const pnx=px/pLen, pny=py/pLen;
    const CLEN=Math.max(35, 130*Math.sqrt(pLen2)/Math.max(1,Math.abs(dot)+Math.sqrt(pLen2)));
    const cx2=gx+pnx*CLEN, cy2=gy+pny*CLEN;
    // SCRATCH warning: would the cue ball roll into a pocket after contact (stun→follow fan)?
    const scr = cueScratchScan(gx, gy, hrdx, hrdy, nx, ny, balls.indexOf(ball));
    const cueLineC = scr !== -1 ? 'rgba(255,60,60,0.9)' : CUE_C;
    ctx.strokeStyle=cueLineC; ctx.lineWidth=1.5; ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.moveTo(gx,gy); ctx.lineTo(cx2,cy2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(cx2,cy2);
    ctx.lineTo(cx2-pnx*9+pny*5, cy2-pny*9-pnx*5);
    ctx.lineTo(cx2-pnx*9-pny*5, cy2-pny*9+pnx*5);
    ctx.closePath(); ctx.fillStyle=cueLineC; ctx.fill();
    if (scr !== -1) {
      // Red warning ring on the pocket the cue would scratch into.
      ctx.save();
      ctx.shadowColor = '#ff2a2a'; ctx.shadowBlur = 20;
      ctx.strokeStyle = 'rgba(255,55,55,0.95)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(PX[scr], PY[scr], 15, 0, Math.PI*2); ctx.stroke();
      ctx.shadowBlur = 0; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(PX[scr]-7, PY[scr]-7); ctx.lineTo(PX[scr]+7, PY[scr]+7);
      ctx.moveTo(PX[scr]+7, PY[scr]-7); ctx.lineTo(PX[scr]-7, PY[scr]+7); ctx.stroke();  // ✕
      ctx.restore();
    }
  }

  ctx.setLineDash([]);

  // Contact point dot
  ctx.beginPath(); ctx.arc(gx+nx*BALL_R, gy+ny*BALL_R, 3, 0, Math.PI*2);
  ctx.fillStyle='rgba(255,255,255,0.9)'; ctx.fill();

  ctx.restore();
}

// Combo/Bank assist overlay: the first hop (A→B, or bank-point→ball) and the ball→pocket roll.
function drawAssistChain(){
  if(!assistChain || gState!==S.AIM || !cheatMode) return;
  const [a, b, pk] = assistChain;
  ctx.save();
  ctx.setLineDash([6,4]); ctx.lineWidth=1.5;
  ctx.strokeStyle='rgba(120,210,255,0.85)';   // first hop
  ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  ctx.strokeStyle='rgba(255,185,50,0.9)';     // second hop → pocket
  ctx.beginPath(); ctx.moveTo(b.x,b.y); ctx.lineTo(pk.x,pk.y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle='rgba(120,210,255,0.95)';      // mark the bank/intermediate point
  ctx.beginPath(); ctx.arc(a.x,a.y,3.5,0,Math.PI*2); ctx.fill();
  ctx.restore();
}

function drawCue(){
  if(gState!==S.AIM||mx<0||!balls[0].active) return;
  const cu=balls[0];
  const dx=cu.x-mx, dy=cu.y-my;
  const len=Math.sqrt(dx*dx+dy*dy);
  if(len<1) return;
  const nx=dx/len, ny=dy/len;

  // Plain aim line — suppressed when cheat/guide mode is active (drawAimAssist handles it)
  if(!cheatMode){
    const [ex, ey] = aimLineEnd(cu.x, cu.y, -nx, -ny);
    ctx.setLineDash([5,5]);
    ctx.strokeStyle='rgba(255,255,255,0.32)';
    ctx.lineWidth=1;
    ctx.beginPath();
    ctx.moveTo(cu.x, cu.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Cue stick: behind the cue ball, in the (nx,ny) direction (away from aim)
  // nearOff grows with power so stick pulls back as power charges
  const nearOff = BALL_R + 5 + power * 0.5;

  const stick = gameMode==='snooker'
    ? (imgs.snookerStick1||imgs.snookerStick0||imgs.stick1||imgs.stick0)
    : (imgs.stick1||imgs.stick0);
  if(stick){
    ctx.save();
    // Place origin at the stick tip (on the away side of the cue ball)
    ctx.translate(cu.x + nx*nearOff, cu.y + ny*nearOff);
    // Rotate so +Y local → (nx,ny) world direction (handle extends away from ball)
    ctx.rotate(Math.atan2(ny, nx) - Math.PI/2);
    // Centre horizontally on the cue axis
    ctx.translate(-stick.width/2, 0);
    ctx.drawImage(stick, 0, 0);
    ctx.restore();
  } else {
    // Fallback line
    const farOff = nearOff + 65;
    ctx.strokeStyle='#c8a060'; ctx.lineWidth=5;
    ctx.beginPath();
    ctx.moveTo(cu.x+nx*nearOff, cu.y+ny*nearOff);
    ctx.lineTo(cu.x+nx*farOff,  cu.y+ny*farOff);
    ctx.stroke();
    ctx.strokeStyle='#6a3a10'; ctx.lineWidth=8;
    ctx.beginPath();
    ctx.moveTo(cu.x+nx*(farOff-6), cu.y+ny*(farOff-6));
    ctx.lineTo(cu.x+nx*farOff,     cu.y+ny*farOff);
    ctx.stroke();
  }
}

function drawPower(){
  if(gState!==S.AIM||!mdown||mx<0) return;
  const bx=10, by=TH-26;
  ctx.fillStyle='rgba(0,0,0,0.5)';
  ctx.fillRect(bx,by,100,12);
  const c=`hsl(${120-power*1.2},100%,45%)`;
  ctx.fillStyle=c;
  ctx.fillRect(bx,by,power,12);
  ctx.strokeStyle='rgba(255,255,255,0.6)'; ctx.lineWidth=1;
  ctx.strokeRect(bx,by,100,12);
  ctx.fillStyle='#fff'; ctx.font='10px Arial';
  ctx.textAlign='left';
  ctx.fillText(`Power: ${power}%`,bx,by-3);
}

const HEAD_STRING_X = 170; // method2678: var1 < 170

function drawPlaceBall(){
  if(gState!==S.PLACE) return;

  // Snooker: highlight the D (baulk semicircle) — guide for legal placement
  if(gameMode==='snooker'){
    ctx.save();
    ctx.strokeStyle='rgba(255,255,255,0.30)';
    ctx.setLineDash([4,4]); ctx.lineWidth=1;
    ctx.beginPath();
    ctx.moveTo(SNK_BAULK_X, SNK_D_CY-SNK_D_R);
    ctx.lineTo(SNK_BAULK_X, SNK_D_CY+SNK_D_R);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(SNK_BAULK_X, SNK_D_CY, SNK_D_R, Math.PI/2, 3*Math.PI/2);
    ctx.stroke();
    ctx.restore();
  } else if(!freeBall){
    // Head string line (pool, shown when not freeBall)
    ctx.setLineDash([4,4]);
    ctx.strokeStyle='rgba(255,255,255,0.25)';
    ctx.lineWidth=1;
    ctx.beginPath();
    ctx.moveTo(HEAD_STRING_X, BORDER);
    ctx.lineTo(HEAD_STRING_X, TH-BORDER);
    ctx.stroke();
    ctx.setLineDash([]);
    // Label
    ctx.fillStyle='rgba(255,255,255,0.22)';
    ctx.font='10px Arial';
    ctx.textAlign='center';
    ctx.fillText('Place here', HEAD_STRING_X/2, BORDER-4+12);
  }

  if(mx<0) return;
  const ok=isValidPlacement(mx,my);
  drawBall(0,mx,my,ok?0.55:0.2);
  if(!ok){
    ctx.strokeStyle='rgba(255,50,50,0.7)'; ctx.lineWidth=2;
    ctx.beginPath();
    ctx.arc(mx,my,BALL_R+3,0,Math.PI*2);
    ctx.stroke();
  }
}

function drawSnookerOverlays(){
  if(gameMode!=='snooker' || imgs.snookerTable) return;
  // Fallback markings only when the snooker table image is unavailable
  // (snooker-table.png already has baulk line, D, and spots baked in).
  ctx.save();
  ctx.strokeStyle='rgba(255,255,255,0.18)'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
  ctx.beginPath();
  ctx.moveTo(SNK_BAULK_X, SNK_D_CY-SNK_D_R);
  ctx.lineTo(SNK_BAULK_X, SNK_D_CY+SNK_D_R);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(SNK_BAULK_X, SNK_D_CY, SNK_D_R, Math.PI/2, 3*Math.PI/2);
  ctx.stroke();
  ctx.setLineDash([]);
  for(const id of [16,17,18,19,20,21]){
    const sp=SNOOKER_SPOTS[id];
    ctx.beginPath(); ctx.arc(sp.x, sp.y, 1.5, 0, Math.PI*2);
    ctx.fillStyle='rgba(255,255,255,0.4)'; ctx.fill();
  }
  ctx.restore();
}

function drawCountHUD(){
  if(gameMode!=='count'||gState===S.DONE) return;
  const barW=180, barH=10, bx=(TW-barW)/2, by=8;
  const pct=Math.min(countPoints/countTarget,1);
  ctx.fillStyle='rgba(0,0,0,0.55)';
  ctx.fillRect(bx,by,barW,barH);
  ctx.fillStyle=`hsl(${Math.round(110*pct)},75%,45%)`;
  ctx.fillRect(bx,by,barW*pct,barH);
  ctx.strokeStyle='rgba(255,255,255,0.25)'; ctx.lineWidth=1;
  ctx.strokeRect(bx,by,barW,barH);
  ctx.fillStyle='rgba(255,255,255,0.9)'; ctx.font='bold 9px Arial';
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(`${countPoints} / ${countTarget} pts  ·  ${countShots} shots`, TW/2, by+barH/2);
  ctx.textBaseline='alphabetic';
}

// Only the player whose turn it is may see the aim line / cue stick / power / placement
// ghost. The opponent and spectators see just the balls (no peeking at the aim).
function localControlsTurn(){
  if(gameMode!=='online') return true;      // hotseat / single-player: local controls
  if(isViewer || !net) return false;         // spectators never aim
  return net.playerIndex === curP;           // online: only the player in turn
}

function render(){
  ctx.clearRect(0,0,TW,TH);
  drawTable();
  drawBalls();
  const myTurn = localControlsTurn();
  if(gState===S.AIM && myTurn)   { drawAimAssist(); drawAssistChain(); drawCue(); drawPower(); }
  if(gState===S.PLACE && myTurn) { drawPlaceBall(); }
  drawCountHUD();
  drawSnookerOverlays();
}

// ─── INPUT ──────────────────────────────────────────────────────────────────
function canvasCoords(e){
  const r=canvas.getBoundingClientRect();
  return [(e.clientX-r.left)*TW/r.width, (e.clientY-r.top)*TH/r.height];
}

// Snooker "D" test — method2678: left of baulk line AND within the D radius
function inSnookerD(x,y){
  if(x > SNK_BAULK_X) return false;
  const dx=SNK_BAULK_X-x, dy=SNK_D_CY-y;
  return Math.sqrt(dx*dx+dy*dy) <= SNK_D_R;
}

function isValidPlacement(x,y){
  const margin=BORDER+BALL_R;
  if(x<margin||x>TW-margin||y<margin||y>TH-margin) return false;
  if(gameMode==='snooker'){
    // Cue ball always placed in the D (break and after fouls)
    if(!inSnookerD(x,y)) return false;
  } else if(!freeBall && x>=170){
    return false;  // pool: must be left of head string
  }
  for(let i=1;i<balls.length;i++){
    const b=balls[i];
    if(!b.active) continue;
    const dx=x-b.x, dy=y-b.y;
    if(dx*dx+dy*dy<BALL_D*BALL_D) return false;
  }
  return true;
}

canvas.addEventListener('mousemove',e=>{
  const [rx,ry]=canvasCoords(e);
  // Hold Shift while aiming → ease the aim point toward the cursor so the aim line
  // changes in much smaller increments (precise fine-tuning). Normal = follow cursor.
  if(shiftHeld && gState===S.AIM && mx>=0){
    mx += (rx-mx)*0.12;
    my += (ry-my)*0.12;
  } else {
    mx=rx; my=ry;
  }
  applyAssist();   // if an assist mode is on, lock the aim onto the computed potting line
});
canvas.addEventListener('mouseleave',()=>{mx=my=-1;});
// Track Shift for fine-aim (window-level so it works regardless of focus target)
window.addEventListener('keydown',e=>{ if(e.key==='Shift') shiftHeld=true; });
window.addEventListener('keyup',  e=>{ if(e.key==='Shift') shiftHeld=false; });
window.addEventListener('blur',   ()=>{ shiftHeld=false; });

canvas.addEventListener('mousedown',e=>{
  if(isViewer) return;
  if(shooting||gState===S.DONE) return;
  [mx,my]=canvasCoords(e);
  applyAssist();   // re-lock the aim before charging, so the shot matches the guide line

  if(gState===S.PLACE){
    if(gameMode==='online' && net && net.playerIndex!==curP) return;
    if(isValidPlacement(mx,my)){
      // Lockstep: online placement is an action too — send intent, apply on echo.
      if(gameMode==='online' && net){
        net.sendPlace(mx, my);
      } else {
        balls[0].x=mx; balls[0].y=my;
        balls[0].vx=balls[0].vy=0; balls[0].active=true; balls[0].falling=false;
        freeBall=false; gState=S.AIM; updateUI();
      }
    }
    return;
  }

  if(gState===S.AIM){
    if(!balls[0].active) return;
    mdown=true;
    if(e.button===2){
      power=100; // right-click = instant full power, no charging
    } else {
      power=5;
      pwrTimer=setInterval(()=>{if(power<100)power++;},18);
    }
  }
});

canvas.addEventListener('mouseup', e => {
  if (isViewer) return;
  if (!mdown || gState !== S.AIM) return;
  mdown = false;
  clearInterval(pwrTimer);
  if (shooting || !balls[0].active || mx < 0) return;
  // Online: only local player can shoot on their turn
  if (gameMode==='online' && net && net.playerIndex !== curP) return;
  const cu = balls[0];
  const dx = mx - cu.x, dy = my - cu.y;
  if (Math.sqrt(dx*dx+dy*dy) < 5) return;

  // ── LOCKSTEP (online): send the shot as INTENT and apply it only when the
  // server echoes it back (to everyone, in order). Do NOT simulate locally here —
  // the unified 'shot' handler runs startPhysics for the actor too, so all clients
  // execute identical inputs in identical order. `shooting` blocks re-input meanwhile.
  if (gameMode==='online' && net) {
    net.sendShot(mx, my, power, spinX, spinY);
    shooting = true;
    return;
  }

  shooting = true;
  gState = S.SHOOT; updateUI();
  startPhysics(mx, my, power);
  // Reset spin after each shot (like Java method2627 on turn end)
  spinX = 0; spinY = 0;
  drawSpinPanel();
});

// Prevent browser context menu on right-click (right-click = full power handled in mousedown)
canvas.addEventListener('contextmenu',e=>{e.preventDefault();});

// ─── UI ─────────────────────────────────────────────────────────────────────
function updateUI(){
  const s   = document.getElementById('status');
  const p1  = document.getElementById('p1box');
  const p2  = document.getElementById('p2box');
  const rb  = document.getElementById('restartBtn');

  const isSP = ['practice','count','9ball','10ball','snooker'].includes(gameMode);
  // Restart always visible in single-player modes; hidden in lobby/multiplayer
  if(rb) rb.style.display = isSP ? '' : 'none';

  // Multiplayer-only UI: shot clock (Aika) + side controls (Katsojat/toggles/Luovuta/Poistu)
  const mpMode = (gameMode==='hotseat' || gameMode==='online');
  const clockWrap = document.getElementById('clock-wrap');
  const mpCtl = document.getElementById('mp-controls');
  if(clockWrap) clockWrap.style.display = mpMode ? 'flex' : 'none';
  if(mpCtl)     mpCtl.style.display     = mpMode ? 'flex' : 'none';
  if(mpMode){
    const arrow = document.getElementById('turn-arrow');   // points at active player
    if(arrow) arrow.classList.toggle('right', curP===1);
    if(gState!==prevClockState){                            // (re)start on turn transitions
      if(gState===S.AIM || gState===S.PLACE) startShotClock();
      else stopShotClock();
    }
  } else {
    stopShotClock();
  }
  prevClockState = mpMode ? gState : -1;

  if(gameMode==='practice'){
    p1.style.visibility='hidden'; p2.style.visibility='hidden';
    const labels={[S.PLACE]:'Place cue ball',[S.AIM]:'Practice — Aim',[S.SHOOT]:'Shooting…'};
    s.textContent=labels[gState]||'Practice';
    return;
  }

  if(gameMode==='snooker'){
    p1.style.visibility='hidden'; p2.style.visibility='hidden';
    if(gState===S.DONE){
      s.textContent=`Snooker cleared! Total: ${snookerScore} pts · ${snookerShots} shots`;
    } else {
      const phaseLabel =
        snookerPhase==='red'     ? 'Pot a red'  :
        snookerPhase==='color'   ? 'Pot any colour' :
        `Pot ${SNKNAM[16+snookerEndColorIdx]} (${SNKVAL[16+snookerEndColorIdx]}pts)`;
      const redsLeft=balls.slice(1,16).filter(b=>b.active).length;
      const placeLabel=freeBall?'Ball in hand':'Place in D';
      const labels={
        [S.PLACE]:placeLabel,
        [S.AIM]:`Break: ${snookerBreak}  Total: ${snookerScore}  ·  ${phaseLabel}`,
        [S.SHOOT]:'Shooting…'
      };
      s.textContent=labels[gState]||'Snooker';
    }
    return;
  }

  if(gameMode==='9ball' || gameMode==='10ball'){
    p1.style.visibility='hidden'; p2.style.visibility='hidden';
    const targetBall = gameMode==='9ball' ? 9 : 10;
    const modeName   = gameMode==='9ball' ? '9-Ball' : '10-Ball';
    if(gState===S.DONE){
      s.textContent = `${modeName} — Cleared in ${countShots} shots`;
    } else {
      const remaining = balls.slice(1, targetBall + 1).filter(b => b.active);
      const nextBall  = remaining.length ? Math.min(...remaining.map(b => b.id)) : targetBall;
      const placeLabel = freeBall ? 'Ball in hand' : 'Place behind head string';
      const labels = {
        [S.PLACE]:  placeLabel,
        [S.AIM]:    `Shot ${countShots+1} — must hit ${nextBall}-ball first`,
        [S.SHOOT]:  'Shooting…'
      };
      s.textContent = labels[gState] || modeName;
    }
    return;
  }

  if(gameMode==='count'){
    p1.style.visibility='hidden'; p2.style.visibility='hidden';
    if(gState===S.DONE){
      s.textContent=`Done! ${countTarget} pts in ${countShots} shots`;
    } else {
      const placeLabel = freeBall?'Ball in hand':'Place behind head string';
      const labels={[S.PLACE]:placeLabel,[S.AIM]:`${countPoints}/${countTarget} pts · ${countShots} shots`,[S.SHOOT]:'Shooting…'};
      s.textContent=labels[gState]||'';
    }
    return;
  }

  if(gameMode==='jatkumo'){
    p1.style.visibility='hidden'; p2.style.visibility='hidden';
    if(gState===S.DONE){
      s.textContent=`Streak ${jatkumoStreak} · Best ${jatkumoBest}`;
    } else {
      const placeLabel = freeBall?'Ball in hand':'Place behind head string';
      const labels={[S.PLACE]:placeLabel,[S.AIM]:`Streak: ${jatkumoStreak}  ·  Best: ${jatkumoBest}  ·  pot every shot!`,[S.SHOOT]:'Shooting…'};
      s.textContent=labels[gState]||'';
    }
    return;
  }

  // Hotseat / Online: show both player panels
  p1.style.visibility=''; p2.style.visibility='';
  p1.classList.toggle('active', curP===0 && gState!==S.DONE);
  p2.classList.toggle('active', curP===1 && gState!==S.DONE);

  // Group labels only shown once a group has been determined by the first pot
  const p1g = document.getElementById('p1g');
  const p2g = document.getElementById('p2g');
  if (group[0] === -1) {
    p1g.textContent = ''; p2g.textContent = '';
  } else {
    const gName = g => g===0 ? 'Solids' : 'Stripes';
    p1g.textContent = gName(group[0]);
    p2g.textContent = gName(group[1]);
  }

  if(winner>=0){
    s.textContent=`Player ${winner+1} wins!`;
    return;
  }
  const who = gameMode==='online' ? (net&&net.playerIndex===curP?'Your':'Opponent\'s') : `P${curP+1}`;
  const placeLabel = freeBall ? 'Ball in hand' : 'Behind head string';
  const labels={[S.PLACE]:placeLabel,[S.AIM]:'Aiming',[S.SHOOT]:'Shooting…'};
  s.textContent=`${who} — ${labels[gState]||''}`;
}

let msgTimer=null;
function showMsg(txt,dur=2000){
  const el=document.getElementById('msg');
  el.textContent=txt; el.style.display='block';
  clearTimeout(msgTimer);
  msgTimer=setTimeout(()=>{el.style.display='none';},dur);
}

// ─── MAIN LOOP & INIT ────────────────────────────────────────────────────────
// Fixed-timestep accumulator: each stepPhysics() advances exactly 1/60 s of simulation, and
// we run as many steps as REAL time has elapsed. So a shot always takes the same wall-clock
// time and the balls move at the same speed regardless of frame rate — no slow motion on a
// cold first load, and identical duration on every reload. The leftover fraction is banked
// (no drift, unlike rounding per frame). Deterministic-safe for online lockstep (the total
// step count to settle is unchanged).
const SIM_DT = 1000 / 60;     // ms of simulation per stepPhysics() call
let _simAcc = 0, _simLast = 0;
function gameLoop() {
  const now = performance.now();
  if (!_simLast) _simLast = now;
  _simAcc += Math.min(now - _simLast, 250);   // cap banked time (avoid spiral after a stall)
  _simLast = now;

  if (gState === S.SHOOT) {
    let done = false;
    while (_simAcc >= SIM_DT && !done) { done = stepPhysics(); _simAcc -= SIM_DT; }
    if (done) {
      _simAcc = 0;
      for (let i = 0; i < balls.length; i++) {
        if (balls[i].active && balls[i].falling) balls[i].active = false;
      }
      shooting = false;
      awardShotProgress();   // classify the shot for badges/tokens BEFORE endTurn resets pocketed
      endTurn();
    }
  } else {
    _simAcc = 0;             // don't bank time while idle / aiming
  }
  render();
  requestAnimationFrame(gameLoop);
}

// Classify the just-finished shot and feed the progression layer (practice/solo only for now —
// online stays clean). `pocketed` holds the object balls that dropped this shot; their
// per-ball flags (cueStruck / banked) say how. Multiple categories can apply at once.
function awardShotProgress() {
  if (!window.Progression || gameMode === 'online' || gameMode === 'hotseat') return;
  const potted = pocketed.filter(id => id >= 1);   // object balls only (cue scratch excluded)
  if (potted.length === 0) return;
  const types = [];
  if (potted.some(id => balls[id].cueStruck && !balls[id].banked)) types.push('direct');
  if (potted.some(id => balls[id].banked))   types.push('bank');
  if (potted.some(id => !balls[id].cueStruck)) types.push('combo');
  if (potted.length >= 2) types.push('multi');
  if (types.length === 0) return;
  const earned = window.Progression.recordShot(types);
  showProgressToast(earned);
  updateTokenHUD();
}

// Replay one logged action to completion SYNCHRONOUSLY (no animation). Used by
// spectators / reconnects to fast-forward from the seed to the live state, running
// the exact same deterministic physics + endTurn the live clients ran.
function applyActionInstant(a) {
  if (a.type === 'place') {
    const b = balls[0];
    b.x=a.x; b.y=a.y; b.vx=b.vy=0; b.active=true; b.falling=false;
    freeBall=false; gState=S.AIM;
    return;
  }
  if (a.type === 'shot') {
    spinX=a.spinX; spinY=a.spinY;
    shooting=true; gState=S.SHOOT;
    startPhysics(a.tx, a.ty, a.power);
    let guard=0;
    while (!stepPhysics() && guard++ < 200000) { /* run substeps to rest */ }
    for (let i=0;i<balls.length;i++) if (balls[i].active && balls[i].falling) balls[i].active=false;
    shooting=false; spinX=0; spinY=0;
    endTurn();
  }
}

function start(){
  resetGame();      // populate balls[] so render() has valid data
  gState = S.INIT;  // override back to lobby state (lobby overlay stays visible)
  initPlayerName(); // prompt for name if first visit, otherwise load from localStorage
  gameLoop();
  document.getElementById('status').textContent = 'Pool';
  updateTokenHUD();   // show current token balance in the store button
}

// Kick off if images somehow all errored immediately
setTimeout(()=>{ if(loaded>=NEED&&gState===S.INIT) start(); },3000);

// ─── LOBBY ──────────────────────────────────────────────────────────────────
function showLobby() {
  setGeometry('');   // reset to pool table size (620) so the lobby fills the canvas
  render();          // repaint immediately at the restored size
  document.getElementById('lobby').style.display = 'flex';
  document.getElementById('backBtn').style.display = 'none';
  document.getElementById('onlinePanel').style.display = 'none';
  document.getElementById('countPanel').style.display = 'none';
  const rb = document.getElementById('restartBtn');
  if(rb) rb.style.display = 'none';
  // Restore player panels
  const p1 = document.getElementById('p1box'), p2 = document.getElementById('p2box');
  if(p1) p1.style.visibility=''; if(p2) p2.style.visibility='';
  // Stop any running game gracefully
  physState = null; shooting = false; mdown = false; isViewer = false;
  clearInterval(pwrTimer);
  stopShotClock();
  hideGameOver();
  document.getElementById('bottom-row').classList.remove('show');
  gState = S.INIT;
}

function hideLobby() {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('backBtn').style.display = '';
}

// Switch the lobby between single-player (sp) and multiplayer (mp) tabs
function showLobbyTab(which) {
  const sp = which === 'sp';
  document.getElementById('tabSP').classList.toggle('active', sp);
  document.getElementById('tabMP').classList.toggle('active', !sp);
  document.getElementById('spView').classList.toggle('active', sp);
  document.getElementById('mpView').classList.toggle('active', !sp);
  document.getElementById('lobbyTitle').textContent =
    sp ? 'Valitse yksinpeli:' : 'Valitse moninpeli:';
  document.getElementById('onlinePanel').style.display = 'none';
}

// ─── SHOT CLOCK (Aika) — multiplayer per-turn countdown ──────────────────────
function stopShotClock() {
  if (shotClockTimer) { clearInterval(shotClockTimer); shotClockTimer = null; }
}
function renderShotClock() {
  const el = document.getElementById('shotClock');
  if (!el) return;
  const left = Math.max(0, shotClockLeft);
  el.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
  el.classList.toggle('low', shotClockLeft <= 10);
}
function startShotClock() {
  stopShotClock();
  shotClockLeft = shotClockMax;
  renderShotClock();
  shotClockTimer = setInterval(() => {
    shotClockLeft--;
    renderShotClock();
    if (shotClockLeft <= 0) { stopShotClock(); onShotClockTimeout(); }
  }, 1000);
}
function onShotClockTimeout() {
  if (gameMode === 'hotseat') {
    showMsg('Aika loppui! Vuoro vaihtuu.', 1800);   // time up → turn passes
    freeBall = true; balls[0].active = false; curP = 1 - curP;
    firstHit = -1; pocketed = []; cueScratch = false;
    gState = S.PLACE; updateUI();
  } else {
    showMsg('Aika loppui!', 1500);  // online enforcement arrives with the server
  }
}

// Luovuta (concede) — current player forfeits, opponent wins
function concedeGame() {
  if (gState === S.DONE || winner >= 0) return;
  if (gameMode !== 'hotseat' && gameMode !== 'online') return;
  const loser = (gameMode === 'online' && net) ? net.playerIndex : curP;
  winner = 1 - loser;
  stopShotClock();
  gState = S.DONE; updateUI();
  showGameOver(displayName(winner) + ' Wins!', displayName(loser) + ' conceded (luovutti)');
}

// Poistu (leave) — exit the current game back to the lobby
function leaveGame() {
  stopShotClock();
  showLobby();
}

function restartGame() {
  physState = null; shooting = false; mdown = false;
  clearInterval(pwrTimer);
  hideGameOver();
  resetGame(gameMode);
}

function startMode(mode) {
  hideLobby();
  hideGameOver();
  // Show chat only for multiplayer modes
  document.getElementById('bottom-row').classList.toggle('show',
    mode === 'hotseat' || mode === 'online');
  clearChat();
  updateInfoBarNames(mode);
  resetGame(mode);
}

// ─── PLAYER NAMES ────────────────────────────────────────────────────────────
let localPlayer = '';      // this device's player name (q+xxx format)
let opponentName = '';     // online opponent's name

function initPlayerName() {
  const stored = localStorage.getItem('poolPlayerName');
  if (stored) {
    localPlayer = stored;
  } else {
    // Show name setup overlay before the lobby
    document.getElementById('name-setup').style.display = 'flex';
  }
}

function saveName() {
  const inp = document.getElementById('name-input');
  let raw = (inp.value || '').trim();
  if (!raw) raw = 'Guest' + Math.floor(Math.random() * 9000 + 1000);
  localPlayer = 'q+' + raw;
  localStorage.setItem('poolPlayerName', localPlayer);
  document.getElementById('name-setup').style.display = 'none';
  updateInfoBarNames(gameMode);
}

function displayName(idx) {
  if (gameMode === 'online' && net) {
    return idx === net.playerIndex ? (localPlayer || 'You') : (opponentName || 'Opponent');
  }
  return idx === 0 ? (localPlayer || 'Player 1') : 'Player 2';
}

function updateInfoBarNames(mode) {
  // Update the .pname elements in the player info boxes
  const p1name = document.querySelector('#p1box .pname');
  const p2name = document.querySelector('#p2box .pname');
  if (!p1name || !p2name) return;
  if (mode === 'online' && net) {
    p1name.textContent = net.playerIndex === 0 ? (localPlayer || 'You') : (opponentName || 'Opponent');
    p2name.textContent = net.playerIndex === 1 ? (localPlayer || 'You') : (opponentName || 'Opponent');
  } else {
    p1name.textContent = localPlayer || 'Player 1';
    p2name.textContent = 'Player 2';
  }
}

// ─── GAME-OVER DIALOG ────────────────────────────────────────────────────────
function showGameOver(title, sub) {
  document.getElementById('game-over-title').textContent = title;
  document.getElementById('game-over-sub').textContent = sub || '';
  document.getElementById('game-over').style.display = 'flex';
  // Win/lose/draw jingle (game-win.au / game-lose.au / game-draw.au)
  let snd = 'game-win';
  if (winner < 0) snd = 'game-draw';
  else if (gameMode === 'online' && net && net.playerIndex >= 0) snd = (winner === net.playerIndex) ? 'game-win' : 'game-lose';
  Sound.end(snd);
}

function hideGameOver() {
  document.getElementById('game-over').style.display = 'none';
}

// ─── CHAT ────────────────────────────────────────────────────────────────────
function clearChat() {
  document.getElementById('chat-msgs').innerHTML = '';
}

function addChatMsg(type, sender, text) {
  const area = document.getElementById('chat-msgs');
  const div = document.createElement('div');
  div.className = 'cm-' + type;
  div.textContent = sender ? sender + ': ' + text : text;
  area.appendChild(div);
  // Auto-scroll to bottom
  area.scrollTop = area.scrollHeight;
}

function sendChatMsg() {
  const inp = document.getElementById('chat-input');
  const txt = inp.value.trim();
  if (!txt) return;
  inp.value = '';
  if (gameMode === 'online' && net && net.connected) {
    net.sendChat(txt);
    addChatMsg('p1', localPlayer || 'You', txt);
  } else if (gameMode === 'hotseat') {
    const cls = curP === 0 ? 'p1' : 'p2';
    addChatMsg(cls, displayName(curP), txt);
  }
}

function chatKeyDown(e) {
  if (e.key === 'Enter') { e.preventDefault(); sendChatMsg(); }
}

function openCountPanel() {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('countPanel').style.display = 'flex';
}
function closeCountPanel() {
  document.getElementById('countPanel').style.display = 'none';
  document.getElementById('lobby').style.display = 'flex';
}
function startCount(target) {
  countTarget = target;
  document.getElementById('countPanel').style.display = 'none';
  startMode('count');
}

let poolLobby = null;
function openOnlinePanel() {
  if (!net || !net.connected) {
    document.getElementById('srvStatus').textContent = 'Server: offline — start server.js first';
    return;
  }
  // Preferred: the shared platform Lobby (player-list challenge UI). The module
  // bootstrap exposes it as window.PlatformLobby; fall back to the create/join panel
  // if modules didn't load (e.g. opened from file://).
  if (window.PlatformLobby) {
    if (poolLobby) return;
    poolLobby = new window.PlatformLobby({
      net, me: localPlayer || 'q+Guest', game: 'pool', title: 'Kasapallo',
      onClose: () => { poolLobby = null; },
    });
    poolLobby.mount(document.body);
  } else {
    document.getElementById('onlinePanel').style.display = 'flex';
  }
}
function closeOnlinePanel() {
  document.getElementById('onlinePanel').style.display = 'none';
}
function createOnlineRoom() {
  if (!net || !net.connected) return;
  net.createRoom();
}
function joinOnlineRoom() {
  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  if (code.length < 4 || !net || !net.connected) return;
  net.joinRoom(code);
}

// ─── NETWORK (WebSocket client for server.js) ────────────────────────────────
// Protocol: JSON messages over WebSocket to ws://localhost:8080
// Run: node server.js  (see server.js in project root)
class Network {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.playerIndex = -1;
    this.roomId = null;
    this._subs = {};   // event bus for the lobby (type → [cb])
  }

  // ── event bus (the platform Lobby subscribes here) ──
  on(type, cb)  { (this._subs[type] || (this._subs[type] = [])).push(cb); }
  off(type, cb) { const a = this._subs[type]; if (a) { const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); } }
  _emit(type, msg) { (this._subs[type] || []).forEach(cb => { try { cb(msg); } catch (e) { console.error(e); } }); }

  // ── lobby presence + challenge (server.js protocol) ──
  enterLobby(game)  { this.send({ type: 'hello', name: localPlayer || 'q+Guest', game }); }
  sendChallenge(id) { this.send({ type: 'challenge', to: id }); }
  sendAccept(from)  { this.send({ type: 'accept', from }); }
  sendDecline(from) { this.send({ type: 'decline', from }); }
  sendCancel(to)    { this.send({ type: 'cancel', to }); }
  sendLobbyChat(m)  { this.send({ type: 'lobbychat', msg: m }); }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
        this.ws.onopen = () => { this.connected = true; resolve(); };
        this.ws.onerror = () => reject(new Error('ws error'));
        this.ws.onclose = () => {
          this.connected = false;
          document.getElementById('srvStatus').textContent = 'Server: disconnected';
          document.getElementById('srvStatus').style.color = '#e94560';
        };
        this.ws.onmessage = e => this._handle(JSON.parse(e.data));
      } catch(err) { reject(err); }
    });
  }

  send(obj) { if (this.connected) this.ws.send(JSON.stringify(obj)); }
  createRoom() { this.send({ type:'create', mode:'8ball', name: localPlayer||'q+Guest' }); }
  joinRoom(id)  { this.send({ type:'join', room:id, name: localPlayer||'q+Guest' }); }
  sendShot(tx, ty, power, sx, sy) {
    this.send({ type:'shot', tx, ty, power, spinX:sx, spinY:sy });
  }
  sendPlace(x, y) { this.send({ type:'place', x, y }); }
  sendChat(msg)   { this.send({ type:'chat', msg }); }
  watch(room)     { this.send({ type:'watch', room }); }

  _handle(msg) {
    this._emit(msg.type, msg);   // feed the lobby bus (lobby/games/challenged/start/…)
    switch(msg.type) {
      case 'room':
        this.playerIndex = msg.player;
        this.roomId = msg.id;
        document.getElementById('myRoomCode').textContent = msg.id;
        break;
      case 'start': {
        const seed = msg.seed;
        opponentName = msg.names ? msg.names[1 - this.playerIndex] : 'Opponent';
        hideLobby();
        hideGameOver();
        gameMode = 'online';
        isViewer = false;
        document.getElementById('bottom-row').classList.add('show');
        clearChat();
        addChatMsg('sys', '', 'Game started! Room: ' + (this.roomId||''));
        setGeometry('');   // online is always 8-ball → pool geometry/friction
        balls = Array.from({length:16},(_,i)=>mkBall(i));
        curP = 0; group = [-1,-1]; winner = -1; freeBall = false;
        rackSeeded(seed);
        balls[0].x=175; balls[0].y=165; balls[0].active=true;
        gState = S.AIM;
        updateInfoBarNames('online');
        updateUI();
        break;
      }
      // Lockstep: apply for EVERYONE (incl. the actor's own echo and spectators),
      // in the server's order. The actor did NOT simulate locally — it applies here.
      case 'shot':
        spinX = msg.spinX; spinY = msg.spinY;
        shooting = true; gState = S.SHOOT; updateUI();
        startPhysics(msg.tx, msg.ty, msg.power);
        spinX = 0; spinY = 0;
        if (typeof drawSpinPanel === 'function') drawSpinPanel();
        break;
      case 'place': {
        const b = balls[0];
        b.x=msg.x; b.y=msg.y; b.vx=b.vy=0;
        b.active=true; b.falling=false; freeBall=false;
        gState=S.AIM; updateUI();
        break;
      }
      // Spectator / reconnect catch-up: rebuild from seed, replay the action log to
      // the live state, then stream subsequent shot/place like any lockstep client.
      case 'replay': {
        isViewer = true;
        gameMode = 'online';
        this.playerIndex = -1;
        hideLobby(); hideGameOver();
        document.getElementById('bottom-row').classList.add('show');
        clearChat();
        addChatMsg('sys', '', 'Katsot peliä: ' + (msg.names ? msg.names.join(' vs ') : ''));
        setGeometry('');   // online is always 8-ball → pool geometry/friction
        balls = Array.from({length:16},(_,i)=>mkBall(i));
        curP = 0; group = [-1,-1]; winner = -1; freeBall = false;
        rackSeeded(msg.seed);
        balls[0].x=175; balls[0].y=165; balls[0].active=true;
        gState = S.AIM;
        document.getElementById('p1name').textContent = (msg.names && msg.names[0]) || 'P1';
        document.getElementById('p2name').textContent = (msg.names && msg.names[1]) || 'P2';
        replaying = true;                                  // mute the fast-forward
        for (const a of (msg.actions || [])) applyActionInstant(a);
        replaying = false;
        updateUI();
        break;
      }
      case 'chat':
        // Server broadcasts to all; the sender already echoed locally, so skip own.
        if (msg.player !== this.playerIndex) {
          addChatMsg('p2', opponentName || 'Opponent', msg.msg);
        }
        break;
      case 'opponent_left':
        addChatMsg('sys', '', isViewer ? 'Game ended.' : 'Opponent disconnected.');
        showMsg(isViewer ? 'Game ended.' : 'Opponent disconnected.', 4000);
        isViewer = false;
        showLobby();
        break;
    }
  }
}

// Try connecting to local server on load; silently fail if not running.
// The WS server shares the page's HTTP server, so derive the URL from location — this
// works on ANY port (8080, 8765, …). Falls back to localhost:8080 when opened via file://.
let net = null;
(async () => {
  try {
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = location.host ? `${wsProto}://${location.host}` : 'ws://localhost:8080';
    net = new Network(wsUrl);
    await net.connect();
    document.getElementById('srvStatus').textContent = 'Server: online';
    document.getElementById('srvStatus').style.color = '#4ac88a';
    document.getElementById('onlineCard').classList.remove('dis');
  } catch(_) {
    document.getElementById('srvStatus').textContent = 'Server: offline';
    net = null;
  }
})();

// ─── SPIN BALL PANEL ────────────────────────────────────────────────────────
// Matches GameSpinBallPanel.java: 125×100, centre (62,55), radius 37, dead zone ±2
const spinC   = document.getElementById('spinc');
const spinCtx = spinC.getContext('2d');

// Load spinball.png without blocking game start
const spinImg = new Image();
spinImg.onload = () => drawSpinPanel();
spinImg.src = P + 'spinball.png';

function drawSpinPanel() {
  if (spinImg.complete && spinImg.naturalWidth > 0) {
    spinCtx.drawImage(spinImg, 0, 0, 125, 100);
  } else {
    // Fallback: draw a simple cue ball on dark background
    spinCtx.fillStyle = '#0d2a1f';
    spinCtx.fillRect(0, 0, 125, 100);
    spinCtx.beginPath();
    spinCtx.arc(62, 55, 37, 0, Math.PI*2);
    spinCtx.fillStyle = '#e8e8e8';
    spinCtx.fill();
    spinCtx.strokeStyle = '#888'; spinCtx.lineWidth = 1; spinCtx.stroke();
    spinCtx.fillStyle = '#333'; spinCtx.font = 'bold 10px Arial';
    spinCtx.textAlign = 'center'; spinCtx.textBaseline = 'top';
    spinCtx.fillText('SPIN', 62, 4);
  }
  // Grey crosshair lines (like the Java paint code)
  spinCtx.strokeStyle = 'rgba(192,192,192,0.8)';
  spinCtx.lineWidth = 1;
  spinCtx.beginPath();
  spinCtx.moveTo(43, 55); spinCtx.lineTo(81, 55);
  spinCtx.moveTo(62, 36); spinCtx.lineTo(62, 74);
  spinCtx.stroke();
  // Red crosshair at current spin position
  const sx = Math.round(spinX * 79 / 2);
  const sy = Math.round(spinY * 79 / 2);
  spinCtx.strokeStyle = 'rgba(220,0,0,0.95)';
  spinCtx.lineWidth = 2;
  spinCtx.beginPath();
  spinCtx.moveTo(62+sx-4, 55+sy); spinCtx.lineTo(62+sx+4, 55+sy);
  spinCtx.moveTo(62+sx,   55+sy-4); spinCtx.lineTo(62+sx,   55+sy+4);
  spinCtx.stroke();
}

spinC.addEventListener('click', e => {
  const r = spinC.getBoundingClientRect();
  const cx = (e.clientX - r.left) * 125 / r.width;
  const cy = (e.clientY - r.top)  * 100 / r.height;
  let dx = cx - 62, dy = cy - 55;
  if (Math.sqrt(dx*dx + dy*dy) > 37) return;
  if (Math.abs(dx) <= 2) dx = 0;
  if (Math.abs(dy) <= 2) dy = 0;
  spinX = 2 * dx / 79;
  spinY = 2 * dy / 79;
  drawSpinPanel();
});

spinC.addEventListener('dblclick', e => {
  spinX = 0; spinY = 0;
  drawSpinPanel();
});

drawSpinPanel();

// ─── BALL STATUS INDICATORS ──────────────────────────────────────────────────
function makeBallDot(ballId, potted) {
  const cvs = document.createElement('canvas');
  cvs.width = 14; cvs.height = 14;
  cvs.className = 'bi ' + (potted ? 'potted' : 'on-table');
  cvs.title = ballId >= 16 ? SNKNAM[ballId] + ' (' + SNKVAL[ballId] + 'pts)' : 'Ball ' + ballId;
  const c = cvs.getContext('2d');
  if (imgs.snookerBalls && ballId >= 16) {
    // Snooker colour ball from snooker sprite
    const frame = ballId - 14;
    const sw = imgs.snookerBalls.width / 8;
    c.drawImage(imgs.snookerBalls, frame*sw, 0, sw, imgs.snookerBalls.height, 0, 0, 14, 14);
  } else if (imgs.snookerBalls && ballId >= 1 && ballId <= 15 && gameMode === 'snooker') {
    // Red ball from snooker sprite (frame 1)
    const sw = imgs.snookerBalls.width / 8;
    c.drawImage(imgs.snookerBalls, sw, 0, sw, imgs.snookerBalls.height, 0, 0, 14, 14);
  } else if (imgs.balls && ballId < 16) {
    const sw = imgs.balls.width / 16;
    c.drawImage(imgs.balls, ballId * sw, 0, sw, imgs.balls.height, 0, 0, 14, 14);
  } else {
    const col = ballId >= 16 ? SNKCLR[ballId-16] :
                ballId === 0  ? '#e8e8e8' :
                gameMode === 'snooker' ? '#cc1111' : (BCLR[ballId] || '#888');
    c.beginPath(); c.arc(7, 7, 6, 0, Math.PI * 2);
    c.fillStyle = col; c.fill();
    c.strokeStyle = '#333'; c.lineWidth = 1; c.stroke();
    if (ballId >= 16) {
      c.fillStyle = (ballId===21||ballId===17) ? '#ddd' : '#fff';
      c.font = 'bold 6px Arial';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(SNKVAL[ballId], 7, 7);
    }
  }
  return cvs;
}

function updateBallIndicators() {
  const p1row = document.getElementById('p1balls');
  const p2row = document.getElementById('p2balls');
  const strip = document.getElementById('ball-strip');
  if (!p1row || !p2row || !strip) return;

  if (gameMode === 'snooker') {
    p1row.innerHTML = ''; p2row.innerHTML = '';
    strip.style.display = 'flex';
    strip.innerHTML = '';
    // Reds: show a count badge instead of 15 individual dots
    const redsLeft = balls.slice(1,16).filter(b=>b.active).length;
    const redDot = makeBallDot(1, redsLeft===0);
    redDot.title = `Reds: ${redsLeft} remaining`;
    strip.appendChild(redDot);
    const badge = document.createElement('span');
    badge.style.cssText = 'font-size:10px;color:#ccc;margin:0 4px;align-self:center';
    badge.textContent = `×${redsLeft}`;
    strip.appendChild(badge);
    // 6 colour balls
    for (let id = 16; id <= 21; id++) {
      strip.appendChild(makeBallDot(id, !(balls[id] && balls[id].active)));
    }
    return;
  }

  if (gameMode === 'practice' || gameMode === 'count') {
    p1row.innerHTML = ''; p2row.innerHTML = '';
    strip.style.display = 'flex';
    strip.innerHTML = '';
    for (let i = 1; i <= 15; i++) {
      strip.appendChild(makeBallDot(i, !(balls[i] && balls[i].active)));
    }
  } else if (gameMode === '9ball') {
    p1row.innerHTML = ''; p2row.innerHTML = '';
    strip.style.display = 'flex';
    strip.innerHTML = '';
    for (let i = 1; i <= 9; i++) {
      strip.appendChild(makeBallDot(i, !(balls[i] && balls[i].active)));
    }
  } else if (gameMode === '10ball') {
    p1row.innerHTML = ''; p2row.innerHTML = '';
    strip.style.display = 'flex';
    strip.innerHTML = '';
    for (let i = 1; i <= 10; i++) {
      strip.appendChild(makeBallDot(i, !(balls[i] && balls[i].active)));
    }
  } else if (gameMode === 'hotseat' || gameMode === 'online') {
    strip.style.display = 'none';
    strip.innerHTML = '';
    if (group[0] === -1) {
      // Groups not yet assigned — hide both ball rows until first pot decides them
      p1row.innerHTML = '';
      p2row.innerHTML = '';
    } else {
      const render = (el, ids) => {
        el.innerHTML = '';
        for (const i of ids) {
          el.appendChild(makeBallDot(i, !(balls[i] && balls[i].active)));
        }
      };
      render(p1row, group[0] === 0 ? [1,2,3,4,5,6,7] : [9,10,11,12,13,14,15]);
      render(p2row, group[1] === 0 ? [1,2,3,4,5,6,7] : [9,10,11,12,13,14,15]);
    }
  } else {
    strip.style.display = 'none';
  }
}

// ─── SCORE LEADERBOARD ───────────────────────────────────────────────────────
function saveScore(shots, target) {
  const key = 'poolCountScores';
  let scores = [];
  try { scores = JSON.parse(localStorage.getItem(key) || '[]'); } catch(_) {}
  scores.push({ player: localPlayer || 'q+Guest', shots, target, ts: Date.now() });
  localStorage.setItem(key, JSON.stringify(scores));
  showSbTab(document.querySelector('.sb-tab.active')?.dataset.tab || 'alltime');
}

function showSbTab(tab) {
  document.querySelectorAll('.sb-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  let scores = [];
  try { scores = JSON.parse(localStorage.getItem('poolCountScores') || '[]'); } catch(_) {}
  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const weekStart = now - 7 * 86400000;
  let filtered = scores.filter(s => s.target === (countTarget || s.target));
  if (tab === 'today')  filtered = filtered.filter(s => s.ts >= todayStart.getTime());
  if (tab === 'week')   filtered = filtered.filter(s => s.ts >= weekStart);
  if (tab === 'mine')   filtered = filtered.filter(s => s.player === (localPlayer || 'q+Guest'));
  filtered.sort((a,b) => a.shots - b.shots);
  renderSb(filtered.slice(0, 20));
}

function renderSb(records) {
  const body = document.getElementById('sb-body');
  if (!body) return;
  if (!records.length) {
    body.innerHTML = '<div style="padding:10px;color:#4a6a80;font-size:11px;text-align:center">No scores yet</div>';
    return;
  }
  body.innerHTML = records.map((r, i) => {
    const d = new Date(r.ts);
    const ds = d.toLocaleDateString(undefined, { month:'short', day:'numeric' });
    const name = r.player.startsWith('q+') ? r.player.slice(2) : r.player;
    return `<div class="sb-row"><span style="width:18px;color:#3a5a70">${i+1}.</span><span style="flex:1;color:#8ab0c0">${name}</span><span style="color:#f5d800">${r.shots} shots</span><span style="color:#3a5a70;margin-left:6px">${ds}</span></div>`;
  }).join('');
}

function showScoreboard(visible) {
  const sb = document.getElementById('scoreboard');
  if (!sb) return;
  const wasHidden = sb.style.display === 'none' || !sb.style.display;
  sb.style.display = visible ? 'block' : 'none';
  // Only init the active tab when first revealing the scoreboard
  if (visible && wasHidden) {
    const activeTab = document.querySelector('.sb-tab.active')?.dataset.tab || 'alltime';
    showSbTab(activeTab);
  }
}

// ─── RACK MODE ───────────────────────────────────────────────────────────────
let rackBallId = -1;

function enterRackMode() {
  hideGameOver();
  const panel = document.getElementById('rack-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  rackBallId = -1;
  populateRackBalls();
  gState = S.PLACE;
}

function populateRackBalls() {
  const row = document.getElementById('rack-balls-row');
  if (!row) return;
  row.innerHTML = '';
  for (let i = 1; i <= 15; i++) {
    const cvs = makeBallDot(i, true);
    cvs.className = 'bi rack-avail' + (rackBallId === i ? ' rack-sel' : '');
    cvs.dataset.ball = i;
    cvs.title = 'Ball ' + i;
    cvs.onclick = () => selectRackBall(i);
    row.appendChild(cvs);
  }
}

function selectRackBall(id) {
  rackBallId = id;
  populateRackBalls();
}

function finishRack() {
  const panel = document.getElementById('rack-panel');
  if (panel) panel.style.display = 'none';
  rackBallId = -1;
  // Make sure cue ball is active
  if (!balls[0].active) {
    balls[0].x = 175; balls[0].y = 165;
    balls[0].active = true; balls[0].falling = false;
  }
  pocketed = []; firstHit = -1; cueScratch = false;
  gState = S.AIM;
  updateUI();
  updateBallIndicators();
}

function clearRack() {
  for (let i = 1; i <= 15; i++) {
    balls[i].active = false;
  }
  populateRackBalls();
  updateBallIndicators();
}

// Canvas click in rack mode: place selected ball (capture phase, runs before existing handlers)
canvas.addEventListener('mousedown', e => {
  if (rackBallId < 1) return;
  // Consume the event so the cue-ball placement handler doesn't also fire
  e.stopImmediatePropagation();
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width  / rect.width;
  const sy = canvas.height / rect.height;
  const cx = (e.clientX - rect.left) * sx;
  const cy = (e.clientY - rect.top)  * sy;
  if (cx < BORDER+BALL_R || cx > TW-BORDER-BALL_R) return;
  if (cy < BORDER+BALL_R || cy > TH-BORDER-BALL_R) return;
  for (let i = 0; i < balls.length; i++) {
    if (i === rackBallId || !balls[i].active) continue;
    const dx = balls[i].x - cx, dy = balls[i].y - cy;
    if (dx*dx + dy*dy < BALL_D*BALL_D) return;
  }
  balls[rackBallId].x = cx; balls[rackBallId].y = cy;
  balls[rackBallId].vx = 0; balls[rackBallId].vy = 0;
  balls[rackBallId].active = true; balls[rackBallId].falling = false;
  rackBallId = -1;
  populateRackBalls();
  updateBallIndicators();
}, true);

// ─── PATCH updateUI TO REFRESH INDICATORS + SCOREBOARD ───────────────────────
const _origUpdateUI = updateUI;
function updateUI_withExtras() {
  _origUpdateUI();
  updateBallIndicators();
  showScoreboard(gameMode === 'count');
}
updateUI = updateUI_withExtras;

// ─── PATCH endTurn FOR PRACTICE COMPLETION + COUNT SCORE SAVE ────────────────
const _origEndTurn = endTurn;
var endTurn = function() {
  _origEndTurn();

  if (gameMode === 'practice' && gState !== S.DONE) {
    const allClear = balls.slice(1).every(b => !b.active);
    if (allClear) {
      gState = S.DONE; winner = 0;
      const rackBtn = document.getElementById('gobtn-rack');
      if (rackBtn) rackBtn.style.display = '';
      showGameOver('Table Clear!', 'All balls potted — play again or place balls manually');
      updateUI();
    }
  }

  if (gameMode === 'count' && gState === S.DONE && !window._scoreSaved) {
    window._scoreSaved = true;
    saveScore(countShots, countTarget);
  }
};

// Reset the score-saved flag on game restart
const _origResetGame = resetGame;
resetGame = function(mode) {
  window._scoreSaved = false;
  const rackBtn = document.getElementById('gobtn-rack');
  if (rackBtn) rackBtn.style.display = 'none';
  const panel = document.getElementById('rack-panel');
  if (panel) panel.style.display = 'none';
  rackBallId = -1;
  _origResetGame(mode);
};
