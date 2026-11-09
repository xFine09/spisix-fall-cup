// Servidor de la web de SpiSix: Fall Cup. Sin dependencias: Node 22.5+ (http, fetch y node:sqlite).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, q, backup } from './server/db.js';
import * as osu from './server/osu.js';
import { CONFIG, phase, zoned, MATCH_IDS, phaseOfMatch, bestOf, slotSort } from './server/config.js';
import { loadBeatmap, parseMatch, parseQual } from './server/results.js';
import { parseResponses, readPools, parsePoolText, sameMap } from './server/import.js';
import { readSpreadsheet, SheetError } from './server/sheet.js';
import * as twitch from './server/twitch.js';
import { resolveBracket, roundName } from './server/bracket.js';
import { createReferee } from './server/referee.js';
import { DEFAULT_RULES } from './server/refflow.js';

const PORT = +process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const REDIRECT_URI = BASE_URL + '/auth/osu/callback';
const SECURE = BASE_URL.startsWith('https://');
// ADMIN_IDS son los hosts: los únicos que asignan roles, y no se les pueden quitar desde la web.
const HOST_IDS = new Set((process.env.ADMIN_IDS || '').split(',').map((s) => +s.trim()).filter(Boolean));
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const SESSION_DAYS = 30;
const POOL_SLOT = /^(NM|HD|HR|DT|FM)\d{1,2}$|^TB$/;
const POOL_FILE_MAX = 20 * 1024 * 1024;
// Última vez que cada usuario intentó inscribirse: cada intento consulta a osu! y la cola es común para todos.

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- utilidades HTTP ----------
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* cookie mal codificada: se ignora */ }
  }
  return out;
}
function setCookie(res, name, value, maxAgeSeconds) {
  const c = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (SECURE) c.push('Secure');
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...prev, c.join('; ')]);
}
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}
// Solo se aceptan cuerpos JSON: un formulario de otra web no puede enviarlos sin permiso CORS.
async function readJson(req, limit = 100_000) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'La petición debe ser JSON.');
  if (+req.headers['content-length'] > limit) throw new HttpError(413, 'La petición es demasiado grande.');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'La petición es demasiado grande.');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new HttpError(400, 'El JSON no es válido.'); }
}
// Un jugador de osu! por nombre, ID o enlace del perfil.
async function findOsuUser(raw) {
  const tryUser = async (fn) => { try { return await fn(); } catch (e) { if (e.status !== 404) throw e; return null; } };
  let u = null;
  const id = /^\d+$/.test(raw) || /osu\.ppy\.sh\/(u|users)\//.test(raw) ? parseId(raw, 'del perfil de osu!') : null;
  if (id) { u = await tryUser(() => osu.user(id)); if (u?.id !== id) u = null; }
  if (!u && !/osu\.ppy\.sh/.test(raw)) u = await tryUser(() => osu.userByName(raw));
  if (!u) throw new HttpError(404, `No existe ningún jugador de osu! «${raw}».`);
  return u;
}
function slotFrom(id) {
  const slot = q.qualSlot.get(Number.isInteger(+id) ? +id : 0);
  if (!slot) throw new HttpError(404, 'Ese lobby ya no existe.');
  return slot;
}
function slotFields(b) {
  const name = String(b.name ?? '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 30) throw new HttpError(400, 'Ponle un nombre al lobby (máximo 30 caracteres), por ejemplo «Lobby A».');
  const time = Number(b.time);
  if (!Number.isFinite(time) || time <= 0) throw new HttpError(400, 'Elige la fecha y la hora del lobby.');
  const size = Number(b.size ?? 8);
  if (!Number.isInteger(size) || size < 1 || size > 16) throw new HttpError(400, 'Las plazas van de 1 a 16 (osu! no admite más en una sala).');
  return { name, time, size };
}
// Acepta un número o un enlace de osu! (usa el último número del texto).
function parseId(value, what) {
  const m = String(value ?? '').match(/(\d+)\D*$/);
  if (!m) throw new HttpError(400, `Escribe el ID o el enlace ${what}.`);
  return +m[1];
}

// ---------- sesión ----------
function sessionUser(req) {
  const sid = cookies(req).sid;
  if (!sid) return null;
  const s = q.getSession.get(sid, Date.now());
  return s ? q.getUser.get(s.user_id) || null : null;
}
function requireUser(req) {
  const u = sessionUser(req);
  if (!u) throw new HttpError(401, 'Inicia sesión con osu! primero.');
  return u;
}
const ROLES = ['admin', 'referee', 'staff'];
const roleOf = (id) => (HOST_IDS.has(id) ? 'host' : q.roleOf.get(id)?.role || null);
const isAdminId = (id) => ['host', 'admin'].includes(roleOf(id));
const isRef = (u) => Boolean(u && ['host', 'admin', 'referee'].includes(roleOf(u.id)));
function requireHost(req) {
  const u = requireUser(req);
  if (!HOST_IDS.has(u.id)) throw new HttpError(403, 'Los roles solo los puede cambiar el host.');
  return u;
}
function requireAdmin(req) {
  const u = requireUser(req);
  if (!isAdminId(u.id)) throw new HttpError(403, 'Esta acción es solo para la organización.');
  return u;
}
function requireRef(req) {
  const u = requireUser(req);
  if (!isRef(u)) throw new HttpError(403, 'Esta página es solo para los árbitros del torneo.');
  return u;
}
function saveUser(u) {
  q.upsertUser.run(u.id, u.username, u.avatar_url, u.country_code, u.statistics?.global_rank ?? null, Date.now());
}

// IDs admitidos fuera del rango: los de config.json más los añadidos desde el panel.
function exceptionIds() {
  return [...new Set([...(CONFIG.rango.excepciones || []), ...q.exceptions.all().map((e) => e.user_id)])];
}

// Comprueba si un usuario de osu! puede inscribirse. Devuelve el motivo si no puede.
function eligibility(u) {
  const rank = u.statistics?.global_rank ?? null;
  const { min, max } = CONFIG.rango;
  const fmt = (n) => '#' + n.toLocaleString('es-ES');
  if (exceptionIds().includes(u.id)) return null;
  if (CONFIG.paises && !CONFIG.paises.includes(u.country_code)) return `El torneo es solo para jugadores de: ${CONFIG.paises.join(', ')}.`;
  if (!rank) return 'Tu cuenta no tiene rango global ahora mismo (osu! lo quita por inactividad). Juega alguna partida rankeada y vuelve a intentarlo.';
  if (rank < min || rank > max) {
    return `Tu rango es ${fmt(rank)} y el torneo es para jugadores entre ${fmt(min)} y ${fmt(max)}. ` +
      'Si crees que deberías poder jugar, habla con la organización.';
  }
  return null;
}

// ---------- estado público ----------
// Mejor score de cada jugador en cada mapa, juntando todos los lobbies de clasificatorios.
function qualScores() {
  const scores = {};
  const lobbies = [];
  for (const l of q.quals.all()) {
    const d = l.data ? JSON.parse(l.data) : {};
    lobbies.push({ mp: l.mp, name: d.name || null, updated_at: l.updated_at, skipped: d.skipped || 0 });
    for (const [uid, maps] of Object.entries(d.scores || {})) {
      for (const [bid, s] of Object.entries(maps)) {
        scores[uid] ??= {};
        scores[uid][bid] = Math.max(scores[uid][bid] || 0, s);
      }
    }
  }
  return { scores, lobbies };
}

// Lobbies a los que apuntarse, con los IDs de sus jugadores por orden de llegada.
const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.zona }).format(ms);
// 31 de febrero, mes 13…: Date lo pasaría al mes siguiente sin avisar.
const validDay = (d) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const [Y, M, D] = d.split('-').map(Number);
  return new Date(Date.UTC(Y, M - 1, D)).toISOString().slice(0, 10) === d;
};

