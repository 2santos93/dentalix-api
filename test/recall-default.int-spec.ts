import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import {
  PrismaRecallRepository,
  RECALL_ALREADY_EXISTS_MESSAGE,
} from '../src/modules/recall/infrastructure/prisma-recall.repository';
import {
  RECALL_TYPE_INACTIVE_MESSAGE,
  RECALL_TYPE_UNAVAILABLE_MESSAGE,
} from '../src/modules/recall/infrastructure/recall-manual-write';
import {
  CreateDefaultRecallUseCase,
  GetPatientRecallsUseCase,
  PATIENT_NOT_FOUND_MESSAGE,
} from '../src/modules/recall/application/use-cases/recall.use-cases';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';
import {
  type DefaultRecallTypes,
  seedDefaultRecallTypes,
} from './support/recall-types';

// DX-015-bis (porción 3, D15) · «Programar recall» con el intervalo por
// defecto del tipo, con el caso de uso y el repositorio REALES sobre Postgres
// como dentalix_app (RLS FORCE). La base es el día civil de la última cita
// COMPLETED viva en la zona de SU sede (Kiritimati, UTC+14, cambia el día);
// sin citas, hoy en la sede activa. Solo crea (409), tipo vivo y activo (422),
// exclusión (D9) y auditoría (`via: 'DEFAULT'`), también con dos altas a la
// vez. `raw` (DIRECT_URL, owner) siembra, comprueba y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaRecallRepository(prisma, tenantContext);

const SUBDOMAIN = 'dx015bis-default';
const EMAIL = `recepcion@${SUBDOMAIN}.test`;
/** «Hoy»: 10:00 del 07/11/2027 en Caracas (UTC−4). */
const NOW = new Date('2027-11-07T14:00:00.000Z');
const DAY = (d: string) => new Date(`${d}T00:00:00.000Z`);

interface Seeded {
  tenantId: string;
  userId: string;
  caracas: string;
  kiritimati: string;
  types: DefaultRecallTypes;
}
let s: Seeded;

const audit = (): AuditRequestContext => ({
  tenantId: s.tenantId,
  locationId: s.caracas,
  actor: { userId: s.userId, role: ClinicRole.RECEPTION },
  requestId: 'dx015bis-default-int',
  ip: null,
  userAgent: null,
});

const createDefault = (patientId: string, recallTypeId: string) =>
  tenantContext.run(s.tenantId, s.caracas, () =>
    new CreateDefaultRecallUseCase(
      repo,
      () => NOW,
      new GetPatientRecallsUseCase(repo, () => NOW),
    ).execute(patientId, recallTypeId, s.userId, audit()),
  );

async function seed(): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
  });
  const user = await raw.user.create({
    data: { email: EMAIL, passwordHash: 'x', fullName: 'Rosa Medina' },
  });
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: ClinicRole.RECEPTION },
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

let seq = 0;
async function patient(name: string): Promise<string> {
  seq += 1;
  return (
    await raw.patient.create({
      data: {
        tenantId: s.tenantId,
        firstName: name,
        lastName: `Programar ${seq}`,
      },
    })
  ).id;
}

