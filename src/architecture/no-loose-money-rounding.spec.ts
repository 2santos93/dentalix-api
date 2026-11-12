import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DX-488 (sigue a DX-340 y DX-472): ningún redondeo ni texto de importes fuera
 * de `src/shared/money`. Un importe se redondea con `round2`/`roundToDigits`/
 * `roundCents` y se escribe con `amountText`; nunca con un `Math.round(x * k)` ni
 * un `.toFixed(` en línea. Lo que NO es dinero (porcentajes, dosis, pesos,
 * tasas de cambio, minutos, métricas) va en la lista blanca de abajo, cada
 * entrada con su razón; una entrada que ya no coincide con nada también falla,
 * para que la lista no se pudra.
 *
 * Trabaja con `git ls-files`: ejecútala DESPUÉS de commitear un fichero nuevo.
 */
const API_ROOT = join(__dirname, '..', '..');
const MONEY_DIR = 'src/shared/money/';

/**
 * `.toFixed(` / `["toFixed"]` / `.toPrecision(` (con o sin espacio), un
 * `Math.round(` cuyo argumento multiplica o suma `Number.EPSILON` (DX-488: un
 * épsilon no arregla los empates; los promedios usan `averageAmount`), o un
 * `Math.floor/trunc(` que multiplica por 100 (en varias líneas). Sencilla a propósito: NO cubre alias
 * (`const r = Math.round`, `const { round } = Math`) ni `Intl.NumberFormat`.
 */