// Lo que los admins cambian en el panel se superpone a config.json. Si lo quitan, vuelve lo de config.json.
const BASE_CONFIG = structuredClone({ nombre: CONFIG.nombre, comunidad: CONFIG.comunidad, enlaces: CONFIG.enlaces, fases: CONFIG.fases });
const SITE_TEXT_MAX = { normas: 20000, anuncio: 500, lead: 800, formato: 4000, qualis: 800, registro: 800, nombre: 60, comunidad: 60, enlaces: 1500 };
const PAGE_TEXTS = ['lead', 'formato', 'qualis', 'registro', 'nombre', 'comunidad', 'enlaces'];
function parseLinks(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 10) throw new HttpError(400, 'Como máximo, 10 enlaces.');
  return lines.map((l) => {
    const m = l.match(/^([^|]{1,40}?)\s*\|\s*(https?:\/\/\S+)?$/i);
    if (!m) throw new HttpError(400, `No entiendo esta línea: «${l.slice(0, 60)}». Escríbela así: Nombre | https://…`);
    return [m[1], m[2] || ''];
  });
}
function applySiteConfig() {
  const text = (key) => q.siteText.get(key)?.text;
  CONFIG.nombre = text('nombre') ?? BASE_CONFIG.nombre;
  CONFIG.comunidad = text('comunidad') ?? BASE_CONFIG.comunidad;
  CONFIG.enlaces = text('enlaces') ? parseLinks(text('enlaces')) : BASE_CONFIG.enlaces;
  const fases = JSON.parse(text('fases') || '{}');
  CONFIG.fases = BASE_CONFIG.fases.map((f) => ({ ...f, ...fases[f.key] }));
}
applySiteConfig();
// Al acabar la fase se fijan las seeds y el cuadro: un lobby que empiece justo antes ya no llegaría a contar.
const QUAL_LAST_CALL = 30 * 60e3;
const EXTRA_NAME = /^X(\d+)$/; // los lobbies extraordinarios: X1, X2…
// Hora de un lobby extraordinario.
function extraTime(value) {
  const time = Number(value), qp = phase('qualifiers');
  if (!Number.isFinite(time) || time <= 0) throw new HttpError(400, 'Elige la fecha y la hora.');
  if (time <= Date.now()) throw new HttpError(400, 'Esa hora ya ha pasado.');
  if (time < qp.start || time > qp.end - QUAL_LAST_CALL) throw new HttpError(400, 'Tiene que ser durante los clasificatorios, al menos media hora antes de que acaben.');
  return time;
}
// Una plaza sin aprobar no cuenta: si el lobby empieza sin aprobarla, ese jugador no ha jugado y puede elegir otro.
const lobbyStarted = (userId) => {
  const s = q.signupOf.get(userId);
  return Boolean(s?.approved) && Date.now() >= (q.qualSlot.get(s.slot_id)?.time ?? Infinity);
};
function pendingSeat(b, u) {
  const s = q.signupOf.get(Number(b.user));
  if (!s || s.approved) throw new HttpError(404, 'Esa plaza ya no está pendiente.');
  if (s.user_id === u.id) throw new HttpError(403, 'No puedes responder a tu propia plaza.');
  return { seat: s, slot: q.qualSlot.get(s.slot_id) };
}
function pendingRequest(b, u) {
  const r = q.requestOf.get(Number(b.user));
  if (r?.status !== 'pending') throw new HttpError(404, 'Esa solicitud ya no está pendiente.');
  if (r.user_id === u.id) throw new HttpError(403, 'No puedes responder a tu propia solicitud.');
  return r;
}
// Estado de un lobby que ya ha empezado: terminado si osu! lo ha cerrado o ya se ha jugado toda la mappool,
// jugándose si tiene MP y aún no, y empezado a secas si llegó la hora y nadie lo ha abierto desde la web.
function slotState(slot, now, poolSize) {
  if (now < slot.time) return null;
  if (!slot.mp) return 'started';
  const row = q.getQual.get(slot.mp);
  const d = row?.data ? JSON.parse(row.data) : {};
  const played = new Set(Object.values(d.scores || {}).flatMap((m) => Object.keys(m))).size;
  return d.ended || (poolSize && played >= poolSize) ? 'done' : 'live';
}
function qualSlots() {
  const now = Date.now(), poolSize = poolBySlot('qualifiers').size;
  const bySlot = new Map();
  const pending = new Map();
  for (const x of q.signups.all()) {
    bySlot.set(x.slot_id, [...(bySlot.get(x.slot_id) || []), x.user_id]);
    if (!x.approved) pending.set(x.slot_id, [...(pending.get(x.slot_id) || []), x.user_id]);
  }
  return q.qualSlots.all().map((x) => ({ ...x, players: bySlot.get(x.id) || [], pending: pending.get(x.id) || [], state: slotState(x, now, poolSize) }));
}

// Quién lleva el torneo, para la página de información y para el panel del host.
function team() {
  const hosts = [...HOST_IDS].map((id) => q.getUser.get(id)).filter(Boolean).map((u) => ({ id: u.id, username: u.username, role: 'host' }));
  return [...hosts, ...q.roles.all().filter((r) => !HOST_IDS.has(r.user_id)).map((r) => ({ id: r.user_id, username: r.username, role: r.role }))];
}

// Hora a la que se hace pública la mappool de cada ronda: la programada en el panel o, si no hay,
// el día del showcase a las 00:00 (hora de Madrid). Antes, solo la organización la ve.
function releases() {
  const set = Object.fromEntries(q.releases.all().map((r) => [r.round, r.at]));
  const out = {};
  for (const f of CONFIG.fases) {
    if (f.key === 'registros') continue;
    out[f.key] = { at: set[f.key] ?? (f.showcase ? zoned(f.showcase) : 0), set: f.key in set };
  }
  return out;
}
const isPublic = (round, rel = releases()) => (rel[round]?.at ?? 0) <= Date.now();

// Resultados de clasificatorios: ocultos hasta la hora que fije la organización (sin hora, ocultos del todo).
// Los admins y los árbitros los ven siempre, y son los únicos que ven los MP de los lobbies.
const QUAL_RESULTS = 'qual-results';
const qualResultsAt = () => q.getRelease.get(QUAL_RESULTS)?.at ?? null;
const qualResultsPublic = () => { const at = qualResultsAt(); return at != null && at <= Date.now(); };

// Reglas de arbitraje de cada ronda del cuadro (bans, protects, mapas entre tandas de bans y temporizador).
const BRACKET_ROUNDS = CONFIG.fases.filter((f) => f.bo).map((f) => f.key);
function allRules() {
  const set = Object.fromEntries(q.roundRules.all().map((r) => [r.round, JSON.parse(r.data)]));
  return Object.fromEntries(BRACKET_ROUNDS.map((k) => [k, { ...DEFAULT_RULES, ...set[k] }]));
}
const rulesOf = (round) => allRules()[round] || { ...DEFAULT_RULES };
const poolOf = (round) => q.poolRound.all(round).map((r) => ({ ...r, data: JSON.parse(r.data) })).sort(slotSort);

function poolBySlot(round) {
  return new Map(q.poolRound.all(round).map((r) => [r.beatmap_id, r.slot]));
}

