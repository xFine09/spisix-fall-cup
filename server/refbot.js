// Bot de arbitraje por fases: LOBBY → WARMUP → ROLL (protects) → PROTECT → ROLL (bans y picks) → BAN → PICK → READY
// → PLAY → (BAN | PICK) … → FIN.
// Módulo sin E/S: con el estado guardado del partido (ref_state), el turno que calcula refFlow y lo que se ve en el
// lobby, dice cuál es el paso siguiente (con los mensajes y comandos exactos que mandaría) y qué se está esperando.
// referee.js lo ejecuta solo en modo AUTO o lo enseña como botón en modo SEMI.
//
// Lo que decide refFlow (roll, orden, protects, bans, picks, TB y fin) no se guarda aquí: sale siempre de st.actions,
// así que «Apuntar a mano» y el bot nunca se contradicen. En st.bot solo va lo que refFlow no sabe: los pasos hechos
// del lobby, de los warmups y del ready, los temporizadores (hora límite absoluta), las advertencias, las incidencias,
// el log y el historial para deshacer.
//
// Lo que escriben los jugadores (rolls, «sí»/«no», códigos de mapa) nunca se apunta directamente: se guarda como dato
// de entrada y el paso siguiente lo convierte en una acción («Apuntar ban de DT1 (B)», «Rechazar NM9…»), que en AUTO
// ejecuta el bot y en SEMI pulsa el árbitro. Ninguna acción sanciona, descalifica ni da un partido por perdido.
import { modsFor, modOf } from './refflow.js';

export const newBot = () => ({
  mode: 'semi', paused: false, pausedAt: null, driver: null, stage: 'idle',
  sub: {}, done: {}, timers: {}, warnings: { a: 0, b: 0 }, incidents: [], log: [], history: [], seq: 0
});

const LOG_MAX = 200;
const HISTORY_MAX = 40;
export const CHECK_MS = 10_000;  // tiempo para que BanchoBot confirme el mapa y los mods (sin escalar)
export const START_MS = 20_000;  // tiempo para que empiece el mapa tras !mp start 5 (sin escalar)
export const SETTINGS_MS = 1500; // tiempo para leer la respuesta de !mp settings

const VERB = { protect: 'proteger', ban: 'banear', pick: 'elegir' };
const DOES = { protect: 'protege', ban: 'banea', pick: 'elige' };
const ASK = { protect: 'protege un mapa', ban: 'banea un mapa', pick: 'elige mapa' };
const PHASE = { protect: 'PROTECT', ban: 'BAN', pick: 'PICK' };
const LETTER = { protect: 'P', ban: 'B', pick: 'F' };
const MOD_NAMES = { nofail: 'NF', hidden: 'HD', hardrock: 'HR', doubletime: 'DT', nightcore: 'NC', easy: 'EZ', flashlight: 'FL', freemod: 'FM', halftime: 'HT', suddendeath: 'SD', perfect: 'PF' };
const ms = (ctx, sec) => Math.round(sec * 1000 * ctx.scale);
const on = (bot, k) => Boolean(bot.done[k]);
const other = (s) => (s === 'a' ? 'b' : 'a');
const kickName = (name) => String(name).trim().replace(/ /g, '_');

// ---------- log, incidencias e historial ----------
export function logBot(bot, by, text, now = Date.now()) {
  bot.log.push({ at: now, by, text });
  if (bot.log.length > LOG_MAX) bot.log.splice(0, bot.log.length - LOG_MAX);
}

// Incidencia del bot: queda abierta y el bot no hace nada solo (salvo avisos urgentes) hasta que el árbitro la resuelve.
export function incident(ctx, kind, text, extra = {}) {
  const { bot, now } = ctx;
  if (bot.incidents.some((i) => i.open && i.kind === kind)) return null;
  const inc = { id: ++bot.seq, at: now, by: 'bot', kind, text, open: true, block: true, ...extra };
  bot.incidents.push(inc);
  if (bot.incidents.length > 50) bot.incidents.splice(0, bot.incidents.length - 50);
  logBot(bot, 'bot', `Incidencia: ${text}`, now);
  return inc;
}
export const blocked = (bot) => bot.incidents.some((i) => i.open && i.block);

