import { randomUUID } from 'node:crypto';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaRecallRepository } from '../src/modules/recall/infrastructure/prisma-recall.repository';
import { ListUnconfiguredRecallsUseCase } from '../src/modules/recall/application/use-cases/recall.use-cases';
import type { RecallUnconfiguredPage } from '../src/modules/recall/domain/recall.entity';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';
import {
  type DefaultRecallTypes,
  seedDefaultRecallTypes,
} from './support/recall-types';

// DX-015-bis (porción 3, D17) · «Sin recall configurado» con el caso de uso y
// el repositorio REALES sobre Postgres como dentalix_app (RLS FORCE): cada
// condición que incluye o excluye a un paciente (cita atendida en los 24
// meses en la zona de su sede, ningún recall activo de un tipo vivo, sin
// próxima cita, paciente vivo), la sede (la de la última atendida: query,
// cabecera, sedes permitidas), el día civil y el orden. La de 60.000
// pacientes está en recall-due-load.int-spec.ts. `raw` (DIRECT_URL, owner)
// siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaRecallRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx015bis-unconfigured', 'dx015bis-unconfigured-otra'];
const EMAIL = `admin@${SUBDOMAINS[0]}.test`;
/** «Hoy»: 10:00 del 07/11/2027 en Caracas; ya es 08/11 en Kiritimati. */
const NOW = new Date('2027-11-07T14:00:00.000Z');

interface Seeded {
  tenantId: string;
  otherTenantId: string;
  userId: string;
  caracas: string;
  kiritimati: string;
  otherSede: string;
  types: DefaultRecallTypes;
  retiredTypeId: string;
}
let s: Seeded;

/** Nombre → id de los pacientes sembrados. */
const ids = new Map<string, string>();

const list = (
  input: { locationId?: string; page?: number; pageSize?: number } = {},
  ctx: { activeLocation?: string; allowed?: readonly string[] } = {},
): Promise<RecallUnconfiguredPage> =>
  tenantContext.run(
    s.tenantId,
    ctx.activeLocation,
    () =>
      new ListUnconfiguredRecallsUseCase(
        repo,
        () => NOW,
        tenantContext,
      ).execute({ pageSize: 100, ...input }),
    ctx.allowed,
  );

const names = (page: RecallUnconfiguredPage) =>
  page.items.map((i) => i.patientName.split(' ')[0]);

async function sede(tenantId: string, name: string, timeZone: string) {
  return (
    await raw.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId,
        name,
        timeZone,
      }),
    })
  ).id;
}

async function seed(): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: SUBDOMAINS[0], subdomain: SUBDOMAINS[0] },
  });
  const other = await raw.tenant.create({
    data: { name: SUBDOMAINS[1], subdomain: SUBDOMAINS[1] },
  });
  const user = await raw.user.create({
    data: { email: EMAIL, passwordHash: 'x', fullName: 'Rosa Medina' },
  });
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: ClinicRole.ADMIN },
  });
  const types = await seedDefaultRecallTypes(raw, tenant.id);
  const retired = await raw.recallType.create({
    data: {
      tenantId: tenant.id,
      name: 'Blanqueamiento',
      defaultIntervalMonths: 12,
      active: false,
      sortOrder: 90,
      deletedAt: new Date('2027-01-01T00:00:00.000Z'),
    },
  });
  return {
    tenantId: tenant.id,
    otherTenantId: other.id,
    userId: user.id,
    caracas: await sede(tenant.id, 'Sede Altamira', 'America/Caracas'),
    kiritimati: await sede(tenant.id, 'Sede Kiritimati', 'Pacific/Kiritimati'),
    otherSede: await sede(other.id, 'Sede Maracay', 'America/Caracas'),
    types,
    retiredTypeId: retired.id,
  };
}

interface PatientSpec {
  name: string;
  lastName?: string;
  tenantId?: string;
  deleted?: boolean;
  optedOut?: boolean;
  phone?: string;
  appointments: {
    at: string;
    location?: 'kiritimati';
    status?: 'COMPLETED' | 'CANCELLED' | 'SCHEDULED' | 'CONFIRMED' | 'ARRIVED';
    deleted?: boolean;
  }[];
  recalls?: { typeId: 'hygiene' | 'retired'; active: boolean }[];
}

