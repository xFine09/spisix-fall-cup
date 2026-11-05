// Configuración del torneo (config.json) y utilidades de fechas en hora de Madrid.
import { readFileSync } from 'node:fs';

export const CONFIG = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

// Diferencia entre la hora local de una zona y UTC en un instante dado.
function tzOffset(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(ms);
  const g = (t) => +parts.find((p) => p.type === t).value;
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ms;
}

// "2026-11-07" o "2026-11-07T18:30" en hora de la zona → milisegundos UTC.
// Con endOfDay, una fecha sin hora se interpreta como las 23:59:59.
export function zoned(str, endOfDay = false, tz = CONFIG.zona) {
  const [d, t] = String(str).split('T');
  const [Y, M, D] = d.split('-').map(Number);
  const [h, mi, s] = t ? t.split(':').map(Number) : endOfDay ? [23, 59, 59] : [0, 0, 0];
  const guess = Date.UTC(Y, M - 1, D, h, mi || 0, s || 0);
  return guess - tzOffset(guess, tz);
}

export function phase(key) {
  const f = CONFIG.fases.find((x) => x.key === key);
  if (!f) return null;
  return { ...f, start: zoned(f.inicio), end: zoned(f.fin, true) };
}

// Cuadro de doble eliminación de 16 jugadores. Mismos ids que usa la web.
export const MATCH_IDS = [
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => 'u1-' + i),
  ...[1, 2, 3, 4].map((i) => 'u2-' + i),
  ...[1, 2, 3, 4].map((i) => 'l1-' + i),
  'u3-1', 'u3-2',
  ...[1, 2, 3, 4].map((i) => 'l2-' + i),
  'l3-1', 'l3-2',
  'u4-1', 'l4-1', 'l4-2', 'l5-1', 'l6-1', 'gf'
];

export function phaseOfMatch(id) {
  if (id.startsWith('u1-')) return 'octavos';
  if (/^(u2|l1)-/.test(id)) return 'cuartos';
  if (/^(u3|l2|l3)-/.test(id)) return 'semis';
  if (/^(u4|l4|l5)-/.test(id)) return 'finals';
  return 'gf';
}

export function bestOf(id) {
  return CONFIG.fases.find((f) => f.key === phaseOfMatch(id))?.bo ?? 9;
}

export const SLOT_ORDER = ['NM', 'HD', 'HR', 'DT', 'FM', 'TB'];
export function slotSort(a, b) {
  const ma = SLOT_ORDER.indexOf(a.slot.slice(0, 2)), mb = SLOT_ORDER.indexOf(b.slot.slice(0, 2));
  return ma - mb || (parseInt(a.slot.slice(2)) || 0) - (parseInt(b.slot.slice(2)) || 0);
}
