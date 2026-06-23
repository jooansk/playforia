// GameShell — the shared multiplayer game chrome, ≈ Java `SPanel_Sub20` base class.
// It owns everything OUTSIDE the felt: the 755-wide layout frame, the top info bar,
// the shot clock (Aika), the right side-panel (spin slot + viewers + buttons), and the
// bottom row (table-width chat + control panel). The game supplies only the BOARD
// (a canvas) and its own overlays, which go into `shell.boardSlot`.
//
// Phase 2 (see ARCHITECTURE.md "Shared multiplayer lobby + game shell"): this is a
// *behaviour-preserving* extraction. The markup, element IDs and inline on* handlers
// are exactly those pool.html used inline, so the existing classic-script game.js keeps
// driving the chrome by id with zero changes. The richer pull/push controller API
// (setInfoModel / startClock / addChat …) lands when game.js becomes a board module.
//
// Boundary map (ARCHITECTURE.md table):
//   shell  → frame, info-bar FRAME, shot clock, chat, MP controls, side-panel frame
//   board  → canvas + overlays (injected into boardSlot), info-bar CONTENT (by id)

const CHROME_HTML = `
<!-- Top info bar (Java SPanel_Sub34: player-info area) -->
<div id="infobar">
  <div id="p1box" class="pinfo">
    <div style="display:flex;align-items:baseline;gap:5px">
      <div class="pname" id="p1name">Player 1</div>
      <div class="pgroup" id="p1g">—</div>
    </div>
    <div class="ball-row" id="p1balls"></div>
  </div>
  <div id="center-info">
    <!-- Shot clock (Aika) with turn-direction arrow — shown in multiplayer -->
    <div id="clock-wrap">
      <div id="clock-label">Aika</div>
      <div id="clock-box">
        <span id="turn-arrow">&#9664;</span>
        <span id="shotClock">1:00</span>
      </div>
    </div>
    <!-- Ball strip: all 15 balls for count/practice modes -->
    <div id="ball-strip"></div>
    <div id="count-shots"></div>
    <div id="status">Pool</div>
    <button id="backBtn" onclick="showLobby()">&#9776; Menu</button>
  </div>
  <div id="p2box" class="pinfo" style="text-align:right">
    <div style="display:flex;align-items:baseline;justify-content:flex-end;gap:5px">
      <div class="pgroup" id="p2g">—</div>
      <div class="pname" id="p2name">Player 2</div>
    </div>
    <div class="ball-row right" id="p2balls"></div>
  </div>
</div>
<!-- Main row: board slot (filled by the game) + right side-panel -->
<div id="main-row">
  <div id="canvas-wrap"><!-- board slot: game injects its canvas + overlays here --></div>
  <!-- Right side panel (Java x=630 side area) -->
  <div id="side-panel">
    <canvas id="spinc" width="125" height="100" title="Click to set spin · Double-click to reset"></canvas>
    <div id="spinlabel">Spin (dbl-click=reset)</div>
    <div id="hint">Hold to charge, release to shoot.<br>Right-click = 100% power.</div>
    <button id="cheatBtn" class="spbtn" onclick="toggleCheat()">&#9673; Guide OFF</button>
    <button id="assistBtn" class="spbtn" onclick="cycleAssist()">&#129522; OFF</button>
    <button id="storeBtn" class="spbtn" onclick="openStore()">&#127894; Store · <span id="tokenHUD">0</span></button>
    <div style="flex:1"></div>
    <button id="restartBtn" class="spbtn" onclick="restartGame()">&#8635; Restart</button>
    <!-- Viewers list (Katsoja) — platform overlay in Java, kept in the right rail here -->
    <div id="mp-controls">
      <div class="katsojat-title">Katsojat</div>
      <div id="katsojat"><div class="none">No viewers</div></div>
    </div>
  </div>
</div>
<!-- Bottom row: table-width chat (Java SPanel_Sub29 @5,417) + control panel (Java @630,417) -->
<div id="bottom-row">
  <div id="chat-panel">
    <div id="chat-msgs"></div>
    <div id="chat-input-row">
      <input id="chat-input" type="text" placeholder="Type a message… (Enter to send)" maxlength="200" onkeydown="chatKeyDown(event)">
      <button onclick="sendChatMsg()">Say</button>
    </div>
  </div>
  <!-- Control panel (Java GameControlPanel_Sub14_Sub2 @630,417: toggles + concede/leave) -->
  <div id="bottom-controls">
    <div class="toggle-row">
      <label><input type="checkbox" id="tglSound" checked onchange="soundOn=this.checked"> Äänet</label>
      <label><input type="checkbox" id="tglShadow" checked onchange="shadowsOn=this.checked"> Varjot</label>
    </div>
    <div style="flex:1"></div>
    <button class="spbtn btn-luovuta" onclick="concedeGame()">Luovuta</button>
    <button class="spbtn btn-poistu" onclick="leaveGame()">Poistu</button>
  </div>
</div>`;

export class GameShell {
  /**
   * @param {object} [opts]
   * @param {string} [opts.status]  initial text for the #status label
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.root = null;       // #game-wrap
    this.boardSlot = null;  // #canvas-wrap — the game fills this with canvas + overlays
  }

  /**
   * Build the shared chrome into `parent` and return `this`.
   * After mount, append the game's canvas/overlays to `shell.boardSlot`, and any
   * game-specific footer (e.g. pool's #scoreboard) to `shell.root`.
   */
  mount(parent) {
    const wrap = document.createElement('div');
    wrap.id = 'game-wrap';
    wrap.innerHTML = CHROME_HTML;
    parent.appendChild(wrap);

    this.root = wrap;
    this.boardSlot = wrap.querySelector('#canvas-wrap');

    if (this.opts.status != null) {
      const s = wrap.querySelector('#status');
      if (s) s.textContent = this.opts.status;
    }
    return this;
  }

  /** Remove the chrome from the document. */
  unmount() {
    if (this.root) this.root.remove();
    this.root = this.boardSlot = null;
  }
}

// Convenience: build a shell, inject HTML/nodes into its board slot, and (optionally)
// load a classic-script engine AFTER the DOM exists — preserving the load ordering the
// engine relies on (its load-time code queries #srvStatus etc.). Returns the shell.
GameShell.boot = function boot({ parent = document.body, status, boardHTML = '', footer = null, engineSrc = null } = {}) {
  const shell = new GameShell({ status }).mount(parent);
  if (boardHTML) shell.boardSlot.innerHTML = boardHTML;
  if (footer) shell.root.appendChild(footer);
  if (engineSrc) {
    const s = document.createElement('script');
    s.src = engineSrc;
    document.body.appendChild(s);     // runs now that the chrome DOM exists
  }
  return shell;
};

export default GameShell;
