// Orden de un partido del cuadro según las normas (pestaña Info) y las reglas de la ronda:
// roll → quien lo gana elige quién protege, banea y elige primero → protects alternos → bans por tandas
// (uno cada jugador; la tanda siguiente tras rules.banEvery mapas jugados, con el orden invertido: ABBA)
// → picks alternos desde el First Pick → tiebreaker si los dos se quedan a un mapa de ganar.
// No se puede banear ni elegir el mismo mod que en el ban o pick anterior propio, ni banear un mapa protegido.

export const DEFAULT_RULES = { bans: 2, protects: 1, banEvery: 4, pickTimer: 90 };
export const other = (side) => (side === 'a' ? 'b' : 'a');
export const modOf = (slot) => (slot === 'TB' ? 'TB' : slot.slice(0, 2));

// Mods del lobby para cada slot. FM y TB en FreeMod (el NF lo pone cada jugador, como piden las normas).
export function modsFor(slot) {
  const mod = modOf(slot);
  if (mod === 'FM' || mod === 'TB') return 'Freemod';
  return mod === 'NM' ? 'NF' : 'NF ' + mod;
}

// st: { roll: { a, b, winner }, order: { protect, ban, pick }, actions: [{ type, by, slot }] }
// slots: slots de la mappool de la ronda · played: slots ya jugados (del MP) · score: { a, b } · need: mapas para ganar
export function refFlow({ rules, st, slots, played, score, need }) {
  const acts = st.actions || [];
  const protects = acts.filter((x) => x.type === 'protect');
  const bans = acts.filter((x) => x.type === 'ban');
  const picks = acts.filter((x) => x.type === 'pick');
  const base = { protects, bans, picks, score, need, played: played.length, roll: st.roll || null, order: st.order || null };
  if (score.a >= need || score.b >= need) return { ...base, step: 'done', winner: score.a >= need ? 'a' : 'b' };
  const last = picks.at(-1);
  if (last && !played.includes(last.slot)) return { ...base, step: 'play', current: last.slot, by: last.by };
  if (!st.roll?.winner) return { ...base, step: 'roll' };
  const o = st.order || {};
  if (!o.protect || !o.ban || !o.pick) return { ...base, step: 'order', by: st.roll.winner };

  const lastOf = (type, by) => acts.filter((x) => x.type === type && x.by === by).at(-1);
  const allowed = (type, by) => {
    const out = {};
    for (const slot of slots) {
      if (slot === 'TB') continue;
      let why = '';
      if (type === 'protect') {
        if (protects.some((x) => x.slot === slot)) why = 'Ya está protegido';
      } else if (type === 'ban') {
        if (protects.some((x) => x.slot === slot)) why = 'Está protegido';
        else if (bans.some((x) => x.slot === slot)) why = 'Ya está baneado';
        else if (picks.some((x) => x.slot === slot)) why = 'Ya se ha jugado';
        else if (lastOf('ban', by) && modOf(lastOf('ban', by).slot) === modOf(slot)) why = 'Mismo mod que su ban anterior';
      } else {
        if (bans.some((x) => x.slot === slot)) why = 'Está baneado';
        else if (picks.some((x) => x.slot === slot)) why = 'Ya se ha elegido';
        else if (lastOf('pick', by) && modOf(lastOf('pick', by).slot) === modOf(slot)) why = 'Mismo mod que su pick anterior';
      }
      out[slot] = why;
    }
    return out;
  };

  if (protects.length < rules.protects * 2) {
    const by = protects.length % 2 === 0 ? o.protect : other(o.protect);
    return { ...base, step: 'protect', by, allowed: allowed('protect', by) };
  }
  const tanda = Math.floor(bans.length / 2);
  if (tanda < rules.bans && played.length >= tanda * rules.banEvery) {
    const first = tanda % 2 === 0 ? o.ban : other(o.ban); // ABBA: quien abre una tanda cierra la siguiente
    const by = bans.length % 2 === 0 ? first : other(first);
    return { ...base, step: 'ban', by, allowed: allowed('ban', by) };
  }
  if (score.a === need - 1 && score.b === need - 1) return { ...base, step: 'tb', hasTb: slots.includes('TB') };
  const n = picks.filter((x) => x.slot !== 'TB').length;
  const by = n % 2 === 0 ? o.pick : other(o.pick);
  return { ...base, step: 'pick', by, allowed: allowed('pick', by) };
}