function buildState(user) {
  const admin = Boolean(user && isAdminId(user.id));
  const players = q.registered.all().map((p) => ({
    id: p.id, username: p.username, avatar_url: p.avatar_url, country: p.country, rank: p.rank,
    registered_at: p.registered_at,
    ...(admin ? { availability: p.availability } : {})
  }));
  const rel = releases();
  const pools = {};
  const seesHidden = admin || (user && roleOf(user.id) === 'staff'); // las mappools sin publicar
  for (const r of q.pool.all()) if (seesHidden || isPublic(r.round, rel)) (pools[r.round] ??= []).push({ slot: r.slot, beatmap_id: r.beatmap_id, data: JSON.parse(r.data) });
  for (const k in pools) pools[k].sort(slotSort);
  const protects = {};
  for (const r of q.refStates.all()) {
    const list = (JSON.parse(r.data).actions || []).filter((x) => x.type === 'protect').map((x) => x.slot);
    if (list.length) protects[r.key] = list;
  }
  const matches = {};
  for (const m of q.matches.all()) {
    matches[m.id] = {
      time: m.time, ref: m.ref, mp: m.mp, ff: m.ff, protects: protects[m.id] || [],
      bans: m.bans ? JSON.parse(m.bans) : [], result: m.result ? JSON.parse(m.result) : null
    };
  }
  const { scores, lobbies } = qualScores();
  const qualStaff = isRef(user);
  const slots = qualSlots().map((x) => (qualStaff ? x : { ...x, mp: null }));
  return {
    now: Date.now(),
    configured: osu.configured(),
    twitch: CONFIG.twitch ? { channel: CONFIG.twitch, live: twitchLive, ...(admin ? { configured: twitch.configured() } : {}) } : null,
    releases: rel,
    config: { ...CONFIG, rango: { ...CONFIG.rango, excepciones: exceptionIds() } },
    me: user ? {
      id: user.id, username: user.username, avatar_url: user.avatar_url, country: user.country, rank: user.rank,
      availability: user.availability,
      registered: Boolean(user.registered_at), admin, referee: isRef(user), host: HOST_IDS.has(user.id),
      qualRequest: q.requestOf.get(user.id) || null,
      qualRejection: q.rejectionOf.get(user.id) || null
    } : null,
    rules: allRules(),
    players, pools, matches,
    qual: {
      scores: qualStaff || qualResultsPublic() ? scores : {},
      lobbies: qualStaff ? lobbies : [],
      slots,
      results: qualResultsAt()
    },
    team: team(),
    normas: q.siteText.get('normas') || null,
    anuncio: q.siteText.get('anuncio') || null,
    textos: Object.fromEntries(PAGE_TEXTS.map((k) => [k, q.siteText.get(k)]).filter(([, v]) => v)),
    fasesEditadas: Boolean(q.siteText.get('fases')),
    ...(isRef(user) ? { qualRequests: q.pendingRequests.all() } : {}),
    ...(admin ? {
      exceptions: q.exceptions.all().map((e) => ({ id: e.user_id, username: e.username }))
    } : {})
  };
}

// ---------- sincronización con /matches ----------
// Los lobbies creados con !mp makeprivate solo los pueden leer quienes jugaron en ellos (osu-web, MatchView),
// así que con el token de aplicación osu! responde 401/403.
const matchReadAt = new Map(); // última lectura de cada MP (el arbitraje espera un minuto entre lecturas)
const sinceRead = (mp) => Date.now() - (matchReadAt.get(+mp) || 0);
async function readMatch(mp) {
  matchReadAt.set(+mp, Date.now());
  try {
    return await osu.match(mp);
  } catch (e) {
    if (e.status === 401 || e.status === 403) throw new HttpError(502, `osu! no deja leer el MP #${mp}: el lobby es privado (!mp makeprivate). Los lobbies del torneo hay que crearlos con !mp make.`);
    if (e.status === 404) throw new HttpError(404, `No existe el MP #${mp}. Revisa el enlace.`);
    throw e;
  }
}

async function syncMatch(id) {
  const rec = q.getMatch.get(id);
  if (!rec?.mp) throw new HttpError(400, 'Este partido no tiene enlace de multiplayer.');
  const pool = poolBySlot(phaseOfMatch(id));
  if (!pool.size) throw new HttpError(400, 'Añade antes el mappool de esta ronda: sin él no se distinguen los warmups.');
  const data = await readMatch(rec.mp);
  const result = parseMatch(data, pool, CONFIG.multiplicadores);
  q.setResult.run(JSON.stringify(result), Date.now(), id);
  return result;
}

async function syncQual(mp) {
  const pool = poolBySlot('qualifiers');
  if (!pool.size) throw new HttpError(400, 'Añade antes el mappool de clasificatorios.');
  const data = await readMatch(mp);
  const parsed = parseQual(data, pool);
  if (parsed.skipped && !Object.keys(parsed.scores).length) {
    throw new HttpError(400, `El MP #${mp} no se jugó en head to head, así que sus mapas no cuentan para los clasificatorios.`);
  }
  q.upsertQual.run(mp, JSON.stringify(parsed), Date.now());
  return parsed;
}

function finished(rec) {
  if (rec.ff) return true;
  if (!rec.result) return false;
  const need = (bestOf(rec.id) + 1) / 2;
  return Object.values(JSON.parse(rec.result).wins || {}).some((w) => w >= need);
}

const matchLabel = (id) => `${id.toUpperCase()} · ${roundName(id)}`;

// Quién juega cada partido según las seeds y los resultados (lo mismo que dibuja la web).
function currentBracket() {
  const players = new Map(q.registered.all().map((p) => [p.id, p]));
  const matches = {};
  for (const m of q.matches.all()) matches[m.id] = { ff: m.ff, result: m.result ? JSON.parse(m.result) : null };
  const bids = q.poolRound.all('qualifiers').sort(slotSort).map((r) => String(r.beatmap_id));
  return resolveBracket({ players, scores: qualScores().scores, bids, matches });
}

// Cada 5 minutos: partidos en juego, lobbies de clasificatorios mientras dura la fase y copia diaria de la base de datos.
let syncing = false;
async function autoSync() {
  if (syncing) return; // la vuelta anterior sigue en marcha (osu! va lento)
  syncing = true;
  try { await syncAll(); } finally { syncing = false; }
}
async function syncAll() {
  const now = Date.now();
  for (const rec of q.matches.all()) {
    if (!rec.mp || finished(rec)) continue;
    if (rec.time && (rec.time > now || rec.time < now - 12 * 3600e3)) continue;
    try { await syncMatch(rec.id); } catch (e) { console.warn('[sync]', rec.id, e.message); }
  }
  const qp = phase('qualifiers');
  if (qp && now >= qp.start && now <= qp.end + 86400e3) {
    for (const l of q.quals.all()) {
      try { await syncQual(l.mp); } catch (e) { console.warn('[sync qual]', l.mp, e.message); }
    }
  }
  q.purgeSessions.run(now);
  try {
    const file = backup();
    if (file) console.log('[backup]', file);
  } catch (e) { console.warn('[backup]', e.message); }
}

// ---------- arbitraje (bot de IRC) ----------
const referee = createReferee({
  q, CONFIG, HttpError, syncMatch, syncQual, poolOf, rulesOf, sinceRead,
  bracket: currentBracket,
  label: matchLabel,
  need: (id) => (bestOf(id) + 1) / 2,
  phaseOf: phaseOfMatch,
  visible: (round, userId) => isAdminId(userId) || isPublic(round)
});

