import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * DX-528: ningún email dice un importe con un símbolo. El producto es
 * bimonetario y «$» no dice qué moneda es (DX-378), así que los importes de los
 * emails salen con `moneyWithCode` (código ISO o el texto propio de la
 * clínica, DX-517/DX-521), nunca con `fmt.money`, que escribe «$», «£»…
 * La guarda recorre el código de producción de los emails: todo
 * `modules/notifications/email/` y las variables de email (`*-vars.ts`,
 * `*-email-vars.ts`), y falla si una línea llama a `.money(`. La autoprueba
 * fija qué detecta y qué no.
 */
const SRC = join(__dirname, '..');
const EMAIL_DIR = join(SRC, 'modules', 'notifications', 'email') + sep;

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

const isEmailCode = (file: string): boolean =>
  !file.endsWith('.spec.ts') &&
  !file.split(sep).includes('__fixtures__') &&
  (file.startsWith(EMAIL_DIR) || /-vars\.ts$/.test(file));

describe('sin importes con símbolo en los emails (DX-528)', () => {
  it('el código de los emails no llama a fmt.money', () => {
    const files = tsFiles(SRC).filter(isEmailCode);
    // Que la guarda mire algo: las variables del recibo y de la política.
    const names = files.map((f) => relative(SRC, f).split(sep).join('/'));
    expect(names).toEqual(
      expect.arrayContaining([
        'modules/payments/application/receipts/receipt-email-vars.ts',
        'modules/cancellation-policies/domain/reminder-policy-vars.ts',
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

  it('autoprueba: detecta fmt.money y deja pasar moneyWithCode', () => {
    expect(usesSymbolMoney('fmt.money(10, currency)')).toBe(true);
    expect(usesSymbolMoney('  }).money(value, currency),')).toBe(true);
    expect(usesSymbolMoney('moneyWithCode(10, currency, fmt, texts)')).toBe(
      false,
    );
    expect(usesSymbolMoney('const money = (a: number) => a')).toBe(false);
  });
});