const SNAP = ['stage', 'sub', 'done', 'timers', 'warnings'];
export function remember(st, label, now = Date.now()) {
  const b = st.bot;
  const snap = JSON.parse(JSON.stringify({ roll: st.roll ?? null, roll2: st.roll2 ?? null, order: st.order ?? null, actions: st.actions || [], ...Object.fromEntries(SNAP.map((k) => [k, b[k]])) }));
  b.history.push({ label, at: now, snap });
  if (b.history.length > HISTORY_MAX) b.history.splice(0, b.history.length - HISTORY_MAX);
}
// Vuelve al estado de antes del último paso. Devuelve su nombre, o null si no hay historial.
export function undo(st) {
  const h = st.bot.history.pop();
  if (!h) return null;
  const s = h.snap;
  st.roll = s.roll; st.roll2 = s.roll2 ?? null; st.order = s.order; st.actions = s.actions;
  for (const k of SNAP) st.bot[k] = s[k];
  return h.label;
}

// Pausar congela los temporizadores; al reanudar se desplazan lo que ha durado la pausa.
export function setPaused(bot, paused, now = Date.now()) {
  if (Boolean(bot.paused) === paused) return false;
  if (paused) { bot.paused = true; bot.pausedAt = now; return true; }
  const d = now - (bot.pausedAt ?? now);
  for (const t of Object.values(bot.timers)) {
    if (!t) continue;
    if (t.until) t.until += d;
    if (t.next) t.next += d;
  }
  if (bot.sub.load?.at) bot.sub.load.at += d;
  if (bot.sub.startAt) bot.sub.startAt += d;
  bot.paused = false;
  bot.pausedAt = null;
  return true;
}

// ---------- mods ----------
// Respuestas de BanchoBot: «Enabled Hidden, NoFail, disabled FreeMod», «Disabled all mods, enabled FreeMod»,
// «Active mods: Hidden, NoFail» (en !mp settings). Devuelve el conjunto nuevo o undefined si la línea no es de mods.
export function parseMods(text, current) {
  let m;
  if ((m = text.match(/^Active mods: (.+)$/i))) {
    return new Set(m[1].split(/,\s*/).map((x) => MOD_NAMES[x.replace(/\s+/g, '').toLowerCase()]).filter(Boolean));
  }
  if (!/^(Enabled |Disabled all mods)/i.test(text)) return undefined;
  const set = new Set(current || []);
  let mode = 'enabled';
  for (const part of text.split(/,\s*/)) {
    const p = part.trim();
    if (/^disabled all mods$/i.test(p)) { set.clear(); continue; }
    const w = p.match(/^(?:(enabled|disabled)\s+)?(\w+)$/i);
    if (!w) continue;
    if (w[1]) mode = w[1].toLowerCase();
    const mod = MOD_NAMES[w[2].toLowerCase()];
    if (!mod) continue;
    if (mode === 'enabled') set.add(mod); else set.delete(mod);
  }
  return set;
}
export function modsMatch(set, slot) {
  if (!set) return false;
  const want = modsFor(slot) === 'Freemod' ? ['FM'] : modsFor(slot).split(' ');
  const have = new Set([...set].map((x) => (x === 'NC' ? 'DT' : x)));
  return want.length === have.size && want.every((x) => have.has(x));
}
const modsText = (slot) => (modsFor(slot) === 'Freemod' ? 'FreeMod' : modsFor(slot));

// ---------- entradas: lo que escriben los jugadores y lo que dice BanchoBot ----------
const turnKey = (f) => `${f.step}#${f[f.step + 's'].length}`;

export function onChat(ctx, side, text) {
  const { bot, f, pool } = ctx;
  const t = String(text).trim();
  if (bot.stage === 'warmup') {
    const wu = (bot.sub.wu ||= {});
    if (!on(bot, `wu:ask:${side}`) || wu[side] !== undefined) return false;
    if (/^(s[ií]|yes|y|vale|ok|claro)(?![a-z])/i.test(t)) wu[side] = true;
    else if (/^(no|nop|nope|n)(?![a-z])/i.test(t)) wu[side] = false;
    else return false;
    return true;
  }
  if (bot.stage !== 'match') return false;
  if (f.step === 'roll' && /^!roll\b/i.test(t)) {
    (bot.sub.rollReq ||= {})[side] = /^!roll$/i.test(t) ? 'ok' : 'bad';
    return true;
  }
  if (VERB[f.step] && side === f.by) {
    const m = t.match(/^([a-z]{2})\s*(\d{1,2})[.!]?$/i) || t.match(/^(tb)[.!]?$/i);
    if (!m) return false;
    const slot = (m[1] + (m[2] || '')).toUpperCase();
    let why = '';
    if (slot === 'TB') why = `El TB no se puede ${VERB[f.step]}`;
    else if (!pool.some((p) => p.slot === slot)) why = 'No está en la mappool';
    else why = f.allowed?.[slot] || '';
    bot.sub.input = { tk: turnKey(f), slot, why, n: ++bot.seq };
    return true;
  }
  return false;
}

