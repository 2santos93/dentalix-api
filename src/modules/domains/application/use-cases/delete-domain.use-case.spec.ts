import { NotFoundException } from '@nestjs/common';
import { DeleteDomainUseCase } from './delete-domain.use-case';
import { ListDomainsUseCase } from './list-domains.use-case';
import { FakeClock, InMemoryDomains } from '../__fixtures__/fake-domains';

const A = 'tenant-a';
const B = 'tenant-b';

describe('DeleteDomainUseCase (SEC-009)', () => {
  it('soft-deletes a domain of this tenant, in any state', async () => {
    const store = new InMemoryDomains();
    const clock = new FakeClock();
    const rows = (['PENDING', 'VERIFIED', 'DISABLED'] as const).map(
      (status, i) => store.seed(A, { host: `d${i}.miclinica.com`, status }),
    );
    const uc = new DeleteDomainUseCase(store.as(A), clock);
    for (const row of rows) {
      await uc.execute({ id: row.id });
    }
    expect(
      store.rows.every(
        (r) => r.deletedAt?.getTime() === clock.current.getTime(),
      ),
    ).toBe(true);
    await expect(
      new ListDomainsUseCase(store.as(A), clock).execute(),
    ).resolves.toEqual([]);
  });

  it('404 for a domain of another tenant (and it is left untouched)', async () => {
    const store = new InMemoryDomains();
    const other = store.seed(B, { host: 'citas.otra.com' });
    const uc = new DeleteDomainUseCase(store.as(A), new FakeClock());
    await expect(uc.execute({ id: other.id })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(store.rows[0].deletedAt).toBeNull();
  });

  it('404 for an already deleted domain', async () => {
    const store = new InMemoryDomains();
    const row = store.seed(A, { host: 'citas.miclinica.com' });
    const uc = new DeleteDomainUseCase(store.as(A), new FakeClock());
    await uc.execute({ id: row.id });
    await expect(uc.execute({ id: row.id })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ListDomainsUseCase (SEC-009)', () => {
  it('reports a PENDING past its expiresAt as EXPIRED', async () => {
    const store = new InMemoryDomains();
    const clock = new FakeClock();
    store.seed(A, {
      host: 'viejo.miclinica.com',
      expiresAt: new Date(clock.current.getTime() - 1),
    });
    store.seed(A, {
      host: 'nuevo.miclinica.com',
      expiresAt: new Date(clock.current.getTime() + 1),
    });
    store.seed(A, { host: 'off.miclinica.com', status: 'DISABLED' });
    const list = await new ListDomainsUseCase(store.as(A), clock).execute();
    expect(list.map((d) => [d.host, d.status])).toEqual([
      ['viejo.miclinica.com', 'EXPIRED'],
      ['nuevo.miclinica.com', 'PENDING'],
      ['off.miclinica.com', 'DISABLED'],
    ]);
  });
});
