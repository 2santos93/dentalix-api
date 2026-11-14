import { randomUUID } from 'node:crypto';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { PrismaClinicalEntryRepository } from '../src/modules/clinical-entries/infrastructure/repositories/prisma-clinical-entry.repository';
import {
  CreateClinicalEntryUseCase,
  type CreateClinicalEntryInput,
} from '../src/modules/clinical-entries/application/use-cases/create-clinical-entry.use-case';
import { InMemoryClinicalEntrySettingsRepository } from '../src/modules/clinical-entries/application/__fixtures__/in-memory-clinical-entries';
import { InMemoryClinicalNoteTemplateRepository } from '../src/modules/clinical-note-templates/application/__fixtures__/in-memory-clinical-note-templates';
import { patientsInClinic } from '../src/modules/patients/application/__fixtures__/patients-in-clinic.fake';
import { RECALL_TYPE_UNAVAILABLE_MESSAGE } from '../src/modules/recall/infrastructure/recall-manual-write';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';
import { civilDaysSince } from './support/sede-clock';
import {
  type DefaultRecallTypes,
  seedDefaultRecallTypes,
} from './support/recall-types';

// DX-015-bis (porción 3, D18) · El intervalo del recall al registrar la
// evolución, con el repositorio REAL de evoluciones sobre Postgres como
// dentalix_app (RLS FORCE) y la misma transacción: sin recall de ese tipo se
// crea con la base en el día de la evolución y su sede; con uno, solo cambia
// el intervalo (y se reactiva); exclusión (D9) y auditoría
// (`via: 'CLINICAL_ENTRY'`); un tipo inexistente o retirado da 422 y NO se
// guarda la evolución. `raw` (DIRECT_URL, owner) siembra, comprueba y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const entries = new PrismaClinicalEntryRepository(prisma, tenantContext);

const SUBDOMAIN = 'dx015bis-entry-recall';
const EMAIL = `odontologa@${SUBDOMAIN}.test`;
const DAY = (d: string) => new Date(`${d}T00:00:00.000Z`);

interface Seeded {
  tenantId: string;
  userId: string;
  caracas: string;
  kiritimati: string;
  types: DefaultRecallTypes;
}
let s: Seeded;
const patientIds: string[] = [];

const audit = (): AuditRequestContext => ({
  tenantId: s.tenantId,
  locationId: s.caracas,
  actor: { userId: s.userId, role: ClinicRole.DENTIST },
  requestId: 'dx015bis-entry-recall-int',
  ip: null,
  userAgent: null,
});

const createEntry = (
  patientId: string,
  input: CreateClinicalEntryInput,
  activeLocation?: string,
) =>
  tenantContext.run(s.tenantId, activeLocation ?? s.caracas, () =>
    new CreateClinicalEntryUseCase(
      entries,
      patientsInClinic(...patientIds),
      new InMemoryClinicalNoteTemplateRepository(),
      tenantContext,
      new InMemoryClinicalEntrySettingsRepository(),
    ).execute(patientId, input, s.userId, audit()),
  );

async function seed(): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
  });
  const user = await raw.user.create({
    data: { email: EMAIL, passwordHash: 'x', fullName: 'Dra. Briceño' },
  });
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: ClinicRole.DENTIST },
  });
  const sede = async (name: string, timeZone: string) =>
    (
      await raw.location.create({
        data: locationData(REGIONAL_CARACAS_FIXTURE, {
          tenantId: tenant.id,
          name,
          timeZone,
        }),
      })
    ).id;
  return {
    tenantId: tenant.id,
    userId: user.id,
    caracas: await sede('Sede Altamira', 'America/Caracas'),
    kiritimati: await sede('Sede Kiritimati', 'Pacific/Kiritimati'),
    types: await seedDefaultRecallTypes(raw, tenant.id),
  };
}

async function patient(name: string): Promise<string> {
  const id = (
    await raw.patient.create({
      data: { tenantId: s.tenantId, firstName: name, lastName: 'Evolución' },
    })
  ).id;
  patientIds.push(id);
  return id;
}

