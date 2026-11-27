// Prueba de extremo a extremo contra una API de osu! simulada (no hace falta conexión ni credenciales reales).
// Ejecuta: npm test
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { mapWeights, duel, mapFactor, inverseNormal, qualZ, qualBase, percentiles, generalStrength } from '../server/skills.js';
import { STATS_VIEWS } from '../server/stats.js';

// Reloj fijo: la prueba y el primer servidor creen que es el 14 de noviembre de 2026 a las 13:00 (hora de Madrid),
// con los clasificatorios en marcha, sea cual sea la fecha real. El segundo servidor va a octavos con su propio reloj.
const TEST_NOW = '2026-11-14T12:00:00Z';
{ const o = Date.parse(TEST_NOW) - Date.now(), n = Date.now; Date.now = () => n() + o; }

// ---------- API de osu! simulada ----------
const USERS = {
  4242: { id: 4242, username: 'Organizador', avatar_url: 'https://a.ppy.sh/4242', country_code: 'ES', statistics: { global_rank: 234567 } },
  77: { id: 77, username: 'DemasiadoBueno', avatar_url: 'https://a.ppy.sh/77', country_code: 'ES', statistics: { global_rank: 45000 } },
  78: { id: 78, username: 'RankBuffer', country_code: 'ES', statistics: { global_rank: 92000 } },
  503: { id: 503, username: 'Jugador C', country_code: 'ES', statistics: { global_rank: 400000 } },
  504: { id: 504, username: 'NombreNuevo', country_code: 'AR', statistics: { global_rank: 500000 } },
  // Perfil completo, como GET /users/{id}/osu: estadísticas, rango de país e historial de rango (0 = día sin rango)
  501: { id: 501, username: 'JugadorA', avatar_url: 'https://a.ppy.sh/501', country_code: 'ES', country: { code: 'ES', name: 'Spain' },
    statistics: { global_rank: 150000, country_rank: 4100, pp: 3123.45, hit_accuracy: 98.1234, play_count: 25000 },
    rank_history: { mode: 'osu', data: [...Array(10).fill(0), ...Array.from({ length: 80 }, (_, i) => 160000 - i * 125)] } },
  502: { id: 502, username: 'JugadorB', country_code: 'ES', statistics: { global_rank: 300000 } }
};
// 16 jugadores para el cuadro (segunda parte: reloj en octavos)
for (let i = 1; i <= 16; i++) {
  const id = 600 + i;
  USERS[id] = { id, username: 'P' + String(i).padStart(2, '0'), country_code: 'ES', statistics: { global_rank: 150000 + i * 1000 } };
}
const OLD_NAMES = { nombreviejo: 504 }; // historial de cambios de nombre
const byName = (n) => Object.values(USERS).find((u) => u.username.toLowerCase() === n.toLowerCase());
let nextLogin = 4242;
// Atributos de dificultad de cada mapa (aim, velocidad, notas rápidas) para el perfil de skills.
const ATTR = { 101: [3.2, 1.6, 150], 102: [1.5, 3.1, 520], 103: [2.4, 2.4, 300], 104: [2.8, 1.9, 200], 105: [3.0, 2.0, 260], 106: [2.2, 3.4, 610], 201: [3.3, 1.5, 160], 202: [1.6, 3.2, 540] };
const calls = [];
const failProfiles = new Set(); // IDs cuyo perfil responde 500
const profileCalls = []; // IDs pedidos a /users/{id}/osu
// o!TR simulado: estadísticas por ID de osu! (sin entrada = 404). mods es la máscara de bits de osu! (1 = NF, 8 = HD, 576 = NC).
const OTR = {
  501: { playerInfo: { id: 77001 }, matchStats: null,
    rating: { rating: 1234.56, percentile: 87.5, globalRank: 3210, countryRank: 45, tournamentsPlayed: 7, matchesPlayed: 60, winRate: 0.55, isProvisional: false, tierProgress: { currentTier: 'gold', currentSubTier: 2 } },
    modStats: [{ mods: 1, count: 10, averageScore: 500000 }, { mods: 0, count: 30, averageScore: 600000 }, { mods: 9, count: 20, averageScore: 550000 }, { mods: 8, count: 20, averageScore: 650000 }, { mods: 576, count: 5, averageScore: 700000 }] },
  502: { playerInfo: { id: 77002 }, rating: null, matchStats: null, modStats: [] }, // en o!TR, pero sin torneos verificados
  4242: { playerInfo: { id: 77003 }, rating: { rating: 900, tierProgress: {} }, matchStats: null, modStats: [] }
};
let otrFail = false;
const otrCalls = []; // IDs pedidos a o!TR
// Twitch: directo que devuelve /helix/streams (null = sin directo)
let twitchLive = null;

function beatmap(id) {
  return { id, version: 'Insane', difficulty_rating: 5.31, cs: 4, ar: 9, accuracy: 8, bpm: 180, total_length: 150,
    owners: id === 106 ? [{ id: 9, username: 'Invitado' }] : [{ id: 8, username: 'Mapper' }], // 106 es una guest difficulty
    beatmapset: { artist: 'Artista ' + id, title: 'Titulo ' + id, creator: 'Mapper', covers: { card: `https://assets.ppy.sh/beatmaps/${id}/covers/card.jpg` } } };
}
const game = (bid, scores, mods = ['NF']) => ({ beatmap_id: bid, end_time: '2026-11-17T18:10:00Z', mods, scoring_type: 'scorev2', team_type: 'team-vs',
  scores: scores.map(([user_id, score, smods = []]) => ({ user_id, score, mods: smods, match: { team: user_id === 501 ? 'red' : 'blue', pass: true } })) });

// Partido 555: 1 warmup (mapa 999, no está en el pool), 150 eventos de relleno y 6 mapas.
// FM1 lo gana B gracias al multiplicador de EZ (600k × 1,8 = 1,08M > 900k).
function match555() {
  const events = [];
  let id = 1;
  events.push({ id: id++, detail: { type: 'match-created' } });
  events.push({ id: id++, detail: { type: 'other' }, game: game(999, [[501, 100], [502, 900000]]) }); // warmup
  events.push({ id: id++, detail: { type: 'other' }, game: game(101, [[501, 800000], [502, 700000]]) }); // NM1 A (queda en la página antigua)
  for (let i = 0; i < 150; i++) events.push({ id: id++, detail: { type: 'player-joined' } });
  events.push({ id: id++, detail: { type: 'other' }, game: game(102, [[501, 650000], [502, 700000]]) }); // NM2 B
  events.push({ id: id++, detail: { type: 'other' }, game: game(103, [[501, 900000, ['HR']], [502, 600000, ['EZ']]], ['NF']) }); // FM1 B por EZ
  events.push({ id: id++, detail: { type: 'other' }, game: game(104, [[501, 910000], [502, 500000]], ['NF', 'HD']) }); // HD1 A
  events.push({ id: id++, detail: { type: 'other' }, game: game(105, [[501, 920000], [502, 500000]], ['NF', 'HR']) }); // HR1 A
  events.push({ id: id++, detail: { type: 'other' }, game: game(106, [[501, 930000], [502, 500000]], ['NF', 'DT']) }); // DT1 A
  return { match: { id: 555, name: 'SPI: (JugadorA) vs (JugadorB)' }, events, users: [], first_event_id: 1, latest_event_id: id - 1 };
}
// Clasificatorio con los 16: P01 el mejor, P16 el peor.
function qual901() {
  const sc = (base) => Array.from({ length: 16 }, (_, i) => [601 + i, base - i * 10000]);
  const events = [201, 202].map((bid, k) => ({ id: k + 1, detail: { type: 'other' }, game: { ...game(bid, sc(900000 - k * 50000)), team_type: 'head-to-head' } }));
  return { match: { id: 901, name: 'SPI: (Clasificatorios) Lobby B' }, events, first_event_id: 1, latest_event_id: 2 };
}
// U1-2 (seed 8 vs seed 9): P08 gana 5–1. Después, dos mapas del pool de showmatch, que no cuentan
// (si contaran, NM1 pasaría a P08 y NM2 a P09).
function match556() {
  const events = [[101, 609], [102, 608], [103, 608], [104, 608], [105, 608], [106, 608], [101, 608], [102, 609]].map(([bid, w], k) => ({
    id: k + 1, detail: { type: 'other' }, game: game(bid, [[608, w === 608 ? 900000 : 500000], [609, w === 609 ? 900000 : 500000]])
  }));
  return { match: { id: 556, name: 'SPI: (P08) vs (P09)' }, events, first_event_id: 1, latest_event_id: events.length };
}
// MP 557: U1-7 (P07 contra P10) en juego, con precisión y 300/100/50/fallos en cada score (para Stats).
// Los mapas se añaden a games557 a medida que se «juegan». En FM1, P10 gana con EZ (550k × 1,8 = 990k > 900k).
const sc557 = (user_id, score, accuracy, [count_300, count_100, count_50, count_miss], mods = []) =>
  ({ user_id, score, accuracy, mods, statistics: { count_300, count_100, count_50, count_miss }, match: { team: user_id === 607 ? 'red' : 'blue', pass: true } });
const game557 = (bid, scores) => ({ beatmap_id: bid, end_time: '2026-11-17T16:30:00Z', mods: ['NF'], scoring_type: 'scorev2', team_type: 'team-vs', scores });
const GAMES557 = [
  game557(999, [sc557(607, 100, 0.5, [10, 10, 10, 10]), sc557(610, 999999, 1, [500, 0, 0, 0])]), // warmup
  game557(101, [sc557(607, 800000, 0.9812, [480, 15, 0, 0]), sc557(610, 750000, 0.95, [440, 50, 3, 2])]), // NM1: S y B
  game557(102, [sc557(607, 600000, 0.93, [430, 60, 5, 0]), sc557(610, 700000, 0.97, [470, 25, 0, 0])]), // NM2: A y S
  game557(103, [sc557(607, 900000, 0.99, [500, 0, 0, 0], ['HR']), sc557(610, 550000, 0.96, [470, 20, 2, 3], ['EZ'])]) // FM1: SS y A
];
const games557 = [];
const match557 = () => ({ match: { id: 557, name: 'SPI6: (P07) vs (P10)' }, events: games557.map((g, i) => ({ id: i + 1, detail: { type: 'other' }, game: g })), first_event_id: 1, latest_event_id: games557.length });
function qual900() {
  const events = [
    { id: 1, detail: { type: 'other' }, game: { ...game(201, [[4242, 700000], [501, 750000], [502, 600000]]), team_type: 'head-to-head' } },
    { id: 2, detail: { type: 'other' }, game: { ...game(202, [[4242, 800000], [501, 500000], [502, 650000]]), team_type: 'head-to-head' } },
    { id: 3, detail: { type: 'other' }, game: { ...game(202, [[4242, 850000]]), team_type: 'head-to-head' } } // repetición tras desconexión
  ];
  return { match: { id: 900, name: 'SPI: (Clasificatorios) Lobby A' }, events, first_event_id: 1, latest_event_id: 3 };
}
// El mismo pool jugado por equipos (902) y un lobby que cambia de modo a mitad (903).
const qual902 = () => ({ match: { id: 902, name: 'SPI: por equipos' }, events: [{ id: 1, detail: { type: 'other' }, game: game(201, [[501, 900000], [502, 800000]]) }], first_event_id: 1, latest_event_id: 1 });
const qual903 = () => ({ match: { id: 903, name: 'SPI: mixto' }, events: [
  { id: 1, detail: { type: 'other' }, game: { ...game(201, [[501, 900000]]), team_type: 'head-to-head' } },
  { id: 2, detail: { type: 'other' }, game: game(202, [[501, 800000], [502, 700000]]) }
], first_event_id: 1, latest_event_id: 2 });

// MP 558: lo crea el bot de arbitraje; los mapas se añaden a medida que se «juegan» en el Bancho simulado.
const games558 = [];
const match558 = () => ({ match: { id: 558, name: 'SPI6: partido arbitrado' }, events: games558.map((g, i) => ({ id: i + 1, detail: { type: 'other' }, game: g })), first_event_id: 1, latest_event_id: games558.length });
// MP 559: lobby de clasificatorios creado por el bot (scores bajos para no cambiar las seeds).
// MP 560: el Lobby E, ya cerrado (end_time), con un score bajo para no cambiar las seeds.
const qual560 = () => ({ match: { id: 560, name: 'SPI6: (Clasificatorios) Lobby E', end_time: '2026-11-17T19:00:00Z' }, events: [{ id: 1, detail: { type: 'other' }, game: { ...game(201, [[601, 100]]), team_type: 'head-to-head' } }], first_event_id: 1, latest_event_id: 1 });
const qual559 = () => ({ match: { id: 559, name: 'SPI6: (Clasificatorios) Lobby C' }, events: [{ id: 1, detail: { type: 'other' }, game: { ...game(201, [[605, 100]]), team_type: 'head-to-head' } }], first_event_id: 1, latest_event_id: 1 });

// MP 561: U1-4 arbitrado a mano, sin los botones (se completa después en Arbitrar). Warmup, 8 mapas y el TB.
// Los IDs de los jugadores se ponen en la prueba (players561 = [rojo, azul]); w = quién gana cada mapa.
let players561 = [0, 0];
const plays561 = [[102, 'a'], [109, 'b'], [103, 'a'], [110, 'b'], [101, 'a'], [104, 'b'], [111, 'a'], [108, 'b'], [113, 'a']];
const match561 = () => {
  const [a, b] = players561;
  const games = [game(999, [[a, 100], [b, 900000]]), ...plays561.map(([bid, w]) => game(bid, [[a, w === 'a' ? 900000 : 500000], [b, w === 'b' ? 900000 : 500000]]))];
  return { match: { id: 561, name: 'SPI6: (A) vs (B)' }, events: games.map((g, i) => ({ id: i + 1, detail: { type: 'other' }, game: g })), first_event_id: 1, latest_event_id: games.length };
};

// MP 600 en adelante: partidos que lleva el bot por fases (los mapas se añaden al «jugarse» en el Bancho simulado).
const gamesN = {};
const matchN = (mp) => ({ match: { id: mp, name: 'SPI6: bot por fases' }, events: (gamesN[mp] || []).map((g, i) => ({ id: i + 1, detail: { type: 'other' }, game: g })), first_event_id: 1, latest_event_id: (gamesN[mp] || []).length });

function page(data, url) {
  const before = +url.searchParams.get('before') || Infinity;
  const limit = Math.min(+url.searchParams.get('limit') || 100, 100);
  const evs = data.events.filter((e) => e.id < before).slice(-limit);
  return { ...data, events: evs };
}

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  calls.push(`${req.method} ${url.pathname}${url.search}`);
  const send = (s, d) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
  let body = '';
  for await (const c of req) body += c;
  const auth = req.headers.authorization || '';
  const otrPath = url.pathname.match(/^\/api\/players\/(\d+)\/stats$/); // o!TR (su clave, no la de osu!)
  if (otrPath) {
    assert.equal(url.searchParams.get('keyType'), 'osu');
    assert.equal(url.searchParams.get('ruleset'), '0');
    if (auth !== 'Bearer otr-clave') return send(401, { error: 'An API key is required to access this endpoint.' });
    otrCalls.push(+otrPath[1]);
    if (otrFail) return send(500, {});
    return OTR[otrPath[1]] ? send(200, OTR[otrPath[1]]) : send(404, { error: 'Player not found' });
  }
  if (url.pathname === '/oauth2/token') { // Twitch, token de aplicación
    const p = new URLSearchParams(body);
    assert.equal(p.get('grant_type'), 'client_credentials');
    assert.equal(p.get('client_secret'), 'tw-secreto');
    return send(200, { access_token: 'twtok', expires_in: 5000000, token_type: 'bearer' });
  }
  if (url.pathname === '/helix/streams') {
    assert.equal(req.headers['client-id'], 'tw-id');
    if (auth !== 'Bearer twtok') return send(401, {});
    assert.equal(url.searchParams.get('user_login'), 'spi6_osu');
    return send(200, { data: twitchLive ? [twitchLive] : [], pagination: {} });
  }
  if (url.pathname === '/oauth/authorize') {
    assert.equal(url.searchParams.get('scope'), 'identify');
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', 'code-' + nextLogin);
    back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { Location: back.href });
    return res.end();
  }
  if (url.pathname === '/oauth/token') {
    const p = new URLSearchParams(body);
    assert.equal(p.get('client_secret'), 'secreto');
    if (p.get('grant_type') === 'client_credentials') return send(200, { access_token: 'app', expires_in: 86400 });
    if (p.get('grant_type') === 'authorization_code') return send(200, { access_token: 'user-' + p.get('code').slice(5), expires_in: 86400 });
    return send(400, {});
  }
  if (url.pathname === '/api/v2/me/osu') {
    const uid = +auth.replace('Bearer user-', '');
    return USERS[uid] ? send(200, USERS[uid]) : send(401, {});
  }
  if (auth !== 'Bearer app') return send(401, { error: 'token de aplicación esperado' });
  let m;
  if (url.pathname === '/api/v2/users/lookup') {
    // Como osu-web: solo nombres exactos (sin historial ni cambio de espacios por guiones bajos)
    assert.equal(url.searchParams.get('ruleset_id'), '0');
    const users = url.searchParams.getAll('ids[]').map((id) => byName(id.replace(/^@/, ''))).filter(Boolean)
      .map((u) => ({ id: u.id, username: u.username, country_code: u.country_code, avatar_url: u.avatar_url, global_rank: { rank: u.statistics.global_rank, ruleset_id: 0 } }));
    return send(200, { users });
  }
  if ((m = url.pathname.match(/^\/api\/v2\/users\/@([^/]+)\/osu$/))) {
    const name = decodeURIComponent(m[1]);
    const u = byName(name) || byName(name.replace(/_/g, ' ')) || byName(name.replace(/ /g, '_')) || USERS[OLD_NAMES[name.toLowerCase()]];
    return u ? send(200, u) : send(404, {});
  }
  if ((m = url.pathname.match(/^\/api\/v2\/users\/(\d+)\/osu$/))) {
    if (m[1] === '1234') return send(200, { ...USERS[501], id: 501, username: '1234' }); // sin ID 1234: osu! encuentra al usuario llamado "1234"
    if (failProfiles.has(+m[1])) return send(500, {}); // osu! caído para ese perfil
    profileCalls.push(+m[1]);
    return USERS[m[1]] ? send(200, USERS[m[1]]) : send(404, {});
  }
  if ((m = url.pathname.match(/^\/api\/v2\/beatmaps\/(\d+)$/))) return +m[1] === 404404 ? send(404, {}) : send(200, beatmap(+m[1]));
  if ((m = url.pathname.match(/^\/api\/v2\/beatmaps\/(\d+)\/attributes$/))) {
    const mods = JSON.parse(body).mods;
    const [aim, speed, notes] = ATTR[m[1]] || [2, 2, 300];
    return send(200, { attributes: { star_rating: mods.includes('DT') ? 7.12 : 5.78, aim_difficulty: aim, speed_difficulty: speed, speed_note_count: notes, slider_factor: 0.98 } });
  }
  if (url.pathname === '/api/v2/matches/555') return send(200, page(match555(), url));
  if (url.pathname === '/api/v2/matches/900') return send(200, page(qual900(), url));
  if (url.pathname === '/api/v2/matches/901') return send(200, page(qual901(), url));
  if (url.pathname === '/api/v2/matches/902') return send(200, page(qual902(), url));
  if (url.pathname === '/api/v2/matches/903') return send(200, page(qual903(), url));
  if (url.pathname === '/api/v2/matches/556') return send(200, page(match556(), url));
  if (url.pathname === '/api/v2/matches/557') return send(200, page(match557(), url));
  if (url.pathname === '/api/v2/matches/558') return send(200, page(match558(), url));
  if (url.pathname === '/api/v2/matches/561') return send(200, page(match561(), url));
  if (url.pathname === '/api/v2/matches/559') return send(200, page(qual559(), url));
  if (url.pathname === '/api/v2/matches/560') return send(200, page(qual560(), url));
  if (url.pathname === '/api/v2/matches/777') return send(403, { error: null }); // lobby creado con !mp makeprivate
  if ((m = url.pathname.match(/^\/api\/v2\/matches\/(6\d\d)$/))) return send(200, page(matchN(+m[1]), url));
  send(404, {});
});

// ---------- Bancho (IRC de osu!) simulado ----------
// Acepta la contraseña IRC «irc-secreta», crea MPs con !mp make (558, 559…) y responde a !mp map, !mp settings y !mp close.
const irc = { conns: [], sent: [], lines: [], mps: new Set(), nextMp: 558, settings: {}, full: false };
// Comandos que llevan al final una palabra al azar contra el anti-spam de Bancho (nunca un número): se guarda sin ella.
const TAG = /^(!mp (?:settings|close|abort|aborttimer|start(?: \d+)?|timer \d+|map \d+(?: \d)?|mods \S.*|set \d.*)) ([a-z0-9]*[a-z][a-z0-9]*)$/;
const ircOut = (c, line) => { if (!c.closed) c.sock.write(line + '\r\n'); };
const bb = (c, ch, text) => ircOut(c, `:BanchoBot!cho@ppy.sh PRIVMSG ${ch} :${text}`);
// Mensaje en un canal (de BanchoBot o de un jugador) para la conexión abierta
const ircSay = (ch, from, text) => { for (const c of irc.conns) if (c.ready) ircOut(c, `:${from}!cho@ppy.sh PRIVMSG ${ch} :${text}`); };
const sentTo = (ch) => irc.sent.filter((m) => m.to === ch).map((m) => m.text);
const bancho = net.createServer((sock) => {
  const c = { sock, nick: null, pass: null, ready: false, closed: false };
  irc.conns.push(c);
  sock.setEncoding('utf8');
  sock.on('error', () => {});
  sock.on('close', () => { c.closed = true; c.ready = false; });
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      irc.lines.push(line);
      let m;
      if ((m = line.match(/^PASS (.+)$/))) c.pass = m[1];
      else if ((m = line.match(/^NICK (.+)$/))) {
        c.nick = m[1];
        if (c.pass === 'irc-secreta') { c.ready = true; ircOut(c, `:cho.ppy.sh 001 ${c.nick} :Welcome to the osu!Bancho.`); ircOut(c, 'PING :cho.ppy.sh'); }
        else { ircOut(c, `:cho.ppy.sh 464 ${c.nick} :Bad authentication token.`); sock.end(); }
      } else if (line === 'QUIT') c.quit = true;
      else if ((m = line.match(/^JOIN (#mp_\d+)$/))) {
        if (irc.mps.has(m[1])) ircOut(c, `:${c.nick}!cho@ppy.sh JOIN :${m[1]}`);
        else ircOut(c, `:cho.ppy.sh 403 ${c.nick} ${m[1]} :No such channel ${m[1]}`);
      } else if ((m = line.match(/^PRIVMSG (\S+) :(.*)$/))) {
        const [, to, raw] = m;
        const tag = raw.match(TAG);
        const text = tag ? tag[1] : raw;
        irc.sent.push({ to, text, raw, tagged: Boolean(tag), at: Date.now() });
        let k;
        if (to === 'BanchoBot' && irc.full && /^!mp make /.test(text)) {
          bb(c, c.nick, 'You cannot create any more tournament matches. Please close any previous tournament matches you have open.');
        } else if (to === 'BanchoBot' && (k = text.match(/^!mp make (.+)$/))) {
          const mp = irc.nextMp++;
          irc.mps.add('#mp_' + mp);
          bb(c, c.nick, `Created the tournament match https://osu.ppy.sh/mp/${mp} ${k[1]}`);
          ircOut(c, `:${c.nick}!cho@ppy.sh JOIN :#mp_${mp}`);
        }
        if ((k = text.match(/^!mp map (\d+) 0$/))) bb(c, to, `Changed beatmap to https://osu.ppy.sh/b/${k[1]} Artista ${k[1]} - Titulo ${k[1]}`);
        if (text === '!mp settings') for (const l of irc.settings[to] || []) bb(c, to, l);
        if ((k = text.match(/^!mp mods (.+)$/))) {
          const NAMES = { NF: 'NoFail', HD: 'Hidden', HR: 'HardRock', DT: 'DoubleTime', EZ: 'Easy' };
          bb(c, to, /^freemod$/i.test(k[1]) ? 'Enabled FreeMod' : `Enabled ${k[1].split(' ').map((x) => NAMES[x] || x).join(', ')}, disabled FreeMod`);
        }
        if ((k = text.match(/^!mp kick (.+)$/))) { bb(c, to, `Kicked ${k[1]} from the match.`); bb(c, to, `${k[1]} left the game.`); }
        if (text === '!mp close') { bb(c, to, 'Closed the match'); irc.mps.delete(to); }
      }
    }
  });
});

// ---------- cliente HTTP con cookies ----------
function client(base) {
  const jar = {};
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  async function req(path, { method = 'GET', json, headers = {} } = {}) {
    const r = await fetch(path.startsWith('http') ? path : base + path, {
      method, redirect: 'manual',
      headers: { Cookie: cookieHeader(), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : undefined
    });
    for (const c of r.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';');
      const [k, v] = kv.split('=');
      if (attrs.some((a) => a.trim() === 'Max-Age=0')) delete jar[k]; else jar[k] = v;
    }
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : await r.text() };
  }
  req.cookie = cookieHeader;
  return req;
}

// Página del árbitro: lee los Server-Sent Events y guarda el último estado recibido.
async function refStream(base, c) {
  const ctrl = new AbortController();
  const r = await fetch(base + '/api/ref/events', { headers: { Cookie: c.cookie() }, signal: ctrl.signal });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/event-stream/);
  const st = { last: null, count: 0, close: () => ctrl.abort() };
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          buf = buf.slice(i + 2);
          if (data) { st.last = JSON.parse(data); st.count++; }
        }
      }
    } catch { /* cerrado */ }
  })();
  return st;
}

async function login(base, uid) {
  nextLogin = uid;
  const c = client(base);
  const a = await c('/auth/osu');
  assert.equal(a.status, 302);
  const b = await fetch(a.headers.get('location'), { redirect: 'manual' });
  const cb = await c(b.headers.get('location'));
  assert.equal(cb.status, 302, 'el callback redirige');
  assert.equal(cb.headers.get('location'), '/#registro');
  return c;
}

