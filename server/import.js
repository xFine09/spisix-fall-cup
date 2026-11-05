// Lee las respuestas del formulario de Google pegadas desde la hoja de cálculo (tabuladores) o un CSV.
import { CONFIG, zoned } from './config.js';

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// Tabuladores si los hay (copiado de Sheets); si no, punto y coma o comas, lo que aparezca en más líneas (CSV de Excel en español usa ;).
function guessSeparator(t) {
  if (t.includes('\t')) return '\t';
  const lines = t.split('\n').slice(0, 200);
  return lines.filter((l) => l.includes(';')).length > lines.filter((l) => l.includes(',')).length ? ';' : ',';
}

// Filas y celdas de un texto separado por tabuladores (copiado de Sheets), punto y coma o comas (CSV). Una celda que empieza
// por comillas puede contener separadores, saltos de línea y "" (comillas escapadas).
export function parseTable(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n');
  const sep = guessSeparator(t);
  const rows = [];
  let row = [], cell = '', quoted = false, start = true;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && start) { quoted = true; start = false; }
    else if (c === sep) { row.push(cell); cell = ''; start = true; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; start = true; }
    else { cell += c; start = false; }
  }
  row.push(cell);
  rows.push(row);
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some(Boolean));
}

// "2/11/2026 18:30:05" (formato de Sheets en español) o ISO → ms, en hora de Madrid. null si no se entiende.
function parseTime(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, d, mo, y, h, mi, se] = m;
    return zoned(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${mi}:${se || '00'}`);
  }
  m = t.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/);
  return m ? zoned(`${m[1]}T${m[2]}`) : null;
}

// Devuelve [{ name, id, availability, time }] sin repetidos (si alguien envió el formulario
// dos veces, vale la última respuesta). id solo se rellena si en el nombre pegaron el enlace del perfil.
export function parseResponses(text) {
  const table = parseTable(text);
  if (!table.length) return [];
  const head = table[0].map(norm);
  const find = (re) => head.findIndex((h) => re.test(h));
  // El formulario puede tener una columna de Discord («discord username»): no se guarda ni se toma por el nombre de osu!.
  const skip = find(/discord/);
  let col = { availability: find(/disponib|horari/), time: find(/marca temporal|timestamp|fecha/) };
  col.name = head.findIndex((h, i) => i !== skip && /osu|nombre|name|nick|usuario/.test(h));
  let rows = table.slice(1);
  if (col.name < 0) {
    // Sin fila de títulos: el orden del formulario, con o sin marca temporal delante.
    // Tras el nombre puede haber otra columna (la del formulario actual) antes de la disponibilidad.
    rows = table;
    const first = parseTime(table[0][0]) ? 1 : 0;
    const last = Math.min(first + 2, table[0].length - 1);
    col = { time: first - 1, name: first, availability: last > first ? last : -1 };
  }
  const byKey = new Map();
  for (const c of rows) {
    const raw = (c[col.name] || '').replace(/^@/, '');
    if (!raw) continue;
    const link = raw.match(/osu\.ppy\.sh\/(?:users|u)\/(\d+)/);
    const entry = {
      name: link ? null : raw,
      id: link ? +link[1] : null,
      availability: col.availability >= 0 ? (c[col.availability] || '').replace(/\s+/g, ' ').slice(0, 200) : '',
      time: col.time >= 0 ? parseTime(c[col.time]) : null
    };
    const key = entry.id ? 'id:' + entry.id : 'n:' + norm(raw).replace(/ /g, '_');
    const prev = byKey.get(key);
    if (prev?.time && !(entry.time < prev.time)) entry.time = prev.time; // fecha de la primera respuesta
    byKey.delete(key);
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

// ---------- Mappools desde una hoja ----------
// Cada hoja es de su padre, así que aquí no se da nada por supuesto:
//   · el slot puede venir como NM1, nm 01, NoMod 1, en dos columnas (NM | 1) o solo el mod (se numeran por orden);
//   · una misma pestaña puede tener varias rondas: con columna de ronda (stage), con títulos o una al lado de la otra;
//   · el mapa puede ser un ID, un enlace o un texto con enlace, y puede haber varias columnas de números.
// readPools no guarda nada ni llama a osu!: devuelve lo que ha entendido para que la organización lo revise.
const MOD_WORDS = new Map(Object.entries({
  nm: 'NM', nomod: 'NM', hd: 'HD', hidden: 'HD', hr: 'HR', hardrock: 'HR', dt: 'DT', doubletime: 'DT',
  fm: 'FM', freemod: 'FM', tb: 'TB', tiebreak: 'TB', tiebreaker: 'TB'
}));
const HEAD = {
  id: /^(map ?id|mapa ?id|beatmap ?id|bid|diff(iculty)? ?id|id|id (del )?mapa)$/,
  stage: /^(stage|ronda|round|fase|phase|week|semana|pool|mappool)$/,
  mods: /^mods?$/,
  map: /^(pick|slot|mods?|mod ?#|map|mapa|map ?url|map ?link|url|link|enlace|beatmap)$/
};
const ROUND_NAMES = [
  ['gf', /grand ?final|gran final|\bgf\b/],
  ['semis', /semi|\bsf\b|\bro ?4\b/],
  ['cuartos', /cuartos|quarter|\bqf\b|\bro ?8\b/],
  ['octavos', /octavos|\bro ?16\b|\br16\b|(round|ronda) (of|de) 16/],
  ['finals', /\bfinals?\b|\bf\b|\bro ?2\b/],
  ['qualifiers', /^(q|ql|quals?)$|qualif|clasif/]
];
export function suggestRound(name) {
  const n = norm(name || '');
  if (!n) return null;
  const hit = ROUND_NAMES.find(([key, re]) => re.test(n) && CONFIG.fases.some((f) => f.key === key));
  return hit ? hit[0] : null;
}

// «NM1», «nm 01», «NoMod-1», «Hard Rock 2», «TB» → { mod, n }. «NM» a secas → { mod, n: null }.
function slotOf(cell) {
  const m = norm(cell).replace(/[\s_.:#-]+/g, '').match(/^([a-z]+?)0*(\d{1,2})?$/);
  const mod = m && MOD_WORDS.get(m[1]);
  return mod ? { mod, n: m[2] ? +m[2] : null } : null;
}
const slotName = (s) => (s.mod === 'TB' ? 'TB' : s.mod + s.n);
const smallNumber = (v) => {
  if (!/^\d{1,2}(\.0+)?$/.test(v || '')) return null;
  const n = Math.trunc(+v);
  return n >= 1 && n <= 30 ? n : null;
};

// El slot de una fila: primero uno completo (NM1 o NM | 1); si no, el primer mod suelto.
function rowSlot(row) {
  let modOnly = null;
  for (let i = 0; i < row.length; i++) {
    const s = row[i] ? slotOf(row[i]) : null;
    if (!s) continue;
    if (s.mod === 'TB') return { mod: 'TB', n: 1, at: i, end: smallNumber(row[i + 1]) ? i + 2 : i + 1 };
    if (s.n) return { ...s, at: i, end: i + 1 };
    const n = smallNumber(row[i + 1]);
    if (n) return { mod: s.mod, n, at: i, end: i + 2 };
    modOnly ??= { mod: s.mod, n: null, at: i, end: i + 1 };
  }
  return modOnly;
}

const linkId = (v) => {
  const m = String(v).match(/osu\.ppy\.sh\/(?:b|beatmaps)\/(\d+)|#(?:osu|taiko|fruits|mania)\/(\d+)|[?&]b=(\d+)/);
  return m ? +(m[1] || m[2] || m[3]) : null;
};
const isSetLink = (v) => /osu\.ppy\.sh\/(?:beatmapsets|s)\/\d+/.test(v);
// 3493106, 3493106.0, 3,493,106 o 3.493.106
function numberIn(v) {
  const t = String(v ?? '').trim();
  let n = null;
  if (/^\d{1,10}(\.0+)?$/.test(t)) n = Math.trunc(+t);
  else if (/^\d{1,3}([.,\s]\d{3})+$/.test(t)) n = +t.replace(/\D/g, '');
  return n > 0 && n < 1e9 ? n : null;
}

// Sin título de columna: la columna con más números grandes (un ID es mayor que el BPM o el combo). Si empatan, la de números más altos.
function guessIdColumn(rows, info) {
  const vals = new Map();
  rows.forEach((row, i) => {
    const s = info[i];
    if (!s) return;
    row.forEach((c, j) => {
      if (j >= s.at && j < s.end) return;
      const n = numberIn(c);
      if (n >= 1000) vals.set(j, [...(vals.get(j) || []), n]);
    });
  });
  let best = -1, count = 0, median = 0;
  for (const [j, v] of vals) {
    const med = v.sort((a, b) => a - b)[v.length >> 1];
    if (v.length > count || (v.length === count && med > median)) { best = j; count = v.length; median = med; }
  }
  return count * 2 >= info.filter(Boolean).length ? best : -1;
}

// Sin título «stage»: una columna de texto a la izquierda del slot que se repite (QL, QL, QL, Semana 1, Semana 1…).
function guessStageColumn(rows, info) {
  const slotRows = rows.filter((_, i) => info[i]);
  if (slotRows.length < 3) return -1;
  const first = info.find(Boolean);
  for (let c = first.at - 1; c >= 0; c--) {
    const vals = slotRows.map((r) => r[c] || '').filter(Boolean);
    if (!slotRows[0][c] || vals.some((v) => numberIn(v) !== null || slotOf(v) || /osu\.ppy\.sh|^\W*$/.test(v))) continue;
    if (new Set(vals).size <= Math.max(1, slotRows.length / 3)) return c;
  }
  return -1;
}

const TITLE_REACH = 3; // título, una nota y la fila de cabecera: más lejos ya no es el título de esa pool
const cleanName = (v) => String(v).replace(/\s*https?:\S+/g, '').replace(/\s+/g, ' ').trim();
// El nombre de un título: el que parezca una ronda; si no, el más cercano a la columna del slot.
function titleName(row, slotCol) {
  const cells = row.map((c, i) => ({ c: cleanName(c), i })).filter((x) => x.c && x.c.length <= 60 && /\p{L}/u.test(x.c));
  const named = cells.find((x) => suggestRound(x.c));
  if (named) return named.c;
  return [...cells].reverse().find((x) => x.i <= slotCol)?.c || cells[0]?.c || null;
}

// El título de la canción de una fila, para comprobar luego que el ID es el suyo.
function rowTitle(row, s) {
  for (let i = 0; i < row.length; i++) {
    if (i >= s.at && i < s.end) continue;
    const c = cleanName(row[i]);
    if (/ - |\[.+\]/.test(c)) return c.slice(0, 200);
  }
  return '';
}

function rowMap(row, s, idCol, guess) {
  const inSlot = (i) => i >= s.at && i < s.end;
  const numbers = row.map((c, i) => (inSlot(i) ? null : numberIn(c)));
  const links = row.map((c, i) => (inSlot(i) ? null : linkId(c)));
  let id = null;
  if (idCol >= 0 && !inSlot(idCol)) id = numbers[idCol] ?? links[idCol];
  id ??= links.find(Boolean) ?? null;
  if (id === null && idCol < 0) {
    if (guess >= 0 && !inSlot(guess)) id = numbers[guess];
    else id = Math.max(0, ...numbers.filter((n) => n >= 1000)) || null;
  }
  // Una fila corta como «NM1 | 305»: el único número que hay, aunque sea pequeño (los mapas muy antiguos).
  if (id === null && idCol < 0 && guess < 0 && row.filter((c, i) => c && !inSlot(i)).length <= 2) {
    const only = numbers.filter(Boolean);
    if (only.length === 1) id = only[0];
  }
  const link = links.find(Boolean);
  return { id, conflict: link && id && link !== id ? link : null, set: row.some((c, i) => !inSlot(i) && isSetLink(c)) };
}

function readTable(rows, sheet) {
  const info = rows.map(rowSlot);
  const heads = rows.map((row, i) => {
    if (info[i]?.n || row.filter(Boolean).length < 2) return null;
    const cells = row.map(norm);
    const id = cells.findIndex((c) => HEAD.id.test(c)), stage = cells.findIndex((c) => HEAD.stage.test(c)), mods = cells.findIndex((c) => HEAD.mods.test(c));
    // «Stage» o «Mappool» a secas pueden ser un título: como cabecera vienen junto a la columna del slot o del mapa.
    return id >= 0 || (stage >= 0 && cells.some((c) => HEAD.map.test(c))) ? { id, stage, mods } : null;
  });
  rows.forEach((_, i) => { if (heads[i]) info[i] = null; });
  const guess = guessIdColumn(rows, info);
  const hasStageHead = heads.some((h) => h && h.stage >= 0);
  const stageGuess = hasStageHead ? -1 : guessStageColumn(rows, info);
  const slotCol = info.find(Boolean)?.at ?? 0;

  const groups = [], loose = [];
  const newGroup = (name) => {
    const g = { name, sheet, maps: [], bySlot: new Map(), auto: {}, missing: new Map(), warnings: [] };
    groups.push(g);
    return g;
  };
  let group = null, pending = null, pendingAt = -9, idCol = -1, stageCol = stageGuess, modsCol = -1, stage = '', stageOf = new Map();
  let joined = null, section = null; // columna de mods combinada (NM | 1, «» | 2…) y secciones (una fila «Hidden» y debajo sus mapas)

  rows.forEach((row, i) => {
    const h = heads[i];
    if (h) {
      idCol = h.id;
      stageCol = h.stage >= 0 ? h.stage : stageGuess;
      modsCol = h.mods;
      return;
    }
    let s = info[i];
    const probe = s || { at: -1, end: -1 };
    const found = rowMap(row, probe, idCol, guess);
    if (!s && joined && !row[joined.at] && smallNumber(row[joined.at + 1])) {
      s = { mod: joined.mod, n: smallNumber(row[joined.at + 1]), at: joined.at, end: joined.at + 2 };
    }
    if (!s && section && found.id) s = { mod: section, n: null, at: -1, end: -1 };
    if (s && s.n === null && s.mod !== 'TB' && !found.id && !found.set && s.at >= 0) { section = s.mod; return; }
    if (!s) {
      const hasMap = (idCol >= 0 && numberIn(row[idCol])) || (idCol < 0 && guess >= 0 && numberIn(row[guess])) || row.some((c) => linkId(c) || isSetLink(c));
      if (hasMap) loose.push((row.map(cleanName).find((c) => c && numberIn(c) === null) || row.find(Boolean)).slice(0, 40));
      else if (row.some((c) => /\p{L}/u.test(cleanName(c)))) {
        const keep = pending && i - pendingAt <= TITLE_REACH && suggestRound(titleName(pending, slotCol)) && !suggestRound(titleName(row, slotCol));
        if (!keep) { pending = row; pendingAt = i; }
        section = null;
      }
      return;
    }
    if (s.end - s.at === 2) joined = s;
    else if (s.at >= 0) joined = null;
    const { id, conflict, set } = s.at === -1 ? found : rowMap(row, s, idCol, guess);

    if (stageCol >= 0 && row[stageCol]) stage = cleanName(row[stageCol]) || stage;
    // ¿Empieza otra pool? Con columna de ronda, cuando cambia; si no, con un título de ronda o si se repite un slot con otro mapa.
    const nameOfPending = pending && i - pendingAt <= TITLE_REACH ? titleName(pending, slotCol) : null;
    if (stageCol >= 0 && stage) {
      group = stageOf.get(stage) || newGroup(stage);
      stageOf.set(stage, group);
    } else if (!group || (nameOfPending && suggestRound(nameOfPending) && group.maps.length)) {
      group = newGroup(nameOfPending);
    }
    const name = s.mod === 'TB' ? 'TB' : s.n ? slotName(s) : null;
    const prev = name ? group.bySlot.get(name) : null;
    if (prev && id && prev !== id) {
      group = newGroup(stageCol >= 0 ? stage : nameOfPending);
      if (stageCol >= 0) stageOf.set(stage, group);
    }
    pending = null;
    section = s.at >= 0 ? null : section;
    const n = s.n ?? (group.auto[s.mod] = (group.auto[s.mod] || 0) + 1);
    const slot = slotName({ mod: s.mod, n });
    if (id) {
      if (group.bySlot.get(slot) === id) return;
      group.bySlot.set(slot, id);
      group.missing.delete(slot);
      group.maps.push({ slot, beatmap: id, text: rowTitle(row, s) });
      if (conflict) group.warnings.push(`${slot}: el ID (${id}) y el enlace (${conflict}) no coinciden. Uso el ID: compruébalo.`);
      const mark = norm(row[modsCol >= 0 ? modsCol : s.end] || '');
      const said = mark ? slotOf(mark) : null;
      if (said && said.n === null && s.mod !== 'TB' && said.mod !== 'TB' && said.mod !== s.mod) {
        group.warnings.push(`${slot}: la fila también dice ${said.mod}. Comprueba el mod.`);
      }
    } else if (!group.bySlot.has(slot)) {
      group.missing.set(slot, set ? `${slot}: el enlace es del set, no de la dificultad (debe acabar en #osu/número).` : `${slot}: no encuentro el ID ni el enlace del mapa.`);
    }
  });
  return { groups, loose };
}

