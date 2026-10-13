// Pool 3D view: a three.js renderer layered over the existing engine (game.js).
//
// game.js stays the single source of truth: rules, assists, progression and online lockstep
// run unchanged. This module only
//   • READS engine state every frame (balls[], gState, mx/my, power, spin…) and draws it;
//   • WRITES input back the way the 2D board does: synthetic mouse events on #gc, so cue-ball
//     placement, shooting and online intents all go through the engine's own handlers. In
//     the cue camera the aim point (mx,my) is set from the camera heading instead;
//   • REUSES the engine's 2D overlay drawing (Guide/assist lines, placement guides): it is
//     rendered into #gc at 2× and laid on the cloth as a texture. The basic aim line, ghost
//     ball and ball directions are drawn in 3D (updateAimAid).
// The table (cushion faces, jaws, round pockets) comes from tablegeom.js, the same geometry
// the realistic physics collides with, so what you see is what the balls bounce off.
//
// Engine globals used (classic-script lexical scope is shared with modules): balls gState S
// TW TH BALL_R BALL_D PCAPT BORDER gameMode mx my mdown power spinX spinY freeBall
// rackBallId countPoints countTarget countShots ctx isValidPlacement
// localControlsTurn applyAssist drawAimAssist drawAssistChain drawSpinPanel HEAD_STRING_X
// SNK_BAULK_X SNK_D_CY SNK_D_R SNOOKER_SPOTS POOL_FOOT_X POOL_FOOT_Y

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildTable as buildGeometry, inPoly } from './tablegeom.js';

const OVERLAY_SCALE = 2;       // #gc supersampling while it serves as the cloth overlay
const DEG = Math.PI / 180;
const RAIL_EXT = 8;            // wood beyond the mask's outer edge (px)

const POOL_COLORS = ['#f4f1e8', '#f2b705', '#1c3fa6', '#d0201b', '#4a2380', '#ef6a12',
  '#0e7a3a', '#7a1e22', '#111111', '#f2b705', '#1c3fa6', '#d0201b', '#4a2380', '#ef6a12',
  '#0e7a3a', '#7a1e22'];
const SNOOKER_COLORS = { cue: '#f4f1e8', red: '#b3141b', 16: '#ecc417', 17: '#13803a',
  18: '#6e4122', 19: '#1d43c4', 20: '#ec7fae', 21: '#121212' };
const FELT = { pool: '#177a2b', snooker: '#08858d' };
const WOOD = '#6b3518', WOOD_DARK = '#3b1d0d', LEATHER = '#2a1c12', POCKET_DARK = '#070707';

let active = false;
let T = null;            // three.js singletons (renderer, scene, camera, …)
let table = null;        // per-geometry objects (rebuilt when pool ↔ snooker)
let gc = null, wrap = null, hud = null, origRender = null, savedHint = null;
let ballTex = {};        // texture cache

// Camera / aim state. Distances are in ball diameters so pool and snooker feel the same.
const view = {
  user: 'aim',           // 'aim' (behind the cue ball) | 'top' (overhead, point to aim)
  yaw: null,             // raw aim heading in table coords (radians)
  pitch: 10 * DEG, dist: 7,     // player's eye: ~7 ball widths behind the cue ball, just over the cue
  bcYaw: -Math.PI / 2, bcPitch: 40 * DEG,   // broadcast view (orbitable)
  ballsRef: null, lastState: -1, lastEff: 'broadcast',
  strikeAt: 0, strikePower: 50,
  gap: 0, sawT0: null, stroke: null,   // cue stroke state (see cueGap)
  shotFrom: null,        // { x, y, yaw } of the cue ball at the strike — the "stand up" pivot
};
window.poolCue = window.poolCue || { elevation: 5 };   // read by physics-real.js
const cam = { pos: new THREE.Vector3(), target: new THREE.Vector3(), ready: false };
const input = { drag: null, forwarding: false, lastTable: null, spaceDown: false, rightShot: false };

export function isEnabled() { return active; }

export function enable() {
  if (active) return;
  gc = document.getElementById('gc');
  wrap = document.getElementById('canvas-wrap');
  if (!gc || !wrap) return;
  if (!T) initThree();
  active = true;
  document.body.classList.add('v3d');
  wrap.insertBefore(T.renderer.domElement, wrap.firstChild);
  wrap.appendChild(hud);
  const hint = document.getElementById('hint');
  if (hint) { savedHint = hint.innerHTML; hint.innerHTML = 'Drag to aim · hold <b>Space</b> or right mouse to charge, release to shoot.<br><b>V</b> view · <b>[ ]</b> cue angle · wheel zoom.'; }
  origRender = window.render;
  window.render = renderFrame;
  window.addEventListener('resize', layout);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  cam.ready = false;
  layout();
  if (balls && balls.length) renderFrame();
}

export function disable() {
  if (!active) return;
  active = false;
  if (origRender) window.render = origRender;
  document.body.classList.remove('v3d');
  T.renderer.domElement.remove();
  hud.remove();
  const hint = document.getElementById('hint');
  if (hint && savedHint != null) hint.innerHTML = savedHint;
  window.removeEventListener('resize', layout);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp, true);
  if (input.spaceDown) releaseShot();
  if (view.stroke) finishStroke();          // don't leave a shot half-released
  delete window.poolCue.effective;
  gc.width = TW; gc.height = TH;
  gc.style.width = gc.style.height = '';
  const gw = document.getElementById('game-wrap');
  if (gw) { gw.style.removeProperty('--bw'); gw.style.removeProperty('--bh'); }
  if (typeof render === 'function') render();
}

// ─── layout ──────────────────────────────────────────────────────────────────────────
function layout() {
  if (!active) return;
  const gw = document.getElementById('game-wrap');
  const bottom = document.getElementById('bottom-row');
  const chrome = 62 + (bottom && bottom.classList.contains('show') ? 120 : 0) + 24;
  const avW = Math.max(620, window.innerWidth - 135 - 24);
  const avH = Math.max(330, window.innerHeight - chrome);
  let w = Math.min(avW, 1240), h = Math.round(w * 0.58);
  if (h > avH) { h = avH; w = Math.max(620, Math.min(avW, Math.round(h / 0.58))); }
  gw.style.setProperty('--bw', w + 'px');
  gw.style.setProperty('--bh', h + 'px');
  T.renderer.setSize(w, h, false);
  T.camera.aspect = w / h;
  T.camera.updateProjectionMatrix();
}

// ─── three.js setup ─────────────────────────────────────────────────────────────────
function initThree() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.id = 'v3d-canvas';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1a1512');
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.3;

  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 1, 12000);

  scene.add(new THREE.HemisphereLight('#fff4e0', '#3a2a1c', 0.3));
  const key = new THREE.DirectionalLight('#fff6e8', 1.7);
  key.position.set(60, 900, 140);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.6;
  key.shadow.radius = 3;
  scene.add(key, key.target);
  const fill1 = new THREE.PointLight('#ffe2b8', 0.3, 0, 0);
  const fill2 = fill1.clone();
  scene.add(fill1, fill2);

  T = { renderer, scene, camera, key, fill1, fill2, raycaster: new THREE.Raycaster(), room: null };
  buildRoom();
  buildHud();
  bindPointer(renderer.domElement);
}

function canvasTex(w, h, draw, opts = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (opts.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(opts.repeat[0], opts.repeat[1]); }
  return t;
}

