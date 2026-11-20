// Estadísticas de una ronda para la página Stats: resultados individuales y leaderboard por mapa.
// Solo usa lo que la sincronización ya ha guardado (no pide nada a osu!). Quién puede ver qué lo decide server.js.

export const STATS_VIEWS = ['resultados-individuales', 'leaderboard-por-mapa'];

// Letra del rank. Si osu! la manda, esa; si no, se calcula con los 300/100/50/fallos como en stable
// (SS: todo 300; S: más del 90 % de 300, como mucho un 1 % de 50 y sin fallos; A, B, C y D, como en osu!).
const RANK_NAME = { XH: 'SS', X: 'SS', SH: 'S' };
export function rankOf(d) {
  if (!d) return null;
  if (typeof d.rank === 'string' && d.rank) return RANK_NAME[d.rank] || d.rank;
  const { n300, n100, n50, miss } = d;
  if (![n300, n100, n50, miss].every((v) => Number.isFinite(v))) return null;
  const total = n300 + n100 + n50 + miss;
  if (!total) return null;
  const r300 = n300 / total, r50 = n50 / total;
  if (r300 === 1) return 'SS';
  if (r300 > 0.9 && r50 <= 0.01 && miss === 0) return 'S';
  if ((r300 > 0.8 && miss === 0) || r300 > 0.9) return 'A';
  if ((r300 > 0.7 && miss === 0) || r300 > 0.8) return 'B';
  if (r300 > 0.6) return 'C';
  return 'D';
}

// Mods que se enseñan junto al slot: los que no van ya en el nombre del slot. NF no se enseña (va en todos los mapas).
export function extraMods(slot, mods) {
  const own = ['HD', 'HR', 'DT'].includes(slot.slice(0, 2)) ? slot.slice(0, 2) : null;
  return [...new Set((mods || []).filter((m) => m && m !== 'NF' && m !== own && !(own === 'DT' && m === 'NC')))];
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// plays: [{ uid, bid, slot, score, acc, mods, rank, mult, group, match, mp }], un elemento por score.
//   score: el que cuenta (con los multiplicadores de la ronda); group: los scores que se comparan entre sí
//   para el match cost (el mismo mapa en el mismo partido).
// name(uid) → nombre del jugador. metric: null (match cost) o { key, label, values: Map uid → valor } en clasificatorios.
export function individual(plays, name, metric = null) {
  const groups = new Map();
  for (const p of plays) (groups.get(p.group) || groups.set(p.group, []).get(p.group)).push(p.score);
  const byUser = new Map();
  for (const p of plays) (byUser.get(p.uid) || byUser.set(p.uid, []).get(p.uid)).push(p);
  const rows = [...byUser].map(([uid, ps]) => {
    const ratios = ps.map((p) => { const m = mean(groups.get(p.group)); return m > 0 ? p.score / m : null; }).filter((x) => x != null);
    const accs = ps.map((p) => p.acc).filter((a) => typeof a === 'number');
    const best = ps.reduce((a, b) => (b.score > a.score ? b : a));
    return {
      id: uid, username: name(uid),
      value: metric ? (metric.values.get(uid) ?? null) : mean(ratios),
      avgScore: mean(ps.map((p) => p.score)),
      avgAcc: accs.length ? mean(accs) : null,
      maps: ps.length,
      best: playOut(best)
    };
  });
  rows.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity) || b.avgScore - a.avgScore || a.username.localeCompare(b.username));
  return rows;
}

const playOut = (p) => ({ score: p.score, acc: p.acc, slot: p.slot, mods: p.mods, rank: p.rank, mult: p.mult, match: p.match, mp: p.mp });

// Una sección por mapa del pool, con todos sus scores de mayor a menor.
export function leaderboard(pool, plays, name) {
  return pool.map((m) => ({
    slot: m.slot, beatmap_id: m.beatmap_id,
    artist: m.data?.artist ?? null, title: m.data?.title ?? null, version: m.data?.version ?? null, url: m.data?.url ?? null,
    plays: plays.filter((p) => p.bid === m.beatmap_id)
      .sort((a, b) => b.score - a.score)
      .map((p) => ({ id: p.uid, username: name(p.uid), ...playOut(p) }))
  }));
}
