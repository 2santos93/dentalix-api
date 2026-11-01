import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { RegisterDomainUseCase } from './register-domain.use-case';
import { FakeClock, InMemoryDomains } from '../__fixtures__/fake-domains';
import type { TenantDomainRepository } from '../../domain/ports/tenant-domain-repository.port';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

const A = 'tenant-a';
const B = 'tenant-b';
const HOST = 'citas.miclinica.com';
const HOUR = 3_600_000;
const AUDIT: AuditRequestContext = {
  tenantId: A,
  locationId: null,
  actor: { userId: 'admin-a', role: 'ADMIN' },
  requestId: null,
  ip: null,
  userAgent: null,
};

const config = {
  get: jest.fn().mockReturnValue('dentalix.app,localhost'),
} as unknown as ConfigService;

function setup() {
  const store = new InMemoryDomains();
  const clock = new FakeClock();
  const register = (tenantId: string, repo?: TenantDomainRepository) =>
    new RegisterDomainUseCase(repo ?? store.as(tenantId), config, clock);
  return { store, clock, register };
}

describe('RegisterDomainUseCase', () => {
  it('normalizes the host, creates a PENDING record expiring in 72 h, and returns DNS instructions', async () => {
    const { store, clock, register } = setup();
    const result = await register(A).execute(
      {
        host: '  Citas.MiClinica.com  ',
      },
      AUDIT,
    );

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ tenantId: A, host: HOST });
    expect(result.domain.status).toBe('PENDING');
    expect(result.domain.expiresAt).toEqual(
      new Date(clock.current.getTime() + 72 * HOUR),
    );
    expect(result.dns).toEqual({
      name: '_dentalix-verify.citas.miclinica.com',
      type: 'TXT',
      value: result.domain.verifyToken,
    });
  });

  it('rejects a host that is actually a subdomain of a base domain', async () => {
    const { register } = setup();
    await expect(
      register(A).execute({ host: 'acme.dentalix.app' }, AUDIT),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a host that is a reserved subdomain (parseHost returns null)', async () => {
    const { register } = setup();
    await expect(
      register(A).execute({ host: 'www.dentalix.app' }, AUDIT),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // SEC-009: antes, el PENDING de A bloqueaba a B con 409 para siempre.
  it('SEC-009: another tenant can register a host that is only PENDING elsewhere (no squatting)', async () => {
    const { store, register } = setup();
    await register(A).execute({ host: HOST }, AUDIT);
    const b = await register(B).execute({ host: HOST }, AUDIT);

    expect(b.domain.status).toBe('PENDING');
    expect(store.rows.map((r) => r.tenantId).sort()).toEqual([A, B]);
    // Cada clínica tiene su propio token.
    expect(store.rows[0].verifyToken).not.toBe(store.rows[1].verifyToken);
  });

  it('rejects a host already registered (and not expired) for this tenant', async () => {
    const { register } = setup();
    await register(A).execute({ host: HOST }, AUDIT);
    await expect(
      register(A).execute({ host: HOST }, AUDIT),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('replaces this tenant’s own EXPIRED pending registration with a fresh one', async () => {
    const { store, clock, register } = setup();
    const first = await register(A).execute({ host: HOST }, AUDIT);
    clock.advance(72 * HOUR);

    const second = await register(A).execute({ host: HOST }, AUDIT);

    expect(second.domain.id).not.toBe(first.domain.id);
    expect(second.domain.verifyToken).not.toBe(first.domain.verifyToken);
    expect(second.domain.status).toBe('PENDING');
    const old = store.rows.find((r) => r.id === first.domain.id);
    expect(old?.deletedAt).toEqual(clock.current);
  });

  it('rejects a host that another tenant already VERIFIED (proved DNS control)', async () => {
    const { store, register } = setup();
    store.seed(B, { host: HOST, status: 'VERIFIED' });
    await expect(register(A).execute({ host: HOST }, AUDIT)).rejects.toThrow(
      'verificado por otra cuenta',
    );
  });

  it('a 409 because another tenant VERIFIED it leaves this tenant’s own expired row untouched', async () => {
    const { store, clock, register } = setup();
    const mine = await register(A).execute({ host: HOST }, AUDIT);
    clock.advance(72 * HOUR);
    store.seed(B, { host: HOST, status: 'VERIFIED' });

    await expect(
      register(A).execute({ host: HOST }, AUDIT),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      store.rows.find((r) => r.id === mine.domain.id)?.deletedAt,
    ).toBeNull();
  });

  it('a DISABLED or soft-deleted domain of another tenant does not block', async () => {
    const { store, register } = setup();
    store.seed(B, { host: HOST, status: 'DISABLED' });
    store.seed(B, {
      host: 'otro.miclinica.com',
      status: 'VERIFIED',
      deletedAt: new Date(0),
    });
    await expect(
      register(A).execute({ host: HOST }, AUDIT),
    ).resolves.toBeDefined();
    await expect(
      register(A).execute({ host: 'otro.miclinica.com' }, AUDIT),
    ).resolves.toBeDefined();
  });

  it('maps a Prisma P2002 on create (same-tenant concurrent registration) to ConflictException', async () => {
    const { store, register } = setup();
    const repo = store.as(A);
    jest.spyOn(repo, 'create').mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'x',
      }),
    );
    await expect(
      register(A, repo).execute({ host: HOST }, AUDIT),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
