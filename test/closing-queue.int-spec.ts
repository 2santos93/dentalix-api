import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaClosingQueueRepository } from '../src/modules/closing-queue/infrastructure/prisma-closing-queue.repository';
import { ClosingQueueUseCases } from '../src/modules/closing-queue/application/closing-queue.use-cases';
import { resetDatabase } from './support/e2e-fixtures';
import {
  locationData,
  type RegionalFixture,
} from './support/location-fixtures';

// DX-439 · «Pendiente de cerrar» contra Postgres de verdad, como dentalix_app
// (DATABASE_URL, sin BYPASSRLS) con la clínica fijada por el contexto. `raw`
// (DIRECT_URL, owner) solo siembra: las citas son del pasado, que la API no
// deja crear.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const CARACAS: RegionalFixture = {
  country: 'VE',
  currency: 'USD',
  timeZone: 'America/Caracas',
  locale: 'es-VE',
  hourCycle: 'h12',
  defaultPhoneRegion: 'VE',
};
const MADRID: RegionalFixture = {
  country: 'ES',
  currency: 'EUR',
  timeZone: 'Europe/Madrid',
  locale: 'es-ES',
  hourCycle: 'h23',
  defaultPhoneRegion: 'ES',
};

/**
 * «Ahora» = 01/11/2026 00:30 UTC: en Caracas (UTC−4) aún es el 31/10, 20:30;
 * en Madrid (UTC+1) ya es el 01/11, 01:30.
 */
const NOW = new Date('2026-11-01T00:30:00Z');

const SOURCE_TABLES = [
  'appointments',
  'patients',
  'locations',
  'clinical_entries',
  'appointment_plan_items',
  'treatment_plan_items',
  'treatment_plans',
  'dental_catalog_items',
  'closing_queue_dismissals',
];

interface SeededClinic {
  tenantId: string;
  caracas: string;
  madrid: string;
  dentistId: string;
  patientId: string;
  catalogId: string;
}

async function seedClinic(subdomain: string): Promise<SeededClinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const caracas = await raw.location.create({
    data: locationData(CARACAS, { tenantId: tenant.id, name: 'Caracas' }),
  });
  const madrid = await raw.location.create({
    data: locationData(MADRID, { tenantId: tenant.id, name: 'Madrid' }),
  });
  const user = await raw.user.create({
    data: {
      email: `dentista@${subdomain}.test`,
      passwordHash: 'x',
      fullName: `Dra. ${subdomain}`,
    },
  });
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: ClinicRole.DENTIST },
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: subdomain },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: `RES-${subdomain}`,
      kind: 'PROCEDURE',
      labelEs: 'Resina',
      color: '#123456',
    },
  });
  return {
    tenantId: tenant.id,
    caracas: caracas.id,
    madrid: madrid.id,
    dentistId: user.id,
    patientId: patient.id,
    catalogId: catalog.id,
  };
}

