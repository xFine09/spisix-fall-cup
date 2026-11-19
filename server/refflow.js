// Orden de un partido del cuadro según las normas (pestaña Info) y las reglas de la ronda:
// roll → quien lo gana elige quién protege, banea y elige primero → protects alternos → bans por tandas
// (uno cada jugador; la tanda siguiente tras rules.banEvery mapas jugados, con el orden invertido: ABBA)
// → picks alternos desde el First Pick → tiebreaker si los dos se quedan a un mapa de ganar.
// No se puede banear ni elegir el mismo mod que en el ban o pick anterior propio, ni banear un mapa protegido.

// pickTimer y readyTimer en segundos (pickTimer 0: sin temporizador), absentLimit en minutos, reinviteEvery en segundos,
// maxWarnings: advertencias por no estar listo antes de avisar al staff (el bot nunca sanciona).
export const DEFAULT_RULES = { bans: 2, protects: 1, banEvery: 4, pickTimer: 90, readyTimer: 30, absentLimit: 15, reinviteEvery: 60, maxWarnings: 3 };
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

// Completar un partido después de jugarlo: con el orden y las listas de protects, bans (en el orden en que se
// dijeron, todas las tandas seguidas) y picks, reconstruye las acciones en el orden real del partido.
// Se recorre refFlow paso a paso como si se arbitrara en directo, y el marcador avanza con el ganador de cada
// pick en el MP: así cada protect, ban y pick va a quien le tocaba, la segunda tanda de bans cae tras banEvery
// mapas (o justo antes del TB) y se aplican las mismas reglas. El TB se añade solo si el MP lo tiene.
// winners: slot → 'a' | 'b' (ganador de ese mapa en el MP). Devuelve { actions } o { error }.
const NAMES = { protect: 'protects', ban: 'bans', pick: 'picks' };
export function buildActions({ rules, order, protects, bans, picks, slots, winners, need }) {
  const queues = { protect: [...protects], ban: [...bans], pick: [...picks] };
  for (const [type, list] of Object.entries(queues)) {
    for (const slot of list) {
      if (!slots.includes(slot)) return { error: `${slot} no está en la mappool de esta ronda.` };
      if (slot === 'TB') return { error: `El TB no se puede poner en ${NAMES[type]}: se añade solo si se jugó.` };
    }
  }
  for (const slot of picks) if (!(slot in winners)) return { error: `${slot} no se jugó en el MP: quítalo de los picks.` };
  const st = { roll: { winner: order.protect }, order, actions: [] };
  const played = [];
  const score = { a: 0, b: 0 };
  for (let guard = 0; guard < 100; guard++) {
    const f = refFlow({ rules, st, slots, played, score, need });
    if (f.step === 'done') break;
    if (f.step === 'tb') {
      if (!('TB' in winners)) {
        if (queues.pick.length) break; // sobran picks: se avisa abajo
        return { error: `Con estos picks el partido llega a ${score.a} – ${score.b}, pero el MP no tiene el TB. Revisa los picks.` };
      }
      st.actions.push({ type: 'pick', by: null, slot: 'TB' });
      played.push('TB');
      score[winners.TB]++;
      continue;
    }
    const q = queues[f.step];
    if (!q.length) {
      if (f.step === 'pick') return { error: `Faltan picks: con estos mapas el partido queda ${score.a} – ${score.b} y no ha terminado.` };
      const total = f.step === 'protect' ? rules.protects * 2 : null;
      return { error: f.step === 'protect'
        ? `Faltan protects: esta ronda tiene ${rules.protects} por jugador (${total} en total).`
        : `Faltan bans: tras ${played.length} mapa${played.length === 1 ? '' : 's'} tocaba la tanda ${Math.floor(st.actions.filter((x) => x.type === 'ban').length / 2) + 1} (esta ronda tiene ${rules.bans} por jugador, una tanda cada ${rules.banEvery} mapas).` };
    }
    const slot = q.shift();
    const why = f.allowed[slot];
    const n = st.actions.filter((x) => x.type === f.step).length + 1;
    if (why) return { error: `${NAMES[f.step][0].toUpperCase()}${NAMES[f.step].slice(1, -1)} ${n} (${slot}): ${why.toLowerCase()}.` };
    st.actions.push({ type: f.step, by: f.by, slot });
    if (f.step === 'pick') { played.push(slot); score[winners[slot]]++; }
  }
  const left = Object.entries(queues).filter(([, l]) => l.length).map(([type, l]) => `${NAMES[type]} (${l.join(', ')})`);
  if (left.length) return { error: `Sobran ${left.join(' y ')}: el partido ya había terminado o no tocaban según las reglas de la ronda.` };
  return { actions: st.actions };
}
