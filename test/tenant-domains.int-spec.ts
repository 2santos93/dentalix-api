import { ConflictException, GoneException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { TenantResolverService } from '../src/shared/tenancy/tenant-resolver.service';
import { PrismaTenantDomainRepository } from '../src/modules/domains/infrastructure/repositories/prisma-tenant-domain.repository';
import { PrismaDomainRecheckSource } from '../src/modules/domains/infrastructure/repositories/prisma-domain-recheck-source';
import { RegisterDomainUseCase } from '../src/modules/domains/application/use-cases/register-domain.use-case';
import { VerifyDomainUseCase } from '../src/modules/domains/application/use-cases/verify-domain.use-case';
import { ListDomainsUseCase } from '../src/modules/domains/application/use-cases/list-domains.use-case';
import {
  DomainRecheckSweep,
  RECHECK_DOMAIN_JOB,
  RecheckDomain,
} from '../src/modules/domains/application/domain-recheck';
import type { JobQueue } from '../src/modules/jobs/application/job-queue.service';
import {
  FakeClock,
  FakeDns,
} from '../src/modules/domains/application/__fixtures__/fake-domains';

// SEC-009, capa de BD: los índices únicos parciales nuevos, la caducidad de
// los PENDING, la carrera de dos verificaciones y la re-verificación
// periódica con el repositorio REAL (rol dentalix_app; tenant_domains no
// tiene RLS, el aislamiento es el filtro por tenant del repositorio) y el
// resolver de host real. El DNS y el reloj son simulados.
const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const config = {
  get: (key: string) =>
    key === 'TENANT_BASE_DOMAINS' ? 'dentalix.app,localhost' : undefined,
} as unknown as ConfigService;
const repo = new PrismaTenantDomainRepository(prisma, tenantContext);
const resolver = new TenantResolverService(prisma, config);

const SUBDOMAINS = ['sec009-int-a', 'sec009-int-b'];
const HOUR = 3_600_000;
const ROUNDS = 5;
const txt = (host: string) => `_dentalix-verify.${host}`;

let A: string;
let B: string;
const clock = new FakeClock();
const dns = new FakeDns();
const register = new RegisterDomainUseCase(repo, config, clock);
const verify = new VerifyDomainUseCase(repo, dns, clock);
const list = new ListDomainsUseCase(repo, clock);

const as = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(tenantId, fn);

async function cleanup(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  await owner.tenantDomain.deleteMany({ where: { tenantId: { in: ids } } });
  await owner.tenant.deleteMany({ where: { id: { in: ids } } });
}

function uniqueIndexOf(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  if (error.code !== 'P2002') return null;
  return JSON.stringify(error.meta ?? {});
}

describe('SEC-009 · dominios personalizados (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    A = (
      await owner.tenant.create({
        data: { name: 'Clínica Squatter', subdomain: SUBDOMAINS[0] },
      })
    ).id;
    B = (
      await owner.tenant.create({
        data: { name: 'Clínica Real', subdomain: SUBDOMAINS[1] },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await owner.$disconnect();
  });

  beforeEach(async () => {
    await owner.tenantDomain.deleteMany({
      where: { tenantId: { in: [A, B] } },
    });
    dns.records.clear();
    dns.failing.clear();
    clock.current = new Date();
  });

  describe('índices únicos parciales', () => {
    it('dos clínicas pueden tener el mismo host en PENDING (antes: 409 por el índice global)', async () => {
      const host = 'citas.squat-int.com';
      await as(A, () => register.execute({ host }));
      await expect(as(B, () => register.execute({ host }))).resolves.toEqual(
        expect.objectContaining({
          domain: expect.objectContaining({ status: 'PENDING' }) as unknown,
        }),
      );
      expect(
        await owner.tenantDomain.count({ where: { host, deletedAt: null } }),
      ).toBe(2);
    });

    it('la BD no admite dos VERIFIED vivos del mismo host (tenant_domains_verified_host_key)', async () => {
      const host = 'citas.verified-int.com';
      await owner.tenantDomain.create({
        data: { tenantId: A, host, verifyToken: 'a', status: 'VERIFIED' },
      });
      const error = await owner.tenantDomain
        .create({
          data: { tenantId: B, host, verifyToken: 'b', status: 'VERIFIED' },
        })
        .catch((e: unknown) => e);
      expect(uniqueIndexOf(error)).not.toBeNull();
      // Uno borrado (soft) o DISABLED no cuenta.
      await owner.tenantDomain.updateMany({
        where: { tenantId: A, host },
        data: { status: 'DISABLED' },
      });
      await expect(
        owner.tenantDomain.create({
          data: { tenantId: B, host, verifyToken: 'b', status: 'VERIFIED' },
        }),
      ).resolves.toBeDefined();
    });

    it('dentro de una clínica, un host una sola vez entre los vivos (tenant_domains_tenant_host_key); borrado se puede repetir', async () => {
      const host = 'citas.same-tenant-int.com';
      const first = await owner.tenantDomain.create({
        data: { tenantId: A, host, verifyToken: 'a' },
      });
      const error = await owner.tenantDomain
        .create({ data: { tenantId: A, host, verifyToken: 'a2' } })
        .catch((e: unknown) => e);
      expect(uniqueIndexOf(error)).not.toBeNull();
      await owner.tenantDomain.update({
        where: { id: first.id },
        data: { deletedAt: new Date() },
      });
      await expect(
        owner.tenantDomain.create({
          data: { tenantId: A, host, verifyToken: 'a3' },
        }),
      ).resolves.toBeDefined();
    });

    it('el índice de host único lleva exactamente el predicado del ruteo', async () => {
      const [idx] = await owner.$queryRaw<{ def: string }[]>`
        SELECT pg_get_indexdef(i.indexrelid) AS def
          FROM pg_index i
         WHERE i.indexrelid = 'public.tenant_domains_verified_host_key'::regclass`;
      expect(idx.def).toContain('UNIQUE INDEX');
      expect(idx.def).toContain(
        `WHERE ((status = 'VERIFIED'::"TenantDomainStatus") AND ("deletedAt" IS NULL))`,
      );
      const [legacy] = await owner.$queryRaw<{ r: string | null }[]>`
        SELECT to_regclass('public.tenant_domains_host_key')::text AS r`;
      expect(legacy.r).toBeNull();
    });
  });

  describe('caducidad de los PENDING (72 h)', () => {
    it('sin expiresAt explícito, la BD lo pone a 72 h (código anterior durante el despliegue)', async () => {
      const row = await owner.tenantDomain.create({
        data: { tenantId: A, host: 'citas.default-int.com', verifyToken: 'x' },
      });
      expect(row.expiresAt).not.toBeNull();
      // createdAt lo pone Prisma (cliente) y expiresAt la BD: mismo instante
      // salvo milisegundos.
      const ttl = row.expiresAt!.getTime() - row.createdAt.getTime();
      expect(Math.abs(ttl - 72 * HOUR)).toBeLessThan(2000);
    });

    it('un PENDING de más de 72 h es EXPIRED: no se verifica (410) y su clínica lo puede volver a registrar', async () => {
      const host = 'citas.expired-int.com';
      const { domain } = await as(A, () => register.execute({ host }));
      clock.advance(72 * HOUR + 1);
      dns.records.set(txt(host), [domain.verifyToken]);

      await expect(
        as(A, () => verify.execute({ id: domain.id })),
      ).rejects.toBeInstanceOf(GoneException);
      expect((await as(A, () => list.execute())).map((d) => d.status)).toEqual([
        'EXPIRED',
      ]);

      const again = await as(A, () => register.execute({ host }));
      expect(again.domain.id).not.toBe(domain.id);
      const rows = await owner.tenantDomain.findMany({
        where: { tenantId: A, host },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => r.deletedAt !== null)).toEqual([true, false]);
    });

    it('la BD tampoco deja verificar un PENDING caducado aunque se salte el caso de uso', async () => {
      const row = await owner.tenantDomain.create({
        data: {
          tenantId: A,
          host: 'citas.expired-db-int.com',
          verifyToken: 'x',
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      await expect(
        as(A, () => repo.markVerified(row.id, new Date())),
      ).resolves.toBe('unavailable');
      expect(
        (await owner.tenantDomain.findUniqueOrThrow({ where: { id: row.id } }))
          .status,
      ).toBe('PENDING');
    });
  });

  describe('verificación: el primero que demuestra el TXT se lo queda', () => {
    it('B verifica: enruta a B y el PENDING de A queda invalidado (EXPIRED)', async () => {
      const host = 'citas.winner-int.com';
      const squat = await as(A, () => register.execute({ host }));
      const real = await as(B, () => register.execute({ host }));
      expect(await resolver.resolve(host)).toBeNull();

      dns.records.set(txt(host), [real.domain.verifyToken]);
      await expect(
        as(B, () => verify.execute({ id: real.domain.id })),
      ).resolves.toEqual({ status: 'VERIFIED' });

      expect(await resolver.resolve(host)).toBe(B);
      expect((await as(A, () => list.execute()))[0]).toMatchObject({
        id: squat.domain.id,
        status: 'EXPIRED',
      });
      // A ya no puede ni verificarlo ni registrarlo de nuevo.
      dns.records.set(txt(host), [
        real.domain.verifyToken,
        squat.domain.verifyToken,
      ]);
      await expect(
        as(A, () => verify.execute({ id: squat.domain.id })),
      ).rejects.toBeInstanceOf(GoneException);
      await expect(
        as(A, () => register.execute({ host: 'citas.winner-int.com' })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it(`carrera: dos clínicas verifican a la vez (${ROUNDS} vueltas) → exactamente una gana, la otra recibe 'taken'`, async () => {
      for (let i = 0; i < ROUNDS; i += 1) {
        const host = `citas.race-${i}-int.com`;
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 72 * HOUR);
        const a = await owner.tenantDomain.create({
          data: { tenantId: A, host, verifyToken: 'a', expiresAt },
        });
        const b = await owner.tenantDomain.create({
          data: { tenantId: B, host, verifyToken: 'b', expiresAt },
        });
        const results = await Promise.all([
          as(A, () => repo.markVerified(a.id, now)),
          as(B, () => repo.markVerified(b.id, now)),
        ]);
        expect([...results].sort()).toEqual(['taken', 'verified']);
        expect(
          await owner.tenantDomain.count({
            where: { host, status: 'VERIFIED', deletedAt: null },
          }),
        ).toBe(1);
      }
    });
  });

  describe('re-verificación periódica (repositorio real, DNS simulado)', () => {
    const queued: { payload: Record<string, string>; tenantId: string }[] = [];
    const jobs = {
      enqueue: (
        name: string,
        payload: Record<string, string>,
        options: { tenantId: string },
      ) => {
        expect(name).toBe(RECHECK_DOMAIN_JOB);
        queued.push({ payload, tenantId: options.tenantId });
        return Promise.resolve({ id: 'x', created: true });
      },
    } as unknown as JobQueue;
    const sweep = new DomainRecheckSweep(
      new PrismaDomainRecheckSource(prisma),
      jobs,
      clock,
    );
    const recheck = new RecheckDomain(repo, dns, { recheckMaxFailures: 3 });

    async function round(): Promise<void> {
      queued.length = 0;
      await sweep.run();
      for (const job of queued.filter((q) => [A, B].includes(q.tenantId))) {
        await as(job.tenantId, () =>
          recheck.handle(job.payload, {
            tenantId: job.tenantId,
            attempt: 1,
            maxAttempts: 3,
          }),
        );
      }
      clock.advance(HOUR);
    }

    it('cuando el TXT desaparece, a la 3ª comprobación seguida pasa a DISABLED y el resolver deja de enrutarlo', async () => {
      const host = 'citas.recheck-int.com';
      const { domain } = await as(A, () => register.execute({ host }));
      dns.records.set(txt(host), [domain.verifyToken]);
      await as(A, () => verify.execute({ id: domain.id }));
      expect(await resolver.resolve(host)).toBe(A);

      await round();
      expect(
        await owner.tenantDomain.findUniqueOrThrow({
          where: { id: domain.id },
        }),
      ).toMatchObject({ status: 'VERIFIED', failedChecks: 0 });

      // El dominio caduca y lo compra otro: el TXT ya no está.
      dns.records.delete(txt(host));
      await round();
      await round();
      expect(await resolver.resolve(host)).toBe(A);
      await round();

      const row = await owner.tenantDomain.findUniqueOrThrow({
        where: { id: domain.id },
      });
      expect(row).toMatchObject({ status: 'DISABLED', failedChecks: 3 });
      expect(row.disabledAt).not.toBeNull();
      expect(await resolver.resolve(host)).toBeNull();
      expect((await as(A, () => list.execute()))[0].status).toBe('DISABLED');

      // El host queda libre para quien demuestre el control ahora.
      const real = await as(B, () => register.execute({ host }));
      dns.records.set(txt(host), [real.domain.verifyToken]);
      await expect(
        as(B, () => verify.execute({ id: real.domain.id })),
      ).resolves.toEqual({ status: 'VERIFIED' });
      expect(await resolver.resolve(host)).toBe(B);
    });

    it('el resolver no enruta un VERIFIED de una clínica borrada', async () => {
      const host = 'citas.tenant-deleted-int.com';
      await owner.tenantDomain.create({
        data: { tenantId: A, host, verifyToken: 'a', status: 'VERIFIED' },
      });
      expect(await resolver.resolve(host)).toBe(A);
      await owner.tenant.update({
        where: { id: A },
        data: { deletedAt: new Date() },
      });
      try {
        expect(await resolver.resolve(host)).toBeNull();
      } finally {
        await owner.tenant.update({
          where: { id: A },
          data: { deletedAt: null },
        });
      }
    });
  });
});