// Pools una al lado de otra en las mismas filas: cada una se lee por separado.
function splitSideBySide(rows) {
  const starts = rows.map((row) => {
    const out = [];
    for (let i = 0; i < row.length; i++) {
      const s = row[i] ? slotOf(row[i]) : null;
      if (!s) continue;
      if (s.mod === 'TB' || s.n) out.push(i);
      else if (smallNumber(row[i + 1])) { out.push(i); i++; }
    }
    return out;
  });
  const counts = new Map();
  for (const st of starts) if (st.length >= 2) for (const c of st) counts.set(c, (counts.get(c) || 0) + 1);
  const cols = [...counts].filter(([, n]) => n >= 3).map(([c]) => c).sort((a, b) => a - b);
  if (cols.length < 2) return [rows];
  // Cada una empieza en su slot o una columna antes (ronda o título), salvo que esa columna sea el ID de la pool anterior.
  const from = cols.map((c, k) => (k && c - 1 > cols[k - 1] + 1 && rows.every((r) => numberIn(r[c - 1]) === null) ? c - 1 : k ? c : 0));
  return from.map((f, k) => rows.map((r) => r.slice(f, from[k + 1])));
}

const groupKey = (g) => g.maps.map((m) => `${m.slot}:${m.beatmap}`).sort().join();