// «X rolls N point(s)». Vale el primer roll de cada jugador. Se rechaza si se vio que escribió !roll con número
// (o si pasa de 100); si el bot no vio el comando, se da por bueno.
export function onRoll(ctx, side, n) {
  const { bot, f } = ctx;
  if (bot.stage !== 'match' || f.step !== 'roll') return false;
  let r = (bot.sub.rolls ||= {});
  // Si repiten tras un empate antes de que el bot lo anuncie, empieza otra pareja de rolls.
  if (r.a != null && r.b != null && r.a === r.b) r = bot.sub.rolls = {};
  if (r[side] != null) return false;
  const req = bot.sub.rollReq?.[side];
  if (bot.sub.rollReq) delete bot.sub.rollReq[side];
  if (req === 'bad' || n > 100) { bot.sub.rollBad = { side, n: ++bot.seq }; return true; }
  r[side] = n;
  r.n = ++bot.seq;
  return true;
}

// Fin de un mapa en el lobby: en los warmups, el del jugador que tiene el host.
export function onMapEnd(ctx) {
  const { bot } = ctx;
  const s = bot.sub.wuCur;
  if (bot.stage !== 'warmup' || !s || on(bot, `wu:end:${s}`)) return false;
  (bot.sub.wuFin ||= {})[s] = true;
  return true;
}

// ---------- temporizadores ----------
// Se llama cada segundo y tras cada evento. Solo crea avisos e incidencias: nunca manda nada al lobby por sí mismo.
export function tick(ctx) {
  const { bot, now, rules, f, lob, names } = ctx;
  if (bot.paused || bot.stage === 'idle' || bot.stage === 'fin' || f.ff) return false;
  let changed = false;
  const t = bot.timers.absent;
  if (bot.stage === 'lobby' && t && !t.expired && lob && now >= t.until && !(lob.has.a && lob.has.b) && !on(bot, 'lobby:wait')) {
    t.expired = true;
    const who = ['a', 'b'].filter((s) => !lob.has[s]).map((s) => names[s]).join(' y ');
    incident(ctx, 'absent', `${who} no ha llegado al lobby en ${rules.absentLimit} min. Avisa al staff: la decisión es de la organización (el forfeit se pone en Admin). El bot no da el partido por perdido.`);
    changed = true;
  }
  const p = bot.timers.pick;
  if (p && now >= p.until) {
    delete bot.timers.pick;
    if (f.step === 'pick' && p.tk === turnKey(f)) {
      bot.sub.pickOut = p.tk;
      incident(ctx, 'pick', `Se ha acabado el tiempo de pick de ${names[f.by]} (${rules.pickTimer} s). Decide el árbitro: el bot no elige mapa ni da la victoria.`, { tk: p.tk });
    }
    changed = true;
  }
  const r = bot.timers.ready;
  if (r && now >= r.until) {
    delete bot.timers.ready;
    if (f.step === 'play' && r.tk === `play#${f.picks.length}` && lob && !lob.playing && !lob.ready) {
      bot.sub.warnN = (bot.sub.warnN || 0) + 1;
      bot.sub.warn = { tk: r.tk, step: 'check', n: bot.sub.warnN };
    }
    changed = true;
  }
  if (f.step === 'play' && lob) {
    const tk = `play#${f.picks.length}`;
    const ld = bot.sub.load;
    if (ld?.tk === tk && ld.tries >= 1 && !ld.failed && !on(bot, `check:${tk}`) && now - ld.at >= CHECK_MS) {
      ld.failed = true;
      incident(ctx, 'tech', `Error técnico: el lobby no confirma ${problems(ctx, tk)} tras reintentarlo. Reintenta o sigue sin comprobar.`, { tk, what: 'check' });
      changed = true;
    }
    if (on(bot, `start:${tk}`) && bot.sub.startAt && !bot.sub.startFailed && !lob.playing && !lob.waiting && !lob.map?.played && now - bot.sub.startAt >= START_MS) {
      bot.sub.startFailed = true;
      incident(ctx, 'tech', 'Error técnico: el mapa no ha empezado tras !mp start. Reintenta o empiézalo a mano.', { tk, what: 'start' });
      changed = true;
    }
  }
  return changed;
}

function problems(ctx, tk) {
  const { lob, pool, f } = ctx;
  const e = pool.find((p) => p.slot === f.current);
  const out = [];
  if (lob.map?.bid !== e?.bid) out.push(`el mapa (${f.current})`);
  if (!modsMatch(lob.mods, f.current)) out.push(`los mods (${modsText(f.current)})`);
  if (lob.team.a === 'blue' || lob.team.b === 'red') out.push('los equipos');
  return out.join(', ') || 'el mapa';
}

