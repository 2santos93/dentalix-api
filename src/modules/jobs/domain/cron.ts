/**
 * Expresiones cron de 5 campos (minuto, hora, día del mes, mes, día de la
 * semana), siempre en UTC. Sin dependencias: `*`, `a`, `a-b`, `* /n` y
 * `a-b/n`, y listas con comas. El día de la semana admite 0 y 7 como domingo.
 * Como en cron clásico, si día del mes y día de la semana están acotados los
 * dos, basta con que case uno.
 */
export interface CronSchedule {
  readonly expression: string;
  /** El primer instante (minuto entero) estrictamente posterior a `after`. */
  next(after: Date): Date;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
}

const FIELDS: FieldSpec[] = [
  { name: 'minuto', min: 0, max: 59 },
  { name: 'hora', min: 0, max: 23 },
  { name: 'día del mes', min: 1, max: 31 },
  { name: 'mes', min: 1, max: 12 },
  { name: 'día de la semana', min: 0, max: 7 },
];

/** Horizonte de búsqueda: cubre el 29 de febrero (cada 4 años) con margen. */
const SEARCH_YEARS = 8;

function invalid(expression: string, reason: string): Error {
  return new Error(`Expresión cron inválida "${expression}": ${reason}`);
}

function parseNumber(raw: string, spec: FieldSpec, expr: string): number {
  if (!/^\d{1,2}$/.test(raw)) {
    throw invalid(expr, `${spec.name} "${raw}" no es un número`);
  }
  const value = Number(raw);
  if (value < spec.min || value > spec.max) {
    throw invalid(
      expr,
      `${spec.name} ${value} fuera de ${spec.min}-${spec.max}`,
    );
  }
  return value;
}

function parseField(
  raw: string,
  spec: FieldSpec,
  expr: string,
): { values: Set<number>; wildcard: boolean } {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    if (part === '') {
      throw invalid(expr, `lista vacía en ${spec.name}`);
    }
    const [range, stepRaw, extra] = part.split('/');
    if (extra !== undefined) {
      throw invalid(expr, `paso mal formado en ${spec.name}`);
    }
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d{1,2}$/.test(stepRaw) || Number(stepRaw) === 0) {
        throw invalid(expr, `paso "${stepRaw}" inválido en ${spec.name}`);
      }
      step = Number(stepRaw);
    }
    let from: number;
    let to: number;
    if (range === '*') {
      from = spec.min;
      to = spec.max;
    } else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined) {
        throw invalid(expr, `rango mal formado en ${spec.name}`);
      }
      from = parseNumber(a, spec, expr);
      to = parseNumber(b, spec, expr);
      if (from > to) {
        throw invalid(expr, `rango ${range} al revés en ${spec.name}`);
      }
    } else {
      from = parseNumber(range, spec, expr);
      to = stepRaw === undefined ? from : spec.max;
    }
    for (let v = from; v <= to; v += step) {
      values.add(v);
    }
  }
  return { values, wildcard: raw === '*' };
}

class ParsedCron implements CronSchedule {
  constructor(
    readonly expression: string,
    private readonly minutes: Set<number>,
    private readonly hours: Set<number>,
    private readonly daysOfMonth: Set<number>,
    private readonly months: Set<number>,
    private readonly daysOfWeek: Set<number>,
    private readonly domRestricted: boolean,
    private readonly dowRestricted: boolean,
  ) {}

  private dayMatches(d: Date): boolean {
    const dom = this.daysOfMonth.has(d.getUTCDate());
    const dow = this.daysOfWeek.has(d.getUTCDay());
    if (this.domRestricted && this.dowRestricted) return dom || dow;
    if (this.domRestricted) return dom;
    if (this.dowRestricted) return dow;
    return true;
  }

  next(after: Date): Date {
    const d = new Date(after.getTime());
    d.setUTCSeconds(0, 0);
    d.setUTCMinutes(d.getUTCMinutes() + 1);
    const limit = after.getTime() + SEARCH_YEARS * 366 * 24 * 3600 * 1000;
    while (d.getTime() <= limit) {
      if (!this.months.has(d.getUTCMonth() + 1)) {
        d.setUTCMonth(d.getUTCMonth() + 1, 1);
        d.setUTCHours(0, 0, 0, 0);
        continue;
      }
      if (!this.dayMatches(d)) {
        d.setUTCDate(d.getUTCDate() + 1);
        d.setUTCHours(0, 0, 0, 0);
        continue;
      }
      if (!this.hours.has(d.getUTCHours())) {
        d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
        continue;
      }
      if (!this.minutes.has(d.getUTCMinutes())) {
        d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
        continue;
      }
      return d;
    }
    throw invalid(this.expression, 'nunca se cumple');
  }
}

export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === '') {
    throw invalid(expression, 'hacen falta 5 campos');
  }
  const [min, hour, dom, month, dow] = parts.map((raw, i) =>
    parseField(raw, FIELDS[i], expression),
  );
  // 7 también es domingo.
  const daysOfWeek = new Set([...dow.values].map((d) => d % 7));
  const cron = new ParsedCron(
    expression,
    min.values,
    hour.values,
    dom.values,
    month.values,
    daysOfWeek,
    !dom.wildcard,
    !dow.wildcard,
  );
  // Falla al registrar, no en el primer tick: «30 de febrero» nunca llega.
  cron.next(new Date(Date.UTC(2000, 0, 1)));
  return cron;
}
