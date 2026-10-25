import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaStaffRepository } from '../src/modules/staff/infrastructure/repositories/prisma-staff.repository';

/**
 * DX-213 (SEC-038): antes de desbloquear el login de un miembro, el ADMIN de
 * la clínica A necesita saber si esa cuenta da acceso a OTRA clínica. Lo
 * contesta `PrismaStaffRepository.hasOtherActiveMemberships` con la función
 * SECURITY DEFINER de DX-143, como dentalix_app y bajo la RLS FORCE de
 * `clinic_memberships` (que, por sí sola, no deja ver las de otra clínica).
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUBDOMAINS = ['dx213-int-a', 'dx213-int-b'];
const EMAIL_DOMAIN = '@dx213-int.test';

describe('DX-213 · hasOtherActiveMemberships del personal (int, RLS FORCE)', () => {
  const tenantContext = new TenantContextService();
  const prisma = new PrismaService(tenantContext);
  const repo = new PrismaStaffRepository(prisma, tenantContext);
  let tenantA: string;
  let tenantB: string;

  async function cleanup(): Promise<void> {
    const where = { email: { endsWith: EMAIL_DOMAIN } };
    await raw.clinicMembership.deleteMany({ where: { user: where } });
    await raw.user.deleteMany({ where });
    await raw.tenant.deleteMany({ where: { subdomain: { in: SUBDOMAINS } } });
  }

  async function newUser(name: string): Promise<string> {
    const user = await raw.user.create({
      data: {
        email: `${name}${EMAIL_DOMAIN}`,
        passwordHash: 'x',
        fullName: name,
      },
      select: { id: true },
    });
    return user.id;
  }

  async function member(
    userId: string,
    tenantId: string,
    deletedAt: Date | null = null,
  ): Promise<void> {
    await raw.clinicMembership.create({
      data: { tenantId, userId, role: ClinicRole.DENTIST, deletedAt },
    });
  }

  const askFrom = (tenantId: string, userId: string): Promise<boolean> =>
    tenantContext.run(tenantId, () => repo.hasOtherActiveMemberships(userId));

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    [tenantA, tenantB] = await Promise.all(
      SUBDOMAINS.map(async (subdomain) => {
        const t = await raw.tenant.create({
          data: { name: `Clínica ${subdomain}`, subdomain },
          select: { id: true },
        });
        return t.id;
      }),
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await raw.$disconnect();
  });

  it('clinic_memberships sigue con RLS FORCE', async () => {
    const [row] = await raw.$queryRaw<{ enabled: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE relname = 'clinic_memberships'`;
    expect(row).toEqual({ enabled: true, forced: true });
  });

  it('membresía ACTIVA en otra clínica: true, aunque la RLS no deje verla desde A', async () => {
    const userId = await newUser('activa-en-b');
    await member(userId, tenantA);
    await member(userId, tenantB);

    expect(await askFrom(tenantA, userId)).toBe(true);
    expect(await askFrom(tenantB, userId)).toBe(true);
    // La app, bajo RLS, solo ve la membresía de su clínica.
    const seenFromA = await tenantContext.run(tenantA, () =>
      prisma.runWithTenant((tx) =>
        tx.clinicMembership.count({ where: { userId } }),
      ),
    );
    expect(seenFromA).toBe(1);
  });

  it('membresía BORRADA en otra clínica: false (ya no da acceso)', async () => {
    const userId = await newUser('borrada-en-b');
    await member(userId, tenantA);
    await member(userId, tenantB, new Date());
    expect(await askFrom(tenantA, userId)).toBe(false);
  });

  it('solo de la propia clínica: false (activa o desactivada aquí)', async () => {
    const onlyA = await newUser('solo-a');
    await member(onlyA, tenantA);
    expect(await askFrom(tenantA, onlyA)).toBe(false);

    const deactivatedInA = await newUser('desactivada-en-a');
    await member(deactivatedInA, tenantA, new Date());
    expect(await askFrom(tenantA, deactivatedInA)).toBe(false);
  });

  it('la membresía activa de A cuenta como «otra» vista desde B', async () => {
    const userId = await newUser('activa-en-a');
    await member(userId, tenantA);
    expect(await askFrom(tenantB, userId)).toBe(true);
  });

  it('sin tenant en contexto no pregunta (no hay «esta» clínica)', async () => {
    const userId = await newUser('sin-contexto');
    await member(userId, tenantA);
    await expect(repo.hasOtherActiveMemberships(userId)).rejects.toThrow(
      'No tenant in context',
    );
  });
});