// ---------- el paso siguiente ----------
// Devuelve { phase, step, text?, wait?, waitRef?, timer?, actions: [acción], skip? }.
// acción: { id, step, label, out: [líneas para el lobby], done?: clave, run?(ctx), auto?: false (en AUTO no se
//   ejecuta sola), urgent?: se ejecuta aunque haya una incidencia abierta, decision?: apunta algo de refFlow (no se
//   puede saltar), silent?: no manda nada y se ejecuta sola en los dos modos, special?: 'start' | 'make' | 'load' }.
// skip: undefined → se salta la primera acción (marcándola como hecha); null → este paso no se puede saltar.
export function plan(ctx) {
  const { bot, f } = ctx;
  if (f.ff) return { phase: 'FIN', step: 'FIN', text: 'Partido decidido por forfeit.', actions: [], skip: null };
  if (bot.stage === 'idle') {
    return { phase: 'LOBBY', step: 'A0', text: f.step === 'done' ? 'Partido terminado.' : 'Sin empezar.', skip: null,
      actions: f.step === 'done' ? [] : [{ id: 'start', step: 'A0', label: 'Iniciar partido', out: [], auto: false, special: 'start' }] };
  }
  if (bot.stage === 'fin') return { phase: 'FIN', step: 'FIN', text: 'Partido terminado.', actions: [], skip: null };
  if (bot.stage === 'lobby') return lobbyPlan(ctx);
  if (!ctx.lob) {
    const FLOW_PHASE = { roll: 'ROLL', order: 'ROLL', protect: 'PROTECT', ban: 'BAN', pick: 'PICK', tb: 'PICK', play: 'READY', done: 'FIN' };
    return { phase: bot.stage === 'warmup' ? 'WARMUP' : FLOW_PHASE[f.step] || 'LOBBY', step: '—', actions: [], skip: null,
      waitRef: 'El bot no está en el lobby: quien lo lleva tiene que conectar con Bancho y pulsar «Volver a entrar al MP». Seguirá desde aquí sin repetir nada.' };
  }
  if (bot.stage === 'warmup') return warmupPlan(ctx);
  return matchPlan(ctx);
}

function lobbyPlan(ctx) {
  const { bot, lob, names, ids, rules } = ctx;
  const P = (step, x) => ({ phase: 'LOBBY', step, actions: [], ...x });
  if (!on(bot, 'lobby:make')) {
    return P('A2', { text: 'Crear el lobby en Bancho.', skip: null,
      actions: [{ id: 'lobby:make', step: 'A2', label: 'Crear el lobby', out: [`!mp make ${ctx.lobbyName}`], special: 'make' }] });
  }
  if (!lob) return P('A3', { skip: null, waitRef: 'El lobby está creado, pero el bot no está dentro: pulsa «Volver a entrar al MP».' });
  const steps = [
    ['lobby:setup', 'A4', 'Team VS, ScoreV2 y 2 plazas', ['!mp set 2 3 2']],
    ['lobby:password', 'A5', 'Poner contraseña al lobby', [`!mp password ${bot.sub.pw}`]],
    ['lobby:invite', 'A6', `Invitar a ${names.a} y ${names.b}`, [`!mp invite #${ids.a}`, `!mp invite #${ids.b}`], (c) => {
      c.bot.timers.absent = { until: Math.max(c.now, c.time || 0) + ms(c, rules.absentLimit * 60), next: c.now + ms(c, rules.reinviteEvery), n: 0 };
    }]
  ];
  for (const [k, step, label, out, run] of steps) {
    if (!on(bot, k)) return P(step, { text: label + '.', actions: [{ id: k, step, label, out, done: k, run }] });
  }
  const missing = ['a', 'b'].filter((s) => !lob.has[s]);
  if (missing.length && !on(bot, 'lobby:wait')) {
    const t = bot.timers.absent || { n: 0 };
    const who = missing.map((s) => names[s]).join(' y ');
    return P('A8', {
      wait: `Esperando a ${who}. Se le reinvita cada ${rules.reinviteEvery} s.`, timer: 'absent',
      actions: [{ id: `lobby:reinvite:${t.n}`, step: 'A9', label: `Reinvitar a ${who}`, out: missing.map((s) => `!mp invite #${ids[s]}`),
        auto: !t.next || ctx.now >= t.next,
        run: (c) => { const x = c.bot.timers.absent; if (x) { x.next = c.now + ms(c, rules.reinviteEvery); x.n = (x.n || 0) + 1; } } }],
      skip: { label: 'Seguir sin esperar a los jugadores', done: 'lobby:wait' }
    });
  }
  // Los jugadores se reconocen por su nombre: si hay alguien más (o uno ha cambiado de nombre), la expulsión la
  // confirma siempre el árbitro, también en AUTO.
  return P('A12', {
    text: 'Los dos están en el lobby.',
    waitRef: lob.intruders.length ? `Hay alguien más en el lobby (${lob.intruders.join(', ')}). Comprueba que no es un jugador con otro nombre y confirma la expulsión.` : null,
    actions: [{ id: 'lobby:confirm', step: 'A12', auto: !lob.intruders.length, label: lob.intruders.length ? `Confirmar jugadores y equipos, y expulsar a ${lob.intruders.join(', ')}` : 'Confirmar jugadores y equipos (A rojo, B azul)',
      out: [`!mp team #${ids.a} red`, `!mp team #${ids.b} blue`, ...lob.intruders.map((n) => `!mp kick ${kickName(n)}`)],
      done: 'lobby:confirm', run: (c) => { delete c.bot.timers.absent; c.bot.stage = 'warmup'; } }]
  });
}

