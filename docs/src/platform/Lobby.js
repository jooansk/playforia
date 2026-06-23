// Lobby — the shared multiplayer challenge lobby, ≈ Java `SPanel_Sub21` + the
// `com.playray.multiuser.UserList` roster + `apool.LobbyHeaderPanel` challenge controls.
//
// Mirrors the authentic flow (see ARCHITECTURE.md "Shared multiplayer lobby"):
//   • a roster of everyone online (UserList) with ranking + status, sortable;
//   • SELECT a player, then CHALLENGE — challenge acts on the selected user
//     (LobbyHeaderPanel.getSelectedUser().getNick() → "challenge\t<nick>…");
//   • the target Accepts / Refuses; the challenger may Cancel;
//   • on the server's `start`, the game begins and the lobby closes.
//
// This module is game-agnostic. It drives a `net` adapter (the pool Network instance,
// extended with lobby methods + `on(type,cb)`), so the SAME socket that lobbies is the
// one that plays — the server creates the room on the accepting/accepted connection.
//
// Challenge SETTINGS (bet / spectators / shot-time) are a deliberate pass-2 addition
// (ARCHITECTURE: "add a settings object to challenge/start"); the header has a slot.

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
  .lobby2-backdrop{position:fixed;inset:0;background:rgba(2,8,4,.72);z-index:200;
    display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif;}
  .lobby2{width:760px;max-width:96vw;height:520px;max-height:94vh;display:flex;flex-direction:column;
    background:#0c2414;border:1px solid #2f7a36;border-radius:10px;overflow:hidden;
    box-shadow:0 14px 50px rgba(0,0,0,.6);}
  .lobby2-hd{background:linear-gradient(#176a2a,#0c3a17);padding:8px 12px;display:flex;
    align-items:center;gap:12px;border-bottom:1px solid #2f7a36;}
  .lobby2-hd .gname{color:#fff;font-weight:900;font-size:15px;letter-spacing:.5px;flex:0 0 auto;}
  .lobby2-settings{display:flex;gap:10px;color:#bfe6c6;font-size:10px;align-items:center;flex:1;}
  .lobby2-settings .soon{opacity:.5;font-style:italic;}
  .lobby2-hd .x{background:#3a0d0d;border:1px solid #7a2a2a;color:#f0a0a0;border-radius:4px;
    cursor:pointer;font-size:12px;padding:4px 10px;}
  .lobby2-hd .x:hover{background:#501515;}
  .lobby2-actions{display:flex;gap:6px;}
  .lobby2-btn{border:0;border-radius:4px;cursor:pointer;font-size:12px;font-weight:700;padding:6px 14px;color:#fff;}
  .lobby2-btn.challenge{background:linear-gradient(#5cc832,#2e8a10);}
  .lobby2-btn.accept{background:linear-gradient(#5cc832,#2e8a10);}
  .lobby2-btn.cancel,.lobby2-btn.refuse{background:linear-gradient(#c85a32,#8a2e10);}
  .lobby2-btn:disabled{filter:grayscale(.8) brightness(.7);cursor:default;}
  .lobby2-body{flex:1;display:flex;min-height:0;}
  .lobby2-col{display:flex;flex-direction:column;min-height:0;}
  .lobby2-players{flex:0 0 210px;border-right:1px solid #143;}
  .lobby2-chat{flex:1;border-right:1px solid #143;}
  .lobby2-games{flex:0 0 190px;}
  .lobby2-coltitle{background:#06180c;color:#7ec98a;font-size:10px;font-weight:800;
    text-transform:uppercase;letter-spacing:1px;padding:6px 8px;display:flex;justify-content:space-between;}
  .lobby2-coltitle .sort{color:#4f8a5c;cursor:pointer;font-weight:700;}
  .lobby2-coltitle .sort:hover{color:#9fe0a8;}
  .lobby2-list{flex:1;overflow-y:auto;}
  .lobby2-row{display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;
    font-size:12px;color:#cfe;border-bottom:1px solid #0e2716;}
  .lobby2-row:hover{background:#10331b;}
  .lobby2-row.sel{background:#1c5a2c;}
  .lobby2-row.busy{opacity:.45;cursor:default;}
  .lobby2-row.me{color:#9fe0a8;font-weight:700;}
  .lobby2-row.game{justify-content:space-between;align-items:center;}
  .lobby2-watch{flex:0 0 auto;background:linear-gradient(#5cc832,#2e8a10);border:1px solid #1f6608;
    color:#fff;border-radius:4px;cursor:pointer;font-size:10px;font-weight:700;padding:3px 8px;}
  .lobby2-watch:hover{filter:brightness(1.15);}
  .lobby2-rank{flex:0 0 22px;height:14px;border-radius:3px;background:#0a3a18;border:1px solid #2f7a36;
    color:#8fd89c;font-size:9px;display:flex;align-items:center;justify-content:center;}
  .lobby2-rname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .lobby2-tag{font-size:9px;color:#7aa;}
  .lobby2-msgs{flex:1;overflow-y:auto;padding:5px 8px;font-size:12px;line-height:1.5;color:#bcdcc4;}
  .lobby2-msgs .nm{color:#7ec98a;font-weight:700;}
  .lobby2-msgs .sys{color:#5a8a6a;font-style:italic;}
  .lobby2-inrow{display:flex;border-top:1px solid #143;}
  .lobby2-inrow input{flex:1;background:#05140a;border:0;color:#cfe;padding:7px 9px;font-size:12px;outline:none;}
  .lobby2-inrow button{background:#176a2a;border:0;color:#fff;padding:0 14px;cursor:pointer;font-size:12px;}
  .lobby2-status{background:#06180c;border-top:1px solid #143;color:#bfe6c6;font-size:11px;
    padding:6px 12px;min-height:26px;display:flex;align-items:center;}
  .lobby2-status.warn{color:#f0c060;}
  .lobby2-empty{color:#3f6a4c;font-style:italic;font-size:11px;padding:8px;}`;
  const el = document.createElement('style');
  el.id = 'lobby2-styles';
  el.textContent = css;
  document.head.appendChild(el);
}

export class Lobby {
  /**
   * @param {object} opts
   * @param {object} opts.net    Network adapter: send methods + `on(type,cb)` (see game.js)
   * @param {string} opts.me     local player's display name
   * @param {string} opts.game   game id for the lobby (e.g. 'pool')
   * @param {string} [opts.title] header label (defaults to game)
   * @param {function} [opts.onClose] called when the lobby is dismissed
   */
  constructor(opts) {
    this.net = opts.net;
    this.me = opts.me || 'You';
    this.game = opts.game || 'pool';
    this.title = opts.title || 'Kasapallo';
    this.onClose = opts.onClose || (() => {});
    this.players = [];
    this.games = [];
    this.selectedId = null;     // chosen opponent row
    this.outgoing = null;       // id we challenged, awaiting reply
    this.incoming = null;       // { from, fromName } challenge to answer
    this.sortBy = 'rank';       // 'rank' | 'name'  (UserList SORT_*)
    this._unsub = [];
    this.root = null;
  }

  mount(parent = document.body) {
    injectStyles();
    const bd = document.createElement('div');
    bd.className = 'lobby2-backdrop';
    bd.innerHTML = `
      <div class="lobby2">
        <div class="lobby2-hd">
          <div class="gname">${esc(this.title)}</div>
          <div class="lobby2-settings">
            <span class="soon">Asetukset (panos · katsojat · vuoroaika) — pass&nbsp;2</span>
          </div>
          <div class="lobby2-actions">
            <button class="lobby2-btn challenge" data-a="challenge" disabled>Haasta</button>
            <button class="lobby2-btn cancel" data-a="cancel" style="display:none">Peru</button>
            <button class="lobby2-btn accept" data-a="accept" style="display:none">Hyväksy</button>
            <button class="lobby2-btn refuse" data-a="refuse" style="display:none">Kieltäydy</button>
          </div>
          <button class="x" data-a="close">Poistu</button>
        </div>
        <div class="lobby2-body">
          <div class="lobby2-col lobby2-players">
            <div class="lobby2-coltitle"><span>Pelaajat</span>
              <span class="sort" data-a="sort">lajittele</span></div>
            <div class="lobby2-list" data-list="players"></div>
          </div>
          <div class="lobby2-col lobby2-chat">
            <div class="lobby2-coltitle"><span>Aula</span></div>
            <div class="lobby2-msgs" data-list="msgs"></div>
            <div class="lobby2-inrow">
              <input type="text" maxlength="200" placeholder="Viesti aulaan…">
              <button data-a="say">Sano</button>
            </div>
          </div>
          <div class="lobby2-col lobby2-games">
            <div class="lobby2-coltitle"><span>Avoimet pelit</span></div>
            <div class="lobby2-list" data-list="games"></div>
          </div>
        </div>
        <div class="lobby2-status" data-status>Valitse pelaaja ja paina Haasta.</div>
      </div>`;
    parent.appendChild(bd);
    this.root = bd;

    // refs
    this.elPlayers = bd.querySelector('[data-list="players"]');
    this.elGames = bd.querySelector('[data-list="games"]');
    this.elMsgs = bd.querySelector('[data-list="msgs"]');
    this.elStatus = bd.querySelector('[data-status]');
    this.elInput = bd.querySelector('.lobby2-inrow input');
    this.btn = {
      challenge: bd.querySelector('[data-a="challenge"]'),
      cancel: bd.querySelector('[data-a="cancel"]'),
      accept: bd.querySelector('[data-a="accept"]'),
      refuse: bd.querySelector('[data-a="refuse"]'),
    };

    // clicks (delegated)
    bd.addEventListener('click', e => this._onClick(e));
    this.elInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this._say(); }
    });

    // subscribe to server events
    const on = (t, cb) => { this.net.on(t, cb); this._unsub.push([t, cb]); };
    on('lobby', m => { this.players = m.players || []; this._renderPlayers(); });
    on('games', m => { this.games = m.list || []; this._renderGames(); });
    on('lobbychat', m => this._addMsg('nm', m.name, m.msg));
    on('challenged', m => { this.incoming = m; this._setStatus(`${m.fromName} haastaa sinut!`); this._renderButtons(); });
    on('declined', m => { this.outgoing = null; this._setStatus(`${m.byName} kieltäytyi.`, true); this._renderButtons(); });
    on('cancelled', m => { this.incoming = null; this._setStatus(`${m.byName} perui haasteen.`, true); this._renderButtons(); });
    on('error', m => this._setStatus(m.msg || 'Virhe', true));
    on('start', () => this.close());    // match begins → dismiss lobby
    on('replay', () => this.close());   // started spectating → dismiss lobby

    // enter the lobby (presence)
    this.net.enterLobby(this.game);
    this._addMsg('sys', '', 'Liityit aulaan.');
    return this;
  }

  close() {
    if (!this.root) return;
    for (const [t, cb] of this._unsub) this.net.off?.(t, cb);
    this._unsub = [];
    this.root.remove();
    this.root = null;
    this.onClose();
  }

  // ── rendering ──────────────────────────────────────────────────────────────
  _sorted() {
    const ps = [...this.players];
    if (this.sortBy === 'name') ps.sort((a, b) => a.name.localeCompare(b.name));
    else ps.sort((a, b) => (b.rank - a.rank) || a.name.localeCompare(b.name));
    return ps;
  }

  _renderPlayers() {
    const mine = this.me;
    const rows = this._sorted().map(p => {
      const isMe = p.name === mine;
      const busy = p.status === 'playing';
      const cls = ['lobby2-row'];
      if (isMe) cls.push('me');
      if (busy) cls.push('busy');
      if (p.id === this.selectedId) cls.push('sel');
      const tag = busy ? '<span class="lobby2-tag">pelaa</span>' : '';
      const rank = p.rank > 0 ? p.rank : '–';
      return `<div class="${cls.join(' ')}" data-pid="${p.id}" ${(isMe || busy) ? 'data-noselect="1"' : ''}>
        <span class="lobby2-rank" title="ranking">${rank}</span>
        <span class="lobby2-rname">${esc(p.name)}${isMe ? ' (sinä)' : ''}</span>${tag}</div>`;
    });
    this.elPlayers.innerHTML = rows.join('') || '<div class="lobby2-empty">Ei pelaajia.</div>';
  }

  _renderGames() {
    const rows = this.games.map(g => {
      const playing = g.status === 'playing';
      const label = playing ? 'käynnissä' : 'odottaa';
      // Whole row is clickable; the ▶ Katso button makes the spectate affordance explicit.
      return `<div class="lobby2-row game" data-gid="${esc(g.id)}" title="Katso peliä">
        <span class="lobby2-rname">${esc(g.host)}<br><span class="lobby2-tag">${esc(g.mode)} · ${label}</span></span>
        <button class="lobby2-watch" data-gid="${esc(g.id)}">▶ Katso</button></div>`;
    });
    this.elGames.innerHTML = rows.join('') || '<div class="lobby2-empty">Ei avoimia pelejä.</div>';
  }

  _renderButtons() {
    const b = this.btn;
    const waiting = this.outgoing != null;
    const answering = this.incoming != null;
    b.challenge.style.display = (waiting || answering) ? 'none' : '';
    b.cancel.style.display = waiting ? '' : 'none';
    b.accept.style.display = answering ? '' : 'none';
    b.refuse.style.display = answering ? '' : 'none';
    b.challenge.disabled = !(this.selectedId != null);
  }

  _addMsg(cls, name, text) {
    const row = document.createElement('div');
    if (cls === 'sys') row.innerHTML = `<span class="sys">${esc(text)}</span>`;
    else row.innerHTML = `<span class="nm">${esc(name)}:</span> ${esc(text)}`;
    this.elMsgs.appendChild(row);
    this.elMsgs.scrollTop = this.elMsgs.scrollHeight;
  }

  _setStatus(text, warn = false) {
    this.elStatus.textContent = text;
    this.elStatus.classList.toggle('warn', warn);
  }

  // ── interaction ─────────────────────────────────────────────────────────────
  _onClick(e) {
    const row = e.target.closest('[data-pid]');
    if (row && !row.dataset.noselect) { this._select(Number(row.dataset.pid)); return; }
    const grow = e.target.closest('[data-gid]');   // open-games row → spectate
    if (grow) { this.net.watch(grow.dataset.gid); return; }
    const a = e.target.closest('[data-a]');
    if (!a) return;
    switch (a.dataset.a) {
      case 'challenge': this._challenge(); break;
      case 'cancel': this._cancel(); break;
      case 'accept': this._accept(); break;
      case 'refuse': this._refuse(); break;
      case 'say': this._say(); break;
      case 'sort': this.sortBy = this.sortBy === 'rank' ? 'name' : 'rank'; this._renderPlayers(); break;
      case 'close': this.close(); break;
    }
  }

  _select(id) {
    this.selectedId = id;
    this._renderPlayers();
    this._renderButtons();
    const p = this.players.find(x => x.id === id);
    if (p) this._setStatus(`Valittu: ${p.name}. Paina Haasta.`);
  }

  _challenge() {
    if (this.selectedId == null) return;
    this.outgoing = this.selectedId;
    this.net.sendChallenge(this.selectedId);
    const p = this.players.find(x => x.id === this.selectedId);
    this._setStatus(`Odotetaan vastausta: ${p ? p.name : ''}…`);
    this._renderButtons();
  }

  _cancel() {
    if (this.outgoing != null) this.net.sendCancel(this.outgoing);
    this.outgoing = null;
    this._setStatus('Haaste peruttu.');
    this._renderButtons();
  }

  _accept() {
    if (!this.incoming) return;
    this.net.sendAccept(this.incoming.from);   // server replies with room+start → close()
    this._setStatus('Hyväksyttiin — peli alkaa…');
  }

  _refuse() {
    if (!this.incoming) return;
    this.net.sendDecline(this.incoming.from);
    this.incoming = null;
    this._setStatus('Kieltäydyit haasteesta.');
    this._renderButtons();
  }

  _say() {
    const t = this.elInput.value.trim();
    if (!t) return;
    this.net.sendLobbyChat(t);
    this._addMsg('nm', this.me, t);   // optimistic echo (server broadcasts to others)
    this.elInput.value = '';
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export default Lobby;
