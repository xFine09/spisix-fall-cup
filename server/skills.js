// Skillsets de los jugadores, solo con datos de torneo: los mapas del torneo, sus clasificatorios y su cuadro, y el TR
// de o!TR como fuerza inicial. Funciones puras (sin base de datos ni red), para poder probarlas una a una.
//
// 1. Perfil de cada mapa: peso en 5 skills. Cada valor del mapa se compara con el de los demás mapas del torneo
//    (percentil p entre 0 y 1) y el peso es (p + 0,1)² / Σ(p + 0,1)². Los pesos de un mapa suman 1.
// 2. Base con los clasificatorios: en cada mapa, z-score de cada jugador frente a los que lo jugaron; la base de cada
//    skill es la media de sus z ponderada por el peso del mapa en esa skill (solo mapas jugados), limitada a ±3.
// 3. Elo por skill: fuerza general G (TR de o!TR o, si no, la seed), rating inicial R = G + 150 · base, y cada mapa
//    del cuadro es un duelo que mueve cada skill K · m · peso · (resultado − esperado).

export const SKILLS = ['aim', 'speed', 'prec', 'acc', 'stamina'];
export const ELO = { scale: 400, K: 80, baseFactor: 150, spread: 300, center: 1500, freeMod: 0.5, ez: 0.5, maxBase: 3 };

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Valores brutos de un mapa (con los mods del slot ya aplicados): aim y velocidad de osu!, CS, OD y notas rápidas.
export function mapComponents(data) {
  const a = data?.attr;
  if (!a) return null;
  const c = { aim: a.aim, speed: a.speed, prec: data.cs, acc: data.od, stamina: a.speed_notes };
  return SKILLS.every((k) => finite(c[k])) ? c : null;
}

// maps: [{ key, comp }] → Map(key → { aim, speed, prec, acc, stamina }) con pesos que suman 1.
export function mapWeights(maps) {
  const list = maps.filter((m) => m.comp);
  const n = list.length;
  const pct = (k, v) => {
    if (n < 2) return 0.5;
    let less = 0, equal = 0;
    for (const m of list) { if (m.comp[k] < v) less++; else if (m.comp[k] === v) equal++; }
    return (less + (equal - 1) / 2) / (n - 1); // los empates cuentan a medias
  };
  const out = new Map();
  for (const m of list) {
    const raw = Object.fromEntries(SKILLS.map((k) => [k, (pct(k, m.comp[k]) + 0.1) ** 2]));
    const sum = SKILLS.reduce((s, k) => s + raw[k], 0);
    out.set(m.key, Object.fromEntries(SKILLS.map((k) => [k, raw[k] / sum])));
  }
  return out;
}

// Inversa de la normal estándar (aproximación de Acklam, error < 1,2e-9).
export function inverseNormal(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - lo) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Fuerza general: TR de o!TR (z frente a los inscritos con TR) o, sin TR, la seed (seed 1 arriba). Sin nada, 1500.
export function generalStrength({ ids, tr, seeds, ranked }) {
  const withTr = ids.filter((id) => finite(tr.get(id)));
  const vals = withTr.map((id) => tr.get(id));
  const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length || 1));
  const out = new Map();
  out.fromTr = new Set(); // a quién se le ha calculado con el TR
  for (const id of ids) {
    let z = 0;
    if (finite(tr.get(id)) && withTr.length >= 2 && sd > 0) { z = (tr.get(id) - mean) / sd; out.fromTr.add(id); }
    else if (seeds.has(id) && ranked > 0) z = inverseNormal(1 - (seeds.get(id) - 0.5) / ranked);
    out.set(id, ELO.center + ELO.spread * z);
  }
  return out;
}

// z-score de cada jugador en cada mapa de clasificatorios, frente a los que lo jugaron (score > 0).
// scores: { uid: { bid: score } }. Devuelve Map(bid → Map(uid → z)).
export function qualZ(scores, bids) {
  const out = new Map();
  for (const bid of bids) {
    const played = Object.entries(scores).map(([uid, m]) => [+uid, m[bid] || 0]).filter(([, v]) => v > 0);
    if (played.length < 2) continue;
    const mean = played.reduce((a, [, v]) => a + v, 0) / played.length;
    const sd = Math.sqrt(played.reduce((a, [, v]) => a + (v - mean) ** 2, 0) / played.length) || 1;
    out.set(String(bid), new Map(played.map(([uid, v]) => [uid, (v - mean) / sd])));
  }
  return out;
}

