// Arbitraje con bot de IRC. Cada árbitro conecta su cuenta a Bancho con su contraseña IRC (solo en memoria,
// nunca en disco ni en los logs) y la web manda los comandos !mp por él.
// Cada partido del cuadro tiene un bot por fases (server/refbot.js) en uno de dos modos, que se cambia en cualquier
// momento desde Arbitrar:
// - SEMIAUTOMÁTICO (por defecto): cada paso que el bot haría solo sale como botón y no se manda nada al lobby
//   hasta pulsarlo. Lo que escriben los jugadores solo prepara el botón siguiente.
// - AUTOMÁTICO: el bot ejecuta cada paso él mismo, de uno en uno y respetando el límite de mensajes de Bancho.
// En los dos modos siguen los botones de siempre («Apuntar a mano»), y el bot nunca sanciona, descalifica ni da
// un partido por perdido: avisa y espera al árbitro. El bot solo actúa desde la sesión de un árbitro (quien lo
// lleva, «driver»), así que con dos árbitros en el mismo lobby no se manda nada dos veces.
// El estado de cada partido (y el del bot) se guarda en la base de datos; la conexión a Bancho no.
import { randomBytes } from 'node:crypto';
import { Bancho, ircName } from './irc.js';
import { refFlow, buildActions, modsFor, modOf } from './refflow.js';
import { newBot, plan, tick, skipOf, onChat, onRoll, onMapEnd, parseMods, logBot, incident, blocked, remember, undo as undoBot, setPaused } from './refbot.js';

const LOG_MAX = 300;
const IDLE_MS = 3 * 3600e3;   // 3 horas sin usar la web y sin página abierta: se cierra la conexión y se olvida la contraseña
const READ_GAP = +process.env.OSU_MATCH_GAP_MS || 60e3; // términos de la API de osu!: el mismo MP no se lee más de una vez por minuto
const SYNC_TRIES = 3;
const MAKE_TRIES = 2;
// Solo para la prueba: acorta los temporizadores del bot (pick, ready, ausencia, reinvitaciones). Los segundos que
// se anuncian en el lobby no cambian.
const TIME_SCALE = +process.env.REF_TIME_SCALE > 0 ? +process.env.REF_TIME_SCALE : 1;
const TICK_MS = TIME_SCALE < 1 ? 200 : 1000;
// En AUTO, como mucho un paso cada cuarto de ventana del límite de Bancho (1,25 s): nunca ráfagas.
const AUTO_GAP = Math.round((+process.env.BANCHO_RATE_MS || 5000) / 4);
const TYPES = { protect: 'protege', ban: 'banea', pick: 'elige' };
const VERB = { protect: 'proteger', ban: 'banear', pick: 'elegir' };
const nfmt = new Intl.NumberFormat('es-ES');

