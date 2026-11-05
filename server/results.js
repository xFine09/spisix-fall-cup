// Convierte respuestas de la API de osu! en los datos que usa la web.
import * as osu from './osu.js';

const round1 = (x) => Math.round(x * 10) / 10;

// AR y OD con DT (el tiempo va 1,5 veces más rápido).
function arDT(ar) {
  let ms = ar < 5 ? 1800 - 120 * ar : 1200 - 150 * (ar - 5);
  ms /= 1.5;
  return ms > 1200 ? (1800 - ms) / 120 : 5 + (1200 - ms) / 150;
}
const odDT = (od) => (80 - (80 - 6 * od) / 1.5) / 6;

// Datos de un mapa del pool. El SR con HR o DT se pide a /beatmaps/{id}/attributes.
export async function loadBeatmap(id, slot) {
  const b = await osu.beatmap(id);
  const mod = slot.slice(0, 2);
  let sr = b.difficulty_rating;
  if (mod === 'HR' || mod === 'DT') {
    const a = await osu.attributes(id, [mod]);
    sr = a.attributes?.star_rating ?? sr;
  }
  let { cs, ar, accuracy: od, bpm, total_length: length } = b;
  if (mod === 'HR') { cs = Math.min(10, cs * 1.3); ar = Math.min(10, ar * 1.4); od = Math.min(10, od * 1.4); }
  if (mod === 'DT') { bpm *= 1.5; length = Math.round(length / 1.5); ar = arDT(ar); od = odDT(od); }
  // owners = quien ha hecho esta dificultad (en una guest difficulty no es el creador del set)
  const mappers = (b.owners || []).map((o) => o.username).filter(Boolean).join(', ');
  return {
    artist: b.beatmapset?.artist, title: b.beatmapset?.title, title_unicode: b.beatmapset?.title_unicode, version: b.version, creator: mappers || b.beatmapset?.creator,
    sr: Math.round(sr * 100) / 100, bpm: Math.round(bpm), length, cs: round1(cs), ar: round1(ar), od: round1(od),
    cover: b.beatmapset?.covers?.card || null, url: `https://osu.ppy.sh/b/${id}`
  };
}

const modList = (game, score) => [...(game.mods || []), ...(score.mods || [])]
  .map((m) => (typeof m === 'string' ? m : m.acronym));

// Puntuación de un score aplicando los multiplicadores del torneo (EZ 1,8x, EZHD 2x).
function points(game, score, mult) {
  const raw = score.score ?? score.legacy_total_score ?? score.total_score ?? 0;
  const mods = modList(game, score);
  if (mods.includes('EZ')) return Math.round(raw * (mods.includes('HD') ? mult.EZHD : mult.EZ));
  return raw;
}

// Resultado de un partido 1v1: solo cuentan los mapas del pool de esa ronda
// (los warmups no están en el pool). Si un mapa se repite, vale el último.
export function parseMatch(data, poolBySlot, mult) {
  const byBeatmap = new Map();
  for (const ev of data.events || []) {
    const g = ev.game;
    if (!g || !g.end_time || !g.scores?.length) continue;
    const slot = poolBySlot.get(g.beatmap_id);
    if (!slot) continue;
    const scores = {};
    for (const s of g.scores) scores[s.user_id] = points(g, s, mult);
    const ids = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
    if (ids.length < 2 || scores[ids[0]] === scores[ids[1]]) continue;
    byBeatmap.set(g.beatmap_id, { bid: g.beatmap_id, slot, w: +ids[0], scores });
  }
  const maps = [...byBeatmap.values()];
  const wins = {};
  for (const m of maps) wins[m.w] = (wins[m.w] || 0) + 1;
  return { wins, maps, name: data.match?.name || null, updated: Date.now() };
}

// Clasificatorios: mejor score de cada jugador en cada mapa del pool. Solo cuentan los mapas jugados
// en head to head: un mapa por equipos no se puede comparar y se deja fuera (skipped dice cuántos).
export function parseQual(data, poolBySlot) {
  const scores = {};
  let skipped = 0;
  for (const ev of data.events || []) {
    const g = ev.game;
    if (!g || !g.end_time || !poolBySlot.has(g.beatmap_id)) continue;
    if (g.team_type !== 'head-to-head') { skipped++; continue; }
    for (const s of g.scores || []) {
      const uid = s.user_id;
      const val = s.score ?? s.legacy_total_score ?? s.total_score ?? 0;
      scores[uid] ??= {};
      scores[uid][g.beatmap_id] = Math.max(scores[uid][g.beatmap_id] || 0, val);
    }
  }
  return { scores, name: data.match?.name || null, skipped };
}
