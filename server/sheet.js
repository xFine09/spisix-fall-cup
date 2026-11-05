// Lee las hojas de cálculo que sube la organización, sin dependencias: Excel (.xlsx), OpenDocument (.ods) y texto (.csv, .tsv, .txt).
// Devuelve [{ name, hidden, rows: [[celda, …], …] }] con las celdas como texto. Si una celda enlaza a osu!
// (en Excel y Google Sheets el enlace va aparte del texto que se ve), el enlace se añade al final de su texto.
import { inflateRawSync } from 'node:zlib';

export class SheetError extends Error {}

const BROKEN = 'No puedo abrir el archivo: parece dañado. Vuelve a descargarlo de la hoja, o copia las filas y pégalas.';
// Límites: un zip muy pequeño puede ocupar gigas al descomprimirse.
const ENTRY_MAX = 64 * 1024 * 1024;
const TOTAL_MAX = 256 * 1024 * 1024;
const MAX_SHEETS = 80, MAX_ROWS = 20_000, MAX_COLS = 300;

const OSU_URL = /(?:https?:\/\/)?osu\.ppy\.sh\/[^\s"'<>)]+/i;

// ---------- zip ----------
function readZip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new SheetError(BROKEN);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new SheetError(BROKEN);
    const nameLen = buf.readUInt16LE(p + 28);
    entries.set(buf.toString('utf8', p + 46, p + 46 + nameLen), {
      method: buf.readUInt16LE(p + 10), size: buf.readUInt32LE(p + 20), offset: buf.readUInt32LE(p + 42)
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  let spent = 0;
  return {
    has: (name) => entries.has(name),
    text(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
      const data = buf.subarray(start, start + e.size);
      if (e.method !== 0 && e.method !== 8) throw new SheetError(BROKEN);
      let out;
      try { out = e.method === 0 ? data : inflateRawSync(data, { maxOutputLength: ENTRY_MAX }); } catch (err) {
        throw new SheetError(err.code === 'ERR_BUFFER_TOO_LARGE' ? 'El archivo es demasiado grande al descomprimirlo. Copia solo la pestaña de las mappools.' : BROKEN);
      }
      spent += out.length;
      if (spent > TOTAL_MAX) throw new SheetError('El archivo es demasiado grande al descomprimirlo. Copia solo la pestaña de las mappools.');
      return out.toString('utf8');
    }
  };
}

// ---------- XML (solo se leen textos y atributos: nunca se cargan entidades ni nada externo) ----------
const decode = (s) => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (_, d, x, n) => {
  if (n) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[n.toLowerCase()];
  const code = d ? +d : parseInt(x, 16);
  return code <= 0x10ffff ? String.fromCodePoint(code) : '';
});
const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(([, k, a, b]) => [k, decode(a ?? b)]));
const finish = (rows) => rows.map((r) => Array.from(r, (c) => c ?? ''));

// ---------- Excel ----------
const textOf = (xml) => decode([...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)].map((m) => m[1] || '').join(''));
const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref.match(/^[A-Za-z]+/)?.[0].toUpperCase() ?? '') n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

function xlsxCell(type, inner, shared) {
  if (type === 'inlineStr') return textOf(inner).trim();
  const v = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
  if (v === undefined || type === 'e' || type === 'b') return '';
  if (type === 's') return (shared[+v] ?? '').trim();
  if (type === 'str') return decode(v).trim();
  const n = Number(v); // 3828141.0 y 3.828141E6 son el mismo ID
  return Number.isFinite(n) ? String(n) : decode(v).trim();
}

function xlsxRows(xml, shared, rels) {
  const links = new Map();
  for (const [, a] of xml.matchAll(/<hyperlink\b([^>]*?)\/?>/g)) {
    const x = attrs(a);
    const url = rels[x['r:id']];
    if (x.ref && url && OSU_URL.test(url)) links.set(x.ref.split(':')[0].toUpperCase(), url);
  }
  const rows = [];
  for (const [, , body] of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (!body) continue;
    if (rows.length >= MAX_ROWS) break;
    const row = [];
    let next = 0;
    for (const [, a, inner = ''] of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const x = attrs(a);
      const col = x.r ? colIndex(x.r) : next;
      next = col + 1;
      if (col >= MAX_COLS) continue;
      const value = xlsxCell(x.t, inner, shared);
      const formula = inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1];
      const link = (x.r && links.get(x.r.toUpperCase())) || (formula && /HYPERLINK/i.test(formula) && decode(formula).match(OSU_URL)?.[0]) || '';
      if (value || link) row[col] = link && !value.includes(link) ? `${value} ${link}`.trim() : value;
    }
    if (row.length) rows.push(row);
  }
  return finish(rows);
}

