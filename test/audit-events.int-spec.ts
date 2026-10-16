import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaAuditEventRepository } from '../src/modules/audit/infrastructure/prisma-audit-event.repository';
import type { AuditEventDraft } from '../src/modules/audit/domain/audit-event';

// DX-009, capa de BD: append-only (triggers), RLS forzada y el repositorio
// (resolución del paciente bajo RLS y paginación por cursor) contra Postgres.

// Owner/superusuario (DIRECT_URL): fixtures y limpieza.
const owner = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
// Rol de la app (DATABASE_URL) sujeto a RLS, como la API.
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaAuditEventRepository(prisma);

const SUBDOMAINS = ['audit-db-a', 'audit-db-b'];
const EMAILS = ['audit-db-a@x.com', 'audit-db-b@x.com'];

async function purge(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  // Solo el superusuario puede borrar (trigger); la app nunca.
  await owner.auditEvent.deleteMany({ where: { tenantId: { in: ids } } });
  await owner.treatmentPlan.deleteMany({ where: { tenantId: { in: ids } } });
  await owner.clinicMembership.deleteMany({ where: { tenantId: { in: ids } } });
  await owner.patient.deleteMany({ where: { tenantId: { in: ids } } });
  await owner.tenant.deleteMany({ where: { id: { in: ids } } });
  await owner.user.deleteMany({ where: { email: { in: EMAILS } } });
}

function draft(
  tenantId: string,
  overrides: Partial<AuditEventDraft> = {},
): AuditEventDraft {
  return {
    tenantId,
    locationId: null,
    actor: { kind: 'user', userId: randomUUID(), role: 'ADMIN' },
    action: 'VIEW',
    resourceType: 'PATIENT',
    resourceId: null,
    patient: null,
    requestId: 'req-int-0001',
    ip: '10.0.0.1',
    userAgent: 'jest',
    metadata: {},
    ...overrides,
  };
}