describe('«Pendiente de cerrar» en la BD (DX-439, int)', () => {
  const context = new TenantContextService();
  const prisma = new PrismaService(context);
  const repo = new PrismaClosingQueueRepository(prisma, context);
  const useCases = new ClosingQueueUseCases(repo, () => NOW);
  const admin = {
    userId: '00000000-0000-4000-8000-00000000a0a0',
    role: ClinicRole.ADMIN,
  };
  let a: SeededClinic;
  let b: SeededClinic;

  async function appointment(
    clinic: SeededClinic,
    input: {
      locationId: string;
      start: string;
      status: 'SCHEDULED' | 'CONFIRMED' | 'COMPLETED';
    },
  ): Promise<string> {
    const start = new Date(input.start);
    const row = await raw.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId: input.locationId,
        patientId: clinic.patientId,
        providerId: clinic.dentistId,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
        status: input.status,
      },
    });
    return row.id;
  }

  async function entry(
    clinic: SeededClinic,
    appointmentId: string,
    deleted: boolean,
  ): Promise<void> {
    await raw.clinicalEntry.create({
      data: {
        tenantId: clinic.tenantId,
        patientId: clinic.patientId,
        appointmentId,
        locationId: clinic.caracas,
        entryDate: new Date('2026-10-30T12:00:00Z'),
        notes: 'texto clínico',
        performedById: clinic.dentistId,
        deletedAt: deleted ? new Date('2026-10-30T13:00:00Z') : null,
      },
    });
  }

  /** Un ítem ACCEPTED de un plan ACCEPTED, ligado a la cita. */
  async function linkedItem(
    clinic: SeededClinic,
    appointmentId: string,
  ): Promise<string> {
    const plan = await raw.treatmentPlan.create({
      data: {
        tenantId: clinic.tenantId,
        patientId: clinic.patientId,
        currency: 'USD',
        status: 'ACCEPTED',
      },
    });
    const item = await raw.treatmentPlanItem.create({
      data: {
        tenantId: clinic.tenantId,
        planId: plan.id,
        toothNumber: '16',
        catalogItemId: clinic.catalogId,
        price: 50,
        status: 'ACCEPTED',
      },
    });
    await raw.appointmentPlanItem.create({
      data: {
        tenantId: clinic.tenantId,
        patientId: clinic.patientId,
        appointmentId,
        planItemId: item.id,
      },
    });
    return item.id;
  }

  const list = (
    clinic: SeededClinic,
    allowed: readonly string[] | 'ALL' = 'ALL',
  ) =>
    context.run(clinic.tenantId, () =>
      useCases.list({ actor: admin, allowedLocationIds: allowed }),
    );

  // A: Caracas 30/10 (ayer allí) CONFIRMED, 31/10 20:00 (hoy allí) SCHEDULED;
  // Madrid 31/10 23:30 local = 22:30Z (ayer allí) CONFIRMED y 01/11 00:10
  // local = 23:10Z del 31/10 (hoy allí) SCHEDULED.
  let caracasYesterday: string;
  let caracasToday: string;
  let madridYesterday: string;
  let madridToday: string;
  let withVoidedEntry: string;
  let withLiveEntry: string;
  let withItem: string;
  let itemId: string;
  let movedItem: string;
  let bAppointment: string;
  let laterFirst: string;
  let laterSecond: string;
  let laterItem: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(raw);
    a = await seedClinic('dx439-a');
    b = await seedClinic('dx439-b');
    caracasYesterday = await appointment(a, {
      locationId: a.caracas,
      start: '2026-10-30T23:00:00Z', // 30/10 19:00 en Caracas
      status: 'CONFIRMED',
    });
    caracasToday = await appointment(a, {
      locationId: a.caracas,
      start: '2026-11-01T00:00:00Z', // 31/10 20:00 en Caracas: hoy
      status: 'SCHEDULED',
    });
    madridYesterday = await appointment(a, {
      locationId: a.madrid,
      start: '2026-10-31T22:30:00Z', // 31/10 23:30 en Madrid: ayer
      status: 'CONFIRMED',
    });
    madridToday = await appointment(a, {
      locationId: a.madrid,
      start: '2026-10-31T23:10:00Z', // 01/11 00:10 en Madrid: hoy
      status: 'SCHEDULED',
    });
    withVoidedEntry = await appointment(a, {
      locationId: a.caracas,
      start: '2026-10-29T15:00:00Z',
      status: 'COMPLETED',
    });
    await entry(a, withVoidedEntry, true);
    withLiveEntry = await appointment(a, {
      locationId: a.caracas,
      start: '2026-10-28T15:00:00Z',
      status: 'COMPLETED',
    });
    await entry(a, withLiveEntry, false);
    withItem = await appointment(a, {
      locationId: a.caracas,
      start: '2026-10-27T15:00:00Z',
      status: 'COMPLETED',
    });
    await entry(a, withItem, false);
    itemId = await linkedItem(a, withItem);
    // Un ítem ligado a una atendida que ya reserva otra cita (próxima visita):
    // ese vínculo de la atendida no es el activo, no sale.
    movedItem = await appointment(a, {
      locationId: a.caracas,
      start: '2026-10-26T15:00:00Z',
      status: 'COMPLETED',
    });
    await entry(a, movedItem, false);
    const moved = await linkedItem(a, movedItem);
    const next = await appointment(a, {
      locationId: a.caracas,
      start: '2099-11-20T15:00:00Z',
      status: 'SCHEDULED',
    });
    await raw.appointmentPlanItem.create({
      data: {
        tenantId: a.tenantId,
        patientId: a.patientId,
        appointmentId: next,
        planItemId: moved,
      },
    });
    // Un ítem ligado a dos atendidas (empezado el 22/10 y seguido el 25/10):
    // sale solo en la última.
    laterFirst = await appointment(a, {
      locationId: a.caracas,
      start: '2026-10-22T15:00:00Z',
      status: 'COMPLETED',
    });
    await entry(a, laterFirst, false);
    laterItem = await linkedItem(a, laterFirst);
    laterSecond = await appointment(a, {
      locationId: a.caracas,
      start: '2026-10-25T15:00:00Z',
      status: 'COMPLETED',
    });
    await entry(a, laterSecond, false);
    await raw.appointmentPlanItem.create({
      data: {
        tenantId: a.tenantId,
        patientId: a.patientId,
        appointmentId: laterSecond,
        planItemId: laterItem,
      },
    });
    bAppointment = await appointment(b, {
      locationId: b.caracas,
      start: '2026-10-30T15:00:00Z',
      status: 'CONFIRMED',
    });
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await raw.$disconnect();
  });

  it('corre como dentalix_app, sin BYPASSRLS, y las tablas que lee tienen RLS forzada', async () => {
    const [who] = await prisma.$queryRaw<{ role: string; bypass: boolean }[]>`
      SELECT current_user AS role, rolbypassrls AS bypass
        FROM pg_roles WHERE rolname = current_user`;
    expect(who).toEqual({ role: 'dentalix_app', bypass: false });
    const rows = await raw.$queryRaw<
      { relname: string; enabled: boolean; forced: boolean }[]
    >`SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relname = ANY(${SOURCE_TABLES})`;
    expect(rows.map((r) => r.relname).sort()).toEqual(
      [...SOURCE_TABLES].sort(),
    );
    expect(rows.filter((r) => !r.enabled || !r.forced)).toEqual([]);
  });

  it('hoy no sale, con la zona de CADA sede alrededor de la medianoche UTC', async () => {
    const q = await list(a);
    const outcome = q.outcome!.items.map((i) => i.appointmentId);
    expect(outcome).toEqual(
      expect.arrayContaining([caracasYesterday, madridYesterday]),
    );
    expect(outcome).not.toContain(caracasToday);
    expect(outcome).not.toContain(madridToday);
    expect(q.outcome!.total).toBe(2);
  });

  it('una evolución anulada no cuenta como evolución; una viva, sí', async () => {
    const q = await list(a);
    const evolution = q.evolution!.items.map((i) => i.appointmentId);
    expect(evolution).toEqual([withVoidedEntry]);
    expect(evolution).not.toContain(withLiveEntry);
  });

  it('el ítem ligado en ACCEPTED sale con procedimiento y diente; el que reserva otra cita, no', async () => {
    const q = await list(a);
    expect(q.treatment!.items).toEqual([
      expect.objectContaining({
        appointmentId: laterSecond,
        planItemId: laterItem,
      }),
      expect.objectContaining({
        appointmentId: withItem,
        planItemId: itemId,
        procedureLabel: 'Resina',
        toothNumber: '16',
      }),
    ]);
    // El mismo ítem atendido después en otra cita COMPLETED: no sale en la primera.
    expect(q.treatment!.items.map((i) => i.appointmentId)).not.toContain(
      laterFirst,
    );
    expect(q.treatment!.items.map((i) => i.appointmentId)).not.toContain(
      movedItem,
    );
  });

  it('el filtro de sede: con solo Madrid permitida no sale nada de Caracas', async () => {
    const q = await list(a, [a.madrid]);
    expect(q.outcome!.items.map((i) => i.appointmentId)).toEqual([
      madridYesterday,
    ]);
    expect(q.evolution!.total).toBe(0);
    expect(q.treatment!.total).toBe(0);
  });

  it('RLS por clínica: B no ve nada de A aunque filtre por sus sedes', async () => {
    const qb = await list(b);
    expect(qb.outcome!.items.map((i) => i.appointmentId)).toEqual([
      bAppointment,
    ]);
    // La RLS sola ya aísla: con la clínica B fijada en la sesión y A en el
    // filtro explícito (y sus sedes), nada.
    const branches = [
      {
        timeZone: 'America/Caracas',
        locationIds: [a.caracas],
        start: new Date('2026-10-01T00:00:00Z'),
        end: new Date('2026-11-01T00:00:00Z'),
      },
    ];
    const asA = new TenantContextService();
    const crossed = new PrismaClosingQueueRepository(prisma, asA);
    const [outcome, evolution, treatment, found] = await context.run(
      b.tenantId,
      () =>
        asA.run(a.tenantId, () =>
          Promise.all([
            crossed.outcome({ branches }, 10),
            crossed.evolution({ branches }, 10),
            crossed.treatment({ branches }, 10),
            crossed.findAppointment(withItem),
          ]),
        ),
    );
    expect([outcome.total, evolution.total, treatment.total]).toEqual([
      0, 0, 0,
    ]);
    expect(found).toBeNull();
  });

  it('el descarte saca el pendiente, deja la cita igual y la BD no deja reescribirlo', async () => {
    const result = await context.run(a.tenantId, () =>
      useCases.dismiss(
        {
          section: 'OUTCOME',
          appointmentId: caracasYesterday,
          reasonCode: 'DUPLICATE_APPOINTMENT',
        },
        admin,
        'ALL',
        {
          tenantId: a.tenantId,
          locationId: null,
          actor: { userId: a.dentistId, role: ClinicRole.ADMIN },
          requestId: null,
          ip: null,
          userAgent: null,
        },
      ),
    );
    const q = await list(a);
    expect(q.outcome!.items.map((i) => i.appointmentId)).toEqual([
      madridYesterday,
    ]);
    const appt = await raw.appointment.findUniqueOrThrow({
      where: { id: caracasYesterday },
    });
    expect(appt.status).toBe('CONFIRMED');
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "closing_queue_dismissals" SET "reasonCode" = 'OTHER' WHERE "id" = ${result.id}::uuid`,
      ),
    ).rejects.toThrow();
    // CHECK: «Otro» sin texto no entra ni por SQL.
    await expect(
      raw.closingQueueDismissal.create({
        data: {
          tenantId: a.tenantId,
          section: 'EVOLUTION',
          patientId: a.patientId,
          appointmentId: withVoidedEntry,
          reasonCode: 'OTHER',
          createdById: a.dentistId,
        },
      }),
    ).rejects.toThrow(/closing_queue_dismissals_reason_text_check/);
  });
});