export function createReferee(deps) {
  const { q, CONFIG, HttpError, bracket, syncMatch, syncQual, poolOf, rulesOf, label, need, phaseOf, sinceRead, visible } = deps;
  const sessions = new Map();  // userId → conexión a Bancho de ese árbitro
  const listeners = new Map(); // userId → páginas abiertas (SSE)
  const inflight = new Set();  // partidos con un paso en marcha (crear el lobby)
  const nextAuto = new Map();  // partido → no antes de esta hora el siguiente paso automático
  const kicks = new Map();

  // ---------- estado guardado ----------
  const loadState = (key) => { const r = q.getRefState.get(key); return r ? JSON.parse(r.data) : {}; };
  const saveState = (key, st) => q.setRefState.run(key, JSON.stringify(st), Date.now());
  const matchState = (key) => {
    const st = { roll: null, order: null, actions: [], ...loadState(key) };
    st.bot = { ...newBot(), ...(st.bot || {}) };
    return st;
  };
  const qualState = (key) => ({ played: [], ...loadState(key) });
  const saveBans = (key, st) => q.setBans.run(key, JSON.stringify(st.actions.filter((x) => x.type === 'ban').map((x) => x.slot)), Date.now());

  const poolView = (round) => poolOf(round).map((p) => ({
    slot: p.slot, bid: p.beatmap_id, title: `${p.data.artist} - ${p.data.title} [${p.data.version}]`, sr: p.data.sr
  }));

  function baseFlow(id, br = bracket()) {
    const m = br.matches[id];
    const rec = q.getMatch.get(id);
    const result = rec?.result ? JSON.parse(rec.result) : null;
    const wins = result?.wins || {};
    const round = phaseOf(id);
    const slots = poolOf(round).map((p) => p.slot);
    const rules = rulesOf(round);
    let f = refFlow({
      rules, st: matchState(id), slots, played: (result?.maps || []).map((x) => x.slot),
      score: { a: m.a ? wins[m.a.id] || 0 : 0, b: m.b ? wins[m.b.id] || 0 : 0 }, need: need(id)
    });
    if (rec?.ff) f = { ...f, step: 'done', winner: rec.ff, ff: true };
    const pl = (p) => p && { id: p.id, username: p.username };
    const maps = (result?.maps || []).map((x) => ({
      slot: x.slot, w: x.w === m.a?.id ? 'a' : 'b', a: x.scores[m.a?.id] ?? null, b: x.scores[m.b?.id] ?? null
    }));
    // «Completar después del partido»: partido terminado con su MP leído y sin forfeit. Se sugiere si no tiene
    // acciones apuntadas, si tiene menos picks que mapas jugados o menos protects de los de la ronda.
    const canFill = Boolean(rec?.mp && maps.length && f.step === 'done' && !f.ff && slots.length);
    const incomplete = !(f.protects.length + f.bans.length + f.picks.length) || f.picks.length < maps.length || f.protects.length < rules.protects * 2;
    return { ...f, id, round, rules, label: label(id), time: rec?.time ?? null, ref: rec?.ref || null, a: pl(m.a), b: pl(m.b), mp: rec?.mp || null, maps, noPool: !slots.length,
      canFill, fillSuggested: canFill && incomplete };
  }
  const flowOf = (id, br) => { const f = baseFlow(id, br); return f.a && f.b ? { ...f, bot: botView(id, f) } : f; };

  // ---------- avisos a las páginas abiertas (SSE) ----------
  // El estado de los partidos es común: cualquier cambio se manda a todos los árbitros con la página abierta.
  let flushTimer = null;
  function push() {
    if (listeners.size) flushTimer ??= setTimeout(flush, 150);
  }
  function flush() {
    flushTimer = null;
    for (const [id, set] of listeners) {
      if (!set.size) continue;
      const data = `data: ${JSON.stringify(view(id))}\n\n`;
      for (const res of set) res.write(data);
    }
  }
  function subscribe(user, res) {
    if (!listeners.has(user.id)) listeners.set(user.id, new Set());
    listeners.get(user.id).add(res);
    const s = sessions.get(user.id);
    if (s) s.lastUsed = Date.now();
    res.write(`retry: 3000\ndata: ${JSON.stringify(view(user.id))}\n\n`);
    return () => {
      const set = listeners.get(user.id);
      set?.delete(res);
      if (set && !set.size) listeners.delete(user.id);
    };
  }

  function view(userId) {
    const s = sessions.get(userId);
    const br = bracket();
    const flows = {};
    const pools = {};
    const addPool = (round) => { if (!(round in pools)) pools[round] = visible(round, userId) ? poolView(round) : null; };
    for (const [id, m] of Object.entries(br.matches)) {
      if (!m.a || !m.b) continue;
      flows[id] = flowOf(id, br);
      addPool(flows[id].round);
    }
    addPool('qualifiers');
    return {
      irc: s ? { status: s.status, nick: ircName(s.username), error: s.error } : { status: 'off' },
      log: s ? s.log.slice(-30) : [],
      lobbies: s ? [...s.lobbies.values()].map((l) => ({
        mp: l.mp, kind: l.kind, key: l.key, name: l.name, closed: l.closed, playing: l.playing, waiting: l.waiting,
        map: l.map, ready: l.ready, timer: l.timer, badMode: l.badMode, mods: l.mods ? [...l.mods] : null,
        players: [...l.players.values()], scores: Object.values(l.scores), log: l.log.slice(-150),
        ...(l.kind === 'qual' ? { played: qualState(l.key).played } : {})
      })) : [],
      quals: q.quals.all().map((x) => ({ mp: x.mp, name: (x.data && JSON.parse(x.data).name) || null })),
      slots: q.qualSlots.all().map((x) => ({ id: x.id, name: x.name, time: x.time, size: x.size, mp: x.mp, ref_id: x.ref_id, ref_name: x.ref_name, signed: q.slotPlayers.all(x.id).length, pending: q.slotCount.get(x.id).n - q.slotPlayers.all(x.id).length })),
      flows, pools
    };
  }

  // ---------- conexión a Bancho ----------
  function addLog(target, from, text, own = false) {
    target.log.push({ at: Date.now(), from, text, own });
    if (target.log.length > LOG_MAX) target.log.splice(0, target.log.length - LOG_MAX);
  }
  const lobbyOfChannel = (s, ch) => (ch?.startsWith('#mp_') ? s.lobbies.get(ch.slice(4)) : null);
  const lobbyOfKey = (s, key) => [...s.lobbies.values()].find((l) => l.key === key && !l.closed);
  const say = (s, l, text, opts) => s.client?.say('#mp_' + l.mp, text, opts);
  // ready: Bancho ha dicho que todos están listos · badMode: el lobby de clasificatorios no está en HeadToHead con ScoreV2
  // mods: mods del lobby según BanchoBot (null: sin confirmar) · readyAt: antes de esa hora el bot no actúa (al volver a entrar)
  const newLobby = (fields) => ({ players: new Map(), map: null, playing: false, waiting: false, closed: false, log: [], scores: {}, timer: false, ready: false, badMode: null, mods: null, readyAt: 0, ...fields });

  async function open(s) {
    const c = new Bancho(s.username, s.password);
    s.client = c;
    c.on('message', (m) => onMessage(s, m));
    c.on('out', ({ target, text }) => {
      const l = lobbyOfChannel(s, target);
      addLog(l || s, c.nick, l ? text : `→ ${target}: ${text}`, true);
      push();
    });
    c.on('join', (ch) => {
      const l = lobbyOfChannel(s, ch);
      if (!l) return;
      l.closed = false;
      if (l.attaching) {
        l.attaching = false;
        // Al volver a entrar, el bot espera a leer !mp settings (jugadores, mapa y mods) antes de seguir.
        l.readyAt = Date.now() + 2000;
        addLog(l, 'web', 'Has vuelto a entrar al lobby.');
        say(s, l, '!mp settings');
        if (l.kind === 'match') kick(l.key, 2100);
      }
      push();
    });
    c.on('nochannel', (ch) => {
      const l = lobbyOfChannel(s, ch);
      if (!l) return;
      l.closed = true;
      l.attaching = false;
      addLog(l, 'web', 'Bancho dice que este lobby no existe o ya está cerrado (o no eres árbitro de él).');
      push();
    });
    c.on('close', () => onDrop(s));
    await c.connect();
    s.status = 'connected';
    s.error = '';
    s.retries = 0;
    for (const l of s.lobbies.values()) if (l.attaching) c.join('#mp_' + l.mp);
    push();
  }

  // Si se corta, se reintenta 3 veces (a los 5, 10 y 15 s) y se vuelve a entrar a los lobbies abiertos.
  function onDrop(s) {
    if (sessions.get(s.userId) !== s) return;
    for (const l of s.lobbies.values()) if (!l.closed) l.attaching = true;
    if (s.retries >= 3) {
      s.status = 'error';
      s.error = 'Se ha perdido la conexión con Bancho. Vuelve a conectar.';
      return push();
    }
    s.status = 'reconnecting';
    s.retries++;
    push();
    setTimeout(async () => {
      if (sessions.get(s.userId) !== s) return;
      try { await open(s); } catch { onDrop(s); }
    }, 5000 * s.retries).unref();
  }

  async function connect(user, password) {
    password = String(password || '').trim();
    if (!/^\S{4,64}$/.test(password)) throw new HttpError(400, 'Pega tu contraseña IRC de osu! (sin espacios).');
    const old = sessions.get(user.id);
    if (old) { sessions.delete(user.id); old.password = null; old.client?.close(); }
    // Los lobbies que tenías abiertos se conservan: al conectar se vuelve a entrar en ellos.
    const s = { userId: user.id, username: user.username, password, client: null, status: 'connecting', error: '', lobbies: old?.lobbies || new Map(), log: old?.log || [], pendingMake: null, lastUsed: Date.now(), retries: 0 };
    for (const l of s.lobbies.values()) if (!l.closed) l.attaching = true;
    sessions.set(user.id, s);
    push();
    try {
      await open(s);
    } catch (e) {
      if (sessions.get(user.id) === s) sessions.delete(user.id);
      s.password = null;
      push();
      throw new HttpError(400, e.message);
    }
  }

  function closeSession(s) {
    sessions.delete(s.userId);
    s.password = null;
    s.client?.close();
    for (const l of s.lobbies.values()) stopSync(l);
    if (s.pendingMake) { clearTimeout(s.pendingMake.timer); s.pendingMake.reject(new HttpError(409, 'Te has desconectado.')); }
    push();
  }

  function sessionFor(user) {
    const s = sessions.get(user.id);
    if (!s || s.status !== 'connected') throw new HttpError(409, s?.status === 'reconnecting' ? 'Reconectando con Bancho… Espera unos segundos.' : 'Conecta antes tu cuenta a Bancho (IRC).');
    s.lastUsed = Date.now();
    return s;
  }

  // ---------- mensajes de Bancho ----------
  function onMessage(s, { from, target, text }) {
    if (target.startsWith('#')) {
      const l = lobbyOfChannel(s, target);
      if (!l) return;
      addLog(l, from, text);
      if (from === 'BanchoBot') bancho(s, l, text);
      else if (l.kind === 'match') {
        const side = sideOf(l, from);
        if (side) botInput(s, l, (ctx) => onChat(ctx, side, text));
      }
      return push();
    }
    // Mensaje privado: la respuesta de BanchoBot a !mp make, o cualquier otro aviso.
    if (from === 'BanchoBot' && s.pendingMake) {
      const p = s.pendingMake;
      s.pendingMake = null;
      clearTimeout(p.timer);
      const m = text.match(/^Created the tournament match https:\/\/osu\.ppy\.sh\/mp\/(\d+)/);
      if (m) p.resolve(m[1]);
      else if (/cannot create any more/i.test(text)) {
        p.reject(new HttpError(409, 'osu! solo deja tener 4 lobbies de torneo abiertos a la vez por cuenta. Cierra los que ya no uses (Cerrar lobby, o !mp close dentro de cada uno) y vuelve a intentarlo.'));
      } else p.reject(new HttpError(502, 'BanchoBot: ' + text));
    }
    addLog(s, from, text);
    push();
  }

  const nameKey = (name) => ircName(name).toLowerCase();
  const sideOf = (l, name) => (l.a && nameKey(name) === nameKey(l.a.username) ? 'a' : l.b && nameKey(name) === nameKey(l.b.username) ? 'b' : null);
  const slotOfBid = (l, bid) => poolView(l.kind === 'qual' ? 'qualifiers' : phaseOf(l.key)).find((p) => p.bid === bid)?.slot || null;

  function bancho(s, l, text) {
    let m;
    if ((m = text.match(/^(.+) joined in slot (\d+)(?: for team (red|blue))?\.$/))) {
      l.players.set(nameKey(m[1]), { name: m[1], slot: +m[2], team: m[3] || null, ready: false });
      l.ready = false;
      return l.kind === 'match' && kick(l.key);
    }
    if ((m = text.match(/^(.+) left the game\.$/))) { l.players.delete(nameKey(m[1])); l.ready = false; return; }
    if ((m = text.match(/^(.+) moved to slot (\d+)$/))) { const p = l.players.get(nameKey(m[1])); if (p) p.slot = +m[2]; return; }
    if ((m = text.match(/^(.+) changed to (Red|Blue)$/))) { const p = l.players.get(nameKey(m[1])); if (p) p.team = m[2].toLowerCase(); return; }
    // Respuesta a !mp settings. Un lobby de clasificatorios tiene que ser head to head con ScoreV2: si no, se avisa
    // al árbitro (con un botón para corregirlo), sin cambiarlo por él.
    if ((m = text.match(/^Team mode: (\w+), Win condition: (\w+)$/i))) {
      if (l.kind === 'qual') l.badMode = m[1] !== 'HeadToHead' || m[2] !== 'ScoreV2' ? `${m[1]} con ${m[2]}` : null;
      return;
    }
    // Respuesta a !mp settings (al volver a entrar): «Slot 1  Not Ready https://osu.ppy.sh/u/123 Nombre  [Team Red ]»
    if ((m = text.match(/^Slot (\d+)\s+(Ready|Not Ready|No Map)\s+https:\/\/osu\.ppy\.sh\/u\/(\d+) (.+?)\s*(?:\[([^\]]*)\])?$/))) {
      const team = /team (red|blue)/i.exec(m[5] || '')?.[1]?.toLowerCase() || null;
      // Con el ID se sabe el nombre exacto aunque lleve corchetes (el resto de la línea es «[Host / Team Red / Hidden]»).
      const name = [l.a, l.b].find((p) => p?.id === +m[3])?.username || m[4].trim();
      l.players.set(nameKey(name), { name, slot: +m[1], team, ready: m[2] === 'Ready' });
      return;
    }
    // Mods del lobby: respuesta a !mp mods («Enabled Hidden, NoFail…») y línea «Active mods:» de !mp settings.
    const mods = parseMods(text, l.mods);
    if (mods !== undefined) { l.mods = mods; return l.kind === 'match' && kick(l.key); }
    if ((m = text.match(/^(?:Changed beatmap to|Beatmap:) https:\/\/osu\.ppy\.sh\/b\/(\d+)/))) {
      if (l.map?.bid !== +m[1]) { l.map = { bid: +m[1], slot: slotOfBid(l, +m[1]), played: false }; l.ready = false; }
      return l.kind === 'match' && kick(l.key);
    }
    if ((m = text.match(/^(.+) rolls (\d+) point\(s\)$/))) {
      const side = l.kind === 'match' ? sideOf(l, m[1]) : null;
      if (side) botInput(s, l, (ctx) => onRoll(ctx, side, +m[2]));
      return;
    }
    if (text === 'All players are ready') { l.ready = true; return l.kind === 'match' && kick(l.key); }
    if (text === 'The match has started!') { l.playing = true; l.ready = false; l.scores = {}; return l.kind === 'match' && kick(l.key); }
    if ((m = text.match(/^(.+) finished playing \(Score: (\d+), (PASSED|FAILED)\)\.$/))) {
      l.scores[nameKey(m[1])] = { name: m[1], score: +m[2], passed: m[3] === 'PASSED' };
      return;
    }
    if (text === 'The match has finished!') {
      l.playing = false;
      if (l.map) l.map.played = true;
      if (l.kind === 'match') botInput(s, l, (ctx) => onMapEnd(ctx));
      return afterMap(s, l);
    }
    if (text === 'Aborted the match') { l.playing = false; return; }
    if (text === 'Countdown finished') { l.timer = false; return; }
    if (text === 'Closed the match') {
      l.closed = true; stopSync(l);
      // Así el lobby de clasificatorios sale como terminado sin esperar a la sincronización de cada 5 minutos.
      if (l.kind === 'qual') {
        const t = setTimeout(() => syncQual(+l.mp).then(push, (e) => console.warn('[ref qual]', l.mp, e.message)), Math.max(Math.min(3000, READ_GAP), READ_GAP - sinceRead(l.mp)));
        t.unref?.();
      }
      return;
    }
  }

  const playerName = (l, side) => (side ? l[side]?.username || side.toUpperCase() : '');

  function stopTimer(s, l) {
    if (!l.timer) return;
    l.timer = false;
    say(s, l, '!mp aborttimer');
  }

  // Pone el mapa del slot con sus mods. El mapa empieza solo cuando todos están listos.
  function playSlot(s, l, slot, by, round) {
    const e = poolView(round).find((p) => p.slot === slot);
    if (!e) return say(s, l, `La mappool no tiene ${slot}.`);
    stopTimer(s, l);
    l.mods = null;
    say(s, l, `!mp map ${e.bid} 0`);
    say(s, l, `!mp mods ${modsFor(slot)}`);
    l.map = { bid: e.bid, slot, played: false };
    const fm = modOf(slot) === 'FM' || modOf(slot) === 'TB';
    const who = by ? `${playerName(l, by)} elige ` : slot === 'TB' ? '¡Tiebreaker! ' : '';
    say(s, l, `${who}${slot}: ${e.title}${fm ? ' · FreeMod, NF obligatorio' : ''}. Empieza cuando estéis listos.`);
  }

  // Tras cada mapa se lee el MP en la API de osu! (respetando un minuto entre lecturas) y se anuncia el marcador.
  function stopSync(l) { clearTimeout(l.syncTimer); l.syncTimer = null; l.waiting = false; }
  function syncLater(l, run) {
    stopSync(l);
    l.waiting = true;
    l.syncTimer = setTimeout(run, Math.max(Math.min(3000, READ_GAP), READ_GAP - sinceRead(l.mp)));
    l.syncTimer.unref?.();
  }

  // Al terminar un mapa del pool solo se lee el resultado (no se manda nada al lobby). Los warmups no se leen.
  function afterMap(s, l) {
    if (l.kind === 'qual') {
      const slot = l.map?.slot;
      if (slot) {
        const st = qualState(l.key);
        if (!st.played.includes(slot)) st.played.push(slot);
        saveState(l.key, st);
      }
      syncLater(l, async () => {
        stopSync(l);
        try { await syncQual(+l.mp); } catch (e) { console.warn('[ref qual]', l.mp, e.message); }
        push();
      });
      return;
    }
    if (!l.map?.slot) return; // warmup: no es un mapa del pool
    const before = baseFlow(l.key).played;
    let tries = 0;
    const attempt = async () => {
      tries++;
      try { await syncMatch(l.key); } catch (e) { console.warn('[ref]', l.key, e.message); }
      const f = baseFlow(l.key);
      if (f.played > before || f.step === 'done') {
        stopSync(l);
        addLog(l, 'web', `Resultado leído de osu!: ${scoreLine(l, f)}`);
        kick(l.key);
        return push();
      }
      if (tries < SYNC_TRIES) { l.syncTimer = setTimeout(attempt, READ_GAP + 500); l.syncTimer.unref?.(); }
      else {
        stopSync(l);
        addLog(l, 'web', 'La API de osu! todavía no tiene el resultado de este mapa. Pulsa «Releer el MP» en un rato.');
        const st = matchState(l.key);
        if (st.bot.stage === 'match') {
          incident({ bot: st.bot, now: Date.now() }, 'result', 'La API de osu! todavía no tiene el resultado del último mapa. Pulsa «Releer el MP» en un rato y resuelve esta incidencia.');
          saveState(l.key, st);
        }
        push();
      }
    };
    syncLater(l, attempt);
  }

  function scoreText(names, f, point = false) {
    const last = f.maps.at(-1);
    const map = last && last.a != null && last.b != null ? `${last.slot}: ${nfmt.format(last.a)} – ${nfmt.format(last.b)}. ` : '';
    const mp = point && (f.score.a === f.need - 1 || f.score.b === f.need - 1) ? ' · Match point' : '';
    return `${map}Marcador: ${names.a} ${f.score.a} – ${f.score.b} ${names.b}${mp}`;
  }
  const scoreLine = (l, f) => scoreText({ a: playerName(l, 'a'), b: playerName(l, 'b') }, f);

  function playQual(s, l, slot) {
    const pool = poolView('qualifiers');
    const i = pool.findIndex((p) => p.slot === slot);
    say(s, l, `Mapa ${i + 1} de ${pool.length}.`);
    playSlot(s, l, slot, null, 'qualifiers');
  }

  // ---------- bot por fases (refbot.js) ----------
  // Sesión y lobby desde los que actúa el bot de un partido: los de quien lo lleva; si no está en el lobby, los de
  // cualquier árbitro que sí esté (y al pulsar un paso pasa a llevarlo él).
  function engineOf(key, b) {
    const ds = sessions.get(b.driver);
    const dl = ds?.status === 'connected' ? lobbyOfKey(ds, key) : null;
    if (dl && !dl.attaching) return { s: ds, l: dl };
    for (const s of sessions.values()) {
      if (s.status !== 'connected') continue;
      const l = lobbyOfKey(s, key);
      if (l && !l.attaching) return { s, l };
    }
    return null;
  }

  function lobSnap(l) {
    if (!l) return null;
    const pa = l.a && l.players.get(nameKey(l.a.username));
    const pb = l.b && l.players.get(nameKey(l.b.username));
    return {
      has: { a: Boolean(pa), b: Boolean(pb) }, team: { a: pa?.team ?? null, b: pb?.team ?? null }, rdy: { a: pa?.ready ?? null, b: pb?.ready ?? null },
      intruders: [...l.players.values()].filter((p) => p !== pa && p !== pb).map((p) => p.name),
      map: l.map, mods: l.mods, playing: l.playing, ready: l.ready, waiting: l.waiting, timer: l.timer
    };
  }

  function ctxOf(key, st, eng, f = baseFlow(key)) {
    const names = { a: f.a?.username, b: f.b?.username };
    return {
      st, bot: st.bot, f, now: Date.now(), rules: f.rules, scale: TIME_SCALE, pool: poolView(f.round), names, ids: { a: f.a?.id, b: f.b?.id },
      time: f.time, lobbyName: `${CONFIG.sigla}: (${names.a}) vs (${names.b})`, lob: lobSnap(eng?.l), scoreLine: scoreText(names, f, true)
    };
  }

  // Ejecuta un paso: lo apunta (con su historial para deshacer y su línea en el log) y manda sus líneas al lobby.
  // En AUTO las líneas llevan una marca para poder quitarlas de la cola si se pasa a SEMI antes de que salgan.
  function runAction(key, st, ctx, eng, a, by, { auto = false } = {}) {
    if (a.out.length && !eng) throw new HttpError(409, 'El bot no está en el lobby de este partido: conecta con Bancho y entra en el MP.');
    if (!a.silent) remember(st, a.label, ctx.now);
    if (a.special === 'load' && eng) eng.l.mods = null;
    a.run?.(ctx);
    if (a.done) st.bot.done[a.done] = true;
    logBot(st.bot, by, a.label, ctx.now);
    saveState(key, st);
    if (a.decision) saveBans(key, st);
    for (const line of a.out) say(eng.s, eng.l, line, auto ? { tag: 'auto:' + key } : undefined);
    push();
    kick(key);
  }

  // Programa una vuelta del bot para ese partido (como mucho una pendiente a la vez).
  function kick(key, delay = 0) {
    if (kicks.has(key)) return;
    const t = setTimeout(() => {
      kicks.delete(key);
      try { drive(key); } catch (e) { console.warn('[bot]', key, e.message); }
    }, Math.max(0, delay));
    t.unref?.();
    kicks.set(key, t);
  }

  // Una vuelta del bot: temporizadores, pasos silenciosos y, en AUTO, el paso siguiente.
  function drive(key) {
    if (inflight.has(key) || !bracket().matches[key]) return;
    const st = matchState(key);
    const b = st.bot;
    const now = Date.now();
    if (b.stage === 'idle') { if (b.mode === 'auto' && !b.paused) autoStart(key, st); return; }
    if (b.stage === 'fin') return;
    const eng = engineOf(key, b);
    let ctx = ctxOf(key, st, eng);
    if (tick(ctx)) { saveState(key, st); push(); }
    const p = plan(ctx);
    const silent = p.actions.find((a) => a.silent);
    if (silent && !b.paused) return runAction(key, st, ctx, eng, silent, 'bot');
    if (b.mode !== 'auto' || b.paused) return;
    const isBlocked = blocked(b);
    const a = p.actions.find((x) => x.auto !== false && !x.silent && (!isBlocked || x.urgent));
    if (!a) return;
    const wait = (nextAuto.get(key) || 0) - now;
    if (wait > 0) return kick(key, wait);
    if (a.special === 'make') {
      const s = sessions.get(b.driver);
      if (s?.status !== 'connected') return;
      nextAuto.set(key, now + AUTO_GAP);
      return void botMake(key, s, 'bot', true).catch((e) => console.warn('[bot]', key, e.message));
    }
    if (!eng) return;
    if (now < eng.l.readyAt) return kick(key, eng.l.readyAt - now);
    nextAuto.set(key, now + AUTO_GAP);
    ctx = ctxOf(key, st, eng);
    runAction(key, st, ctx, eng, a, 'bot', { auto: true });
  }

  // A0 en AUTO: a la hora del partido, si quien lleva el bot está conectado a Bancho. Si falla, una sola incidencia.
  function autoStart(key, st) {
    const rec = q.getMatch.get(key);
    const now = Date.now();
    if (!rec?.time || now < rec.time || now - rec.time > 3 * 3600e3 || st.bot.sub.autoErr) return;
    const s = sessions.get(st.bot.driver);
    if (s?.status !== 'connected') return;
    try {
      startMatch({ id: s.userId, username: s.username }, key);
    } catch (e) {
      st.bot.sub.autoErr = true;
      incident({ bot: st.bot, now }, 'start', `No se ha podido iniciar el partido a su hora: ${e.message}`);
      saveState(key, st);
      push();
    }
  }

  // A0 + A1: empezar el partido en el bot, tras comprobar jugadores, BO, mappool y reglas.
  function startMatch(user, key, { replace = false } = {}) {
    const st = matchState(key);
    const b = st.bot;
    if (b.stage !== 'idle' && b.stage !== 'fin') throw new HttpError(409, 'Este partido ya está en marcha en el bot.');
    const f = baseFlow(key);
    if (!f.a || !f.b) throw new HttpError(400, 'Este partido aún no tiene a los dos jugadores.');
    if (f.noPool) throw new HttpError(400, 'Añade antes la mappool de esta ronda.');
    if (f.ff || f.step === 'done') throw new HttpError(400, 'Este partido ya está terminado.');
    const r = f.rules;
    if (!(f.need >= 1) || ![r.bans, r.protects, r.banEvery, r.readyTimer, r.absentLimit, r.reinviteEvery, r.maxWarnings].every(Number.isInteger)) {
      throw new HttpError(400, 'Las reglas de esta ronda no son válidas: revísalas en Admin.');
    }
    remember(st, 'Iniciar partido');
    Object.assign(b, { stage: 'lobby', driver: user.id, done: {}, sub: { pw: randomBytes(5).toString('hex'), replace: Boolean(replace) }, timers: {}, warnings: { a: 0, b: 0 } });
    const s = sessions.get(user.id);
    if (s?.status === 'connected' && lobbyOfKey(s, key)) b.done['lobby:make'] = true;
    logBot(b, user.username, 'Partido iniciado: jugadores, BO, mappool y reglas correctos.');
    saveState(key, st);
    push();
    kick(key);
  }

  function makeMp(s, name) {
    if (s.pendingMake) throw new HttpError(409, 'Ya se está creando un lobby. Espera unos segundos.');
    return new Promise((resolve, reject) => {
      s.pendingMake = { resolve, reject, timer: setTimeout(() => { s.pendingMake = null; reject(new HttpError(504, 'BanchoBot no ha respondido al crear el lobby. Mira si te ha llegado un mensaje en osu! y vuelve a intentarlo.')); }, 20_000) };
      s.client.say('BanchoBot', `!mp make ${name}`);
    });
  }

  // A2: crear el lobby de un partido (con un reintento si BanchoBot no responde). Si no llega, incidencia.
  async function botMake(key, s, by, auto = false) {
    inflight.add(key);
    try {
      const m = bracket().matches[key];
      if (!m?.a || !m?.b) throw new HttpError(400, 'Este partido aún no tiene a los dos jugadores.');
      if (lobbyOfKey(s, key)) throw new HttpError(409, 'Ya tienes un lobby abierto para este partido.');
      if (!poolOf(phaseOf(key)).length) throw new HttpError(400, 'Añade antes la mappool de esta ronda.');
      const replace = matchState(key).bot.sub.replace;
      const rec = q.getMatch.get(key);
      const played = rec?.result ? (JSON.parse(rec.result).maps || []).length : 0;
      if (rec?.mp && played && !replace) {
        throw new HttpError(409, `Este partido ya tiene el MP #${rec.mp} con ${played} mapa${played === 1 ? '' : 's'} jugado${played === 1 ? '' : 's'}. ` +
          'Vuelve a entrar en ese lobby, o marca «Sustituir el MP anterior» (la web solo cuenta un MP por partido).');
      }
      const name = `${CONFIG.sigla}: (${m.a.username}) vs (${m.b.username})`;
      let mp = null, err = null;
      for (let i = 1; i <= MAKE_TRIES && !mp; i++) {
        try { mp = await makeMp(s, name); } catch (e) {
          err = e;
          if (e.status !== 504) throw e;
          addLog(s, 'web', `BanchoBot no ha respondido al crear el lobby (intento ${i} de ${MAKE_TRIES}).`);
        }
      }
      if (!mp) throw err;
      const l = newLobby({ mp, kind: 'match', key, name, a: { id: m.a.id, username: m.a.username }, b: { id: m.b.id, username: m.b.username } });
      s.lobbies.set(mp, l);
      addLog(l, 'web', `Lobby creado: https://osu.ppy.sh/mp/${mp}`);
      // El MP nuevo sustituye al anterior (si había): el resultado se vuelve a leer de este.
      q.upsertMatch.run(key, rec?.time ?? null, rec?.ref || s.username, +mp, rec?.ff ?? null, rec?.bans ?? '[]', null, Date.now());
      const st = matchState(key);
      remember(st, 'Crear el lobby');
      st.bot.done['lobby:make'] = true;
      st.bot.driver = s.userId;
      logBot(st.bot, by, `Crear el lobby: MP #${mp}`);
      saveState(key, st);
      return mp;
    } catch (e) {
      if (auto || e.status === 504 || e.status === 502) {
        const st = matchState(key);
        if (incident({ bot: st.bot, now: Date.now() }, 'lobby', `No se ha podido crear el lobby: ${e.message} Avisa al staff si sigue fallando.`)) saveState(key, st);
      }
      throw e;
    } finally {
      inflight.delete(key);
      push();
      kick(key);
    }
  }

  // Lo que BanchoBot y los jugadores dicen en el lobby, solo desde la sesión que lleva el bot.
  function botInput(s, l, apply) {
    const st = matchState(l.key);
    const eng = engineOf(l.key, st.bot);
    if (!eng || eng.s !== s || eng.l !== l) return;
    const ctx = ctxOf(l.key, st, eng);
    if (apply(ctx)) { saveState(l.key, st); kick(l.key); }
  }

  function botView(key, f) {
    const st = matchState(key);
    const b = st.bot;
    const eng = engineOf(key, b);
    const p = plan(ctxOf(key, st, eng, f));
    const sk = skipOf(p);
    const driver = b.driver ? (sessions.get(b.driver)?.username || q.getUser.get(b.driver)?.username || null) : null;
    return {
      mode: b.mode, paused: b.paused, stage: b.stage, phase: p.phase, step: p.step, at: stepId(p),
      text: p.text || null, wait: p.wait || null, waitRef: p.waitRef || null, timer: p.timer || null,
      actions: p.actions.filter((a) => !a.silent).map((a) => ({ id: a.id, label: a.label, out: a.out, auto: a.auto !== false, decision: Boolean(a.decision), urgent: Boolean(a.urgent) })),
      skip: sk ? sk.label : null,
      timers: Object.fromEntries(Object.entries(b.timers).filter(([, t]) => t?.until && !t.expired)
        .map(([k, t]) => [k, { until: t.until, left: b.paused ? Math.max(0, t.until - b.pausedAt) : null }])),
      warnings: b.warnings, incidents: b.incidents.slice(-20), blocked: blocked(b),
      log: b.log.slice(-40), driver, inLobby: Boolean(eng), canUndo: b.history.length > 0
    };
  }
  const stepId = (p) => `${p.phase}:${p.step}:${p.actions[0]?.id || ''}`;

  // Botones del bot: iniciar, ejecutar un paso, modo, pausa, saltar, incidencias. Deshacer es «undo» de siempre.
  async function botAct(user, key, b) {
    const what = String(b.do || '');
    const st = matchState(key);
    const bt = st.bot;
    const now = Date.now();
    const s = sessions.get(user.id);
    const own = s?.status === 'connected' ? lobbyOfKey(s, key) : null;
    if (own && !own.attaching) bt.driver = user.id; // quien pulsa desde el lobby pasa a llevar el bot
    const save = (text) => { if (text) logBot(bt, user.username, text, now); saveState(key, st); push(); kick(key); };

    if (what === 'start') return startMatch(user, key, { replace: b.replace === true });
    if (what === 'mode') {
      const mode = b.mode === 'auto' || b.mode === 'semi' ? b.mode : null;
      if (!mode) throw new HttpError(400, 'Elige AUTO o SEMI.');
      if (bt.mode === mode) return;
      bt.mode = mode;
      if (!bt.driver) bt.driver = user.id;
      let dropped = 0;
      if (mode === 'semi') for (const x of sessions.values()) dropped += x.client?.drop('auto:' + key) || 0;
      return save(mode === 'auto' ? 'Modo AUTOMÁTICO: el bot sigue solo desde el paso actual.'
        : `Modo SEMIAUTOMÁTICO: cada paso sale como botón.${dropped ? ` Cancelados ${dropped} mensajes que aún no habían salido.` : ''}`);
    }
    if (what === 'pause') {
      const on = b.on !== false;
      if (!setPaused(bt, on, now)) return;
      return save(on ? 'Bot en pausa: no hace nada solo y los temporizadores se paran.' : 'Bot reanudado.');
    }
    if (what === 'note') {
      const text = String(b.note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!text) throw new HttpError(400, 'Escribe la nota de la incidencia.');
      bt.incidents.push({ id: ++bt.seq, at: now, by: user.username, kind: 'note', text, open: false, block: false });
      return save(`Incidencia anotada: ${text}`);
    }
    if (what === 'resolve') {
      const inc = bt.incidents.find((i) => i.id === +b.id && i.open);
      if (!inc) throw new HttpError(409, 'Esa incidencia ya está resuelta.');
      const how = String(b.how || '');
      const r = rulesOf(phaseOf(key));
      inc.open = false; inc.resolvedBy = user.username; inc.resolvedAt = now; inc.how = how || null;
      if (inc.kind === 'absent' && how === 'wait' && bt.timers.absent) Object.assign(bt.timers.absent, { until: now + Math.round(r.absentLimit * 60e3 * TIME_SCALE), expired: false });
      if (inc.kind === 'pick') { delete bt.sub.pickOut; if (how === 'retimer' && inc.tk) delete bt.done[`turn:${inc.tk}`]; }
      if (inc.kind === 'tech' && inc.what === 'check') {
        if (how === 'retry') { delete bt.done[`load:${inc.tk}`]; delete bt.sub.load; } else bt.done[`check:${inc.tk}`] = true;
      }
      if (inc.kind === 'tech' && inc.what === 'start') { if (how === 'retry') { delete bt.done[`start:${inc.tk}`]; delete bt.sub.startAt; } delete bt.sub.startFailed; }
      if (inc.kind === 'start') delete bt.sub.autoErr;
      const HOW = { wait: 'seguir esperando', retimer: 'reiniciar el tiempo', retry: 'reintentar', ignore: 'seguir sin comprobar' };
      return save(`Incidencia resuelta${HOW[how] ? ` (${HOW[how]})` : ''}: ${inc.text}`);
    }
    if (what === 'skip' || what === 'run') {
      if (inflight.has(key)) throw new HttpError(409, 'El bot está creando el lobby. Espera unos segundos.');
      const eng = engineOf(key, bt);
      const ctx = ctxOf(key, st, eng);
      const p = plan(ctx);
      if (what === 'skip') {
        const sk = skipOf(p);
        if (b.at && b.at !== stepId(p)) throw new HttpError(409, 'El paso ha cambiado mientras tanto: mira el estado actual.');
        if (!sk) throw new HttpError(400, 'Este paso no se puede saltar: es una decisión (apúntala con los botones de siempre) o una espera del lobby.');
        remember(st, `Saltado: ${sk.label}`, now);
        sk.run?.(ctx);
        if (sk.done) bt.done[sk.done] = true;
        return save(`Saltado: ${sk.label}`);
      }
      const a = p.actions.find((x) => x.id === String(b.id || ''));
      if (!a) throw new HttpError(409, 'Ese paso ya no es el siguiente (puede que ya se haya hecho). Mira el estado actual.');
      if (a.special === 'start') return startMatch(user, key, { replace: b.replace === true });
      if (a.special === 'make') {
        const ss = sessionFor(user);
        if (b.replace === true) bt.sub.replace = true;
        saveState(key, st);
        await botMake(key, ss, user.username);
        return;
      }
      return runAction(key, st, ctx, eng, a, user.username);
    }
    throw new HttpError(400, 'Acción del bot desconocida.');
  }

  // Cada segundo: temporizadores y pasos de los partidos que tienen el bot en marcha (o en AUTO a la espera de su hora).
  const botTick = setInterval(() => {
    for (const r of q.refStates.all()) {
      if (r.key.startsWith('qual:')) continue;
      let b;
      try { b = JSON.parse(r.data).bot; } catch { continue; }
      if (!b || b.stage === 'fin' || (b.stage === 'idle' && b.mode !== 'auto')) continue;
      try { drive(r.key); } catch (e) { console.warn('[bot]', r.key, e.message); }
    }
  }, TICK_MS);
  botTick.unref();

  // ---------- roll, orden, protects, bans y picks a mano ----------
  // Cada botón apunta el paso y, con lobby, manda su mensaje o sus comandos (un pick pone el mapa y los mods).
  // Funciona igual en los dos modos del bot: el bot sigue desde lo que quede apuntado.
  const stepName = (x, f) => `${{ protect: 'protect', ban: 'ban', pick: 'pick' }[x.type]} de ${x.slot}${x.by ? ` (${f[x.by].username})` : ''}`;
  function perform(s, l, key, b, by = 'web') {
    const f = baseFlow(key);
    if (!f.a || !f.b) throw new HttpError(400, 'Este partido aún no tiene a los dos jugadores.');
    const st = matchState(key);
    const type = b.type;
    const side = (x) => (x === 'a' || x === 'b' ? x : null);
    let said = null, note = null, logText = null;
    if (type === 'roll') {
      if (f.step !== 'roll') throw new HttpError(400, 'El roll ya está decidido. Usa «Deshacer» para cambiarlo.');
      if (!side(b.winner)) throw new HttpError(400, 'Elige quién ha ganado el roll.');
      remember(st, `roll (gana ${f[b.winner].username})`);
      st.roll = { winner: b.winner };
      said = `${f[b.winner].username} gana el roll y elige quién protege, banea y elige primero.`;
      logText = `A mano: ${f[b.winner].username} gana el roll.`;
    } else if (type === 'order') {
      if (f.step !== 'order') throw new HttpError(400, 'Ahora no toca elegir el orden.');
      if (!side(b.protect) || !side(b.ban) || !side(b.pick)) throw new HttpError(400, 'Elige quién protege, banea y elige primero.');
      remember(st, 'el orden de protects, bans y picks');
      st.order = { protect: b.protect, ban: b.ban, pick: b.pick };
      said = `Orden: protege primero ${f[b.protect].username}, banea primero ${f[b.ban].username} y elige primero ${f[b.pick].username}.`;
      logText = `A mano: ${said}`;
    } else if (TYPES[type]) {
      const slot = String(b.slot || '').toUpperCase().replace(/\s+/g, '');
      if (f.noPool) throw new HttpError(400, 'Esta ronda no tiene mappool todavía.');
      if (!poolOf(f.round).some((p) => p.slot === slot) || slot === 'TB') throw new HttpError(400, `${slot || 'Ese mapa'} no está en la mappool o no se puede ${VERB[type]}.`);
      const force = b.force === true;
      if (f.step !== type && !force) throw new HttpError(400, `Ahora no toca ${VERB[type]} (marca «Saltarse las reglas» si hace falta).`);
      const why = f.step === type ? f.allowed[slot] : '';
      if (why && !force) throw new HttpError(400, `${slot}: ${why.toLowerCase()}.`);
      const who = force && side(b.by) ? b.by : f.by;
      if (!side(who)) throw new HttpError(400, 'Elige qué jugador lo hace.');
      const x = { type, by: who, slot, at: Date.now() };
      remember(st, stepName(x, f));
      st.actions.push(x);
      if (type !== 'pick') said = `${f[who].username} ${TYPES[type]} ${slot}.`;
      logText = `A mano: ${stepName(x, f)}${force ? ' (saltándose las reglas)' : ''}.`;
    } else if (type === 'tb') {
      if (f.step !== 'tb') throw new HttpError(400, 'Ahora no toca el tiebreaker.');
      if (!f.hasTb) throw new HttpError(400, 'La mappool de esta ronda no tiene TB.');
      remember(st, 'pick de TB');
      st.actions.push({ type: 'pick', by: null, slot: 'TB', at: Date.now() });
      logText = 'A mano: Tiebreaker.';
    } else if (type === 'undo') {
      // Solo cambia lo apuntado en la web; en el lobby no se manda nada. En AUTO, el bot queda en pausa para revisar.
      const label = undoBot(st);
      if (label) note = `Deshecho: ${label}.`;
      else if (st.actions.length) note = `Deshecho: ${stepName(st.actions.pop(), f)}.`;
      else if (st.order) { st.order = null; note = 'Deshecho: el orden de protects, bans y picks.'; }
      else if (st.roll) { st.roll = null; note = 'Deshecho: el roll.'; }
      else throw new HttpError(400, 'No hay nada que deshacer.');
      if (st.bot.mode === 'auto' && setPaused(st.bot, true)) note += ' El bot queda en pausa: revisa y pulsa Reanudar.';
      logText = note;
    } else if (type === 'reset') {
      if (!st.roll && !st.order && !st.actions.length) throw new HttpError(400, 'No hay nada apuntado.');
      st.roll = null; st.order = null; st.actions = [];
      // El bot vuelve a los rolls (lo del lobby y los warmups se conserva).
      const bt = st.bot;
      bt.done = Object.fromEntries(Object.entries(bt.done).filter(([k]) => k.startsWith('lobby:') || k.startsWith('wu:')));
      bt.sub = { pw: bt.sub.pw, wu: bt.sub.wu };
      delete bt.timers.pick; delete bt.timers.ready;
      bt.history = [];
      note = 'Empezado de cero: se han borrado el roll, el orden, los protects, los bans y los picks (el marcador sale del MP).';
      logText = note;
    } else {
      throw new HttpError(400, 'Acción desconocida.');
    }
    // Lo apuntado a mano sustituye a lo que el bot tuviera a medias en ese turno.
    if (type !== 'undo' && type !== 'reset') {
      delete st.bot.sub.input; delete st.bot.timers.pick; delete st.bot.sub.pickOut;
      if ((type === 'pick' || type === 'tb') && l && st.bot.stage === 'match') {
        const tk = `play#${st.actions.filter((x) => x.type === 'pick').length}`;
        st.bot.done[`load:${tk}`] = true;
        st.bot.sub.load = { tk, at: Date.now(), tries: 0 };
      }
    }
    if (logText) logBot(st.bot, by, logText);
    saveState(key, st);
    saveBans(key, st);
    if (l) {
      const last = st.actions.at(-1);
      if (type === 'pick' || type === 'tb') playSlot(s, l, last.slot, last.by, f.round);
      else if (said) { stopTimer(s, l); say(s, l, said); }
      if (note) addLog(l, 'web', note);
    }
    push();
    kick(key);
    return flowOf(key);
  }

  // ---------- completar después del partido ----------
  // Solo apunta en la web lo que pasó en un partido que no se arbitró con los botones: no manda nada a Bancho.
  // El orden de cada paso lo decide refFlow (buildActions); si algo no cuadra, no se guarda nada.
  const slotList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/))
    .map((x) => String(x).toUpperCase().replace(/\s+/g, '')).filter(Boolean).slice(0, 30);
  function complete(key, b, by) {
    const f = baseFlow(key);
    if (!f.a || !f.b) throw new HttpError(400, 'Este partido aún no tiene a los dos jugadores.');
    if (f.noPool) throw new HttpError(400, 'Esta ronda no tiene mappool todavía.');
    if (f.ff) throw new HttpError(400, 'Este partido se decidió por forfeit: no hay protects, bans ni picks que apuntar.');
    if (!f.mp || !f.maps.length) throw new HttpError(400, 'Este partido no tiene un MP leído con mapas del pool.');
    if (f.step !== 'done') throw new HttpError(400, `El MP todavía no tiene el partido terminado (${f.score.a} – ${f.score.b}). Relee el MP cuando acabe.`);
    const side = (x) => (x === 'a' || x === 'b' ? x : null);
    const order = { protect: side(b.protect), ban: side(b.ban), pick: side(b.pick) };
    if (!order.protect || !order.ban || !order.pick) throw new HttpError(400, 'Elige quién protege, banea y elige primero.');
    const st = matchState(key);
    if (st.actions.length && b.replace !== true) {
      const n = st.actions.length;
      throw new HttpError(409, `Este partido ya tiene ${n} paso${n === 1 ? '' : 's'} apuntado${n === 1 ? '' : 's'}. Confirma que quieres sustituirlos.`);
    }
    const r = buildActions({
      rules: f.rules, order, protects: slotList(b.protects), bans: slotList(b.bans), picks: slotList(b.picks),
      slots: poolOf(f.round).map((p) => p.slot), winners: Object.fromEntries(f.maps.map((x) => [x.slot, x.w])), need: f.need
    });
    if (r.error) throw new HttpError(400, r.error);
    remember(st, 'completar después del partido');
    st.order = order;
    st.actions = r.actions;
    logBot(st.bot, by, 'Completado después del partido.');
    saveState(key, st);
    saveBans(key, st);
    push();
    return flowOf(key);
  }

  // ---------- acciones del árbitro ----------
  function guardOwn(user, key) {
    const m = bracket().matches[key];
    if (!m) throw new HttpError(400, 'Ese partido no existe en el cuadro.');
    if (m.a?.id === user.id || m.b?.id === user.id) throw new HttpError(403, 'No puedes arbitrar un partido en el que juegas.');
    return m;
  }

  async function createLobby(user, { match, qualName, qualSlot, replace }) {
    const s = sessionFor(user);
    if (match) {
      // Partido del cuadro: es «Iniciar partido» + «Crear el lobby» del bot. El resto de pasos los lleva el bot.
      const m = guardOwn(user, match);
      if (!m.a || !m.b) throw new HttpError(400, 'Este partido aún no tiene a los dos jugadores.');
      if (lobbyOfKey(s, match)) throw new HttpError(409, 'Ya tienes un lobby abierto para este partido.');
      const st = matchState(match);
      if (st.bot.stage === 'idle' || st.bot.stage === 'fin') startMatch(user, match, { replace });
      else { st.bot.sub.replace = Boolean(replace); st.bot.driver = user.id; saveState(match, st); }
      const mp = await botMake(match, s, user.username);
      return { mp, key: match };
    }
    if (s.pendingMake) throw new HttpError(409, 'Ya se está creando un lobby. Espera unos segundos.');
    const slot = qualSlot == null ? null : q.qualSlot.get(+qualSlot);
    if (qualSlot != null && !slot) throw new HttpError(404, 'Ese lobby ya no existe.');
    if (slot?.mp && !replace) throw new HttpError(409, `${slot.name} ya tiene el MP #${slot.mp}. Entra en él o crea otro.`);
    if (slot && q.signupOf.get(user.id)?.slot_id === slot.id) throw new HttpError(403, 'No puedes arbitrar un lobby en el que juegas.');
    const n = slot ? slot.name : String(qualName || '').replace(/\s+/g, ' ').trim();
    if (!n || n.length > 30) throw new HttpError(400, 'Ponle un nombre al lobby (máximo 30 caracteres), por ejemplo «Lobby A».');
    if (!poolOf('qualifiers').length) throw new HttpError(400, 'Añade antes la mappool de clasificatorios.');
    const name = `${CONFIG.sigla}: (Clasificatorios) ${n}`;
    const mp = await makeMp(s, name);
    // Otro árbitro lo ha creado mientras tanto: este sobra.
    if (slot && !replace && q.qualSlot.get(slot.id)?.mp) {
      s.client.say(`#mp_${mp}`, '!mp close');
      throw new HttpError(409, `Otro árbitro acaba de crear ${slot.name}. Entra en su lobby.`);
    }
    const l = newLobby({ mp, kind: 'qual', key: `qual:${mp}`, name });
    s.lobbies.set(mp, l);
    addLog(l, 'web', `Lobby creado: https://osu.ppy.sh/mp/${mp}`);
    q.upsertQual.run(+mp, JSON.stringify({ name, scores: {} }), Date.now());
    saveState(l.key, { played: [] });
    say(s, l, `!mp set 0 3 ${slot?.size || 16}`); // HeadToHead, ScoreV2, plazas
    if (slot) {
      q.setSlotMp.run(+mp, slot.id);
      if (!slot.ref_id) q.setSlotRef.run(user.id, slot.id);
      for (const p of q.slotPlayers.all(slot.id)) say(s, l, `!mp invite #${p.id}`);
    }
    push();
    const pending = slot ? q.slotCount.get(slot.id).n - q.slotPlayers.all(slot.id).length : 0;
    return { mp, key: l.key, ...(pending ? { pending } : {}) };
  }

  // Volver a entrar a un lobby ya creado (tras reconectar o reiniciar el servidor).
  function attach(user, key) {
    key = String(key || '');
    const s = sessionFor(user);
    if (lobbyOfKey(s, key)) throw new HttpError(409, 'Ya estás en ese lobby.');
    let fields;
    if (key.startsWith('qual:')) {
      const mp = key.slice(5);
      const row = q.quals.all().find((x) => String(x.mp) === mp);
      if (!row) throw new HttpError(400, 'Ese lobby de clasificatorios no está en la web.');
      fields = { mp, kind: 'qual', key, name: (row.data && JSON.parse(row.data).name) || 'Clasificatorios' };
    } else {
      const m = guardOwn(user, key);
      const rec = q.getMatch.get(key);
      if (!rec?.mp || !m.a || !m.b) throw new HttpError(400, 'Este partido no tiene lobby todavía.');
      fields = { mp: String(rec.mp), kind: 'match', key, name: `${CONFIG.sigla}: (${m.a.username}) vs (${m.b.username})`,
        a: { id: m.a.id, username: m.a.username }, b: { id: m.b.id, username: m.b.username } };
    }
    const l = newLobby({ ...fields, closed: true, attaching: true });
    s.lobbies.set(l.mp, l);
    addLog(l, 'web', `Entrando en https://osu.ppy.sh/mp/${l.mp}…`);
    s.client.join('#mp_' + l.mp);
    push();
  }

  function lobbyFor(user, key) {
    const s = sessionFor(user);
    const l = lobbyOfKey(s, key);
    if (!l) throw new HttpError(409, 'No estás en el lobby de este partido. Créalo o vuelve a entrar.');
    return { s, l };
  }

  const LOBBY_CMDS = { start: '!mp start 5', abort: '!mp abort', close: '!mp close', settings: '!mp settings', aborttimer: '!mp aborttimer' };

  async function act(user, key, b) {
    key = String(key || '');
    const type = String(b.type || '');
    const s = sessions.get(user.id);
    if (s) s.lastUsed = Date.now();
    if (!key.startsWith('qual:')) guardOwn(user, key);

    if (LOBBY_CMDS[type]) {
      const { s: ss, l } = lobbyFor(user, key);
      if (type === 'start') stopTimer(ss, l);
      if (type === 'aborttimer') l.timer = false;
      say(ss, l, LOBBY_CMDS[type]);
      return push();
    }
    if (type === 'teams') {
      // TeamVS: el jugador A en rojo y el B en azul (#ID: vale aunque el nombre tenga espacios o haya cambiado)
      const { s: ss, l } = lobbyFor(user, key);
      if (l.kind !== 'match') throw new HttpError(400, 'Eso es para partidos del cuadro.');
      say(ss, l, `!mp team #${l.a.id} red`);
      say(ss, l, `!mp team #${l.b.id} blue`);
      return push();
    }
    if (type === 'fixmode') {
      const { s: ss, l } = lobbyFor(user, key);
      if (l.kind !== 'qual') throw new HttpError(400, 'Eso es para lobbies de clasificatorios.');
      say(ss, l, '!mp set 0 3');
      l.badMode = null;
      return push();
    }
    if (type === 'timer') {
      const { s: ss, l } = lobbyFor(user, key);
      say(ss, l, `!mp timer ${Math.min(600, Math.max(10, Math.round(+b.seconds) || 90))}`);
      l.timer = true;
      return push();
    }
    if (type === 'invite') {
      const { s: ss, l } = lobbyFor(user, key);
      const names = String(b.names || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean).slice(0, 16);
      if (!names.length) throw new HttpError(400, 'Escribe los nombres de osu! a invitar, separados por comas.');
      for (const n of names) say(ss, l, `!mp invite ${ircName(n)}`);
      return push();
    }
    if (type === 'warmup') {
      const { s: ss, l } = lobbyFor(user, key);
      const id = String(b.beatmap || '').match(/(\d+)\D*$/)?.[1];
      if (!id) throw new HttpError(400, 'Pega el enlace o el ID de la dificultad del warmup.');
      stopTimer(ss, l);
      say(ss, l, `!mp map ${id} 0`);
      say(ss, l, '!mp mods Freemod');
      l.map = { bid: +id, slot: null, played: false };
      return push();
    }
    if (type === 'qinvite') {
      const { s: ss, l } = lobbyFor(user, key);
      const slot = l.kind === 'qual' ? q.slotByMp.get(+l.mp) : null;
      if (!slot) throw new HttpError(400, 'Este lobby no tiene jugadores apuntados en la web.');
      for (const p of q.slotPlayers.all(slot.id)) if (!l.players.has(nameKey(p.username))) say(ss, l, `!mp invite #${p.id}`);
      return push();
    }
    if (type === 'qmap') {
      const { s: ss, l } = lobbyFor(user, key);
      if (l.kind !== 'qual') throw new HttpError(400, 'Eso es para lobbies de clasificatorios.');
      const slot = String(b.slot || '').toUpperCase();
      if (!poolOf('qualifiers').some((p) => p.slot === slot)) throw new HttpError(400, 'Ese mapa no está en la mappool de clasificatorios.');
      playQual(ss, l, slot);
      return push();
    }
    if (type === 'resync') {
      const { l } = lobbyFor(user, key);
      const wait = Math.ceil((READ_GAP - sinceRead(l.mp)) / 1000);
      if (wait > 0) throw new HttpError(429, `Espera ${wait} s: osu! pide no leer el mismo MP más de una vez por minuto.`);
      if (l.kind === 'qual') { await syncQual(+l.mp); return push(); }
      const before = baseFlow(key).played;
      stopSync(l);
      await syncMatch(key);
      const f = baseFlow(key);
      if (f.played > before) addLog(l, 'web', `Resultado leído de osu!: ${scoreLine(l, f)}`);
      kick(key);
      return push();
    }

    // Partido del cuadro: bot, roll, orden, protects, bans y picks (también sin lobby, para apuntarlo a mano)
    if (key.startsWith('qual:')) throw new HttpError(400, 'Acción desconocida.');
    if (type === 'bot') return botAct(user, key, b);
    if (type === 'complete') return complete(key, b, user.username);
    const l = s?.status === 'connected' ? lobbyOfKey(s, key) : null;
    return perform(s, l, key, { ...b, type }, user.username);
  }

  function chat(user, key, text) {
    const { s, l } = lobbyFor(user, String(key || ''));
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) throw new HttpError(400, 'Escribe un mensaje.');
    s.client?.say('#mp_' + l.mp, t, { repeat: true });
  }

  function disconnect(user) {
    const s = sessions.get(user.id);
    if (s) closeSession(s);
  }

  // Cada 20 s se manda el estado a las páginas abiertas (resultados de la sincronización normal),
  // y cada 10 minutos se cierran las conexiones que nadie usa.
  const refresh = setInterval(push, 20_000);
  refresh.unref();
  const idle = setInterval(() => {
    for (const s of sessions.values()) if (!listeners.get(s.userId)?.size && Date.now() - s.lastUsed > IDLE_MS) closeSession(s);
  }, 10 * 60e3);
  idle.unref();

  function shutdown() {
    clearInterval(refresh);
    clearInterval(idle);
    clearInterval(botTick);
    clearTimeout(flushTimer);
    for (const t of kicks.values()) clearTimeout(t);
    for (const set of listeners.values()) for (const res of set) res.end();
    for (const s of sessions.values()) { for (const l of s.lobbies.values()) stopSync(l); s.client?.close(); }
  }

  return { connect, disconnect, createLobby, attach, act, chat, subscribe, shutdown, flowOf, push };
}
