// Progression — the meta-layer over the assist ("cheat") system: shot stats, tiered
// badges, tokens, and an asset store. PURE-ish (only touches localStorage for persistence),
// so the same logic can later run server-side over a SQLite `users` row. See MAINTAINING.md.
//
// Loop: make shots → earn tokens (+ badges at milestones, which grant bonus tokens) →
// spend tokens in the store to buy ASSETS (the assist modes) → use them in PRACTICE.
// Decision (this build): assists are practice-only; ranked/online stay clean.

// Shot categories we recognise, with the base token reward for making one.
export const SHOT_TYPES = {
  direct: { name: 'Pot',       tokens: 1 },
  long:   { name: 'Long Pot',  tokens: 2 },
  cut:    { name: 'Cut',       tokens: 2 },
  bank:   { name: 'Bank',      tokens: 5 },
  combo:  { name: 'Combo',     tokens: 4 },
  multi:  { name: 'Multi-pot', tokens: 6 },
};

// Badge tiers per shot type (your First → Player → Master → Sensei), each granting tokens.
export const TIERS = [
  { key: 'first',  name: 'First',  n: 1,    tokens: 10 },
  { key: 'player', name: 'Player', n: 10,   tokens: 25 },
  { key: 'master', name: 'Master', n: 100,  tokens: 150 },
  { key: 'sensei', name: 'Sensei', n: 1000, tokens: 1000 },
];

// The store: assets you buy with tokens. Asset ids map to assist modes in game.js.
export const STORE = [
  { id: 'guide',  name: 'Aim Guide',    price: 0,   blurb: 'Predicted ball + cue paths' },
  { id: 'magnet', name: 'Magnet',       price: 60,  blurb: 'Auto-aim the nearest pot' },
  { id: 'bank',   name: 'Bank Helper',  price: 120, blurb: 'One-rail bank shots' },
  { id: 'best',   name: 'Best Shot',    price: 200, blurb: 'Easiest pot anywhere' },
  { id: 'combo',  name: 'Combo Finder', price: 260, blurb: 'Find 2-ball combinations' },
];

const KEY = 'playforia-pool-progression';
const blank = () => ({ stats: {}, tokens: 0, owned: ['guide'], badges: {} });

function load() {
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s) return Object.assign(blank(), s); } catch (_) {}
  return blank();
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }

let state = load();

export const getState = () => state;
export const getTokens = () => state.tokens;
export const owns = (id) => state.owned.includes(id);
export const statOf = (t) => state.stats[t] || 0;

/**
 * Record one made shot. `types` = the categories it satisfied, e.g. ['bank','multi'].
 * Bumps each counter, awards tokens, unlocks any newly-crossed badge tiers (with bonus
 * tokens), persists, and returns what was earned so the UI can toast it.
 * @returns {{ tokens:number, badges:{type,tier,name}[] }}
 */
export function recordShot(types) {
  let tokens = 0; const badges = [];
  for (const t of types) {
    if (!SHOT_TYPES[t]) continue;
    state.stats[t] = (state.stats[t] || 0) + 1;
    tokens += SHOT_TYPES[t].tokens;
    state.badges[t] = state.badges[t] || {};
    for (const tier of TIERS) {
      if (state.stats[t] >= tier.n && !state.badges[t][tier.key]) {
        state.badges[t][tier.key] = true;
        tokens += tier.tokens;
        badges.push({ type: t, tier: tier.key, name: `${SHOT_TYPES[t].name} ${tier.name}` });
      }
    }
  }
  state.tokens += tokens;
  save();
  return { tokens, badges };
}

/** Buy a store asset. Returns true on success (enough tokens, not already owned). */
export function buy(id) {
  const item = STORE.find((s) => s.id === id);
  if (!item || owns(id) || state.tokens < item.price) return false;
  state.tokens -= item.price;
  state.owned.push(id);
  save();
  return true;
}

/** Highest badge tier earned for a shot type (or null). For UI. */
export function topTier(t) {
  const b = state.badges[t] || {};
  let top = null;
  for (const tier of TIERS) if (b[tier.key]) top = tier;
  return top;
}

/** Test/dev helper — wipe progress. */
export function reset() { state = blank(); save(); }
