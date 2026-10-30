import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaInvitationRepository } from '../src/modules/invitations/infrastructure/repositories/prisma-invitation.repository';
import { AccountClaimBlockedError } from '../src/modules/invitations/domain/ports/invitation-repository.port';

/**
 * DX-143 (SEC-033): el reclamo de una cuenta sin verificar al aceptar una
 * invitación no alcanza a una cuenta con acceso a otra clínica.
 *
 * `clinic_memberships` tiene RLS FORCE por clínica, así que la pregunta
 * «¿tiene membresías activas en OTRA clínica?» la responde
 * `dx_user_has_other_active_memberships`, SECURITY DEFINER de un rol NOLOGIN
 * con su propia política (mismo andamiaje que DX-043 y DX-113). Aquí: su
 * configuración en el catálogo, su comportamiento como dentalix_app, la
 * comprobación dentro de `acceptTransactional` y el backfill de
 * `emailVerifiedAt` (20261017231100_dx143_verify_active_accounts).
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const FN = 'dx_user_has_other_active_memberships';
const ROLE = 'dentalix_membership_lookup';
const SUBDOMAINS = ['dx143-int-a', 'dx143-int-b'];
const EMAIL_DOMAIN = '@dx143-int.test';

const VERIFY_MIGRATION = readFileSync(
  join(
    __dirname,
    '../prisma/migrations/20261017231100_dx143_verify_active_accounts/migration.sql',
  ),
  'utf8',
);

/** Las sentencias de la migración, sin comentarios, en orden. */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

class Rollback extends Error {}