function noise(g, w, h, amt) {
  const img = g.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amt;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

function woodGrain(g, w, h, base, vertical) {
  g.fillStyle = base; g.fillRect(0, 0, w, h);
  const L = vertical ? h : w, S = vertical ? w : h;
  for (let i = 0; i < S * 0.9; i++) {
    const p = Math.random() * S, a = 0.04 + Math.random() * 0.1;
    g.strokeStyle = Math.random() < 0.5 ? `rgba(30,12,4,${a})` : `rgba(255,200,140,${a * 0.5})`;
    g.lineWidth = 0.5 + Math.random() * 2;
    g.beginPath();
    for (let s = 0; s <= L; s += 24) {
      const q = p + Math.sin(s / 90 + p) * 3;
      if (vertical) (s ? g.lineTo(q, s) : g.moveTo(q, s)); else (s ? g.lineTo(s, q) : g.moveTo(s, q));
    }
    g.stroke();
  }
}

function buildRoom() {
  const floorY = -300;
  const room = new THREE.Group();
  const planks = canvasTex(1024, 1024, (g, w, h) => {
    for (let r = 0; r < 8; r++) {
      const off = (r % 2) * 300;
      for (let x = -off; x < w; x += 600) {
        g.save(); g.beginPath(); g.rect(x, r * 128, 600, 128); g.clip();
        woodGrain(g, w, h, ['#5a3a22', '#634126', '#4f321d'][(r + x / 600 + 3) % 3 | 0], false);
        g.restore();
        g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 3; g.strokeRect(x, r * 128, 600, 128);
      }
    }
  }, { repeat: [5, 5] });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(5200, 5200),
    new THREE.MeshStandardMaterial({ map: planks, roughness: 0.55 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = floorY; floor.receiveShadow = true;
  room.add(floor);

  // Rug under the table.
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(1500, 1050), new THREE.MeshStandardMaterial({
    roughness: 1, map: canvasTex(512, 360, (g, w, h) => {
      g.fillStyle = '#5b1a1a'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#c9a25a'; g.lineWidth = 10; g.strokeRect(18, 18, w - 36, h - 36);
      g.strokeStyle = '#1d3b52'; g.lineWidth = 16; g.strokeRect(44, 44, w - 88, h - 88);
      g.fillStyle = '#7a2a22';
      for (let i = 0; i < 26; i++) { g.beginPath(); g.arc(80 + Math.random() * (w - 160), 80 + Math.random() * (h - 160), 6 + Math.random() * 14, 0, 7); g.fill(); }
      noise(g, w, h, 26);
    }),
  }));
  rug.rotation.x = -Math.PI / 2; rug.position.y = floorY + 0.5; rug.receiveShadow = true;
  room.add(rug);

  // Walls: plaster with a wood wainscot; one accent brick wall.
  const wallH = 1500, roomW = 4200, roomD = 3200;
  const plaster = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#d8d2c6'; g.fillRect(0, 0, w, h);
    noise(g, w, h, 14);
    g.fillStyle = '#4a2b17'; g.fillRect(0, h * 0.8, w, h * 0.2);
    g.fillStyle = '#2d190c'; g.fillRect(0, h * 0.8, w, 6);
  }, { repeat: [4, 1] });
  const brick = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#9b9187'; g.fillRect(0, 0, w, h);
    const bh = 32, bw = 96;
    for (let r = 0; r < h / bh; r++) for (let c = -1; c < w / bw + 1; c++) {
      const x = c * bw + (r % 2) * bw / 2;
      const t = 0.75 + Math.random() * 0.35;
      g.fillStyle = `rgb(${150 * t | 0},${62 * t | 0},${44 * t | 0})`;
      g.fillRect(x + 3, r * bh + 3, bw - 6, bh - 6);
    }
    noise(g, w, h, 30);
  }, { repeat: [7, 3] });
  const mk = (map, w, rotY, x, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, wallH), new THREE.MeshStandardMaterial({ map, roughness: 0.9 }));
    m.position.set(x, floorY + wallH / 2, z); m.rotation.y = rotY; room.add(m);
  };
  mk(plaster, roomW, 0, 0, -roomD / 2);
  mk(plaster, roomW, Math.PI, 0, roomD / 2);
  mk(brick, roomD, Math.PI / 2, -roomW / 2, 0);
  mk(plaster, roomD, -Math.PI / 2, roomW / 2, 0);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(roomW, roomD), new THREE.MeshStandardMaterial({ color: '#2a2622', roughness: 1 }));
  ceil.rotation.x = Math.PI / 2; ceil.position.y = floorY + wallH; room.add(ceil);

  // Framed pictures on the back wall.
  for (const [x, hue] of [[-900, 200], [500, 25]]) {
    const pic = new THREE.Mesh(new THREE.BoxGeometry(520, 330, 10), [
      ...Array(4).fill(new THREE.MeshStandardMaterial({ color: '#4a3010' })),
      new THREE.MeshStandardMaterial({ roughness: 0.7, map: canvasTex(256, 160, (g, w, h) => {
        const gr = g.createLinearGradient(0, 0, w, h);
        gr.addColorStop(0, `hsl(${hue},45%,35%)`); gr.addColorStop(1, `hsl(${hue + 40},35%,15%)`);
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
        for (let i = 0; i < 40; i++) { g.fillStyle = `hsla(${hue + Math.random() * 80},50%,${30 + Math.random() * 40}%,.35)`; g.beginPath(); g.arc(Math.random() * w, Math.random() * h, 4 + Math.random() * 24, 0, 7); g.fill(); }
        g.strokeStyle = '#b8892c'; g.lineWidth = 12; g.strokeRect(0, 0, w, h);
      }) }),
      new THREE.MeshStandardMaterial({ color: '#4a3010' }),
    ]);
    pic.position.set(x, floorY + 820, -roomD / 2 + 8); room.add(pic);
  }

  // Pendant lamp over the table.
  const lamp = new THREE.Group();
  const shadeMat = new THREE.MeshStandardMaterial({ color: '#173d22', roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
  const bulbMat = new THREE.MeshBasicMaterial({ color: '#fff3d6' });
  for (const x of [-210, 0, 210]) {
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(26, 70, 52, 32, 1, true), shadeMat);
    shade.position.set(x, 0, 0); lamp.add(shade);
    const bulb = new THREE.Mesh(new THREE.CircleGeometry(24, 24), bulbMat);
    bulb.rotation.x = Math.PI / 2; bulb.position.set(x, -20, 0); lamp.add(bulb);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(520, 8, 8), new THREE.MeshStandardMaterial({ color: '#b08a3a', metalness: 0.8, roughness: 0.3 }));
  bar.position.y = 30; lamp.add(bar);
  for (const x of [-230, 230]) {
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 700, 6), bar.material);
    rod.position.set(x, 380, 0); lamp.add(rod);
  }
  T.scene.add(lamp);            // height is set per table (buildTable)
  T.lamp = lamp;

  T.scene.add(room);
  T.room = room;
}

