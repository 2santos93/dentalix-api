import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaOrthoRepository } from '../src/modules/orthodontics/infrastructure/prisma-ortho.repository';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenants, purgeTenantsBySubdomain } from './support/tenant-purge';

// DX-190, capa DB de ortho_cases / ortho_visits: RLS FORCE, FK compuestas por
// clínica y paciente, un caso ACTIVE por paciente (único parcial), control
// inalterable, caso cerrado inmóvil, la lista de seguimiento por SQL con el
// día civil de Caracas y la fusión de pacientes (DX-266). Se escribe como la
// app (runWithTenant, dentalix_app); `raw` (DIRECT_URL, owner) siembra y
// limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaOrthoRepository(prisma, tenantContext);

// Reloj fijo: lunes 16-11-2026 a las 23:30 de Caracas (03:30 UTC del 17):
// en UTC ya es otro día; en la sede, no.
const NOW = new Date('2026-11-17T03:30:00.000Z');

const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

interface Clinic {
  tenantId: string;
  locationId: string;
  userId: string;
  patients: string[];
  planId: string;
}

async function seedClinic(subdomain: string, patients = 3): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Principal',
    }),
  });
  const user = await raw.user.create({
    data: {
      email: `dr@${subdomain}.test`,
      passwordHash: 'x',
      fullName: `Dra. ${subdomain}`,
    },
  });
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'DENTIST' },
  });
  const ids: string[] = [];
  for (let i = 0; i < patients; i++) {
    const p = await raw.patient.create({
      data: {
        tenantId: tenant.id,
        firstName: `Paciente${i}`,
        lastName: subdomain,
        phone: `+58412000000${i}`,
      },
    });
    ids.push(p.id);
  }
  const plan = await raw.treatmentPlan.create({
    data: { tenantId: tenant.id, patientId: ids[0], currency: 'USD' },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    userId: user.id,
    patients: ids,
    planId: plan.id,
  };
}

function caseData(
  c: Clinic,
  patientId: string,
  extra: Partial<Prisma.OrthoCaseUncheckedCreateInput> = {},
): Prisma.OrthoCaseUncheckedCreateInput {
  return {
    tenantId: c.tenantId,
    patientId,
    locationId: c.locationId,
    providerId: c.userId,
    createdById: c.userId,
    technique: 'METAL_BRACKETS',
    startDate: day('2026-06-01'),
    estimatedMonths: 24,
    plannedVisits: 24,
    ...extra,
  };
}

/** Una evolución + su control, en la MISMA transacción, como la app. */
async function visit(
  c: Clinic,
  patientId: string,
  caseId: string,
  visitDate: string,
): Promise<{ id: string; entryId: string }> {
  return prisma.runWithTenant(c.tenantId, async (tx) => {
    const entry = await tx.clinicalEntry.create({
      data: {
        tenantId: c.tenantId,
        patientId,
        locationId: c.locationId,
        entryDate: day(visitDate),
        notes: 'Control de ortodoncia.',
        performedById: c.userId,
      },
    });
    const v = await tx.orthoVisit.create({
      data: {
        tenantId: c.tenantId,
        patientId,
        caseId,
        clinicalEntryId: entry.id,
        visitDate: day(visitDate),
        upperWireMaterial: 'NITI',
        upperWireGauge: '0.016',
        hygieneIndex: 2,
        authorId: c.userId,
      },
    });
    return { id: v.id, entryId: entry.id };
  });
}

const asApp = <T>(
  c: Clinic,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) => prisma.runWithTenant(c.tenantId, fn);

