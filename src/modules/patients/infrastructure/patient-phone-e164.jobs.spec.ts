import { runPhoneE164Backfill } from './patient-phone-e164.jobs';

const ok = { patientsWritten: 2, responsiblesWritten: 1 };

describe('runPhoneE164Backfill (DX-224, ronda 2)', () => {
  it('el fallo de una clínica no impide rellenar las siguientes y se registra sin teléfonos', async () => {
    const errors: [string, unknown][] = [];
    const seen: string[] = [];
    const result = await runPhoneE164Backfill({
      tenantIds: ['t1', 't2', 't3'],
      backfill: (id) => {
        seen.push(id);
        if (id === 't2') {
          return Promise.reject(
            Object.assign(new Error('0412 1234567'), { name: 'QueryTimeout' }),
          );
        }
        return Promise.resolve(ok);
      },
      shouldStop: () => false,
      onTenantError: (id, error) => errors.push([id, error]),
    });
    expect(seen).toEqual(['t1', 't2', 't3']);
    expect(result).toEqual({
      tenants: 3,
      done: 2,
      failed: 1,
      written: 6,
      stopped: false,
    });
    expect(errors.map(([id]) => id)).toEqual(['t2']);
  });

  it('con la señal abortada entre clínicas, para y no toca las siguientes', async () => {
    let aborted = false;
    const seen: string[] = [];
    const result = await runPhoneE164Backfill({
      tenantIds: ['t1', 't2', 't3'],
      backfill: (id) => {
        seen.push(id);
        if (id === 't1') aborted = true; // la reserva se pierde durante t1
        return Promise.resolve(ok);
      },
      shouldStop: () => aborted,
      onTenantError: () => undefined,
    });
    expect(seen).toEqual(['t1']);
    expect(result).toMatchObject({ done: 1, stopped: true });
  });

  it('pasa la señal a cada clínica para que pare entre lotes', async () => {
    let aborted = false;
    let stopSeen: boolean | null = null;
    await runPhoneE164Backfill({
      tenantIds: ['t1'],
      backfill: (_id, shouldStop) => {
        aborted = true;
        stopSeen = shouldStop();
        return Promise.resolve(ok);
      },
      shouldStop: () => aborted,
      onTenantError: () => undefined,
    });
    expect(stopSeen).toBe(true);
  });
});
