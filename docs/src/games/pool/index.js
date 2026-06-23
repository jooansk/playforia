// Pool game module. The monolithic pool.html has been split into this folder:
//   pool.css            — styles (extracted)
//   game.js             — the full engine (physics/render/UI/lobby) as a classic script
//   rules.js            — PURE racking/rules (ESM, importable by client AND server)
//   /pool.html (root)   — thin shell that just loads pool.css + game.js
// This module mounts that thin pool.html in an iframe, which gives clean CSS + scope
// isolation and conforms to the GameModule contract. Next migration step (ARCHITECTURE.md):
// convert game.js into an ESM module with init()/dispose() — resolving the var/function
// patch redeclarations and inline on* handlers — so it can mount in-document, no iframe.

import { GameModule } from '../../platform/GameModule.js';
export * as rules from './rules.js';

export class PoolGame extends GameModule {
  static id = 'pool';
  static title = 'Biljardi & Snooker';
  static icon = 'assets/res/APool/picture/lobbyselect/sp-0.png';
  static blurb = 'Kasa-, ysi-, rotaatio- & pistepeli, snooker';
  static ready = true;
  static modes = [
    { id: '8ball', name: 'Kasapallo', players: 2 },
    { id: '9ball', name: 'Ysipallo', players: 2 },
    { id: 'rotation', name: 'Rotaatio', players: 2 },
    { id: 'snooker', name: 'Snooker', players: 1 },
  ];

  mount(container, ctx) {
    const wrap = document.createElement('div');
    wrap.className = 'pool-bridge';

    const back = document.createElement('button');
    back.className = 'glaunch-back';
    back.textContent = '← Pelivalikko';
    back.onclick = () => ctx.onExit();

    const frame = document.createElement('iframe');
    frame.src = 'pool.html';
    frame.title = 'Pool';
    frame.style.cssText = 'border:0;width:800px;height:620px;display:block;margin:6px auto;background:#0a1420;';

    wrap.appendChild(back);
    wrap.appendChild(frame);
    container.appendChild(wrap);
    this._wrap = wrap;
  }

  unmount() { if (this._wrap) this._wrap.remove(); }
}

export default PoolGame;
