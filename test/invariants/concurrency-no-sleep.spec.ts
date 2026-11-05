import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-450 (TST-054): las carreras del cobro dividido, del saldo a favor y del
// presupuesto a distancia avanzan por una señal observable (pg_locks, por PID,
// vía test/support/postgres-concurrency), nunca por una pausa: con un
// `setTimeout` como sincronización el test pasa también cuando la segunda
// petición no llegó al candado, y deja de detectar que se quitó.
const TEST = join(__dirname, '..');
const RACE_SPECS = [
  'split-payments.int-spec.ts',
  'patient-credit.int-spec.ts',
  'patient-credit.e2e-spec.ts',
  'remote-budget.int-spec.ts',
];

describe('DX-450: las carreras de dinero y de firma no duermen para sincronizar', () => {
  it.each(RACE_SPECS)('%s no usa setTimeout ni sleeps', (file) => {
    const text = readFileSync(join(TEST, file), 'utf8');
    expect(text).not.toMatch(/\bsetTimeout\s*\(/);
    expect(text).not.toMatch(/\bsleep\s*\(/);
  });

  it.each(RACE_SPECS)('%s espera el bloqueo con waitForLockWaiters', (file) => {
    expect(readFileSync(join(TEST, file), 'utf8')).toMatch(
      /waitForLockWaiters\(/,
    );
  });
});
