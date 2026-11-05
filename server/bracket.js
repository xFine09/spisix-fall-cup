// Seeds de clasificatorios y cruces del cuadro, calculados en el servidor (para el bot de arbitraje).
// Es la misma lógica que computeQual() y compute() de public/index.html: si cambias una, cambia la otra.
import { CONFIG, phase, MATCH_IDS, bestOf } from './config.js';

// Orden de los cruces de octavos por seed y de dónde sale cada jugador de las rondas siguientes.
const SEED_ORDER = [1, 16, 8, 9, 5, 12, 4, 13, 3, 14, 6, 11, 7, 10, 2, 15];
const W = (m) => ({ m, r: 'W' }), L = (m) => ({ m, r: 'L' });
const SOURCES = {};
for (let i = 1; i <= 8; i++) SOURCES['u1-' + i] = [{ q: SEED_ORDER[2 * i - 2] }, { q: SEED_ORDER[2 * i - 1] }];
for (let i = 1; i <= 4; i++) SOURCES['u2-' + i] = [W('u1-' + (2 * i - 1)), W('u1-' + 2 * i)];
for (let i = 1; i <= 4; i++) SOURCES['l1-' + i] = [L('u1-' + (2 * i - 1)), L('u1-' + 2 * i)];
for (let i = 1; i <= 2; i++) SOURCES['u3-' + i] = [W('u2-' + (2 * i - 1)), W('u2-' + 2 * i)];
for (let i = 1; i <= 4; i++) SOURCES['l2-' + i] = [W('l1-' + i), L('u2-' + (5 - i))];
for (let i = 1; i <= 2; i++) SOURCES['l3-' + i] = [W('l2-' + (2 * i - 1)), W('l2-' + 2 * i)];
SOURCES['u4-1'] = [W('u3-1'), W('u3-2')];
for (let i = 1; i <= 2; i++) SOURCES['l4-' + i] = [W('l3-' + i), L('u3-' + (3 - i))];
SOURCES['l5-1'] = [W('l4-1'), W('l4-2')];
SOURCES['l6-1'] = [W('l5-1'), L('u4-1')];
SOURCES.gf = [W('u4-1'), W('l6-1')];

// Mismo texto que la columna «ronda» de la web.
const ROUND_NAMES = {
  u1: 'Upper · Octavos', u2: 'Upper · Cuartos', u3: 'Upper · Semifinal', u4: 'Upper · Final',
  l1: 'Lower · Ronda 1', l2: 'Lower · Ronda 2', l3: 'Lower · Ronda 3', l4: 'Lower · Ronda 4',
  l5: 'Lower · Semifinal', l6: 'Lower · Final', gf: 'Grand Final'
};
export const roundName = (id) => ROUND_NAMES[id.split('-')[0]];

// players: inscritos (Map id → jugador). scores: { uid: { beatmap_id: mejor score } }. bids: mapas del pool de clasificatorios.
export function qualRanking(players, scores, bids) {
  const rows = [];
  for (const [uid, maps] of Object.entries(scores)) {
    const p = players.get(+uid);
    if (p) rows.push({ player: p, scores: bids.map((b) => maps[b] || 0), z: 0 });
  }
  rows.forEach((r) => { r.total = r.scores.reduce((a, b) => a + b, 0); });
  bids.forEach((_, j) => {
    const v = rows.map((r) => r.scores[j]);
    const mean = v.reduce((a, b) => a + b, 0) / (v.length || 1);
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length || 1)) || 1;
    rows.forEach((r) => { r.z += (r.scores[j] - mean) / sd; });
  });
  const byZ = CONFIG.metodoClasif !== 'suma';
  rows.sort((a, b) => (byZ ? b.z - a.z : b.total - a.total));
  return rows;
}

// matches: { id: { ff, result } } como en la base de datos ya leída. Devuelve { id: { a, b, winner, loser, done } }.
export function resolveBracket({ players, scores, bids, matches, now = Date.now() }) {
  const rows = qualRanking(players, scores, bids);
  const seedsFinal = now > phase('qualifiers').end && rows.length >= CONFIG.clasificados;
  const out = {};
  const from = (s) => {
    if (s.q) return seedsFinal ? rows[s.q - 1].player : null;
    const m = out[s.m];
    return m?.done ? (s.r === 'W' ? m.winner : m.loser) : null;
  };
  for (const id of MATCH_IDS) {
    const [sa, sb] = SOURCES[id];
    const m = { a: from(sa), b: from(sb), winner: null, loser: null, done: false };
    const rec = matches[id] || {};
    const need = (bestOf(id) + 1) / 2;
    const wins = rec.result?.wins || {};
    const wa = m.a ? wins[m.a.id] || 0 : 0, wb = m.b ? wins[m.b.id] || 0 : 0;
    if (m.a && m.b && (rec.ff || wa >= need || wb >= need)) {
      const aWins = rec.ff ? rec.ff === 'a' : wa > wb;
      Object.assign(m, { done: true, winner: aWins ? m.a : m.b, loser: aWins ? m.b : m.a });
    }
    out[id] = m;
  }
  return { seedsFinal, matches: out };
}
