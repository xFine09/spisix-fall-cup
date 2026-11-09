// Base de datos SQLite (módulo node:sqlite incluido en Node 22.5+).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const file = process.env.DB_PATH || 'data/spisix.db';
const BACKUP_DIR = join(dirname(file), 'backups');
const BACKUPS_KEPT = 14;
mkdirSync(dirname(file), { recursive: true });
export const db = new DatabaseSync(file);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,   -- id de osu!
    username      TEXT NOT NULL,
    avatar_url    TEXT,
    country       TEXT,
    rank          INTEGER,               -- rango global en osu! standard
    registered_at INTEGER,               -- NULL = ha iniciado sesión pero no está inscrito
    updated_at    INTEGER,
    availability  TEXT,                  -- disponibilidad horaria que escribe el jugador
    removed_at    INTEGER                -- se borró o lo quitó la organización: la importación no lo vuelve a añadir
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pool (
    round      TEXT NOT NULL,
    slot       TEXT NOT NULL,
    beatmap_id INTEGER NOT NULL,
    data       TEXT NOT NULL,            -- datos del mapa ya calculados (JSON)
    PRIMARY KEY (round, slot)
  );
  CREATE TABLE IF NOT EXISTS matches (
    id         TEXT PRIMARY KEY,         -- u1-1, l2-3, gf...
    time       INTEGER,
    ref        TEXT,
    mp         INTEGER,                  -- id del multiplayer de osu!
    ff         TEXT,                     -- 'a' o 'b' si gana por forfeit
    bans       TEXT,                     -- JSON con los slots baneados
    result     TEXT,                     -- JSON calculado desde /matches
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS qual_lobbies (
    mp         INTEGER PRIMARY KEY,
    data       TEXT,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS pool_release (   -- hora a la que se hace pública cada mappool (si no hay: día del showcase)
                                              -- y, con round = 'qual-results', la de los resultados de clasificatorios
    round TEXT PRIMARY KEY,
    at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ref_state (      -- arbitraje: roll, orden, protects, bans y picks de cada partido (JSON)
    key        TEXT PRIMARY KEY,         -- id del partido (u1-1…) o qual:<mp> para un lobby de clasificatorios
    data       TEXT NOT NULL,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS roles (          -- admins, árbitros y staff que asigna el host (el host va en ADMIN_IDS)
    user_id    INTEGER PRIMARY KEY,
    role       TEXT NOT NULL,            -- admin | referee | staff
    username   TEXT,
    added_at   INTEGER
  );
  CREATE TABLE IF NOT EXISTS qual_slots (     -- lobbies de clasificatorios a los que se apuntan los jugadores
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    time       INTEGER NOT NULL,
    size       INTEGER NOT NULL,
    mp         INTEGER                   -- el MP, cuando un árbitro lo crea desde la web
  );
  CREATE TABLE IF NOT EXISTS qual_requests (  -- la última solicitud de lobby extraordinario de cada jugador
    user_id INTEGER PRIMARY KEY,
    time    INTEGER NOT NULL,                 -- la hora que propone
    note    TEXT,
    status  TEXT NOT NULL,                    -- pending | rejected (al aceptarla, se borra)
    reason  TEXT,
    at      INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS qual_signups (   -- cada jugador está en un solo lobby
    user_id    INTEGER PRIMARY KEY,
    slot_id    INTEGER NOT NULL,
    at         INTEGER NOT NULL,
    approved   INTEGER NOT NULL DEFAULT 1     -- 0: la pide el jugador y falta que la apruebe un árbitro o admin
  );
  CREATE TABLE IF NOT EXISTS qual_rejections ( -- el último rechazo de cada jugador, para que lo vea
    user_id INTEGER PRIMARY KEY,
    lobby   TEXT NOT NULL,
    time    INTEGER NOT NULL,
    reason  TEXT
  );
  CREATE TABLE IF NOT EXISTS site_text (      -- lo que escriben los admins: normas de Info y anuncio de Inicio
    key  TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    at   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS round_rules (    -- bans, protects y temporizador de cada ronda (JSON)
    round TEXT PRIMARY KEY,
    data  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS exceptions (  -- admitidos fuera del rango
    user_id    INTEGER PRIMARY KEY,
    username   TEXT,
    added_at   INTEGER
  );
`);

// Columnas añadidas después de crear la tabla en bases de datos ya existentes.
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('availability')) db.exec('ALTER TABLE users ADD COLUMN availability TEXT');
if (!userCols.includes('removed_at')) db.exec('ALTER TABLE users ADD COLUMN removed_at INTEGER');
// La web ya no usa Discord: borra lo que guardaran las versiones anteriores.
for (const c of ['discord_id', 'discord']) if (userCols.includes(c)) db.exec(`ALTER TABLE users DROP COLUMN ${c}`);
db.exec('DROP TABLE IF EXISTS alerts; DROP TABLE IF EXISTS announcements');
if (!db.prepare('PRAGMA table_info(qual_signups)').all().some((c) => c.name === 'approved')) db.exec('ALTER TABLE qual_signups ADD COLUMN approved INTEGER NOT NULL DEFAULT 1');
if (!db.prepare('PRAGMA table_info(qual_slots)').all().some((c) => c.name === 'ref_id')) db.exec('ALTER TABLE qual_slots ADD COLUMN ref_id INTEGER');
// Los árbitros añadidos antes de que existieran los roles pasan a ser un rol más.
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'referees'").get()) {
  db.exec(`BEGIN;
    INSERT OR IGNORE INTO roles (user_id, role, username, added_at) SELECT user_id, 'referee', username, added_at FROM referees;
    DROP TABLE referees;
    COMMIT;`);
}

const n = (v) => (v === undefined ? null : v);

const st = {
  getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
  upsertUser: db.prepare(`INSERT INTO users (id, username, avatar_url, country, rank, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET username = excluded.username, avatar_url = excluded.avatar_url,
      country = excluded.country, rank = excluded.rank, updated_at = excluded.updated_at`),
  // Desde el formulario de Google: solo rellena lo que falte (repetir la importación no pisa nada).
  importRegister: db.prepare(`UPDATE users SET availability = COALESCE(NULLIF(availability, ''), NULLIF(?, '')), registered_at = COALESCE(registered_at, ?) WHERE id = ?`),
  unregister: db.prepare('UPDATE users SET registered_at = NULL, removed_at = ? WHERE id = ?'),
  registered: db.prepare('SELECT * FROM users WHERE registered_at IS NOT NULL ORDER BY registered_at'),
  newSession: db.prepare('INSERT INTO sessions (sid, user_id, expires) VALUES (?, ?, ?)'),
  getSession: db.prepare('SELECT * FROM sessions WHERE sid = ? AND expires > ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE sid = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
  pool: db.prepare('SELECT * FROM pool'),
  poolRound: db.prepare('SELECT * FROM pool WHERE round = ?'),
  upsertPool: db.prepare(`INSERT INTO pool (round, slot, beatmap_id, data) VALUES (?, ?, ?, ?)
    ON CONFLICT(round, slot) DO UPDATE SET beatmap_id = excluded.beatmap_id, data = excluded.data`),
  delPool: db.prepare('DELETE FROM pool WHERE round = ? AND slot = ?'),
  delPoolRound: db.prepare('DELETE FROM pool WHERE round = ?'),
  matches: db.prepare('SELECT * FROM matches'),
  getMatch: db.prepare('SELECT * FROM matches WHERE id = ?'),
  upsertMatch: db.prepare(`INSERT INTO matches (id, time, ref, mp, ff, bans, result, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET time = excluded.time, ref = excluded.ref, mp = excluded.mp, ff = excluded.ff,
      bans = excluded.bans, result = excluded.result, updated_at = excluded.updated_at`),
  setResult: db.prepare('UPDATE matches SET result = ?, updated_at = ? WHERE id = ?'),
  quals: db.prepare('SELECT * FROM qual_lobbies'),
  getQual: db.prepare('SELECT * FROM qual_lobbies WHERE mp = ?'),
  upsertQual: db.prepare(`INSERT INTO qual_lobbies (mp, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(mp) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
  delQual: db.prepare('DELETE FROM qual_lobbies WHERE mp = ?'),
  exceptions: db.prepare('SELECT * FROM exceptions ORDER BY added_at'),
  addException: db.prepare(`INSERT INTO exceptions (user_id, username, added_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET username = excluded.username`),
  delException: db.prepare('DELETE FROM exceptions WHERE user_id = ?'),
  releases: db.prepare('SELECT * FROM pool_release'),
  setRelease: db.prepare('INSERT INTO pool_release (round, at) VALUES (?, ?) ON CONFLICT(round) DO UPDATE SET at = excluded.at'),
  getRelease: db.prepare('SELECT at FROM pool_release WHERE round = ?'),
  delRelease: db.prepare('DELETE FROM pool_release WHERE round = ?'),
  getRefState: db.prepare('SELECT * FROM ref_state WHERE key = ?'),
  refStates: db.prepare('SELECT * FROM ref_state'),
  setRefState: db.prepare(`INSERT INTO ref_state (key, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
  // Bans apuntados desde el arbitraje: crea el partido si aún no estaba guardado.
  setBans: db.prepare(`INSERT INTO matches (id, bans, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET bans = excluded.bans`),
  roles: db.prepare('SELECT * FROM roles ORDER BY added_at'),
  roleOf: db.prepare('SELECT * FROM roles WHERE user_id = ?'),
  setRole: db.prepare(`INSERT INTO roles (user_id, role, username, added_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, username = excluded.username`),
  delRole: db.prepare('DELETE FROM roles WHERE user_id = ?'),
  qualSlots: db.prepare(`SELECT s.*, COALESCE(r.username, u.username) AS ref_name FROM qual_slots s
    LEFT JOIN roles r ON r.user_id = s.ref_id LEFT JOIN users u ON u.id = s.ref_id ORDER BY s.time, s.id`),
  qualSlot: db.prepare('SELECT * FROM qual_slots WHERE id = ?'),
  slotByMp: db.prepare('SELECT * FROM qual_slots WHERE mp = ?'),
  addSlot: db.prepare('INSERT INTO qual_slots (name, time, size) VALUES (?, ?, ?)'),
  updateSlot: db.prepare('UPDATE qual_slots SET name = ?, time = ?, size = ? WHERE id = ?'),
  setSlotMp: db.prepare('UPDATE qual_slots SET mp = ? WHERE id = ?'),
  setSlotRef: db.prepare('UPDATE qual_slots SET ref_id = ? WHERE id = ?'),
  clearRef: db.prepare('UPDATE qual_slots SET ref_id = NULL WHERE ref_id = ?'),
  delSlot: db.prepare('DELETE FROM qual_slots WHERE id = ?'),
  siteText: db.prepare('SELECT text, at FROM site_text WHERE key = ?'),
  setSiteText: db.prepare(`INSERT INTO site_text (key, text, at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET text = excluded.text, at = excluded.at`),
  delSiteText: db.prepare('DELETE FROM site_text WHERE key = ?'),
  requestOf: db.prepare('SELECT * FROM qual_requests WHERE user_id = ?'),
  pendingRequests: db.prepare(`SELECT r.user_id, r.time, r.note, r.at, u.username, s.name AS lobby FROM qual_requests r
    JOIN users u ON u.id = r.user_id LEFT JOIN qual_signups g ON g.user_id = r.user_id LEFT JOIN qual_slots s ON s.id = g.slot_id
    WHERE r.status = 'pending' ORDER BY r.at, r.user_id`),
  setRequest: db.prepare(`INSERT INTO qual_requests (user_id, time, note, status, reason, at) VALUES (?, ?, ?, 'pending', NULL, ?)
    ON CONFLICT(user_id) DO UPDATE SET time = excluded.time, note = excluded.note, status = 'pending', reason = NULL, at = excluded.at`),
  rejectRequest: db.prepare("UPDATE qual_requests SET status = 'rejected', reason = ? WHERE user_id = ?"),
  delRequest: db.prepare('DELETE FROM qual_requests WHERE user_id = ?'),
  signups: db.prepare('SELECT * FROM qual_signups ORDER BY at, user_id'),
  signupOf: db.prepare('SELECT * FROM qual_signups WHERE user_id = ?'),
  slotCount: db.prepare('SELECT COUNT(*) AS n FROM qual_signups WHERE slot_id = ?'),
  slotPlayers: db.prepare(`SELECT u.id, u.username FROM qual_signups s JOIN users u ON u.id = s.user_id
    WHERE s.slot_id = ? AND s.approved = 1 AND u.registered_at IS NOT NULL ORDER BY s.at, u.id`),
  setSignup: db.prepare(`INSERT INTO qual_signups (user_id, slot_id, at, approved) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET slot_id = excluded.slot_id, at = excluded.at, approved = excluded.approved`),
  approveSignup: db.prepare('UPDATE qual_signups SET approved = 1 WHERE user_id = ?'),
  rejectionOf: db.prepare('SELECT lobby, time, reason FROM qual_rejections WHERE user_id = ?'),
  setRejection: db.prepare(`INSERT INTO qual_rejections (user_id, lobby, time, reason) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET lobby = excluded.lobby, time = excluded.time, reason = excluded.reason`),
  delRejection: db.prepare('DELETE FROM qual_rejections WHERE user_id = ?'),
  delSignup: db.prepare('DELETE FROM qual_signups WHERE user_id = ?'),
  delSlotSignups: db.prepare('DELETE FROM qual_signups WHERE slot_id = ?'),
  roundRules: db.prepare('SELECT * FROM round_rules'),
  setRoundRules: db.prepare('INSERT INTO round_rules (round, data) VALUES (?, ?) ON CONFLICT(round) DO UPDATE SET data = excluded.data'),
  ping: db.prepare('SELECT 1 AS ok')
};

// Envoltorio que convierte undefined en NULL (node:sqlite no acepta undefined).
export const q = Object.fromEntries(Object.entries(st).map(([k, s]) => [k, {
  get: (...a) => s.get(...a.map(n)),
  all: (...a) => s.all(...a.map(n)),
  run: (...a) => s.run(...a.map(n))
}]));

// Copia de la base de datos en data/backups (VACUUM INTO crea una copia consistente aunque la web esté en marcha).
// Se guardan las últimas 14; el nombre lleva la fecha, y con withTime también la hora.
export function backup({ withTime = false } = {}) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, withTime ? 16 : 10).replace('T', '-').replace(':', '');
  const dest = join(BACKUP_DIR, `spisix-${stamp}.db`);
  if (existsSync(dest)) {
    if (!withTime) return null; // la copia de hoy ya está hecha
    rmSync(dest);
  }
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  const old = readdirSync(BACKUP_DIR).filter((f) => /^spisix-.*\.db$/.test(f)).sort().slice(0, -BACKUPS_KEPT);
  for (const f of old) rmSync(join(BACKUP_DIR, f));
  return dest;
}