// ---------- rutas ----------
const routes = {
  'GET /auth/osu': (req, res) => {
    if (!osu.configured()) throw new HttpError(500, 'Faltan OSU_CLIENT_ID y OSU_CLIENT_SECRET en el entorno del servidor.');
    const state = randomBytes(16).toString('hex');
    setCookie(res, 'oauth_state', state, 600);
    redirect(res, osu.authorizeUrl(state, REDIRECT_URI));
  },

  'GET /auth/osu/callback': async (req, res, url) => {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const expected = cookies(req).oauth_state;
    setCookie(res, 'oauth_state', '', 0);
    if (url.searchParams.get('error')) return redirect(res, '/?login=cancelado#registro');
    if (!code || !state || !expected || state !== expected) return redirect(res, '/?login=caducado#registro');
    const token = await osu.exchangeCode(code, REDIRECT_URI);
    const me = await osu.me(token);
    saveUser(me);
    const sid = randomBytes(32).toString('hex');
    q.newSession.run(sid, me.id, Date.now() + SESSION_DAYS * 86400e3);
    setCookie(res, 'sid', sid, SESSION_DAYS * 86400);
    redirect(res, '/#registro');
  },

  'POST /auth/logout': async (req, res) => {
    await readJson(req);
    const sid = cookies(req).sid;
    const u = sessionUser(req);
    if (u) referee.disconnect(u); // al cerrar sesión también se cierra la conexión a Bancho
    if (sid) q.delSession.run(sid);
    setCookie(res, 'sid', '', 0);
    sendJson(res, 200, { ok: true });
  },

  'GET /api/state': (req, res) => sendJson(res, 200, buildState(sessionUser(req))),

  // Para el healthcheck de Docker o un monitor externo.
  'GET /healthz': (req, res) => sendJson(res, 200, { ok: q.ping.get().ok === 1 }),

  // Apuntarse a un lobby de clasificatorios. Quien ya estaba en otro se cambia a este.
  // Lobby extraordinario: el jugador propone una hora; un árbitro o admin la acepta o la rechaza.
  'POST /api/qual/request': async (req, res) => {
    const u = requireUser(req);
    const b = await readJson(req);
    if (!u.registered_at) throw new HttpError(403, 'Solo pueden solicitarlo los inscritos.');
    if (lobbyStarted(u.id)) throw new HttpError(409, 'Tu lobby ya ha empezado: solo se juega una vez.');
    const time = extraTime(b.time);
    q.setRequest.run(u.id, time, String(b.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || null, Date.now());
    sendJson(res, 200, { ok: true });
  },

  'POST /api/qual/request/cancel': async (req, res) => {
    q.delRequest.run(requireUser(req).id);
    sendJson(res, 200, { ok: true });
  },

  // Crea el lobby (X1, X2…) con una sola plaza, para quien lo pidió. Si ya estaba en otro, pasa a este.
  'POST /api/ref/qual-request/accept': async (req, res) => {
    const u = requireRef(req);
    const b = await readJson(req);
    const r = pendingRequest(b, u);
    if (!q.getUser.get(r.user_id)?.registered_at) throw new HttpError(409, 'Esa persona ya no está inscrita.');
    if (lobbyStarted(r.user_id)) throw new HttpError(409, 'Su lobby ya ha empezado: solo se juega una vez.');
    const time = extraTime(b.time ?? r.time);
    const n = Math.max(0, ...q.qualSlots.all().map((x) => +(x.name.match(EXTRA_NAME)?.[1] ?? 0))) + 1;
    db.exec('BEGIN');
    try {
      const id = Number(q.addSlot.run(`X${n}`, time, 1).lastInsertRowid);
      q.setSignup.run(r.user_id, id, Date.now(), 1);
      q.delRejection.run(r.user_id);
      if (b.referee === true) q.setSlotRef.run(u.id, id);
      q.delRequest.run(r.user_id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    referee.push();
    sendJson(res, 200, { ok: true, name: `X${n}` });
  },

  'POST /api/ref/qual-request/reject': async (req, res) => {
    const u = requireRef(req);
    const b = await readJson(req);
    const r = pendingRequest(b, u);
    q.rejectRequest.run(String(b.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || null, r.user_id);
    sendJson(res, 200, { ok: true });
  },

  'POST /api/qual/signup': async (req, res) => {
    const u = requireUser(req);
    const b = await readJson(req);
    if (!u.registered_at) throw new HttpError(403, 'Solo pueden apuntarse los inscritos. Si ya has rellenado el formulario, espera a que la organización lo importe.');
    const slot = slotFrom(b.slot);
    const now = Date.now();
    if (now >= slot.time) throw new HttpError(409, 'Ese lobby ya ha empezado.');
    if (slot.ref_id === u.id) throw new HttpError(409, 'Arbitras ese lobby: déjalo antes de apuntarte.');
    const current = q.signupOf.get(u.id);
    if (current?.slot_id === slot.id) return sendJson(res, 200, { ok: true });
    if (lobbyStarted(u.id)) throw new HttpError(409, 'Tu lobby ya ha empezado: habla con la organización para cambiarte.');
    if (q.slotCount.get(slot.id).n >= slot.size) throw new HttpError(409, 'Ese lobby está lleno.');
    q.setSignup.run(u.id, slot.id, now, 0);
    q.delRejection.run(u.id);
    referee.push();
    sendJson(res, 200, { ok: true });
  },

  // Plazas: el jugador se apunta y un árbitro o admin la aprueba o la rechaza. Solo se invita a los aprobados.
  'POST /api/ref/qual-signup/approve': async (req, res) => {
    const u = requireRef(req);
    const b = await readJson(req);
    const { seat, slot } = pendingSeat(b, u);
    if (Date.now() >= (slot?.time ?? Infinity)) throw new HttpError(409, 'Ese lobby ya ha empezado.');
    q.approveSignup.run(seat.user_id);
    referee.push();
    sendJson(res, 200, { ok: true });
  },

  'POST /api/ref/qual-signup/reject': async (req, res) => {
    const u = requireRef(req);
    const b = await readJson(req);
    const { seat, slot } = pendingSeat(b, u);
    q.delSignup.run(seat.user_id);
    if (slot) q.setRejection.run(seat.user_id, slot.name, slot.time, String(b.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || null);
    referee.push();
    sendJson(res, 200, { ok: true });
  },

  'POST /api/qual/leave': async (req, res) => {
    const u = requireUser(req);
    await readJson(req);
    if (lobbyStarted(u.id)) throw new HttpError(409, 'Tu lobby ya ha empezado: habla con la organización.');
    q.delSignup.run(u.id);
    referee.push();
    sendJson(res, 200, { ok: true });
  },

  'POST /api/admin/pool': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    const round = String(b.round || '');
    if (round === 'registros' || !CONFIG.fases.some((f) => f.key === round)) throw new HttpError(400, 'Elige una ronda válida.');
    const slot = String(b.slot || '').toUpperCase().replace(/\s/g, '');
    if (!POOL_SLOT.test(slot)) throw new HttpError(400, 'El slot debe tener la forma NM1, HD2, HR1, DT3, FM1 o TB.');
    const bid = parseId(b.beatmap, 'del mapa');
    const data = await loadBeatmap(bid, slot);
    q.upsertPool.run(round, slot, bid, JSON.stringify(data));
    sendJson(res, 200, { ok: true, data });
  },

  // Varios mapas a la vez, pegados desde una hoja. Se leen todos de osu! antes de guardar nada.
  // Paso 1: leer el archivo o el texto y enseñar lo entendido. No guarda nada ni llama a osu!.
  'POST /api/admin/pool/read': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req, Math.ceil(POOL_FILE_MAX * 4 / 3) + 1000);
    let sheets;
    if (typeof b.file === 'string') {
      const buf = Buffer.from(b.file, 'base64');
      if (buf.length > POOL_FILE_MAX) throw new HttpError(413, 'El archivo pesa más de 20 MB. Copia solo la pestaña de las mappools.');
      try { sheets = readSpreadsheet(buf, parsePoolText); } catch (e) {
        if (e instanceof SheetError) throw new HttpError(400, e.message);
        throw e;
      }
    } else if (typeof b.text === 'string' && b.text.trim()) {
      if (b.text.length > 200_000) throw new HttpError(413, 'Hay demasiado texto. Copia solo las filas de las mappools.');
      sheets = [{ name: '', hidden: false, rows: parsePoolText(b.text) }];
    } else throw new HttpError(400, 'Elige un archivo o pega las filas de la hoja.');
    const { groups, notes, empty } = readPools(sheets);
    if (!groups.length) throw new HttpError(400, empty[0] || 'No encuentro mapas. Cada fila necesita el slot (NM1, HD2, TB…) y el ID o el enlace del mapa.');
    sendJson(res, 200, { groups, notes });
  },
  // Paso 2: guardar una ronda con lo revisado. Todo o nada: si un mapa falla, la ronda se queda como estaba.
  'POST /api/admin/pool/import': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    const round = String(b.round || '');
    if (round === 'registros' || !CONFIG.fases.some((f) => f.key === round)) throw new HttpError(400, 'Elige una ronda válida.');
    if (!Array.isArray(b.maps) || !b.maps.length) throw new HttpError(400, 'No hay mapas que importar.');
    if (b.maps.length > 40) throw new HttpError(400, 'Demasiados mapas: el máximo son 40 por ronda.');
    const maps = b.maps.map((m) => ({ slot: String(m?.slot ?? '').toUpperCase(), beatmap: m?.beatmap, text: String(m?.text ?? '').slice(0, 200) }));
    const seen = new Set();
    for (const m of maps) {
      if (!POOL_SLOT.test(m.slot)) throw new HttpError(400, `Slot no válido: ${m.slot.slice(0, 12)}.`);
      if (!Number.isInteger(m.beatmap) || m.beatmap <= 0) throw new HttpError(400, `${m.slot}: el ID del mapa no es válido.`);
      if (seen.has(m.slot)) throw new HttpError(400, `${m.slot} está repetido.`);
      seen.add(m.slot);
    }
    const errors = [], loaded = [];
    for (const m of maps) {
      try { loaded.push({ ...m, data: await loadBeatmap(m.beatmap, m.slot) }); } catch (e) {
        if (!(e instanceof osu.OsuError)) throw e;
        errors.push(`${m.slot}: ${e.status === 404 ? `no existe el mapa ${m.beatmap}` : e.message}.`);
      }
    }
    if (errors.length) throw new HttpError(400, 'No se ha cambiado nada en esta ronda. ' + errors.join(' '));
    db.exec('BEGIN');
    try {
      q.delPoolRound.run(round);
      for (const m of loaded) q.upsertPool.run(round, m.slot, m.beatmap, JSON.stringify(m.data));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    const warnings = loaded.filter((m) => !sameMap(m.text, m.data))
      .map((m) => `${m.slot}: la hoja dice «${m.text}», pero el ID ${m.beatmap} es «${m.data.artist} - ${m.data.title} [${m.data.version}]».`);
    if (round !== 'qualifiers' && !seen.has('TB')) warnings.push('Esta ronda no tiene TB.');
    sendJson(res, 200, { ok: true, added: loaded.map((m) => m.slot), warnings });
  },

  // Programar la publicación de una mappool ({ round, at }) o publicarla ya ({ round, now: true }).
  // Textos de la web. Sin texto se borra: el anuncio desaparece y lo demás vuelve a su versión original.
  'POST /api/admin/site-text': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    const max = Object.hasOwn(SITE_TEXT_MAX, String(b.key)) ? SITE_TEXT_MAX[b.key] : 0;
    if (!max) throw new HttpError(400, 'Eso no se puede editar.');
    let text = String(b.text ?? '').replace(/\r\n?/g, '\n').trim();
    if (b.key === 'nombre' || b.key === 'comunidad') text = text.replace(/\s+/g, ' ');
    if (b.key === 'enlaces') parseLinks(text);
    if (text.length > max) throw new HttpError(400, `Es demasiado largo: ${text.length} caracteres, y el máximo es ${max}.`);
    if (text) q.setSiteText.run(b.key, text, Date.now());
    else q.delSiteText.run(b.key);
    applySiteConfig();
    sendJson(res, 200, { ok: true });
  },

  // Rondas: nombre, fechas, SR y best of. Mueven el torneo de verdad: fases, publicación de mappools y cierre de seeds.
  'POST /api/admin/fases': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    const before = phase('qualifiers');
    if (b.reset === true) {
      q.delSiteText.run('fases');
    } else {
      const list = Array.isArray(b.fases) ? b.fases : [];
      const saved = {};
      let prev = null;
      for (const base of BASE_CONFIG.fases) {
        const x = list.find((f) => f?.key === base.key);
        if (!x) throw new HttpError(400, `Falta la ronda ${base.nombre}.`);
        const nombre = String(x.nombre ?? '').replace(/\s+/g, ' ').trim();
        if (!nombre || nombre.length > 40) throw new HttpError(400, `Ponle un nombre a ${base.nombre} (máximo 40 caracteres).`);
        const inicio = String(x.inicio), fin = String(x.fin);
        if (!validDay(inicio) || !validDay(fin)) throw new HttpError(400, `${nombre}: revisa las fechas.`);
        if (inicio > fin) throw new HttpError(400, `${nombre}: termina antes de empezar.`);
        if (prev && inicio <= prev.fin) throw new HttpError(400, `${nombre} tiene que empezar después de que acabe ${prev.nombre}.`);
        const f = { nombre, inicio, fin };
        if (base.showcase != null) {
          f.showcase = String(x.showcase);
          if (!validDay(f.showcase) || f.showcase > inicio) throw new HttpError(400, `${nombre}: el showcase tiene que ser antes de que empiece, o ese mismo día.`);
        }
        if (base.sr != null) {
          f.sr = Number(x.sr);
          if (!(f.sr > 0 && f.sr <= 15)) throw new HttpError(400, `${nombre}: revisa el SR.`);
        }
        if (base.bo != null) {
          f.bo = Number(x.bo);
          if (!Number.isInteger(f.bo) || f.bo < 1 || f.bo > 25 || f.bo % 2 === 0) throw new HttpError(400, `${nombre}: el best of tiene que ser impar, de 1 a 25.`);
        }
        saved[base.key] = f;
        prev = f;
      }
      q.setSiteText.run('fases', JSON.stringify(saved), Date.now());
    }
    applySiteConfig();
    referee.push();
    const after = phase('qualifiers');
    const out = after.start === before.start && after.end === before.end ? 0 : q.qualSlots.all().filter((x) => x.time < after.start || x.time > after.end).length;
    sendJson(res, 200, { ok: true, warning: out ? `Guardado, pero ${out === 1 ? 'un lobby queda' : out + ' lobbies quedan'} fuera de las nuevas fechas de clasificatorios.` : null });
  },

  'POST /api/admin/pool/release': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    const round = String(b.round || '');
    if (!(round in releases())) throw new HttpError(400, 'Esa ronda no existe.');
    const at = b.now === true ? Date.now() : Number(b.at);
    if (!Number.isFinite(at) || Math.abs(at - Date.now()) > 366 * 86400e3) throw new HttpError(400, 'Elige la fecha y la hora de publicación.');
    q.setRelease.run(round, Math.round(at));
    sendJson(res, 200, { ok: true, at: Math.round(at) });
  },

  // Publicación de los resultados de clasificatorios: { at }, { now: true } o { hide: true }.
  'POST /api/admin/qual-results': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    if (b.hide === true) {
      q.delRelease.run(QUAL_RESULTS);
      return sendJson(res, 200, { ok: true, at: null });
    }
    const at = b.now === true ? Date.now() : Number(b.at);
    if (!Number.isFinite(at) || Math.abs(at - Date.now()) > 366 * 86400e3) throw new HttpError(400, 'Elige la fecha y la hora de publicación.');
    q.setRelease.run(QUAL_RESULTS, Math.round(at));
    sendJson(res, 200, { ok: true, at: Math.round(at) });
  },

  'POST /api/admin/pool/delete': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    q.delPool.run(String(b.round), String(b.slot));
    sendJson(res, 200, { ok: true });
  },

  'POST /api/admin/match': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    if (!MATCH_IDS.includes(b.id)) throw new HttpError(400, 'Ese partido no existe en el cuadro.');
    const prev = q.getMatch.get(b.id);
    const mp = b.mp ? parseId(b.mp, 'del multiplayer') : null;
    const time = b.time == null || b.time === '' ? null : +b.time;
    if (time !== null && !Number.isFinite(time)) throw new HttpError(400, 'La fecha no es válida.');
    const ff = b.ff === 'a' || b.ff === 'b' ? b.ff : null;
    const bans = Array.isArray(b.bans) ? b.bans.map((s) => String(s).toUpperCase().trim()).filter(Boolean).slice(0, 8) : [];
    const keepResult = prev && prev.mp === mp ? prev.result : null;
    q.upsertMatch.run(b.id, time, String(b.ref || '').slice(0, 40) || null, mp, ff, JSON.stringify(bans), keepResult, Date.now());
    let result = null;
    let warning = null;
    if (mp) {
      try { result = await syncMatch(b.id); } catch (e) { warning = e.message; }
    }
    sendJson(res, 200, { ok: true, result, warning });
  },

  'POST /api/admin/sync': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    if (!MATCH_IDS.includes(b.id)) throw new HttpError(400, 'Ese partido no existe en el cuadro.');
    sendJson(res, 200, { ok: true, result: await syncMatch(b.id) });
  },

  // Lobbies a los que se apuntan los jugadores (distintos de los MP ya jugados, que se añaden abajo).
  'POST /api/admin/qual-slot': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    const f = slotFields(b);
    if (b.id == null) {
      q.addSlot.run(f.name, f.time, f.size);
    } else {
      const slot = slotFrom(b.id);
      const n = q.slotCount.get(slot.id).n;
      if (f.size < n) throw new HttpError(400, `Ese lobby ya tiene ${n} jugadores apuntados: quita antes a los que sobren.`);
      q.updateSlot.run(f.name, f.time, f.size, slot.id);
    }
    const qp = phase('qualifiers');
    sendJson(res, 200, { ok: true, warning: f.time < qp.start || f.time > qp.end ? 'Guardado, pero esa hora queda fuera de las fechas de los clasificatorios.' : null });
  },

  // La rejilla de una vez: cada día es una letra y cada hora un número (A1, A2… B1, B2…). Lo que ya existe a esa hora se deja.
  'POST /api/admin/qual-slot/generate': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    const days = [...new Set(Array.isArray(b.days) ? b.days.map(String) : [])].sort();
    const times = [...new Set(Array.isArray(b.times) ? b.times.map(String) : [])].sort();
    if (!days.length || days.length > 26) throw new HttpError(400, 'Elige entre 1 y 26 días.');
    for (const d of days) if (!validDay(d)) throw new HttpError(400, `La fecha ${d} no existe.`);
    if (!times.length || times.length > 24 || times.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) throw new HttpError(400, 'Escribe las horas así: 15:00, 16:00, 23:59.');
    const { size } = slotFields({ name: 'x', time: 1, size: b.size });
    const existing = q.qualSlots.all().filter((x) => !EXTRA_NAME.test(x.name)); // los extraordinarios no ocupan sitio en la rejilla
    const taken = new Set(existing.map((x) => x.time));
    const named = existing.map((x) => ({ day: dayOf(x.time), m: x.name.match(/^([A-Z])(\d+)$/) })).filter((x) => x.m);
    const letters = new Set(named.map((x) => x.m[1]));
    const rows = [];
    let skipped = 0, late = 0, past = 0;
    const qEnd = phase('qualifiers').end;
    for (const day of days) {
      let letter = named.find((x) => x.day === day)?.m[1];
      if (!letter) {
        letter = [...'ABCDEFGHIJKLMNOPQRSTUVWYZ'].find((l) => !letters.has(l));
        if (!letter) throw new HttpError(400, 'Ya están usadas todas las letras: quita antes lobbies vacíos.');
        letters.add(letter);
      }
      let n = Math.max(0, ...named.filter((x) => x.m[1] === letter).map((x) => +x.m[2]));
      for (const t of times) {
        const time = zoned(`${day}T${t}`, false, CONFIG.zona);
        if (taken.has(time)) { skipped++; continue; }
        if (time <= Date.now()) { past++; continue; } // nadie podría apuntarse
        if (time <= qEnd && time > qEnd - QUAL_LAST_CALL) { late++; continue; }
        rows.push([`${letter}${++n}`, time, size]);
      }
    }
    db.exec('BEGIN');
    try {
      for (const r of rows) q.addSlot.run(...r);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    sendJson(res, 200, { ok: true, created: rows.length, skipped, late, past,
      warning: !rows.length && past ? 'Esas fechas ya han pasado: no se ha creado ningún lobby, porque nadie podría apuntarse. Elige días futuros.' : null });
  },

  // Limpia un día: quita los lobbies sin jugadores y sin MP.
  'POST /api/admin/qual-slot/delete-empty': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    const empty = q.qualSlots.all().filter((x) => dayOf(x.time) === String(b.day) && !x.mp && !q.slotCount.get(x.id).n);
    for (const x of empty) q.delSlot.run(x.id);
    sendJson(res, 200, { ok: true, removed: empty.length });
  },

  // Árbitro de un lobby: la organización elige a cualquiera (ref: ID, o null para dejarlo sin árbitro).
  'POST /api/admin/qual-slot/ref': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    const slot = slotFrom(b.id);
    const ref = b.ref == null ? null : +b.ref;
    if (ref !== null) {
      if (!isRef({ id: ref })) throw new HttpError(400, 'Esa persona no es árbitro.');
      if (q.signupOf.get(ref)?.slot_id === slot.id) throw new HttpError(409, 'Esa persona juega en este lobby: no puede arbitrarlo.');
    }
    q.setSlotRef.run(ref, slot.id);
    referee.push();
    sendJson(res, 200, { ok: true });
  },

  // Los árbitros se piden un lobby libre o dejan el suyo.
  'POST /api/ref/qual-claim': async (req, res) => {
    const u = requireRef(req);
    const b = await readJson(req);
    const slot = slotFrom(b.id);
    if (b.on === false) {
      if (slot.ref_id !== u.id) throw new HttpError(403, 'Ese lobby no es tuyo.');
      q.setSlotRef.run(null, slot.id);
    } else {
      if (slot.ref_id && slot.ref_id !== u.id) throw new HttpError(409, 'Ese lobby ya tiene árbitro.');
      if (q.signupOf.get(u.id)?.slot_id === slot.id) throw new HttpError(409, 'No puedes arbitrar un lobby en el que juegas.');
      q.setSlotRef.run(u.id, slot.id);
    }
    referee.push();
    sendJson(res, 200, { ok: true });
  },

  'POST /api/admin/qual-slot/delete': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    const slot = slotFrom(b.id);
    q.delSlotSignups.run(slot.id);
    q.delSlot.run(slot.id);
    sendJson(res, 200, { ok: true });
  },

  // La organización coloca o quita a un jugador aunque el lobby haya empezado; las plazas sí se respetan.
  'POST /api/admin/qual-slot/assign': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    const slot = slotFrom(b.id);
    const player = q.getUser.get(+b.user);
    if (!player?.registered_at) throw new HttpError(400, 'Ese jugador no está inscrito.');
    if (q.signupOf.get(player.id)?.slot_id !== slot.id && q.slotCount.get(slot.id).n >= slot.size) throw new HttpError(409, 'Ese lobby está lleno.');
    if (slot.ref_id === player.id) throw new HttpError(409, 'Esa persona arbitra este lobby: no puede jugarlo.');
    q.setSignup.run(player.id, slot.id, Date.now(), 1); // lo pone la organización: ya está aprobado
    q.delRejection.run(player.id);
    sendJson(res, 200, { ok: true });
  },

  'POST /api/admin/qual-slot/remove': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    q.delSignup.run(+b.user);
    sendJson(res, 200, { ok: true });
  },

  'POST /api/admin/qual': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    const mp = parseId(b.mp, 'del multiplayer');
    const parsed = await syncQual(mp);
    sendJson(res, 200, { ok: true, players: Object.keys(parsed.scores).length, warning: parsed.skipped ? `Lobby añadido, pero ${parsed.skipped} ${parsed.skipped === 1 ? 'mapa no se jugó' : 'mapas no se jugaron'} en head to head y no cuentan.` : null });
  },

  'POST /api/admin/qual/delete': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    q.delQual.run(parseId(b.mp, 'del multiplayer'));
    sendJson(res, 200, { ok: true });
  },

  'POST /api/admin/qual/sync': async (req, res) => {
    requireAdmin(req);
    await readJson(req);
    const lobbies = q.quals.all();
    const failed = [];
    for (const l of lobbies) {
      try { await syncQual(l.mp); } catch (e) { failed.push(`#${l.mp} (${e.message})`); }
    }
    sendJson(res, 200, { ok: true, lobbies: lobbies.length, warning: failed.length ? 'No se pudieron leer: ' + failed.join(', ') : null });
  },

  'POST /api/admin/player/delete': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    q.unregister.run(Date.now(), +b.id);
    q.delSignup.run(+b.id);
    q.delRequest.run(+b.id);
    q.delRejection.run(+b.id);
    sendJson(res, 200, { ok: true });
  },

  // Vuelve a pedir el rango de todos los inscritos (1 petición por segundo).
  'POST /api/admin/refresh': async (req, res) => {
    requireAdmin(req);
    await readJson(req);
    const list = q.registered.all();
    const failed = [];
    for (const p of list) {
      try { saveUser(await osu.user(p.id)); } catch { failed.push(p.username); }
    }
    sendJson(res, 200, { ok: true, updated: list.length - failed.length, warning: failed.length ? 'No se pudo leer el perfil de: ' + failed.join(', ') : null });
  },

  // Inscritos del formulario de Google: se pega la hoja de respuestas. Se puede repetir sin duplicar a nadie.
  // Cada jugador se busca en osu! y pasa la misma comprobación de rango que en la web (salvo las fechas).
  'POST /api/admin/import': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    const entries = parseResponses(b.text);
    if (!entries.length) throw new HttpError(400, 'No hay respuestas en el texto pegado. Copia la hoja de respuestas con la fila de títulos.');
    if (entries.length > 500) throw new HttpError(400, 'Demasiadas filas: el máximo son 500 respuestas por importación.');

    // 1) Nombres exactos, de 50 en 50. 2) Los que falten, uno a uno (nombres antiguos, espacios/guiones bajos) o por ID.
    const key = (s) => String(s).toLowerCase().replace(/ /g, '_');
    const found = new Map();
    const byName = entries.filter((e) => e.name);
    for (const u of await osu.lookupUsers(byName.map((e) => e.name))) {
      found.set(key(u.username), { ...u, statistics: { global_rank: u.global_rank?.rank ?? null } });
    }
    const out = { imported: [], already: [], notFound: [], rejected: [], removed: [] };
    for (const e of entries) {
      const label = e.name ?? `ID ${e.id}`;
      let u = e.name ? found.get(key(e.name)) : null;
      if (!u) {
        try { u = e.id ? await osu.user(e.id) : await osu.userByName(e.name); } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
      if (!u) { out.notFound.push(label); continue; }
      saveUser(u);
      const prev = q.getUser.get(u.id);
      if (prev.removed_at) { out.removed.push(u.username); continue; }
      if (prev.registered_at) {
        q.importRegister.run(e.availability, prev.registered_at, u.id);
        out.already.push(u.username);
        continue;
      }
      const reason = eligibility(u);
      if (reason) {
        out.rejected.push({ name: u.username, rank: u.statistics?.global_rank ?? null, country: u.country_code });
        continue;
      }
      q.importRegister.run(e.availability, e.time ?? Date.now(), u.id);
      out.imported.push(u.username);
    }
    sendJson(res, 200, { ok: true, ...out });
  },

  // Excepciones de rango sin tocar config.json.
  'POST /api/admin/exception': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    const id = parseId(b.user, 'del perfil de osu!');
    let u;
    try { u = await osu.user(id); } catch (e) {
      if (e.status !== 404) throw e;
    }
    // Comprobación defensiva: la documentación de osu! dice que un ID inexistente puede buscarse como nombre.
    if (u?.id !== id) throw new HttpError(404, `No existe ningún jugador de osu! con el ID ${id}.`);
    q.addException.run(u.id, u.username, Date.now());
    sendJson(res, 200, { ok: true, username: u.username });
  },

  'POST /api/admin/exception/delete': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    q.delException.run(+b.id);
    sendJson(res, 200, { ok: true });
  },

  // Roles: solo el host. { user: nombre, ID o enlace, role } o { id, role }; sin role, se le quita.
  'POST /api/admin/role': async (req, res) => {
    requireHost(req);
    const b = await readJson(req);
    const role = String(b.role ?? '');
    if (role && !ROLES.includes(role)) throw new HttpError(400, 'Elige un rol válido.');
    let id = Number(b.id), username = q.roleOf.get(id)?.username;
    if (b.id == null) {
      const raw = String(b.user ?? '').trim();
      if (!raw) throw new HttpError(400, 'Escribe el nombre o el ID de osu!.');
      const u = await findOsuUser(raw);
      id = u.id; username = u.username;
    } else if (!Number.isInteger(id) || !username) throw new HttpError(404, 'Esa persona no tiene ningún rol.');
    if (HOST_IDS.has(id)) throw new HttpError(400, 'El host no se cambia desde aquí: va en ADMIN_IDS, en la configuración del servidor.');
    if (role) q.setRole.run(id, role, username, Date.now()); else q.delRole.run(id);
    if (role !== 'admin' && role !== 'referee') { // deja de poder arbitrar: se cierra su conexión a Bancho y deja sus lobbies
      referee.disconnect({ id });
      q.clearRef.run(id);
    }
    sendJson(res, 200, { ok: true, username, role });
  },

  'POST /api/admin/rules': async (req, res) => {
    requireAdmin(req);
    const b = await readJson(req);
    if (!BRACKET_ROUNDS.includes(b.round)) throw new HttpError(400, 'Elige una ronda del cuadro.');
    const int = (v, min, max, what) => {
      const n = Number(v);
      if (v === '' || v == null || !Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${what}: un número de ${min} a ${max}.`);
      return n;
    };
    const rules = {
      bans: int(b.bans, 0, 4, 'Bans por jugador'), protects: int(b.protects, 0, 2, 'Protects por jugador'),
      banEvery: int(b.banEvery, 1, 10, 'Mapas entre tandas de bans'), pickTimer: int(b.pickTimer, 0, 300, 'Segundos para elegir')
    };
    q.setRoundRules.run(b.round, JSON.stringify(rules));
    referee.push();
    // Aviso si con estos bans no quedan mapas para todos los picks posibles.
    const f = CONFIG.fases.find((x) => x.key === b.round);
    const free = q.poolRound.all(b.round).filter((r) => r.slot !== 'TB').length - 2 * rules.bans;
    const picks = f.bo - 1;
    const warning = q.poolRound.all(b.round).length && free < picks
      ? `Reglas guardadas, pero con ${rules.bans} bans por jugador quedan ${free} mapas para elegir y un Bo${f.bo} puede necesitar ${picks} picks antes del TB.` : null;
    sendJson(res, 200, { ok: true, rules, warning });
  },

  // ---------- arbitraje ----------
  // Página del árbitro en directo: se le manda el estado cada vez que algo cambia (Server-Sent Events).
  'GET /api/ref/events': (req, res) => {
    const u = requireRef(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const off = referee.subscribe(u, res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
    req.on('close', () => { clearInterval(ping); off(); });
  },

  // La contraseña IRC solo vive en la memoria del servidor mientras dura la conexión: no se guarda ni se escribe en los logs.
  'POST /api/ref/connect': async (req, res) => {
    const u = requireRef(req);
    const b = await readJson(req);
    await referee.connect(u, b.password);
    sendJson(res, 200, { ok: true });
  },

  'POST /api/ref/disconnect': async (req, res) => {
    const u = requireRef(req);
    await readJson(req);
    referee.disconnect(u);
    sendJson(res, 200, { ok: true });
  },

  'POST /api/ref/lobby': async (req, res) => {
    const u = requireRef(req);
    const b = await readJson(req);
    const r = await referee.createLobby(u, { match: b.match ? String(b.match) : null, qualName: b.qual, qualSlot: b.slot, replace: b.replace === true });
    sendJson(res, 200, { ok: true, ...r });
  },

  'POST /api/ref/attach': async (req, res) => {
    const u = requireRef(req);
    const b = await readJson(req);
    referee.attach(u, b.key);
    sendJson(res, 200, { ok: true });
  },

  'POST /api/ref/act': async (req, res) => {
    const u = requireRef(req);
    const b = await readJson(req);
    await referee.act(u, b.key, b);
    sendJson(res, 200, { ok: true });
  },

  'POST /api/ref/chat': async (req, res) => {
    const u = requireRef(req);
    const b = await readJson(req);
    referee.chat(u, b.key, b.text);
    sendJson(res, 200, { ok: true });
  }
};

// ---------- archivos estáticos ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
async function serveStatic(res, pathname) {
  let rel;
  try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { throw new HttpError(404, 'No encontrado'); }
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(404, 'No encontrado');
  let data;
  try { data = await readFile(file); } catch { throw new HttpError(404, 'No encontrado'); }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
    'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600'
  });
  res.end(data);
}

const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data: https://*.ppy.sh https://static-cdn.jtvnw.net", "connect-src 'self'",
  "frame-src https://player.twitch.tv",
  "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"
].join('; ');

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  if (SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  let url = null;
  try {
    try { url = new URL(req.url, BASE_URL); } catch { throw new HttpError(400, 'Dirección no válida.'); }
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return await route(req, res, url);
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(res, url.pathname);
    throw new HttpError(404, 'No encontrado');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e instanceof osu.OsuError ? 502 : 500;
    if (status >= 500) console.error(`[${req.method} ${url?.pathname ?? req.url}]`, e);
    if (res.headersSent) return res.end();
    if (status === 413) res.setHeader('Connection', 'close'); // queda cuerpo sin leer: esa conexión no se puede reutilizar
    sendJson(res, status, { error: status === 500 ? 'Error interno del servidor.' : e.message });
  }
});

server.listen(PORT, () => {
  console.log(`SpiSix: Fall Cup en ${BASE_URL} (puerto ${PORT})`);
  if (!osu.configured()) console.warn('Aviso: faltan OSU_CLIENT_ID y OSU_CLIENT_SECRET; el login y la API no funcionarán.');
  if (!HOST_IDS.size) console.warn('Aviso: ADMIN_IDS está vacío; no hay host, así que nadie podrá usar el panel de administración.');
  if (CONFIG.twitch && !/^\w{3,25}$/.test(CONFIG.twitch)) console.warn('Aviso: "twitch" en config.json debe ser el nombre del canal (p. ej. spi6_osu), no el enlace.');
  if (CONFIG.twitch && !twitch.configured()) console.warn('Aviso: faltan TWITCH_CLIENT_ID y TWITCH_CLIENT_SECRET; la web no sabrá cuándo hay directo.');
  if (process.env.NODE_ENV === 'production' && !SECURE) console.warn('Aviso: BASE_URL no empieza por https://; el login con osu! y la cookie de sesión necesitan HTTPS en producción.');
});

const timer = setInterval(() => autoSync().catch((e) => console.warn('[sync]', e.message)), 5 * 60e3);
timer.unref();

// Directo de Twitch: se consulta cada minuto (una petición; el límite de Twitch es de 800 por minuto).
// Si Twitch falla, se mantiene lo último que se supo durante 5 minutos.
let twitchLive = null;
let twitchOkAt = 0;
let twitchErr = '';
async function pollTwitch() {
  try {
    twitchLive = await twitch.stream(CONFIG.twitch);
    twitchOkAt = Date.now();
    twitchErr = '';
  } catch (e) {
    if (e.message !== twitchErr) console.warn('[twitch]', e.message); // cada error distinto, una vez
    twitchErr = e.message;
    if (Date.now() - twitchOkAt > 5 * 60e3) twitchLive = null;
  }
}
const twitchTimer = twitch.configured() && CONFIG.twitch ? setInterval(pollTwitch, 60e3) : null;
if (twitchTimer) { twitchTimer.unref(); pollTwitch(); }
setTimeout(() => autoSync().catch((e) => console.warn('[sync]', e.message)), 10e3).unref(); // copia y sincronización al arrancar

// Docker para el contenedor con SIGTERM: se terminan las peticiones en curso y se cierra la base de datos.
function shutdown(signal) {
  console.log(`${signal}: cerrando la web…`);
  clearInterval(timer);
  clearInterval(twitchTimer);
  referee.shutdown();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { server };
