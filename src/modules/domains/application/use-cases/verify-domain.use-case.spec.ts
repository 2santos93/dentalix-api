import {
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { VerifyDomainUseCase } from './verify-domain.use-case';
import {
  FakeClock,
  FakeDns,
  InMemoryDomains,
} from '../__fixtures__/fake-domains';

const A = 'tenant-a';
const B = 'tenant-b';
const HOST = 'citas.miclinica.com';
const TXT = `_dentalix-verify.${HOST}`;
const HOUR = 3_600_000;

function setup() {
  const store = new InMemoryDomains();
  const clock = new FakeClock();
  const dns = new FakeDns();
  const verify = (tenantId: string) =>
    new VerifyDomainUseCase(store.as(tenantId), dns, clock);
  const pending = (tenantId: string) =>
    store.seed(tenantId, {
      host: HOST,
      expiresAt: new Date(clock.current.getTime() + 72 * HOUR),
    });
  return { store, clock, dns, verify, pending };
}

describe('VerifyDomainUseCase', () => {
  it('marks the domain VERIFIED when a matching TXT record exists', async () => {
    const { dns, verify, pending, store } = setup();
    const row = pending(A);
    dns.records.set(TXT, ['unrelated', row.verifyToken]);

    await expect(verify(A).execute({ id: row.id })).resolves.toEqual({
      status: 'VERIFIED',
    });
    expect(dns.lookups).toEqual([TXT]);
    expect(store.rows[0]).toMatchObject({
      status: 'VERIFIED',
      expiresAt: null,
      failedChecks: 0,
    });
  });

  it('stays PENDING when no TXT record matches', async () => {
    const { dns, verify, pending } = setup();
    const row = pending(A);
    dns.records.set(TXT, ['something-else']);
    await expect(verify(A).execute({ id: row.id })).resolves.toEqual({
      status: 'PENDING',
    });
  });

  it('stays PENDING when the DNS cannot answer (SERVFAIL/timeout)', async () => {
    const { dns, verify, pending } = setup();
    const row = pending(A);
    dns.failing.add(TXT);
    await expect(verify(A).execute({ id: row.id })).resolves.toEqual({
      status: 'PENDING',
    });
  });

  it('is idempotent for an already-verified domain', async () => {
    const { dns, verify, store } = setup();
    const row = store.seed(A, { host: HOST, status: 'VERIFIED' });
    await expect(verify(A).execute({ id: row.id })).resolves.toEqual({
      status: 'VERIFIED',
    });
    expect(dns.lookups).toEqual([]);
  });

  it('throws NotFound for an unknown/other-tenant domain', async () => {
    const { verify, pending } = setup();
    const row = pending(B);
    await expect(verify(A).execute({ id: row.id })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('SEC-009: an EXPIRED pending (> 72 h) can no longer be verified (410)', async () => {
    const { dns, clock, verify, pending } = setup();
    const row = pending(A);
    dns.records.set(TXT, [row.verifyToken]);
    clock.advance(72 * HOUR);
    await expect(verify(A).execute({ id: row.id })).rejects.toBeInstanceOf(
      GoneException,
    );
    expect(dns.lookups).toEqual([]);
  });

  it('SEC-009: the first tenant to verify the TXT wins and the other tenant’s PENDING is invalidated', async () => {
    const { dns, verify, pending, store } = setup();
    const squat = pending(A);
    const real = pending(B);
    dns.records.set(TXT, [real.verifyToken]);

    await expect(verify(B).execute({ id: real.id })).resolves.toEqual({
      status: 'VERIFIED',
    });

    const a = store.rows.find((r) => r.id === squat.id);
    expect(a?.status).toBe('PENDING');
    expect(a?.expiresAt).toEqual(
      store.rows.find((r) => r.id === real.id)?.verifiedAt,
    );
    // A ya no puede verificarlo: ha quedado caducado.
    dns.records.set(TXT, [real.verifyToken, squat.verifyToken]);
    await expect(verify(A).execute({ id: squat.id })).rejects.toBeInstanceOf(
      GoneException,
    );
  });

  it('SEC-009: a DISABLED domain can be re-verified when its TXT is back', async () => {
    const { dns, verify, store } = setup();
    const row = store.seed(A, {
      host: HOST,
      status: 'DISABLED',
      failedChecks: 3,
      disabledAt: new Date(0),
    });
    dns.records.set(TXT, [row.verifyToken]);
    await expect(verify(A).execute({ id: row.id })).resolves.toEqual({
      status: 'VERIFIED',
    });
    expect(store.rows[0]).toMatchObject({
      status: 'VERIFIED',
      failedChecks: 0,
      disabledAt: null,
    });
  });

  it('SEC-009: 409 when another tenant already verified the host', async () => {
    const { dns, verify, store } = setup();
    store.seed(B, { host: HOST, status: 'VERIFIED' });
    const mine = store.seed(A, { host: HOST, status: 'DISABLED' });
    dns.records.set(TXT, [mine.verifyToken]);
    await expect(verify(A).execute({ id: mine.id })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
