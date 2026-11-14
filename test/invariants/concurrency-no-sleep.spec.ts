import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-450 (TST-054): las carreras con candado avanzan por una señal observable
// (pg_locks, por PID, vía test/support/postgres-concurrency), nunca por una
// pausa: con un `setTimeout` como sincronización el test pasa también cuando
// la segunda petición no llegó al candado y deja de detectar que se quitó.
// Se descubren solos los specs que usan holdLock / waitForLockWaiters.
const TEST = join(__dirname, '..');
const RACE_SPECS = readdirSync(TEST)
  .filter((f) => /\.(int|e2e)-spec\.ts$/.test(f))
  .filter((f) =>
    /\b(holdLock|holdPlanRowLock|waitForLockWaiters)\(/.test(
      readFileSync(join(TEST, f), 'utf8'),
    ),
  );

describe('DX-450: las carreras con candado no duermen para sincronizar', () => {
  it('descubre al menos los specs del cobro dividido, el saldo y el presupuesto', () => {
    expect(RACE_SPECS).toEqual(
      expect.arrayContaining([
        'split-payments.int-spec.ts',
        'patient-credit.int-spec.ts',
        'patient-credit.e2e-spec.ts',
        'remote-budget.int-spec.ts',
      ]),
    );
  });

  it.each(RACE_SPECS)('%s no usa setTimeout ni sleeps', (file) => {
    const text = readFileSync(join(TEST, file), 'utf8');
    expect(text).not.toMatch(/\bsetTimeout\s*\(/);
    expect(text).not.toMatch(/\bsleep\s*\(/);
  });
});
