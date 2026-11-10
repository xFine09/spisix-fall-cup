// Arbitraje con bot de IRC. Cada árbitro conecta su cuenta a Bancho con su contraseña IRC (solo en memoria,
// nunca en disco ni en los logs) y la web manda los comandos !mp por él, solo cuando pulsa un botón o escribe.
// La web no actúa sola en el lobby ni hace propuestas: el árbitro lee el chat y pulsa los botones. Solo lleva
// el estado (quién hay, si están listos, qué mapa está puesto), el turno según las reglas y el resultado de cada
// mapa, que lee de la API de osu!.
// Todo lo apuntado (roll, orden, protects, bans y picks) se puede deshacer paso a paso o empezar de cero.
// El estado de cada partido se guarda en la base de datos; la conexión a Bancho no.
import { Bancho, ircName } from './irc.js';
import { refFlow, modsFor, modOf } from './refflow.js';

const LOG_MAX = 300;
const IDLE_MS = 3 * 3600e3;   // 3 horas sin usar la web y sin página abierta: se cierra la conexión y se olvida la contraseña
const READ_GAP = +process.env.OSU_MATCH_GAP_MS || 60e3; // términos de la API de osu!: el mismo MP no se lee más de una vez por minuto
const SYNC_TRIES = 3;
const TYPES = { protect: 'protege', ban: 'banea', pick: 'elige' };
const VERB = { protect: 'proteger', ban: 'banear', pick: 'elegir' };
const nfmt = new Intl.NumberFormat('es-ES');