// ---------- prueba ----------
const dir = mkdtempSync(join(tmpdir(), 'spisix-'));
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
await new Promise((r) => bancho.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;
let log = '';
// fakeNow: adelanta el reloj del servidor (Date.now) a esa fecha, para probar fases futuras del torneo.
function startServer(name, fakeNow) {
  const port = 31000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const clock = fakeNow ? ['--import', `data:text/javascript,const o=${Date.parse(fakeNow)}-Date.now(),n=Date.now;Date.now=()=>n()+o;`] : [];
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...clock, 'server.js'], {
    env: {
      ...process.env, PORT: String(port), BASE_URL: base, OSU_BASE: MOCK, OSU_CLIENT_ID: '123', OSU_CLIENT_SECRET: 'secreto', ADMIN_IDS: '4242',
      DB_PATH: join(dir, name + '.db'),
      ...(name === 'test' ? { OTR_API_KEY: 'otr-clave', OTR_BASE: MOCK, OTR_GAP_MS: '0' } : {}), // el segundo servidor, sin clave de o!TR
      TWITCH_BASE: MOCK, TWITCH_CLIENT_ID: 'tw-id', TWITCH_CLIENT_SECRET: 'tw-secreto',
      BANCHO_HOST: '127.0.0.1', BANCHO_PORT: String(bancho.address().port), BANCHO_RATE_MS: '300', OSU_MATCH_GAP_MS: '300',
      ...(name === 'octavos' ? { REF_TIME_SCALE: '0.05' } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  return { proc, port, base };
}
const until = async (cond, what) => {
  for (let i = 0; i < 50; i++) { if (await cond()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('No llegó a pasar: ' + what);
};
async function ready(base) {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
}
const { proc: srv, port: PORT, base: BASE } = startServer('test', TEST_NOW);
let srv2 = null;

let failed = false;
try {
  await ready(BASE);
  const anon = client(BASE);

  let r = await anon('/');
  assert.equal(r.status, 200);
  assert.match(r.body, /SpiSix: Fall Cup/);
  assert.ok(r.headers.get('content-security-policy'));
  // Etiquetas para compartir con la dirección completa de la web, y su imagen e icono
  assert.ok(r.body.includes(`<meta property="og:image" content="${BASE}/og.png">`), 'og:image con BASE_URL');
  assert.ok(!r.body.includes('__BASE_URL__'), 'no queda el marcador sin sustituir');
  // La web no tiene compilación: al menos, que sus scripts se puedan interpretar sin errores de sintaxis.
  const scripts = [...r.body.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
  assert.ok(scripts.length >= 1, 'la página lleva su script');
  scripts.forEach((code, i) => assert.doesNotThrow(() => new Function(code), `el script ${i + 1} de la página tiene un error de sintaxis`));
  assert.ok(r.body.includes('#partidos/jugador/'), 'los partidos de un jugador tienen su propia dirección');
  r = await anon('/og.png');
  assert.deepEqual([r.status, r.headers.get('content-type')], [200, 'image/png']);
  r = await anon('/favicon.svg');
  assert.deepEqual([r.status, r.headers.get('content-type')], [200, 'image/svg+xml']);
  // Guía de /api/overlay: sin sesión no se ve, ni dando un rodeo por los archivos estáticos
  r = await anon('/api.html');
  assert.deepEqual([r.status, r.headers.get('content-type'), r.headers.get('cache-control')], [401, 'text/html; charset=utf-8', 'no-store']);
  assert.match(r.body, /inicia sesión con osu!/);
  assert.ok(!r.body.includes('/api/overlay'), 'sin permiso no sale nada de la guía');
  for (const p of ['/api%2Ehtml', '/api.html/', '/server/api-guide.html', '/api-guide.html']) assert.equal((await anon(p)).status, 404, p);
  r = await anon('/../server.js');
  assert.equal(r.status, 404, 'no se puede salir de public/');
  r = await anon('/api/state');
  assert.equal(r.body.me, null);
  r = await anon('/healthz');
  assert.deepEqual(r.body, { ok: true });
  assert.match((await anon('/')).headers.get('content-security-policy'), /frame-src https:\/\/player\.twitch\.tv/);
  await until(() => calls.includes('GET /helix/streams?user_login=spi6_osu'), 'consulta a Twitch al arrancar');
  assert.deepEqual((await anon('/api/state')).body.twitch, { channel: 'spi6_osu', live: null }, 'sin directo');
  r = await anon('/%E0');
  assert.equal(r.status, 404, 'ruta mal codificada');
  r = await anon('/api/state', { headers: { Cookie: 'sid=%E0' } });
  assert.equal(r.status, 200, 'cookie mal codificada');
  const raw = await new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => s.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let out = '';
    s.on('data', (d) => (out += d));
    s.on('close', () => resolve(out));
  });
  assert.match(raw, /^HTTP\/1\.1 400/, 'una URL inválida responde 400');
  assert.equal((await anon('/healthz')).status, 200, 'el servidor sigue vivo tras una URL inválida');
  console.log('✓ página, estado público y peticiones malformadas');

  r = await anon('/api/qual/signup', { method: 'POST', json: { slot: 1 } });
  assert.equal(r.status, 401);

  const adm = await login(BASE, 4242);
  r = await adm('/api/state');
  assert.equal(r.body.me.username, 'Organizador');
  assert.equal(r.body.me.admin, true);
  console.log('✓ login OAuth con osu!');

  r = await adm('/api/qual/signup', { method: 'POST', body: 'slot=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 415, 'solo JSON');
  for (const path of ['/api/register', '/api/unregister']) {
    assert.equal((await adm(path, { method: 'POST', json: { disponibilidad: 'y', normas: true } })).status, 404, 'la inscripción es solo por el formulario');
  }

  const strong = await login(BASE, 77);
  r = await strong('/api/admin/pool', { method: 'POST', json: { round: 'octavos', slot: 'NM1', beatmap: '1' } });
  assert.equal(r.status, 403, 'un jugador no puede administrar');
  r = await strong('/api/admin/exception', { method: 'POST', json: { user: '77' } });
  assert.equal(r.status, 403, 'un jugador no puede añadir excepciones');
  console.log('✓ bloquea el panel a no admins');

  // Excepción de rango desde el panel: se pega el enlace del perfil, y el formulario ya le deja entrar
  r = await adm('/api/admin/exception', { method: 'POST', json: { user: 'https://osu.ppy.sh/users/78' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.username, 'RankBuffer');
  r = await adm('/api/admin/exception', { method: 'POST', json: { user: '123456789' } });
  assert.equal(r.status, 404);
  r = await adm('/api/admin/exception', { method: 'POST', json: { user: '1234' } });
  assert.equal(r.status, 404, 'un ID inexistente no se confunde con un nombre de usuario numérico');
  r = await adm('/api/state');
  assert.deepEqual(r.body.exceptions, [{ id: 78, username: 'RankBuffer' }]);
  assert.ok(r.body.config.rango.excepciones.includes(78));
  assert.equal((await anon('/api/state')).body.exceptions, undefined, 'la lista detallada es solo para admins');
  r = await adm('/api/admin/import', { method: 'POST', json: { text: 'osu name\tdiscord\tdisponibilidad\nRankBuffer\tbuffer\tfindes' } });
  assert.deepEqual(r.body.imported, ['RankBuffer'], 'la excepción permite inscribirse fuera del rango');
  r = await adm('/api/admin/exception/delete', { method: 'POST', json: { id: 78 } });
  assert.equal(r.status, 200);
  assert.deepEqual((await adm('/api/state')).body.exceptions, []);
  console.log('✓ excepciones de rango desde el panel');

  // Guía de la API: la ven los admins y quien añadan en el panel; los demás, aunque tengan sesión, no
  r = await strong('/api.html');
  assert.equal(r.status, 403);
  assert.ok(!r.body.includes('/api/overlay'));
  assert.equal((await strong('/api/state')).body.me.apiGuide, false);
  r = await adm('/api.html');
  assert.deepEqual([r.status, r.headers.get('content-type'), r.headers.get('cache-control')], [200, 'text/html; charset=utf-8', 'no-store']);
  assert.ok(r.body.includes(`${BASE}/api/overlay?match=u1-6`), 'la guía lleva la dirección completa de la ruta');
  assert.ok(!r.body.includes('__BASE_URL__'), 'no queda el marcador sin sustituir en la guía');
  [...r.body.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].forEach((x) => assert.doesNotThrow(() => new Function(x[1]), 'script de la guía'));
  assert.equal((await strong('/api/admin/api-access', { method: 'POST', json: { user: '77' } })).status, 403, 'solo los admins dan acceso');
  assert.equal((await adm('/api/admin/api-access', { method: 'POST', json: { user: '' } })).status, 400);
  r = await adm('/api/admin/api-access', { method: 'POST', json: { user: '77' } });
  assert.deepEqual(r.body, { ok: true, id: 77, username: 'DemasiadoBueno' });
  assert.deepEqual((await adm('/api/state')).body.apiAccess, [{ id: 77, username: 'DemasiadoBueno' }]);
  assert.equal((await strong('/api/state')).body.apiAccess, undefined, 'la lista es solo para admins');
  r = await strong('/api/state');
  assert.deepEqual([r.body.me.apiGuide, r.body.me.admin], [true, false], 'acceso a la guía, sin ningún otro permiso');
  assert.equal((await strong('/api.html')).status, 200);
  assert.equal((await strong('/api/admin/exception', { method: 'POST', json: { user: '78' } })).status, 403, 'sigue sin poder usar el panel');
  assert.equal((await adm('/api/admin/api-access/delete', { method: 'POST', json: { id: 77 } })).status, 200);
  assert.equal((await strong('/api.html')).status, 403, 'al quitarlo, deja de verla');
  assert.deepEqual((await adm('/api/state')).body.apiAccess, []);
  console.log('✓ guía de la API: solo para admins y quien se añada en el panel');

  // Importación del formulario de Google (funciona con los registros abiertos o cerrados)
  const sheet = [
    'Marca temporal\tosu In game name\tdiscord user\tDisponibilidad horaria en hora española',
    '1/11/2026 12:00:00\tjugadora\tja\tL-V tardes',          // otras mayúsculas: búsqueda en bloque
    '1/11/2026 12:05:00\tJugador_C\tjc\t"noches\ny findes"', // en osu! es "Jugador C"; celda con salto de línea
    '1/11/2026 12:10:00\tNombreViejo\tnv\tfinde',             // nombre antiguo: historial
    '1/11/2026 12:15:00\tDemasiadoBueno\tpro\ttodo',          // #45.000: fuera de rango
    '1/11/2026 12:20:00\tNoExiste123\tx\tx',
    '1/11/2026 12:25:00\tOrganizador\totra\tmañanas',
    '2/11/2026 08:00:00\tJugadorA\tja2\tL-V noches'           // segunda respuesta: vale esta, con la fecha de la primera
  ].join('\n');
  r = await anon('/api/admin/import', { method: 'POST', json: { text: sheet } });
  assert.equal(r.status, 401);
  const lookups = () => calls.filter((c) => c.startsWith('GET /api/v2/users/lookup')).length;
  const lookups0 = lookups();
  r = await adm('/api/admin/import', { method: 'POST', json: { text: sheet } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.notFound, ['NoExiste123']);
  assert.deepEqual(r.body.rejected, [{ name: 'DemasiadoBueno', rank: 45000, country: 'ES' }]);
  assert.deepEqual(r.body.imported.sort(), ['Jugador C', 'JugadorA', 'NombreNuevo', 'Organizador'].sort());
  assert.deepEqual(r.body.already, []);
  assert.equal(lookups() - lookups0, 1, 'una sola petición en bloque');
  r = await adm('/api/state');
  const pl = Object.fromEntries(r.body.players.map((p) => [p.username, p]));
  assert.equal(pl['Jugador C'].availability, 'noches y findes');
  assert.equal(new Date(pl.JugadorA.registered_at).toISOString(), '2026-11-01T11:00:00.000Z', 'fecha de la primera respuesta, hora de Madrid');
  assert.equal(pl.Organizador.availability, 'mañanas', 'el admin ve la disponibilidad');
  const pub = (await anon('/api/state')).body.players.find((p) => p.username === 'Organizador');
  assert.equal(pub.availability, undefined, 'el público no ve la disponibilidad');
  r = await adm('/api/admin/import', { method: 'POST', json: { text: sheet } });
  assert.deepEqual(r.body.imported, [], 'repetir la importación no duplica');
  await adm('/api/admin/player/delete', { method: 'POST', json: { id: 503 } });
  r = await adm('/api/admin/import', { method: 'POST', json: { text: sheet } });
  assert.deepEqual(r.body.removed, ['Jugador C'], 'quien quitó la organización no vuelve al importar');
  r = await adm('/api/admin/import', { method: 'POST', json: { text: '' } });
  assert.equal(r.status, 400);
  // La columna de Discord del formulario se salta: ni se guarda ni se toma por el nombre de osu!
  r = await adm('/api/state');
  assert.ok(!/discord|ja2/i.test(JSON.stringify([r.body.me, r.body.players])), 'del formulario no se guarda el Discord');
  assert.deepEqual(r.body.config.enlaces.map(([n]) => n), ['Discord de SpiSix', 'Twitch'], 'en la web, Discord es solo un enlace');
  r = await adm('/api/admin/import', { method: 'POST', json: { text: 'Discord username\tosu name\nNoExisteEnOsu\tJugadorA' } });
  assert.deepEqual([r.body.already, r.body.notFound], [['JugadorA'], []], JSON.stringify(r.body));
  const { parseResponses } = await import('../server/import.js');
  const fecha = '1/11/2026 12:00:00';
  for (const [text, want] of [[`${fecha}\tAna\tana_dc\ttardes`, 'tardes'], [`${fecha}\tAna\ttardes`, 'tardes'], [`${fecha}\tAna`, ''], ['Ana\tana_dc\ttardes', 'tardes'], ['Ana\ttardes', 'tardes'], ['Ana', '']]) {
    const [e] = parseResponses(text);
    assert.deepEqual([e.name, e.availability], ['Ana', want], text);
    assert.equal(e.discord, undefined);
  }
  for (const [method, path] of [['GET', '/auth/discord'], ['GET', '/auth/discord/callback?code=a&state=b'], ['POST', '/api/discord/unlink'], ['POST', '/api/admin/discord/test'], ['POST', '/api/admin/discord/pool']]) {
    const opts = method === 'POST' ? { method, json: {} } : {};
    r = await adm(path, opts);
    assert.ok(r.status === 404 || (method === 'GET' && r.status === 200 && !r.headers.get('location')), `${path}: ${r.status}`);
  }
  r = await adm('/api/admin/import', { method: 'POST', json: { text: 'osu name\tdisponibilidad\nJugadorB\ttardes' } });
  assert.deepEqual(r.body.imported, ['JugadorB'], JSON.stringify(r.body));
  console.log('✓ importación del formulario de Google');

  // Ficha del jugador: la sincronización automática (cada 5 minutos, y en cuanto se importan inscritos) guarda una
  // foto del perfil de cada inscrito con más de un día. La ficha la lee de /api/profile, sin pedir nada a osu!.
  const profileOf = async (id) => (await anon('/api/profile?id=' + id)).body;
  for (let i = 0; i < 250 && !(await profileOf(501)).profile; i++) await new Promise((res) => setTimeout(res, 100));
  r = await anon('/api/profile?id=501');
  assert.equal(r.status, 200);
  const snap = r.body;
  assert.ok(snap.taken_at > 0, 'la foto lleva la fecha');
  assert.deepEqual(snap.profile, {
    username: 'JugadorA', avatar_url: 'https://a.ppy.sh/501', country: 'ES', country_name: 'Spain', global_rank: 150000, country_rank: 4100,
    pp: 3123.45, accuracy: 98.1234, play_count: 25000,
    rank_history: [...Array(10).fill(null), ...Array.from({ length: 80 }, (_, i) => 160000 - i * 125)]
  }, 'solo datos públicos de osu!; los días sin rango quedan en null');
  const calls501 = () => profileCalls.filter((id) => id === 501).length; // la sincronización sigue con los demás de fondo
  const before = calls501();
  for (let i = 0; i < 3; i++) await anon('/api/profile?id=501');
  assert.equal(calls501(), before, 'abrir la ficha no pide nada a osu!');
  assert.equal((await anon('/api/profile?id=77')).status, 404, 'solo hay fichas de inscritos');
  assert.equal((await anon('/api/profile?id=abc')).status, 400);
  // Si osu! falla, se queda la última foto buena (Actualizar rangos también toma la foto).
  failProfiles.add(501);
  r = await adm('/api/admin/refresh', { method: 'POST', json: {} });
  assert.match(r.body.warning || '', /JugadorA/);
  const kept = await profileOf(501);
  assert.deepEqual([kept.profile, kept.taken_at], [snap.profile, snap.taken_at], 'con osu! fallando no se pierde la foto');
  failProfiles.delete(501);
  USERS[501].statistics.pp = 3200;
  r = await adm('/api/admin/refresh', { method: 'POST', json: {} });
  assert.equal(r.status, 200);
  const snap2 = await profileOf(501);
  assert.equal(snap2.profile.pp, 3200, 'Actualizar rangos renueva la foto');
  assert.ok(snap2.taken_at > snap.taken_at);
  console.log('✓ ficha del jugador: foto diaria del perfil de osu!, sin datos privados, y se conserva si osu! falla');

  // Skills: fórmulas (server/skills.js)
  const w2 = mapWeights([{ key: 'A', comp: { aim: 3, speed: 3, prec: 4, acc: 8, stamina: 500 } }, { key: 'B', comp: { aim: 2, speed: 2, prec: 5, acc: 9, stamina: 300 } }]).get('A');
  assert.ok(Math.abs(w2.aim - 1.21 / 3.65) < 1e-12 && Math.abs(w2.prec - 0.01 / 3.65) < 1e-12, 'peso = (p + 0,1)² / Σ(p + 0,1)²');
  const eq = { aim: 1500, speed: 1500, prec: 1500, acc: 1500, stamina: 1500 };
  const d1 = duel(eq, eq, { aim: 0.1, speed: 0.6, prec: 0.1, acc: 0.1, stamina: 0.1 }, true);
  assert.deepEqual([d1.a.speed, d1.a.aim, d1.b.speed, d1.b.aim], [1524, 1504, 1476, 1496], 'K = 80: entre iguales, +40 repartidos por peso');
  const d2 = duel({ ...eq, speed: 1700 }, eq, { aim: 0, speed: 1, prec: 0, acc: 0, stamina: 0 }, false);
  assert.ok(d2.b.speed - 1500 > 40, 'ganar a un rival más fuerte da más puntos');
  assert.deepEqual([mapFactor('NM1', false), mapFactor('FM2', false), mapFactor('TB', false), mapFactor('HD1', true), mapFactor('FM1', true)], [1, 0.5, 0.5, 0.5, 0.25]);
  assert.ok(Math.abs(inverseNormal(0.975) - 1.959964) < 1e-6 && inverseNormal(0.5) === 0);
  const zs = qualZ({ 1: { 10: 900 }, 2: { 10: 700 }, 3: { 10: 0 } }, [10]);
  assert.deepEqual([...zs.get('10')], [[1, 1], [2, -1]], 'z solo entre quienes jugaron el mapa');
  const bs = qualBase(zs, [{ bid: 10, key: 'K' }], new Map([['K', { aim: 0.5, speed: 0.2, prec: 0.1, acc: 0.1, stamina: 0.1 }]]));
  assert.deepEqual(bs.get(1), { aim: 1, speed: 1, prec: 1, acc: 1, stamina: 1 });
  assert.deepEqual(percentiles(new Map([[1, eq], [2, { ...eq, aim: 1400 }], [3, { ...eq, aim: 1400 }]]), 1).aim, 100);
  assert.deepEqual(percentiles(new Map([[1, eq], [2, eq]]), 1).aim, 0, 'un empate no cuenta como mejor');
  // Fuerza general: con TR (z frente a los que tienen TR) y, si no, con la seed. Con un solo TR no hay con qué comparar.
  const gs = generalStrength({ ids: [1, 2, 3, 4], tr: new Map([[1, 1000], [2, 1400]]), seeds: new Map([[3, 1], [4, 8]]), ranked: 16 });
  assert.deepEqual([gs.get(1), gs.get(2), [...gs.fromTr]], [1200, 1800, [1, 2]], 'TR: 1500 ± 300 · z');
  assert.ok(Math.abs(gs.get(3) - (1500 + 300 * inverseNormal(1 - 0.5 / 16))) < 1e-9 && gs.get(4) > 1500 && gs.get(4) < gs.get(3), 'seed: la 1 arriba');
  assert.equal(generalStrength({ ids: [1, 2], tr: new Map([[1, 1000]]), seeds: new Map([[1, 2]]), ranked: 4 }).fromTr.size, 0, 'un solo TR: se usa la seed');

  // o!TR: foto diaria de cada inscrito (también al importar), con su clave y sin que la clave salga en ningún sitio.
  const otrOf = async (id) => (await profileOf(id)).otr;
  const waitFor = async (cond, what) => { for (let i = 0; i < 300; i++) { if (await cond()) return; await new Promise((res) => setTimeout(res, 100)); } throw new Error('No llegó a pasar: ' + what); };
  const notInOtr = (await anon('/api/state')).body.players.find((p) => !OTR[p.id]);
  await waitFor(async () => (await otrOf(501)) && (await otrOf(502)) && (await otrOf(notInOtr.id)), 'datos de o!TR');
  const o501 = await otrOf(501);
  assert.ok(o501.taken_at > 0);
  assert.deepEqual({ ...o501, taken_at: 0 }, {
    found: true, otr_id: 77001, rating: 1234.56, percentile: 87.5, global_rank: 3210, country_rank: 45, tier: 'gold', sub_tier: 2,
    provisional: false, tournaments: 7, matches: 60, win_rate: 0.55, taken_at: 0, url: MOCK + '/players/77001',
    mods: [{ mods: 'NM', count: 40, average: 575000 }, { mods: 'HD', count: 40, average: 600000 }, { mods: 'DT', count: 5, average: 700000 }]
  }, 'NF no cuenta, NC es DT y la media se pondera por partidas');
  assert.deepEqual([(await otrOf(502)).found, (await otrOf(502)).rating], [true, null], 'en o!TR sin rating');
  assert.deepEqual([(await otrOf(notInOtr.id)).found, (await otrOf(notInOtr.id)).rating], [false, null], 'o!TR no lo conoce (404)');
  for (const path of ['/api/profile?id=501', '/api/state']) assert.ok(!JSON.stringify((await adm(path)).body).includes('otr-clave'), 'la clave de o!TR no sale en ' + path);
  // Si o!TR falla, se queda la última foto buena. Actualizar rangos también la renueva.
  otrFail = true;
  OTR[501].rating.rating = 1300; // si o!TR respondiera, se vería este valor
  let c0 = otrCalls.length;
  await adm('/api/admin/refresh', { method: 'POST', json: {} });
  await waitFor(() => otrCalls.slice(c0).includes(501), 'petición fallida a o!TR');
  await new Promise((res) => setTimeout(res, 200));
  assert.equal((await otrOf(501)).rating, 1234.56, 'con o!TR fallando no se pierde la foto');
  // Un 404 de alguien que o!TR tenía tampoco la pisa (puede ser un cambio de su API).
  otrFail = false;
  const saved = OTR[501];
  delete OTR[501];
  c0 = otrCalls.length;
  await adm('/api/admin/refresh', { method: 'POST', json: {} });
  await waitFor(() => otrCalls.slice(c0).includes(501), 'petición con 404 a o!TR');
  await new Promise((res) => setTimeout(res, 200));
  assert.deepEqual([(await otrOf(501)).found, (await otrOf(501)).rating], [true, 1234.56], 'un 404 no borra lo que había');
  OTR[501] = saved;
  await adm('/api/admin/refresh', { method: 'POST', json: {} });
  await waitFor(async () => (await otrOf(501)).rating === 1300, 'Actualizar rangos renueva o!TR');
  assert.ok(!log.includes('otr-clave'), 'la clave de o!TR no sale en el log');
  console.log('✓ o!TR: foto diaria por jugador, mods agrupados, jugadores sin rating, se conserva si o!TR falla y la clave no sale');

  // Mappool: el SR con DT se pide a /attributes y se ajustan BPM, duración y AR
  r = await adm('/api/admin/pool', { method: 'POST', json: { round: 'octavos', slot: 'dt1', beatmap: 'https://osu.ppy.sh/beatmapsets/1#osu/106' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.sr, 7.12);
  assert.equal(r.body.data.bpm, 270);
  assert.equal(r.body.data.length, 100);
  assert.equal(r.body.data.ar, 10.3);
  assert.equal(r.body.data.creator, 'Invitado', 'en una guest difficulty se muestra a quien la ha hecho');
  for (const [slot, bid] of [['NM1', 101], ['NM2', 102], ['FM1', 103], ['HD1', 104], ['HR1', 105]]) {
    r = await adm('/api/admin/pool', { method: 'POST', json: { round: 'octavos', slot, beatmap: String(bid) } });
    assert.equal(r.status, 200);
  }
  r = await adm('/api/admin/pool', { method: 'POST', json: { round: 'octavos', slot: 'XX1', beatmap: '5' } });
  assert.equal(r.status, 400);
  r = await adm('/api/state');
  assert.deepEqual(r.body.pools.octavos.map((x) => x.slot), ['NM1', 'NM2', 'HD1', 'HR1', 'DT1', 'FM1']);
  console.log('✓ mappool desde /beatmaps y /beatmaps/{id}/attributes');

  // Publicación de mappools: sin hora programada, a las 00:00 del día del showcase (Madrid). Antes, solo la organización.
  const showcaseOct = Date.parse('2026-11-16T00:00:00+01:00');
  const octHidden = Date.now() < showcaseOct;
  r = await anon('/api/state');
  assert.deepEqual(r.body.releases.octavos, { at: showcaseOct, set: false });
  if (octHidden) {
    assert.equal(r.body.pools.octavos, undefined, 'antes del showcase el público no ve la mappool');
    assert.equal((await adm('/api/state')).body.pools.octavos.length, 6, 'la organización sí');
  }
  const inOneHour = Date.now() + 3600e3;
  r = await anon('/api/admin/pool/release', { method: 'POST', json: { round: 'octavos', at: inOneHour } });
  assert.equal(r.status, 401);
  r = await adm('/api/admin/pool/release', { method: 'POST', json: { round: 'registros', at: inOneHour } });
  assert.equal(r.status, 400, 'los registros no tienen mappool');
  r = await adm('/api/admin/pool/release', { method: 'POST', json: { round: 'octavos', at: 'mañana' } });
  assert.equal(r.status, 400);
  r = await adm('/api/admin/pool/release', { method: 'POST', json: { round: 'octavos', at: inOneHour } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await anon('/api/state');
  assert.deepEqual(r.body.releases.octavos, { at: inOneHour, set: true });
  assert.equal(r.body.pools.octavos, undefined, 'programada: sigue oculta hasta la hora');
  console.log('✓ publicación programada de mappools');

  // Mappools desde una hoja. Paso 1: leer (no guarda nada). Paso 2: importar lo revisado, ronda a ronda.
  const readPool = (json) => adm('/api/admin/pool/read', { method: 'POST', json });
  const importPool = (round, maps) => adm('/api/admin/pool/import', { method: 'POST', json: { round, maps } });
  const readFile = (buf) => readPool({ file: Buffer.from(buf).toString('base64') });
  const summary = (g) => g.maps.map((m) => `${m.slot}=${m.beatmap}`).join(' ');

  // La pestaña Mappools de una hoja principal, pegada tal cual (dos columnas MAP ID: manda la primera)
  const sheetPool = [
    '  SEMIFINALS\t\t\t\t\t\tBO11, 2 BANS\t\t\t\t\t\tMAPPACK\t\t\tuse mirror\tmappool',
    'BANNER\tPICK\t  ARTIST - TITLE [DIFF]\t\tSR ★\tBPM\tDRAIN\tCOMBO\tCS\tAR\tOD\tMAP ID\tMAP ID\tMULTIPLIER',
    '\tNM1\tArtista 301 - Titulo 301 [Insane]\tCustom\t6.03\t180\t3:49\t1331\t4\t9.3\t9\t301\t999301\t',
    '\tHR1\tArtista 302 - Titulo 302 [Insane]\t\t6.06\t120\t1:52\t1019\t4\t9.4\t8.5\t302\t\t',
    '\tDT1\tArtista 303 - Titulo 303 [Insane]\t\t6.29\t258\t2:34\t1272\t3.6\t10.1\t9.8\t303\t\t',
    '\tTB\tArtista 304 - Titulo 304 [Insane]\tCustom\t5.91\t200\t5:02\t2287\t4.5\t9.3\t8.8\t304\t\t'
  ].join('\n');
  r = await anon('/api/admin/pool/read', { method: 'POST', json: { text: sheetPool } });
  assert.ok([401, 403].includes(r.status), 'leer: solo admins');
  r = await anon('/api/admin/pool/import', { method: 'POST', json: { round: 'semis', maps: [{ slot: 'NM1', beatmap: 301 }] } });
  assert.ok([401, 403].includes(r.status), 'importar: solo admins');
  r = await readPool({ text: sheetPool });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.groups.length, 1);
  let g = r.body.groups[0];
  assert.equal(g.name, 'SEMIFINALS');
  assert.equal(g.suggest, 'semis');
  assert.equal(summary(g), 'NM1=301 HR1=302 DT1=303 TB=304');
  assert.equal((await adm('/api/state')).body.pools.semis, undefined, 'leer no guarda nada');
  r = await importPool('semis', g.maps);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.added, ['NM1', 'HR1', 'DT1', 'TB']);
  assert.deepEqual(r.body.warnings, [], JSON.stringify(r.body.warnings));
  r = await adm('/api/state');
  assert.deepEqual(r.body.pools.semis.map((x) => [x.slot, x.beatmap_id]), [['NM1', 301], ['HR1', 302], ['DT1', 303], ['TB', 304]]);
  assert.equal(r.body.pools.semis.find((x) => x.slot === 'DT1').data.sr, 7.12, 'SR con DT desde /attributes');
  // Todo o nada: si un mapa falla, la ronda se queda como estaba
  r = await importPool('semis', [{ slot: 'NM1', beatmap: 305 }, { slot: 'NM2', beatmap: 404404 }]);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /No se ha cambiado nada.*NM2: no existe el mapa 404404/);
  assert.equal((await adm('/api/state')).body.pools.semis.length, 4, 'la pool anterior sigue entera');
  // Importar sustituye la ronda y avisa de lo que no cuadra: otro mapa que el que dice la hoja, sin TB
  r = await importPool('semis', [{ slot: 'NM1', beatmap: 305, text: 'Otra Banda - Otra Cancion [Insane]' }, { slot: 'HD1', beatmap: 306, text: 'Artista 306 - Titulo 306 [Extra]' }, { slot: 'HR1', beatmap: 307 }]);
  assert.deepEqual(r.body.added, ['NM1', 'HD1', 'HR1']);
  assert.match(r.body.warnings[0], /NM1: la hoja dice «Otra Banda.*el ID 305 es «Artista 305 - Titulo 305/);
  assert.match(r.body.warnings[1], /HD1: la hoja dice.*\[Extra\]/, 'otra dificultad de la misma canción');
  assert.equal(r.body.warnings[2], 'Esta ronda no tiene TB.');
  assert.deepEqual((await adm('/api/state')).body.pools.semis.map((x) => x.slot), ['NM1', 'HD1', 'HR1']);
  r = await importPool('semis', [{ slot: 'NM1', beatmap: 305, text: 'Artista 305 - Titulo 305 [Ins]' }, { slot: 'HD1', beatmap: 306, text: 'Artista 306 - Titulo 306 [Insane] (nota)' }, { slot: 'HR1', beatmap: 307 }]);
  assert.deepEqual(r.body.warnings, ['Esta ronda no tiene TB.'], 'dificultad acortada en la hoja o con notas detrás: sin falsa alarma');
  for (const [maps, msg] of [
    [[], /No hay mapas/], ['x', /No hay mapas/], [[{ slot: 'EZ1', beatmap: 1 }], /Slot no válido/], [[{ slot: 'NM1', beatmap: '1;DROP' }], /ID del mapa/],
    [[{ slot: 'NM1', beatmap: 1 }, { slot: 'nm1', beatmap: 2 }], /NM1 está repetido/], [Array.from({ length: 41 }, (_, i) => ({ slot: `NM${i}`, beatmap: 1 })), /máximo son 40/]
  ]) {
    r = await importPool('semis', maps);
    assert.equal(r.status, 400, JSON.stringify(maps).slice(0, 60));
    assert.match(r.body.error, msg);
  }
  assert.equal((await importPool('registros', [{ slot: 'NM1', beatmap: 301 }])).status, 400);

  // Formato de la hoja del torneo pegado: el slot en dos celdas, luego el mod y el ID. Con tabuladores o con espacios.
  for (const sep of ['\t', '   ']) {
    r = await readPool({ text: ['NM', '1', 'NM', '501'].join(sep) + '\n' + [['NM', 2, 'NM', 502], ['HD', 1, 'HD', 503], ['HR', 2, 'HR', 504], ['DT', 2, 'DT', 505], ['TB', 1, 'TB', 506]].map((x) => x.join(sep)).join('\n') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(summary(r.body.groups[0]), 'NM1=501 NM2=502 HD1=503 HR2=504 DT2=505 TB=506', JSON.stringify(sep));
  }
  // Variantes de escritura, slot combinado (la celda del mod solo en la primera fila), números de varias formas, enlaces de dificultad y de set
  r = await readPool({ text: 'nm01\thttps://osu.ppy.sh/beatmapsets/9#osu/511\nNoMod 2\thttps://osu.ppy.sh/b/512\nHidden-1\t513.0\nHard Rock 1\t5,140\nDT\t1\t515\n\t2\t516\nFree Mod 1\t517\nTiebreaker\t518\nFM2\thttps://osu.ppy.sh/beatmapsets/12\nHD2\t\n' });
  g = r.body.groups[0];
  assert.equal(summary(g), 'NM1=511 NM2=512 HD1=513 HR1=5140 DT1=515 DT2=516 FM1=517 TB=518');
  assert.match(g.errors[0], /FM2: el enlace es del set/);
  assert.match(g.errors[1], /HD2: no encuentro el ID/);
  // Sin títulos de columna: el ID es la columna de números grandes, no el BPM ni el combo; EZ1 no se pierde en silencio
  r = await readPool({ text: 'NM1\tA - B [C]\t180\t1331\t1000611\nHD1\tD - E [F]\t120\t1019\t2000612\nHR1\tG - H [I]\t200\t1500\t3000613\nEZ1\tJ - K [L]\t200\t1500\t3000614' });
  g = r.body.groups[0];
  assert.equal(summary(g), 'NM1=1000611 HD1=2000612 HR1=3000613');
  assert.equal(g.maps[0].text, 'A - B [C]');
  assert.match(r.body.notes[0], /sin un slot que entienda.*EZ1/);
  r = await readPool({ text: 'MOD\tMAPA\tMAP ID\nNM1\tA - B [C]\t611\nHD1\tD - E [F]\t612\nHR1\tG - H [I]\t\nEZ1\tJ - K [L]\t614' });
  g = r.body.groups[0];
  assert.equal(summary(g), 'NM1=611 HD1=612', 'con cabecera, nunca se adivina otra columna');
  assert.match(g.errors[0], /HR1: no encuentro/);
  assert.match(r.body.notes[0], /sin un slot que entienda.*EZ1/);
  // Secciones por mod, repetir un slot empieza otra pool, títulos que no son rondas, notas entre el título y la tabla
  r = await readPool({ text: 'Grand Finals\nBest of 13\nNoMod\n1\tA - B\t1000701\n2\tC - D\t1000702\nHidden\n1\tE - F\t1000703\nFINALS\nNM1\t711\nHD1\t712\nHR1\t713\nNM1\t721\nHD1\t722\nHR1\t723\n' });
  assert.deepEqual(r.body.groups.map((x) => [x.name, x.suggest, summary(x)]), [
    ['Grand Finals', 'gf', 'NM1=1000701 NM2=1000702 HD1=1000703'], ['FINALS', 'finals', 'NM1=711 HD1=712 HR1=713'], ['Mappool', null, 'NM1=721 HD1=722 HR1=723']
  ]);
  // Pools una al lado de la otra
  r = await readPool({ text: 'Octavos\t\t\tCuartos\t\nNM1\t801\t\tNM1\t811\nHD1\t802\t\tHD1\t812\nTB\t803\t\tTB\t813' });
  assert.deepEqual(r.body.groups.map((x) => [x.suggest, summary(x)]), [['octavos', 'NM1=801 HD1=802 TB=803'], ['cuartos', 'NM1=811 HD1=812 TB=813']]);
  // El mismo mapa dos veces, el mod que no cuadra y un enlace que contradice al ID se avisan
  r = await readPool({ text: 'pick\tmap url\tmap id\tmods\nNM1\thttps://osu.ppy.sh/b/901\t901\tNM\nNM2\thttps://osu.ppy.sh/b/901\t901\tNM\nHD1\thttps://osu.ppy.sh/b/902\t903\tHR\n' });
  g = r.body.groups[0];
  assert.equal(summary(g), 'NM1=901 NM2=901 HD1=903');
  assert.ok(g.warnings.some((w) => /HD1: el ID \(903\) y el enlace \(902\)/.test(w)), JSON.stringify(g.warnings));
  assert.ok(g.warnings.some((w) => /HD1: la fila también dice HR/.test(w)));
  assert.ok(g.warnings.some((w) => /NM1 y NM2 usan el mismo mapa/.test(w)));
  // Lo que no es una pool
  assert.equal((await readPool({ text: 'hola\nadiós' })).status, 400);
  assert.equal((await readPool({})).status, 400);
  r = await readPool({ text: 'NM1\thttps://osu.ppy.sh/beatmapsets/12' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /el enlace es del set/);

  // Archivos: Excel como los de la captura y como los de Google Sheets (columna de ronda, enlaces aparte, IDs 3493106.0, pestaña oculta)
  const zip = (files, method = 8) => {
    const locals = [], central = [];
    let at = 0;
    for (const [name, text] of Object.entries(files)) {
      const raw = Buffer.from(text), data = method === 8 ? deflateRawSync(raw) : raw, n = Buffer.from(name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(at, 42);
      locals.push(lh, n, data); central.push(ch, n);
      at += 30 + n.length + data.length;
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16);
    return Buffer.concat([...locals, cd, end]);
  };
  const RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const xmlEsc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const strings = [];
  const si = (t) => { if (!strings.includes(t)) strings.push(t); return strings.indexOf(t); };
  const letter = (i) => String.fromCharCode(65 + i);
  const sheetXml = (rows, links = {}) => {
    const body = rows.map((row, y) => `<row r="${y + 1}">${row.map((c, x) => (c === '' ? '' : typeof c === 'number' ? `<c r="${letter(x)}${y + 1}"><v>${c}.0</v></c>` : `<c r="${letter(x)}${y + 1}" t="s"><v>${si(c)}</v></c>`)).join('')}</row>`).join('');
    const hl = Object.keys(links).map((ref, i) => `<hyperlink ref="${ref}" r:id="rId${i + 1}"/>`).join('');
    return `<worksheet ${RNS}><sheetData>${body}</sheetData>${hl ? `<hyperlinks>${hl}</hyperlinks>` : ''}</worksheet>`;
  };
  const mappools = [
    ['Mappools', '', 'ignore if auto-import'], ['stage', 'pick', 'map url', 'map id', 'mods'],
    ['QL', 'NM1', 'Artista 1 - Uno [Expert]', 3493106, 'NM'], ['QL', 'NM2', 'Artista 2 - Dos [Extra]', 874858, 'NM'], ['QL', 'HD1', 'Artista 3 - Tres & Co <x> [Hard]', 1000003, 'HD'],
    ['Q-EX', 'NM1', 'Artista 4 - Cuatro [Expert]', 5022222, 'NM'], ['Q-EX', 'HR1', 'Artista 5 - Cinco [Expert]', 1000005, 'HR'], ['Q-EX', 'DT1', 'Artista 6 - Seis [Expert]', 1000006, 'DT'],
    ['Semana 1 y 2', 'NM1', 'Artista 7 - Siete [Expert]', 3571342, 'NM'], ['Semana 1 y 2', 'HD1', 'Artista 8 - Ocho [Expert]', 1000008, 'HD'], ['Semana 1 y 2', 'TB', 'Artista 9 - Nueve [Expert]', 735021, 'TB']
  ];
  const xlinks = { C3: 'https://osu.ppy.sh/beatmapsets/9#osu/3493106', C4: 'https://osu.ppy.sh/beatmapsets/10', C5: 'https://example.com/otra' };
  const hidden = sheetXml([['pick', 'map id'], ['NM1', 9001], ['HD1', 9002], ['HR1', 9003]]);
  const onlyLinks = sheetXml([['Octavos'], ['pick', 'map'], ['NM1', 'Ver'], ['HD1', 'Ver'], ['HR1', 'Ver']], { B3: 'https://osu.ppy.sh/beatmapsets/9#osu/7001', B4: 'https://osu.ppy.sh/b/7002', B5: 'https://osu.ppy.sh/beatmaps/7003' });
  const main = sheetXml(mappools, xlinks);
  const sharedXml = () => `<sst>${strings.map((t) => `<si><t>${xmlEsc(t)}</t></si>`).join('')}</sst>`;
  const relsXml = (links) => `<Relationships>${Object.values(links).map((u, i) => `<Relationship Id="rId${i + 1}" Target="${xmlEsc(u)}" TargetMode="External"/>`).join('')}</Relationships>`;
  const xlsx = zip({
    'xl/workbook.xml': `<workbook ${RNS}><sheets><sheet name="Mappools" sheetId="1" r:id="rId1"/><sheet name="Vieja" sheetId="2" state="hidden" r:id="rId2"/><sheet name="Por enlaces" sheetId="3" r:id="rId3"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>',
    'xl/sharedStrings.xml': sharedXml(),
    'xl/worksheets/sheet1.xml': main, 'xl/worksheets/_rels/sheet1.xml.rels': relsXml(xlinks),
    'xl/worksheets/sheet2.xml': hidden,
    'xl/worksheets/sheet3.xml': onlyLinks, 'xl/worksheets/_rels/sheet3.xml.rels': relsXml({ B3: 'https://osu.ppy.sh/beatmapsets/9#osu/7001', B4: 'https://osu.ppy.sh/b/7002', B5: 'https://osu.ppy.sh/beatmaps/7003' })
  });
  r = await readFile(xlsx);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.groups.map((x) => [x.name, x.sheet, x.suggest, summary(x)]), [
    ['QL', 'Mappools', 'qualifiers', 'NM1=3493106 NM2=874858 HD1=1000003'],
    ['Q-EX', 'Mappools', null, 'NM1=5022222 HR1=1000005 DT1=1000006'],
    ['Semana 1 y 2', 'Mappools', null, 'NM1=3571342 HD1=1000008 TB=735021'],
    ['Octavos', 'Por enlaces', 'octavos', 'NM1=7001 HD1=7002 HR1=7003']
  ]);
  assert.equal(r.body.groups[0].maps[2].text, 'Artista 3 - Tres & Co <x> [Hard]', 'el texto de la fila, para comprobarlo con osu!');
  assert.deepEqual(r.body.groups[0].warnings, []);
  // La misma pool en una pestaña por ronda y en la lista general: se enseña una vez, con su ronda por el nombre de la pestaña
  strings.length = 0;
  const copy = sheetXml([['pick', 'map id'], ['NM1', 7101], ['HD1', 7102], ['TB', 7103]]);
  const copy2 = sheetXml([['Mi equipo'], ['id', 'mod'], [7101, 'NM1'], [7102, 'HD1'], [7103, 'TB']]);
  r = await readFile(zip({
    'xl/workbook.xml': `<workbook ${RNS}><sheets><sheet name="Lista" sheetId="1" r:id="rId1"/><sheet name="Cuartos" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/a.xml"/><Relationship Id="rId2" Target="worksheets/b.xml"/></Relationships>',
    'xl/sharedStrings.xml': sharedXml(), 'xl/worksheets/a.xml': copy, 'xl/worksheets/b.xml': copy2
  }));
  assert.deepEqual(r.body.groups.map((x) => [x.name, x.suggest, summary(x)]), [['Cuartos', 'cuartos', 'NM1=7101 HD1=7102 TB=7103']]);
  // OpenDocument (celdas repetidas, enlaces, números en atributos)
  const odc = (v) => (typeof v === 'number' ? `<table:table-cell office:value-type="float" office:value="${v}"><text:p>${v}</text:p></table:table-cell>` : `<table:table-cell office:value-type="string"><text:p>${v}</text:p></table:table-cell>`);
  r = await readFile(zip({ 'content.xml': `<office:document-content><office:body><office:spreadsheet><table:table table:name="Finals"><table:table-row><table:table-cell table:number-columns-repeated="1"/>${odc('pick')}${odc('map id')}</table:table-row>
    <table:table-row><table:table-cell/>${odc('NM1')}${odc(7201)}</table:table-row><table:table-row table:number-rows-repeated="3"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
    <table:table-row><table:table-cell/>${odc('HD1')}<table:table-cell office:value-type="string"><text:p><text:a xlink:href="https://osu.ppy.sh/b/7202">Ver</text:a></text:p></table:table-cell></table:table-row>
    <table:table-row><table:table-cell/>${odc('TB')}${odc(7203)}</table:table-row></table:table></office:spreadsheet></office:body></office:document-content>` }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.groups.map((x) => [x.name, x.suggest, summary(x)]), [['Finals', 'finals', 'NM1=7201 HD1=7202 TB=7203']]);
  // CSV de Excel en español: punto y coma y Latin-1, comas en los títulos
  r = await readFile(Buffer.from('pick;canción;map id\r\nNM1;Fulano, y Mengano - Canción [Difícil];7301\r\nHD1;"A; B - C [D]";7302\r\nTB;E - F [G];7303\r\n', 'latin1'));
  assert.equal(summary(r.body.groups[0]), 'NM1=7301 HD1=7302 TB=7303');
  assert.equal(r.body.groups[0].maps[0].text, 'Fulano, y Mengano - Canción [Difícil]');
  // UTF-8 con BOM y comas
  r = await readFile(Buffer.from('﻿pick,map id\nNM1,7311\nHD1,7312\nTB,7313\n'));
  assert.equal(summary(r.body.groups[0]), 'NM1=7311 HD1=7312 TB=7313');
  // Archivos que no sirven: mensaje claro, sin caerse
  for (const [buf, msg, what] of [
    [Buffer.alloc(0), /Elige un archivo|vacío/, 'vacío'],
    [Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(600)]), /Excel antiguo.*\.xlsx/, '.xls'],
    [Buffer.from('%PDF-1.7 hola'), /PDF o una imagen/, 'pdf'],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), /PDF o una imagen/, 'png'],
    [Buffer.from('MZ\0\0binario\0'), /no es una hoja/, 'binario'],
    [Buffer.from('PK\x03\x04roto y corto'), /parece dañado/, 'zip roto'],
    [xlsx.subarray(0, 400), /parece dañado/, 'xlsx cortado'],
    [zip({ 'hola.txt': 'hola' }), /no es una hoja/, 'zip cualquiera'],
    [zip({ 'xl/workbook.xml': 'x'.repeat(70 * 1024 * 1024) }), /demasiado grande/, 'bomba zip']
  ]) {
    r = await readFile(buf);
    assert.equal(r.status, 400, `${what}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, msg, what);
  }
  r = await readFile(Buffer.alloc(21 * 1024 * 1024));
  assert.equal(r.status, 413, 'más de 20 MB');
  assert.equal((await adm('/api/state')).status, 200, 'el servidor sigue en pie');
  console.log('✓ importación de mappools desde archivos y hojas');

  // Partido: warmup fuera, paginación de eventos y multiplicador de EZ
  r = await adm('/api/admin/match', { method: 'POST', json: { id: 'u1-1', time: Date.now(), ref: 'Gofio', mp: 'https://osu.ppy.sh/community/matches/555', bans: ['nm3', 'hd2'] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.warning, null);
  assert.deepEqual(r.body.result.wins, { 501: 4, 502: 2 });
  assert.equal(r.body.result.maps.length, 6);
  assert.equal(r.body.result.maps.find((m) => m.slot === 'FM1').w, 502);
  assert.equal(r.body.result.maps.find((m) => m.slot === 'FM1').scores[502], 1080000);
  assert.ok(calls.some((c) => c.includes('/matches/555?before=')), 'pide la página anterior de eventos');
  r = await adm('/api/state');
  assert.deepEqual(r.body.matches['u1-1'].bans, ['NM3', 'HD2']);
  r = await adm('/api/admin/match', { method: 'POST', json: { id: 'z9', mp: '1' } });
  assert.equal(r.status, 400);
  r = await adm('/api/admin/match', { method: 'POST', json: { id: 'u1-2', mp: '777' } });
  assert.match(r.body.warning, /!mp make\b/, 'avisa de que el lobby es privado');
  console.log('✓ resultados desde /matches (warmup ignorado, paginación, EZ ×1,8)');

  // Clasificatorios: mejor score por mapa (la repetición sustituye si es mejor)
  for (const [slot, bid] of [['NM1', 201], ['NM2', 202]]) {
    await adm('/api/admin/pool', { method: 'POST', json: { round: 'qualifiers', slot, beatmap: String(bid) } });
  }
  r = await adm('/api/admin/qual', { method: 'POST', json: { mp: '31337' } });
  assert.equal(r.status, 404);
  assert.match(r.body.error, /No existe el MP #31337/);
  r = await adm('/api/admin/qual', { method: 'POST', json: { mp: '900' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.players, 3);
  r = await adm('/api/state');
  assert.equal(r.body.qual.scores['4242']['202'], 850000);
  assert.equal(r.body.qual.lobbies[0].name, 'SPI: (Clasificatorios) Lobby A');
  console.log('✓ clasificatorios desde /matches');

  // Solo cuentan los mapas jugados en head to head
  r = await adm('/api/admin/qual', { method: 'POST', json: { mp: '902' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no se jugó en head to head/);
  assert.ok(!(await adm('/api/state')).body.qual.lobbies.some((l) => l.mp === 902), 'por equipos no se guarda');
  r = await adm('/api/admin/qual', { method: 'POST', json: { mp: '903' } });
  assert.equal(r.status, 200);
  assert.match(r.body.warning, /1 mapa no se jugó en head to head/);
  r = await adm('/api/state');
  assert.equal(r.body.qual.lobbies.find((l) => l.mp === 903).skipped, 1);
  assert.equal(r.body.qual.scores['502']['202'], 650000, 'no cuenta el mapa jugado por equipos');
  await adm('/api/admin/qual/delete', { method: 'POST', json: { mp: '903' } });
  console.log('✓ clasificatorios: solo head to head');

  // Resultados de clasificatorios: ocultos hasta la hora que fije la organización; los MP solo para admins y árbitros
  r = await anon('/api/state');
  assert.deepEqual([r.body.qual.scores, r.body.qual.lobbies, r.body.qual.results], [{}, [], null], 'sin fecha: el público no ve nada');
  assert.equal((await anon('/api/admin/qual-results', { method: 'POST', json: { now: true } })).status, 401);
  assert.equal((await adm('/api/admin/qual-results', { method: 'POST', json: { at: 'mañana' } })).status, 400);
  const qualAt = Date.now() + 3600e3;
  r = await adm('/api/admin/qual-results', { method: 'POST', json: { at: qualAt } });
  assert.deepEqual(r.body, { ok: true, at: qualAt });
  r = await anon('/api/state');
  assert.deepEqual([r.body.qual.scores, r.body.qual.results], [{}, qualAt], 'programados: todavía ocultos, con la fecha a la vista');
  assert.equal((await adm('/api/state')).body.qual.scores['4242']['202'], 850000, 'el host los sigue viendo');
  await adm('/api/admin/qual-results', { method: 'POST', json: { now: true } });
  r = await anon('/api/state');
  assert.equal(r.body.qual.scores['4242']['202'], 850000, 'publicados: el público ve las scores');
  assert.deepEqual(r.body.qual.lobbies, [], 'pero no los MP');
  await adm('/api/admin/qual-results', { method: 'POST', json: { hide: true } });
  assert.deepEqual((await anon('/api/state')).body.qual.scores, {}, 'ocultos otra vez');
  await adm('/api/admin/qual-results', { method: 'POST', json: { now: true } });
  console.log('✓ resultados de clasificatorios: publicación programada y MP privados');

  // Skills con TR de o!TR (JugadorA y Organizador lo tienen) y rendimiento por mod con clasificatorios y o!TR juntos.
  {
    let sk = null;
    for (let i = 0; i < 300 && !(sk = (await adm('/api/profile?id=501')).body).skills; i++) await new Promise((res) => setTimeout(res, 100));
    assert.equal(sk.skills.tr, true, 'con TR de o!TR como punto de partida');
    const nm = sk.mods.find((m) => m.mod === 'NM');
    assert.ok(nm.qual && nm.otr, 'NM: columna de clasificatorios y de o!TR');
    assert.deepEqual(nm.otr, { count: 40, average: 575000 });
  }

  // La práctica ya no existe
  assert.equal((await adm('/api/practice', { method: 'POST', json: { round: 'octavos', beatmap_id: 103 } })).status, 404);
  assert.equal((await adm('/api/state')).body.practice, undefined);
  r = await adm('/api/admin/pool/release', { method: 'POST', json: { round: 'octavos', now: true } });
  assert.equal(r.status, 200);
  assert.equal((await anon('/api/state')).body.pools.octavos.length, 6, 'publicada ya: el público la ve');

  // Lobbies a los que se apuntan los jugadores
  const inTwoYears = Date.now() + 730 * 24 * 3600e3;
  const pa = await login(BASE, 501), pb = await login(BASE, 502);
  r = await pa('/api/admin/qual-slot', { method: 'POST', json: { name: 'Lobby A', time: inTwoYears, size: 2 } });
  assert.equal(r.status, 403, 'crear lobbies es de la organización');
  for (const bad of [{ time: inTwoYears }, { name: 'x'.repeat(31), time: inTwoYears }, { name: 'L' }, { name: 'L', time: inTwoYears, size: 17 }, { name: 'L', time: inTwoYears, size: 0 }]) {
    assert.equal((await adm('/api/admin/qual-slot', { method: 'POST', json: bad })).status, 400, JSON.stringify(bad));
  }
  r = await adm('/api/admin/qual-slot', { method: 'POST', json: { name: ' Lobby   A ', time: inTwoYears, size: 2 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.warning, /fuera de las fechas/);
  await adm('/api/admin/qual-slot', { method: 'POST', json: { name: 'Lobby B', time: inTwoYears + 3600e3, size: 16 } });
  await adm('/api/admin/qual-slot', { method: 'POST', json: { name: 'Lobby viejo', time: Date.now() - 3600e3, size: 16 } });
  const slots = async () => (await anon('/api/state')).body.qual.slots;
  const [sa, sb, sv] = (await slots()).sort((x, y) => x.id - y.id);
  assert.deepEqual([sa.name, sa.size, sa.players], ['Lobby A', 2, []]);
  const signUp = (who, slot) => who('/api/qual/signup', { method: 'POST', json: { slot } });
  assert.equal((await signUp(strong, sa.id)).status, 403, 'solo inscritos');
  assert.match((await signUp(strong, sa.id)).body.error, /formulario/);
  assert.equal((await signUp(pa, 999999)).status, 404);
  assert.equal((await signUp(pa, 'abc')).status, 404);
  assert.equal((await signUp(pa, sv.id)).status, 409, 'ya ha empezado');
  assert.equal((await signUp(pa, sa.id)).status, 200);
  assert.equal((await signUp(pa, sa.id)).status, 200, 'apuntarse dos veces no duplica');
  assert.equal((await signUp(pb, sa.id)).status, 200);
  r = await signUp(adm, sa.id);
  assert.equal(r.status, 409, 'lleno');
  assert.match(r.body.error, /lleno/);
  assert.deepEqual((await slots()).find((x) => x.id === sa.id).players, [501, 502]);
  assert.equal((await signUp(pa, sb.id)).status, 200, 'cambiarse de lobby');
  let list = await slots();
  assert.deepEqual([list.find((x) => x.id === sa.id).players, list.find((x) => x.id === sb.id).players], [[502], [501]], 'solo en un lobby');
  assert.equal((await pb('/api/qual/leave', { method: 'POST', json: {} })).status, 200);
  assert.deepEqual((await slots()).find((x) => x.id === sa.id).players, []);
  // Editar: no se puede dejar con menos plazas que apuntados
  assert.equal((await adm('/api/admin/qual-slot', { method: 'POST', json: { id: sb.id, name: 'Lobby B', time: inTwoYears, size: 1 } })).status, 200);
  assert.equal((await adm('/api/admin/qual-slot', { method: 'POST', json: { id: 999999, name: 'x', time: inTwoYears } })).status, 404);
  await signUp(pb, sa.id);
  await signUp(adm, sa.id);
  r = await adm('/api/admin/qual-slot', { method: 'POST', json: { id: sa.id, name: 'Lobby A', time: inTwoYears, size: 1 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /ya tiene 2 jugadores/);
  // La organización coloca a un jugador aunque el lobby haya empezado; después él ya no se puede mover
  assert.equal((await pa('/api/admin/qual-slot/assign', { method: 'POST', json: { id: sv.id, user: 501 } })).status, 403);
  assert.equal((await adm('/api/admin/qual-slot/assign', { method: 'POST', json: { id: sv.id, user: 77 } })).status, 400, 'no inscrito');
  assert.equal((await adm('/api/admin/qual-slot/assign', { method: 'POST', json: { id: sa.id, user: 501 } })).status, 409, 'plazas');
  assert.equal((await adm('/api/admin/qual-slot/assign', { method: 'POST', json: { id: sv.id, user: 501 } })).status, 200);
  assert.deepEqual((await slots()).find((x) => x.id === sv.id).players, [501]);
  assert.equal((await signUp(pa, sb.id)).status, 409, 'su lobby ya ha empezado');
  assert.equal((await pa('/api/qual/leave', { method: 'POST', json: {} })).status, 409);
  assert.equal((await adm('/api/admin/qual-slot/remove', { method: 'POST', json: { user: 501 } })).status, 200);
  assert.deepEqual((await slots()).find((x) => x.id === sv.id).players, []);
  // Quitar un jugador o un lobby libera las plazas
  await adm('/api/admin/player/delete', { method: 'POST', json: { id: 502 } });
  assert.deepEqual((await slots()).find((x) => x.id === sa.id).players, [4242], 'quien sale del torneo sale del lobby');
  for (const x of [sa, sb, sv]) assert.equal((await adm('/api/admin/qual-slot/delete', { method: 'POST', json: { id: x.id } })).status, 200);
  assert.deepEqual(await slots(), []);
  assert.equal((await signUp(adm, sa.id)).status, 404);
  console.log('✓ lobbies de clasificatorios: crear y apuntarse');

  // La rejilla: cada día una letra, cada hora un número; volver a generarla no duplica
  const gen = (json, who = adm) => who('/api/admin/qual-slot/generate', { method: 'POST', json });
  assert.equal((await gen({ days: ['2026-11-09'], times: ['15:00'] }, pa)).status, 403);
  for (const bad of [{ times: ['15:00'] }, { days: ['ayer'], times: ['15:00'] }, { days: ['2026-11-09'] }, { days: ['2026-11-09'], times: ['25:00'] },
    { days: ['2026-11-09'], times: ['15:00'], size: 17 }, { days: Array.from({ length: 27 }, (_, i) => `2031-01-${String(i + 1).padStart(2, '0')}`), times: ['15:00'] }]) {
    assert.equal((await gen(bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  }
  r = await gen({ days: ['2031-01-11', '2031-01-10'], times: ['16:00', '15:00', '23:59'], size: 8 });
  assert.deepEqual([r.body.created, r.body.skipped], [6, 0], JSON.stringify(r.body));
  list = await slots();
  assert.deepEqual(list.map((x) => x.name), ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
  assert.equal(list[0].time, Date.parse('2031-01-10T14:00:00Z'), 'hora de Madrid');
  assert.equal(list[2].time, Date.parse('2031-01-10T22:59:00Z'));
  assert.ok(list.every((x) => x.size === 8 && x.ref_id === null));
  r = await gen({ days: ['2031-01-10', '2031-01-12'], times: ['15:00', '18:00'] });
  assert.deepEqual([r.body.created, r.body.skipped], [3, 1], 'lo que ya existe a esa hora se deja');
  list = await slots();
  assert.deepEqual(list.map((x) => x.name).sort(), ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'C1', 'C2'], 'mismo día, misma letra; día nuevo, letra nueva');
  for (const d of ['2031-13-45', '2031-02-30']) assert.equal((await gen({ days: [d], times: ['15:00'] })).status, 400, `fecha imposible ${d}`);
  // Árbitro por lobby: se lo pide un árbitro, o lo asigna la organización
  const a1 = list.find((x) => x.name === 'A1'), a2 = list.find((x) => x.name === 'A2');
  const claim = (who, id, on = true) => who('/api/ref/qual-claim', { method: 'POST', json: { id, on } });
  const pr = await login(BASE, 503), prB = await login(BASE, 501);
  assert.equal((await claim(pr, a1.id)).status, 403, 'solo árbitros');
  assert.equal((await pr('/api/admin/qual-slot/ref', { method: 'POST', json: { id: a1.id, ref: 4242 } })).status, 403, 'asignar es de la organización');
  assert.equal((await adm('/api/admin/qual-slot/ref', { method: 'POST', json: { id: a1.id, ref: 503 } })).status, 400, 'no es árbitro');
  await adm('/api/admin/role', { method: 'POST', json: { user: '503', role: 'referee' } });
  await adm('/api/admin/role', { method: 'POST', json: { user: '501', role: 'referee' } });
  assert.equal((await claim(pr, a1.id)).status, 200);
  list = await slots();
  assert.deepEqual([list.find((x) => x.id === a1.id).ref_id, list.find((x) => x.id === a1.id).ref_name], [503, 'Jugador C'], 'el árbitro se ve en público');
  assert.equal((await claim(prB, a1.id)).status, 409, 'ya tiene árbitro');
  assert.equal((await claim(prB, a1.id, false)).status, 403, 'no puede dejar el de otro');
  assert.equal((await claim(pr, a1.id, false)).status, 200);
  assert.equal((await slots()).find((x) => x.id === a1.id).ref_id, null);
  // Quien juega un lobby no lo arbitra, y al revés
  assert.equal((await signUp(prB, a1.id)).status, 200);
  assert.match((await claim(prB, a1.id)).body.error, /en el que juegas/);
  assert.match((await adm('/api/admin/qual-slot/ref', { method: 'POST', json: { id: a1.id, ref: 501 } })).body.error, /juega en este lobby/);
  assert.equal((await claim(prB, a2.id)).status, 200, 'otro lobby sí');
  assert.match((await signUp(prB, a2.id)).body.error, /Arbitras ese lobby/);
  assert.equal((await adm('/api/admin/qual-slot/assign', { method: 'POST', json: { id: a2.id, user: 501 } })).status, 409);
  assert.equal((await adm('/api/admin/qual-slot/ref', { method: 'POST', json: { id: a2.id, ref: 503 } })).status, 200, 'la organización puede cambiarlo');
  assert.equal((await slots()).find((x) => x.id === a2.id).ref_id, 503);
  await adm('/api/admin/qual-slot/ref', { method: 'POST', json: { id: a2.id, ref: null } });
  await adm('/api/admin/qual-slot/ref', { method: 'POST', json: { id: list.find((x) => x.name === 'B1').id, ref: 503 } });
  // Sin rol de árbitro, deja sus lobbies
  await adm('/api/admin/role', { method: 'POST', json: { id: 503, role: '' } });
  assert.equal((await slots()).find((x) => x.name === 'B1').ref_id, null);
  await adm('/api/admin/role', { method: 'POST', json: { id: 501, role: '' } });
  // Quitar los vacíos de un día deja los que tienen jugadores
  r = await adm('/api/admin/qual-slot/delete-empty', { method: 'POST', json: { day: '2031-01-10' } });
  assert.equal(r.body.removed, 3);
  assert.deepEqual((await slots()).filter((x) => x.name.startsWith('A')).map((x) => x.name), ['A1']);
  assert.equal((await pa('/api/admin/qual-slot/delete-empty', { method: 'POST', json: { day: '2031-01-11' } })).status, 403);
  await adm('/api/admin/qual-slot/remove', { method: 'POST', json: { user: 501 } });
  for (const x of await slots()) await adm('/api/admin/qual-slot/delete', { method: 'POST', json: { id: x.id } });
  // Lo que ya ha pasado no se crea, y si no queda nada, se avisa
  r = await gen({ days: ['2020-01-01'], times: ['15:00', '16:00'] });
  assert.deepEqual([r.body.created, r.body.past], [0, 2]);
  assert.match(r.body.warning, /ya han pasado/);
  assert.deepEqual(await slots(), []);
  // El último día no sale el lobby que empezaría al fijarse las seeds
  r = (await adm('/api/state')).body.config.fases.find((f) => f.key === 'qualifiers').fin;
  // Usa el último día real de la fase: pasadas sus 23:00 (hora de Madrid) ya no se puede comprobar.
  if (Date.now() < Date.parse(r + 'T23:00:00+01:00')) {
    const lastDay = await gen({ days: [r], times: ['23:00', '23:59'] });
    assert.deepEqual([lastDay.body.created, lastDay.body.late], [1, 1], JSON.stringify(lastDay.body));
  }
  for (const x of await slots()) await adm('/api/admin/qual-slot/delete', { method: 'POST', json: { id: x.id } });
  console.log('✓ lobbies de clasificatorios: rejilla y árbitros');

  // Lobby extraordinario: lo pide el jugador y lo responde un árbitro o admin
  const qFase = (await adm('/api/state')).body.config.fases.find((f) => f.key === 'qualifiers');
  const inFase = Date.parse(`${qFase.fin}T12:00:00Z`);
  const ask = (who, json) => who('/api/qual/request', { method: 'POST', json });
  const pd = await login(BASE, 504);
  const answer = (who, what, json) => who(`/api/ref/qual-request/${what}`, { method: 'POST', json });
  assert.equal((await ask(anon, { time: inFase })).status, 401);
  assert.equal((await ask(strong, { time: inFase })).status, 403, 'solo inscritos');
  for (const bad of [{}, { time: 'x' }, { time: Date.now() - 1000 }, { time: Date.parse('2031-01-01T12:00:00Z') }, { time: Date.parse(`${qFase.fin}T22:50:00Z`) }]) {
    assert.equal((await ask(pa, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await ask(pa, { time: inFase, note: '  trabajo   por <la> tarde ' })).status, 200);
  assert.deepEqual((await ask(pa, { time: inFase + 3600e3 })).status, 200, 'cambiar la hora no duplica');
  await ask(pa, { time: inFase, note: 'trabajo por <la> tarde' });
  r = (await pa('/api/state')).body;
  assert.deepEqual([r.me.qualRequest.status, r.me.qualRequest.time, r.me.qualRequest.note], ['pending', inFase, 'trabajo por <la> tarde']);
  assert.equal(r.qualRequests, undefined, 'un jugador no ve las solicitudes de los demás');
  assert.equal((await pd('/api/state')).body.qualRequests, undefined);
  assert.equal((await anon('/api/state')).body.qualRequests, undefined);
  assert.equal((await answer(pd, 'accept', { user: 501 })).status, 403, 'responden árbitros y admins');
  assert.equal((await answer(pd, 'reject', { user: 501 })).status, 403);
  r = (await adm('/api/state')).body.qualRequests;
  assert.deepEqual(r.map((x) => [x.user_id, x.username, x.time, x.lobby]), [[501, 'JugadorA', inFase, null]]);
  // Un árbitro no responde a la suya, y rechazar deja verlo
  await adm('/api/admin/role', { method: 'POST', json: { user: '501', role: 'referee' } });
  assert.equal((await answer(pa, 'accept', { user: 501 })).status, 403, 'la suya no');
  assert.equal((await answer(pa, 'reject', { user: 501 })).status, 403);
  await adm('/api/admin/role', { method: 'POST', json: { id: 501, role: '' } });
  assert.equal((await answer(adm, 'reject', { user: 501, reason: 'esa hora no hay nadie' })).status, 200);
  r = (await pa('/api/state')).body.me.qualRequest;
  assert.deepEqual([r.status, r.reason], ['rejected', 'esa hora no hay nadie']);
  assert.equal((await adm('/api/state')).body.qualRequests.length, 0);
  assert.equal((await answer(adm, 'accept', { user: 501 })).status, 404, 'ya no está pendiente');
  // Aceptar con otra hora: crea X1 de una plaza con el jugador, que deja su lobby anterior
  const prev = (await adm('/api/admin/qual-slot', { method: 'POST', json: { name: 'A1', time: inFase - 7200e3, size: 8 } }), await slots()).find((x) => x.name === 'A1');
  assert.equal((await signUp(pa, prev.id)).status, 200);
  await ask(pa, { time: inFase });
  assert.equal((await adm('/api/state')).body.qualRequests[0].lobby, 'A1');
  assert.equal((await answer(adm, 'accept', { user: 501, time: Date.now() - 1000 })).status, 400, 'la hora también se comprueba al aceptar');
  r = await answer(adm, 'accept', { user: 501, time: inFase + 1800e3, referee: true });
  assert.deepEqual([r.status, r.body.name], [200, 'X1'], JSON.stringify(r.body));
  list = await slots();
  const x1 = list.find((x) => x.name === 'X1');
  assert.deepEqual([x1.time, x1.size, x1.players, x1.ref_id], [inFase + 1800e3, 1, [501], 4242]);
  assert.deepEqual(list.find((x) => x.id === prev.id).players, [], 'solo está en un lobby');
  assert.equal((await pa('/api/state')).body.me.qualRequest, null);
  r = await signUp(pd, x1.id);
  assert.match(String(r.body.error), /lleno/, `nadie más entra: ${r.status} ${JSON.stringify(r.body)}`);
  // El siguiente es X2, y la rejilla no cuenta los extraordinarios ni les quita su hora
  await ask(pd, { time: inFase });
  assert.equal((await answer(adm, 'accept', { user: 504 })).body.name, 'X2');
  r = await gen({ days: [qFase.fin], times: ['12:00', '13:00'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  list = await slots();
  assert.ok(list.some((x) => x.name === 'A2') && !list.some((x) => /^X[3-9]/.test(x.name)), JSON.stringify(list.map((x) => x.name)));
  // Quien ya jugó no pide otro
  await adm('/api/admin/qual-slot', { method: 'POST', json: { name: 'Pasado', time: Date.now() - 3600e3, size: 8 } });
  const past = (await slots()).find((x) => x.name === 'Pasado');
  await adm('/api/admin/qual-slot/assign', { method: 'POST', json: { id: past.id, user: 501 } });
  assert.match((await ask(pa, { time: inFase })).body.error, /solo se juega una vez/);
  // Cancelar borra la solicitud
  await adm('/api/admin/qual-slot/remove', { method: 'POST', json: { user: 501 } });
  await ask(pa, { time: inFase });
  assert.equal((await pa('/api/qual/request/cancel', { method: 'POST', json: {} })).status, 200);
  assert.equal((await pa('/api/state')).body.me.qualRequest, null);
  await adm('/api/admin/qual-slot/remove', { method: 'POST', json: { user: 504 } });
  for (const x of await slots()) await adm('/api/admin/qual-slot/delete', { method: 'POST', json: { id: x.id } });
  console.log('✓ lobbies extraordinarios: solicitar, aceptar y rechazar');

  // Plazas: el jugador se apunta y queda pendiente hasta que la aprueba un árbitro o admin
  await adm('/api/admin/qual-slot', { method: 'POST', json: { name: 'A1', time: inFase, size: 2 } });
  await adm('/api/admin/qual-slot', { method: 'POST', json: { name: 'A2', time: inFase + 3600e3, size: 2 } });
  let seatsL = await slots();
  const seatA = seatsL.find((x) => x.name === 'A1'), seatB = seatsL.find((x) => x.name === 'A2');
  const seat = (who, what, json) => who(`/api/ref/qual-signup/${what}`, { method: 'POST', json });
  const inS = async (id) => { const x = (await slots()).find((y) => y.id === id); return [x.players, x.pending]; };
  assert.equal((await signUp(pa, seatA.id)).status, 200);
  assert.deepEqual(await inS(seatA.id), [[501], [501]], 'pendiente');
  assert.equal((await seat(anon, 'approve', { user: 501 })).status, 401);
  assert.equal((await seat(pd, 'approve', { user: 501 })).status, 403, 'un jugador no aprueba');
  assert.equal((await seat(pd, 'reject', { user: 501 })).status, 403);
  // Un árbitro no aprueba su propia plaza; a otra sí
  await adm('/api/admin/role', { method: 'POST', json: { user: '504', role: 'referee' } });
  assert.equal((await signUp(pd, seatB.id)).status, 200);
  assert.equal((await seat(pd, 'approve', { user: 504 })).status, 403, 'la suya no');
  assert.equal((await seat(pd, 'approve', { user: 501 })).status, 200, 'un árbitro aprueba');
  assert.deepEqual(await inS(seatA.id), [[501], []]);
  assert.equal((await seat(pd, 'approve', { user: 501 })).status, 404, 'ya no está pendiente');
  assert.equal((await seat(pd, 'reject', { user: 501 })).status, 404);
  await adm('/api/admin/role', { method: 'POST', json: { id: 504, role: '' } });
  // Cambiarse de lobby vuelve a pedir aprobación
  assert.equal((await signUp(pa, seatA.id)).status, 200);
  assert.deepEqual(await inS(seatA.id), [[501], []], 'apuntarse otra vez al mismo no le quita la aprobación');
  assert.equal((await signUp(pa, seatB.id)).status, 200);
  assert.deepEqual(await inS(seatB.id), [[504, 501], [504, 501]]);
  r = await signUp(adm, seatB.id);
  assert.match(String(r.body.error), /lleno/, 'las pendientes ocupan plaza');
  // Rechazar libera la plaza y el jugador ve el motivo; apuntarse de nuevo borra el aviso
  assert.equal((await seat(adm, 'reject', { user: 501, reason: 'no hay  árbitro' })).status, 200);
  assert.deepEqual(await inS(seatB.id), [[504], [504]]);
  r = (await pa('/api/state')).body.me.qualRejection;
  assert.deepEqual([r.lobby, r.time, r.reason], ['A2', seatB.time, 'no hay árbitro']);
  assert.equal((await pd('/api/state')).body.me.qualRejection, null);
  assert.equal((await signUp(pa, seatA.id)).status, 200);
  assert.equal((await pa('/api/state')).body.me.qualRejection, null);
  assert.equal((await pa('/api/qual/leave', { method: 'POST', json: {} })).status, 200, 'puede salir estando pendiente');
  // Lo que pone la organización ya está aprobado
  await adm('/api/admin/qual-slot/assign', { method: 'POST', json: { id: seatA.id, user: 501 } });
  assert.deepEqual(await inS(seatA.id), [[501], []]);
  // Si el lobby empieza sin aprobarla, no ha jugado: se puede apuntar a otro, y ya no se aprueba
  await adm('/api/admin/qual-slot/remove', { method: 'POST', json: { user: 501 } });
  assert.equal((await signUp(pa, seatA.id)).status, 200);
  await adm('/api/admin/qual-slot', { method: 'POST', json: { id: seatA.id, name: 'A1', time: Date.now() - 60e3, size: 2 } });
  assert.equal((await seat(adm, 'approve', { user: 501 })).status, 409, 'ya ha empezado');
  assert.equal((await pa('/api/qual/request', { method: 'POST', json: { time: inFase } })).status, 200, 'puede pedir un extraordinario');
  assert.equal((await pa('/api/qual/request/cancel', { method: 'POST', json: {} })).status, 200);
  assert.equal((await pa('/api/qual/leave', { method: 'POST', json: {} })).status, 200);
  assert.equal((await signUp(pa, seatB.id)).status, 200, 'y apuntarse a otro');
  await adm('/api/admin/qual-slot/remove', { method: 'POST', json: { user: 501 } });
  await adm('/api/admin/qual-slot/remove', { method: 'POST', json: { user: 504 } });
  for (const x of await slots()) await adm('/api/admin/qual-slot/delete', { method: 'POST', json: { id: x.id } });
  console.log('✓ plazas de los lobbies: aprobar y rechazar');

  // Normas de Info y anuncio de Inicio: los escriben los admins y los ve todo el mundo
  const siteText = (who, key, text) => who('/api/admin/site-text', { method: 'POST', json: { key, text } });
  r = (await anon('/api/state')).body;
  assert.deepEqual([r.normas, r.anuncio], [null, null]);
  assert.equal((await siteText(anon, 'anuncio', 'hola')).status, 401);
  assert.equal((await siteText(pa, 'anuncio', 'hola')).status, 403, 'un jugador no');
  await adm('/api/admin/role', { method: 'POST', json: { user: '501', role: 'referee' } });
  assert.equal((await siteText(pa, 'normas', 'hola')).status, 403, 'un árbitro no');
  await adm('/api/admin/role', { method: 'POST', json: { user: '501', role: 'admin' } });
  assert.equal((await siteText(pa, 'normas', '## Uno\r\n- <b>dos</b>  ')).status, 200, 'un admin sí');
  await adm('/api/admin/role', { method: 'POST', json: { id: 501, role: '' } });
  assert.equal((await siteText(adm, 'anuncio', 'Lobbies abiertos')).status, 200);
  r = (await anon('/api/state')).body;
  assert.deepEqual([r.normas.text, r.anuncio.text], ['## Uno\n- <b>dos</b>', 'Lobbies abiertos'], 'se guarda tal cual: se escapa al mostrarlo');
  assert.equal((await siteText(adm, 'otra', 'x')).status, 400);
  assert.equal((await siteText(adm, 'anuncio', 'x'.repeat(501))).status, 400);
  assert.equal((await siteText(adm, 'normas', 'x'.repeat(20001))).status, 400);
  assert.equal((await anon('/api/state')).body.anuncio.text, 'Lobbies abiertos', 'lo rechazado no cambia nada');
  for (const key of ['normas', 'anuncio']) assert.equal((await siteText(adm, key, '   ')).status, 200);
  r = (await anon('/api/state')).body;
  assert.deepEqual([r.normas, r.anuncio], [null, null], 'sin texto se quita');
  console.log('✓ normas y anuncio de novedades');

  // Más textos: los de Inicio e Info, y los que van a la configuración (nombre, comunidad, enlaces)
  const cfg = async () => (await anon('/api/state')).body;
  const base = await cfg();
  assert.deepEqual(base.textos, {});
  assert.equal(base.fasesEditadas, false);
  assert.equal((await siteText(pa, 'lead', 'x')).status, 403);
  assert.equal((await siteText(adm, 'fases', '{}')).status, 400, 'las rondas no van por aquí');
  assert.equal((await siteText(adm, '__proto__', 'x')).status, 400);
  assert.equal((await siteText(adm, 'lead', 'Hola')).status, 200);
  assert.equal((await siteText(adm, 'nombre', '  Otro:   torneo ')).status, 200);
  assert.equal((await siteText(adm, 'comunidad', 'Spi6')).status, 200);
  for (const bad of ['Enlace | javascript:alert(1)', 'sin separador', 'Malo | ftp://x', Array(11).fill('a | https://a.es').join('\n')]) {
    assert.equal((await siteText(adm, 'enlaces', bad)).status, 400, bad.slice(0, 40));
  }
  assert.equal((await siteText(adm, 'enlaces', 'Directo | https://example.com/abc\nOculto |')).status, 200);
  r = await cfg();
  assert.deepEqual([r.textos.lead.text, r.config.nombre, r.config.comunidad], ['Hola', 'Otro: torneo', 'Spi6']);
  assert.deepEqual(r.config.enlaces, [['Directo', 'https://example.com/abc'], ['Oculto', '']]);
  for (const k of ['lead', 'nombre', 'comunidad', 'enlaces']) assert.equal((await siteText(adm, k, '')).status, 200);
  r = await cfg();
  assert.deepEqual([r.textos, r.config.nombre, r.config.comunidad, r.config.enlaces], [{}, base.config.nombre, base.config.comunidad, base.config.enlaces], 'vuelve el original');
  // Rondas: mueven el torneo de verdad
  const fasesOf = (st) => st.config.fases.map(({ key, nombre, showcase, inicio, fin, sr, bo }) => ({ key, nombre, showcase, inicio, fin, sr, bo }));
  const saveF = (who, fases) => who('/api/admin/fases', { method: 'POST', json: { fases } });
  const change = (key, patch) => fasesOf(base).map((f) => (f.key === key ? { ...f, ...patch } : f));
  assert.equal((await saveF(anon, fasesOf(base))).status, 401);
  assert.equal((await saveF(pa, fasesOf(base))).status, 403);
  assert.equal((await pa('/api/admin/fases', { method: 'POST', json: { reset: true } })).status, 403);
  for (const [bad, why] of [
    [fasesOf(base).slice(1), /Falta/], [change('octavos', { nombre: ' ' }), /nombre/], [change('octavos', { inicio: '2026-13-01' }), /fechas/],
    [change('octavos', { fin: '2026-11-17', inicio: '2026-11-18' }), /antes de empezar/], [change('cuartos', { inicio: '2026-11-20' }), /después de que acabe/],
    [change('octavos', { showcase: '2026-11-18' }), /showcase/], [change('octavos', { sr: 0 }), /SR/], [change('octavos', { bo: 8 }), /impar/], [change('octavos', { bo: 27 }), /impar/]
  ]) {
    r = await saveF(adm, bad);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, why);
  }
  assert.deepEqual(fasesOf(await cfg()), fasesOf(base), 'lo rechazado no cambia nada');
  await adm('/api/admin/qual-slot', { method: 'POST', json: { name: 'Fuera', time: Date.parse(`${qFase.fin}T12:00:00Z`), size: 8 } });
  const shorter = '2026-11-14';
  r = await saveF(adm, change('qualifiers', { nombre: 'Qualis', fin: shorter, sr: 5.5 }).map((f) => (f.key === 'octavos' ? { ...f, bo: 7 } : f)));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.warning, /un lobby queda fuera/);
  r = await cfg();
  const q2 = r.config.fases.find((f) => f.key === 'qualifiers');
  assert.deepEqual([q2.nombre, q2.fin, q2.sr, r.config.fases.find((f) => f.key === 'octavos').bo, r.fasesEditadas], ['Qualis', shorter, 5.5, 7, true]);
  // El servidor usa las fechas nuevas: el último lobby posible se mueve con la fase
  r = await gen({ days: [shorter], times: ['23:59'] });
  assert.deepEqual([r.body.created, r.body.late], [0, 1], JSON.stringify(r.body));
  assert.equal((await pa('/api/qual/request', { method: 'POST', json: { time: inFase } })).status, 400, 'fuera de las fechas nuevas');
  assert.equal((await adm('/api/admin/fases', { method: 'POST', json: { reset: true } })).status, 200);
  r = await cfg();
  assert.deepEqual([fasesOf(r), r.fasesEditadas], [fasesOf(base), false], 'vuelven los datos originales');
  for (const x of await slots()) await adm('/api/admin/qual-slot/delete', { method: 'POST', json: { id: x.id } });
  console.log('✓ textos de la web y rondas editables');

  // Roles: los asigna el host (ADMIN_IDS) y se aplican al momento
  const pc = await login(BASE, 503);
  const role = (who, json) => who('/api/admin/role', { method: 'POST', json });
  assert.ok((await anon('/api/state')).body.team.some((x) => x.id === 4242 && x.role === 'host'), 'el host sale en el equipo');
  assert.equal((await adm('/api/state')).body.me.host, true);
  assert.equal((await role(anon, { user: 'JugadorA', role: 'admin' })).status, 401);
  assert.equal((await role(pc, { user: '503', role: 'admin' })).status, 403, 'nadie se da permisos a sí mismo');
  assert.equal((await role(adm, { user: '503', role: 'dios' })).status, 400);
  assert.equal((await role(adm, { user: 'NadieConEseNombre', role: 'staff' })).status, 404);
  assert.equal((await role(adm, { role: 'staff' })).status, 400);
  r = await role(adm, { user: 'Jugador C', role: 'staff' });
  assert.deepEqual(r.body, { ok: true, username: 'Jugador C', role: 'staff' }, JSON.stringify(r.body));
  r = await pc('/api/state');
  assert.deepEqual([r.body.me.admin, r.body.me.referee, r.body.me.host], [false, false, false], 'staff: sin panel ni arbitraje');
  // Staff ve las mappools antes de publicarse; un árbitro, un jugador o alguien sin sesión, no
  assert.equal((await adm('/api/admin/pool/release', { method: 'POST', json: { round: 'octavos', at: Date.now() + 3600e3 } })).status, 200);
  const hiddenPool = async (who) => (await who('/api/state')).body.pools.octavos?.length;
  assert.equal(await hiddenPool(pc), 6, 'staff ve la pool oculta');
  assert.equal(await hiddenPool(anon), undefined);
  assert.equal(await hiddenPool(pa), undefined);
  assert.equal((await pc('/api/admin/pool/release', { method: 'POST', json: { round: 'octavos', now: true } })).status, 403, 'staff no publica');
  assert.ok(r.body.team.some((x) => x.id === 503 && x.role === 'staff'), 'staff: sale en el equipo');
  assert.equal((await pc('/api/ref/events')).status, 403);
  await adm('/api/admin/qual-results', { method: 'POST', json: { hide: true } });
  r = await pc('/api/state');
  assert.deepEqual([r.body.qual.scores, r.body.qual.lobbies], [{}, []], 'staff: ni resultados ocultos ni MP');
  assert.equal((await pc('/api/admin/qual-results', { method: 'POST', json: { now: true } })).status, 403, 'staff no publica los resultados');
  await role(adm, { id: 503, role: 'referee' });
  r = await pc('/api/state');
  assert.deepEqual([r.body.me.admin, r.body.me.referee], [false, true], 'árbitro');
  assert.ok(Object.keys(r.body.qual.scores).length && r.body.qual.lobbies.length, 'el árbitro ve resultados ocultos y MP');
  assert.equal(await hiddenPool(pc), undefined, 'el árbitro no ve la pool oculta');
  assert.equal((await pc('/api/admin/qual-slot', { method: 'POST', json: { name: 'x', time: inTwoYears } })).status, 403, 'el árbitro no entra en el panel');
  const hiddenRound = (await adm('/api/state')).body.pools.qualifiers?.length;
  await role(adm, { id: 503, role: 'admin' });
  r = await pc('/api/state');
  assert.deepEqual([r.body.me.admin, r.body.me.referee, r.body.me.host], [true, true, false], 'admin');
  assert.equal(r.body.pools.qualifiers?.length, hiddenRound, 'admin: ve lo mismo que la organización');
  assert.ok(Array.isArray(r.body.exceptions), 'admin: datos del panel');
  assert.equal((await role(pc, { user: 'JugadorA', role: 'staff' })).status, 403, 'un admin no cambia roles');
  assert.equal((await pc('/api/admin/qual-results', { method: 'POST', json: { hide: true } })).status, 200, 'un admin también cambia la publicación de los resultados');
  assert.equal((await pc('/api/admin/qual-results', { method: 'POST', json: { now: true } })).status, 200);
  assert.equal((await role(adm, { user: '4242', role: 'staff' })).status, 400, 'al host no se le cambia desde la web');
  assert.equal((await role(adm, { id: 4242, role: '' })).status, 404);
  assert.equal((await role(adm, { id: 999, role: '' })).status, 404);
  assert.equal((await role(adm, { id: 'abc', role: '' })).status, 404);
  assert.equal((await role(adm, { id: 503, role: '' })).status, 200);
  r = await pc('/api/state');
  assert.deepEqual([r.body.me.admin, r.body.me.referee], [false, false], 'sin rol, sin permisos al momento');
  assert.equal(await hiddenPool(pc), undefined, 'sin rol tampoco ve la pool oculta');
  assert.equal((await adm('/api/admin/pool/release', { method: 'POST', json: { round: 'octavos', now: true } })).status, 200);
  assert.ok(!r.body.team.some((x) => x.id === 503));
  console.log('✓ roles: host, admin, árbitro y staff');

  r = await adm('/auth/logout', { method: 'POST', json: {} });
  assert.equal(r.status, 200);
  r = await adm('/api/state');
  assert.equal(r.body.me, null);
  console.log('✓ cerrar sesión');

  // Segunda parte: servidor con el reloj el 17 de noviembre a las 18:00 (octavos), 16 inscritos y clasificatorios hechos.
  // El servidor calcula las seeds y los cruces para mencionar a quien juega cada partido.
  const t0 = '2026-11-17T17:00:00Z';
  twitchLive = { id: '42', user_login: 'spi6_osu', user_name: 'spi6_osu', game_name: 'osu!', type: 'live', title: 'SpiSix Fall Cup · Octavos',
    viewer_count: 87, started_at: '2026-11-17T16:30:00Z', thumbnail_url: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_spi6_osu-{width}x{height}.jpg' };
  const s2 = startServer('octavos', t0);
  srv2 = s2.proc;
  await ready(s2.base);
  const anon2 = client(s2.base);
  let tw = null;
  await until(async () => (tw = (await anon2('/api/state')).body.twitch).live, 'directo en el estado');
  assert.deepEqual(tw, { channel: 'spi6_osu', live: { id: '42', title: 'SpiSix Fall Cup · Octavos', game: 'osu!', viewers: 87,
    started_at: Date.parse('2026-11-17T16:30:00Z'), thumbnail: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_spi6_osu-640x360.jpg' } });
  assert.ok(!JSON.stringify((await anon2('/api/state')).body).includes('tw-secreto'));
  console.log('✓ directo de Twitch (Helix, token de aplicación)');
  const adm2 = await login(s2.base, 4242);
  const names16 = Array.from({ length: 16 }, (_, i) => USERS[601 + i].username);
  r = await adm2('/api/admin/import', { method: 'POST', json: { text: 'osu name\tdiscord\tdisponibilidad\n' + names16.map((n) => `${n}\t${n.toLowerCase()}\ttardes`).join('\n') } });
  assert.equal(r.body.imported.length, 16, JSON.stringify(r.body));
  // Sin OTR_API_KEY no se pide nada a o!TR y la ficha funciona igual.
  r = await anon2('/api/profile?id=601');
  assert.equal(r.status, 200);
  assert.equal(r.body.otr, null, 'sin clave de o!TR, la ficha va sin o!TR');
  for (const [round, slot, bid] of [['qualifiers', 'NM1', 201], ['qualifiers', 'NM2', 202], ['octavos', 'NM1', 101], ['octavos', 'NM2', 102],
    ['octavos', 'FM1', 103], ['octavos', 'HD1', 104], ['octavos', 'HR1', 105], ['octavos', 'DT1', 106]]) {
    await adm2('/api/admin/pool', { method: 'POST', json: { round, slot, beatmap: String(bid) } });
  }
  r = await adm2('/api/admin/qual', { method: 'POST', json: { mp: '901' } });
  assert.equal(r.body.players, 16);
  assert.equal((await anon2('/api/state')).body.pools.octavos.length, 6, 'pasado el showcase, la mappool es pública sin programarla');
  const p01 = await login(s2.base, 601);
  const fakeNow = Date.parse(t0);
  // U1-1 es seed 1 vs seed 16
  r = await adm2('/api/admin/match', { method: 'POST', json: { id: 'u1-1', time: fakeNow + 20 * 60e3, ref: 'Gofio' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await adm2('/api/admin/match', { method: 'POST', json: { id: 'u1-3', time: fakeNow + 3 * 3600e3 } });
  // Forfeit
  await adm2('/api/admin/match', { method: 'POST', json: { id: 'u1-1', time: fakeNow + 20 * 60e3, ref: 'Gofio', ff: 'a' } });
  // U1-2 (P08 vs P09) desde el MP: 5–1
  r = await adm2('/api/admin/match', { method: 'POST', json: { id: 'u1-2', time: fakeNow - 3600e3, mp: '556' } });
  assert.equal(r.body.warning, null, JSON.stringify(r.body));
  assert.deepEqual(r.body.result.wins, { 608: 5, 609: 1 }, 'los mapas jugados después de decidirse el partido no cuentan');
  assert.deepEqual(r.body.result.maps.map((m) => [m.bid, m.w]), [[101, 609], [102, 608], [103, 608], [104, 608], [105, 608], [106, 608]], 'sin los mapas de showmatch');
  await adm2('/api/admin/sync', { method: 'POST', json: { id: 'u1-2' } });
  await adm2('/api/admin/match', { method: 'POST', json: { id: 'u1-2', time: fakeNow - 3600e3, mp: '556', ref: 'otro' } });
  console.log('✓ partidos de octavos: forfeit y resultado desde el MP (sin los mapas de showmatch del final)');

  // Skills del torneo: base con los clasificatorios (901: P01 el mejor en los dos mapas) y Elo con el cuadro (U1-2).
  const prof2 = async (c, id) => (await c('/api/profile?id=' + id)).body;
  const wait2 = async (cond, what) => { for (let i = 0; i < 300; i++) { if (await cond()) return; await new Promise((res) => setTimeout(res, 100)); } throw new Error('No llegó a pasar: ' + what); };
  await wait2(async () => (await prof2(adm2, 608)).skills?.maps === 6, 'atributos de los mapas y skills tras U1-2');
  let pf = await prof2(adm2, 601);
  assert.deepEqual(pf.skills.percentiles, { aim: 100, speed: 100, prec: 100, acc: 100, stamina: 100 }, 'P01, el mejor de los clasificatorios');
  assert.deepEqual([pf.skills.players, pf.skills.tr, pf.skills.change], [16, false, null], 'sin o!TR, la seed; sin partidos, sin flecha');
  assert.deepEqual((await prof2(adm2, 616)).skills.percentiles, { aim: 0, speed: 0, prec: 0, acc: 0, stamina: 0 }, 'P16, el último');
  assert.deepEqual(pf.mods.find((m) => m.mod === 'NM').qual.maps, 2, 'rendimiento por mod: los dos NM de clasificatorios');
  // Antes de publicar los resultados de clasificatorios, el público no ve nada sacado de ellos.
  pf = await prof2(anon2, 601);
  assert.deepEqual([pf.skills, pf.mods], [null, []], 'sin publicar: ni skills ni mods del torneo (y sin o!TR no hay nada)');
  await adm2('/api/admin/qual-results', { method: 'POST', json: { now: true } });
  assert.equal((await prof2(anon2, 601)).skills.percentiles.aim, 100, 'publicados: el público ya los ve');
  await adm2('/api/admin/qual-results', { method: 'POST', json: { hide: true } });
  // U1-2: P08 gana 5–1 a P09. P09 solo gana el NM1 (101, el mapa de más aim); los de velocidad (102 y 106) los gana P08.
  // En conjunto P08 sube y P09 baja; P08 sube sobre todo en velocidad, y P09 pierde menos aim que velocidad.
  const p08 = await prof2(adm2, 608);
  assert.equal(p08.skills.maps, 6);
  const nm = p08.mods.find((m) => m.mod === 'NM').bracket;
  assert.deepEqual(nm, { played: 2, won: 1 }, 'NM1 lo pierde y NM2 lo gana');
  const hist = (() => { const d = new DatabaseSync(join(dir, 'octavos.db'), { readOnly: true }); try { return d.prepare('SELECT step, data FROM skill_history ORDER BY ord').all().map((x) => ({ step: x.step, r: JSON.parse(x.data) })); } finally { d.close(); } })();
  assert.deepEqual(hist.map((x) => x.step), ['qual', 'u1-2'], 'historial: tras los clasificatorios y tras U1-2 (el forfeit de U1-1 no cuenta)');
  const [q0, q1] = hist.map((x) => x.r);
  const sum = (r) => Object.values(r).reduce((x, y) => x + y, 0);
  const dl = (uid, k) => q1[uid][k] - q0[uid][k];
  assert.ok(sum(q1[608]) > sum(q0[608]) && sum(q1[609]) < sum(q0[609]), 'gana P08: sube en conjunto; P09 baja');
  assert.ok(dl(608, 'speed') > 0 && dl(609, 'speed') < 0, 'velocidad: sube P08, baja P09');
  assert.ok(dl(608, 'speed') > dl(608, 'aim'), 'P08 sube más en velocidad que en aim');
  assert.ok(dl(609, 'aim') > dl(609, 'speed'), 'P09 pierde menos aim (ganó el mapa de aim) que velocidad');
  assert.equal(q1[601].aim, q0[601].aim, 'quien no ha jugado no cambia');
  // Detalle por jugador y mapa guardado al leer el MP (sin pedir nada nuevo a osu!).
  const m12 = (await adm2('/api/state')).body.matches['u1-2'].result.maps[0];
  assert.deepEqual(Object.keys(m12.stats).sort(), ['608', '609']);
  assert.deepEqual([m12.stats[609].score, m12.stats[609].mods], [900000, ['NF']], 'puntuación y mods de cada jugador');
  console.log('✓ skills del torneo: pesos, base con clasificatorios, Elo con el cuadro, historial y visibilidad');

  // ---------- Stats: GET /api/stats ----------
  // Octavos: U1-2 (P08 5–1 P09, todo 900k contra 500k, sin precisión) y U1-7 en juego (P07 contra P10, MP 557).
  // Los cálculos se comprueban con la vista previa de los admins; el público solo ve las rondas terminadas y publicadas.
  const stats = async (round, view, who = adm2) => (await who(`/api/stats?round=${round}${view ? '&view=' + view : ''}`));
  const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} ≠ ${b}`);
  const noLeak = (body, leaks, what) => { const txt = JSON.stringify(body); for (const x of leaks) assert.ok(!txt.includes(x), `${what}: no sale ${x}`); };
  const statsRel = (round, publish) => adm2('/api/admin/stats-release', { method: 'POST', json: { round, publish } });
  games557.push(...GAMES557.slice(0, 3)); // warmup, NM1 y NM2
  r = await adm2('/api/admin/match', { method: 'POST', json: { id: 'u1-7', time: fakeNow - 1800e3, mp: '557' } });
  assert.equal(r.body.warning, null, JSON.stringify(r.body));
  games557.push(GAMES557[3]); // FM1 ya jugado, pero el MP aún no se ha vuelto a leer: no cuenta
  // Público: la ronda no ha terminado ni se ha publicado, así que no hay nada.
  for (const view of STATS_VIEWS) {
    r = await stats('octavos', view, anon2);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=5');
    assert.deepEqual([r.body.status, r.body.over, r.body.players, r.body.maps, r.body.preview], ['unpublished', false, [], [], undefined], `${view}: sin publicar`);
    noLeak(r.body, ['101', 'Titulo', '900000', 'P07', 'P08', 'u1-7', 'pending'], view);
  }
  assert.deepEqual((await anon2('/api/state')).body.statsPublic, []);
  r = await stats('octavos');
  assert.equal(r.headers.get('cache-control'), 'private, no-store', 'la vista previa de los admins no se guarda en caché');
  assert.deepEqual([r.body.status, r.body.view, r.body.metric, r.body.preview], ['ok', 'resultados-individuales', { key: 'matchCost', label: 'Match cost' }, true]);
  assert.deepEqual(r.body.publication, { published: null, over: false, pending: 6, visible: false }, 'quedan 6 partidos: U1-1 fue forfeit y U1-2 terminó');
  r = await statsRel('octavos', true);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /faltan 6 partidos/, 'no se puede publicar antes de que termine la ronda');
  r = await stats('octavos');
  const row = (body, id) => body.players.find((x) => x.id === id);
  assert.equal(row(r.body, 607).maps, 2, 'partido en juego: solo los mapas leídos del MP, sin el warmup');
  near(row(r.body, 607).value, (800 / 775 + 600 / 650) / 2, 'match cost con dos mapas');
  await adm2('/api/admin/sync', { method: 'POST', json: { id: 'u1-7' } });
  r = await stats('octavos');
  assert.deepEqual(r.body.players.map((x) => [x.username, x.maps]), [['P08', 6], ['P10', 3], ['P07', 3], ['P09', 6]], 'orden por match cost');
  near(row(r.body, 608).value, (500 / 700 + 5 * 900 / 700) / 6, 'match cost de P08');
  near(row(r.body, 609).value, (900 / 700 + 5 * 500 / 700) / 6, 'match cost de P09');
  near(row(r.body, 607).value, (800 / 775 + 600 / 650 + 900 / 945) / 3, 'match cost de P07 (FM1 con el EZ de P10)');
  near(row(r.body, 610).value, (750 / 775 + 700 / 650 + 990 / 945) / 3, 'match cost de P10');
  near(row(r.body, 607).avgScore, 2300000 / 3, 'avg. score');
  near(row(r.body, 610).avgScore, (750000 + 700000 + 990000) / 3, 'avg. score con el multiplicador de EZ');
  near(row(r.body, 607).avgAcc, (0.9812 + 0.93 + 0.99) / 3, 'avg. acc');
  assert.equal(row(r.body, 608).avgAcc, null, 'sin precisión guardada: null');
  assert.deepEqual(row(r.body, 607).best, { score: 900000, acc: 0.99, slot: 'FM1', mods: ['HR'], rank: 'SS', mult: null, match: 'u1-7', mp: 557 }, 'mejor score de P07');
  assert.deepEqual(row(r.body, 610).best, { score: 990000, acc: 0.96, slot: 'FM1', mods: ['EZ'], rank: 'A', mult: 1.8, match: 'u1-7', mp: 557 }, 'mejor score de P10, con EZ ×1,8');
  assert.deepEqual([row(r.body, 608).best.slot, row(r.body, 609).best.slot], ['NM2', 'NM1'], 'mejor score: el primero de los más altos');
  // Leaderboard por mapa: todos los scores de cada mapa del pool, de mayor a menor.
  r = await stats('octavos', 'leaderboard-por-mapa');
  assert.deepEqual(r.body.maps.map((m) => [m.slot, m.plays.length]), [['NM1', 4], ['NM2', 4], ['HD1', 2], ['HR1', 2], ['DT1', 2], ['FM1', 4]]);
  const nm1 = r.body.maps[0];
  assert.deepEqual([nm1.beatmap_id, nm1.artist, nm1.title, nm1.version], [101, 'Artista 101', 'Titulo 101', 'Insane']);
  assert.deepEqual(nm1.plays.map((x) => [x.username, x.score, x.rank, x.match]), [['P09', 900000, null, 'u1-2'], ['P07', 800000, 'S', 'u1-7'], ['P10', 750000, 'B', 'u1-7'], ['P08', 500000, null, 'u1-2']]);
  assert.deepEqual(r.body.maps[1].plays.slice(0, 2).map((x) => [x.username, x.rank, x.acc]), [['P08', null, null], ['P10', 'S', 0.97]], 'NM2');
  assert.deepEqual(r.body.maps[5].plays[0], { id: 610, username: 'P10', score: 990000, acc: 0.96, slot: 'FM1', mods: ['EZ'], rank: 'A', mult: 1.8, match: 'u1-7', mp: 557 }, 'FM1: gana el EZ');
  // Ronda sin partidos: aviso en vez de tabla. Parámetros que no existen: 400.
  assert.equal((await stats('cuartos', null, anon2)).body.status, 'hidden', 'cuartos, antes de su showcase: oculta al público');
  r = await stats('cuartos');
  assert.deepEqual([r.body.status, r.body.players, r.body.publication.pending], ['empty', [], 8], 'cuartos: aún no hay resultados');
  assert.deepEqual([(await stats('cuartos', 'leaderboard-por-mapa')).body.status, (await stats('cuartos', 'leaderboard-por-mapa')).body.maps], ['empty', []]);
  assert.equal((await stats('registros')).status, 400, 'registros no es una ronda con estadísticas');
  assert.equal((await stats('nada')).status, 400);
  assert.equal((await anon2('/api/stats')).status, 400, 'sin ronda');
  assert.match((await stats('octavos', 'graficos')).body.error, /Vista desconocida/);
  assert.equal((await statsRel('nada', true)).status, 400);
  assert.equal((await anon2('/api/admin/stats-release', { method: 'POST', json: { round: 'octavos', publish: false } })).status, 401, 'publicar es cosa de admins');
  assert.equal((await p01('/api/admin/stats-release', { method: 'POST', json: { round: 'octavos', publish: false } })).status, 403);
  // Mappool sin publicar: el público no ve ni mapas ni scores.
  assert.equal((await adm2('/api/admin/pool/release', { method: 'POST', json: { round: 'octavos', at: fakeNow + 24 * 3600e3 } })).status, 200);
  for (const view of STATS_VIEWS) {
    r = await stats('octavos', view, anon2);
    assert.equal(r.body.status, 'hidden', `${view}: oculta`);
    noLeak(r.body, ['101', 'Titulo', '900000', '990000', 'P07', 'u1-7'], view);
  }
  assert.equal((await stats('octavos')).body.status, 'ok', 'los admins la ven como vista previa');
  assert.equal((await adm2('/api/admin/pool/release', { method: 'POST', json: { round: 'octavos', at: Date.parse('2026-11-15T23:00:00Z') } })).status, 200); // su showcase
  // Clasificatorios: terminados (el reloj está en octavos), pero sin resultados publicados no se pueden publicar.
  r = await stats('qualifiers', null, anon2);
  assert.deepEqual([r.body.status, r.body.players, r.body.metric], ['hidden-results', [], { key: 'zsum', label: 'Z-sum' }]);
  noLeak((await stats('qualifiers', 'leaderboard-por-mapa', anon2)).body, ['201', 'P01'], 'clasificatorios sin publicar');
  assert.deepEqual((await stats('qualifiers')).body.publication, { published: null, over: true, pending: null, visible: false });
  assert.match((await statsRel('qualifiers', true)).body.error, /resultados de los clasificatorios/);
  await adm2('/api/admin/qual-results', { method: 'POST', json: { now: true } });
  assert.deepEqual([(await stats('qualifiers', null, anon2)).body.status, (await stats('qualifiers', null, anon2)).body.over], ['unpublished', true], 'resultados públicos, estadísticas aún no');
  r = await statsRel('qualifiers', true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await stats('qualifiers', null, anon2);
  assert.deepEqual([r.body.status, r.body.players.length, r.body.preview], ['ok', 16, undefined], 'publicadas: el público las ve');
  assert.deepEqual(r.body.players.slice(0, 2).map((x) => [x.username, x.maps, x.avgScore]), [['P01', 2, 875000], ['P02', 2, 865000]], 'orden por Z-sum');
  assert.equal(r.body.players[0].value, Math.round(2 * 7.5 / Math.sqrt(255 / 12) * 1000) / 1000, 'Z-sum de P01');
  assert.deepEqual(r.body.players[0].best, { score: 900000, acc: null, slot: 'NM1', mods: [], rank: null, mult: null, match: null, mp: null });
  r = await stats('qualifiers', 'leaderboard-por-mapa', anon2);
  assert.deepEqual(r.body.maps.map((m) => [m.slot, m.plays.length, m.plays[0].username, m.plays[0].score]), [['NM1', 16, 'P01', 900000], ['NM2', 16, 'P01', 850000]]);
  assert.ok(!JSON.stringify(r.body).includes('901'), 'sin el MP de los lobbies');
  assert.deepEqual((await anon2('/api/state')).body.statsPublic, ['qualifiers']);
  assert.equal((await adm2('/api/state')).body.statsRelease.qualifiers.visible, true);
  assert.equal((await anon2('/api/state')).body.statsRelease, undefined, 'el estado de la publicación es solo para admins');
  await adm2('/api/admin/qual-results', { method: 'POST', json: { hide: true } });
  assert.equal((await stats('qualifiers', null, anon2)).body.status, 'hidden-results', 'si se ocultan los resultados, también sus estadísticas');
  assert.equal((await statsRel('qualifiers', false)).status, 200);
  assert.equal((await adm2('/api/state')).body.statsRelease.qualifiers.published, null, 'ocultas otra vez');
  // Octavos terminado: U1-7 vuelve a estar sin MP ni resultado y el resto de partidos se dan por forfeit.
  await adm2('/api/admin/match', { method: 'POST', json: { id: 'u1-7' } });
  const rest = ['u1-3', 'u1-4', 'u1-5', 'u1-6', 'u1-7', 'u1-8'];
  for (const id of rest) await adm2('/api/admin/match', { method: 'POST', json: { id, ff: 'a', ...(id === 'u1-3' ? { time: fakeNow + 3 * 3600e3 } : {}) } });
  assert.deepEqual((await adm2('/api/state')).body.statsRelease.octavos, { published: null, over: true, pending: 0, visible: false });
  r = await statsRel('octavos', true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await stats('octavos', null, anon2);
  assert.deepEqual([r.body.status, r.body.players.map((x) => x.username)], ['ok', ['P08', 'P09']], 'publicadas: sin los forfeits');
  assert.deepEqual((await anon2('/api/state')).body.statsPublic, ['octavos']);
  // Si un partido deja de estar terminado (se corrige un forfeit), se vuelven a ocultar solas.
  await adm2('/api/admin/match', { method: 'POST', json: { id: 'u1-8' } });
  assert.equal((await stats('octavos', null, anon2)).body.status, 'unpublished', 'ronda sin terminar otra vez: oculta');
  assert.equal((await statsRel('octavos', false)).status, 200);
  for (const id of rest) await adm2('/api/admin/match', { method: 'POST', json: { id, ...(id === 'u1-3' ? { time: fakeNow + 3 * 3600e3 } : {}) } });
  assert.deepEqual((await stats('octavos')).body.players.map((x) => x.username), ['P08', 'P09']);
  // La página: la dirección (#stats/<ronda>?view=…) y el formato de los números, con las funciones de la propia web.
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const pure = new Function(html.match(/\/\* stats:puros[^]*?\*\/([^]*?)\/\* \/stats:puros \*\//)[1] + '; return { statsRoute, fmtInt, fmt3, fmtAcc };')();
  assert.deepEqual(pure.statsRoute('#stats/finals?view=leaderboard-por-mapa'), { round: 'finals', view: 'leaderboard-por-mapa' });
  assert.deepEqual(pure.statsRoute('#stats/gf?view=resultados-individuales'), { round: 'gf', view: 'resultados-individuales' });
  assert.deepEqual(pure.statsRoute('#stats/octavos'), { round: 'octavos', view: 'resultados-individuales' }, 'sin vista: resultados individuales');
  assert.deepEqual(pure.statsRoute('#stats?view=otra'), { round: null, view: 'resultados-individuales' }, 'vista desconocida');
  assert.deepEqual([pure.fmtInt(310368), pure.fmtInt(1234), pure.fmtInt(1234567), pure.fmtInt(999), pure.fmtInt(null)], ['310.368', '1.234', '1.234.567', '999', '–'], 'miles con punto, también con 4 cifras');
  assert.deepEqual([pure.fmt3(1.062), pure.fmt3(0.8095238), pure.fmt3(1234.5)], ['1,062', '0,810', '1.234,500']);
  assert.deepEqual([pure.fmtAcc(0.9281), pure.fmtAcc(1)], ['92,81 %', '100,00 %'], 'precisión con coma y espacio antes del %');
  assert.ok(html.includes("['stats','Stats']"), 'Stats sigue en el menú');
  console.log('✓ stats: match cost, medias, mejor score, leaderboard por mapa, ronda sin resultados, publicación al terminar la ronda, vista previa de admins, mappools y clasificatorios sin publicar, dirección y formato');

  // ---------- Arbitraje con bot de IRC (Bancho simulado) ----------
  const refc = await login(s2.base, 503); // «Jugador C»: no juega el torneo
  r = await refc('/api/ref/events');
  assert.equal(r.status, 403, 'solo árbitros');
  assert.equal((await anon2('/api/ref/events')).status, 401);
  r = await adm2('/api/admin/role', { method: 'POST', json: { user: 'Jugador C', role: 'referee' } });
  assert.equal(r.body.username, 'Jugador C', JSON.stringify(r.body));
  assert.ok((await adm2('/api/state')).body.team.some((x) => x.id === 503 && x.role === 'referee'));
  assert.equal((await refc('/api/state')).body.me.referee, true);
  assert.equal((await p01('/api/state')).body.me.referee, false);
  // Reglas de la ronda desde el panel (con aviso: 6 mapas no dan para un Bo9 con 1 ban cada uno)
  r = await adm2('/api/admin/rules', { method: 'POST', json: { round: 'octavos', bans: '9', protects: '1', banEvery: '2', pickTimer: '30' } });
  assert.equal(r.status, 400);
  r = await adm2('/api/admin/rules', { method: 'POST', json: { round: 'octavos', bans: '1', protects: '1', banEvery: '2', pickTimer: '30' } });
  assert.match(r.body.warning, /quedan 4 mapas para elegir y un Bo9 puede necesitar 8 picks/);
  assert.deepEqual((await anon2('/api/state')).body.rules.octavos, { bans: 1, protects: 1, banEvery: 2, pickTimer: 30, readyTimer: 30, absentLimit: 15, reinviteEvery: 60, maxWarnings: 3 }, 'los campos del bot, por defecto');
  // Campos del bot: opcionales, con su rango
  for (const [k, v] of [['readyTimer', 5], ['absentLimit', 0], ['reinviteEvery', 700], ['maxWarnings', 0], ['readyTimer', 'x']]) {
    r = await adm2('/api/admin/rules', { method: 'POST', json: { round: 'octavos', bans: 1, protects: 1, banEvery: 2, pickTimer: 30, [k]: v } });
    assert.equal(r.status, 400, `${k} = ${v}`);
  }
  r = await adm2('/api/admin/rules', { method: 'POST', json: { round: 'octavos', bans: 1, protects: 1, banEvery: 2, pickTimer: 30, readyTimer: 45, absentLimit: 10, reinviteEvery: 30, maxWarnings: 2 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await adm2('/api/admin/rules', { method: 'POST', json: { round: 'octavos', bans: 1, protects: 1, banEvery: 2, pickTimer: 30 } });
  assert.deepEqual(r.body.rules, { bans: 1, protects: 1, banEvery: 2, pickTimer: 30, readyTimer: 45, absentLimit: 10, reinviteEvery: 30, maxWarnings: 2 }, 'sin los campos del bot se quedan los que había');
  assert.equal((await adm2('/api/admin/rules', { method: 'POST', json: { round: 'qualifiers', bans: 1, protects: 1, banEvery: 2, pickTimer: 0 } })).status, 400);

  const live = await refStream(s2.base, refc);
  await until(() => live.last, 'estado inicial del árbitro');
  assert.equal(live.last.irc.status, 'off');
  const f3 = live.last.flows['u1-3'];
  assert.equal(f3.step, 'roll');
  const A = f3.a.username, B = f3.b.username, CH = '#mp_558';
  // Un jugador no puede arbitrar su propio partido
  await adm2('/api/admin/role', { method: 'POST', json: { user: String(f3.a.id), role: 'referee' } });
  const playerRef = await login(s2.base, f3.a.id);
  r = await playerRef('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'roll', winner: 'a' } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'No puedes arbitrar un partido en el que juegas.');
  await adm2('/api/admin/role', { method: 'POST', json: { id: f3.a.id, role: '' } });

  // Conexión: la contraseña IRC equivocada se rechaza; la buena conecta con el nombre de osu! (espacios → _)
  r = await refc('/api/ref/connect', { method: 'POST', json: { password: 'mala-clave' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Bancho rechaza la contraseña IRC/);
  r = await refc('/api/ref/connect', { method: 'POST', json: { password: 'irc-secreta' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(irc.lines.includes('NICK Jugador_C') && irc.lines.includes('PASS irc-secreta'));
  await until(() => live.last.irc.status === 'connected', 'conectado en la página');
  await until(() => irc.lines.includes('PONG :cho.ppy.sh'), 'responde al PING de Bancho');

  // Crear el lobby: «Iniciar partido» y «Crear el lobby» del bot, en SEMI (el modo por defecto)
  assert.deepEqual([f3.bot.mode, f3.bot.stage, f3.bot.actions.map((x) => x.id)], ['semi', 'idle', ['start']], 'bot sin empezar, en SEMI');
  r = await refc('/api/ref/lobby', { method: 'POST', json: { match: 'u1-3' } });
  assert.deepEqual(r.body, { ok: true, mp: '558', key: 'u1-3' }, JSON.stringify(r.body));
  assert.ok(irc.sent.some((m) => m.to === 'BanchoBot' && m.text === `!mp make SPI6: (${A}) vs (${B})`));
  await until(() => live.last.flows['u1-3'].bot?.step === 'A4', 'el bot pasa a configurar el lobby');
  await new Promise((done) => setTimeout(done, 400));
  assert.deepEqual(sentTo(CH), [], 'en SEMI no se manda nada al lobby sin pulsar');
  const botRun = (key, id) => refc('/api/ref/act', { method: 'POST', json: { key, type: 'bot', do: 'run', id } });
  assert.deepEqual(live.last.flows['u1-3'].bot.actions[0], { id: 'lobby:setup', label: 'Team VS, ScoreV2 y 2 plazas', out: ['!mp set 2 3 2'], auto: true, decision: false, urgent: false }, 'el botón lleva el texto exacto');
  for (const id of ['lobby:setup', 'lobby:password', 'lobby:invite']) {
    r = await botRun('u1-3', id);
    assert.equal(r.status, 200, id + ' ' + JSON.stringify(r.body));
  }
  r = await botRun('u1-3', 'lobby:setup');
  assert.equal(r.status, 409, 'pulsar dos veces no repite el paso');
  await until(() => sentTo(CH).includes(`!mp invite #${f3.b.id}`), 'invitaciones');
  assert.deepEqual(sentTo(CH).filter((t) => !t.startsWith('!mp password ')), ['!mp set 2 3 2', `!mp invite #${f3.a.id}`, `!mp invite #${f3.b.id}`], 'invitaciones por ID');
  assert.match(sentTo(CH)[1], /^!mp password [0-9a-f]{10}$/, 'contraseña al azar');
  assert.ok(!JSON.stringify((await anon2('/api/state')).body).includes(sentTo(CH)[1].slice(13)), 'la contraseña no sale en el estado público');
  assert.ok(!JSON.stringify((await anon2('/api/overlay?match=u1-3')).body).includes(sentTo(CH)[1].slice(13)), 'ni en /api/overlay');
  r = await adm2('/api/state');
  assert.equal(r.body.matches['u1-3'].mp, 558);
  assert.equal(r.body.matches['u1-3'].ref, 'Jugador C');

  // En SEMI el bot no actúa solo: los equipos se ponen con su botón
  const lobby = () => live.last.lobbies.find((l) => l.key === 'u1-3' && !l.closed);
  ircSay(CH, 'BanchoBot', `${A} joined in slot 1.`);
  ircSay(CH, 'BanchoBot', `${B} joined in slot 2 for team red.`);
  await until(() => lobby()?.players.length === 2, 'jugadores en el lobby');
  assert.ok(!sentTo(CH).some((t) => t.startsWith('!mp team')), 'sin equipos hasta que el árbitro los pone');
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'teams' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => sentTo(CH).includes(`!mp team #${f3.a.id} red`) && sentTo(CH).includes(`!mp team #${f3.b.id} blue`), 'equipos por ID');
  // Roll a mano: el árbitro apunta quién gana; en SEMI el bot no apunta ni manda nada por su cuenta
  const inLog = (text) => lobby()?.log.some((x) => x.text === text);
  ircSay(CH, A, '!roll');
  ircSay(CH, 'BanchoBot', `${A} rolls 40 point(s)`);
  ircSay(CH, B, '!roll');
  ircSay(CH, 'BanchoBot', `${B} rolls 75 point(s)`);
  await until(() => inLog(`${B} rolls 75 point(s)`), 'roll en el chat de la página');
  assert.equal(live.last.flows['u1-3'].step, 'roll', 'el roll no se apunta solo');
  assert.equal(live.last.flows['u1-3'].roll, null, 'en SEMI lo que se lee del chat no se apunta sin pulsar');
  assert.ok(!sentTo(CH).some((t) => /roll/i.test(t)), 'nada mandado al lobby sobre el roll');
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'roll', winner: 'b' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => live.last.flows['u1-3'].step === 'order', 'roll apuntado');
  assert.equal(live.last.flows['u1-3'].rollFor, 'protect', 'el primer roll es el de protects');
  assert.deepEqual(live.last.flows['u1-3'].roll, { winner: 'b' });
  await until(() => sentTo(CH).includes(`${B} gana el roll y elige quién protege primero.`), 'anuncio del roll al pulsarlo');
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'order', ban: 'b', pick: 'b' } });
  assert.equal(r.status, 400, 'tras el roll de protects solo se elige quién protege primero');
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'order', protect: 'a' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => sentTo(CH).includes(`Protege primero ${A}.`), 'orden de protects anunciado');
  assert.ok(!sentTo(CH).includes('!mp timer 30'), 'el temporizador no se pone solo');
  await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'timer', seconds: 30 } });
  await until(() => sentTo(CH).includes('!mp timer 30'), 'temporizador con el botón');

  // Protects: en SEMI lo que escribe un jugador no se apunta sin pulsar; aquí el árbitro pulsa el mapa (Apuntar a mano)
  ircSay(CH, A, 'nm1');
  await until(() => inLog('nm1'), 'mapa escrito en el chat');
  assert.equal(live.last.flows['u1-3'].protects.length, 0, 'no se apunta solo');
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'protect', slot: 'NM1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => sentTo(CH).includes(`${A} protege NM1.`) && sentTo(CH).includes('!mp aborttimer'), 'protect anunciado y temporizador parado');
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'protect', slot: 'hd1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Segundo roll, tras los protects: quien lo gana elige quién banea y quién elige primero
  await until(() => live.last.flows['u1-3'].step === 'roll', 'segundo roll tras los protects');
  assert.equal(live.last.flows['u1-3'].rollFor, 'banpick');
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'ban', slot: 'DT1' } });
  assert.equal(r.status, 400, 'sin el segundo roll no se banea');
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'roll', winner: 'a' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => sentTo(CH).includes(`${A} gana el roll y elige quién banea primero y quién elige primero.`), 'anuncio del segundo roll');
  await until(() => live.last.flows['u1-3'].step === 'order', 'segundo roll apuntado');
  assert.deepEqual([live.last.flows['u1-3'].roll, live.last.flows['u1-3'].roll2], [{ winner: 'b' }, { winner: 'a' }], 'los dos rolls, cada uno con su ganador');
  assert.equal(live.last.flows['u1-3'].by, 'a', 'elige el orden quien gana el segundo roll');
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'order', ban: 'b', pick: 'b' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => sentTo(CH).includes(`Banea primero ${B} y elige primero ${B}.`), 'orden de bans y picks anunciado');
  // Bans: no se puede banear un mapa protegido; la primera tanda la abre B (orden elegido)
  await until(() => live.last.flows['u1-3'].step === 'ban', 'turno de bans');
  assert.equal(live.last.flows['u1-3'].by, 'b');
  assert.equal(live.last.flows['u1-3'].allowed.NM1, 'Está protegido', 'la página sabe por qué no vale');
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'ban', slot: 'NM1' } });
  assert.equal(r.status, 400, 'regla: no banear protegidos');
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'ban', slot: 'DT1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'ban', slot: 'DT1' } });
  assert.equal(r.status, 400, 'mapa ya baneado');
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'ban', slot: 'HR1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => live.last.flows['u1-3'].step === 'pick' && live.last.flows['u1-3'].by === 'b', 'turno de picks: First Pick de B');
  // Pick de B (First Pick): al confirmarlo se pone el mapa con NF; se empieza con el botón cuando el árbitro quiere
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'pick', slot: 'NM2' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => sentTo(CH).includes(`${B} elige NM2: Artista 102 - Titulo 102 [Insane]. Empieza cuando estéis listos.`), 'pick anunciado');
  assert.ok(sentTo(CH).includes('!mp map 102 0') && sentTo(CH).includes('!mp mods NF'), 'mapa y mods antes del anuncio');
  const play = async (bid, sa, sb) => {
    ircSay(CH, 'BanchoBot', 'All players are ready');
    await until(() => lobby()?.ready === true, 'todos listos en la página');
    assert.equal(sentTo(CH).filter((t) => t === '!mp start 5').length, play.n, 'no empieza solo');
    await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'start' } });
    await until(() => sentTo(CH).filter((t) => t === '!mp start 5').length > play.n, 'empieza con el botón');
    play.n++;
    ircSay(CH, 'BanchoBot', 'The match has started!');
    ircSay(CH, 'BanchoBot', `${A} finished playing (Score: ${sa}, PASSED).`);
    ircSay(CH, 'BanchoBot', `${B} finished playing (Score: ${sb}, PASSED).`);
    games558.push(game(bid, [[f3.a.id, sa], [f3.b.id, sb]]));
    ircSay(CH, 'BanchoBot', 'The match has finished!');
  };
  play.n = 0;
  const readLine = (text) => lobby()?.log.some((x) => x.from === 'web' && x.text === text);
  await play(102, 500000, 900000);
  await until(() => readLine(`Resultado leído de osu!: NM2: 500.000 – 900.000. Marcador: ${A} 0 – 1 ${B}`), 'marcador leído de la API de osu!');
  assert.ok(!sentTo(CH).some((t) => t.includes('Marcador')), 'el marcador no se anuncia solo');
  await until(() => live.last.flows['u1-3'].step === 'pick' && live.last.flows['u1-3'].by === 'a', 'turno de A');
  // Pick de A con el botón: FreeMod
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'pick', slot: 'FM1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => sentTo(CH).includes('!mp mods Freemod') && sentTo(CH).includes(`${A} elige FM1: Artista 103 - Titulo 103 [Insane] · FreeMod, NF obligatorio. Empieza cuando estéis listos.`), 'FM en FreeMod');
  await play(103, 900000, 500000);
  await until(() => readLine(`Resultado leído de osu!: FM1: 900.000 – 500.000. Marcador: ${A} 1 – 1 ${B}`), 'segundo mapa');
  // Regla: B no puede repetir el mod de su pick anterior (NM2 → NM1); el mapa protegido sí se puede elegir
  await until(() => live.last.flows['u1-3'].by === 'b', 'turno de B');
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'pick', slot: 'NM1' } });
  assert.equal(r.status, 400, 'regla: mismo mod');
  assert.match(r.body.error, /mismo mod que su pick anterior/);
  ircSay(CH, B, 'hd1');
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'pick', slot: 'HD1' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => sentTo(CH).includes('!mp mods NF HD'), 'pick del mapa protegido');
  r = await anon2('/api/state');
  assert.deepEqual(r.body.matches['u1-3'].bans, ['DT1', 'HR1']);
  assert.deepEqual(r.body.matches['u1-3'].protects, ['NM1', 'HD1']);
  assert.deepEqual(r.body.matches['u1-3'].result.wins, { [f3.a.id]: 1, [f3.b.id]: 1 });

  // /api/overlay: datos públicos de un partido para otras webs (sin sesión, CORS abierto)
  const overlay = async (qs, init = {}) => {
    const res = await fetch(s2.base + '/api/overlay' + qs, { headers: { Origin: 'https://otra-web.example' }, ...init });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : await res.text() };
  };
  r = await overlay('?match=U1-3');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body), ['matchId', 'scheduledAt', 'round', 'bestOf', 'players', 'pool', 'rundown']);
  assert.deepEqual([r.body.matchId, r.body.scheduledAt, r.body.round, r.body.bestOf], ['u1-3', fakeNow + 3 * 3600e3, 'octavos', 9]);
  assert.deepEqual(r.body.players, { red: null, blue: null }, 'sin resultados de clasificatorios publicados, el público no ve los cruces');
  assert.deepEqual(r.body.rundown, [
    { actor: 'RED', action: 'PROTECT', pick: 'NM1' }, { actor: 'BLUE', action: 'PROTECT', pick: 'HD1' },
    { actor: 'BLUE', action: 'BAN', pick: 'DT1' }, { actor: 'RED', action: 'BAN', pick: 'HR1' },
    { actor: 'BLUE', action: 'PICK', pick: 'NM2' }, { actor: 'RED', action: 'PICK', pick: 'FM1' }, { actor: 'BLUE', action: 'PICK', pick: 'HD1' }
  ], 'rundown en el orden apuntado, A en rojo y B en azul, sin el roll');
  assert.deepEqual(r.body.pool.map((p) => [p.slot, p.beatmap_id]), [['NM1', 101], ['NM2', 102], ['HD1', 104], ['HR1', 105], ['DT1', 106], ['FM1', 103]], 'pool publicada, ordenada por slot');
  assert.deepEqual(Object.keys(r.body.pool[0]), ['slot', 'beatmap_id', 'data']);
  assert.equal(r.body.pool[0].data.title, 'Titulo 101', 'data tal como se guarda');
  // Cabeceras: CORS abierto, solo GET, sin cookies y caché de unos segundos
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(r.headers.get('access-control-allow-credentials'), null);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=5');
  r = await overlay('?match=u1-3', { method: 'OPTIONS', headers: { Origin: 'https://otra-web.example', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  assert.equal(r.headers.get('access-control-allow-credentials'), null);
  assert.equal((await anon2('/api/state')).headers.get('access-control-allow-origin'), null, 'CORS solo en /api/overlay');
  // Errores, también con CORS
  r = await overlay('');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Falta el parámetro match/);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  r = await overlay('?match=u9-9');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'No existe ese partido.');
  assert.equal((await overlay('?match=qual:901')).status, 404, 'los lobbies de clasificatorios no son partidos del cuadro');
  // Con los resultados publicados: A en rojo y B en azul, como los pone !mp team; quien aún no está decidido, null
  await adm2('/api/admin/qual-results', { method: 'POST', json: { now: true } });
  r = await overlay('?match=u1-3');
  assert.deepEqual(r.body.players, { red: { id: f3.a.id, username: f3.a.username }, blue: { id: f3.b.id, username: f3.b.username } });
  r = await overlay('?match=u2-2');
  assert.deepEqual([r.body.round, r.body.bestOf, r.body.scheduledAt, r.body.rundown], ['cuartos', 9, null, []], 'partido sin guardar: sin hora ni rundown');
  assert.deepEqual(r.body.players, { red: null, blue: null }, 'U1-3 y U1-4 sin terminar');
  r = await overlay('?match=u2-1');
  assert.ok(r.body.players.red && r.body.players.blue, 'ganadores de U1-1 (forfeit) y U1-2');
  await adm2('/api/admin/qual-results', { method: 'POST', json: { hide: true } });
  // Mappool sin publicar: pool vacío; publicada: con sus mapas
  await adm2('/api/admin/pool', { method: 'POST', json: { round: 'cuartos', slot: 'HD1', beatmap: '112' } });
  await adm2('/api/admin/pool', { method: 'POST', json: { round: 'cuartos', slot: 'NM1', beatmap: '111' } });
  assert.deepEqual((await overlay('?match=u2-1')).body.pool, [], 'antes del showcase de cuartos, sin pool');
  await adm2('/api/admin/pool/release', { method: 'POST', json: { round: 'cuartos', now: true } });
  assert.deepEqual((await overlay('?match=u2-1')).body.pool.map((p) => [p.slot, p.beatmap_id, p.data.title]), [['NM1', 111, 'Titulo 111'], ['HD1', 112, 'Titulo 112']]);
  await adm2('/api/admin/pool/release', { method: 'POST', json: { round: 'cuartos', at: Date.parse('2026-11-22T23:00:00Z') } });
  assert.deepEqual((await overlay('?match=u2-1')).body.pool, []);
  console.log('✓ /api/overlay: partido, cruces públicos, pool publicada, rundown, errores y CORS');

  // Deshacer (solo en la web, sin mandar nada al lobby) y apuntar a mano saltándose las reglas
  const sentBefore = sentTo(CH).length;
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'undo' } });
  assert.equal(r.status, 200);
  await until(() => live.last.flows['u1-3'].picks.length === 2, 'pick deshecho');
  await until(() => readLine(`Deshecho: pick de HD1 (${B}).`), 'deshacer en el chat de la página');
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'ban', slot: 'NM1', by: 'a' } });
  assert.equal(r.status, 400, 'fuera de turno sin forzar');
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'ban', slot: 'NM1', by: 'a', force: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => live.last.flows['u1-3'].bans.length === 3, 'ban forzado');
  await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'undo' } });
  await until(() => live.last.flows['u1-3'].bans.length === 2, 'ban forzado deshecho');
  await until(() => sentTo(CH).includes(`${A} banea NM1.`), 'ban forzado anunciado');
  await new Promise((done) => setTimeout(done, 1500));
  assert.equal(sentTo(CH).filter((t) => !t.startsWith('!')).length, sentTo(CH).slice(0, sentBefore).filter((t) => !t.startsWith('!')).length + 1, 'deshacer no manda nada; el ban forzado sí se anuncia');
  // Chat y comandos del árbitro
  await refc('/api/ref/chat', { method: 'POST', json: { key: 'u1-3', text: '¡Suerte a los dos!' } });
  await until(() => sentTo(CH).includes('¡Suerte a los dos!'), 'mensaje del árbitro');
  await refc('/api/ref/chat', { method: 'POST', json: { key: 'u1-3', text: '¡Suerte a los dos!' } });
  await until(() => sentTo(CH).filter((t) => t === '¡Suerte a los dos!').length === 2, 'lo que escribe el árbitro se manda aunque se repita');
  // Ráfaga: como mucho 8 mensajes cada ventana (300 ms en la prueba) y 18 cada 5 ventanas
  const sent0 = irc.sent.length;
  for (let i = 1; i <= 12; i++) await refc('/api/ref/chat', { method: 'POST', json: { key: 'u1-3', text: `Mensaje ${i}` } });
  await until(() => sentTo(CH).includes('Mensaje 12'), 'ráfaga enviada');
  const burst = irc.sent.slice(sent0).filter((m) => /^Mensaje \d+$/.test(m.text));
  assert.ok(burst[8].at - burst[0].at >= 250, `el 9.º mensaje espera a la ventana (${burst[8].at - burst[0].at} ms)`);
  await until(() => live.last.lobbies[0]?.log.some((x) => x.from === B && x.text === 'hd1'), 'chat del lobby en la página');
  assert.ok(!JSON.stringify(live.last).includes('irc-secreta'), 'la contraseña no viaja a la página');

  // Desconectar: sin Bancho se puede seguir apuntando; al volver se entra de nuevo en el MP
  await refc('/api/ref/disconnect', { method: 'POST', json: {} });
  await until(() => live.last.irc.status === 'off', 'desconectado');
  assert.ok(irc.lines.includes('QUIT'));
  assert.equal((await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'start' } })).status, 409);
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'pick', slot: 'HD1' } });
  assert.equal(r.status, 200, 'apuntar a mano sin IRC');
  await refc('/api/ref/connect', { method: 'POST', json: { password: 'irc-secreta' } });
  irc.settings[CH] = [`Room name: SPI6: (${A}) vs (${B}), History: https://osu.ppy.sh/mp/558`, 'Beatmap: https://osu.ppy.sh/b/104 Artista 104 - Titulo 104',
    `Slot 1  Not Ready https://osu.ppy.sh/u/${f3.a.id} ${A}            [Team Red  ]`, `Slot 2  Ready     https://osu.ppy.sh/u/${f3.b.id} ${B}            [Team Blue ]`];
  r = await refc('/api/ref/attach', { method: 'POST', json: { key: 'u1-3' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => live.last.lobbies.find((l) => l.key === 'u1-3' && !l.closed)?.players.length === 2, 'jugadores leídos de !mp settings');
  const lob = live.last.lobbies.find((l) => l.key === 'u1-3' && !l.closed);
  assert.deepEqual(lob.players.map((p) => [p.name, p.team]), [[A, 'red'], [B, 'blue']]);
  assert.deepEqual(lob.map, { bid: 104, slot: 'HD1', played: false });
  // Empezar de cero: se borra todo lo apuntado del partido (el marcador sigue saliendo del MP)
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'reset' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => live.last.flows['u1-3'].roll === null && !live.last.flows['u1-3'].bans.length, 'partido de cero');
  assert.deepEqual((await anon2('/api/state')).body.matches['u1-3'].bans, []);
  assert.equal((await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'reset' } })).status, 400, 'nada que borrar');

  // osu! solo deja 4 lobbies de torneo abiertos por cuenta
  irc.full = true;
  r = await refc('/api/ref/lobby', { method: 'POST', json: { qual: 'Lobby D' } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /4 lobbies de torneo/);
  irc.full = false;

  // Lobby de clasificatorios: cada mapa lo pone el árbitro con su botón
  r = await refc('/api/ref/lobby', { method: 'POST', json: { qual: 'Lobby C' } });
  assert.deepEqual(r.body, { ok: true, mp: '559', key: 'qual:559' }, JSON.stringify(r.body));
  const QC = '#mp_559';
  await until(() => sentTo(QC).includes('!mp set 0 3 16'), 'HeadToHead');
  await refc('/api/ref/act', { method: 'POST', json: { key: 'qual:559', type: 'qmap', slot: 'NM1' } });
  await until(() => sentTo(QC).includes('!mp map 201 0'), 'primer mapa');
  ircSay(QC, 'BanchoBot', 'The match has finished!');
  await until(() => live.last.lobbies.find((l) => l.key === 'qual:559')?.played.includes('NM1'), 'mapa jugado apuntado');
  await new Promise((done) => setTimeout(done, 300));
  assert.ok(!sentTo(QC).includes('!mp map 202 0'), 'el siguiente mapa no se pone solo');
  await refc('/api/ref/act', { method: 'POST', json: { key: 'qual:559', type: 'qmap', slot: 'NM2' } });
  await until(() => sentTo(QC).includes('!mp map 202 0'), 'siguiente mapa con el botón');
  await until(async () => (await refc('/api/state')).body.qual.lobbies.some((l) => l.mp === 559 && l.name === 'SPI6: (Clasificatorios) Lobby C'), 'lobby leído de osu!');
  r = await anon2('/api/state');
  assert.equal(r.body.matches['u1-3'].mp, 558, 'las seeds no cambian');
  // Un lobby de clasificatorios que no sea head to head con ScoreV2 se avisa; se corrige con el botón
  const setsBefore = sentTo(QC).filter((t) => t === '!mp set 0 3').length;
  ircSay(QC, 'BanchoBot', 'Team mode: HeadToHead, Win condition: ScoreV2');
  ircSay(QC, 'BanchoBot', 'Team mode: TeamVs, Win condition: ScoreV2');
  await until(() => live.last.lobbies.find((l) => l.key === 'qual:559')?.badMode === 'TeamVs con ScoreV2', 'aviso de modo');
  assert.equal(sentTo(QC).filter((t) => t === '!mp set 0 3').length, setsBefore, 'no se corrige solo');
  await refc('/api/ref/act', { method: 'POST', json: { key: 'qual:559', type: 'fixmode' } });
  await until(() => sentTo(QC).filter((t) => t === '!mp set 0 3').length === setsBefore + 1, 'corrige el modo con el botón');
  await until(() => live.last.lobbies.find((l) => l.key === 'qual:559')?.badMode === null, 'aviso quitado');
  ircSay(CH, 'BanchoBot', 'Team mode: TeamVs, Win condition: ScoreV2');
  // Lobby con jugadores apuntados: se crea con sus plazas e invita a los apuntados
  await adm2('/api/admin/qual-slot', { method: 'POST', json: { name: 'Lobby E', time: Date.now() + 3600e3, size: 4 } });
  const slotE = (await anon2('/api/state')).body.qual.slots.find((x) => x.name === 'Lobby E');
  await adm2('/api/admin/qual-slot/assign', { method: 'POST', json: { id: slotE.id, user: 601 } });
  await until(() => live.last.slots?.some((x) => x.id === slotE.id && x.signed === 1), 'el árbitro ve los apuntados');
  assert.equal((await p01('/api/ref/lobby', { method: 'POST', json: { slot: slotE.id } })).status, 403);
  assert.equal((await refc('/api/ref/lobby', { method: 'POST', json: { slot: 999999 } })).status, 404);
  r = await refc('/api/ref/lobby', { method: 'POST', json: { slot: slotE.id } });
  assert.deepEqual(r.body, { ok: true, mp: '560', key: 'qual:560' }, JSON.stringify(r.body));
  const QE = '#mp_560';
  await until(() => sentTo(QE).includes('!mp invite #601'), 'invita a los apuntados');
  assert.ok(sentTo(QE).includes('!mp set 0 3 4'), 'HeadToHead con las plazas del lobby');
  assert.ok(irc.sent.some((m) => m.to === 'BanchoBot' && m.text === '!mp make SPI6: (Clasificatorios) Lobby E'));
  r = (await refc('/api/state')).body.qual.slots.find((x) => x.id === slotE.id);
  assert.deepEqual([r.mp, r.ref_id, r.ref_name], [560, 503, 'Jugador C'], 'quien lo abre queda como su árbitro');
  assert.equal((await anon2('/api/state')).body.qual.slots.find((x) => x.id === slotE.id).mp, null, 'el público no ve el MP del lobby');
  r = await refc('/api/ref/lobby', { method: 'POST', json: { slot: slotE.id } });
  assert.equal(r.status, 409, 'ese lobby ya está creado');
  assert.match(r.body.error, /ya tiene el MP #560/);
  // Quien se apunta después se invita con un botón; a quien ya está dentro no se le vuelve a invitar
  await adm2('/api/admin/qual-slot/assign', { method: 'POST', json: { id: slotE.id, user: 602 } });
  ircSay(QE, 'BanchoBot', 'P01 joined in slot 1.');
  const invites = () => sentTo(QE).filter((t) => t.startsWith('!mp invite')).length;
  await until(async () => { const p = live.last.lobbies.find((l) => l.key === 'qual:560'); return p?.players.length === 1; }, 'P01 en el lobby');
  const inv0 = invites();
  assert.equal((await refc('/api/ref/act', { method: 'POST', json: { key: 'qual:560', type: 'qinvite' } })).status, 200);
  await until(() => sentTo(QE).includes('!mp invite #602'), 'invita a quien falta');
  assert.equal(invites(), inv0 + 1, 'no vuelve a invitar a quien ya está');
  assert.equal((await refc('/api/ref/act', { method: 'POST', json: { key: 'qual:559', type: 'qinvite' } })).status, 400, 'lobby sin apuntados');
  // Quien se apunta y no está aprobado no se invita; al aprobarlo, sí
  const p03 = await login(s2.base, 603);
  // En esta parte el reloj del servidor va adelantado: el lobby tiene que seguir sin empezar
  await adm2('/api/admin/qual-slot', { method: 'POST', json: { id: slotE.id, name: 'Lobby E', time: Date.now() + 5 * 365 * 86400e3, size: 4 } });
  assert.equal((await p03('/api/qual/signup', { method: 'POST', json: { slot: slotE.id } })).status, 200);
  await until(() => live.last.slots?.some((x) => x.id === slotE.id && x.pending === 1), 'el árbitro ve la plaza pendiente');
  assert.equal((await refc('/api/ref/act', { method: 'POST', json: { key: 'qual:560', type: 'qinvite' } })).status, 200);
  await new Promise((done) => setTimeout(done, 400));
  assert.ok(!sentTo(QE).includes('!mp invite #603'), 'sin aprobar no se invita');
  // Quien ya tiene scores de clasificatorios (603 jugó el MP 901) queda aprobado al leer los MP, aunque nadie lo aprobara
  assert.equal((await adm2('/api/admin/qual', { method: 'POST', json: { mp: '901' } })).status, 200);
  await until(() => live.last.slots?.some((x) => x.id === slotE.id && x.pending === 0), 'aprobado solo por haber jugado');
  assert.equal((await refc('/api/ref/qual-signup/approve', { method: 'POST', json: { user: 603 } })).status, 404, 'ya no está pendiente');
  assert.equal((await refc('/api/ref/act', { method: 'POST', json: { key: 'qual:560', type: 'qinvite' } })).status, 200);
  await until(() => sentTo(QE).includes('!mp invite #603'), 'aprobado, se invita');
  // Estado del lobby: sin estado antes de su hora, jugándose con el MP abierto y terminado al cerrarlo
  const stateE = async () => (await anon2('/api/state')).body.qual.slots.find((x) => x.id === slotE.id).state;
  assert.equal(await stateE(), null, 'aún no ha empezado');
  await adm2('/api/admin/qual-slot', { method: 'POST', json: { id: slotE.id, name: 'Lobby E', time: (await anon2('/api/state')).body.now - 60e3, size: 4 } });
  assert.equal(await stateE(), 'live', 'empezado y con MP: se está jugando');
  assert.equal((await refc('/api/ref/act', { method: 'POST', json: { key: 'qual:560', type: 'close' } })).status, 200);
  await until(async () => (await stateE()) === 'done', 'al cerrarlo sale como terminado');
  // Corrección a mano de los árbitros: el estado del lobby y las plazas, en cualquier momento
  const slotOf = async () => (await anon2('/api/state')).body.qual.slots.find((x) => x.id === slotE.id);
  assert.equal((await refc('/api/ref/qual-slot/state', { method: 'POST', json: { id: slotE.id, state: 'live' } })).status, 200);
  assert.deepEqual([(await slotOf()).state, (await slotOf()).manual], ['live', true], 'puesto a mano: manda sobre el automático');
  assert.equal((await refc('/api/ref/qual-slot/state', { method: 'POST', json: { id: slotE.id, state: 'jugando' } })).status, 400, 'estado no válido');
  assert.equal((await p03('/api/ref/qual-slot/state', { method: 'POST', json: { id: slotE.id, state: 'done' } })).status, 403, 'solo árbitros');
  assert.equal((await refc('/api/ref/qual-slot/state', { method: 'POST', json: { id: slotE.id, state: 'auto' } })).status, 200);
  assert.deepEqual([(await slotOf()).state, (await slotOf()).manual], ['done', false], 'de vuelta al automático');
  assert.ok(!(await slotOf()).pending.includes(603));
  r = await refc('/api/ref/qual-signup/state', { method: 'POST', json: { user: 603, approved: false } });
  assert.equal(r.status, 409, 'quien ha jugado no puede volver a pendiente');
  assert.match(r.body.error, /ya ha jugado/i);
  assert.ok(!(await slotOf()).pending.includes(603));
  assert.ok((await refc('/api/state')).body.qualPlayed.includes(603), 'el árbitro sabe quién ha jugado');
  assert.equal((await anon2('/api/state')).body.qualPlayed, undefined, 'el público no');
  assert.equal((await p03('/api/ref/qual-signup/state', { method: 'POST', json: { user: 603, approved: true } })).status, 403, 'solo árbitros');
  assert.equal((await refc('/api/ref/qual-signup/state', { method: 'POST', json: { user: 603, approved: true } })).status, 200);
  assert.equal((await refc('/api/ref/qual-signup/state', { method: 'POST', json: { user: 9999, approved: true } })).status, 404, 'sin plaza');
  // Anti-spam de Bancho: los comandos repetibles llevan una palabra distinta cada vez; el resto, tal cual
  const cmds = irc.sent.filter((m) => /^!mp (settings|close|abort|aborttimer|start|timer|map|mods|set)\b/.test(m.text));
  assert.ok(cmds.length > 10 && cmds.every((m) => m.tagged), 'comandos con palabra al azar');
  const starts = irc.sent.filter((m) => m.text === '!mp start 5').map((m) => m.raw);
  assert.ok(starts.length >= 2 && new Set(starts).size === starts.length, '«!mp start 5» nunca sale igual dos veces');
  assert.ok(irc.sent.filter((m) => /^!mp (make|invite|team) /.test(m.text)).every((m) => !m.tagged), 'make, invite y team sin palabra');
  // Límite de Bancho en toda la prueba, también al reconectar: ≤ 8 en cualquier ventana de 300 ms y ≤ 18 en 1.500 ms
  // (con margen: aquí se mide cuándo llega cada mensaje, no cuándo sale)
  const ts = irc.sent.map((m) => m.at);
  assert.ok(ts.every((t, i) => i < 8 || t - ts[i - 8] >= 250), 'respeta 8 por ventana');
  assert.ok(ts.every((t, i) => i < 18 || t - ts[i - 18] >= 1400), 'respeta 18 por 5 ventanas');

  // ---------- Completar después del partido (U1-4, arbitrado sin los botones) ----------
  // Bo9 con 1 protect y 2 bans por jugador, la segunda tanda tras 4 mapas. Pool de 12 mapas y TB.
  for (const [slot, bid] of [['NM3', 107], ['NM4', 108], ['HD2', 109], ['HR2', 110], ['DT2', 111], ['FM2', 112], ['TB', 113]]) {
    assert.equal((await adm2('/api/admin/pool', { method: 'POST', json: { round: 'octavos', slot, beatmap: String(bid) } })).status, 200);
  }
  await adm2('/api/admin/rules', { method: 'POST', json: { round: 'octavos', bans: 2, protects: 1, banEvery: 4, pickTimer: 90 } });
  const f4 = live.last.flows['u1-4'];
  players561 = [f4.a.id, f4.b.id];
  r = await adm2('/api/admin/match', { method: 'POST', json: { id: 'u1-4', time: Date.now() - 3600e3, mp: '561' } });
  assert.deepEqual(r.body.result.wins, { [f4.a.id]: 5, [f4.b.id]: 4 }, JSON.stringify(r.body));
  await until(() => live.last.flows['u1-4'].step === 'done' && live.last.flows['u1-4'].fillSuggested, 'se sugiere completar el partido');
  assert.deepEqual(live.last.flows['u1-4'].maps.map((x) => x.slot), ['NM2', 'HD2', 'FM1', 'HR2', 'NM1', 'HD1', 'DT2', 'NM4', 'TB'], 'sin el warmup');
  const fill = (json) => refc('/api/ref/act', { method: 'POST', json: { key: 'u1-4', type: 'complete', ...json } });
  const good = { protect: 'a', ban: 'b', pick: 'a', protects: 'NM1, HD1', bans: 'dt1, HR1, NM3, FM2', picks: ['NM2', 'HD2', 'FM1', 'HR2', 'NM1', 'HD1', 'DT2', 'NM4'] };
  const sent4 = irc.sent.length;
  const overlay4 = async () => (await anon2('/api/overlay?match=u1-4')).body.rundown;
  // Permisos: un jugador no puede; un árbitro que juega el partido, tampoco
  assert.equal((await p01('/api/ref/act', { method: 'POST', json: { key: 'u1-4', type: 'complete', ...good } })).status, 403, 'un jugador no puede');
  assert.equal((await anon2('/api/ref/act', { method: 'POST', json: { key: 'u1-4', type: 'complete', ...good } })).status, 401);
  await adm2('/api/admin/role', { method: 'POST', json: { user: String(f4.b.id), role: 'referee' } });
  r = await (await login(s2.base, f4.b.id))('/api/ref/act', { method: 'POST', json: { key: 'u1-4', type: 'complete', ...good } });
  assert.equal(r.status, 403, 'quien juega el partido no lo completa');
  await adm2('/api/admin/role', { method: 'POST', json: { id: f4.b.id, role: '' } });
  // Casos inválidos: se explica el error y no se guarda nada
  for (const [bad, re] of [
    [{ bans: 'DT1, HR1, NM3, DT2' }, /Ban 4 \(DT2\): mismo mod que su ban anterior/],
    [{ bans: 'NM1, HR1, NM3, FM2' }, /Ban 1 \(NM1\): está protegido/],
    [{ bans: 'DT1, HR1' }, /Faltan bans: tras 4 mapas tocaba la tanda 2/],
    [{ protects: 'NM1' }, /Faltan protects/],
    [{ picks: [...good.picks, 'FM2'] }, /FM2 no se jugó en el MP/],
    [{ picks: good.picks.slice(0, 7) }, /Faltan picks/],
    [{ protects: 'NM1, NM1' }, /Protect 2 \(NM1\): ya está protegido/],
    [{ pick: 'x' }, /Elige quién protege/]
  ]) {
    r = await fill({ ...good, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.body.error, re);
  }
  assert.deepEqual(await overlay4(), [], 'nada guardado tras los errores');
  assert.deepEqual((await anon2('/api/state')).body.matches['u1-4'].bans, []);
  // Bien: el rundown en el orden real, con la segunda tanda (ABBA) tras 4 mapas y el TB al final
  r = await fill(good);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const RED = 'RED', BLUE = 'BLUE';
  assert.deepEqual(await overlay4(), [
    { actor: RED, action: 'PROTECT', pick: 'NM1' }, { actor: BLUE, action: 'PROTECT', pick: 'HD1' },
    { actor: BLUE, action: 'BAN', pick: 'DT1' }, { actor: RED, action: 'BAN', pick: 'HR1' },
    { actor: RED, action: 'PICK', pick: 'NM2' }, { actor: BLUE, action: 'PICK', pick: 'HD2' }, { actor: RED, action: 'PICK', pick: 'FM1' }, { actor: BLUE, action: 'PICK', pick: 'HR2' },
    { actor: RED, action: 'BAN', pick: 'NM3' }, { actor: BLUE, action: 'BAN', pick: 'FM2' },
    { actor: RED, action: 'PICK', pick: 'NM1' }, { actor: BLUE, action: 'PICK', pick: 'HD1' }, { actor: RED, action: 'PICK', pick: 'DT2' }, { actor: BLUE, action: 'PICK', pick: 'NM4' },
    { actor: null, action: 'PICK', pick: 'TB' }
  ], 'rundown completado después del partido');
  assert.equal(irc.sent.length, sent4, 'no se manda nada a Bancho');
  r = (await anon2('/api/state')).body.matches['u1-4'];
  assert.deepEqual(r.bans, ['DT1', 'HR1', 'NM3', 'FM2'], 'bans para la tarjeta y las estadísticas');
  assert.deepEqual(r.protects, ['NM1', 'HD1']);
  assert.deepEqual(r.by, { protect: { NM1: 'a', HD1: 'b' }, ban: { DT1: 'b', HR1: 'a', NM3: 'a', FM2: 'b' } }, 'quién hizo cada protect y ban');
  await until(() => live.last.flows['u1-4'].fillSuggested === false && live.last.flows['u1-4'].canFill, 'ya no se sugiere');
  // Con acciones ya apuntadas hay que confirmar la sustitución
  r = await fill({ ...good, ban: 'a', bans: 'HR1, DT1, FM2, NM3' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /ya tiene 15 pasos apuntados/);
  assert.equal((await overlay4())[2].pick, 'DT1', 'sin confirmar no cambia nada');
  r = await fill({ ...good, ban: 'a', bans: 'HR1, DT1, FM2, NM3', replace: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await overlay4()).filter((x) => x.action === 'BAN').map((x) => [x.actor, x.pick]), [[RED, 'HR1'], [BLUE, 'DT1'], [BLUE, 'FM2'], [RED, 'NM3']], 'sustituido: banea primero rojo');
  // Un partido sin terminar no se completa
  assert.equal((await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-5', type: 'complete', ...good } })).status, 400);
  console.log('✓ completar después del partido: rundown con las reglas de la ronda, errores sin guardar, sustituir con confirmación y permisos');

  // ---------- Bot de arbitraje por fases: AUTO, SEMI, cambio de modo, ausencias, errores y advertencias ----------
  // Los temporizadores del bot van 20 veces más rápido en este servidor (REF_TIME_SCALE = 0,05).
  irc.nextMp = 600;
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const untilLong = async (cond, what, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await cond()) return; await sleep(80); }
    throw new Error('No llegó a pasar: ' + what);
  };
  const botAct = (key, json, who = refc) => who('/api/ref/act', { method: 'POST', json: { key, type: 'bot', ...json } });
  const botOf = (key) => live.last.flows[key]?.bot;
  const lobbyKey = (key) => live.last.lobbies.find((l) => l.key === key && !l.closed);
  const setRules = (extra) => adm2('/api/admin/rules', { method: 'POST', json: { round: 'octavos', bans: 2, protects: 1, banEvery: 4, pickTimer: 0, readyTimer: 300, absentLimit: 15, reinviteEvery: 60, maxWarnings: 3, ...extra } });
  assert.equal((await setRules()).status, 200);

  // Guion de un partido: lo que tiene que mandar el bot, paso a paso. En SEMI, antes de cada paso se comprueba que
  // no ha salido nada sin pulsar y se pulsa el botón que lleva ese texto; en AUTO solo se espera a que salga.
  function script(key, CH, semi) {
    const g = { key, CH, semi, cur: 0, presses: 0 };
    const hit = (line) => (t) => (typeof line === 'string' ? t === line : line.test(t));
    const seen = async (line) => {
      let i = -1;
      await untilLong(() => (i = sentTo(CH).findIndex((t, k) => k >= g.cur && hit(line)(t))) >= 0, `${key}: el bot manda «${line}»`, 10000);
      g.cur = i + 1;
    };
    g.out = async (lines) => {
      if (g.semi) {
        const n0 = sentTo(CH).length;
        await sleep(150);
        assert.equal(sentTo(CH).length, n0, `${key} en SEMI: nada sale sin pulsar (antes de «${lines[0]}»)`);
        let a;
        await untilLong(() => (a = botOf(key)?.actions.find((x) => x.out.some(hit(lines[0])))), `${key}: botón que manda «${lines[0]}»`, 6000);
        r = await botAct(key, { do: 'run', id: a.id });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        g.presses++;
      }
      for (const line of lines) await seen(line);
    };
    g.saw = seen; // lo que manda un botón de siempre (Apuntar a mano), no el bot
    g.press = async (prefix) => { // paso que no manda nada (Warmup terminado): en SEMI se pulsa; en AUTO lo hace el bot
      if (!g.semi) return;
      let a;
      await untilLong(() => (a = botOf(key)?.actions.find((x) => x.id.startsWith(prefix))), `${key}: botón ${prefix}`, 6000);
      r = await botAct(key, { do: 'run', id: a.id });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    };
    g.mode = async (mode) => {
      r = await botAct(key, { do: 'mode', mode });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      g.semi = mode === 'semi';
      await untilLong(() => botOf(key)?.mode === mode, 'modo ' + mode);
    };
    return g;
  }
  const MODS = { NM: 'NF', HD: 'NF HD', HR: 'NF HR', DT: 'NF DT', FM: 'Freemod' };
  const BID = { NM1: 101, NM2: 102, FM1: 103, HD1: 104, HR1: 105, DT1: 106, NM3: 107, NM4: 108, HD2: 109, HR2: 110, DT2: 111, FM2: 112, TB: 113 };
  // Partido completo: lobby (con un intruso), warmup de A, rolls (uno no válido y un empate), orden a mano, protects
  // y bans con códigos no válidos, picks (uno repetido) y 5 mapas hasta el 0 – 5 de B, con la segunda tanda de bans.
  async function fullMatch(g, f, mp, hooks = {}) {
    const A = f.a.username, B = f.b.username, ids = { a: f.a.id, b: f.b.id }, CH = g.CH;
    const nm = { a: A, b: B };
    gamesN[mp] = [];
    await g.out(['!mp set 2 3 2']);
    await g.out([/^!mp password [0-9a-f]{10}$/]);
    await g.out([`!mp invite #${ids.a}`, `!mp invite #${ids.b}`]);
    ircSay(CH, 'BanchoBot', 'Mirón joined in slot 3.');
    ircSay(CH, 'BanchoBot', `${A} joined in slot 1 for team red.`);
    ircSay(CH, 'BanchoBot', `${B} joined in slot 2 for team blue.`);
    if (!g.semi) { // con alguien más en el lobby, también en AUTO la expulsión la confirma el árbitro
      let a;
      await untilLong(() => (a = botOf(g.key)?.actions.find((x) => x.id === 'lobby:confirm')), 'confirmar jugadores');
      assert.equal(a.auto, false, 'el bot no expulsa solo');
      assert.match(botOf(g.key).waitRef, /Hay alguien más en el lobby \(Mirón\)/);
      await sleep(300);
      assert.ok(!sentTo(CH).some((t) => t.startsWith('!mp kick')), 'sin confirmar no expulsa');
      r = await botAct(g.key, { do: 'run', id: 'lobby:confirm' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    await g.out([`!mp team #${ids.a} red`, `!mp team #${ids.b} blue`, '!mp kick Mirón']);
    // WARMUP: A sí (se detecta el fin de su mapa), B no
    await g.out([`${A}, ¿quieres warmup? Responde «sí» o «no» en el chat.`]);
    ircSay(CH, A, 'sí');
    await g.out([`!mp host #${ids.a}`, `${A}: tienes el host. Elige tu warmup y empiézalo cuando quieras.`]);
    ircSay(CH, 'BanchoBot', 'Changed beatmap to https://osu.ppy.sh/b/999 Warmup');
    ircSay(CH, 'BanchoBot', 'The match has started!');
    ircSay(CH, 'BanchoBot', 'The match has finished!');
    await g.press('wu:end:a');
    await g.out([`${B}, ¿quieres warmup? Responde «sí» o «no» en el chat.`]);
    ircSay(CH, B, 'no');
    await g.out(['!mp clearhost']);
    await g.out(['!mp set 2 3 2', `!mp team #${ids.a} red`, `!mp team #${ids.b} blue`]);
    // ROLL de protects: «!roll 1000» no vale, empate a 40, gana B 80 – 30
    await g.out(['Roll para los protects: haced !roll los dos (solo «!roll», sin número). Gana el más alto.']);
    ircSay(CH, A, '!roll 1000');
    ircSay(CH, 'BanchoBot', `${A} rolls 734 point(s)`);
    await g.out([`${A}: solo vale «!roll», sin número. Repítelo.`]);
    for (const [who, n] of [[A, 40], [B, 40]]) { ircSay(CH, who, '!roll'); ircSay(CH, 'BanchoBot', `${who} rolls ${n} point(s)`); }
    await g.out(['Empate a 40. Repetid el !roll los dos.']);
    for (const [who, n] of [[A, 30], [B, 80]]) { ircSay(CH, who, '!roll'); ircSay(CH, 'BanchoBot', `${who} rolls ${n} point(s)`); }
    await g.out([`${B} gana el roll (80 – 30) y elige quién protege primero.`]);
    await g.out([`${B}: di en el chat quién protege primero.`]);
    await untilLong(() => botOf(g.key)?.waitRef?.includes('Apúntalo en «Orden»'), 'el bot espera al árbitro para el orden');
    assert.deepEqual(live.last.flows[g.key].roll, { winner: 'b', a: 30, b: 80 });
    r = await refc('/api/ref/act', { method: 'POST', json: { key: g.key, type: 'order', protect: 'a' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await g.saw(`Protege primero ${A}.`);
    await untilLong(() => botOf(g.key)?.log.some((x) => x.by === 'Jugador C' && x.text === `A mano: Protege primero ${A}.`), 'lo apuntado a mano también va al log');
    // PROTECT: B escribe fuera de turno (se ignora), A un mapa que no existe, B uno ya protegido
    await g.out([`${A}, protege un mapa: escríbelo en el chat (p. ej. NM2).`]);
    ircSay(CH, B, 'nm2');
    ircSay(CH, A, 'xx9');
    await g.out([`${A}: XX9 no vale (no está en la mappool). Escribe otro mapa.`]);
    ircSay(CH, A, 'nm1');
    await g.out([`${A} protege NM1.`]);
    await g.out([`${B}, protege un mapa: escríbelo en el chat (p. ej. NM2).`]);
    ircSay(CH, B, 'NM1');
    await g.out([`${B}: NM1 no vale (ya está protegido). Escribe otro mapa.`]);
    ircSay(CH, B, 'hd 1');
    await g.out([`${B} protege HD1.`]);
    // ROLL de bans y picks, tras los protects: gana A 70 – 20 y elige el orden (lo apunta el árbitro)
    await g.out(['Roll para bans y picks: haced !roll los dos (solo «!roll», sin número). Gana el más alto.']);
    for (const [who, n] of [[A, 70], [B, 20]]) { ircSay(CH, who, '!roll'); ircSay(CH, 'BanchoBot', `${who} rolls ${n} point(s)`); }
    await g.out([`${A} gana el roll (70 – 20) y elige quién banea primero y quién elige primero.`]);
    await g.out([`${A}: di en el chat quién banea primero y quién elige primero.`]);
    await untilLong(() => botOf(g.key)?.waitRef?.includes('quién banea primero y quién elige primero. Apúntalo en «Orden»'), 'el bot espera al árbitro para el orden de bans y picks');
    assert.deepEqual([live.last.flows[g.key].roll, live.last.flows[g.key].roll2], [{ winner: 'b', a: 30, b: 80 }, { winner: 'a', a: 70, b: 20 }], 'dos rolls');
    r = await refc('/api/ref/act', { method: 'POST', json: { key: g.key, type: 'order', ban: 'b', pick: 'b' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await g.saw(`Banea primero ${B} y elige primero ${B}.`);
    await hooks.ban?.();
    // BAN, tanda 1 (abre B): no se puede banear un mapa protegido
    await g.out([`${B}, banea un mapa (tanda 1 de 2): escríbelo en el chat (p. ej. NM2).`]);
    ircSay(CH, B, 'nm1');
    await g.out([`${B}: NM1 no vale (está protegido). Escribe otro mapa.`]);
    ircSay(CH, B, 'dt1');
    await g.out([`${B} banea DT1.`]);
    await g.out([`${A}, banea un mapa (tanda 1 de 2): escríbelo en el chat (p. ej. NM2).`]);
    ircSay(CH, A, 'hr1');
    await g.out([`${A} banea HR1.`]);
    // PICK → READY → PLAY
    const pick = async (by, slot, k, bad) => {
      await g.out([`${nm[by]}, elige mapa: escríbelo en el chat (p. ej. NM2).`]);
      if (k === 0) await hooks.firstPick?.();
      if (bad) {
        ircSay(CH, nm[by], bad.toLowerCase());
        await g.out([`${nm[by]}: ${bad} no vale (ya se ha elegido). Escribe otro mapa.`]);
      }
      ircSay(CH, nm[by], slot.toLowerCase());
      await g.out([`${nm[by]} elige ${slot}: Artista ${BID[slot]} - Titulo ${BID[slot]} [Insane].`]);
      await g.out([`!mp map ${BID[slot]} 0`, `!mp mods ${MODS[slot.slice(0, 2)]}`]);
      await g.out([new RegExp(`^${slot}: Artista ${BID[slot]} .*Pulsad Ready cuando estéis listos \\(300 s\\)\\.$`), '!mp timer 300']);
      ircSay(CH, 'BanchoBot', 'All players are ready');
      await g.out(['!mp aborttimer', '!mp start 5']);
      ircSay(CH, 'BanchoBot', 'The match has started!');
      gamesN[mp].push(game(BID[slot], [[ids.a, 500000], [ids.b, 900000]]));
      ircSay(CH, 'BanchoBot', 'The match has finished!');
      if (k < 4) await g.out([new RegExp(`^${slot}: 500\\.000 – 900\\.000\\. Marcador: ${A} 0 – ${k + 1} ${B}${k === 3 ? ' · Match point' : ''}$`)]);
    };
    await pick('b', 'NM2', 0);
    await pick('a', 'FM1', 1, 'NM2');
    await pick('b', 'HD2', 2);
    await pick('a', 'NM3', 3);
    // Segunda tanda de bans tras 4 mapas, en orden ABBA: la abre A
    await g.out([`${A}, banea un mapa (tanda 2 de 2): escríbelo en el chat (p. ej. NM2).`]);
    ircSay(CH, A, 'nm4');
    await g.out([`${A} banea NM4.`]);
    await g.out([`${B}, banea un mapa (tanda 2 de 2): escríbelo en el chat (p. ej. NM2).`]);
    ircSay(CH, B, 'fm2');
    await g.out([`${B} banea FM2.`]);
    await pick('b', 'HR2', 4);
    await g.out([`${B} gana el partido 5 – 0. ¡GG!`]);
    await untilLong(() => botOf(g.key)?.phase === 'FIN' && botOf(g.key)?.stage === 'fin', 'partido terminado en el bot');
    return [
      ['RED', 'PROTECT', 'NM1'], ['BLUE', 'PROTECT', 'HD1'], ['BLUE', 'BAN', 'DT1'], ['RED', 'BAN', 'HR1'],
      ['BLUE', 'PICK', 'NM2'], ['RED', 'PICK', 'FM1'], ['BLUE', 'PICK', 'HD2'], ['RED', 'PICK', 'NM3'],
      ['RED', 'BAN', 'NM4'], ['BLUE', 'BAN', 'FM2'], ['BLUE', 'PICK', 'HR2']
    ].map(([actor, action, pick]) => ({ actor, action, pick }));
  }

  // Permisos: solo árbitros y admins, y nadie en su propio partido
  const f5 = live.last.flows['u1-5'];
  assert.equal((await botAct('u1-5', { do: 'mode', mode: 'auto' }, p01)).status, 403, 'un jugador no puede cambiar el modo');
  assert.equal((await botAct('u1-5', { do: 'start' }, p01)).status, 403, 'ni iniciar el partido');
  assert.equal((await botAct('u1-5', { do: 'pause' }, anon2)).status, 401);
  await adm2('/api/admin/role', { method: 'POST', json: { user: String(f5.a.id), role: 'referee' } });
  r = await botAct('u1-5', { do: 'mode', mode: 'auto' }, await login(s2.base, f5.a.id));
  assert.equal(r.status, 403, 'quien juega el partido no lleva su bot');
  await adm2('/api/admin/role', { method: 'POST', json: { id: f5.a.id, role: '' } });
  assert.equal(live.last.flows['u1-5'].bot.mode, 'semi', 'sigue en SEMI');

  // AUTO, U1-5 (MP 600): en AUTO el partido empieza solo a su hora (A0) y el bot lo lleva entero
  r = await botAct('u1-5', { do: 'mode', mode: 'auto' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await untilLong(() => botOf('u1-5')?.mode === 'auto', 'modo AUTO');
  await sleep(400);
  assert.ok(!irc.sent.some((m) => m.to === 'BanchoBot' && m.text.includes(`(${f5.a.username}) vs (${f5.b.username})`)), 'antes de su hora no empieza');
  const serverNow = (await anon2('/api/state')).body.now;
  await adm2('/api/admin/match', { method: 'POST', json: { id: 'u1-5', time: serverNow - 60e3 } });
  await untilLong(() => irc.sent.some((m) => m.to === 'BanchoBot' && m.text === `!mp make SPI6: (${f5.a.username}) vs (${f5.b.username})`), 'crea el lobby a la hora del partido');
  const g5 = script('u1-5', '#mp_600', false);
  const rundown5 = await fullMatch(g5, f5, 600);
  assert.deepEqual((await anon2('/api/overlay?match=u1-5')).body.rundown, rundown5, '/api/overlay con el rundown del bot');
  r = (await anon2('/api/state')).body.matches['u1-5'];
  assert.deepEqual([r.mp, r.bans, r.protects, r.ff], [600, ['DT1', 'HR1', 'NM4', 'FM2'], ['NM1', 'HD1'], null]);
  assert.ok(botOf('u1-5').log.some((x) => x.by === 'bot' && x.text === `Apuntar ban de FM2 (${f5.b.username})`), 'log con hora y quién hizo cada paso');
  console.log('✓ bot en AUTO: partido completo (lobby, warmups, rolls, protects, bans, picks, ready, mapas y fin), errores rechazados con su motivo y /api/overlay');

  // SEMI, U1-6 (MP 601): el mismo partido avanzando solo con botones; a mitad pasa a AUTO (bans) y vuelve a SEMI (picks)
  const f6 = live.last.flows['u1-6'];
  r = await botAct('u1-6', { do: 'start' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await botAct('u1-6', { do: 'start' })).status, 409, 'iniciar dos veces no hace nada');
  await untilLong(() => botOf('u1-6')?.step === 'A2', 'A2: crear el lobby');
  await sleep(300);
  assert.ok(!irc.sent.some((m) => m.to === 'BanchoBot' && m.text.includes(`(${f6.a.username}) vs`)), 'en SEMI no crea el lobby sin pulsar');
  r = await botAct('u1-6', { do: 'run', id: 'lobby:make' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const g6 = script('u1-6', '#mp_601', true);
  const rundown6 = await fullMatch(g6, f6, 601, {
    ban: () => g6.mode('auto'),       // SEMI → AUTO: el bot sigue solo desde el turno de bans
    firstPick: () => g6.mode('semi')  // AUTO → SEMI con el bot esperando el pick: vuelven los botones
  });
  assert.ok(g6.presses > 30, `en SEMI cada paso se ha pulsado (${g6.presses})`);
  const count = (re) => sentTo('#mp_601').filter((t) => re.test(t)).length;
  assert.deepEqual([count(/, protege un mapa/), count(/, banea un mapa/), count(/, elige mapa/), count(/^!mp map \d+ 0$/), count(/^!mp start 5$/)], [2, 4, 5, 5, 5], 'cambiar de modo no pierde ni repite pasos');
  assert.deepEqual((await anon2('/api/overlay?match=u1-6')).body.rundown, rundown6);
  console.log('✓ bot en SEMI: nada sale al lobby sin pulsar, y cambio de modo a mitad de partido en los dos sentidos');

  // Ausencia, U1-7 (MP 602): reinvitación cada 15 s (0,75 s aquí) y aviso a los 1 min (3 s aquí). No se da por perdido.
  const f7 = live.last.flows['u1-7'], CH7 = '#mp_602';
  const A7 = f7.a.username, B7 = f7.b.username;
  assert.equal((await setRules({ absentLimit: 1, reinviteEvery: 15 })).status, 200);
  await botAct('u1-7', { do: 'mode', mode: 'auto' });
  r = await botAct('u1-7', { do: 'start' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await untilLong(() => sentTo(CH7).includes(`!mp invite #${f7.b.id}`), 'invitaciones de U1-7');
  ircSay(CH7, 'BanchoBot', `${A7} joined in slot 1 for team red.`);
  const inv7 = () => sentTo(CH7).filter((t) => t === `!mp invite #${f7.b.id}`).length;
  await untilLong(() => inv7() >= 3, 'reinvita al ausente');
  assert.equal(sentTo(CH7).filter((t) => t === `!mp invite #${f7.a.id}`).length, 1, 'a quien ya está no se le reinvita');
  await untilLong(() => botOf('u1-7')?.incidents.some((i) => i.open && i.kind === 'absent'), 'aviso de ausencia');
  assert.match(botOf('u1-7').incidents.find((i) => i.kind === 'absent').text, new RegExp(`^${B7} no ha llegado al lobby en 1 min\\. Avisa al staff`));
  assert.equal(botOf('u1-7').blocked, true, 'el bot espera al árbitro');
  const invAt = inv7();
  await sleep(1500);
  assert.equal(inv7(), invAt, 'con el aviso abierto no hace nada solo');
  r = (await anon2('/api/state')).body.matches['u1-7'];
  assert.equal(r.ff, null, 'el bot no da el partido por perdido');
  assert.ok(!sentTo(CH7).some((t) => /^!mp (close|abort)/.test(t)));
  const inc7 = botOf('u1-7').incidents.find((i) => i.open);
  r = await botAct('u1-7', { do: 'resolve', id: inc7.id, how: 'wait' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await botAct('u1-7', { do: 'resolve', id: inc7.id })).status, 409, 'resolver dos veces');
  await untilLong(() => inv7() > invAt, 'seguir esperando: vuelve a reinvitar');
  ircSay(CH7, 'BanchoBot', `${B7} joined in slot 2 for team blue.`);
  await untilLong(() => sentTo(CH7).includes(`${A7}, ¿quieres warmup? Responde «sí» o «no» en el chat.`), 'con los dos, al warmup');
  console.log('✓ bot: jugador ausente, reinvitaciones y aviso al staff a los minutos de la regla, sin forfeit automático');

  // Pick sin elegir y ready sin pulsar, U1-7: en SEMI se saltan los warmups y se apunta a mano hasta los picks
  r = await botAct('u1-7', { do: 'mode', mode: 'semi' });
  assert.equal(r.status, 200);
  await untilLong(() => botOf('u1-7')?.mode === 'semi', 'U1-7 en SEMI');
  for (let i = 0; i < 6 && botOf('u1-7').stage !== 'match'; i++) {
    const at = botOf('u1-7').at;
    r = await botAct('u1-7', { do: 'skip', at });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await untilLong(() => botOf('u1-7')?.at !== at, 'paso siguiente tras saltar');
  }
  assert.ok(botOf('u1-7').log.some((x) => x.text === `Saltado: Sin warmup de ${B7}`), 'el salto queda en el log');
  assert.equal(botOf('u1-7').stage, 'match', 'warmups saltados');
  r = await botAct('u1-7', { do: 'skip', at: 'otro:paso' });
  assert.equal(r.status, 409, 'saltar un paso que ya no es el actual');
  for (const json of [{ type: 'roll', winner: 'a' }, { type: 'order', protect: 'a' }, { type: 'protect', slot: 'NM1' }, { type: 'protect', slot: 'HD1' }, { type: 'roll', winner: 'a' }, { type: 'order', ban: 'a', pick: 'a' }, { type: 'ban', slot: 'DT1' }, { type: 'ban', slot: 'HR1' }]) {
    r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-7', ...json } });
    assert.equal(r.status, 200, JSON.stringify(json) + JSON.stringify(r.body));
  }
  await untilLong(() => botOf('u1-7')?.phase === 'PICK', 'turno de pick');
  r = await botAct('u1-7', { do: 'skip', at: botOf('u1-7').at });
  assert.equal(r.status, 200, 'anunciar el turno se puede saltar');
  await untilLong(() => botOf('u1-7')?.step === 'F3', 'esperando el pick');
  r = await botAct('u1-7', { do: 'skip', at: botOf('u1-7').at });
  assert.equal(r.status, 400, 'esperar el pick de un jugador no se salta');
  // Deshacer vuelve al paso anterior sin mandar nada
  const s7 = sentTo(CH7).length;
  r = await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-7', type: 'undo' } });
  assert.equal(r.status, 200);
  await untilLong(() => botOf('u1-7')?.step === 'F1', 'deshecho: vuelve a anunciar el turno');
  assert.equal(sentTo(CH7).length, s7, 'deshacer no manda nada');
  // 30 s para elegir (1,5 s aquí): se avisa al jugador, se apunta la incidencia y se espera al árbitro (sin autopick)
  assert.equal((await setRules({ absentLimit: 1, reinviteEvery: 15, pickTimer: 30, readyTimer: 10 })).status, 200);
  await botAct('u1-7', { do: 'mode', mode: 'auto' });
  await untilLong(() => sentTo(CH7).includes(`${A7}, elige mapa: escríbelo en el chat (p. ej. NM2). Tienes 30 s.`) && sentTo(CH7).includes('!mp timer 30'), 'turno con temporizador');
  await untilLong(() => botOf('u1-7')?.timers.pick, 'cuenta atrás del pick en la página');
  await untilLong(() => sentTo(CH7).includes(`${A7}: se ha acabado el tiempo para elegir. Espera a lo que decida el árbitro.`), 'aviso de tiempo agotado');
  await untilLong(() => botOf('u1-7')?.incidents.some((i) => i.open && i.kind === 'pick'), 'incidencia de pick');
  assert.equal(botOf('u1-7').blocked, true, 'aviso claro: el bot espera al árbitro');
  const s7b = sentTo(CH7).length;
  await sleep(1200);
  assert.equal(sentTo(CH7).length, s7b, 'espera al árbitro: ni autopick ni nada más');
  assert.equal(live.last.flows['u1-7'].picks.length, 0);
  assert.equal((await anon2('/api/state')).body.matches['u1-7'].ff, null, 'ni victoria automática');
  r = await botAct('u1-7', { do: 'resolve', id: botOf('u1-7').incidents.find((i) => i.open).id });
  assert.equal(r.status, 200);
  ircSay(CH7, A7, 'nm2');
  await untilLong(() => sentTo(CH7).includes(`${A7} elige NM2: Artista 102 - Titulo 102 [Insane].`), 'pick tras la decisión del árbitro');
  // Ready: 10 s (0,5 s aquí) sin que B esté listo → advertencia; a la tercera, solo aviso al staff
  irc.settings[CH7] = [`Slot 1  Ready     https://osu.ppy.sh/u/${f7.a.id} ${A7}            [Team Red  ]`, `Slot 2  Not Ready https://osu.ppy.sh/u/${f7.b.id} ${B7}            [Team Blue ]`];
  await untilLong(() => sentTo(CH7).includes('!mp timer 10'), 'pide el ready con su temporizador');
  for (const k of [1, 2, 3]) await untilLong(() => sentTo(CH7).includes(`${B7}: pulsa Ready. Advertencia ${k} de 3.`), `advertencia ${k}`);
  assert.ok(!sentTo(CH7).some((t) => t.includes(A7 + ': pulsa Ready')), 'a quien está listo no se le advierte');
  await untilLong(() => botOf('u1-7')?.incidents.some((i) => i.open && i.kind === 'warnings'), 'aviso al staff');
  assert.match(botOf('u1-7').incidents.find((i) => i.open).text, /ha llegado a 3 advertencias.*el bot no sanciona/);
  assert.deepEqual(botOf('u1-7').warnings, { a: 0, b: 3 });
  await sleep(1500);
  assert.ok(!sentTo(CH7).some((t) => /Advertencia 4|^!mp (kick|abort|close|start)/.test(t)), 'solo avisa: ni más advertencias ni sanción ni empezar');
  assert.equal((await anon2('/api/state')).body.matches['u1-7'].ff, null);
  r = await botAct('u1-7', { do: 'resolve', id: botOf('u1-7').incidents.find((i) => i.open).id });
  ircSay(CH7, 'BanchoBot', 'All players are ready');
  await untilLong(() => sentTo(CH7).includes('!mp start 5'), 'con los dos listos, empieza');
  // Pausar: el bot no hace nada solo; incidencia con nota en el log
  r = await botAct('u1-7', { do: 'pause' });
  assert.equal(r.status, 200);
  await untilLong(() => botOf('u1-7')?.paused, 'en pausa');
  r = await botAct('u1-7', { do: 'note', note: 'B se ha desconectado en mitad del mapa' });
  assert.equal(r.status, 200);
  await untilLong(() => botOf('u1-7')?.incidents.some((i) => i.kind === 'note' && i.by === 'Jugador C'), 'nota en las incidencias');
  assert.equal((await botAct('u1-7', { do: 'note', note: '  ' })).status, 400);
  // En AUTO tampoco hay ráfagas: el límite de Bancho se cumple en toda la prueba (≤ 8 por ventana de 300 ms y ≤ 18 en 1.500 ms)
  const tsBot = irc.sent.map((m) => m.at);
  assert.ok(tsBot.every((t, i) => i < 8 || t - tsBot[i - 8] >= 250), 'AUTO respeta 8 por ventana');
  assert.ok(tsBot.every((t, i) => i < 18 || t - tsBot[i - 18] >= 1400), 'AUTO respeta 18 por 5 ventanas');
  // La palabra contra el anti-spam nunca va en comandos con argumentos libres (en !mp password sería parte de la contraseña)
  assert.ok(irc.sent.filter((m) => /^!mp (make|invite|team|password|host|clearhost|kick)\b/.test(m.text)).every((m) => !m.tagged), 'password, host, clearhost y kick sin palabra');
  assert.ok(irc.sent.some((m) => m.text.startsWith('!mp password ')) && irc.sent.some((m) => m.text === '!mp clearhost'));
  console.log('✓ bot: pick agotado espera al árbitro, 3 advertencias de ready solo avisan al staff, saltar, deshacer, pausa e incidencias');

  // Quitar al árbitro y cerrar sesión cierran su conexión a Bancho
  await adm2('/api/admin/role', { method: 'POST', json: { id: 503, role: '' } });
  assert.equal((await refc('/api/ref/act', { method: 'POST', json: { key: 'u1-3', type: 'start' } })).status, 403);
  assert.equal(irc.conns.filter((c) => c.nick === 'Jugador_C' && !c.closed).length, 0);
  live.close();
  await refc('/auth/logout', { method: 'POST', json: {} });
  // La contraseña IRC no se ha escrito ni en la base de datos ni en el log
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) assert.ok(!readFileSync(join(f.parentPath, f.name)).includes('irc-secreta'), 'contraseña en ' + f.name);
  }
  assert.ok(!log.includes('irc-secreta'), 'contraseña en el log');
  console.log('✓ arbitraje: en SEMI nada sale sin pulsar, apuntar a mano, reglas, deshacer, marcador, clasificatorios y correcciones a mano');
  // ---------- Reinicio del servidor a mitad de partido (U1-8, MP 603, en AUTO) ----------
  // Tras reiniciar, la contraseña IRC ya no está: el bot espera a que el árbitro conecte y vuelva a entrar al MP, lee
  // !mp settings y sigue desde ref_state sin repetir lo que ya había mandado.
  {
    const adm3a = await login(s2.base, 4242);
    await adm3a('/api/admin/role', { method: 'POST', json: { user: 'Jugador C', role: 'referee' } });
    const ref8 = await login(s2.base, 503);
    const live8 = await refStream(s2.base, ref8);
    await until(() => live8.last?.flows['u1-8'], 'U1-8 en la página');
    const f8 = live8.last.flows['u1-8'], CH8 = '#mp_603', A8 = f8.a.username, B8 = f8.b.username;
    assert.equal((await ref8('/api/ref/connect', { method: 'POST', json: { password: 'irc-secreta' } })).status, 200);
    await until(() => live8.last.irc.status === 'connected', 'conectado');
    await ref8('/api/ref/act', { method: 'POST', json: { key: 'u1-8', type: 'bot', do: 'mode', mode: 'auto' } });
    r = await ref8('/api/ref/act', { method: 'POST', json: { key: 'u1-8', type: 'bot', do: 'start' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await untilLong(() => sentTo(CH8).includes(`!mp invite #${f8.b.id}`), 'invitaciones de U1-8');
    ircSay(CH8, 'BanchoBot', `${A8} joined in slot 1 for team red.`);
    ircSay(CH8, 'BanchoBot', `${B8} joined in slot 2 for team blue.`);
    for (const who of [A8, B8]) {
      await untilLong(() => sentTo(CH8).includes(`${who}, ¿quieres warmup? Responde «sí» o «no» en el chat.`), 'pregunta de warmup');
      ircSay(CH8, who, 'no');
    }
    await untilLong(() => sentTo(CH8).includes('Roll para los protects: haced !roll los dos (solo «!roll», sin número). Gana el más alto.'), 'rolls');
    for (const [who, n] of [[A8, 50], [B8, 60]]) { ircSay(CH8, who, '!roll'); ircSay(CH8, 'BanchoBot', `${who} rolls ${n} point(s)`); }
    await untilLong(() => sentTo(CH8).includes(`${B8}: di en el chat quién protege primero.`), 'pregunta el orden');
    await ref8('/api/ref/act', { method: 'POST', json: { key: 'u1-8', type: 'order', protect: 'a' } });
    const turn8 = `${A8}, protege un mapa: escríbelo en el chat (p. ej. NM2).`;
    await untilLong(() => sentTo(CH8).includes(turn8), 'turno de protect de A');
    live8.close();
    // Reinicio (la misma base de datos)
    await new Promise((done) => { srv2.once('exit', done); srv2.kill(); });
    const s3 = startServer('octavos', t0);
    srv2 = s3.proc;
    await ready(s3.base);
    const ref9 = await login(s3.base, 503);
    const live9 = await refStream(s3.base, ref9);
    await until(() => live9.last?.flows['u1-8']?.bot, 'estado tras el reinicio');
    let b8 = live9.last.flows['u1-8'].bot;
    assert.deepEqual([b8.mode, b8.stage, b8.phase, b8.inLobby], ['auto', 'match', 'PROTECT', false], 'retoma la fase y el modo de ref_state');
    assert.match(b8.waitRef, /Volver a entrar al MP/, 'espera a que el árbitro vuelva a entrar');
    assert.deepEqual(live9.last.flows['u1-8'].roll, { winner: 'b', a: 50, b: 60 });
    const sent8 = sentTo(CH8).length;
    assert.equal((await ref9('/api/ref/connect', { method: 'POST', json: { password: 'irc-secreta' } })).status, 200);
    irc.settings[CH8] = [`Slot 1  Not Ready https://osu.ppy.sh/u/${f8.a.id} ${A8}            [Team Red  ]`, `Slot 2  Not Ready https://osu.ppy.sh/u/${f8.b.id} ${B8}            [Team Blue ]`];
    assert.equal((await ref9('/api/ref/attach', { method: 'POST', json: { key: 'u1-8' } })).status, 200);
    await untilLong(() => live9.last.flows['u1-8'].bot.inLobby && live9.last.lobbies.find((l) => l.key === 'u1-8')?.players.length === 2, 'de vuelta en el lobby');
    await sleep(3000);
    assert.deepEqual(sentTo(CH8).slice(sent8), ['!mp settings'], 'al volver no repite nada: solo lee !mp settings');
    ircSay(CH8, A8, 'nm1');
    await untilLong(() => sentTo(CH8).includes(`${A8} protege NM1.`), 'sigue desde el paso guardado');
    await untilLong(() => sentTo(CH8).includes(`${B8}, protege un mapa: escríbelo en el chat (p. ej. NM2).`), 'siguiente turno');
    assert.equal(sentTo(CH8).filter((t) => t === turn8).length, 1, 'el turno de A no se anuncia dos veces');
    assert.deepEqual((await client(s3.base)('/api/overlay?match=u1-8')).body.rundown, [{ actor: 'RED', action: 'PROTECT', pick: 'NM1' }]);
    await ref9('/api/ref/disconnect', { method: 'POST', json: {} });
    live9.close();
    // Tampoco tras el reinicio está la contraseña IRC en la base de datos ni en el log
    for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (f.isFile()) assert.ok(!readFileSync(join(f.parentPath, f.name)).includes('irc-secreta'), 'contraseña en ' + f.name);
    }
    assert.ok(!log.includes('irc-secreta'), 'contraseña en el log');
    console.log('✓ bot: reinicio del servidor a mitad de partido, retoma desde ref_state sin repetir pasos');
  }
  console.log('\nTodo correcto.');
} catch (e) {
  failed = true;
  console.error('\n✗ Fallo:', e.message);
  console.error('--- log del servidor ---\n' + log);
} finally {
  srv.kill();
  srv2?.kill();
  mock.close();
  bancho.close();
  for (const c of irc.conns) c.sock.destroy();
  // En Windows el servidor tarda un momento en soltar la base de datos tras kill(): se reintenta.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  process.exitCode = failed ? 1 : 0;
}
