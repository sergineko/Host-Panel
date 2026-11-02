/**
 * Cron expressions (5 fields, UTC like Cloudflare Cron Triggers):
 *   minute hour day-of-month month day-of-week
 * Supports *, numbers, ranges (1-5), lists (1,15), steps (*\/5, 10-30/10) and names (mon, jan).
 */
const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
  { min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
] as const;

export interface Cron {
  sets: Set<number>[];
  domStar: boolean;
  dowStar: boolean;
}

function parseValue(v: string, field: (typeof FIELDS)[number]) {
  const names = 'names' in field ? field.names : undefined;
  const idx = names?.indexOf(v.toLowerCase() as never) ?? -1;
  if (idx >= 0) return idx + field.min;
  if (!/^\d+$/.test(v)) throw new Error(`Valor no válido: ${v}`);
  return Number(v);
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Una expresión cron tiene 5 campos: minuto hora día mes día-semana');
  const sets = parts.map((part, i) => {
    const field = FIELDS[i]!;
    const set = new Set<number>();
    for (const item of part.split(',')) {
      const [range, stepText] = item.split('/') as [string, string | undefined];
      const step = stepText === undefined ? 1 : Number(stepText);
      if (!Number.isInteger(step) || step < 1) throw new Error(`Paso no válido: ${item}`);
      let lo: number;
      let hi: number;
      if (range === '*') {
        lo = field.min;
        hi = field.max;
      } else if (range.includes('-')) {
        const [a, b] = range.split('-') as [string, string];
        lo = parseValue(a, field);
        hi = parseValue(b, field);
      } else {
        lo = parseValue(range, field);
        hi = stepText === undefined ? lo : field.max;
      }
      if (lo < field.min || hi > field.max || lo > hi) throw new Error(`Fuera de rango: ${item}`);
      for (let v = lo; v <= hi; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    return set;
  });
  return { sets, domStar: parts[2] === '*', dowStar: parts[4] === '*' };
}

export function cronMatches(cron: Cron, date: Date) {
  const [min, hour, dom, mon, dow] = cron.sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (!min.has(date.getUTCMinutes()) || !hour.has(date.getUTCHours()) || !mon.has(date.getUTCMonth() + 1)) return false;
  // Standard cron: if both day fields are restricted, either one may match.
  const domOk = dom.has(date.getUTCDate());
  const dowOk = dow.has(date.getUTCDay());
  if (cron.domStar || cron.dowStar) return domOk && dowOk;
  return domOk || dowOk;
}

/** Next run times (for the UI preview). */
export function nextRuns(expr: string, count = 3, from = new Date()) {
  const cron = parseCron(expr);
  const out: string[] = [];
  const d = new Date(from);
  d.setUTCSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60 && out.length < count; i++) {
    d.setUTCMinutes(d.getUTCMinutes() + 1);
    if (cronMatches(cron, d)) out.push(d.toISOString());
  }
  return out;
}