async function patient(spec: PatientSpec): Promise<string> {
  const tenantId = spec.tenantId ?? s.tenantId;
  const row = await raw.patient.create({
    data: {
      tenantId,
      firstName: spec.name,
      lastName: spec.lastName ?? 'Sin Recall',
      phone: spec.phone ?? '+58 412 555 0101',
      deletedAt: spec.deleted ? new Date('2027-10-01T00:00:00.000Z') : null,
      reminderOptOutAt: spec.optedOut
        ? new Date('2027-10-01T00:00:00.000Z')
        : null,
      reminderOptOutSource: spec.optedOut ? 'STAFF' : null,
    },
  });
  for (const a of spec.appointments) {
    const start = new Date(a.at);
    await raw.appointment.create({
      data: {
        tenantId,
        patientId: row.id,
        // Cada cita con su profesional: sin choques de la agenda.
        providerId: randomUUID(),
        locationId: a.location
          ? s.kiritimati
          : tenantId === s.tenantId
            ? s.caracas
            : s.otherSede,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
        status: a.status ?? 'COMPLETED',
        // DX-200: una llegada lleva su hora y de qué estado venía.
        ...(a.status === 'ARRIVED'
          ? { arrivedAt: start, preArrivalStatus: 'CONFIRMED' as const }
          : {}),
        deletedAt: a.deleted ? new Date('2027-10-02T00:00:00.000Z') : null,
      },
    });
  }
  for (const r of spec.recalls ?? []) {
    await raw.patientRecall.create({
      data: {
        tenantId,
        patientId: row.id,
        recallTypeId:
          r.typeId === 'hygiene' ? s.types.HYGIENE : s.retiredTypeId,
        intervalMonths: 6,
        lastDoneAt: new Date('2027-06-01T00:00:00.000Z'),
        manualDoneAt: new Date('2027-06-01T00:00:00.000Z'),
        locationId: s.caracas,
        active: r.active,
        createdById: s.userId,
        updatedById: s.userId,
      },
    });
  }
  ids.set(spec.name, row.id);
  return row.id;
}