function readXlsx(zip) {
  const rels = (path) => {
    const i = path.lastIndexOf('/');
    const xml = zip.text(`${path.slice(0, i)}/_rels/${path.slice(i + 1)}.rels`) || '';
    return Object.fromEntries([...xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)].map(([, a]) => { const x = attrs(a); return [x.Id, x.Target]; }));
  };
  const shared = [...(zip.text('xl/sharedStrings.xml') || '').matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((m) => textOf(m[1] || ''));
  const targets = rels('xl/workbook.xml');
  const sheets = [];
  for (const [, a] of zip.text('xl/workbook.xml').matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    if (sheets.length >= MAX_SHEETS) break;
    const x = attrs(a);
    const target = targets[x['r:id']];
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    const xml = zip.text(path);
    if (xml) sheets.push({ name: (x.name || '').trim(), hidden: Boolean(x.state) && x.state !== 'visible', rows: xlsxRows(xml, shared, rels(path)) });
  }
  return sheets;
}

// ---------- OpenDocument ----------
function odsCell(a, inner) {
  const x = attrs(a);
  let value = '';
  if (x['office:value-type'] === 'float' || x['office:value-type'] === 'percentage') {
    const n = Number(x['office:value']);
    if (Number.isFinite(n)) value = String(n);
  }
  if (!value) value = [...inner.matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)].map((m) => decode(m[1].replace(/<[^>]+>/g, ''))).join(' ').trim();
  const link = attrs(inner.match(/<text:a\b([^>]*)>/)?.[1] || '')['xlink:href'] || (/HYPERLINK/i.test(x['table:formula'] || '') && x['table:formula'].match(OSU_URL)?.[0]) || '';
  if (link && OSU_URL.test(link) && !value.includes(link)) value = `${value} ${link}`.trim();
  return { value, repeat: Math.max(1, +x['table:number-columns-repeated'] || 1) };
}

function readOds(zip) {
  const sheets = [];
  for (const [, a, body] of zip.text('content.xml').matchAll(/<table:table(?=[\s>])([^>]*)>([\s\S]*?)<\/table:table>/g)) {
    if (sheets.length >= MAX_SHEETS) break;
    const rows = [];
    for (const [, , rowBody] of body.matchAll(/<table:table-row(?=[\s>/])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)) {
      if (!rowBody) continue;
      if (rows.length >= MAX_ROWS) break;
      const row = [];
      let col = 0;
      for (const [, ca, inner = ''] of rowBody.matchAll(/<table:(?:covered-)?table-cell(?=[\s>/])([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g)) {
        const { value, repeat } = odsCell(ca, inner);
        if (value) for (let i = 0; i < repeat && col + i < MAX_COLS; i++) row[col + i] = value;
        col += repeat;
      }
      if (row.length) rows.push(row);
    }
    sheets.push({ name: (attrs(a)['table:name'] || '').trim(), hidden: false, rows: finish(rows) });
  }
  return sheets;
}

// ---------- entrada ----------
// parseText: la función que convierte texto en filas (la misma que se usa con lo que se pega en la web).
export function readSpreadsheet(buf, parseText) {
  if (!buf.length) throw new SheetError('El archivo está vacío.');
  const head = buf.subarray(0, 8);
  if (head.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) {
    throw new SheetError('Es un Excel antiguo (.xls). Guárdalo como .xlsx, o copia las filas y pégalas.');
  }
  if (head.subarray(0, 4).toString('latin1') === '%PDF' || head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) || head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    throw new SheetError('Eso es un PDF o una imagen. Sube la hoja de cálculo (.xlsx, .ods o .csv), o copia las filas y pégalas.');
  }
  try {
    if (head.subarray(0, 2).toString('latin1') === 'PK') {
      const zip = readZip(buf);
      if (zip.has('xl/workbook.xml')) return readXlsx(zip);
      if (zip.has('content.xml')) return readOds(zip);
      throw new SheetError('Ese archivo comprimido no es una hoja de cálculo. Sube un .xlsx, .ods o .csv.');
    }
  } catch (e) {
    if (e instanceof SheetError) throw e;
    throw new SheetError(BROKEN);
  }
  if (buf.includes(0)) throw new SheetError('Ese archivo no es una hoja de cálculo. Sube un .xlsx, .ods o .csv.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('latin1').decode(buf); } // CSV de Excel en español
  return [{ name: '', hidden: false, rows: parseText(text) }];
}
