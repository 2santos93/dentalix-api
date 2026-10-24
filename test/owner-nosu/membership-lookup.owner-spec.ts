import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { TenantContextService } from '../../src/shared/tenancy/tenant-context.service';
import { PrismaInvitationRepository } from '../../src/modules/invitations/infrastructure/repositories/prisma-invitation.repository';
import { adminUrlFor, requireOwnerNosuEnv } from './owner-nosu-env';

// DX-143 (SEC-033): con un owner de las migraciones sin superusuario ni
// BYPASSRLS, `dx_user_has_other_active_memberships` sigue viendo las
// membresías de TODAS las clínicas: es SECURITY DEFINER de un rol NOLOGIN
// con su propia política de SELECT, no del owner. Si dependiera del owner,
// devolvería false en silencio y el reclamo de una cuenta con otra clínica
// volvería a ser posible.
//
// Corre como la app (DATABASE_URL) sobre la base migrada por el owner de
// DIRECT_URL; las filas las carga el admin del clúster (saltando la RLS).

describe('DX-143 · membresías en otras clínicas con un owner sin superusuario (owner-nosu)', () => {
  const env = requireOwnerNosuEnv();
  const db = new URL(env.ownerUrl).pathname.slice(1);
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: adminUrlFor(env, db) } },
  });
  const tenantContext = new TenantContextService();
  const prisma = new PrismaService(tenantContext);
  const repo = new PrismaInvitationRepository(prisma, tenantContext);
  const stamp = `${process.pid}-${Date.now()}`;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const userId = randomUUID();

  beforeAll(async () => {
    await prisma.onModuleInit();
    await admin.$executeRawUnsafe(
      `INSERT INTO "tenants" ("id","name","subdomain","updatedAt") VALUES
         ($1::uuid,'DX-143 A',$3,now()), ($2::uuid,'DX-143 B',$4,now())`,
      tenantA,
      tenantB,
      `dx143-a-${stamp}`,
      `dx143-b-${stamp}`,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "users" ("id","email","passwordHash","fullName","updatedAt")
       VALUES ($1::uuid,$2,'x','DX-143',now())`,
      userId,
      `dx143-${stamp}@owner-nosu.test`,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO "clinic_memberships" ("id","tenantId","userId","role","updatedAt")
       VALUES (gen_random_uuid(),$1::uuid,$2::uuid,'DENTIST',now())`,
      tenantA,
      userId,
    );
  });

  afterAll(async () => {
    await admin.$executeRawUnsafe(
      `DELETE FROM "clinic_memberships" WHERE "userId" = $1::uuid`,
      userId,
    );
    await admin.$executeRawUnsafe(
      `DELETE FROM "users" WHERE "id" = $1::uuid`,
      userId,
    );
    await admin.$executeRawUnsafe(
      `DELETE FROM "tenants" WHERE "id" IN ($1::uuid, $2::uuid)`,
      tenantA,
      tenantB,
    );
    await prisma.$disconnect();
    await admin.$disconnect();
  });

  it('el owner de la migración no es superusuario ni salta la RLS', async () => {
    const [role] = await admin.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${env.owner}`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('desde la clínica B ve la membresía activa en A; desde A, no hay otras', async () => {
    expect(
      await tenantContext.run(tenantB, () =>
        repo.hasOtherActiveMemberships(userId),
      ),
    ).toBe(true);
    expect(
      await tenantContext.run(tenantA, () =>
        repo.hasOtherActiveMemberships(userId),
      ),
    ).toBe(false);
  });

  it('la función es del rol NOLOGIN, no del owner', async () => {
    const [row] = await admin.$queryRaw<{ owner: string }[]>`
      SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc
       WHERE proname = 'dx_user_has_other_active_memberships'`;
    expect(row.owner).toBe('dentalix_membership_lookup');
  });
});
