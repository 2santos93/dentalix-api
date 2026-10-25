import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaBreakGlassRepository } from '../src/modules/auth/infrastructure/repositories/prisma-break-glass.repository';
import { PrismaSupportAccessRepository } from '../src/modules/support-accesses/infrastructure/prisma-support-access.repository';

// SEC-008, capa de BD: platform_access_audit es append-only (triggers y
// grants), con RLS forzada por tenant y CHECKs de motivo y caducidad; y el
// anti-replay del TOTP es atómico.

// Owner/superusuario (DIRECT_URL): fixtures y limpieza.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
// Rol de la app (DATABASE_URL) sujeto a RLS, como la API.
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const breakGlass = new PrismaBreakGlassRepository(prisma);
const supportAccesses = new PrismaSupportAccessRepository(prisma);

const SUBDOMAINS = ['bg-db-a', 'bg-db-b'];
const EMAIL = 'bg-db-super@x.com';
const REASON = 'Ticket 77: revisar la agenda de la sede';

async function purge(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  // Solo el superusuario puede borrar (trigger); la app nunca.
  await owner.platformAccessAudit.deleteMany({
    where: { tenantId: { in: ids } },
  });
  await owner.tenant.deleteMany({ where: { id: { in: ids } } });
  await owner.user.deleteMany({ where: { email: EMAIL } });
}

function access(tenantId: string, userId: string, minutes = 30) {
  const createdAt = new Date();
  return {
    tenantId,
    userId,
    reason: REASON,
    ip: '10.0.0.1',
    userAgent: 'jest',
    createdAt,
    expiresAt: new Date(createdAt.getTime() + minutes * 60_000),
  };
}

/** Ejecuta `sql` como la app con el tenant fijado; devuelve el error, si lo hay. */
async function asApp(tenantId: string, sql: string): Promise<unknown> {
  try {
    await prisma.runWithTenant(tenantId, (tx) => tx.$executeRawUnsafe(sql));
    return null;
  } catch (err) {
    return err;
  }
}

describe('SEC-008 · platform_access_audit en la BD (int)', () => {
  let tenantA: string;
  let tenantB: string;
  let userId: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purge();
    const [a, b] = await Promise.all(
      SUBDOMAINS.map((subdomain) =>
        owner.tenant.create({ data: { name: subdomain, subdomain } }),
      ),
    );
    tenantA = a.id;
    tenantB = b.id;
    userId = (
      await owner.user.create({
        data: {
          email: EMAIL,
          passwordHash: 'x',
          fullName: 'Soporte',
          isPlatformAdmin: true,
          mfaTotpSecretEnc: 'v1.cifrado',
          mfaEnabledAt: new Date(),
        },
      })
    ).id;
    await breakGlass.recordAccess(access(tenantA, userId));
    await breakGlass.recordAccess(access(tenantB, userId));
  });

  afterAll(async () => {
    await purge();
    await prisma.onModuleDestroy();
    await owner.$disconnect();
  });

  it('el repositorio inserta bajo la RLS del tenant y cada clínica lee solo lo suyo', async () => {
    const seenByA = await tenantContext.run(tenantA, () =>
      supportAccesses.list(10, null),
    );
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]).toMatchObject({ reason: REASON, userEmail: EMAIL });
    const rawCount = await prisma.runWithTenant(tenantA, (tx) =>
      tx.platformAccessAudit.count(),
    );
    expect(rawCount).toBe(1);
  });

  it('WITH CHECK: la app no puede escribir una fila de otra clínica', async () => {
    await expect(
      prisma.runWithTenant(tenantA, (tx) =>
        tx.platformAccessAudit.create({ data: access(tenantB, userId) }),
      ),
    ).rejects.toThrow();
  });

  it.each([
    [
      'UPDATE',
      `UPDATE platform_access_audit SET reason = 'otro motivo cualquiera'`,
    ],
    ['DELETE', 'DELETE FROM platform_access_audit'],
    ['TRUNCATE', 'TRUNCATE platform_access_audit'],
  ])('append-only: la app no puede hacer %s', async (_op, sql) => {
    const err = await asApp(tenantA, sql);
    expect(err).not.toBeNull();
    expect(String(err)).toMatch(/permission denied|append-only|42501/i);
    expect(
      await owner.platformAccessAudit.count({ where: { tenantId: tenantA } }),
    ).toBe(1);
  });

  it('el trigger frena el UPDATE incluso al owner', async () => {
    await expect(
      owner.$executeRawUnsafe(
        `UPDATE platform_access_audit SET reason = 'reescrito por el owner' WHERE "tenantId" = '${tenantA}'`,
      ),
    ).rejects.toThrow(/append-only/);
  });

  it.each([
    ['motivo de menos de 10 caracteres', { reason: 'corto' }],
    ['caducidad de más de 60 min', { minutes: 61 }],
    ['caducidad anterior al acceso', { minutes: -1 }],
  ])('CHECK: rechaza %s', async (_label, opts) => {
    const row = access(tenantA, userId, 'minutes' in opts ? opts.minutes : 30);
    if ('reason' in opts) row.reason = opts.reason;
    await expect(breakGlass.recordAccess(row)).rejects.toThrow();
  });

  it('anti-replay atómico: de dos consumos concurrentes del mismo paso solo gana uno', async () => {
    const step = 60_000_000;
    const results = await Promise.all([
      breakGlass.consumeTotpStep(userId, step),
      breakGlass.consumeTotpStep(userId, step),
      breakGlass.consumeTotpStep(userId, step),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await breakGlass.consumeTotpStep(userId, step - 1)).toBe(false);
    expect(await breakGlass.consumeTotpStep(userId, step + 1)).toBe(true);
  });

  it('el secreto confirmado exige fecha de alta (CHECK users_mfa_enabled_check)', async () => {
    await expect(
      owner.user.update({
        where: { id: userId },
        data: { mfaEnabledAt: null },
      }),
    ).rejects.toThrow();
  });
});