describe('ortho_cases / ortho_visits (DX-190, int)', () => {
  let a: Clinic;
  let b: Clinic;
  let caseA: string;
  let visitA: { id: string; entryId: string };

  beforeAll(async () => {
    await prisma.onModuleInit();
    // Restos de una corrida cortada.
    await purgeTenantsBySubdomain(raw, ['ortho-int-a', 'ortho-int-b']);
    await raw.user.deleteMany({
      where: { email: { in: ['dr@ortho-int-a.test', 'dr@ortho-int-b.test'] } },
    });
    a = await seedClinic('ortho-int-a', 6);
    b = await seedClinic('ortho-int-b', 1);
    caseA = (
      await asApp(a, (tx) =>
        tx.orthoCase.create({
          data: caseData(a, a.patients[0], { treatmentPlanId: a.planId }),
        }),
      )
    ).id;
    visitA = await visit(a, a.patients[0], caseA, '2026-09-27');
  });

  afterAll(async () => {
    await purgeTenants(raw, [a.tenantId, b.tenantId]);
    await raw.user.deleteMany({ where: { id: { in: [a.userId, b.userId] } } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  describe('RLS FORCE', () => {
    it('las dos tablas tienen RLS activada y forzada', async () => {
      const rows = await raw.$queryRaw<
        { relname: string; on: boolean; forced: boolean }[]
      >`SELECT relname, relrowsecurity AS on, relforcerowsecurity AS forced
          FROM pg_class WHERE relname IN ('ortho_cases', 'ortho_visits') ORDER BY 1`;
      expect(rows).toEqual([
        { relname: 'ortho_cases', on: true, forced: true },
        { relname: 'ortho_visits', on: true, forced: true },
      ]);
    });

    it('B no ve el caso ni el control de A', async () => {
      await expect(
        asApp(b, (tx) => tx.orthoCase.findMany({ where: { id: caseA } })),
      ).resolves.toEqual([]);
      await expect(
        asApp(b, (tx) => tx.orthoVisit.findMany({ where: { id: visitA.id } })),
      ).resolves.toEqual([]);
    });

    it('B no inserta un caso con el tenant de A', async () => {
      await expect(
        asApp(b, (tx) =>
          tx.orthoCase.create({ data: caseData(a, a.patients[1]) }),
        ),
      ).rejects.toThrow(/row-level security|violates/);
    });
  });

  describe('FK compuestas', () => {
    it('el paciente, la sede y el plan de otra clínica u otro paciente se rechazan', async () => {
      await expect(
        raw.orthoCase.create({ data: caseData(a, b.patients[0]) }),
      ).rejects.toMatchObject({ code: 'P2003' });
      await expect(
        raw.orthoCase.create({
          data: caseData(a, a.patients[1], { locationId: b.locationId }),
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      // El plan es de A, pero de otro paciente.
      await expect(
        raw.orthoCase.create({
          data: caseData(a, a.patients[1], { treatmentPlanId: a.planId }),
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('el control con la evolución o el caso de otro paciente se rechaza', async () => {
      const other = await raw.clinicalEntry.create({
        data: {
          tenantId: a.tenantId,
          patientId: a.patients[1],
          locationId: a.locationId,
          entryDate: day('2026-10-01'),
          notes: 'Otra evolución',
          performedById: a.userId,
        },
      });
      const base = {
        tenantId: a.tenantId,
        visitDate: day('2026-10-01'),
        hygieneIndex: 1,
        authorId: a.userId,
      };
      await expect(
        raw.orthoVisit.create({
          data: {
            ...base,
            patientId: a.patients[0],
            caseId: caseA,
            clinicalEntryId: other.id,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      await expect(
        raw.orthoVisit.create({
          data: {
            ...base,
            patientId: a.patients[1],
            caseId: caseA,
            clinicalEntryId: other.id,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('la FK directa a tenants es RESTRICT', async () => {
      const rows = await raw.$queryRaw<{ conname: string; del: string }[]>`
        SELECT conname, confdeltype::text AS del FROM pg_constraint
         WHERE conname IN ('ortho_cases_tenantId_fkey', 'ortho_visits_tenantId_fkey')
         ORDER BY 1`;
      expect(rows).toEqual([
        { conname: 'ortho_cases_tenantId_fkey', del: 'r' },
        { conname: 'ortho_visits_tenantId_fkey', del: 'r' },
      ]);
    });
  });

  describe('un caso ACTIVE por paciente', () => {
    it('el segundo activo choca con el único parcial; uno en retención no', async () => {
      await expect(
        asApp(a, (tx) =>
          tx.orthoCase.create({ data: caseData(a, a.patients[0]) }),
        ),
      ).rejects.toThrow(/ortho_cases_one_active_key|Unique constraint/);
      const retention = await asApp(a, (tx) =>
        tx.orthoCase.create({
          data: caseData(a, a.patients[1], {
            status: 'RETENTION',
            statusChangedAt: new Date(),
            statusChangedById: a.userId,
          }),
        }),
      );
      await expect(
        asApp(a, (tx) =>
          tx.orthoCase.create({ data: caseData(a, a.patients[1]) }),
        ),
      ).resolves.toMatchObject({ status: 'ACTIVE' });
      expect(retention.status).toBe('RETENTION');
    });

    it('el repositorio traduce el choque en «ya hay uno activo» (null)', async () => {
      await expect(
        tenantContext.run(a.tenantId, () =>
          repo.createCase({
            patientId: a.patients[0],
            locationId: a.locationId,
            providerId: a.userId,
            treatmentPlanId: null,
            createdById: a.userId,
            technique: 'ALIGNERS',
            startDate: '2026-11-01',
            estimatedMonths: 12,
            plannedVisits: 12,
            visitIntervalDays: 30,
            bondedOn: null,
            debondedOn: null,
          }),
        ),
      ).resolves.toBeNull();
    });

    it('abandonar exige motivo (CHECK)', async () => {
      await expect(
        raw.orthoCase.create({
          data: caseData(a, a.patients[2], {
            status: 'ABANDONED',
            statusChangedAt: new Date(),
            statusChangedById: a.userId,
          }),
        }),
      ).rejects.toThrow(/ortho_cases_status_check/);
    });
  });

  describe('inalterabilidad', () => {
    it('la app no actualiza ni borra un control (sin privilegio)', async () => {
      await expect(
        asApp(a, (tx) =>
          tx.orthoVisit.update({
            where: { id: visitA.id },
            data: { hygieneIndex: 4 },
          }),
        ),
      ).rejects.toThrow(/permission denied|inalterable/);
      await expect(
        asApp(
          a,
          (tx) =>
            tx.$executeRaw`DELETE FROM "ortho_visits" WHERE "id" = ${visitA.id}::uuid`,
        ),
      ).rejects.toThrow(/permission denied|inalterable/);
    });

    it('ni el owner cambia un control: el trigger lo rechaza', async () => {
      await expect(
        raw.$executeRaw`UPDATE "ortho_visits" SET "hygieneIndex" = 4 WHERE "id" = ${visitA.id}::uuid`,
      ).rejects.toThrow(/ortho_visits es inalterable/);
    });

    it('la app no borra un caso; un caso cerrado no cambia (ni para el owner)', async () => {
      await expect(
        asApp(
          a,
          (tx) =>
            tx.$executeRaw`DELETE FROM "ortho_cases" WHERE "id" = ${caseA}::uuid`,
        ),
      ).rejects.toThrow(/permission denied|historia clínica/);
      const closed = await asApp(a, (tx) =>
        tx.orthoCase.create({
          data: caseData(a, a.patients[3], {
            status: 'FINISHED',
            statusChangedAt: new Date(),
            statusChangedById: a.userId,
          }),
        }),
      );
      await expect(
        raw.$executeRaw`UPDATE "ortho_cases" SET "plannedVisits" = 30 WHERE "id" = ${closed.id}::uuid`,
      ).rejects.toThrow(/caso de ortodoncia cerrado no se modifica/);
      await expect(
        asApp(a, (tx) =>
          tx.orthoCase.update({
            where: { id: caseA },
            data: { patientId: a.patients[4] },
          }),
        ),
      ).rejects.toThrow(/no cambian|violates|P2003|Foreign key/);
    });

    it('createdAt del control lo pone el servidor (UTC)', async () => {
      const [row] = await raw.$queryRaw<{ skew: number }[]>`
        SELECT abs(extract(epoch FROM (timezone('UTC', now()) - "createdAt")))::float AS skew
          FROM "ortho_visits" WHERE "id" = ${visitA.id}::uuid`;
      expect(row.skew).toBeLessThan(600);
    });
  });

  describe('lista de seguimiento (día civil de Caracas, una consulta)', () => {
    const list = (
      c: Clinic,
      filter: 'ALL' | 'OVERDUE' | 'NO_NEXT_APPOINTMENT',
    ) =>
      tenantContext.run(c.tenantId, () =>
        repo.followUp({ filter, page: 1, pageSize: 50, now: NOW }),
      );

    it('último control hace 50 días (intervalo 30): «Atrasado»; sin cita futura: «Sin próxima cita»', async () => {
      const { rows } = await list(a, 'ALL');
      const row = rows.find((r) => r.caseId === caseA);
      expect(row).toMatchObject({
        patientId: a.patients[0],
        lastVisitDate: '2026-09-27',
        daysSinceLastVisit: 50,
        overdue: true,
        noNextAppointment: true,
        visitsDone: 1,
        plannedVisits: 24,
        locationName: 'Sede Principal',
        providerName: 'Dra. ortho-int-a',
        noShowCount: 0,
      });
      expect((await list(a, 'OVERDUE')).rows.map((r) => r.caseId)).toContain(
        caseA,
      );
      // Solo casos ACTIVOS; nada de B.
      expect(rows.every((r) => r.patientId !== b.patients[0])).toBe(true);
    });

    it('al agendarle una cita sale de «Sin próxima cita»; los no-show desde el inicio cuentan', async () => {
      const start = new Date('2026-11-20T14:00:00.000Z');
      await raw.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          patientId: a.patients[0],
          providerId: a.userId,
          start,
          end: new Date(start.getTime() + 30 * 60_000),
        },
      });
      const missed = new Date('2026-10-20T14:00:00.000Z');
      await raw.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: a.locationId,
          patientId: a.patients[0],
          providerId: a.userId,
          start: missed,
          end: new Date(missed.getTime() + 30 * 60_000),
          status: 'NO_SHOW',
        },
      });
      const { rows } = await list(a, 'NO_NEXT_APPOINTMENT');
      expect(rows.map((r) => r.caseId)).not.toContain(caseA);
      const all = await list(a, 'ALL');
      expect(all.rows.find((r) => r.caseId === caseA)).toMatchObject({
        noNextAppointment: false,
        nextAppointmentAt: start,
        noShowCount: 1,
      });
    });

    it('justo en intervalo + 15 no está atrasado; el día lo decide Caracas, no UTC', async () => {
      const recent = await asApp(a, (tx) =>
        tx.orthoCase.create({ data: caseData(a, a.patients[5]) }),
      );
      // 16-11 − 45 días = 02-10: a las 23:30 de Caracas aún es día 16 (en UTC
      // ya sería 17 y daría 46 → atrasado).
      await visit(a, a.patients[5], recent.id, '2026-10-02');
      const row = (await list(a, 'ALL')).rows.find(
        (r) => r.caseId === recent.id,
      );
      expect(row).toMatchObject({ daysSinceLastVisit: 45, overdue: false });
    });

    it('el plan de la consulta no hace una ida y vuelta por caso: una sola sentencia', async () => {
      const spy = jest.spyOn(prisma, 'runWithTenant');
      await list(a, 'ALL');
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  describe('fusión de pacientes (DX-266)', () => {
    it('dos casos activos bloquean la fusión con su código', async () => {
      const [{ blockers }] = await asApp(
        a,
        (tx) =>
          tx.$queryRaw<{ blockers: string[] }[]>`
          SELECT dx_patient_merge_blockers(${a.patients[0]}::uuid, ${a.patients[1]}::uuid) AS blockers`,
      );
      expect(blockers).toContain('DX266_TWO_ACTIVE_ORTHO_CASES');
    });

    it('con un solo caso activo, el caso y sus controles pasan al conservado', async () => {
      // patients[3] (caso FINALIZADO) se absorbe en patients[4] (sin caso).
      const closed = await raw.orthoCase.findFirstOrThrow({
        where: { patientId: a.patients[3] },
      });
      const v = await raw.orthoVisit.count({ where: { caseId: closed.id } });
      await asApp(
        a,
        (tx) =>
          tx.$queryRaw`SELECT dx_merge_patients(${a.patients[3]}::uuid, ${a.patients[4]}::uuid, ${a.userId}::uuid)`,
      );
      const moved = await raw.orthoCase.findUniqueOrThrow({
        where: { id: closed.id },
      });
      expect(moved.patientId).toBe(a.patients[4]);
      expect(moved.status).toBe('FINISHED');
      expect(await raw.orthoVisit.count({ where: { caseId: closed.id } })).toBe(
        v,
      );
    });

    it('un caso activo con controles también se mueve (las guardas abren la puerta)', async () => {
      // patients[0] (caso activo con un control) se absorbe en patients[2].
      await asApp(
        a,
        (tx) =>
          tx.$queryRaw`SELECT dx_merge_patients(${a.patients[0]}::uuid, ${a.patients[2]}::uuid, ${a.userId}::uuid)`,
      );
      const moved = await raw.orthoVisit.findUniqueOrThrow({
        where: { id: visitA.id },
      });
      expect(moved.patientId).toBe(a.patients[2]);
      const entry = await raw.clinicalEntry.findUniqueOrThrow({
        where: { id: visitA.entryId },
      });
      expect(entry.patientId).toBe(a.patients[2]);
    });
  });
});