describe('DX-143 · reclamo de cuenta y membresías en otras clínicas (int)', () => {
  const tenantContext = new TenantContextService();
  const prisma = new PrismaService(tenantContext);
  const repo = new PrismaInvitationRepository(prisma, tenantContext);
  let tenantA: string;
  let tenantB: string;

  async function cleanup(): Promise<void> {
    const where = { email: { endsWith: EMAIL_DOMAIN } };
    await raw.clinicInvitation.deleteMany({ where });
    await raw.clinicMembership.deleteMany({ where: { user: where } });
    await raw.userToken.deleteMany({ where: { user: where } });
    await raw.user.deleteMany({ where });
    await raw.tenant.deleteMany({ where: { subdomain: { in: SUBDOMAINS } } });
  }

  async function newUser(
    name: string,
    data: { emailVerifiedAt?: Date | null; isPlatformAdmin?: boolean } = {},
  ): Promise<string> {
    const user = await raw.user.create({
      data: {
        email: `${name}${EMAIL_DOMAIN}`,
        passwordHash: 'ORIGINAL_HASH',
        fullName: name,
        tokenVersion: 3,
        emailVerifiedAt: data.emailVerifiedAt ?? null,
        isPlatformAdmin: data.isPlatformAdmin ?? false,
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

  describe('catálogo', () => {
    it('la función es SECURITY DEFINER de un rol NOLOGIN sin BYPASSRLS ni superusuario, con search_path fijo', async () => {
      const rows = await raw.$queryRaw<
        {
          secdef: boolean;
          config: string[] | null;
          owner: string;
          login: boolean;
          bypass: boolean;
          super: boolean;
          result: string;
          args: string;
        }[]
      >`
        SELECT p.prosecdef AS secdef, p.proconfig AS config,
               r.rolname AS owner, r.rolcanlogin AS login,
               r.rolbypassrls AS bypass, r.rolsuper AS super,
               pg_get_function_result(p.oid) AS result,
               pg_get_function_identity_arguments(p.oid) AS args
          FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.proname = ${FN}`;
      expect(rows).toEqual([
        {
          secdef: true,
          config: ['search_path=pg_catalog, public, pg_temp'],
          owner: ROLE,
          login: false,
          bypass: false,
          super: false,
          result: 'boolean',
          args: 'p_user_id uuid, p_tenant_id uuid',
        },
      ]);
    });

    it('EXECUTE solo para dentalix_app (y el dueño): PUBLIC no puede', async () => {
      const grants = await raw.$queryRaw<{ grantee: string }[]>`
        SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee
          FROM pg_proc p, aclexplode(p.proacl) a
         WHERE p.proname = ${FN} AND a.privilege_type = 'EXECUTE'
         ORDER BY 1`;
      expect(grants.map((g) => g.grantee)).toEqual(['dentalix_app', ROLE]);
    });

    it('la política extra de clinic_memberships es solo FOR SELECT y solo para el rol', async () => {
      const policies = await raw.$queryRaw<
        { policy: string; cmd: string; roles: string[]; qual: string }[]
      >`
        SELECT policyname AS policy, cmd, roles::text[] AS roles, qual
          FROM pg_policies WHERE tablename = 'clinic_memberships'
         ORDER BY policyname`;
      expect(policies).toEqual([
        {
          policy: 'membership_lookup_definer',
          cmd: 'SELECT',
          roles: [ROLE],
          qual: 'true',
        },
        expect.objectContaining({
          policy: 'tenant_isolation',
          cmd: 'ALL',
          roles: ['public'],
        }),
      ]);
    });

    it('el rol solo lee tres columnas de clinic_memberships y nada más de public', async () => {
      const tables = await raw.$queryRaw<
        { table: string; privilege: string }[]
      >`
        SELECT table_name AS table, privilege_type AS privilege
          FROM information_schema.role_table_grants
         WHERE grantee = ${ROLE} AND table_schema = 'public'`;
      expect(tables).toEqual([]);
      const columns = await raw.$queryRaw<
        { column: string; privilege: string }[]
      >`
        SELECT column_name AS column, privilege_type AS privilege
          FROM information_schema.role_column_grants
         WHERE grantee = ${ROLE} AND table_schema = 'public'
         ORDER BY 1`;
      expect(columns).toEqual([
        { column: 'deletedAt', privilege: 'SELECT' },
        { column: 'tenantId', privilege: 'SELECT' },
        { column: 'userId', privilege: 'SELECT' },
      ]);
    });

    it('nadie puede actuar como el rol (SET) ni heredar sus permisos (INHERIT), y no pertenece a otros roles', async () => {
      const [row] = await raw.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_auth_members m
         WHERE (m.roleid = to_regrole(${ROLE}) AND (m.set_option OR m.inherit_option))
            OR m.member = to_regrole(${ROLE})`;
      expect(row.n).toBe(0);
    });
  });

  describe('como dentalix_app', () => {
    it('cuenta solo las membresías ACTIVAS de OTRAS clínicas', async () => {
      const onlyA = await newUser('solo-a');
      await member(onlyA, tenantA);
      const deletedInB = await newUser('borrada-b');
      await member(deletedInB, tenantA);
      await member(deletedInB, tenantB, new Date());
      const none = await newUser('sin-clinicas');

      const ask = (tenantId: string, userId: string): Promise<boolean> =>
        tenantContext.run(tenantId, () =>
          repo.hasOtherActiveMemberships(userId),
        );
      expect(await ask(tenantB, onlyA)).toBe(true);
      expect(await ask(tenantA, onlyA)).toBe(false);
      expect(await ask(tenantA, deletedInB)).toBe(false);
      expect(await ask(tenantB, deletedInB)).toBe(true);
      expect(await ask(tenantA, none)).toBe(false);
    });

    it('la RLS de clinic_memberships sigue igual para la app: desde B no ve la membresía de A', async () => {
      const userId = await newUser('rls-sigue');
      await member(userId, tenantA);
      const seen = await tenantContext.run(tenantB, () =>
        prisma.runWithTenant((tx) =>
          tx.clinicMembership.count({ where: { userId } }),
        ),
      );
      expect(seen).toBe(0);
    });
  });

  describe('acceptTransactional (claim)', () => {
    async function invitation(
      email: string,
      tenantId: string,
    ): Promise<string> {
      const inv = await raw.clinicInvitation.create({
        data: {
          tenantId,
          email,
          fullName: 'Invitada',
          role: ClinicRole.ASSISTANT,
          tokenHash: randomBytes(32).toString('hex'),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        select: { id: true },
      });
      return inv.id;
    }

    async function claimIn(tenantId: string, userId: string, email: string) {
      const invitationId = await invitation(email, tenantId);
      const run = tenantContext.run(tenantId, () =>
        repo.acceptTransactional({
          invitationId,
          email,
          role: ClinicRole.ASSISTANT,
          user: { claim: { userId, passwordHash: 'NEW_HASH' } },
          request: null,
        }),
      );
      return { invitationId, run };
    }

    async function expectUntouched(userId: string, invitationId: string) {
      const user = await raw.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          passwordHash: true,
          tokenVersion: true,
          emailVerifiedAt: true,
        },
      });
      expect(user).toEqual({
        passwordHash: 'ORIGINAL_HASH',
        tokenVersion: 3,
        emailVerifiedAt: null,
      });
      const inv = await raw.clinicInvitation.findUniqueOrThrow({
        where: { id: invitationId },
        select: { acceptedAt: true },
      });
      expect(inv.acceptedAt).toBeNull();
      expect(
        await raw.clinicMembership.count({
          where: { userId, tenantId: tenantB },
        }),
      ).toBe(0);
    }

    it('con membresía activa en otra clínica: AccountClaimBlockedError y no cambia nada', async () => {
      const userId = await newUser('multi');
      await member(userId, tenantA);
      const { invitationId, run } = await claimIn(
        tenantB,
        userId,
        `multi${EMAIL_DOMAIN}`,
      );
      await expect(run).rejects.toBeInstanceOf(AccountClaimBlockedError);
      await expectUntouched(userId, invitationId);
    });

    it('administrador de plataforma sin verificar: AccountClaimBlockedError y no cambia nada', async () => {
      const userId = await newUser('plataforma', { isPlatformAdmin: true });
      const { invitationId, run } = await claimIn(
        tenantB,
        userId,
        `plataforma${EMAIL_DOMAIN}`,
      );
      await expect(run).rejects.toBeInstanceOf(AccountClaimBlockedError);
      await expectUntouched(userId, invitationId);
    });

    it('sin membresías en otras clínicas: la reclama (contraseña nueva, tokenVersion + 1, verificada)', async () => {
      const userId = await newUser('presecuestro');
      const { run } = await claimIn(
        tenantB,
        userId,
        `presecuestro${EMAIL_DOMAIN}`,
      );
      await expect(run).resolves.toMatchObject({ userId, tokenVersion: 4 });
      const user = await raw.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.passwordHash).toBe('NEW_HASH');
      expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    });
  });

  describe('migración 20261017231100_dx143_verify_active_accounts', () => {
    it('verifica a quien inició sesión o registró su clínica, deja al resto y es idempotente (en una transacción que se deshace)', async () => {
      const firstLogin = new Date(Date.now() - 3 * 86_400_000);
      const verifiedBefore = new Date('2026-01-01T00:00:00.000Z');
      const loggedIn = await newUser('con-login');
      const owner = await newUser('duena');
      const nothing = await newUser('nada');
      const already = await newUser('ya-verificada', {
        emailVerifiedAt: verifiedBefore,
      });
      const deleted = await newUser('borrada');
      // Revisión DX-143: sin ninguna membresía ACTIVA (en una clínica no
      // borrada) la cuenta no da acceso a nada; verificarla solo impediría
      // reclamarla a quien controla el buzón (y no puede restablecer: DX-010
      // exige membresía). Pasa con cuentas pre-secuestradas (SEC-007) cuya
      // clínica ya no existe o cuyo acceso se dio de baja.
      const loginOrphan = await newUser('login-sin-clinica');
      await member(loginOrphan, tenantA, new Date());
      const ownerGone = await newUser('duena-clinica-borrada');
      await member(loggedIn, tenantA);
      await raw.user.update({
        where: { id: deleted },
        data: { deletedAt: new Date() },
      });
      // Dueña creada por el registro anterior a DX-029: clínica, usuario y
      // membresía ADMIN a la vez.
      const ownerUser = await raw.user.findUniqueOrThrow({
        where: { id: owner },
      });
      const ownTenant = await raw.tenant.create({
        data: {
          name: 'Clínica de la dueña',
          subdomain: 'dx143-int-owner',
          createdAt: ownerUser.createdAt,
        },
      });
      SUBDOMAINS.push('dx143-int-owner');
      await raw.clinicMembership.create({
        data: {
          tenantId: ownTenant.id,
          userId: owner,
          role: ClinicRole.ADMIN,
          createdAt: ownerUser.createdAt,
        },
      });
      // Un ADMIN añadido mucho después de crear la clínica no es la dueña.
      const lateTenant = await raw.tenant.create({
        data: {
          name: 'Clínica antigua',
          subdomain: 'dx143-int-late',
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
        },
      });
      SUBDOMAINS.push('dx143-int-late');
      const ownerGoneUser = await raw.user.findUniqueOrThrow({
        where: { id: ownerGone },
      });
      const goneTenant = await raw.tenant.create({
        data: {
          name: 'Clínica borrada',
          subdomain: 'dx143-int-gone',
          createdAt: ownerGoneUser.createdAt,
          deletedAt: new Date(),
        },
      });
      SUBDOMAINS.push('dx143-int-gone');
      await raw.clinicMembership.create({
        data: {
          tenantId: goneTenant.id,
          userId: ownerGone,
          role: ClinicRole.ADMIN,
          createdAt: ownerGoneUser.createdAt,
        },
      });
      await raw.clinicMembership.create({
        data: {
          tenantId: lateTenant.id,
          userId: nothing,
          role: ClinicRole.ADMIN,
        },
      });

      const result = await raw
        .$transaction(async (tx) => {
          for (const [userId, at] of [
            [loggedIn, firstLogin],
            [loggedIn, new Date()],
            [already, firstLogin],
            [deleted, firstLogin],
            [loginOrphan, firstLogin],
          ] as const) {
            await tx.auditEvent.create({
              data: {
                tenantId: tenantA,
                actorUserId: userId,
                actorRole: ClinicRole.DENTIST,
                action: 'LOGIN',
                resourceType: 'SESSION',
                occurredAt: at,
              },
            });
          }
          // Un LOGIN_FAILED no cuenta.
          await tx.auditEvent.create({
            data: {
              tenantId: tenantA,
              actorUserId: nothing,
              actorRole: ClinicRole.DENTIST,
              action: 'LOGIN_FAILED',
              resourceType: 'SESSION',
            },
          });
          const updates: number[] = [];
          // Dos pasadas completas de la migración: la segunda no toca nada.
          for (let pass = 0; pass < 2; pass++) {
            for (const sql of statements(VERIFY_MIGRATION)) {
              const n = await tx.$executeRawUnsafe(sql);
              if (sql.startsWith('UPDATE')) updates.push(n);
            }
          }
          const users = await tx.user.findMany({
            where: {
              id: {
                in: [
                  loggedIn,
                  owner,
                  nothing,
                  already,
                  deleted,
                  loginOrphan,
                  ownerGone,
                ],
              },
            },
            select: { id: true, emailVerifiedAt: true },
          });
          const forced = await tx.$queryRaw<
            { table: string; forced: boolean }[]
          >`
            SELECT relname AS table, relforcerowsecurity AS forced
              FROM pg_class
             WHERE relname IN ('audit_events', 'clinic_memberships')
             ORDER BY 1`;
          throw new Rollback(
            JSON.stringify({
              updates,
              users: Object.fromEntries(
                users.map((u) => [
                  u.id,
                  u.emailVerifiedAt?.toISOString() ?? null,
                ]),
              ),
              forced,
            }),
          );
        })
        .catch((err: unknown) => {
          if (err instanceof Rollback) {
            return JSON.parse(err.message) as {
              updates: number[];
              users: Record<string, string | null>;
              forced: { table: string; forced: boolean }[];
            };
          }
          throw err;
        });

      // Segunda pasada: nada que hacer.
      expect(result.updates[1]).toBe(0);
      expect(result.updates[0]).toBeGreaterThanOrEqual(2);
      expect(result.users[loggedIn]).toBe(firstLogin.toISOString());
      expect(result.users[owner]).toBe(ownerUser.createdAt.toISOString());
      expect(result.users[nothing]).toBeNull();
      expect(result.users[already]).toBe(verifiedBefore.toISOString());
      expect(result.users[deleted]).toBeNull();
      expect(result.users[loginOrphan]).toBeNull();
      expect(result.users[ownerGone]).toBeNull();
      expect(result.forced).toEqual([
        { table: 'audit_events', forced: true },
        { table: 'clinic_memberships', forced: true },
      ]);
      // Y se deshizo: fuera de la transacción nadie quedó verificado.
      const after = await raw.user.findUniqueOrThrow({
        where: { id: loggedIn },
        select: { emailVerifiedAt: true },
      });
      expect(after.emailVerifiedAt).toBeNull();
    });
  });
});
