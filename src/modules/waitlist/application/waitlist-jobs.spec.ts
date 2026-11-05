import { JobRegistry } from '../../jobs/application/job-registry';
import { WaitlistJobs } from './waitlist-jobs';
import {
  EXPIRE_BATCH_SIZE,
  EXPIRE_MAX_BATCHES,
  EXPIRE_SLOT_OFFERS_JOB,
  ExpireSlotOffers,
} from './expire-slot-offers';
import type { SlotOfferRepository } from '../domain/ports/slot-offer-repository.port';

describe('barrido de ofertas de hueco caducadas (DX-435)', () => {
  it('registra el trabajo y su tarea programada con nombres válidos en la cola', () => {
    const registry = new JobRegistry();
    const expire = { run: jest.fn() } as unknown as ExpireSlotOffers;
    expect(() =>
      new WaitlistJobs(registry, expire).onModuleInit(),
    ).not.toThrow();
    expect(registry.get(EXPIRE_SLOT_OFFERS_JOB)).toBeDefined();
  });

  it('recorre todas las clínicas y falla al final si alguna falló (sin frenar a las demás)', async () => {
    const expireDueBatch = jest
      .fn()
      .mockResolvedValueOnce({ scanned: 2, expired: 2, lastId: 'a' })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ scanned: 1, expired: 1, lastId: 'b' });
    const repo = {
      tenantIds: () => Promise.resolve(['t1', 't2', 't3']),
      expireDueBatch,
    } as unknown as SlotOfferRepository;
    const now = new Date('2026-11-02T15:00:00Z');
    const sweep = new ExpireSlotOffers(repo, () => now);
    await expect(sweep.run()).rejects.toThrow(
      'Caducar ofertas falló en 1 clínica(s)',
    );
    expect(expireDueBatch).toHaveBeenCalledTimes(3);
    expect(expireDueBatch).toHaveBeenCalledWith(
      't3',
      now,
      EXPIRE_BATCH_SIZE,
      null,
    );
  });

  it('DX-476: sigue lote a lote desde el último id hasta que un lote no se llena', async () => {
    const full = (lastId: string) => ({
      scanned: EXPIRE_BATCH_SIZE,
      expired: EXPIRE_BATCH_SIZE,
      lastId,
    });
    const expireDueBatch = jest
      .fn()
      .mockResolvedValueOnce(full('id-1'))
      .mockResolvedValueOnce(full('id-2'))
      // Un lote con filas saltadas por estar bloqueadas: escaneó, no caducó.
      .mockResolvedValueOnce({ scanned: 7, expired: 3, lastId: 'id-3' });
    const repo = {
      tenantIds: () => Promise.resolve(['t1']),
      expireDueBatch,
    } as unknown as SlotOfferRepository;
    const now = new Date('2026-11-02T15:00:00Z');
    const result = await new ExpireSlotOffers(repo, () => now).run();
    expect(result.expired).toBe(EXPIRE_BATCH_SIZE * 2 + 3);
    expect((expireDueBatch.mock.calls as unknown[][]).map((c) => c[3])).toEqual(
      [null, 'id-1', 'id-2'],
    );
  });

  it('DX-476: nunca pasa de EXPIRE_MAX_BATCHES lotes por clínica y pasada', async () => {
    const expireDueBatch = jest.fn().mockResolvedValue({
      scanned: EXPIRE_BATCH_SIZE,
      expired: EXPIRE_BATCH_SIZE,
      lastId: 'x',
    });
    const repo = {
      tenantIds: () => Promise.resolve(['t1']),
      expireDueBatch,
    } as unknown as SlotOfferRepository;
    await new ExpireSlotOffers(repo, () => new Date()).run();
    expect(expireDueBatch).toHaveBeenCalledTimes(EXPIRE_MAX_BATCHES);
  });
});