export function createReferee(deps) {
  const { q, CONFIG, HttpError, bracket, syncMatch, syncQual, poolOf, rulesOf, label, need, phaseOf, sinceRead, visible } = deps;
  const sessions = new Map();  // userId → conexión a Bancho de ese árbitro
  const listeners = new Map(); // userId → páginas abiertas (SSE)

  // ---------- estado guardado ----------
  const loadState = (key) => { const r = q.getRefState.get(key); return r ? JSON.parse(r.data) : {}; };
  const saveState = (key, st) => q.setRefState.run(key, JSON.stringify(st), Date.now());
  const matchState = (key) => ({ roll: null, order: null, actions: [], ...loadState(key) });
  const qualState = (key) => ({ played: [], ...loadState(key) });

  const poolView = (round) => poolOf(round).map((p) => ({
    slot: p.slot, bid: p.beatmap_id, title: `${p.data.artist} - ${p.data.title} [${p.data.version}]`, sr: p.data.sr
  }));

  function flowOf(id, br = bracket()) {
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
    return { ...f, id, round, rules, label: label(id), time: rec?.time ?? null, ref: rec?.ref || null, a: pl(m.a), b: pl(m.b), mp: rec?.mp || null, maps, noPool: !slots.length };
  }

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
        map: l.map, ready: l.ready, timer: l.timer, badMode: l.badMode,
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
  const say = (s, l, text) => s.client?.say('#mp_' + l.mp, text);
  // ready: Bancho ha dicho que todos están listos · badMode: el lobby de clasificatorios no está en HeadToHead con ScoreV2
  const newLobby = (fields) => ({ players: new Map(), map: null, playing: false, waiting: false, closed: false, log: [], scores: {}, timer: false, ready: false, badMode: null, ...fields });

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
      if (l.attaching) { l.attaching = false; addLog(l, 'web', 'Has vuelto a entrar al lobby.'); say(s, l, '!mp settings'); }
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
  const slotOfBid = (l, bid) => poolView(l.kind === 'qual' ? 'qualifiers' : phaseOf(l.key)).find((p) => p.bid === bid)?.slot || null;

  function bancho(s, l, text) {
    let m;
    if ((m = text.match(/^(.+) joined in slot (\d+)(?: for team (red|blue))?\.$/))) {
      l.players.set(nameKey(m[1]), { name: m[1], slot: +m[2], team: m[3] || null });
      l.ready = false;
      return;
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
    if ((m = text.match(/^Slot (\d+)\s+(?:Ready|Not Ready|No Map)\s+https:\/\/osu\.ppy\.sh\/u\/(\d+) (.+?)\s*(?:\[([^\]]*)\])?$/))) {
      const team = /team (red|blue)/i.exec(m[4] || '')?.[1]?.toLowerCase() || null;
      // Con el ID se sabe el nombre exacto aunque lleve corchetes (el resto de la línea es «[Host / Team Red / Hidden]»).
      const name = [l.a, l.b].find((p) => p?.id === +m[2])?.username || m[3].trim();
      l.players.set(nameKey(name), { name, slot: +m[1], team });
      return;
    }
    if ((m = text.match(/^(?:Changed beatmap to|Beatmap:) https:\/\/osu\.ppy\.sh\/b\/(\d+)/))) {
      if (l.map?.bid !== +m[1]) { l.map = { bid: +m[1], slot: slotOfBid(l, +m[1]), played: false }; l.ready = false; }
      return;
    }
    // Se avisa al árbitro; el mapa lo empieza él con «Empezar».
    if (text === 'All players are ready') { l.ready = true; return; }
    if (text === 'The match has started!') { l.playing = true; l.ready = false; l.scores = {}; return; }
    if ((m = text.match(/^(.+) finished playing \(Score: (\d+), (PASSED|FAILED)\)\.$/))) {
      l.scores[nameKey(m[1])] = { name: m[1], score: +m[2], passed: m[3] === 'PASSED' };
      return;
    }
    if (text === 'The match has finished!') {
      l.playing = false;
      if (l.map) l.map.played = true;
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

  // Al terminar un mapa solo se lee el resultado (no se manda nada al lobby): el árbitro ve el marcador
  // en la página y decide cuándo anunciarlo y poner el siguiente mapa.
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
    const before = flowOf(l.key).played;
    let tries = 0;
    const attempt = async () => {
      tries++;
      try { await syncMatch(l.key); } catch (e) { console.warn('[ref]', l.key, e.message); }
      const f = flowOf(l.key);
      if (f.played > before || f.step === 'done') {
        stopSync(l);
        addLog(l, 'web', `Resultado leído de osu!: ${scoreLine(l, f)}`);
        return push();
      }
      if (tries < SYNC_TRIES) { l.syncTimer = setTimeout(attempt, READ_GAP + 500); l.syncTimer.unref?.(); }
      else { stopSync(l); addLog(l, 'web', 'La API de osu! todavía no tiene el resultado de este mapa. Pulsa «Releer el MP» en un rato.'); push(); }
    };
    syncLater(l, attempt);
  }

  function scoreLine(l, f) {
    const last = f.maps.at(-1);
    const map = last && last.a != null && last.b != null ? `${last.slot}: ${nfmt.format(last.a)} – ${nfmt.format(last.b)}. ` : '';
    return `${map}Marcador: ${playerName(l, 'a')} ${f.score.a} – ${f.score.b} ${playerName(l, 'b')}`;
  }

  function playQual(s, l, slot) {
    const pool = poolView('qualifiers');
    const i = pool.findIndex((p) => p.slot === slot);
    say(s, l, `Mapa ${i + 1} de ${pool.length}.`);
    playSlot(s, l, slot, null, 'qualifiers');
  }

  // ---------- roll, orden, protects, bans y picks ----------
  // Cada botón apunta el paso y, con lobby, manda su mensaje o sus comandos (un pick pone el mapa y los mods).
  // No se anuncia el turno siguiente ni se pone el temporizador: eso lo hace el árbitro cuando quiera.
  const stepName = (x, f) => `${{ protect: 'protect', ban: 'ban', pick: 'pick' }[x.type]} de ${x.slot}${x.by ? ` (${f[x.by].username})` : ''}`;
  function perform(s, l, key, b) {
    const f = flowOf(key);
    if (!f.a || !f.b) throw new HttpError(400, 'Este partido aún no tiene a los dos jugadores.');
    const st = matchState(key);
    const type = b.type;
    const side = (x) => (x === 'a' || x === 'b' ? x : null);
    let said = null, note = null;
    if (type === 'roll') {
      if (f.step !== 'roll') throw new HttpError(400, 'El roll ya está decidido. Usa «Deshacer» para cambiarlo.');
      if (!side(b.winner)) throw new HttpError(400, 'Elige quién ha ganado el roll.');
      st.roll = { winner: b.winner };
      said = `${f[b.winner].username} gana el roll y elige quién protege, banea y elige primero.`;
    } else if (type === 'order') {
      if (f.step !== 'order') throw new HttpError(400, 'Ahora no toca elegir el orden.');
      if (!side(b.protect) || !side(b.ban) || !side(b.pick)) throw new HttpError(400, 'Elige quién protege, banea y elige primero.');
      st.order = { protect: b.protect, ban: b.ban, pick: b.pick };
      said = `Orden: protege primero ${f[b.protect].username}, banea primero ${f[b.ban].username} y elige primero ${f[b.pick].username}.`;
    } else if (TYPES[type]) {
      const slot = String(b.slot || '').toUpperCase().replace(/\s+/g, '');
      if (f.noPool) throw new HttpError(400, 'Esta ronda no tiene mappool todavía.');
      if (!poolOf(f.round).some((p) => p.slot === slot) || slot === 'TB') throw new HttpError(400, `${slot || 'Ese mapa'} no está en la mappool o no se puede ${VERB[type]}.`);
      const force = b.force === true;
      if (f.step !== type && !force) throw new HttpError(400, `Ahora no toca ${VERB[type]} (marca «Saltarse las reglas» si hace falta).`);
      const why = f.step === type ? f.allowed[slot] : '';
      if (why && !force) throw new HttpError(400, `${slot}: ${why.toLowerCase()}.`);
      const by = force && side(b.by) ? b.by : f.by;
      if (!side(by)) throw new HttpError(400, 'Elige qué jugador lo hace.');
      st.actions.push({ type, by, slot, at: Date.now() });
      if (type !== 'pick') said = `${f[by].username} ${TYPES[type]} ${slot}.`;
    } else if (type === 'tb') {
      if (f.step !== 'tb') throw new HttpError(400, 'Ahora no toca el tiebreaker.');
      if (!f.hasTb) throw new HttpError(400, 'La mappool de esta ronda no tiene TB.');
      st.actions.push({ type: 'pick', by: null, slot: 'TB', at: Date.now() });
    } else if (type === 'undo') {
      // Solo cambia lo apuntado en la web; en el lobby no se manda nada.
      if (st.actions.length) note = `Deshecho: ${stepName(st.actions.pop(), f)}.`;
      else if (st.order) { st.order = null; note = 'Deshecho: el orden de protects, bans y picks.'; }
      else if (st.roll) { st.roll = null; note = 'Deshecho: el roll.'; }
      else throw new HttpError(400, 'No hay nada que deshacer.');
    } else if (type === 'reset') {
      if (!st.roll && !st.order && !st.actions.length) throw new HttpError(400, 'No hay nada apuntado.');
      st.roll = null; st.order = null; st.actions = [];
      note = 'Empezado de cero: se han borrado el roll, el orden, los protects, los bans y los picks (el marcador sale del MP).';
    } else {
      throw new HttpError(400, 'Acción desconocida.');
    }
    saveState(key, st);
    q.setBans.run(key, JSON.stringify(st.actions.filter((x) => x.type === 'ban').map((x) => x.slot)), Date.now());
    if (l) {
      const last = st.actions.at(-1);
      if (type === 'pick' || type === 'tb') playSlot(s, l, last.slot, last.by, f.round);
      else if (said) { stopTimer(s, l); say(s, l, said); }
      if (note) addLog(l, 'web', note);
    }
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
    if (s.pendingMake) throw new HttpError(409, 'Ya se está creando un lobby. Espera unos segundos.');
    let name, sides = null, slot = null;
    if (match) {
      const m = guardOwn(user, match);
      if (!m.a || !m.b) throw new HttpError(400, 'Este partido aún no tiene a los dos jugadores.');
      if (lobbyOfKey(s, match)) throw new HttpError(409, 'Ya tienes un lobby abierto para este partido.');
      if (!poolOf(phaseOf(match)).length) throw new HttpError(400, 'Añade antes la mappool de esta ronda.');
      const rec = q.getMatch.get(match);
      const played = rec?.result ? (JSON.parse(rec.result).maps || []).length : 0;
      if (rec?.mp && played && !replace) {
        throw new HttpError(409, `Este partido ya tiene el MP #${rec.mp} con ${played} mapa${played === 1 ? '' : 's'} jugado${played === 1 ? '' : 's'}. ` +
          'Vuelve a entrar en ese lobby, o marca «Sustituir el MP anterior» (la web solo cuenta un MP por partido).');
      }
      sides = { a: { id: m.a.id, username: m.a.username }, b: { id: m.b.id, username: m.b.username } };
      name = `${CONFIG.sigla}: (${m.a.username}) vs (${m.b.username})`;
    } else {
      slot = qualSlot == null ? null : q.qualSlot.get(+qualSlot);
      if (qualSlot != null && !slot) throw new HttpError(404, 'Ese lobby ya no existe.');
      if (slot?.mp && !replace) throw new HttpError(409, `${slot.name} ya tiene el MP #${slot.mp}. Entra en él o crea otro.`);
      if (slot && q.signupOf.get(user.id)?.slot_id === slot.id) throw new HttpError(403, 'No puedes arbitrar un lobby en el que juegas.');
      const n = slot ? slot.name : String(qualName || '').replace(/\s+/g, ' ').trim();
      if (!n || n.length > 30) throw new HttpError(400, 'Ponle un nombre al lobby (máximo 30 caracteres), por ejemplo «Lobby A».');
      if (!poolOf('qualifiers').length) throw new HttpError(400, 'Añade antes la mappool de clasificatorios.');
      name = `${CONFIG.sigla}: (Clasificatorios) ${n}`;
    }
    const mp = await new Promise((resolve, reject) => {
      s.pendingMake = { resolve, reject, timer: setTimeout(() => { s.pendingMake = null; reject(new HttpError(504, 'BanchoBot no ha respondido al crear el lobby. Mira si te ha llegado un mensaje en osu! y vuelve a intentarlo.')); }, 20_000) };
      s.client.say('BanchoBot', `!mp make ${name}`);
    });
    // Otro árbitro lo ha creado mientras tanto: este sobra.
    if (slot && !replace && q.qualSlot.get(slot.id)?.mp) {
      s.client.say(`#mp_${mp}`, '!mp close');
      throw new HttpError(409, `Otro árbitro acaba de crear ${slot.name}. Entra en su lobby.`);
    }
    const l = newLobby({ mp, kind: match ? 'match' : 'qual', key: match || `qual:${mp}`, name, ...sides });
    s.lobbies.set(mp, l);
    addLog(l, 'web', `Lobby creado: https://osu.ppy.sh/mp/${mp}`);
    if (match) {
      const rec = q.getMatch.get(match);
      // El MP nuevo sustituye al anterior (si había): el resultado se vuelve a leer de este.
      q.upsertMatch.run(match, rec?.time ?? null, rec?.ref || user.username, +mp, rec?.ff ?? null, rec?.bans ?? '[]', null, Date.now());
      // Lo que hace el botón «Crear el lobby»: modo del lobby e invitaciones. El saludo lo manda el árbitro.
      say(s, l, '!mp set 2 3 2'); // TeamVS, ScoreV2, 2 plazas
      say(s, l, `!mp invite #${sides.a.id}`);
      say(s, l, `!mp invite #${sides.b.id}`);
    } else {
      q.upsertQual.run(+mp, JSON.stringify({ name, scores: {} }), Date.now());
      saveState(l.key, { played: [] });
      say(s, l, `!mp set 0 3 ${slot?.size || 16}`); // HeadToHead, ScoreV2, plazas
      if (slot) {
        q.setSlotMp.run(+mp, slot.id);
        if (!slot.ref_id) q.setSlotRef.run(user.id, slot.id);
        for (const p of q.slotPlayers.all(slot.id)) say(s, l, `!mp invite #${p.id}`);
      }
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
      const before = flowOf(key).played;
      stopSync(l);
      await syncMatch(key);
      const f = flowOf(key);
      if (f.played > before) addLog(l, 'web', `Resultado leído de osu!: ${scoreLine(l, f)}`);
      return push();
    }

    // Partido del cuadro: roll, orden, protects, bans y picks (también sin lobby, para apuntarlo a mano)
    if (key.startsWith('qual:')) throw new HttpError(400, 'Acción desconocida.');
    const l = s?.status === 'connected' ? lobbyOfKey(s, key) : null;
    return perform(s, l, key, { ...b, type });
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
  const tick = setInterval(push, 20_000);
  tick.unref();
  const idle = setInterval(() => {
    for (const s of sessions.values()) if (!listeners.get(s.userId)?.size && Date.now() - s.lastUsed > IDLE_MS) closeSession(s);
  }, 10 * 60e3);
  idle.unref();

  function shutdown() {
    clearInterval(tick);
    clearInterval(idle);
    clearTimeout(flushTimer);
    for (const set of listeners.values()) for (const res of set) res.end();
    for (const s of sessions.values()) { for (const l of s.lobbies.values()) stopSync(l); s.client?.close(); }
  }

  return { connect, disconnect, createLobby, attach, act, chat, subscribe, shutdown, flowOf, push };
}