async function appointment(
  patientId: string,
  locationId: string,
  start: string,
  status: 'COMPLETED' | 'CANCELLED' | 'SCHEDULED' = 'COMPLETED',
  deletedAt: Date | null = null,
): Promise<void> {
  const at = new Date(start);
  await raw.appointment.create({
    data: {
      tenantId: s.tenantId,
      patientId,
      providerId: s.userId,
      locationId,
      start: at,
      end: new Date(at.getTime() + 30 * 60_000),
      status,
      deletedAt,
    },
  });
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

describe('DX-015-bis · «Programar recall» con el intervalo por defecto (int)', () => {
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

  it('base = día civil de la última COMPLETED viva en la zona de su sede, y esa sede; intervalo del tipo, MANUAL', async () => {
    const patientId = await patient('Ana');
    // Más antigua, en Caracas.
    await appointment(patientId, s.caracas, '2027-01-10T14:00:00.000Z');
    // La última atendida: 12:00 UTC del 10/03 = 02:00 del 11/03 en Kiritimati.
    await appointment(patientId, s.kiritimati, '2027-03-10T12:00:00.000Z');
    // Ni una cancelada, ni una atendida borrada, ni una agendada cuentan.
    await appointment(
      patientId,
      s.caracas,
      '2027-05-10T14:00:00.000Z',
      'CANCELLED',
    );
    await appointment(
      patientId,
      s.caracas,
      '2027-06-10T14:00:00.000Z',
      'COMPLETED',
      new Date('2027-06-11T00:00:00.000Z'),
    );

    const result = await createDefault(patientId, s.types.CHECKUP);
    const row = await raw.patientRecall.findFirstOrThrow({
      where: { patientId, recallTypeId: s.types.CHECKUP },
    });
    expect(row).toMatchObject({
      intervalMonths: 12,
      source: 'MANUAL',
      manualDoneAt: DAY('2027-03-11'),
      lastDoneAt: DAY('2027-03-11'),
      dueAt: DAY('2028-03-11'),
      locationId: s.kiritimati,
      active: true,
      kind: 'CHECKUP',
      createdById: s.userId,
    });
    expect(result.recallUpdates).toEqual([]);
    expect(result.recalls).toEqual([
      expect.objectContaining({
        id: row.id,
        recallTypeId: s.types.CHECKUP,
        baseDate: '2027-03-11',
        status: 'UPCOMING',
      }),
    ]);
    // Auditado como el PUT, con el recall y `via: 'DEFAULT'`.
    expect(await recallEvents(patientId)).toEqual([
      expect.objectContaining({
        action: 'UPDATE',
        resourceType: 'PATIENT_RECALL',
        resourceId: row.id,
        actorUserId: s.userId,
        actorRole: ClinicRole.RECEPTION,
        metadata: {
          via: 'DEFAULT',
          changedFields: ['intervalMonths', 'lastDoneAt'],
          params: { recallTypeId: s.types.CHECKUP },
        },
      }),
    ]);
  });

  it('sin ninguna cita atendida: hoy en la sede activa (y esa sede)', async () => {
    const patientId = await patient('Beatriz');
    await appointment(
      patientId,
      s.kiritimati,
      '2027-12-01T14:00:00.000Z',
      'SCHEDULED',
    );
    await createDefault(patientId, s.types.HYGIENE);
    const row = await raw.patientRecall.findFirstOrThrow({
      where: { patientId, recallTypeId: s.types.HYGIENE },
    });
    expect(row).toMatchObject({
      intervalMonths: 6,
      manualDoneAt: DAY('2027-11-07'),
      dueAt: DAY('2028-05-07'),
      locationId: s.caracas,
    });
  });

  it('solo crea: 409 si ya tiene uno de ese tipo, también inactivo, sin tocarlo ni auditar', async () => {
    const patientId = await patient('Carmen');
    await createDefault(patientId, s.types.CHECKUP);
    await raw.patientRecall.updateMany({
      where: { patientId },
      data: { active: false, intervalMonths: 9 },
    });
    const before = await raw.patientRecall.findMany({ where: { patientId } });
    const events = (await recallEvents(patientId)).length;
    await expect(createDefault(patientId, s.types.CHECKUP)).rejects.toThrow(
      new ConflictException(RECALL_ALREADY_EXISTS_MESSAGE),
    );
    expect(await raw.patientRecall.findMany({ where: { patientId } })).toEqual(
      before,
    );
    expect(await recallEvents(patientId)).toHaveLength(events);
  });

  it('tipo desactivado, retirado o de nadie: 422 sin crear nada; paciente ajeno: 404', async () => {
    const patientId = await patient('Daniela');
    const inactive = await raw.recallType.create({
      data: {
        tenantId: s.tenantId,
        name: 'Ortodoncia (pausado)',
        defaultIntervalMonths: 2,
        active: false,
        sortOrder: 90,
      },
    });
    const retired = await raw.recallType.create({
      data: {
        tenantId: s.tenantId,
        name: 'Blanqueamiento',
        defaultIntervalMonths: 12,
        active: false,
        sortOrder: 91,
        deletedAt: new Date('2027-01-01T00:00:00.000Z'),
      },
    });
    await expect(createDefault(patientId, inactive.id)).rejects.toThrow(
      new UnprocessableEntityException(RECALL_TYPE_INACTIVE_MESSAGE),
    );
    for (const id of [retired.id, '00000000-0000-4000-8000-000000000015']) {
      await expect(createDefault(patientId, id)).rejects.toThrow(
        new UnprocessableEntityException(RECALL_TYPE_UNAVAILABLE_MESSAGE),
      );
    }
    expect(await raw.patientRecall.count({ where: { patientId } })).toBe(0);
    await expect(
      createDefault('00000000-0000-4000-8000-0000000000aa', s.types.HYGIENE),
    ).rejects.toThrow(new NotFoundException(PATIENT_NOT_FOUND_MESSAGE));
  });

  it('D9: programar la Higiene desactiva el Mantenimiento periodontal activo, lo devuelve y lo audita', async () => {
    const patientId = await patient('Elena');
    await appointment(patientId, s.caracas, '2027-10-01T14:00:00.000Z');
    const perio = await raw.patientRecall.create({
      data: {
        tenantId: s.tenantId,
        patientId,
        recallTypeId: s.types.PERIO,
        intervalMonths: 3,
        lastDoneAt: DAY('2027-06-01'),
        manualDoneAt: DAY('2027-06-01'),
        locationId: s.caracas,
        createdById: s.userId,
        updatedById: s.userId,
      },
    });
    const result = await createDefault(patientId, s.types.HYGIENE);
    const hygiene = await raw.patientRecall.findFirstOrThrow({
      where: { patientId, recallTypeId: s.types.HYGIENE },
    });
    expect(result.recallUpdates).toEqual([
      {
        recallId: perio.id,
        recallTypeId: s.types.PERIO,
        recallTypeName: 'Mantenimiento periodontal',
        dueAt: '2027-09-01',
        deactivated: true,
        replacedBy: {
          recallTypeId: s.types.HYGIENE,
          recallTypeName: 'Higiene',
        },
      },
    ]);
    expect(
      await raw.patientRecall.findUniqueOrThrow({ where: { id: perio.id } }),
    ).toMatchObject({ active: false, excludedAt: expect.any(Date) as Date });
    expect(hygiene).toMatchObject({
      active: true,
      lastDoneAt: DAY('2027-10-01'),
    });
    expect(
      (await recallEvents(patientId)).map((e) => [
        e.resourceId,
        (e.metadata as { via?: string; reason?: string }).via ??
          (e.metadata as { reason?: string }).reason,
      ]),
    ).toEqual([
      [hygiene.id, 'DEFAULT'],
      [perio.id, 'EXCLUSION'],
    ]);
  });

  it('dos altas a la vez del mismo tipo (sin grupo): una crea y la otra da 409; una sola fila', async () => {
    const patientId = await patient('Fabiola');
    const results = await Promise.allSettled([
      createDefault(patientId, s.types.CHECKUP),
      createDefault(patientId, s.types.CHECKUP),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const rejected = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(ConflictException);
    expect(await raw.patientRecall.count({ where: { patientId } })).toBe(1);
  });

  it('dos altas a la vez de tipos del mismo grupo: queda uno solo activo', async () => {
    const patientId = await patient('Gabriela');
    await Promise.all([
      createDefault(patientId, s.types.HYGIENE),
      createDefault(patientId, s.types.PERIO),
    ]);
    const rows = await raw.patientRecall.findMany({ where: { patientId } });
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.active)).toHaveLength(1);
  });
});