// sheets: [{ name, hidden, rows }]. Devuelve { groups: [{ name, sheet, suggest, maps, errors, warnings }], notes, empty }.
export function readPools(sheets) {
  const readAll = (list) => {
    const groups = [], loose = [];
    for (const sheet of list) {
      for (const seg of splitSideBySide(sheet.rows)) {
        const r = readTable(seg, sheet.name);
        groups.push(...r.groups);
        if (r.groups.some((g) => g.maps.length)) loose.push(...r.loose.map((t) => (sheet.name ? `${sheet.name}: ${t}` : t)));
      }
    }
    return { groups, loose };
  };
  let { groups, loose } = readAll(sheets.filter((s) => !s.hidden));
  const notes = [];
  if (!groups.some((g) => g.maps.length) && sheets.some((s) => s.hidden)) {
    ({ groups, loose } = readAll(sheets));
    if (groups.some((g) => g.maps.length)) notes.push('Solo había mapas en pestañas ocultas.');
  }
  const empty = groups.filter((g) => !g.maps.length).flatMap((g) => [...g.missing.values()]);
  let usable = groups.filter((g) => g.maps.length);
  // Una pool tiene varios mapas: lo demás suele ser ruido (por ejemplo, «HR» en una lista de países). Si no hay otra cosa, se enseña.
  if (usable.some((g) => g.maps.length >= 3)) usable = usable.filter((g) => g.maps.length >= 3);
  // La misma pool en dos pestañas (la hoja de un equipo la copia de la principal): se enseña una vez.
  const seen = new Map(), unique = [];
  for (const g of usable) {
    const key = groupKey(g), twin = seen.get(key);
    if (twin) { twin.names.push(g.name, g.sheet); continue; }
    g.names = [g.name, g.sheet];
    seen.set(key, g);
    unique.push(g);
  }
  const used = new Set(), counts = new Map();
  const out = unique.map((g) => {
    const named = g.names.find((n) => suggestRound(n));
    const base = named || g.name || g.sheet || 'Mappool';
    const times = (counts.get(base) || 0) + 1;
    counts.set(base, times);
    const suggest = g.names.map(suggestRound).find((k) => k && !used.has(k)) || null;
    if (suggest) used.add(suggest);
    const slots = new Map();
    for (const m of g.maps) slots.set(m.beatmap, [...(slots.get(m.beatmap) || []), m.slot]);
    const warnings = [...g.warnings];
    for (const [bid, list] of slots) if (list.length > 1) warnings.push(`${list.join(' y ')} usan el mismo mapa (${bid}).`);
    if (g.maps.length > 40) warnings.push('Tiene más de 40 mapas: la web admite 40 por ronda.');
    return { name: times > 1 ? `${base} (${times})` : base, sheet: g.sheet, suggest, maps: g.maps.slice(0, 40), errors: [...g.missing.values()], warnings };
  });
  if (loose.length) notes.push(`Filas con mapa pero sin un slot que entienda (no se importan): ${[...new Set(loose)].slice(0, 6).join(' · ')}.`);
  return { groups: out, notes, empty };
}

// Texto pegado. Sin tabuladores (por ejemplo, copiado de un chat: «NM   1  NM  3493106»), la fila se parte por espacios.
export function parsePoolText(text) {
  return parseTable(text).map((row) => {
    if (row.some((c) => c && slotOf(c))) return row;
    const parts = row.join(' ').trim().split(/\s+/);
    return parts.some((p) => slotOf(p)) ? parts : row;
  });
}

// ¿El título que dice la hoja es el del mapa de osu!? Si la hoja no da título, no se puede saber: se da por bueno.
const titleKey = (s) => norm(s).replace(/[^\p{L}\p{N}]/gu, '');
export function sameMap(text, data) {
  if (!text) return true;
  const t = titleKey(text);
  const title = [data.title, data.title_unicode].some((x) => x && t.includes(titleKey(x)));
  if (!title || !data.version) return title;
  // La dificultad puede venir acortada en la hoja: «[Kvartz]» por «[Kvartz (6WC ver.)]».
  const version = titleKey(data.version), shown = titleKey(text.slice(text.indexOf('[') + 1, text.lastIndexOf(']')));
  return t.includes(version) || (shown !== '' && version.includes(shown));
}
