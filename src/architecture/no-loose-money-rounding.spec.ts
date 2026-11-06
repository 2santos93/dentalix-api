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

/** `.toFixed(` o un `Math.round(` cuyo argumento multiplica (en varias líneas). */
const LOOSE = /\.toFixed\(|Math\.round\([^;]*?\*/g;

export interface Allowed {
  file: string;
  /** Fragmento de la línea marcada (estable aunque cambien los números de línea). */
  text: string;
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
    text: 'Math.round(value * factor) / factor',
    reason:
      'redondeo de tasas y variaciones (%, p.p.); los importes usan round2',
  },
  {
    file: 'src/modules/reports/domain/production-by-procedure.ts',
    text: 'Math.round((value + Number.EPSILON) * factor) / factor',
    reason:
      'diferencia % frente al catálogo (1 decimal); los importes usan round2WithEpsilon',
  },
  {
    file: 'src/modules/reports/application/production-by-procedure-csv.ts',
    text: 'value.toFixed(decimals)',
    reason: 'solo la columna de diferencia % (1 decimal)',
  },
  {
    file: 'src/modules/reports/application/locations-comparison-csv.ts',
    text: 'value.toFixed(decimals)',
    reason:
      'valores de KPI de varias unidades (conteo, %, p.p.); los importes ya vienen redondeados a 2 decimales por computeKpis',
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
    text: 'Math.round(value * f) / f',
    reason: 'constantes clínicas de sedación',
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
  file.startsWith('src/') &&
  file.endsWith('.ts') &&
  !file.endsWith('.spec.ts') &&
  !file.includes('/__fixtures__/') &&
  !file.startsWith(MONEY_DIR);

const isComment = (line: string): boolean => /^\s*(\*|\/\/|\/\*)/.test(line);

/** Las líneas con un redondeo o `toFixed` en línea (no comentarios). */
export function looseRoundings(
  source: string,
): { line: number; text: string }[] {
  const lines = source.split('\n');
  return [...source.matchAll(LOOSE)].flatMap((m) => {
    const line = source.slice(0, m.index).split('\n').length;
    const text = lines[line - 1];
    return isComment(text) ? [] : [{ line, text: text.trim() }];
  });
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', 'src'], {
    cwd: API_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(isScanned);
}

describe('sin redondeos sueltos de importes (DX-488)', () => {
  const files = trackedFiles();

  it('la guarda mira los ficheros de producción', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('src/modules/payments/domain/idempotency.ts');
    expect(files).not.toContain('src/shared/money/money.ts');
  });

  it('ningún Math.round(x * k) ni toFixed de importes fuera de src/shared/money', () => {
    const offenders = files.flatMap((file) =>
      looseRoundings(readFileSync(join(API_ROOT, file), 'utf8'))
        .filter(
          ({ text }) =>
            !ALLOWED.some((a) => a.file === file && text.includes(a.text)),
        )
        .map(({ line, text }) => `${file}:${line}  ${text}`),
    );
    expect(offenders).toEqual([]);
  });

  it('cada entrada de la lista blanca sigue coincidiendo con algo y tiene razón', () => {
    const stale = ALLOWED.filter(
      (a) =>
        !a.reason.trim() ||
        !files.includes(a.file) ||
        !looseRoundings(readFileSync(join(API_ROOT, a.file), 'utf8')).some(
          ({ text }) => text.includes(a.text),
        ),
    );
    expect(stale).toEqual([]);
  });

  it('autoprueba: detecta las formas de un redondeo a mano', () => {
    const n = (s: string) => looseRoundings(s).length;
    expect(n('const c = Math.round(x * 100);')).toBe(1);
    expect(n('Math.round(a.amount*100) / 100')).toBe(1);
    expect(n('Math.round(\n  (a + b) *\n    100,\n)')).toBe(1);
    expect(n('Math.round(value * factor) / factor')).toBe(1);
    expect(n('return amount.toFixed(2);')).toBe(1);
    expect(n('Number(rate.toFixed(8))')).toBe(1);
    // No son importes ni multiplican:
    expect(n('Math.round(ms / 1000)')).toBe(0);
    expect(n('Math.round(t.cents)')).toBe(0);
    expect(n(' * `Math.round(kg * 10)` daría 72,6')).toBe(0);
    expect(n('// Math.round(x * 100)')).toBe(0);
    expect(n('amountText(x, 2)')).toBe(0);
  });
});
