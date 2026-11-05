// Cliente IRC de Bancho (irc.ppy.sh) para arbitrar con la cuenta del propio árbitro.
// https://osu.ppy.sh/wiki/en/Community/Internet_Relay_Chat · Bancho solo ofrece IRC sin cifrar (puerto 6667).
import net from 'node:net';
import { EventEmitter } from 'node:events';

const HOST = process.env.BANCHO_HOST || 'irc.ppy.sh';
const PORT = +process.env.BANCHO_PORT || 6667;
// Límite de Bancho para cuentas normales en privados y #multiplayer: 10 mensajes cada 5 segundos
// (https://osu.ppy.sh/wiki/en/Bot_account). Se deja margen para lo que el árbitro escriba a la vez desde el juego:
// como mucho 8 cada 5 s y 18 cada 25 s (lo que usa bancho.js por defecto). Lo que no cabe espera en la cola.
const WINDOW_MS = +process.env.BANCHO_RATE_MS || 5000;
const LIMITS = [[WINDOW_MS, 8], [WINDOW_MS * 5, 18]];
// Un mismo aviso al mismo canal no se repite en 10 s (por ejemplo, si un jugador escribe varias veces un pick no válido).
const REPEAT_MS = WINDOW_MS * 2;
const CONNECT_TIMEOUT_MS = 15_000;
// Lo que ha mandado cada cuenta, compartido entre conexiones: el límite es de la cuenta y reconectar no lo reinicia.
const sentBy = new Map();

// El anti-spam de Bancho puede descartar un comando idéntico al anterior (otro «!mp start 5», otro «!mp timer 90»…).
// Como hace bancho.js, a los comandos que lo admiten se les añade al final una palabra al azar que Bancho no lee.
// Nunca es un número, para que no cuente como argumento.
const TAGGED = /^!mp (?:settings|close|abort|aborttimer|start(?: \d+)?|timer \d+|map \d+(?: \d)?|mods \S.*|set \d.*)$/i;
function antiSpam(text) {
  if (!TAGGED.test(text)) return text;
  let tag;
  do tag = Math.random().toString(36).slice(2, 8); while (!isNaN(tag));
  return `${text} ${tag}`;
}

// En IRC los espacios del nombre de osu! van como guiones bajos.
export const ircName = (name) => String(name ?? '').trim().replace(/ /g, '_');
export const sameName = (a, b) => ircName(a).toLowerCase() === ircName(b).toLowerCase();

export class BanchoError extends Error {}

// Eventos: 'message' { from, target, text } · 'join' canal · 'part' canal · 'nochannel' canal · 'out' { target, text } · 'close'
export class Bancho extends EventEmitter {
  constructor(username, password) {
    super();
    this.nick = ircName(username);
    this.password = password;
    this.queue = [];
    const who = this.nick.toLowerCase();
    if (!sentBy.has(who)) sentBy.set(who, []);
    this.sentAt = sentBy.get(who);
    this.recent = new Map();
    this.timer = null;
    this.sock = null;
    this.ready = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let buf = '';
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (err) { this.sock?.destroy(); reject(err); } else resolve();
      };
      const timeout = setTimeout(() => done(new BanchoError('Bancho no ha respondido. Vuelve a intentarlo en un rato.')), CONNECT_TIMEOUT_MS);
      const sock = net.connect(PORT, HOST);
      this.sock = sock;
      sock.setEncoding('utf8');
      sock.setTimeout(2 * 60e3, () => sock.destroy()); // Bancho manda PING cada poco (bancho.js corta al minuto): 2 minutos sin nada = conexión muerta
      sock.on('connect', () => {
        this.raw(`PASS ${this.password}`);
        this.raw(`USER ${this.nick} 0 * :${this.nick}`);
        this.raw(`NICK ${this.nick}`);
      });
      sock.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line) this.line(line, done);
        }
      });
      sock.on('error', (e) => done(new BanchoError(`No se puede conectar con Bancho (${e.code || e.message}).`)));
      sock.on('close', () => {
        const was = this.ready;
        this.ready = false;
        clearTimeout(this.timer);
        this.timer = null;
        done(new BanchoError('Bancho ha cerrado la conexión. Revisa el usuario y la contraseña IRC.'));
        if (was) this.emit('close');
      });
    });
  }

  line(line, done) {
    const m = line.match(/^(?::(\S+) )?(\S+)(?: (.*))?$/);
    if (!m) return;
    const [, prefix = '', cmd, rest = ''] = m;
    const from = prefix.split('!')[0];
    if (cmd === 'PING') return this.raw('PONG ' + rest);
    if (cmd === '001') { this.ready = true; return done(); }
    if (cmd === '464') return done(new BanchoError('Bancho rechaza la contraseña IRC. Cópiala otra vez desde los ajustes de tu cuenta de osu!.'));
    if (cmd === 'PRIVMSG') {
      const i = rest.indexOf(' :');
      if (i < 0) return;
      return this.emit('message', { from, target: rest.slice(0, i), text: rest.slice(i + 2) });
    }
    if (cmd === 'JOIN' && sameName(from, this.nick)) return this.emit('join', rest.replace(/^:/, '').trim());
    if (cmd === 'PART' && sameName(from, this.nick)) return this.emit('part', rest.replace(/^:/, '').split(' ')[0]);
    if (cmd === '403') return this.emit('nochannel', rest.split(' ')[1]); // «No such channel»: el lobby está cerrado o no eres árbitro
  }

  raw(text) {
    if (this.sock && !this.sock.destroyed) this.sock.write(String(text).replace(/[\r\n]+/g, ' ') + '\r\n');
  }

  // Mensaje a un canal (#mp_…) o a un usuario (BanchoBot). Se envía en orden respetando el límite.
  // repeat: true para lo que escribe el árbitro a mano (se manda aunque sea igual que el anterior).
  say(target, text, { repeat = false } = {}) {
    const clean = String(text).replace(/[\r\n]+/g, ' ').trim().slice(0, 400);
    if (!clean) return;
    if (!repeat && !clean.startsWith('!')) {
      const now = Date.now();
      const key = target + '\n' + clean;
      if (now - (this.recent.get(key) ?? -Infinity) < REPEAT_MS) return;
      this.recent.set(key, now);
      if (this.recent.size > 200) for (const [k, t] of this.recent) if (now - t >= REPEAT_MS) this.recent.delete(k);
    }
    this.queue.push({ target, text: clean, wire: antiSpam(clean) });
    this.pump();
  }

  pump() {
    if (this.timer || !this.queue.length || !this.ready) return;
    const now = Date.now();
    const keep = this.sentAt.findIndex((t) => now - t < LIMITS.at(-1)[0]);
    this.sentAt.splice(0, keep < 0 ? this.sentAt.length : keep);
    // Si alguna ventana está llena, se espera a que salga de ella el mensaje que sobra.
    let wait = 0;
    for (const [ms, max] of LIMITS) {
      const inside = this.sentAt.filter((t) => now - t < ms);
      if (inside.length >= max) wait = Math.max(wait, ms - (now - inside[inside.length - max]));
    }
    if (!wait) {
      const { target, text, wire } = this.queue.shift();
      this.sentAt.push(now);
      this.raw(`PRIVMSG ${target} :${wire}`);
      this.emit('out', { target, text });
      return this.pump();
    }
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait + 20);
  }

  join(channel) { this.raw('JOIN ' + channel); }

  close() {
    clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.ready = false;
    this.raw('QUIT');
    this.sock?.end();
  }
}