function warmupPlan(ctx) {
  const { bot, names, ids } = ctx;
  const P = (step, x) => ({ phase: 'WARMUP', step, actions: [], ...x });
  const wu = bot.sub.wu || {};
  const setWu = (s, v) => (c) => { (c.bot.sub.wu ||= {})[s] = v; c.bot.done[`wu:ask:${s}`] = true; };
  for (const [i, s] of ['a', 'b'].entries()) {
    const n = names[s], w = i * 4;
    if (!on(bot, `wu:ask:${s}`)) {
      return P(`W${w + 1}`, { actions: [{ id: `wu:ask:${s}`, label: `Preguntar a ${n} si quiere warmup`, out: [`${n}, ¿quieres warmup? Responde «sí» o «no» en el chat.`], done: `wu:ask:${s}` }],
        skip: { label: `Sin warmup de ${n}`, run: setWu(s, false) } });
    }
    if (wu[s] === undefined) {
      return P(`W${w + 2}`, { wait: `Esperando la respuesta de ${n} («sí» o «no»).`,
        actions: [{ id: `wu:yes:${s}`, label: `${n} quiere warmup`, out: [], auto: false, run: setWu(s, true) },
          { id: `wu:no:${s}`, label: `${n} no quiere warmup`, out: [], auto: false, run: setWu(s, false) }],
        skip: { label: `Sin warmup de ${n}`, run: setWu(s, false) } });
    }
    if (!wu[s]) continue;
    if (!on(bot, `wu:host:${s}`)) {
      return P(`W${w + 3}`, { actions: [{ id: `wu:host:${s}`, label: `Dar el host a ${n} para su warmup`, out: [`!mp host #${ids[s]}`, `${n}: tienes el host. Elige tu warmup y empiézalo cuando quieras.`],
        done: `wu:host:${s}`, run: (c) => { c.bot.sub.wuCur = s; } }] });
    }
    if (!on(bot, `wu:end:${s}`)) {
      const fin = bot.sub.wuFin?.[s];
      return P(`W${w + 4}`, { wait: fin ? null : `Warmup de ${n}: el bot espera a que termine el mapa.`,
        actions: [{ id: `wu:end:${s}`, label: 'Warmup terminado', out: [], done: `wu:end:${s}`, auto: Boolean(fin) }] });
    }
  }
  if (!on(bot, 'wu:clearhost')) return P('W9', { actions: [{ id: 'wu:clearhost', label: 'Quitar el host', out: ['!mp clearhost'], done: 'wu:clearhost' }] });
  return P('W10', { actions: [{ id: 'wu:restore', label: 'Restaurar la configuración oficial y pasar a los rolls',
    out: ['!mp set 2 3 2', `!mp team #${ids.a} red`, `!mp team #${ids.b} blue`], done: 'wu:restore', run: (c) => { c.bot.stage = 'match'; } }] });
}

