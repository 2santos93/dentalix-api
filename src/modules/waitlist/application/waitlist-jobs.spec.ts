import { JobRegistry } from '../../jobs/application/job-registry';
import { WaitlistJobs } from './waitlist-jobs';
import { EXPIRE_SLOT_OFFERS_JOB, ExpireSlotOffers } from './expire-slot-offers';
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
    const expireDue = jest
      .fn()
      .mockResolvedValueOnce(2)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(1);
    const repo = {
      tenantIds: () => Promise.resolve(['t1', 't2', 't3']),
      expireDue,
    } as unknown as SlotOfferRepository;
    const now = new Date('2026-11-02T15:00:00Z');
    const sweep = new ExpireSlotOffers(repo, () => now);
    await expect(sweep.run()).rejects.toThrow(
      'Caducar ofertas falló en 1 clínica(s)',
    );
    expect(expireDue).toHaveBeenCalledTimes(3);
    expect(expireDue).toHaveBeenCalledWith('t3', now, 500);
  });
});