// Base de cada jugador: media de sus z ponderada por el peso de cada mapa en cada skill.
// qualMaps: [{ bid, key }] (key → pesos). Devuelve Map(uid → { aim… }) solo de quien ha jugado algún mapa con pesos.
export function qualBase(z, qualMaps, weights) {
  const acc = new Map();
  for (const { bid, key } of qualMaps) {
    const w = weights.get(key), zs = z.get(String(bid));
    if (!w || !zs) continue;
    for (const [uid, zi] of zs) {
      const a = acc.get(uid) || Object.fromEntries(SKILLS.flatMap((k) => [[k, 0], [k + 'W', 0]]));
      for (const k of SKILLS) { a[k] += w[k] * zi; a[k + 'W'] += w[k]; }
      acc.set(uid, a);
    }
  }
  const lim = (v) => Math.max(-ELO.maxBase, Math.min(ELO.maxBase, v));
  return new Map([...acc].map(([uid, a]) => [uid, Object.fromEntries(SKILLS.map((k) => [k, a[k + 'W'] ? lim(a[k] / a[k + 'W']) : 0]))]));
}

// Un mapa del cuadro entre A y B: devuelve los ratings nuevos. aWon: si A ganó el mapa. m: multiplicador (FM, EZ).
export function duel(ra, rb, w, aWon, m = 1) {
  const fa = SKILLS.reduce((s, k) => s + w[k] * ra[k], 0);
  const fb = SKILLS.reduce((s, k) => s + w[k] * rb[k], 0);
  const ea = 1 / (1 + 10 ** ((fb - fa) / ELO.scale));
  const d = ELO.K * m * ((aWon ? 1 : 0) - ea);
  return {
    a: Object.fromEntries(SKILLS.map((k) => [k, ra[k] + d * w[k]])),
    b: Object.fromEntries(SKILLS.map((k) => [k, rb[k] - d * w[k]]))
  };
}

// Multiplicador de un mapa: FM y TB (FreeMod) cuentan la mitad, y también si alguno de los dos jugó con EZ.
export function mapFactor(slot, ezUsed) {
  return (/^(FM|TB)/.test(slot) ? ELO.freeMod : 1) * (ezUsed ? ELO.ez : 1);
}

// Percentil de cada skill frente al resto: % de los demás con un rating menor (un empate no cuenta).
export function percentiles(ratings, id) {
  const me = ratings.get(id);
  if (!me) return null;
  const others = [...ratings].filter(([uid]) => uid !== id).map(([, r]) => r);
  if (!others.length) return null;
  return Object.fromEntries(SKILLS.map((k) => [k, Math.round((100 * others.filter((o) => o[k] < me[k]).length) / others.length)]));
}

// Todo junto. Devuelve los ratings tras los clasificatorios (qual) y tras cada partido (history), y los actuales.
// matches: [{ id, at, a, b, maps: [{ key, slot, w, ez }] }] en el orden en que se jugaron.
export function computeSkills({ ids, tr, seeds, ranked, qualScores, qualMaps, weights, matches }) {
  const z = qualZ(qualScores, qualMaps.map((m) => m.bid));
  const base = qualBase(z, qualMaps, weights);
  const g = generalStrength({ ids, tr, seeds, ranked });
  const ratings = new Map();
  for (const [uid, b] of base) {
    if (!g.has(uid)) continue; // solo inscritos
    ratings.set(uid, Object.fromEntries(SKILLS.map((k) => [k, g.get(uid) + ELO.baseFactor * b[k]])));
  }
  const snap = () => Object.fromEntries([...ratings].map(([uid, r]) => [uid, { ...r }]));
  const qual = snap();
  const history = [];
  const mapsOf = new Map();
  for (const mt of matches) {
    let used = 0;
    for (const mp of mt.maps) {
      const w = weights.get(mp.key);
      const ra = ratings.get(mt.a), rb = ratings.get(mt.b);
      if (!w || !ra || !rb) continue;
      const r = duel(ra, rb, w, mp.w === mt.a, mapFactor(mp.slot, mp.ez));
      ratings.set(mt.a, r.a);
      ratings.set(mt.b, r.b);
      used++;
      for (const uid of [mt.a, mt.b]) mapsOf.set(uid, (mapsOf.get(uid) || 0) + 1);
    }
    if (used) history.push({ step: mt.id, at: mt.at, ratings: snap() });
  }
  return { qual, ratings, history, mapsOf, z, fromTr: g.fromTr };
}
