import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaLoginThrottleRepository } from '../src/modules/auth/infrastructure/repositories/prisma-login-throttle.repository';
import { PrismaTokenMaintenanceRepository } from '../src/modules/auth/infrastructure/repositories/prisma-token-maintenance.repository';
import {
  accountKeyHash,
  ipKeyHash,
} from '../src/modules/auth/domain/login-lockout';

/**
 * DX-048: `login_throttles` contra Postgres real con el rol de la app
 * (DATABASE_URL): escrituras atómicas entre conexiones (varias réplicas),
 * horas de la BD, solo hashes (CHECK) y purga de filas olvidadas. Tabla de
 * plataforma: sin columna de tenant ni FK a tenants (no entra en el catálogo
 * de RLS, como revoked_tokens).
 */
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const RUN = Date.now().toString(36);
const MIN = 60_000;

describe('PrismaLoginThrottleRepository (int)', () => {
  let prisma: PrismaService;
  let replicaB: PrismaService;
  let repo: PrismaLoginThrottleRepository;
  let repoB: PrismaLoginThrottleRepository;
  const account = accountKeyHash(`doctora-${RUN}@int.test`);
  const ip = ipKeyHash(`192.0.2.${RUN}`);

  beforeAll(() => {
    prisma = new PrismaService(new TenantContextService());
    replicaB = new PrismaService(new TenantContextService());
    repo = new PrismaLoginThrottleRepository(prisma);
    repoB = new PrismaLoginThrottleRepository(replicaB);
  });

  beforeEach(async () => {
    await raw.loginThrottle.deleteMany({
      where: { keyHash: { in: [account, ip] } },
    });
  });

  afterAll(async () => {
    await raw.loginThrottle.deleteMany({
      where: { keyHash: { in: [account, ip] } },
    });
    await Promise.all([
      prisma.$disconnect(),
      replicaB.$disconnect(),
      raw.$disconnect(),
    ]);
  });

  it('suma TODOS los fallos concurrentes de dos "réplicas" (sin pérdidas)', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? repo : repoB).recordAccountFailure(account, 60 * MIN),
      ),
    );
    const row = await raw.loginThrottle.findUniqueOrThrow({
      where: { scope_keyHash: { scope: 'ACCOUNT', keyHash: account } },
    });
    expect(row.failures).toBe(20);
  });

  it('bloquea con la hora de la BD y devuelve los segundos redondeados hacia arriba', async () => {
    await repo.recordAccountFailure(account, 60 * MIN);
    await repo.blockAccount(account, 90_000);
    const seconds = await repoB.retryAfterSeconds({
      accountKeyHash: account,
      ipKeyHash: ip,
    });
    expect(seconds).toBeGreaterThanOrEqual(89);
    expect(seconds).toBeLessThanOrEqual(90);
    const until = await repoB.accountBlockedUntil(account);
    expect(until).toBeInstanceOf(Date);
    const [{ now }] = await raw.$queryRaw<{ now: Date }[]>`
      SELECT timezone('utc', now())::timestamp(3) AS now`;
    expect((until as Date).getTime() - now.getTime()).toBeGreaterThan(85_000);
    expect((until as Date).getTime() - now.getTime()).toBeLessThanOrEqual(
      90_000,
    );
  });

  it('blockAccount nunca acorta una espera más larga', async () => {
    await repo.recordAccountFailure(account, 60 * MIN);
    await repo.blockAccount(account, 10 * MIN);
    await repo.blockAccount(account, MIN);
    expect(
      await repo.retryAfterSeconds({ accountKeyHash: account, ipKeyHash: ip }),
    ).toBeGreaterThan(9 * 60);
  });

  it('olvida los fallos tras failureMemoryMs sin fallar y quita la espera vieja', async () => {
    await repo.recordAccountFailure(account, 60 * MIN);
    await repo.recordAccountFailure(account, 60 * MIN);
    await raw.loginThrottle.update({
      where: { scope_keyHash: { scope: 'ACCOUNT', keyHash: account } },
      data: { lastFailureAt: new Date(Date.now() - 61 * MIN) },
    });
    expect(await repo.recordAccountFailure(account, 60 * MIN)).toBe(1);
  });

  it('IP: ventana fija; al llegar al límite queda en espera hasta su final', async () => {
    for (let i = 0; i < 3; i++) await repo.recordIpFailure(ip, 3, MIN);
    const seconds = await repo.retryAfterSeconds({
      accountKeyHash: account,
      ipKeyHash: ip,
    });
    expect(seconds).toBeGreaterThan(55);
    expect(seconds).toBeLessThanOrEqual(60);
    // Ventana acabada: el siguiente fallo abre una nueva y sin espera.
    await raw.loginThrottle.update({
      where: { scope_keyHash: { scope: 'IP', keyHash: ip } },
      data: {
        windowStartedAt: new Date(Date.now() - 2 * MIN),
        blockedUntil: new Date(Date.now() - MIN),
      },
    });
    await repo.recordIpFailure(ip, 3, MIN);
    const row = await raw.loginThrottle.findUniqueOrThrow({
      where: { scope_keyHash: { scope: 'IP', keyHash: ip } },
    });
    expect(row.failures).toBe(1);
    expect(row.blockedUntil).toBeNull();
  });

  it('clearAccount borra la cuenta y no toca la IP', async () => {
    await repo.recordAccountFailure(account, 60 * MIN);
    await repo.recordIpFailure(ip, 100, MIN);
    await repo.clearAccount(account);
    expect(
      await raw.loginThrottle.count({
        where: { keyHash: { in: [account, ip] } },
      }),
    ).toBe(1);
  });

  it('el CHECK solo admite un SHA-256 en hex (nunca un email en claro)', async () => {
    await expect(
      raw.$executeRaw`
        INSERT INTO "login_throttles"
               ("scope", "keyHash", "failures", "windowStartedAt", "lastFailureAt")
        VALUES ('ACCOUNT', ${`ana-${RUN}@clinica.co`}, 1, now(), now())`,
    ).rejects.toThrow(/login_throttles_key_hash_check/);
  });

  it('tabla de plataforma: sin columna de tenant ni FK a tenants', async () => {
    const cols = await raw.$queryRaw<{ column: string }[]>`
      SELECT a.attname AS column FROM pg_attribute a
       WHERE a.attrelid = 'public.login_throttles'::regclass
         AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ILIKE '%tenant%'`;
    expect(cols).toEqual([]);
    const fks = await raw.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conrelid = 'public.login_throttles'::regclass AND contype = 'f'`;
    expect(fks[0].n).toBe(0);
  });

  it('la purga horaria borra lo olvidado y conserva lo reciente o en espera', async () => {
    await repo.recordAccountFailure(account, 60 * MIN);
    await repo.recordIpFailure(ip, 100, MIN);
    await raw.loginThrottle.update({
      where: { scope_keyHash: { scope: 'ACCOUNT', keyHash: account } },
      data: { lastFailureAt: new Date(Date.now() - 2 * 60 * MIN) },
    });
    const maintenance = new PrismaTokenMaintenanceRepository(prisma);
    const purged = await maintenance.purgeExpired(7 * 86_400_000, 60 * MIN);
    expect(purged.loginThrottles).toBeGreaterThanOrEqual(1);
    const left = await raw.loginThrottle.findMany({
      where: { keyHash: { in: [account, ip] } },
    });
    expect(left.map((r) => r.scope)).toEqual(['IP']);
  });
});
