// Cliente mínimo de la API v2 de osu! (https://osu.ppy.sh/docs/)
// - OAuth: authorization_code para el login de jugadores, client_credentials (scope "public") para leer datos.
// - La documentación pide no pasar de 60 peticiones por minuto: aquí se hace como mucho 1 por segundo.

const OSU = (process.env.OSU_BASE || 'https://osu.ppy.sh').replace(/\/$/, '');
const CLIENT_ID = process.env.OSU_CLIENT_ID;
const CLIENT_SECRET = process.env.OSU_CLIENT_SECRET;
// Si osu! no responde, se corta la petición para no bloquear la cola del resto.
const TIMEOUT_MS = 15_000;

export class OsuError extends Error {
  constructor(status, what) {
    super(status ? `osu! respondió ${status} al pedir ${what}` : `osu! no ha respondido al pedir ${what}`);
    this.status = status;
  }
}

// fetch con tiempo máximo; un fallo de red o un corte se convierte en OsuError.
async function request(url, opts, what) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new OsuError(0, what);
  }
}

export const configured = () => Boolean(CLIENT_ID && CLIENT_SECRET);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let queue = Promise.resolve();
let last = 0;
function throttled(fn) {
  const p = queue.then(async () => {
    const wait = last + 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    return fn();
  });
  queue = p.catch(() => {});
  return p;
}

async function tokenRequest(params) {
  const r = await request(OSU + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params })
  }, 'un token OAuth');
  if (!r.ok) throw new OsuError(r.status, 'un token OAuth');
  return r.json();
}

let appToken = null;
let appTokenExpires = 0;
async function getAppToken() {
  if (appToken && Date.now() < appTokenExpires - 60_000) return appToken;
  const t = await tokenRequest({ grant_type: 'client_credentials', scope: 'public' });
  appToken = t.access_token;
  appTokenExpires = Date.now() + t.expires_in * 1000;
  return appToken;
}

async function api(path, { token, method = 'GET', body } = {}) {
  return throttled(async () => {
    const r = await request(OSU + '/api/v2' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + (token || (await getAppToken())),
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    }, path);
    if (r.status === 401 && !token) appToken = null; // token de aplicación caducado o revocado: se pide otro
    if (!r.ok) throw new OsuError(r.status, path);
    return r.json();
  });
}

// ---- Login de jugadores ----
// Solo se pide "identify" (leer el perfil público con /me): el resto de datos se leen con el token de aplicación.
export function authorizeUrl(state, redirectUri) {
  const u = new URL(OSU + '/oauth/authorize');
  u.search = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', scope: 'identify', state
  }).toString();
  return u.href;
}

export async function exchangeCode(code, redirectUri) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  return t.access_token;
}

// GET /me/osu → el usuario que ha iniciado sesión (requiere scope identify)
export const me = (userToken) => api('/me/osu', { token: userToken });

// ---- Datos públicos (token de aplicación) ----
export const user = (id) => api(`/users/${encodeURIComponent(id)}/osu`);
// Por nombre (con @): también encuentra nombres antiguos y trata igual espacios y guiones bajos.
export const userByName = (name) => api(`/users/@${encodeURIComponent(name)}/osu`);
// Hasta 50 nombres por petición, solo nombres exactos. Devuelve UserCompact con global_rank.rank.
export async function lookupUsers(names) {
  const out = [];
  for (let i = 0; i < names.length; i += 50) {
    const qs = new URLSearchParams([['ruleset_id', '0'], ...names.slice(i, i + 50).map((n) => ['ids[]', '@' + n])]);
    out.push(...((await api('/users/lookup?' + qs)).users || []));
  }
  return out;
}
export const beatmap = (id) => api(`/beatmaps/${id}`);
export const attributes = (id, mods) => api(`/beatmaps/${id}/attributes`, { method: 'POST', body: { mods, ruleset: 'osu' } });

// GET /matches/{id} devuelve como mucho 100 eventos; se pide hacia atrás hasta llegar al primero.
export async function match(id) {
  const data = await api(`/matches/${id}`);
  let events = data.events || [];
  for (let i = 0; i < 20 && events.length && data.first_event_id && events[0].id !== data.first_event_id; i++) {
    const older = await api(`/matches/${id}?before=${events[0].id}&limit=100`);
    if (!older.events?.length) break;
    events = [...older.events, ...events];
  }
  return { ...data, events };
}
