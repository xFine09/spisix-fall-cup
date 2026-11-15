// Cliente de la API pública de o!TR (osu! Tournament Rating): https://otr.stagec.net/api
// - Necesita una clave propia: OTR_API_KEY (se crea en https://otr.stagec.net/settings). Sin clave no se pide nada
//   y la web funciona igual, sin la sección de o!TR en la ficha.
// - La clave va en la cabecera Authorization y no se escribe nunca en la base de datos, en el log ni en los errores.
// - o!TR deja 60 peticiones por minuto por clave: aquí se hace como mucho 1 cada 1,5 segundos.

const BASE = (process.env.OTR_BASE || 'https://otr.stagec.net').replace(/\/$/, '');
const KEY = process.env.OTR_API_KEY || '';
const GAP_MS = process.env.OTR_GAP_MS != null ? +process.env.OTR_GAP_MS : 1500;
const TIMEOUT_MS = 15_000;

export const configured = () => Boolean(KEY);
export const site = BASE;

export class OtrError extends Error {
  constructor(status, what) {
    super(status ? `o!TR respondió ${status} al pedir ${what}` : `o!TR no ha respondido al pedir ${what}`);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let queue = Promise.resolve();
let last = 0;
function throttled(fn) {
  const p = queue.then(async () => {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    return fn();
  });
  queue = p.catch(() => {});
  return p;
}

// Estadísticas de un jugador por su ID de osu! en osu! standard (ruleset 0). null si o!TR no lo conoce.
export function playerStats(osuId) {
  const what = `las estadísticas del jugador ${osuId}`;
  return throttled(async () => {
    let r;
    try {
      r = await fetch(`${BASE}/api/players/${encodeURIComponent(osuId)}/stats?keyType=osu&ruleset=0`, {
        headers: { Authorization: 'Bearer ' + KEY, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch {
      throw new OtrError(0, what);
    }
    if (r.status === 404) return null;
    if (!r.ok) throw new OtrError(r.status, what);
    return r.json();
  });
}

// Mods de o!TR (máscara de bits de osu!) → siglas. NF no cuenta (en torneo se juega casi siempre con NF) y NC es DT.
const MOD_BITS = [[2, 'EZ'], [8, 'HD'], [16, 'HR'], [64, 'DT'], [512, 'DT'], [256, 'HT'], [1024, 'FL']];
export function modLabel(bits) {
  const out = [];
  for (const [bit, name] of MOD_BITS) if (bits & bit && !out.includes(name)) out.push(name);
  return out.join('') || 'NM';
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Lo que se guarda de cada jugador: solo datos públicos de o!TR. modStats se agrupa por siglas (sin NF), con la
// puntuación media ponderada por el número de partidas.
export function summarize(st) {
  const r = st?.rating || null;
  const byMod = new Map();
  for (const m of st?.modStats || []) {
    const count = num(m.count) || 0;
    if (!count) continue;
    const k = modLabel(num(m.mods) || 0);
    const g = byMod.get(k) || { mods: k, count: 0, total: 0 };
    g.count += count;
    g.total += (num(m.averageScore) || 0) * count;
    byMod.set(k, g);
  }
  const mods = [...byMod.values()].map((g) => ({ mods: g.mods, count: g.count, average: Math.round(g.total / g.count) }))
    .sort((a, b) => b.count - a.count);
  return {
    found: Boolean(st), // false: o!TR no tiene a este jugador
    otr_id: st?.playerInfo?.id ?? null,
    rating: num(r?.rating),
    percentile: num(r?.percentile),
    global_rank: num(r?.globalRank),
    country_rank: num(r?.countryRank),
    tier: r?.tierProgress?.currentTier ?? null,
    sub_tier: num(r?.tierProgress?.currentSubTier),
    provisional: Boolean(r?.isProvisional),
    tournaments: num(r?.tournamentsPlayed),
    matches: num(r?.matchesPlayed),
    win_rate: num(r?.winRate) ?? num(st?.matchStats?.matchWinRate),
    mods
  };
}