async function recall(
  patientId: string,
  recallTypeId: string,
  data: { active?: boolean; intervalMonths?: number; base?: string } = {},
): Promise<string> {
  const base = DAY(data.base ?? '2026-02-01');
  return (
    await raw.patientRecall.create({
      data: {
        tenantId: s.tenantId,
        patientId,
        recallTypeId,
        intervalMonths: data.intervalMonths ?? 6,
        lastDoneAt: base,
        manualDoneAt: base,
        locationId: s.caracas,
        active: data.active ?? true,
        excludedAt: data.active === false ? new Date() : null,
        createdById: s.userId,
        updatedById: s.userId,
      },
    })
  ).id;
}

const recallEvents = (patientId: string) =>
  raw.auditEvent.findMany({
    where: {
      tenantId: s.tenantId,
      patientId,
      resourceType: 'PATIENT_RECALL',
    },
    orderBy: { occurredAt: 'asc' },
  });

describe('DX-015-bis · recall en la evolución (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeTenantsBySubdomain(raw, [SUBDOMAIN]);
    await raw.user.deleteMany({ where: { email: EMAIL } });
    s = await seed();
  }, 60_000);

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, [SUBDOMAIN]);
    await raw.user.deleteMany({ where: { email: EMAIL } });
    await Promise.all([raw.$disconnect(), prisma.$disconnect()]);
  });

  it('sin recall de ese tipo: lo crea MANUAL con la base en el día de la evolución y su sede, y lo audita', async () => {
    const patientId = await patient('Ana');
    const created = await createEntry(
      patientId,
      {
        notes: 'Control. Volver en 3 meses.',
        entryDate: DAY('2026-04-10'),
        recall: { recallTypeId: s.types.CHECKUP, intervalMonths: 3 },
      },
      s.kiritimati,
    );
    const row = await raw.patientRecall.findFirstOrThrow({
      where: { patientId, recallTypeId: s.types.CHECKUP },
    });
    expect(row).toMatchObject({
      intervalMonths: 3,
      source: 'MANUAL',
      manualDoneAt: DAY('2026-04-10'),
      lastDoneAt: DAY('2026-04-10'),
      dueAt: DAY('2026-07-10'),
      locationId: s.kiritimati,
      active: true,
      createdById: s.userId,
    });
    expect(created.recallUpdates).toEqual([
      {
        recallId: row.id,
        recallTypeId: s.types.CHECKUP,
        recallTypeName: 'Control',
        dueAt: '2026-07-10',
        deactivated: false,
        replacedBy: null,
      },
    ]);
    expect(await recallEvents(patientId)).toEqual([
      expect.objectContaining({
        action: 'UPDATE',
        resourceId: row.id,
        actorUserId: s.userId,
        metadata: {
          via: 'CLINICAL_ENTRY',
          changedFields: ['intervalMonths', 'lastDoneAt'],
          params: { recallTypeId: s.types.CHECKUP, entryId: created.id },
        },
      }),
    ]);
  });

  it('sin fecha ni cita: la base es hoy en la zona de la sede de la evolución', async () => {
    const patientId = await patient('Beatriz');
    const started = Date.now();
    await createEntry(
      patientId,
      {
        notes: 'Control',
        recall: { recallTypeId: s.types.CHECKUP, intervalMonths: 12 },
      },
      s.kiritimati,
    );
    const row = await raw.patientRecall.findFirstOrThrow({
      where: { patientId, recallTypeId: s.types.CHECKUP },
    });
    // Los días de la sede que tocó la petición (dos si cruzó su medianoche).
    const elapsed = Math.ceil((Date.now() - started) / 60_000);
    expect(civilDaysSince(elapsed, 'Pacific/Kiritimati')).toContain(
      row.manualDoneAt?.toISOString().slice(0, 10),
    );
  });

  it('con cita: la sede de la cita y su día civil', async () => {
    const patientId = await patient('Carmen');
    // 12:00 UTC del 10/03 = 02:00 del 11/03 en Kiritimati.
    const start = new Date('2026-03-10T12:00:00.000Z');
    const appointment = await raw.appointment.create({
      data: {
        tenantId: s.tenantId,
        patientId,
        providerId: randomUUID(),
        locationId: s.kiritimati,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
        status: 'COMPLETED',
      },
    });
    await createEntry(
      patientId,
      {
        notes: 'Profilaxis',
        appointmentId: appointment.id,
        recall: { recallTypeId: s.types.CHECKUP, intervalMonths: 6 },
      },
      s.caracas,
    );
    expect(
      await raw.patientRecall.findFirstOrThrow({
        where: { patientId, recallTypeId: s.types.CHECKUP },
      }),
    ).toMatchObject({
      manualDoneAt: DAY('2026-03-11'),
      locationId: s.kiritimati,
    });
  });

  it('con recall activo: solo cambia el intervalo; la base no se toca ni se excluye nada', async () => {
    const patientId = await patient('Daniela');
    const id = await recall(patientId, s.types.CHECKUP, {
      intervalMonths: 12,
      base: '2026-02-01',
    });
    const created = await createEntry(patientId, {
      notes: 'Control',
      entryDate: DAY('2026-04-10'),
      recall: { recallTypeId: s.types.CHECKUP, intervalMonths: 4 },
    });
    expect(
      await raw.patientRecall.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      intervalMonths: 4,
      manualDoneAt: DAY('2026-02-01'),
      lastDoneAt: DAY('2026-02-01'),
      dueAt: DAY('2026-06-01'),
      active: true,
    });
    expect(created.recallUpdates).toEqual([
      expect.objectContaining({
        recallId: id,
        dueAt: '2026-06-01',
        deactivated: false,
      }),
    ]);
    expect((await recallEvents(patientId)).map((e) => e.metadata)).toEqual([
      {
        via: 'CLINICAL_ENTRY',
        changedFields: ['intervalMonths'],
        params: { recallTypeId: s.types.CHECKUP, entryId: created.id },
      },
    ]);
  });

  it('con recall inactivo: lo reactiva (y quita la marca de excluido) con su base; D9 desactiva el otro del grupo', async () => {
    const patientId = await patient('Elena');
    const hygiene = await recall(patientId, s.types.HYGIENE, {
      active: false,
      base: '2026-01-15',
    });
    const perio = await recall(patientId, s.types.PERIO, {
      intervalMonths: 3,
      base: '2026-03-01',
    });
    const created = await createEntry(patientId, {
      notes: 'Encías estables: vuelve a higiene cada 6 meses.',
      entryDate: DAY('2026-04-10'),
      recall: { recallTypeId: s.types.HYGIENE, intervalMonths: 6 },
    });
    expect(
      await raw.patientRecall.findUniqueOrThrow({ where: { id: hygiene } }),
    ).toMatchObject({
      active: true,
      excludedAt: null,
      lastDoneAt: DAY('2026-01-15'),
      intervalMonths: 6,
    });
    expect(
      await raw.patientRecall.findUniqueOrThrow({ where: { id: perio } }),
    ).toMatchObject({ active: false, excludedAt: expect.any(Date) as Date });
    expect(created.recallUpdates).toEqual([
      {
        recallId: hygiene,
        recallTypeId: s.types.HYGIENE,
        recallTypeName: 'Higiene',
        dueAt: '2026-07-15',
        deactivated: false,
        replacedBy: null,
      },
      {
        recallId: perio,
        recallTypeId: s.types.PERIO,
        recallTypeName: 'Mantenimiento periodontal',
        dueAt: '2026-06-01',
        deactivated: true,
        replacedBy: {
          recallTypeId: s.types.HYGIENE,
          recallTypeName: 'Higiene',
        },
      },
    ]);
    const events = await recallEvents(patientId);
    expect(
      events.map((e) => [
        e.resourceId,
        (e.metadata as { via?: string }).via ??
          (e.metadata as { reason?: string }).reason,
      ]),
    ).toEqual([
      [hygiene, 'CLINICAL_ENTRY'],
      [perio, 'EXCLUSION'],
    ]);
    expect(events[0].metadata).toMatchObject({
      changedFields: ['active', 'intervalMonths'],
    });
  });

  it('reactivar quita también la pausa (como el PUT); con el recall activo, la pausa se conserva', async () => {
    const patientId = await patient('Irene');
    const retired = await recall(patientId, s.types.CHECKUP, { active: false });
    const paused = await recall(patientId, s.types.HYGIENE);
    await raw.patientRecall.updateMany({
      where: { id: { in: [retired, paused] } },
      data: {
        disabledUntil: DAY('2026-12-31'),
        disabledReason: 'Tratamiento de ortodoncia',
      },
    });
    for (const recallTypeId of [s.types.CHECKUP, s.types.HYGIENE]) {
      await createEntry(patientId, {
        notes: 'Control',
        entryDate: DAY('2026-04-10'),
        recall: { recallTypeId, intervalMonths: 6 },
      });
    }
    expect(
      await raw.patientRecall.findUniqueOrThrow({ where: { id: retired } }),
    ).toMatchObject({
      active: true,
      disabledUntil: null,
      disabledReason: null,
    });
    expect(
      await raw.patientRecall.findUniqueOrThrow({ where: { id: paused } }),
    ).toMatchObject({
      active: true,
      disabledUntil: DAY('2026-12-31'),
      disabledReason: 'Tratamiento de ortodoncia',
    });
  });

  it('crear uno de un tipo con grupo desactiva el otro activo del grupo', async () => {
    const patientId = await patient('Fabiola');
    const hygiene = await recall(patientId, s.types.HYGIENE);
    const created = await createEntry(patientId, {
      notes: 'Bolsas de 5 mm: mantenimiento periodontal.',
      entryDate: DAY('2026-04-10'),
      recall: { recallTypeId: s.types.PERIO, intervalMonths: 3 },
    });
    expect(created.recallUpdates.map((u) => u.deactivated)).toEqual([
      false,
      true,
    ]);
    expect(
      await raw.patientRecall.findUniqueOrThrow({ where: { id: hygiene } }),
    ).toMatchObject({ active: false });
  });

  it('tipo inexistente o retirado: 422 y NO se guarda la evolución (ni el recall ni eventos)', async () => {
    const patientId = await patient('Gabriela');
    const retired = await raw.recallType.create({
      data: {
        tenantId: s.tenantId,
        name: 'Blanqueamiento',
        defaultIntervalMonths: 12,
        active: false,
        sortOrder: 90,
        deletedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    for (const recallTypeId of [
      retired.id,
      '00000000-0000-4000-8000-000000000015',
    ]) {
      await expect(
        createEntry(patientId, {
          notes: 'No debe quedar',
          entryDate: DAY('2026-04-10'),
          recall: { recallTypeId, intervalMonths: 3 },
        }),
      ).rejects.toThrow(
        new UnprocessableEntityException(RECALL_TYPE_UNAVAILABLE_MESSAGE),
      );
    }
    expect(await raw.clinicalEntry.count({ where: { patientId } })).toBe(0);
    expect(await raw.patientRecall.count({ where: { patientId } })).toBe(0);
    expect(await recallEvents(patientId)).toEqual([]);
  });

  it('un tipo desactivado (vivo) se acepta, como en el PUT', async () => {
    const patientId = await patient('Helena');
    const paused = await raw.recallType.create({
      data: {
        tenantId: s.tenantId,
        name: 'Ortodoncia',
        defaultIntervalMonths: 2,
        active: false,
        sortOrder: 91,
      },
    });
    await createEntry(patientId, {
      notes: 'Control de brackets',
      entryDate: DAY('2026-04-10'),
      recall: { recallTypeId: paused.id, intervalMonths: 1 },
    });
    expect(
      await raw.patientRecall.findFirstOrThrow({
        where: { patientId, recallTypeId: paused.id },
      }),
    ).toMatchObject({ intervalMonths: 1, dueAt: DAY('2026-05-10') });
  });
});