const LOOSE =
  /\.toFixed\s*\(|\["toFixed"\]|\.toPrecision\s*\(|Math\.round\s*\([^;]*?(?:\*|Number\.EPSILON)|Math\.(?:floor|trunc)\s*\([^;]*?(?:\*\s*100\b|\b100\s*\*)/g;

export interface Allowed {
  file: string;
  /** Fragmento de la línea marcada (estable aunque cambien los números de línea). */
  text: string;
  /** Si va, la función cuyo cuerpo es (aparece en las 2 líneas anteriores). */
  fn?: string;
  /** Cuántas líneas con ese fragmento hay en el fichero: una más, falla. */
  count?: number;
  reason: string;
}

export const ALLOWED: readonly Allowed[] = [
  // Porcentajes y variaciones
  {
    file: 'src/modules/discounts/domain/discount-policy.ts',
    text: 'Math.round((discount / price) * 10000) / 100',
    reason: '% del descuento sobre el precio, no un importe',
  },
  {
    file: 'src/modules/discounts/application/discount-report-csv.ts',
    text: 'row.percent.toFixed(2)',
    reason: 'columna % del informe de descuentos',
  },
  {
    file: 'src/modules/reports/domain/kpi-definitions.ts',
    text: 'Math.round(value * 10 ** decimals) / 10 ** decimals',
    fn: 'const roundPercent',
    reason:
      'redondeo de tasas y variaciones (%, p.p.); los importes usan round2',
  },
  {
    file: 'src/modules/reports/domain/production-by-procedure.ts',
    text: 'Math.round((value + Number.EPSILON) * 10 ** decimals)',
    fn: 'const roundPercent',
    reason:
      'diferencia % frente al catálogo (1 decimal); los importes usan round2 y averageAmount',
  },
  {
    file: 'src/modules/reports/application/production-by-procedure-csv.ts',
    text: 'value.toFixed(decimals)',
    reason: 'solo la columna de diferencia % (1 decimal)',
  },
  {
    file: 'src/modules/reports/application/recovered-slots-csv.ts',
    text: '(rate * 100).toFixed(1)',
    fn: 'function percent',
    reason: 'tasas de relleno y cancelación (0..1) como % con 1 decimal',
  },
  {
    file: 'src/modules/reports/application/chair-occupancy-csv.ts',
    text: '(rate * 100).toFixed(1)',
    fn: 'function percent',
    reason: 'ocupación y % atendido (0..1) como % con 1 decimal (DX-481)',
  },
  {
    file: 'src/modules/reports/domain/chair-occupancy.ts',
    text: 'Math.round(Math.min(1, minutes / open) * 10_000) / 10_000',
    reason:
      'tasa de ocupación 0..1 con 4 decimales y tope 1 (DX-481), no un importe',
  },
  {
    file: 'src/modules/reports/application/locations-comparison-csv.ts',
    text: 'value.toFixed(decimals)',
    reason:
      'num(): solo conteos, % y variaciones; los importes (unit MONEY) van por csvAmount',
  },
  {
    file: 'src/modules/periodontal/domain/perio-measures.ts',
    text: 'Math.round((part / total) * 1000) / 10',
    reason: '% de sitios con sangrado/placa, no un importe',
  },
  {
    file: 'src/shared/format/whole-percent.ts',
    text: 'Math.round(fraction * 100)',
    reason: 'fracción a porcentaje entero',
  },
  // Tasas de cambio
  {
    file: 'src/modules/exchange/presentation/exchange-settings.controller.ts',
    text: 'rate.toFixed(8)',
    reason: 'tasa de cambio (8 decimales), no un importe',
  },
  {
    file: 'src/modules/payments/application/payment-exchange-rate.ts',
    text: 'rate.toFixed(8)',
    reason: 'tasa de cambio (8 decimales), no un importe',
  },
  // Clínica: dosis, pesos, fármacos, sedación
  {
    file: 'src/modules/anesthesia/application/use-cases/anesthesia.use-cases.ts',
    text: 'Math.round(perCarpule * carpules * 10000) / 10000',
    reason: 'mg de epinefrina',
  },
  {
    file: 'src/modules/anesthesia/domain/anesthesia-dose.ts',
    text: 'const round1 = (n: number) => Math.round(n * 10) / 10',
    reason: 'dosis de anestesia (mg), no un importe',
  },
  {
    file: 'src/modules/anesthesia/domain/anesthesia-dose.ts',
    text: 'const round4 = (n: number) => Math.round(n * 10000) / 10000',
    reason: 'dosis de anestesia (mg), no un importe',
  },
  {
    file: 'src/modules/anesthesia/domain/anesthesia-limits.ts',
    text: 'Math.round(((mlPerCarpule * 1000) / dilution) * 10000) / 10000',
    reason: 'mg por cárpula',
  },
  {
    file: 'src/modules/anesthesia/domain/anesthesia-window.ts',
    text: 'const round1 = (n: number) => Math.round(n * 10) / 10',
    reason: 'horas de la ventana de anestesia',
  },
  {
    file: 'src/modules/prescriptions/domain/patient-snapshot.ts',
    text: 'Number(kg.toFixed(1))',
    reason: 'peso del paciente en kg',
  },
  {
    file: 'src/modules/prescriptions/domain/prescription-safety.ts',
    text: 'const round = (n: number) => Math.round(n * 10) / 10',
    reason: 'dosis máxima de un fármaco',
  },
  {
    file: 'src/modules/sedation/domain/sedation-rules.ts',
    text: 'Math.round(value * 10 ** decimals) / 10 ** decimals',
    fn: 'const roundDose',
    reason: 'dosis e IMC de sedación (función roundDose)',
  },
  {
    file: 'src/modules/patient-imports/application/patient-imports.use-cases.ts',
    text: 'Math.floor((processed / toProcess) * 100)',
    reason: '% de progreso de una importación',
  },
  {
    file: 'prisma/demo/data.ts',
    text: 'const r4 = (x: number) => Math.round(x * 1e4) / 1e4',
    reason: 'tasa de cambio demo (4 decimales), no un importe',
  },
  {
    file: 'prisma/demo/data.ts',
    text: 'Math.round((usd * 3) / 10) * 10',
    reason: 'precio demo redondeado a decenas (cifra «bonita» de la demo)',
  },
  {
    file: 'prisma/demo/data.ts',
    text: 'Math.round((usd * 0.8) / 5) * 5',
    reason: 'precio demo redondeado a cincos (cifra «bonita» de la demo)',
  },
  // Tiempo y otros
  {
    file: 'src/modules/waitlist/domain/waitlist-rules.ts',
    text: 'Math.round((end.getTime() - start.getTime()) / 300_000) * 5',
    reason: 'minutos de una cita',
  },
  {
    file: 'src/modules/patient-imports/domain/xlsx-reader.ts',
    text: 'n.toFixed(0)',
    reason: 'texto de una celda numérica ENTERA de la hoja (sin redondeo)',
  },
];

const isScanned = (file: string): boolean =>
  (file.startsWith('src/') ||
    file.startsWith('prisma/demo/') ||
    file === 'prisma/seed-demo.ts') &&
  file.endsWith('.ts') &&
  !file.endsWith('.spec.ts') &&
  !file.includes('/__fixtures__/') &&
  !file.startsWith(MONEY_DIR);

const isComment = (line: string): boolean => /^\s*(\*|\/\/|\/\*)/.test(line);

/** Las líneas con un redondeo o `toFixed` en línea (no comentarios). */
export function looseRoundings(
  source: string,
): { line: number; text: string; context: string }[] {
  const lines = source.split('\n');
  return [...source.matchAll(LOOSE)].flatMap((m) => {
    const line = source.slice(0, m.index).split('\n').length;
    const text = lines[line - 1];
    const context = lines.slice(Math.max(0, line - 3), line).join('\n');
    return isComment(text) ? [] : [{ line, text: text.trim(), context }];
  });
}

const tracked = (): string[] =>
  execFileSync('git', ['ls-files', 'src', 'prisma'], {
    cwd: API_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts'));

const matches = (
  a: Allowed,
  { text, context }: { text: string; context: string },
): boolean =>
  text.includes(a.text) && (a.fn === undefined || context.includes(a.fn));

describe('sin redondeos sueltos de importes (DX-488)', () => {
  const all = tracked();
  const files = all.filter(isScanned);
  const read = (file: string): string =>
    readFileSync(join(API_ROOT, file), 'utf8');

  it('la guarda mira los ficheros de producción', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('src/modules/payments/domain/idempotency.ts');
    expect(files).toContain('prisma/demo/data.ts');
    expect(files).not.toContain('src/shared/money/money.ts');
  });

  it('ningún Math.round(x * k) ni toFixed de importes fuera de src/shared/money', () => {
    const offenders = files.flatMap((file) =>
      looseRoundings(read(file))
        .filter(
          (hit) => !ALLOWED.some((a) => a.file === file && matches(a, hit)),
        )
        .map(({ line, text }) => `${file}:${line}  ${text}`),
    );
    expect(offenders).toEqual([]);
  });

  it('cada entrada de la lista blanca coincide con EXACTAMENTE `count` líneas y tiene razón', () => {
    const wrong = ALLOWED.flatMap((a) => {
      const found = files.includes(a.file)
        ? looseRoundings(read(a.file)).filter((hit) => matches(a, hit)).length
        : 0;
      const expected = a.count ?? 1;
      return a.reason.trim() && found === expected
        ? []
        : [`${a.file} «${a.text}»: ${found} de ${expected}`];
    });
    expect(wrong).toEqual([]);
  });

  it('round2WithEpsilon ya no existe (DX-488): ningún fichero lo usa', () => {
    const users = all.filter(
      (f) => !f.endsWith('.spec.ts') && read(f).includes('round2WithEpsilon'),
    );
    expect(users).toEqual([]);
  });

  it('autoprueba: detecta las formas de un redondeo a mano', () => {
    const n = (s: string) => looseRoundings(s).length;
    expect(n('const c = Math.round(x * 100);')).toBe(1);
    expect(n('Math.round(a.amount*100) / 100')).toBe(1);
    expect(n('Math.round(\n  (a + b) *\n    100,\n)')).toBe(1);
    expect(n('Math.round(value * factor) / factor')).toBe(1);
    expect(n('return amount.toFixed(2);')).toBe(1);
    expect(n('return amount.toFixed (2);')).toBe(1);
    expect(n('amount["toFixed"](2)')).toBe(1);
    expect(n('Number(x.toPrecision(4))')).toBe(1);
    expect(n('Math.floor(x * 100 + 0.5)')).toBe(1);
    expect(n('Math.trunc(x * 100)')).toBe(1);
    expect(n('Number(rate.toFixed(8))')).toBe(1);
    expect(n('Math.round(x + Number.EPSILON)')).toBe(1);
    // No son importes ni multiplican:
    expect(n('Math.round(ms / 1000)')).toBe(0);
    expect(n('Math.floor(page)')).toBe(0);
    expect(n('Math.round(t.cents)')).toBe(0);
    expect(n(' * `Math.round(kg * 10)` daría 72,6')).toBe(0);
    expect(n('// Math.round(x * 100)')).toBe(0);
    expect(n('amountText(x, 2)')).toBe(0);
  });
});