function matchPlan(ctx) {
  const { bot, f, names, rules, lob, now, pool } = ctx;
  const n = (s) => names[s];
  if (f.step === 'done') {
    const w = f.winner;
    return { phase: 'FIN', step: 'FIN', actions: [{ id: 'fin', label: 'Anunciar el ganador', out: [`${n(w)} gana el partido ${f.score[w]} – ${f.score[other(w)]}. ¡GG!`], done: 'fin',
      run: (c) => { c.bot.stage = 'fin'; c.bot.timers = {}; } }] };
  }
  if (f.played && f.step !== 'play' && !on(bot, `score#${f.played}`)) {
    return { phase: 'PLAY', step: 'P3', actions: [{ id: `score#${f.played}`, label: 'Anunciar el marcador', out: [ctx.scoreLine], done: `score#${f.played}` }] };
  }

  // Dos rolls: el de protects (quien gana elige quién protege primero) y, tras los protects, el de bans y picks
  // (quien gana elige quién banea primero y quién elige primero). Sin protects en la ronda, solo el segundo.
  const RF = f.rollFor === 'protect'
    ? { key: 'roll', ask: 'roll:ask', oask: 'order:ask', what: 'los protects', label: 'protects', chooses: 'quién protege primero' }
    : { key: 'roll2', ask: 'roll2:ask', oask: 'order2:ask', what: 'bans y picks', label: 'bans y picks', chooses: 'quién banea primero y quién elige primero' };

  if (f.step === 'roll') {
    const R = (step, x) => ({ phase: 'ROLL', step, actions: [], ...x });
    const r = bot.sub.rolls || {};
    if (!on(bot, RF.ask)) return R('R1', { actions: [{ id: RF.ask, label: `Pedir los rolls de ${RF.label}`, out: [`Roll para ${RF.what}: haced !roll los dos (solo «!roll», sin número). Gana el más alto.`], done: RF.ask }] });
    if (bot.sub.rollBad) {
      const s = bot.sub.rollBad.side;
      return R('R3', { actions: [{ id: `roll:bad:${bot.sub.rollBad.n}`, label: `Rechazar el roll de ${n(s)}`, out: [`${n(s)}: solo vale «!roll», sin número. Repítelo.`], run: (c) => { delete c.bot.sub.rollBad; } }] });
    }
    if (r.a != null && r.b != null) {
      if (r.a === r.b) return R('R5', { actions: [{ id: `roll:tie:${r.n}`, label: 'Empate: repetir los rolls', out: [`Empate a ${r.a}. Repetid el !roll los dos.`], run: (c) => { c.bot.sub.rolls = {}; } }] });
      const w = r.a > r.b ? 'a' : 'b';
      return R('R6', { skip: null, actions: [{ id: `roll:win:${r.n}`, decision: true, label: `Apuntar: ${n(w)} gana el roll de ${RF.label} (${r[w]} – ${r[other(w)]})`,
        out: [`${n(w)} gana el roll (${r[w]} – ${r[other(w)]}) y elige ${RF.chooses}.`],
        run: (c) => { c.st[RF.key] = { winner: w, a: r.a, b: r.b }; c.bot.sub.rolls = {}; } }] });
    }
    return R('R2', { skip: null, wait: `Esperando el !roll de ${['a', 'b'].filter((s) => r[s] == null).map(n).join(' y ')} (roll de ${RF.label}).` });
  }

  if (f.step === 'order') {
    const w = f.by;
    if (!on(bot, RF.oask)) {
      return { phase: 'ROLL', step: 'R7', actions: [{ id: RF.oask, label: `Preguntar a ${n(w)} ${RF.chooses}`, out: [`${n(w)}: di en el chat ${RF.chooses}.`], done: RF.oask }] };
    }
    return { phase: 'ROLL', step: 'R8', actions: [], skip: null, waitRef: `${n(w)} elige ${RF.chooses}. Apúntalo en «Orden».` };
  }

  if (VERB[f.step]) {
    const type = f.step, by = f.by, tk = turnKey(f), PH = PHASE[type], L = LETTER[type];
    const timed = type === 'pick' && rules.pickTimer > 0;
    if (bot.sub.pickOut === tk && !on(bot, `pickout:${tk}`)) {
      return { phase: PH, step: `${L}12`, actions: [{ id: `pickout:${tk}`, urgent: true, label: `Avisar a ${n(by)}: tiempo agotado`, out: [`${n(by)}: se ha acabado el tiempo para elegir. Espera a lo que decida el árbitro.`], done: `pickout:${tk}` }] };
    }
    if (!on(bot, `turn:${tk}`)) {
      const tanda = type === 'ban' ? ` (tanda ${Math.floor(f.bans.length / 2) + 1} de ${rules.bans})` : '';
      return { phase: PH, step: `${L}1`, skip: { label: 'Turno sin anunciar', done: `turn:${tk}` },
        actions: [{ id: `turn:${tk}`, label: `Anunciar el turno de ${n(by)}`,
          out: [`${n(by)}, ${ASK[type]}${tanda}: escríbelo en el chat (p. ej. NM2).${timed ? ` Tienes ${rules.pickTimer} s.` : ''}`, ...(timed ? [`!mp timer ${rules.pickTimer}`] : [])],
          done: `turn:${tk}`, run: timed ? (c) => { c.bot.timers.pick = { tk, until: c.now + ms(c, rules.pickTimer) }; } : undefined }] };
    }
    const inp = bot.sub.input;
    if (inp && inp.tk === tk) {
      if (inp.why) {
        return { phase: PH, step: `${L}4`, actions: [{ id: `reject:${tk}:${inp.n}`, label: `Rechazar ${inp.slot} de ${n(by)}: ${inp.why.toLowerCase()}`,
          out: [`${n(by)}: ${inp.slot} no vale (${inp.why.toLowerCase()}). Escribe otro mapa.`], run: (c) => { delete c.bot.sub.input; } }] };
      }
      const e = pool.find((p) => p.slot === inp.slot);
      const out = type === 'pick'
        ? [...(bot.timers.pick ? ['!mp aborttimer'] : []), `${n(by)} elige ${inp.slot}: ${e?.title || ''}.`]
        : [`${n(by)} ${DOES[type]} ${inp.slot}.`];
      return { phase: PH, step: `${L}6`, skip: null, actions: [{ id: `rec:${tk}:${inp.slot}`, decision: true, label: `Apuntar ${type} de ${inp.slot} (${n(by)})`, out,
        run: (c) => { c.st.actions.push({ type, by, slot: inp.slot, at: c.now }); delete c.bot.sub.input; delete c.bot.timers.pick; } }] };
    }
    return { phase: PH, step: `${L}3`, skip: null, actions: [], timer: bot.timers.pick?.tk === tk ? 'pick' : null,
      wait: `Esperando que ${n(by)} escriba su ${type} en el chat.` };
  }

  if (f.step === 'tb') {
    if (!f.hasTb) return { phase: 'PICK', step: 'F2', actions: [], skip: null, waitRef: 'Toca el Tiebreaker, pero la mappool de esta ronda no tiene TB. Decide el árbitro.' };
    return { phase: 'PICK', step: 'F2', skip: null, actions: [{ id: `tb#${f.picks.length}`, decision: true, label: 'Activar el Tiebreaker',
      out: [`¡Tiebreaker! ${n('a')} ${f.score.a} – ${f.score.b} ${n('b')}.`], run: (c) => { c.st.actions.push({ type: 'pick', by: null, slot: 'TB', at: c.now }); } }] };
  }

  // f.step === 'play': el último pick todavía no se ha jugado → READY y PLAY
  const slot = f.current, tk = `play#${f.picks.length}`, e = pool.find((p) => p.slot === slot);
  const R = (step, x) => ({ phase: 'READY', step, actions: [], ...x });
  if (!e) return R('G0', { skip: null, waitRef: `${slot} no está en la mappool de esta ronda. Decide el árbitro.` });
  if (!on(bot, `load:${tk}`)) {
    return R('G1', { actions: [{ id: `load:${tk}`, label: `Cargar ${slot} con ${modsText(slot)}`, out: [`!mp map ${e.bid} 0`, `!mp mods ${modsFor(slot)}`], done: `load:${tk}`, special: 'load',
      run: (c) => { c.bot.sub.load = { tk, at: c.now, tries: 0 }; delete c.bot.sub.startFailed; } }] });
  }
  if (!on(bot, `check:${tk}`)) {
    const teamsOk = lob.team.a !== 'blue' && lob.team.b !== 'red';
    const ok = lob.map?.bid === e.bid && modsMatch(lob.mods, slot) && teamsOk;
    if (ok) return R('G3', { actions: [{ id: `check:${tk}`, silent: true, label: 'Mapa, mods y equipos correctos', out: [], done: `check:${tk}` }] });
    const ld = bot.sub.load || {};
    const skip = { label: 'Seguir sin comprobar', done: `check:${tk}` };
    if (ld.tk === tk && now - ld.at < CHECK_MS) return R('G3', { wait: 'Comprobando el mapa, los mods y los equipos en el lobby…', skip });
    if ((ld.tries || 0) < 1) {
      return R('G4', { skip, actions: [{ id: `recheck:${tk}`, label: `Reintentar: cargar ${slot} otra vez y comprobar`, special: 'load',
        out: [`!mp map ${e.bid} 0`, `!mp mods ${modsFor(slot)}`, `!mp team #${ctx.ids.a} red`, `!mp team #${ctx.ids.b} blue`, '!mp settings'],
        run: (c) => { c.bot.sub.load = { tk, at: c.now, tries: 1 }; } }] });
    }
    return R('G5', { skip, waitRef: `Error técnico: el lobby no confirma ${problems(ctx, tk)}.` });
  }
  if (!on(bot, `ready:${tk}`)) {
    const fm = modOf(slot) === 'FM' || modOf(slot) === 'TB';
    return R('G7', { actions: [{ id: `ready:${tk}`, label: 'Pedir ready', done: `ready:${tk}`,
      out: [`${slot}: ${e.title}${fm ? ' · FreeMod, NF obligatorio' : ''}. Pulsad Ready cuando estéis listos (${rules.readyTimer} s).`, `!mp timer ${rules.readyTimer}`],
      run: (c) => { c.bot.timers.ready = { tk, until: c.now + ms(c, rules.readyTimer) }; } }] });
  }
  if (!on(bot, `start:${tk}`)) {
    const start = { id: `start:${tk}`, label: lob.ready ? 'Iniciar el mapa' : 'Iniciar el mapa sin esperar al ready', auto: Boolean(lob.ready), done: `start:${tk}`,
      out: [...(lob.timer || bot.timers.ready ? ['!mp aborttimer'] : []), '!mp start 5'],
      run: (c) => { delete c.bot.timers.ready; delete c.bot.sub.warn; c.bot.sub.startAt = c.now; delete c.bot.sub.startFailed; } };
    const w = bot.sub.warn;
    if (!lob.ready && w?.tk === tk) {
      if (w.step === 'check') {
        return R('G11', { skip: null, actions: [{ id: `warn:check:${tk}:${w.n}`, label: 'Comprobar quién no está listo', out: ['!mp settings'],
          run: (c) => { c.bot.sub.warn = { ...w, step: 'wait', at: c.now }; } }, start] });
      }
      if (now - w.at < SETTINGS_MS) return R('G11', { skip: null, wait: 'Leyendo quién está listo…', actions: [start] });
      const late = ['a', 'b'].filter((s) => lob.rdy[s] === false);
      const max = rules.maxWarnings;
      const out = late.length ? late.map((s) => `${n(s)}: pulsa Ready. Advertencia ${Math.min(max, bot.warnings[s] + 1)} de ${max}.`) : ['Falta que alguien pulse Ready.'];
      return R('G12', { skip: null, actions: [{ id: `warn:send:${tk}:${w.n}`, label: late.length ? `Advertir a ${late.map(n).join(' y ')} por no estar listo` : 'Recordar que pulsen Ready', out,
        run: (c) => {
          for (const s of late) c.bot.warnings[s] = Math.min(max, c.bot.warnings[s] + 1);
          const reached = late.filter((s) => c.bot.warnings[s] >= max);
          if (reached.length) {
            incident(c, 'warnings', `${reached.map(n).join(' y ')} ha llegado a ${max} advertencias por no estar listo. Avisa al staff por si hay sanción: el bot no sanciona. Mientras, se sigue esperando.`);
          } else c.bot.timers.ready = { tk, until: c.now + ms(c, rules.readyTimer) };
          delete c.bot.sub.warn;
        } }, start] });
    }
    return R(lob.ready ? 'G9' : 'G8', { skip: null, timer: 'ready', wait: lob.ready ? null : 'Esperando a que los dos pulsen Ready.', actions: [start] });
  }
  if (lob.playing) return { phase: 'PLAY', step: 'P1', actions: [], skip: null, wait: `Jugando ${slot}.` };
  if (lob.waiting || (lob.map?.played && lob.map.bid === e.bid)) return { phase: 'PLAY', step: 'P2', actions: [], skip: null, wait: 'Mapa terminado: leyendo el resultado en la API de osu!…' };
  return R('G10', { skip: null, wait: 'Esperando a que empiece el mapa…',
    actions: [{ id: `again:${tk}:${bot.sub.again || 0}`, auto: false, label: 'Volver a pedir ready (si se abortó)', out: [],
      run: (c) => { delete c.bot.done[`ready:${tk}`]; delete c.bot.done[`start:${tk}`]; c.bot.sub.again = (c.bot.sub.again || 0) + 1; delete c.bot.sub.startAt; } }] });
}

// El salto del paso actual: { label, done?, run? } o null.
export function skipOf(p) {
  if (p.skip !== undefined) return p.skip;
  const a = p.actions.find((x) => !x.decision && !x.special && !x.silent);
  return a ? { label: a.label, done: a.done, run: a.run } : null;
}
