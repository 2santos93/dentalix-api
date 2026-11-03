import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * DX-528 / DX-354 (D7): ningún texto del producto dice un importe con un
 * símbolo. El producto es bimonetario y «$» no dice qué moneda es (DX-378), así
 * que los importes de los mensajes (emails, errores 4xx, avisos) salen con
 * `moneyWithCode` (código ISO o el texto propio de la clínica, DX-517/DX-521),
 * nunca con `fmt.money`, que escribe «$», «£»…
 * La guarda recorre TODO `src/` salvo `shared/format/` (donde vive `money`),
 * las specs y los `__fixtures__`, y falla si una línea llama a `.money(`. La
 * autoprueba fija qué detecta y qué no. (Antes, DX-528, solo miraba los emails.)
 */
const SRC = join(__dirname, '..');
const FORMAT_DIR = join(SRC, 'shared', 'format') + sep;

/** Una llamada a `fmt.money(` / `format.money(` / `.money(` (no `moneyWithCode`). */
const SYMBOL_MONEY = /\.money\s*\(/;

export function usesSymbolMoney(line: string): boolean {
  return SYMBOL_MONEY.test(line);
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

const isProductionCode = (file: string): boolean =>
  !file.endsWith('.spec.ts') &&
  !file.split(sep).includes('__fixtures__') &&
  !file.startsWith(FORMAT_DIR);

describe('sin importes con símbolo en los mensajes (DX-528, DX-354)', () => {
  it('el código de producción no llama a fmt.money', () => {
    const files = tsFiles(SRC).filter(isProductionCode);
    // Que la guarda mire algo: los emails del recibo y de la política, y los
    // mensajes que DX-354 pasó a `moneyWithCode`.
    const names = files.map((f) => relative(SRC, f).split(sep).join('/'));
    expect(names).toEqual(
      expect.arrayContaining([
        'modules/payments/application/receipts/receipt-email-vars.ts',
        'modules/cancellation-policies/domain/reminder-policy-vars.ts',
        'modules/payments/domain/opening-balance-payment.ts',
        'modules/cancellation-fees/application/cancellation-fee.use-cases.ts',
        'modules/patient-imports/domain/opening-balance-sheet.ts',
      ]),
    );
    const offending = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          usesSymbolMoney(line)
            ? [`${relative(SRC, file).split(sep).join('/')}:${i + 1}`]
            : [],
        ),
    );
    expect(offending).toEqual([]);
  });

  it('shared/format/ queda fuera: ahí vive money', () => {
    expect(isProductionCode(join(SRC, 'shared', 'format', 'x.ts'))).toBe(false);
    expect(isProductionCode(join(SRC, 'modules', 'x', 'y.ts'))).toBe(true);
    expect(isProductionCode(join(SRC, 'modules', 'x', 'y.spec.ts'))).toBe(
      false,
    );
  });

  it('autoprueba: detecta fmt.money y deja pasar moneyWithCode', () => {
    expect(usesSymbolMoney('fmt.money(10, currency)')).toBe(true);
    expect(usesSymbolMoney('  }).money(value, currency),')).toBe(true);
    expect(usesSymbolMoney('moneyWithCode(10, currency, fmt, texts)')).toBe(
      false,
    );
    expect(usesSymbolMoney('const money = (a: number) => a')).toBe(false);
    expect(usesSymbolMoney('input.moneyText(cents)')).toBe(false);
  });
});
