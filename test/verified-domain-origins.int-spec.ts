import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  VERIFIED_DOMAIN_CACHE_MAX,
  VERIFIED_DOMAIN_TTL_MS,
  VerifiedDomainOrigins,
} from '../src/shared/security/verified-domain-origins';
import {
  isAllowedOrigin,
  loadSecuritySettings,
} from '../src/shared/security/security-settings';

// SEC-021, capa de BD: la caché de dominios propios que consultan CORS y el
// refresh por cookie, con PrismaService real (rol dentalix_app; tenant_domains
// no tiene RLS) y un reloj simulado para el TTL.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const prisma = new PrismaService(new TenantContextService());

const SUBDOMAINS = ['sec021-int-a', 'sec021-int-b'];
const VERIFIED = 'citas.sec021-verified.com';
const PENDING = 'citas.sec021-pending.com';
const DISABLED = 'citas.sec021-disabled.com';
const DELETED = 'citas.sec021-deleted.com';
const ORPHAN = 'citas.sec021-orphan.com'; // VERIFIED de una clínica borrada

const prod = loadSecuritySettings((k) =>
  k === 'NODE_ENV'
    ? 'production'
    : k === 'CORS_ROOT_DOMAIN'
      ? 'dentalix.app'
      : k === 'CORS_ORIGINS'
        ? 'https://dentalix.app'
        : undefined,
);

let A: string;
let B: string;
let now = 0;
let origins: VerifiedDomainOrigins;

async function cleanup(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  await owner.tenantDomain.deleteMany({ where: { tenantId: { in: ids } } });
  await owner.tenant.deleteMany({ where: { id: { in: ids } } });
}

const seed = (
  tenantId: string,
  host: string,
  status: 'PENDING' | 'VERIFIED' | 'DISABLED',
  extra: Partial<Prisma.TenantDomainUncheckedCreateInput> = {},
) =>
  owner.tenantDomain.create({
    data: {
      tenantId,
      host,
      status,
      verifyToken: `tok-${host}`,
      verifiedAt: status === 'PENDING' ? null : new Date(),
      expiresAt: status === 'PENDING' ? new Date(Date.now() + 3600_000) : null,
      ...extra,
    },
  });

describe('SEC-021 · orígenes de dominios propios (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    A = (
      await owner.tenant.create({
        data: { name: 'Clínica Origen', subdomain: SUBDOMAINS[0] },
      })
    ).id;
    B = (
      await owner.tenant.create({
        data: {
          name: 'Clínica Borrada',
          subdomain: SUBDOMAINS[1],
          deletedAt: new Date(),
        },
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
    now = 1_000_000;
    origins = new VerifiedDomainOrigins(prisma, () => now);
  });

  it('solo un VERIFIED vivo de una clínica viva cuenta como dominio propio', async () => {
    await seed(A, VERIFIED, 'VERIFIED');
    await seed(A, PENDING, 'PENDING');
    await seed(A, DISABLED, 'DISABLED');
    await seed(A, DELETED, 'VERIFIED', { deletedAt: new Date() });
    await seed(B, ORPHAN, 'VERIFIED');

    expect(await origins.isVerified(VERIFIED)).toBe(true);
    expect(await origins.isVerified(VERIFIED.toUpperCase())).toBe(true);
    for (const host of [PENDING, DISABLED, DELETED, ORPHAN, 'nadie.com']) {
      expect(await origins.isVerified(host)).toBe(false);
    }
  });

  it('isAllowedOrigin en producción: VERIFIED con https → sí; PENDING → no', async () => {
    await seed(A, VERIFIED, 'VERIFIED');
    await seed(A, PENDING, 'PENDING');

    await expect(
      isAllowedOrigin(`https://${VERIFIED}`, prod, origins),
    ).resolves.toBe(true);
    await expect(
      isAllowedOrigin(`http://${VERIFIED}`, prod, origins),
    ).resolves.toBe(false);
    await expect(
      isAllowedOrigin(`https://${PENDING}`, prod, origins),
    ).resolves.toBe(false);
  });

  it('cachea la respuesta positiva durante el TTL y la relee al caducar', async () => {
    const row = await seed(A, VERIFIED, 'VERIFIED');
    expect(await origins.isVerified(VERIFIED)).toBe(true);

    // Otro proceso (la re-verificación del worker) lo desactiva.
    await owner.tenantDomain.update({
      where: { id: row.id },
      data: { status: 'DISABLED' },
    });
    now += VERIFIED_DOMAIN_TTL_MS - 1;
    expect(await origins.isVerified(VERIFIED)).toBe(true); // aún en caché
    now += 1;
    expect(await origins.isVerified(VERIFIED)).toBe(false); // caducó: relee
  });

  it('cachea también la negativa; invalidar el host la descarta al momento', async () => {
    expect(await origins.isVerified(PENDING)).toBe(false);
    await seed(A, PENDING, 'VERIFIED');
    expect(await origins.isVerified(PENDING)).toBe(false); // negativa cacheada

    origins.invalidate(PENDING.toUpperCase());
    expect(await origins.isVerified(PENDING)).toBe(true);
  });

  it('invalidate() sin host vacía toda la caché (eliminar un dominio)', async () => {
    const row = await seed(A, VERIFIED, 'VERIFIED');
    expect(await origins.isVerified(VERIFIED)).toBe(true);
    await owner.tenantDomain.update({
      where: { id: row.id },
      data: { deletedAt: new Date() },
    });
    origins.invalidate();
    expect(await origins.isVerified(VERIFIED)).toBe(false);
  });

  it(`la caché no pasa de ${VERIFIED_DOMAIN_CACHE_MAX} hosts: descarta el más antiguo`, async () => {
    await seed(A, VERIFIED, 'VERIFIED');
    expect(await origins.isVerified(VERIFIED)).toBe(true); // el más antiguo
    const internal = origins as unknown as { cache: Map<string, unknown> };
    // Llena el resto sin pasar por la BD (los Origin basura de un atacante).
    for (let i = 1; i < VERIFIED_DOMAIN_CACHE_MAX; i += 1) {
      internal.cache.set(`relleno-${i}.com`, {
        verified: false,
        expiresAt: Number.MAX_SAFE_INTEGER,
      });
    }
    expect(internal.cache.size).toBe(VERIFIED_DOMAIN_CACHE_MAX);
    expect(await origins.isVerified('uno-mas.com')).toBe(false);
    expect(internal.cache.size).toBe(VERIFIED_DOMAIN_CACHE_MAX);
    expect(internal.cache.has(VERIFIED)).toBe(false);
  });
});