describe('DX-015-bis · «Sin recall configurado» (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await raw.user.deleteMany({ where: { email: EMAIL } });
    s = await seed();
    const recent = '2027-10-20T14:00:00.000Z';
    // --- Salen ---
    await patient({ name: 'Ana', appointments: [{ at: recent }] });
    // Solo un recall INACTIVO (retirado o excluido): sin recall configurado.
    await patient({
      name: 'Bruno',
      appointments: [{ at: '2027-09-15T14:00:00.000Z' }],
      recalls: [{ typeId: 'hygiene', active: false }],
    });
    // Un recall activo, pero de un tipo retirado: no cuenta.
    await patient({
      name: 'Carla',
      appointments: [{ at: '2027-08-15T14:00:00.000Z' }],
      recalls: [{ typeId: 'retired', active: true }],
    });
    // Una cita agendada ya pasada (sin cerrar) no es una próxima cita.
    await patient({
      name: 'Diego',
      appointments: [
        { at: '2027-07-15T14:00:00.000Z' },
        { at: '2027-11-01T14:00:00.000Z', status: 'SCHEDULED' },
      ],
    });
    // Justo en el borde: 24 meses antes de «hoy» (07/11/2025 en Caracas).
    await patient({
      name: 'Elisa',
      appointments: [{ at: '2025-11-07T14:00:00.000Z' }],
    });
    // Última atendida en Kiritimati: 12:00 UTC del 05/11 = 02:00 del 06/11.
    await patient({
      name: 'Fabio',
      appointments: [
        { at: '2027-01-10T14:00:00.000Z' },
        { at: '2027-11-05T12:00:00.000Z', location: 'kiritimati' },
      ],
    });
    // Con baja de avisos: sale, sin contacto.
    await patient({
      name: 'Gema',
      optedOut: true,
      appointments: [{ at: recent }],
      lastName: 'Aponte',
    });
    // --- No salen ---
    await patient({
      name: 'Hugo',
      appointments: [{ at: '2025-11-06T14:00:00.000Z' }], // un día fuera
    });
    await patient({
      name: 'Inés',
      appointments: [{ at: recent }],
      recalls: [{ typeId: 'hygiene', active: true }],
    });
    await patient({
      name: 'Javier',
      appointments: [
        { at: recent },
        { at: '2027-11-20T14:00:00.000Z', status: 'SCHEDULED' },
      ],
    });
    await patient({
      name: 'Karen',
      appointments: [
        { at: recent },
        { at: '2027-11-07T13:00:00.000Z', status: 'ARRIVED' },
      ],
    });
    await patient({
      name: 'Luis',
      deleted: true,
      appointments: [{ at: recent }],
    });
    await patient({
      name: 'Marta',
      appointments: [
        { at: recent, status: 'CANCELLED' },
        { at: '2027-10-21T14:00:00.000Z', deleted: true },
      ],
    });
    await patient({ name: 'Nora', appointments: [] });
    // Otra clínica: nunca.
    await patient({
      name: 'Oscar',
      tenantId: s.otherTenantId,
      appointments: [{ at: recent }],
    });
  }, 60_000);

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await raw.user.deleteMany({ where: { email: EMAIL } });
    await Promise.all([raw.$disconnect(), prisma.$disconnect()]);
  });

  it('cada condición: incluye y excluye a quien toca; orden por la última visita, después el apellido', async () => {
    const page = await list();
    // Ana y Gema, el mismo día: por apellido (Aponte < Sin Recall).
    expect(names(page)).toEqual([
      'Fabio',
      'Gema',
      'Ana',
      'Bruno',
      'Carla',
      'Diego',
      'Elisa',
    ]);
    expect(page.total).toBe(7);
  });

  it('las filas: día civil y sede de la última visita, teléfono y WhatsApp (sin contacto con baja de avisos)', async () => {
    const page = await list();
    const row = (name: string) =>
      page.items.find((i) => i.patientId === ids.get(name));
    expect(row('Fabio')).toEqual({
      patientId: ids.get('Fabio'),
      patientName: 'Fabio Sin Recall',
      patientPhone: '+58 412 555 0101',
      patientWhatsApp: '584125550101',
      reminderOptedOut: false,
      lastVisitAt: '2027-11-06',
      lastVisitLocationId: s.kiritimati,
    });
    expect(row('Elisa')).toMatchObject({
      lastVisitAt: '2025-11-07',
      lastVisitLocationId: s.caracas,
    });
    expect(row('Gema')).toMatchObject({
      patientPhone: null,
      patientWhatsApp: null,
      reminderOptedOut: true,
    });
  });

  it('sede: la de la última atendida, por la query, la cabecera o las permitidas; otra sede no permitida, 403', async () => {
    expect(names(await list({ locationId: s.kiritimati }))).toEqual(['Fabio']);
    expect(names(await list({}, { activeLocation: s.kiritimati }))).toEqual([
      'Fabio',
    ]);
    expect((await list({}, { allowed: [s.caracas] })).total).toBe(6);
    // La query manda sobre la cabecera.
    expect(
      names(
        await list({ locationId: s.kiritimati }, { activeLocation: s.caracas }),
      ),
    ).toEqual(['Fabio']);
    await expect(
      list({ locationId: s.kiritimati }, { allowed: [s.caracas] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // La sede de otra clínica: nada (RLS y filtro de clínica).
    expect(await list({ locationId: s.otherSede })).toMatchObject({
      items: [],
      total: 0,
    });
  });

  it('paginación: el total de todas las páginas y una página fuera de rango vacía', async () => {
    const first = await list({ page: 1, pageSize: 3 });
    const second = await list({ page: 2, pageSize: 3 });
    expect(names(first)).toEqual(['Fabio', 'Gema', 'Ana']);
    expect(names(second)).toEqual(['Bruno', 'Carla', 'Diego']);
    expect(first.total).toBe(7);
    expect(await list({ page: 9, pageSize: 3 })).toEqual({
      items: [],
      total: 7,
      page: 9,
      pageSize: 3,
    });
  });

  it('al programar su recall, el paciente sale de la lista; al retirarlo, vuelve', async () => {
    const patientId = ids.get('Ana') as string;
    const recall = await raw.patientRecall.create({
      data: {
        tenantId: s.tenantId,
        patientId,
        recallTypeId: s.types.CHECKUP,
        intervalMonths: 12,
        lastDoneAt: new Date('2027-10-20T00:00:00.000Z'),
        manualDoneAt: new Date('2027-10-20T00:00:00.000Z'),
        locationId: s.caracas,
        createdById: s.userId,
        updatedById: s.userId,
      },
    });
    expect(names(await list())).not.toContain('Ana');
    await raw.patientRecall.update({
      where: { id: recall.id },
      data: { active: false },
    });
    expect(names(await list())).toContain('Ana');
  });
});