describe('DX-009 · audit_events en la BD (int)', () => {
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let patientA: string;
  let patientB: string;
  let planA: string;
  let eventA: string;

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
    userA = (
      await owner.user.create({
        data: { email: EMAILS[0], passwordHash: 'x', fullName: 'Ana Admin' },
      })
    ).id;
    await owner.clinicMembership.create({
      data: { tenantId: tenantA, userId: userA, role: 'ADMIN' },
    });
    patientA = (
      await owner.patient.create({
        data: { tenantId: tenantA, firstName: 'Paula', lastName: 'Pérez' },
      })
    ).id;
    patientB = (
      await owner.patient.create({
        data: { tenantId: tenantB, firstName: 'Beto', lastName: 'B' },
      })
    ).id;
    planA = (
      await owner.treatmentPlan.create({
        data: {
          tenantId: tenantA,
          patientId: patientA,
          currency: 'COP',
          createdById: userA,
        },
      })
    ).id;
    eventA = (
      await owner.auditEvent.create({
        data: {
          tenantId: tenantA,
          actorUserId: userA,
          actorRole: 'ADMIN',
          action: 'VIEW',
          resourceType: 'PATIENT',
          patientId: patientA,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await purge();
    await prisma.onModuleDestroy();
    await owner.$disconnect();
  });

  describe('append-only (triggers)', () => {
    it('un evento no se puede modificar, ni siquiera como owner', async () => {
      await expect(
        owner.auditEvent.update({
          where: { id: eventA },
          data: { action: 'UPDATE' },
        }),
      ).rejects.toThrow(/append-only/);
    });

    it('el rol de la app no puede ni modificar ni borrar ni vaciar la tabla', async () => {
      // SQL crudo: `guardHardDeletes` ya frena `.delete()` dentro de
      // runWithTenant; aquí se prueba la barrera de la propia BD.
      await expect(
        prisma.runWithTenant(
          tenantA,
          (tx) =>
            tx.$executeRaw`UPDATE "audit_events" SET "ip" = '0.0.0.0' WHERE "id" = ${eventA}::uuid`,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.runWithTenant(
          tenantA,
          (tx) =>
            tx.$executeRaw`DELETE FROM "audit_events" WHERE "id" = ${eventA}::uuid`,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.runWithTenant(
          tenantA,
          (tx) => tx.$executeRaw`TRUNCATE "audit_events"`,
        ),
      ).rejects.toThrow(/append-only|permission denied/);
      expect(await owner.auditEvent.count({ where: { id: eventA } })).toBe(1);
    });

    it('la metadata es siempre un objeto y solo un login fallido va sin actor', async () => {
      await expect(
        prisma.runWithTenant(
          tenantA,
          (tx) =>
            tx.$executeRaw`INSERT INTO "audit_events" ("id","tenantId","actorUserId","action","resourceType","metadata")
              VALUES (gen_random_uuid(), ${tenantA}::uuid, ${userA}::uuid, 'VIEW', 'PATIENT', '"texto"'::jsonb)`,
        ),
      ).rejects.toThrow(/audit_events_metadata_object_check/);
      await expect(
        prisma.runWithTenant(
          tenantA,
          (tx) =>
            tx.$executeRaw`INSERT INTO "audit_events" ("id","tenantId","action","resourceType")
              VALUES (gen_random_uuid(), ${tenantA}::uuid, 'VIEW', 'PATIENT')`,
        ),
      ).rejects.toThrow(/audit_events_actor_check/);
    });
  });

  describe('RLS forzada por tenant', () => {
    it('la clínica B no ve los eventos de A, y sin tenant no se ve ninguno', async () => {
      expect(
        await prisma.runWithTenant(tenantB, (tx) => tx.auditEvent.count()),
      ).toBe(0);
      expect(
        await prisma.runWithTenant(tenantA, (tx) =>
          tx.auditEvent.count({ where: { id: eventA } }),
        ),
      ).toBe(1);
      // Conexión nueva del rol de la app, sin `app.current_tenant`: 0 filas.
      const fresh = new PrismaClient();
      try {
        expect(await fresh.auditEvent.count({ where: { id: eventA } })).toBe(0);
      } finally {
        await fresh.$disconnect();
      }
    });

    it('B no puede escribir un evento a nombre de A (WITH CHECK)', async () => {
      await expect(
        prisma.runWithTenant(tenantB, (tx) =>
          tx.auditEvent.create({
            data: {
              tenantId: tenantA,
              actorUserId: userA,
              action: 'VIEW',
              resourceType: 'PATIENT',
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('PrismaAuditEventRepository', () => {
    it('resuelve el paciente bajo RLS: el de otra clínica se guarda como NULL', async () => {
      const requestId = `req-${randomUUID()}`;
      await repo.insert(
        draft(tenantA, {
          requestId,
          resourceType: 'TREATMENT_PLAN',
          resourceId: planA,
          patient: { kind: 'treatmentPlan', id: planA },
        }),
      );
      await repo.insert(
        draft(tenantA, {
          requestId: `${requestId}-b`,
          patient: { kind: 'patient', id: patientB },
        }),
      );
      const rows = await owner.auditEvent.findMany({
        where: { requestId: { in: [requestId, `${requestId}-b`] } },
        orderBy: { requestId: 'asc' },
      });
      expect(rows.map((r) => r.patientId)).toEqual([patientA, null]);
      expect(rows.every((r) => r.tenantId === tenantA)).toBe(true);
    });

    it('un login fallido con el email de un miembro guarda su id; uno ajeno, ninguno', async () => {
      await repo.insert(
        draft(tenantA, {
          requestId: 'req-login-member',
          action: 'LOGIN_FAILED',
          resourceType: 'SESSION',
          actor: { kind: 'email', email: EMAILS[0].toUpperCase() },
        }),
      );
      // Un email que existe pero NO es miembro de esta clínica: sin actor.
      await owner.user.create({
        data: { email: EMAILS[1], passwordHash: 'x', fullName: 'Otro' },
      });
      await repo.insert(
        draft(tenantA, {
          requestId: 'req-login-stranger',
          action: 'LOGIN_FAILED',
          resourceType: 'SESSION',
          actor: { kind: 'email', email: EMAILS[1] },
        }),
      );
      const rows = await owner.auditEvent.findMany({
        where: {
          tenantId: tenantA,
          requestId: { in: ['req-login-member', 'req-login-stranger'] },
        },
        orderBy: { requestId: 'asc' },
      });
      expect(
        rows.map((r) => [r.requestId, r.actorUserId, r.actorRole]),
      ).toEqual([
        ['req-login-member', userA, null],
        ['req-login-stranger', null, null],
      ]);
    });

    it('lista más reciente primero, por cursor sin saltos ni repetidos, y con nombres', async () => {
      const at = new Date('2026-01-10T12:00:00.000Z');
      // Tres eventos en el MISMO milisegundo: el desempate por id es lo que
      // evita repetir o saltarse filas entre páginas.
      const ids = await owner.$transaction(
        [0, 1, 2, 3].map((i) =>
          owner.auditEvent.create({
            data: {
              tenantId: tenantA,
              actorUserId: userA,
              actorRole: 'ADMIN',
              action: 'VIEW',
              resourceType: 'PATIENT',
              patientId: patientA,
              occurredAt: i === 3 ? new Date(at.getTime() - 1000) : at,
            },
            select: { id: true },
          }),
        ),
      );
      const filter = {
        patientId: patientA,
        from: new Date('2026-01-10T00:00:00.000Z'),
        to: new Date('2026-01-11T00:00:00.000Z'),
      };
      const first = await repo.list(tenantA, filter, null, 2);
      expect(first).toHaveLength(2);
      const last = first[1];
      const second = await repo.list(
        tenantA,
        filter,
        { occurredAt: last.occurredAt, id: last.id },
        10,
      );
      const seen = [...first, ...second].map((e) => e.id);
      expect(new Set(seen).size).toBe(4);
      expect(seen.sort()).toEqual(ids.map((r) => r.id).sort());
      // El de un segundo antes va el último.
      expect(second[second.length - 1].id).toBe(ids[3].id);
      expect(first[0]).toMatchObject({
        actor: { id: userA, fullName: 'Ana Admin', role: 'ADMIN' },
        patient: { id: patientA, fullName: 'Paula Pérez' },
        timeZone: 'America/Bogota',
      });
      // B, con los mismos filtros, no ve nada.
      expect(await repo.list(tenantB, filter, null, 10)).toEqual([]);
    });
  });
});
