// Estado del directo en Twitch con la API Helix (Get Streams) y un token de aplicación (client credentials).
// https://dev.twitch.tv/docs/api/reference/#get-streams · https://dev.twitch.tv/docs/authentication/
const AUTH = (process.env.TWITCH_BASE || 'https://id.twitch.tv').replace(/\/$/, '');
const API = (process.env.TWITCH_BASE || 'https://api.twitch.tv').replace(/\/$/, '');
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TIMEOUT_MS = 15_000;

export const configured = () => Boolean(CLIENT_ID && CLIENT_SECRET);

async function request(url, opts, what) {
  let r;
  try { r = await fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) }); } catch { throw Object.assign(new Error(`Twitch no ha respondido al ${what}`), { status: 0 }); }
  if (!r.ok) throw Object.assign(new Error(`Twitch respondió ${r.status} al ${what}`), { status: r.status });
  return r.json();
}

let token = null;
let tokenExp = 0;
async function appToken() {
  if (token && Date.now() < tokenExp - 60e3) return token;
  const t = await request(AUTH + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'client_credentials' })
  }, 'pedir el token');
  token = t.access_token;
  tokenExp = Date.now() + (t.expires_in || 3600) * 1000;
  return token;
}

// Directo actual del canal, o null si no está en directo.
export async function stream(login) {
  const get = async () => request(`${API}/helix/streams?user_login=${encodeURIComponent(login)}`,
    { headers: { 'Client-Id': CLIENT_ID, Authorization: 'Bearer ' + (await appToken()) } }, 'consultar el directo');
  let d;
  try { d = await get(); } catch (e) {
    if (e.status !== 401) throw e;
    token = null; // token caducado o revocado: se pide otro y se repite una vez
    d = await get();
  }
  const s = d.data?.find((x) => x.type === 'live');
  if (!s) return null;
  return {
    id: String(s.id), title: s.title || '', game: s.game_name || '', viewers: s.viewer_count || 0,
    started_at: Date.parse(s.started_at) || null,
    thumbnail: String(s.thumbnail_url || '').replace('{width}', '640').replace('{height}', '360')
  };
}