// ─── table (rebuilt for pool / snooker) ─────────────────────────────────────────────
function buildTable() {
  if (table) {
    T.scene.remove(table.group);
    table.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }
  const key = gameMode === 'snooker' ? 'snooker' : 'pool';
  const geo = buildGeometry({ mode: key, TW, TH, R: BALL_R });
  const R = BALL_R;
  const hCush = R * 1.28, hRail = hCush + R * 0.3, ext = RAIL_EXT;
  const g = new THREE.Group();
  g.position.set(-TW / 2, 0, -TH / 2);

  const nearPocket = (x, y, pad) => geo.pockets.some(p => Math.hypot(x - p.x, y - p.y) < p.r + pad);
  const inTable = (x, y) => x >= -ext && y >= -ext && x <= TW + ext && y <= TH + ext;

  // Cloth (the bed, with the pocket holes cut out).
  const feltTex = makeFeltTexture(key);
  const feltMat = new THREE.MeshStandardMaterial({ map: feltTex, roughness: 0.95 });
  const feltUV = (x, y) => [x / TW, 1 - y / TH];
  const felt = new THREE.Mesh(capGeometry(geo.felt, [], 0, feltUV), feltMat);
  felt.receiveShadow = true;
  g.add(felt);

  // Cushions: cloth-covered tops and faces (the jaws too).
  const feltCol = new THREE.Color(FELT[key]);
  const faceCol = '#' + feltCol.clone().multiplyScalar(0.72).getHexString();
  const cushTop = new THREE.MeshStandardMaterial({ map: feltTex, color: '#cfcfcf', roughness: 0.95 });
  const wallMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  for (const ring of geo.cushions) {
    const top = new THREE.Mesh(capGeometry(ring, [], hCush, feltUV), cushTop);
    top.receiveShadow = true; g.add(top);
    const side = new THREE.Mesh(wallGeometry([ring], 0, hCush, (x, y) => inPoly(ring, x, y), () => faceCol), wallMat);
    side.receiveShadow = true; g.add(side);
  }

  // Wooden rail around everything, cut out for cloth + cushions + pockets; leather-lined
  // pocket cuts, diamonds and leather pocket surrounds in its texture.
  const outer = [[-ext, -ext], [TW + ext, -ext], [TW + ext, TH + ext], [-ext, TH + ext]];
  const railTex = makeRailTexture(geo, ext);
  const railUV = (x, y) => [(x + ext) / (TW + 2 * ext), 1 - (y + ext) / (TH + 2 * ext)];
  const rail = new THREE.Mesh(capGeometry(outer, [geo.opening], hRail, railUV),
    new THREE.MeshStandardMaterial({ map: railTex, roughness: 0.35, metalness: 0.05 }));
  rail.castShadow = true; rail.receiveShadow = true; g.add(rail);
  const railSolid = (x, y) => inTable(x, y) && !inPoly(geo.opening, x, y);
  g.add(new THREE.Mesh(wallGeometry([outer], 0, hRail, railSolid, () => WOOD), wallMat));
  g.add(new THREE.Mesh(wallGeometry([geo.opening], 0, hRail, railSolid,
    (x, y) => (nearPocket(x, y, 8) ? LEATHER : WOOD), true), wallMat));

  // Pocket wells: round holes, dark and deep enough to swallow a ball.
  const depth = BALL_D * 1.6;
  const pocketMat = new THREE.MeshStandardMaterial({ color: POCKET_DARK, roughness: 1 });
  for (const p of geo.pockets) {
    const ring = [];
    for (let i = 0; i < 40; i++) ring.push([p.x + Math.cos(i / 40 * Math.PI * 2) * p.r, p.y + Math.sin(i / 40 * Math.PI * 2) * p.r]);
    g.add(new THREE.Mesh(wallGeometry([ring], -depth, 0.01, (x, y) => Math.hypot(x - p.x, y - p.y) > p.r, () => POCKET_DARK, true), wallMat));
    g.add(new THREE.Mesh(capGeometry(ring, [], -depth, () => [0, 0]), pocketMat));
  }

  // Apron, cabinet and legs (sized from the table, not the ball: the frame is the same
  // furniture for pool and snooker).
  const woodMat = new THREE.MeshStandardMaterial({ roughness: 0.45, map: canvasTex(512, 128, (c, w, h) => woodGrain(c, w, h, WOOD, false)) });
  const darkMat = new THREE.MeshStandardMaterial({ color: WOOD_DARK, roughness: 0.6 });
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  // Real tables put the cloth ~13½ ball widths above the floor (snooker ~16½); the room and
  // lamp follow, so a regulation-size rack sits on a regulation-height table.
  const tableH = (key === 'snooker' ? 16.4 : 13.5) * BALL_D;
  T.room.position.y = 300 - tableH;                 // the room's floor is built at y = −300
  T.lamp.position.y = Math.max(16 * BALL_D, 190);
  T.fill1.position.set(-210, T.lamp.position.y - 30, 0);
  T.fill2.position.set(210, T.lamp.position.y - 30, 0);
  const W = TW + 2 * ext, H = TH + 2 * ext, apronH = Math.round(tableH * 0.18), bodyH = Math.round(tableH * 0.24);
  const apron = new THREE.Mesh(new THREE.BoxGeometry(W, apronH, H),
    [woodMat, woodMat, hidden, woodMat, woodMat, woodMat]);
  apron.position.set(TW / 2, -apronH / 2, TH / 2);
  apron.castShadow = true; g.add(apron);
  const body = new THREE.Mesh(new THREE.BoxGeometry(W - 40, bodyH, H - 40), darkMat);
  body.position.set(TW / 2, -apronH - bodyH / 2, TH / 2); body.castShadow = true; g.add(body);
  const legH = tableH - apronH - bodyH;
  for (const [lx, lz] of [[40, 40], [TW - 40, 40], [40, TH - 40], [TW - 40, TH - 40], [TW / 2, 40], [TW / 2, TH - 40]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(46, legH, 46), woodMat);
    leg.position.set(lx, -apronH - bodyH - legH / 2, lz); leg.castShadow = true; g.add(leg);
  }

  // Balls.
  const sphere = new THREE.SphereGeometry(R, 48, 32);
  const meshes = [];
  for (let i = 0; i < balls.length; i++) {
    const m = new THREE.Mesh(sphere, ballMaterial(key, i));
    m.castShadow = true;
    m.quaternion.setFromEuler(new THREE.Euler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3));
    m.userData = { last: null, q: null };
    g.add(m); meshes.push(m);
  }

  // Ghost ball (cue-ball placement / rack placement).
  const ghost = new THREE.Mesh(sphere, new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.45, roughness: 0.3 }));
  ghost.visible = false; g.add(ghost);

  // Overlay: the engine's 2D guide drawing (#gc) laid on the cloth.
  const overlayTex = new THREE.CanvasTexture(gc);
  overlayTex.colorSpace = THREE.SRGBColorSpace;
  overlayTex.anisotropy = 8;
  const overlay = new THREE.Mesh(new THREE.PlaneGeometry(TW, TH), new THREE.MeshBasicMaterial({
    map: overlayTex, transparent: true, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  overlay.rotation.x = -Math.PI / 2;
  overlay.position.set(TW / 2, 0.15, TH / 2);
  overlay.renderOrder = 2;
  g.add(overlay);

  const cue = buildCue(R);
  g.add(cue);
  const cueR0 = R * 0.24, cueR1 = R * 0.62, cueL = Math.min(26 * 2 * R, 0.62 * TW);   // as buildCue

  T.scene.add(g);

  // Shadow frustum tight around the table.
  const sc = T.key.shadow.camera;
  sc.left = -TW / 2 - 120; sc.right = TW / 2 + 120; sc.top = TH / 2 + 120; sc.bottom = -TH / 2 - 120;
  sc.near = 300; sc.far = 1400; sc.updateProjectionMatrix();

  const aim = buildAimAid(R);
  g.add(aim.group);

  table = { key, tw: TW, r: R, group: g, geo, meshes, ghost, overlay, overlayTex, cue, cueR0, cueR1, cueL, aim, ballsRef: balls, hRail, hCush };
  cam.ready = false;
}

function capGeometry(outer, holes, y, uv) {
  const toV = r => r.map(p => new THREE.Vector2(p[0], p[1]));
  const o = toV(outer), hs = holes.map(toV);
  const tris = THREE.ShapeUtils.triangulateShape(o, hs);
  const verts = o.concat(...hs);
  const pos = [], uvs = [], nor = [], idx = [];
  for (const v of verts) { pos.push(v.x, y, v.y); nor.push(0, 1, 0); uvs.push(...uv(v.x, v.y)); }
  for (const [a, b, c] of tris) {
    const A = verts[a], B = verts[b], C = verts[c];
    const up = (B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y);
    if (up >= 0) idx.push(a, b, c); else idx.push(a, c, b);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(idx);
  return geom;
}

// Vertical walls along rings; each face points away from the solid side and takes the
// colour of whatever lies in front of it (cloth bed, pocket, …).
function wallGeometry(rings, y0, y1, solidAt, colorAt, smooth = false) {
  const pos = [], nor = [], col = [], c = new THREE.Color();
  for (const r of rings) {
  const segN = [];
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    let nx = dy / len, ny = -dx / len;
    const mx_ = (p[0] + q[0]) / 2, my_ = (p[1] + q[1]) / 2;
    if (solidAt(mx_ + nx * 0.9, my_ + ny * 0.9)) { nx = -nx; ny = -ny; }
    c.set(colorAt(mx_ + nx * 1.5, my_ + ny * 1.5));
    segN.push([nx, ny, c.r, c.g, c.b, i]);
  }
  for (let k = 0; k < segN.length; k++) {
    const [nx, ny, cr, cg, cb, i] = segN[k];
    const p = r[i], q = r[(i + 1) % r.length];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    // Curved rings (pocket wells) get averaged vertex normals so they shade round.
    const avg = (o) => {
      if (!smooth) return [nx, ny];
      const m = segN[(k + o + segN.length) % segN.length];
      const ax = nx + m[0], ay = ny + m[1], l = Math.hypot(ax, ay) || 1;
      return [ax / l, ay / l];
    };
    const nP = avg(-1), nQ = avg(1);
    let P0 = [p[0], y0, p[1], ...nP], Q0 = [q[0], y0, q[1], ...nQ], Q1 = [q[0], y1, q[1], ...nQ], P1 = [p[0], y1, p[1], ...nP];
    // (P1−P0)×(Q1−P0) = H·(dy, 0, −dx): flip the quad when that faces away from n.
    if (dy * nx - dx * ny < 0) { [P0, Q0] = [Q0, P0]; [P1, Q1] = [Q1, P1]; }
    for (const v of [P0, Q1, Q0, P0, P1, Q1]) { pos.push(v[0], v[1], v[2]); nor.push(v[3], 0, v[4]); col.push(cr, cg, cb); }
  }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geom;
}

function makeFeltTexture(key) {
  const s = 3;
  return canvasTex(TW * s, TH * s, (g, w, h) => {
    g.fillStyle = FELT[key]; g.fillRect(0, 0, w, h);
    const rg = g.createRadialGradient(w / 2, h / 2, h * 0.1, w / 2, h / 2, w * 0.6);
    rg.addColorStop(0, 'rgba(255,255,255,0.07)'); rg.addColorStop(1, 'rgba(0,0,0,0.12)');
    g.fillStyle = rg; g.fillRect(0, 0, w, h);
    noise(g, w, h, 10);
    g.scale(s, s);
    g.strokeStyle = 'rgba(255,255,255,0.75)'; g.fillStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 0.6;
    if (key === 'snooker') {
      g.beginPath(); g.moveTo(SNK_BAULK_X, BORDER); g.lineTo(SNK_BAULK_X, TH - BORDER); g.stroke();
      g.beginPath(); g.arc(SNK_BAULK_X, SNK_D_CY, SNK_D_R, Math.PI / 2, Math.PI * 1.5); g.stroke();
      for (const id of [16, 17, 18, 19, 20, 21]) {
        const p = SNOOKER_SPOTS[id]; g.beginPath(); g.arc(p.x, p.y, 0.9, 0, 7); g.fill();
      }
    } else {
      g.beginPath(); g.arc(POOL_FOOT_X, POOL_FOOT_Y, 1.1, 0, 7); g.fill();
      g.beginPath(); g.arc(HEAD_STRING_X, TH / 2, 1.1, 0, 7); g.fill();
    }
  });
}

function makeRailTexture(geo, ext) {
  const s = 3, W = (TW + 2 * ext) * s, H = (TH + 2 * ext) * s;
  return canvasTex(W, H, (g) => {
    woodGrain(g, W, H, WOOD, false);
    // Vertical grain on the short rails.
    for (const x0 of [0, (TW + ext - 30) * s]) {
      g.save(); g.beginPath(); g.rect(x0, 0, (30 + ext) * s, H); g.clip();
      woodGrain(g, W, H, WOOD, true); g.restore();
    }
    // Leather pocket surrounds: a soft-edged ring around each hole.
    for (const p of geo.pockets) {
      const X = (p.x + ext) * s, Y = (p.y + ext) * s;
      const gr = g.createRadialGradient(X, Y, p.r * s, X, Y, (p.r + 7) * s);
      gr.addColorStop(0, LEATHER); gr.addColorStop(0.75, LEATHER); gr.addColorStop(1, 'rgba(42,28,18,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(X, Y, (p.r + 7) * s, 0, Math.PI * 2); g.fill();
    }
    // Diamonds (sights) at eighths of the long rails and quarters of the short ones.
    const f = geo.faces, railMid = (-ext + (f.T - geo.cushionWidth)) / 2;
    const px0 = geo.pockets[0].x, px2 = geo.pockets[2].x, py0 = geo.pockets[0].y, py1 = geo.pockets[5].y;
    g.fillStyle = '#efe6cf';
    const diamond = (x, y) => {
      const X = (x + ext) * s, Y = (y + ext) * s, r = 2.2 * s;
      g.beginPath(); g.moveTo(X, Y - r); g.lineTo(X + r * 0.6, Y); g.lineTo(X, Y + r); g.lineTo(X - r * 0.6, Y); g.fill();
    };
    for (const k of [1, 2, 3, 5, 6, 7]) {
      const x = px0 + (k * (px2 - px0)) / 8;
      diamond(x, railMid); diamond(x, TH - railMid);
    }
    for (const k of [1, 2, 3]) {
      const y = py0 + (k * (py1 - py0)) / 4;
      diamond(railMid, y); diamond(TW - railMid, y);
    }
  });
}

// ─── balls ──────────────────────────────────────────────────────────────────────────
function ballMaterial(key, id) {
  let tk, spec;
  if (key === 'snooker') {
    if (id === 0) { tk = 'cue'; spec = { base: SNOOKER_COLORS.cue, dots: true }; }
    else if (id <= 15) { tk = 'red'; spec = { base: SNOOKER_COLORS.red }; }
    else { tk = 's' + id; spec = { base: SNOOKER_COLORS[id] }; }
  } else {
    tk = 'p' + id;
    spec = id === 0 ? { base: POOL_COLORS[0], dots: true }
      : id <= 8 ? { base: POOL_COLORS[id], num: id }
      : { base: '#f4f1e8', band: POOL_COLORS[id], num: id };
  }
  if (!ballTex[tk]) ballTex[tk] = makeBallTexture(spec);
  return new THREE.MeshPhysicalMaterial({ map: ballTex[tk], roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.05 });
}

// Equirectangular ball skin (u around the equator, v pole to pole).
function makeBallTexture({ base, band, num, dots }) {
  return canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    if (band) { g.fillStyle = band; g.fillRect(0, h / 2 - 50, w, 100); }
    if (dots) {
      g.fillStyle = '#c4161c';
      for (const u of [0.125, 0.375, 0.625, 0.875]) { g.beginPath(); g.ellipse(u * w, h / 2, 13, 13, 0, 0, 7); g.fill(); }
      g.fillRect(0, 0, w, 9); g.fillRect(0, h - 9, w, 9);
    }
    if (num) {
      for (const u of [0.25, 0.75]) {
        g.fillStyle = '#fbf8ef';
        g.beginPath(); g.ellipse(u * w, h / 2, 34, 34, 0, 0, 7); g.fill();
        g.fillStyle = '#151515';
        g.font = `bold ${num > 9 ? 34 : 40}px Arial, sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(num), u * w, h / 2 + 2);
        if (num === 6 || num === 9) g.fillRect(u * w - 10, h / 2 + 20, 20, 3);
      }
    }
  });
}

function updateBalls() {
  const q = new THREE.Quaternion(), axis = new THREE.Vector3(), qp = new THREE.Quaternion(), qn = new THREE.Quaternion();
  for (let i = 0; i < table.meshes.length; i++) {
    const m = table.meshes[i], b = balls[i];
    if (!b || !b.active) { m.visible = false; m.userData.last = null; m.userData.q = null; continue; }
    m.visible = true;
    let y = BALL_R;
    if (b.falling) y = BALL_R - Math.min(b.fp / PCAPT, 1) * BALL_D * 1.5;
    const last = m.userData.last;
    if (b.rq) {
      // Realistic physics integrates the true spin: apply its orientation change.
      // Pooltool frame (x, −y, z↑) → scene (x, z↑, y): (qx, qy, qz) → (qx, qz, −qy).
      qn.set(b.rq[0], b.rq[2], -b.rq[1], b.rq[3]);
      if (m.userData.q) { qp.copy(m.userData.q).invert(); q.multiplyQuaternions(qn, qp); m.quaternion.premultiply(q); }
      m.userData.q = (m.userData.q || new THREE.Quaternion()).copy(qn);
    } else if (last && !b.falling) {
      // Classic physics has no spin state: roll without slipping along the displacement.
      const dx = b.x - last.x, dz = b.y - last.y, d = Math.hypot(dx, dz);
      if (d > 1e-4 && d < BALL_D * 4) {
        axis.set(dz, 0, -dx).normalize();
        q.setFromAxisAngle(axis, d / BALL_R);
        m.quaternion.premultiply(q);
      }
    }
    m.userData.last = { x: b.x, y: b.y };
    m.position.set(b.x, y, b.y);
  }
}

// ─── cue stick ─────────────────────────────────────────────────────────────────────
function buildCue(R) {
  // ~26 ball widths long (a 58" cue for a 2¼" ball), tip ≈ ¼ R, butt ≈ ⅝ R.
  const L = Math.min(26 * 2 * R, 0.62 * TW), r0 = R * 0.24, r1 = R * 0.62;
  const rad = z => r0 + (r1 - r0) * (z / L);
  const cue = new THREE.Group();
  const part = (z0, z1, mat) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rad(z1), rad(z0), z1 - z0, 28), mat);
    m.rotation.x = Math.PI / 2;            // cylinder axis Y → Z; radiusTop ends up at +Z
    m.position.z = (z0 + z1) / 2;
    m.castShadow = true;
    cue.add(m);
  };
  const maple = new THREE.MeshStandardMaterial({ color: '#e8cf9c', roughness: 0.35 });
  part(0, R * 0.25, new THREE.MeshStandardMaterial({ color: '#2f5c8a', roughness: 0.9 }));
  part(R * 0.25, R * 1.2, new THREE.MeshStandardMaterial({ color: '#f5f2ea', roughness: 0.3 }));
  part(R * 1.2, L * 0.52, maple);
  part(L * 0.52, L * 0.535, new THREE.MeshStandardMaterial({ color: '#c9c9c9', metalness: 0.9, roughness: 0.25 }));
  part(L * 0.535, L * 0.72, new THREE.MeshStandardMaterial({ color: '#4a1d0e', roughness: 0.3 }));
  part(L * 0.72, L * 0.93, new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.8 }));
  part(L * 0.93, L, new THREE.MeshStandardMaterial({ color: '#2a0f06', roughness: 0.3 }));
  cue.visible = false;
  return cue;
}

// Lowest cue elevation (deg) that keeps the cue clear of the cushion, the rail and any ball
// behind the cue ball, for a tip contact at height R + vert, offset sideways by `side`.
function cueClearance(cx, cy, ax, ay, side, vert, into) {
  const f = table.geo.faces, bx = -ax, by = -ay, R = BALL_R, hc = R + vert;
  const cueR = x => table.cueR0 + (table.cueR1 - table.cueR0) * Math.min(1, Math.max(0, x) / table.cueL) + 0.4;
  let need = 0;

  // Cushion nose and rail: the cue rises from the contact point, so the binding spots are where
  // it passes over the cushion nose and the start of the wooden rail.
  let t = Infinity;                                  // ball centre → cushion line, behind the ball
  if (bx < -1e-6) t = Math.min(t, (f.L - cx) / bx); else if (bx > 1e-6) t = Math.min(t, (f.R - cx) / bx);
  if (by < -1e-6) t = Math.min(t, (f.T - cy) / by); else if (by > 1e-6) t = Math.min(t, (f.B - cy) / by);
  const x = t - into;
  if (x <= 0.3) return 85;
  need = Math.max(need,
    Math.atan2(table.hCush + cueR(x) - hc, x),
    Math.atan2(table.hRail + cueR(x) - hc, x + table.geo.cushionWidth));

  // Balls behind the cue ball: the cue line (in the vertical plane through the cue, rising at θ
  // from the contact point) must pass at least R + cue radius from each ball's centre.
  for (let i = 1; i < balls.length; i++) {
    const b = balls[i];
    if (!b.active || b.falling) continue;
    const ox = b.x - cx, oy = b.y - cy;
    const back = -(ox * ax + oy * ay) - into;        // along the cue, from the contact point
    if (back < -R || back > table.cueL) continue;
    const lat = Math.abs(ox * -ay + oy * ax - side);  // sideways from the cue's plane
    const clear = R + cueR(back);
    if (lat >= clear) continue;
    const D = Math.sqrt(clear * clear - lat * lat);   // required in-plane distance
    const A = back, B = hc - R, H = Math.hypot(A, B);
    if (D >= H) return 85;                           // ball right behind the tip: as steep as it gets
    need = Math.max(need, Math.asin(D / H) - Math.atan2(B, A));
  }
  return Math.min(85, Math.max(0, need) / DEG);
}

// Cue stroke, in "gap" = distance from the tip back to the contact point on the ball:
//   aiming     — the tip rests a little behind the ball;
//   charging   — practice strokes (sawing), longer as the power builds;
//   release    — the stick drives forward; the shot is fired when the tip reaches the ball;
//   follow-through — the tip carries on through where the ball was (never into it).
const STROKE_MS = 700;                    // one practice stroke (back and forth)

function cueGap(now, dt) {
  const R = BALL_R, rest = R * 1.3;
  let target;
  if (view.stroke) {
    // Accelerating drive from wherever the stick was to the ball.
    const st = view.stroke, k = Math.min(1, (now - st.t0) / st.ms);
    view.gap = st.from * (1 - k * k);
    if (k >= 1) finishStroke();
    return view.gap;
  }
  if (mdown) {
    if (view.sawT0 == null) view.sawT0 = now;
    const amp = R * (0.8 + 2.6 * power / 100);
    const ph = ((now - view.sawT0) / STROKE_MS) * Math.PI * 2;
    target = rest * 0.6 + amp * (0.5 - 0.5 * Math.cos(ph));
  } else {
    view.sawT0 = null;
    target = shooting ? 0 : rest;           // online: hold at the ball until the server echoes
  }
  view.gap += (target - view.gap) * Math.min(1, dt * 14);
  return view.gap;
}

// Begin the final stroke; `fireShot` releases the engine's shot when the tip meets the ball.
function startStroke(fireShot) {
  if (view.stroke) return;
  const p = power;
  view.stroke = { t0: performance.now(), from: view.gap, power: p, fire: fireShot,
    ms: 70 + view.gap / (BALL_R * 3.4) * (150 - p) };
}
function finishStroke() {
  const st = view.stroke;
  view.stroke = null;
  power = st.power;                         // the engine kept charging during the drive
  view.strikePower = st.power;
  st.fire();
}

function updateCue(now, dt) {
  const cue = table.cue, cu = balls[0];
  const myTurn = localControlsTurn();
  const aiming = gState === S.AIM && myTurn && cu && cu.active && mx >= 0;
  const t = now - view.strikeAt, striking = t < 650;
  if (!aiming && !striking) { cue.visible = false; return; }
  // While aiming the cue follows the cue ball; during the follow-through it stays where the
  // ball was struck (the ball rolls away from it).
  const cx = aiming ? cu.x : view.strikeCx, cy = aiming ? cu.y : view.strikeCy;
  const dx = (aiming ? mx : view.strikeMx) - cx, dy = (aiming ? my : view.strikeMy) - cy;
  const len = Math.hypot(dx, dy);
  if (len < 1 || cx == null) { cue.visible = false; return; }
  const ax = dx / len, ay = dy / len, R = BALL_R;
  const sx = (aiming ? spinX : view.strikeSpinX), sy = (aiming ? spinY : view.strikeSpinY);
  const side = sx * R * 0.5, vert = -sy * R * 0.5;
  const into = Math.sqrt(Math.max(R * R - side * side - vert * vert, 0));
  let gap, elevDeg;
  if (aiming) {
    gap = cueGap(now, dt);
    // Raise the cue as far as needed to clear the rail and balls (published for the physics).
    view.railMin = cueClearance(cx, cy, ax, ay, side, vert, into);
    elevDeg = Math.max(window.poolCue.elevation, view.railMin);
    window.poolCue.effective = elevDeg;
  } else {
    // Follow-through: ease past the contact point, further on harder shots, but never into
    // the (possibly slow) cue ball, then lift away.
    const reach = R * (0.6 + 3.4 * (view.strikePower || 50) / 100);
    const k = Math.min(1, t / 140);
    gap = -reach * (1 - (1 - k) * (1 - k));
    const ballAhead = (cu ? (cu.x - cx) * ax + (cu.y - cy) * ay : Infinity);
    gap = Math.max(gap, -Math.max(0, ballAhead) - 0.2);
    elevDeg = view.strikeElev;
    view.gap = R * 1.3;                     // next aim starts from rest
  }
  const elev = elevDeg * DEG;
  const bx = -ax * Math.cos(elev), by = Math.sin(elev), bz = -ay * Math.cos(elev);
  // Contact point on the ball (offset by the spin), then back along the cue axis.
  const px = cx + (-ay) * side - ax * into + bx * gap;
  const py = R + vert + by * gap;
  const pz = cy + ax * side - ay * into + bz * gap;
  cue.position.set(px, py, pz);
  const target = table.group.localToWorld(new THREE.Vector3(px + bx, py + by, pz + bz));
  cue.lookAt(target);
  cue.visible = true;
  if (aiming) {
    view.strikeMx = mx; view.strikeMy = my;
    view.strikeSpinX = spinX; view.strikeSpinY = spinY;
    view.strikeCx = cu.x; view.strikeCy = cu.y; view.strikeElev = elevDeg;
  }
}

function updateGhost() {
  const gh = table.ghost;
  const placing = gState === S.PLACE && localControlsTurn() && mx >= 0;
  if (!placing) { gh.visible = false; return; }
  const racking = typeof rackBallId !== 'undefined' && rackBallId >= 1;
  const ok = racking || isValidPlacement(mx, my);
  gh.visible = true;
  gh.position.set(mx, BALL_R, my);
  gh.material.color.set(racking ? '#bfe3ff' : ok ? '#ffffff' : '#ff4040');
  gh.material.opacity = ok ? 0.55 : 0.35;
}

// ─── aim aid: line to the contact point, ghost ball, and where both balls head ──────
// Always on while aiming (the Guide button adds the engine's longer predicted paths).
function buildAimAid(R) {
  const group = new THREE.Group();
  const mk = (color, opacity, radius) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 10, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, toneMapped: false }));
    m.renderOrder = 3; group.add(m); return m;
  };
  const line = mk('#ffffff', 0.85, R * 0.07);
  const objLine = mk('#ffd23f', 0.9, R * 0.07);
  const cueLine = mk('#7fdcff', 0.75, R * 0.06);
  const ghost = new THREE.Mesh(new THREE.SphereGeometry(R, 32, 16), new THREE.MeshBasicMaterial({
    color: '#ffffff', transparent: true, opacity: 0.28, depthWrite: false, toneMapped: false }));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(R, R * 0.06, 6, 40), new THREE.MeshBasicMaterial({
    color: '#ffffff', transparent: true, opacity: 0.9, toneMapped: false }));
  ring.rotation.x = Math.PI / 2;
  group.add(ghost, ring);
  group.visible = false;
  return { group, line, objLine, cueLine, ghost, ring };
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
function placeLine(m, x1, z1, x2, z2, y) {
  _a.set(x1, y, z1); _b.set(x2, y, z2);
  const len = _a.distanceTo(_b);
  m.visible = len > 0.5;
  if (!m.visible) return;
  m.position.copy(_a).add(_b).multiplyScalar(0.5);
  m.scale.set(1, len, 1);
  m.quaternion.setFromUnitVectors(_up, _b.sub(_a).normalize());
}

// First thing the cue ball's centre meets along (dx,dy): a ball (at 2R) or a cushion (at R).
function castCue(cx, cy, dx, dy) {
  const R = BALL_R;
  let best = { t: 1e9, ball: -1 };
  for (let i = 1; i < balls.length; i++) {
    const b = balls[i];
    if (!b.active || b.falling) continue;
    const ox = b.x - cx, oy = b.y - cy, along = ox * dx + oy * dy;
    if (along <= 0) continue;
    const perp2 = ox * ox + oy * oy - along * along, rr = 4 * R * R;
    if (perp2 >= rr) continue;
    const t = along - Math.sqrt(rr - perp2);
    if (t > 0 && t < best.t) best = { t, ball: i };
  }
  for (const sg of table.geo.segs) {
    // Ray vs. capsule of radius R around the segment (sampled: offset lines + end caps).
    const t = rayCapsule(cx, cy, dx, dy, sg, R);
    if (t > 0 && t < best.t) best = { t, ball: -1 };
  }
  return best;
}

function rayCapsule(cx, cy, dx, dy, sg, R) {
  let best = Infinity;
  const ex = sg.x2 - sg.x1, ey = sg.y2 - sg.y1, L = Math.hypot(ex, ey);
  const ux = ex / L, uy = ey / L, nx = -uy, ny = ux;
  for (const side of [1, -1]) {
    const ox = sg.x1 + nx * R * side, oy = sg.y1 + ny * R * side;
    const den = dx * uy - dy * ux;                        // ray ∥ cushion → no hit
    if (Math.abs(den) < 1e-9) continue;
    const t = ((ox - cx) * uy - (oy - cy) * ux) / den;
    if (t <= 1e-6) continue;
    const s = (cx + dx * t - sg.x1) * ux + (cy + dy * t - sg.y1) * uy;
    if (s >= 0 && s <= L) best = Math.min(best, t);
  }
  for (const [px, py] of [[sg.x1, sg.y1], [sg.x2, sg.y2]]) {
    const ox = px - cx, oy = py - cy, along = ox * dx + oy * dy;
    const perp2 = ox * ox + oy * oy - along * along;
    if (along > 0 && perp2 < R * R) best = Math.min(best, along - Math.sqrt(R * R - perp2));
  }
  return best;
}

function updateAimAid() {
  const A = table.aim, cu = balls[0];
  const aiming = gState === S.AIM && localControlsTurn() && cu && cu.active && mx >= 0;
  const dx0 = mx - (cu ? cu.x : 0), dy0 = my - (cu ? cu.y : 0), len = Math.hypot(dx0, dy0);
  if (!aiming || len < 1) { A.group.visible = false; return; }
  A.group.visible = true;
  const R = BALL_R, dx = dx0 / len, dy = dy0 / len;
  const hit = castCue(cu.x, cu.y, dx, dy);
  const t = Math.min(hit.t, 2000);
  const gx = cu.x + dx * t, gy = cu.y + dy * t;
  placeLine(A.line, cu.x, cu.y, gx, gy, R);
  A.ghost.position.set(gx, R, gy);
  A.ring.position.set(gx, 0.4, gy);
  if (hit.ball > 0) {
    // Object ball leaves along the line of centres; the cue ball along the tangent (stun).
    const b = balls[hit.ball], nx = (b.x - gx) / (2 * R), ny = (b.y - gy) / (2 * R);
    const ol = BALL_D * 4;
    placeLine(A.objLine, b.x, b.y, b.x + nx * ol, b.y + ny * ol, R);
    const tx = dx - (dx * nx + dy * ny) * nx, ty = dy - (dx * nx + dy * ny) * ny, tl = Math.hypot(tx, ty);
    if (tl > 0.05) placeLine(A.cueLine, gx, gy, gx + (tx / tl) * BALL_D * 2.5 * tl, gy + (ty / tl) * BALL_D * 2.5 * tl, R);
    else A.cueLine.visible = false;
  } else {
    A.objLine.visible = false; A.cueLine.visible = false;
  }
}

// ─── the engine's overlay, re-targeted onto the cloth ──────────────────────────────
function drawOverlay() {
  const k = OVERLAY_SCALE;
  if (gc.width !== TW * k || gc.height !== TH * k) { gc.width = TW * k; gc.height = TH * k; }
  if (gc.style.width !== TW + 'px') { gc.style.width = TW + 'px'; gc.style.height = TH + 'px'; }
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, TW, TH);
  const myTurn = localControlsTurn();
  if (gState === S.AIM && myTurn && balls[0] && balls[0].active && mx >= 0) {
    drawAimAssist();
    drawAssistChain();
  }
  if (gState === S.PLACE && myTurn && gameMode !== 'snooker' && !freeBall) {
    ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(HEAD_STRING_X, BORDER); ctx.lineTo(HEAD_STRING_X, TH - BORDER); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  table.overlayTex.needsUpdate = true;
}

// ─── camera ─────────────────────────────────────────────────────────────────────────
function effectiveView() {
  const myTurn = localControlsTurn();
  if (gState === S.PLACE) return myTurn ? 'top' : 'broadcast';
  if (gState === S.AIM) return myTurn && balls[0] && balls[0].active ? view.user : 'broadcast';
  if (gState === S.SHOOT) return view.lastEff === 'aim' || view.lastEff === 'freeze' ? 'freeze' : view.lastEff === 'top' ? 'top' : 'broadcast';
  return 'broadcast';
}

function orbit(target, yaw, pitch, dist, out) {
  // yaw = heading the camera LOOKS along (table coords); the camera sits behind it.
  out.set(target.x - Math.cos(yaw) * Math.cos(pitch) * dist,
          target.y + Math.sin(pitch) * dist,
          target.z - Math.sin(yaw) * Math.cos(pitch) * dist);
  return out;
}

const _t = new THREE.Vector3(), _p = new THREE.Vector3();
const fitCache = new Map();
function fitDistance(yaw, pitch) {
  // Distance at which the whole table (with rails) fits the viewport.
  const ck = `${TW}|${T.camera.aspect.toFixed(3)}|${yaw.toFixed(3)}|${pitch.toFixed(3)}`;
  if (fitCache.has(ck)) return fitCache.get(ck);
  if (fitCache.size > 64) fitCache.clear();
  const cam2 = T.camera.clone(), ext = RAIL_EXT + 14;
  const corners = [[-TW / 2 - ext, -TH / 2 - ext], [TW / 2 + ext, -TH / 2 - ext], [TW / 2 + ext, TH / 2 + ext], [-TW / 2 - ext, TH / 2 + ext]];
  let d = 900;
  for (let it = 0; it < 4; it++) {
    orbit(_t.set(0, 0, 0), yaw, pitch, d, cam2.position);
    cam2.lookAt(0, 0, 0); cam2.updateMatrixWorld(); cam2.updateProjectionMatrix();
    let m = 0;
    for (const [x, z] of corners) {
      _p.set(x, table.hRail, z).project(cam2);
      m = Math.max(m, Math.abs(_p.x), Math.abs(_p.y));
    }
    d *= m / 0.92;
  }
  fitCache.set(ck, d);
  return d;
}

function updateCamera(dt) {
  const eff = effectiveView();
  const cu = balls[0];
  const wantPos = new THREE.Vector3(), wantTgt = new THREE.Vector3();
  const off = table.group.position;
  let rate = 5;
  if (eff === 'aim') {
    const yaw = Math.atan2(my - cu.y, mx - cu.x);
    // Keep the eye above the cue (which rises at the cue elevation) so it never fills the view,
    // and lean over the rail when the cue ball is close to it, like a player would.
    const f = table.geo.faces, bx = -Math.cos(yaw), by = -Math.sin(yaw);
    let edge = Infinity;                                   // cue ball → cushion line, behind it
    if (bx < -1e-6) edge = Math.min(edge, (f.L - cu.x) / bx); else if (bx > 1e-6) edge = Math.min(edge, (f.R - cu.x) / bx);
    if (by < -1e-6) edge = Math.min(edge, (f.T - cu.y) / by); else if (by > 1e-6) edge = Math.min(edge, (f.B - cu.y) / by);
    const overRail = edge < view.dist * BALL_D ? Math.atan2(table.hRail + BALL_R * 0.5 - BALL_R, Math.max(edge, 1)) : 0;
    const cueDeg = window.poolCue.effective != null ? window.poolCue.effective : window.poolCue.elevation;
    const pitch = Math.max(view.pitch, Math.min(cueDeg + 7, 82) * DEG, overRail);   // look down over a raised cue
    // A raised eye also steps back (as a player straightening over a jacked-up cue does), so
    // the cue ball and the table ahead both stay in view.
    const raise = Math.max(0, (pitch - view.pitch) / (70 * DEG));
    orbit(new THREE.Vector3(cu.x + off.x, BALL_R, cu.y + off.z), yaw, pitch, view.dist * BALL_D * (1 + 1.5 * raise), wantPos);
    wantPos.y = Math.max(wantPos.y, table.hRail + 4);
    // Look a little past the cue ball; the higher the eye, the further down the table.
    const ahead = BALL_D * (2.5 + 3.5 * raise);
    wantTgt.set(cu.x + Math.cos(yaw) * ahead + off.x, BALL_R, cu.y + Math.sin(yaw) * ahead + off.z);
    rate = input.drag ? 30 : 9;
  } else if (eff === 'freeze') {
    // After the strike the player steps back to take in the whole table, still facing
    // the way the shot went.
    const f = view.shotFrom;
    if (f) {
      const yaw = f.yaw, pitch = 50 * DEG;
      wantTgt.set(0, 0, 0);
      orbit(wantTgt, yaw, pitch, fitDistance(yaw, pitch) * 1.02, wantPos);
      rate = 2.2;
    } else { wantPos.copy(cam.pos); wantTgt.copy(cam.target); }
  } else if (eff === 'top') {
    wantTgt.set(0, 0, 18);
    orbit(wantTgt, -Math.PI / 2, 68 * DEG, fitDistance(-Math.PI / 2, 68 * DEG) * 0.98, wantPos);
  } else {
    wantTgt.set(0, 0, 0);
    orbit(wantTgt, view.bcYaw, view.bcPitch, fitDistance(view.bcYaw, view.bcPitch) * 1.04, wantPos);
    rate = input.drag ? 30 : 3;
  }
  if (!cam.ready) { cam.pos.copy(wantPos); cam.target.copy(wantTgt); cam.ready = true; }
  const k = 1 - Math.exp(-rate * dt);
  cam.pos.lerp(wantPos, k); cam.target.lerp(wantTgt, k);
  T.camera.position.copy(cam.pos);
  T.camera.lookAt(cam.target);
  T.lamp.visible = cam.pos.y < T.lamp.position.y - 60;   // don't let the shade block the overview
  if (eff !== 'freeze') view.lastEff = eff;
}

// ─── aim (cue camera) ───────────────────────────────────────────────────────────────
function updateAim() {
  const cu = balls[0];
  if (gState !== S.AIM || !cu || !cu.active || !localControlsTurn()) { view.lastState = gState; return; }
  if (view.yaw == null || view.lastState === S.PLACE) {
    // First aim of a rack (or right after placing the cue ball): face the rack / table.
    view.yaw = Math.atan2(TH / 2 - cu.y, TW * 0.72 - cu.x);
  }
  view.lastState = gState;
  if (effectiveView() !== 'aim') return;
  // Aim point a little ahead of the cue ball, kept on the table (the engine treats mx<0
  // as "no cursor", and only the direction matters to the shot).
  const c = Math.cos(view.yaw), s = Math.sin(view.yaw);
  let t = 80;
  if (c > 1e-6) t = Math.min(t, (TW - 2 - cu.x) / c); else if (c < -1e-6) t = Math.min(t, (2 - cu.x) / c);
  if (s > 1e-6) t = Math.min(t, (TH - 2 - cu.y) / s); else if (s < -1e-6) t = Math.min(t, (2 - cu.y) / s);
  t = Math.max(t, 8);
  mx = cu.x + c * t; my = cu.y + s * t;
  applyAssist();
}

// ─── HUD ────────────────────────────────────────────────────────────────────────────
function buildHud() {
  hud = document.createElement('div');
  hud.id = 'v3d-hud';
  hud.innerHTML = `
    <div class="v3d-views">
      <button data-v="aim" title="Cue camera (V)">&#127921; Cue</button>
      <button data-v="top" title="Overhead (V)">&#11015; Top</button>
    </div>
    <div class="v3d-count"></div>
    <div class="v3d-power"><div class="v3d-power-fill"></div><span>0%</span></div>
    <div class="v3d-elev" title="Cue elevation ([ / ])"><svg viewBox="0 0 64 34" width="64" height="34">
      <line x1="4" y1="30" x2="60" y2="30" stroke="#8fa" stroke-width="1"/>
      <line class="v3d-elev-cue" x1="58" y1="30" x2="8" y2="30" stroke="#e8cf9c" stroke-width="3" stroke-linecap="round"/>
      <circle cx="58" cy="27" r="3" fill="#fff"/></svg><span></span></div>
    <button class="v3d-shoot">Hold to shoot</button>`;
  hud.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => setUserView(b.dataset.v)));
  const shoot = hud.querySelector('.v3d-shoot');
  shoot.addEventListener('pointerdown', e => { e.preventDefault(); pressShot(); });
  shoot.addEventListener('pointerup', releaseShot);
  shoot.addEventListener('pointercancel', releaseShot);
  shoot.addEventListener('pointerleave', () => { if (input.spaceDown) releaseShot(); });
}

function setUserView(v) { view.user = v; }

function updateHud() {
  const eff = effectiveView();
  hud.querySelectorAll('[data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === view.user));
  const aiming = gState === S.AIM && localControlsTurn() && balls[0] && balls[0].active;
  const pw = hud.querySelector('.v3d-power');
  pw.style.display = aiming ? 'flex' : 'none';
  if (aiming) {
    const p = mdown ? power : 0;
    pw.querySelector('.v3d-power-fill').style.height = p + '%';
    pw.querySelector('.v3d-power-fill').style.background = `hsl(${120 - p * 1.2},90%,48%)`;
    pw.querySelector('span').textContent = p + '%';
  }
  const el = hud.querySelector('.v3d-elev');
  el.style.display = aiming && eff === 'aim' ? 'flex' : 'none';
  const e = window.poolCue.effective != null ? window.poolCue.effective : window.poolCue.elevation;
  const raised = view.railMin > window.poolCue.elevation + 0.5;
  el.querySelector('span').textContent = e.toFixed(0) + '°' + (raised ? ' · raised to clear ([ = hit higher)' : '');
  const line = el.querySelector('.v3d-elev-cue');
  line.setAttribute('x2', (58 - Math.cos(e * DEG) * 50).toFixed(1));
  line.setAttribute('y2', (30 - Math.sin(e * DEG) * 50).toFixed(1));
  hud.querySelector('.v3d-shoot').style.display = aiming && eff === 'aim' ? '' : 'none';
  const cnt = hud.querySelector('.v3d-count');
  const showCount = gameMode === 'count' && gState !== S.DONE && gState !== S.INIT;
  cnt.style.display = showCount ? '' : 'none';
  if (showCount) cnt.textContent = `${countPoints} / ${countTarget} pts · ${countShots} shots`;
}

// ─── input ──────────────────────────────────────────────────────────────────────────
// Forward a mouse event to #gc at table coords so the engine's own handlers run.
function fire(type, tx, ty, button = 0) {
  const r = gc.getBoundingClientRect();
  gc.dispatchEvent(new MouseEvent(type, {
    clientX: r.left + (tx * r.width) / TW, clientY: r.top + (ty * r.height) / TH,
    button, buttons: type === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true,
  }));
}

function tablePoint(e) {
  const el = T.renderer.domElement, r = el.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  T.raycaster.setFromCamera(ndc, T.camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BALL_R);
  const hit = new THREE.Vector3();
  if (!T.raycaster.ray.intersectPlane(plane, hit)) return null;
  return [hit.x + TW / 2, hit.z + TH / 2];
}

function bindPointer(el) {
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('pointerdown', e => {
    if (!active || !table) return;
    el.setPointerCapture(e.pointerId);
    const eff = effectiveView();
    if (eff === 'top') {
      const p = tablePoint(e);
      if (!p) return;
      input.forwarding = true; input.lastTable = p;
      fire('mousemove', p[0], p[1]);
      fire('mousedown', p[0], p[1], e.button === 2 ? 2 : 0);
    } else if (eff === 'aim' && e.button === 2) {
      input.rightShot = true;          // right button: hold to charge, release to shoot
      pressShot();
    } else if (eff === 'aim' || eff === 'broadcast') {
      input.drag = { x: e.clientX, y: e.clientY, view: eff };
      el.style.cursor = 'grabbing';
    }
  });
  el.addEventListener('pointermove', e => {
    if (!active || !table) return;
    const eff = effectiveView();
    if (input.drag) {
      const dx = e.clientX - input.drag.x, dy = e.clientY - input.drag.y;
      input.drag.x = e.clientX; input.drag.y = e.clientY;
      const fine = e.shiftKey ? 0.12 : 1;
      if (input.drag.view === 'aim' && eff === 'aim') {
        view.yaw += dx * 0.0042 * fine;
        view.pitch = clamp(view.pitch + dy * 0.004, 2 * DEG, 80 * DEG);
      } else if (input.drag.view === 'broadcast') {
        view.bcYaw += dx * 0.005;
        view.bcPitch = clamp(view.bcPitch + dy * 0.004, 12 * DEG, 85 * DEG);
      }
      return;
    }
    if (eff === 'top') {
      const p = tablePoint(e);
      if (p) { input.lastTable = p; fire('mousemove', p[0], p[1]); }
    }
  });
  const up = e => {
    if (input.rightShot) { input.rightShot = false; releaseShot(); }
    if (input.drag) { input.drag = null; el.style.cursor = ''; }
    if (input.forwarding) {
      input.forwarding = false;
      const p = input.lastTable || [mx, my], btn = e.button === 2 ? 2 : 0;
      if (mdown && gState === S.AIM) startStroke(() => fire('mouseup', p[0], p[1], btn));
      else fire('mouseup', p[0], p[1], btn);
    }
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', () => {
    if (!input.forwarding && !input.drag && effectiveView() === 'top') fire('mouseleave', 0, 0);
  });
  el.addEventListener('wheel', e => {
    if (!active) return;
    e.preventDefault();
    view.dist = clamp(view.dist * (1 + e.deltaY * 0.0012), 3, 40);
  }, { passive: false });
}

function typingTarget(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

function pressShot() {
  if (input.spaceDown || view.stroke || !table) return;
  if (gState !== S.AIM || !localControlsTurn() || mx < 0 || !balls[0] || !balls[0].active) return;
  input.spaceDown = true;
  fire('mousedown', mx, my, 0);
}
function releaseShot() {
  if (!input.spaceDown) return;
  input.spaceDown = false;
  startStroke(() => fire('mouseup', mx, my, 0));
}

function onKeyDown(e) {
  if (!active || typingTarget(e)) return;
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) pressShot(); return; }
  if (e.key === 'v' || e.key === 'V') { setUserView(view.user === 'aim' ? 'top' : 'aim'); return; }
  if (e.key === '[' || e.key === ']') {
    const c = window.poolCue;
    if (e.key === '[' && view.railMin > c.elevation + 0.5 && spinY > -0.9) {
      // The rail or a ball is holding the cue up: keep it low by striking higher on the ball
      // (topspin), as a player does when the cue ball is near a cushion.
      spinY = Math.max(-Math.sqrt(Math.max(0.88 - spinX * spinX, 0)), spinY - 0.12);
      drawSpinPanel();
      return;
    }
    c.elevation = clamp(c.elevation + (e.key === ']' ? 1 : -1), 0, 60);
    return;
  }
  if (effectiveView() === 'aim' && view.yaw != null) {
    const step = (e.shiftKey ? 0.05 : 0.5) * DEG;
    if (e.key === 'ArrowLeft') { view.yaw -= step; e.preventDefault(); }
    if (e.key === 'ArrowRight') { view.yaw += step; e.preventDefault(); }
    if (e.key === 'ArrowUp') { view.pitch = clamp(view.pitch + 2 * DEG, 2 * DEG, 80 * DEG); e.preventDefault(); }
    if (e.key === 'ArrowDown') { view.pitch = clamp(view.pitch - 2 * DEG, 2 * DEG, 80 * DEG); e.preventDefault(); }
  }
}
function onKeyUp(e) {
  if (!active) return;
  if (e.code === 'Space') { if (!typingTarget(e)) e.preventDefault(); releaseShot(); }
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ─── frame ──────────────────────────────────────────────────────────────────────────
let lastFrame = 0, prevState = -1;
function renderFrame() {
  if (!active) return origRender && origRender();
  const now = performance.now();
  const dt = Math.min(0.1, lastFrame ? (now - lastFrame) / 1000 : 0.016);
  lastFrame = now;
  const key = gameMode === 'snooker' ? 'snooker' : 'pool';
  if (!table || table.key !== key || table.tw !== TW || table.r !== BALL_R || table.meshes.length !== balls.length) buildTable();
  if (view.ballsRef !== balls) {          // new rack (resetGame builds a fresh balls[])
    view.ballsRef = balls; view.yaw = null;
    for (const m of table.meshes) { m.userData.last = null; m.userData.q = null; }
  }
  if (prevState === S.AIM && gState === S.SHOOT) {
    view.strikeAt = now;
    view.shotFrom = view.lastEff === 'aim' && view.strikeCx != null
      ? { x: view.strikeCx, y: view.strikeCy, yaw: Math.atan2(view.strikeMy - view.strikeCy, view.strikeMx - view.strikeCx) } : null;
  }
  prevState = gState;

  updateAim();
  drawOverlay();
  updateBalls();
  updateCue(now, dt);
  updateGhost();
  updateAimAid();
  updateCamera(dt);
  updateHud();
  T.renderer.render(T.scene, T.camera);
}
