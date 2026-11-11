import { AppointmentStatus, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaRecoveredSlotsRepository } from '../src/modules/reports/infrastructure/prisma-recovered-slots.repository';
import {
  GetRecoveredSlotsUseCase,
  type RecoveredSlotsReport,
} from '../src/modules/reports/application/use-cases/get-recovered-slots.use-case';
import type { AllowedLocations } from '../src/shared/tenancy/location-access';
import { utcTimestamp } from '../src/modules/reports/infrastructure/zoned-period-sql';
import { resetDatabase } from './support/e2e-fixtures';
import { ReportSeeder } from './support/reports-fixtures';

// DX-436 · «Huecos recuperados» contra Postgres de verdad, como dentalix_app
// (DATABASE_URL, sin BYPASSRLS) con la clínica fijada por runWithTenant.
// `raw` (DIRECT_URL, owner) solo siembra. Las sedes están en America/Caracas
// (UTC−4 fijo): las 09:00 de la sede son las 13:00 UTC.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };

/** Instante de la hora de pared `hhmm` del día `day` en Caracas. */
function local(day: string, hhmm: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h + 4, min));
}
const plus = (date: Date, minutes: number) =>
  new Date(date.getTime() + minutes * 60_000);

interface SeededClinic {
  tenantId: string;
  main: string;
  norte: string;
  ana: string;
  luis: string;
}

class Agenda {
  private patients = 0;
  constructor(
    private readonly seed: ReportSeeder,
    private readonly tenantId: string,
  ) {}

  /** Cada cita con su propio paciente (EXCLUDE por paciente). */
  async appointment(input: {
    locationId: string;
    providerId: string;
    start: Date;
    minutes?: number;
    status?: AppointmentStatus;
    createdAt: Date;
    cancelledAt?: Date;
    legacyCancel?: boolean;
    noShowMarkedAt?: Date;
    walkInOverbook?: boolean;
  }): Promise<{ id: string; patientId: string }> {
    const patientId = await this.seed.patient(`p${++this.patients}`);
    const status =
      input.status ??
      (input.cancelledAt || input.legacyCancel
        ? AppointmentStatus.CANCELLED
        : input.noShowMarkedAt
          ? AppointmentStatus.NO_SHOW
          : AppointmentStatus.SCHEDULED);
    const end = plus(input.start, input.minutes ?? 30);
    const notice = input.cancelledAt
      ? Math.max(
          0,
          Math.floor(
            (input.start.getTime() - input.cancelledAt.getTime()) / 60_000,
          ),
        )
      : null;
    const created = await raw.appointment.create({
      data: {
        tenantId: this.tenantId,
        locationId: input.locationId,
        patientId,
        providerId: input.providerId,
        start: input.start,
        end,
        status,
        createdAt: input.createdAt,
        ...(input.cancelledAt
          ? {
              cancelledAt: input.cancelledAt,
              cancelledByKind: 'PATIENT_LINK' as const,
              noticeMinutes: notice,
              lateCancellation: (notice ?? 0) < 24 * 60,
            }
          : {}),
        ...(input.noShowMarkedAt
          ? { noShowMarkedAt: input.noShowMarkedAt }
          : {}),
        ...(input.walkInOverbook ? { walkIn: true, overbooked: true } : {}),
      },
      select: { id: true },
    });
    return { id: created.id, patientId };
  }

  /** Un ítem del plan (precio en `currency`) ligado a la cita. */
  async linkValue(
    appointment: { id: string; patientId: string },
    currency: string,
    price: number,
    discount = 0,
  ): Promise<void> {
    const planId = await this.seed.plan({
      patientId: appointment.patientId,
      currency,
      price,
      discount,
    });
    const item = await raw.treatmentPlanItem.findFirstOrThrow({
      where: { planId },
      select: { id: true },
    });
    await raw.appointmentPlanItem.create({
      data: {
        tenantId: this.tenantId,
        patientId: appointment.patientId,
        appointmentId: appointment.id,
        planItemId: item.id,
      },
    });
  }
}

const slotIso = (start: Date, minutes: number, providerId: string) => ({
  start: start.toISOString(),
  end: plus(start, minutes).toISOString(),
  providerId,
  chairId: null,
});

/**
 * La agenda fija de octubre de la clínica A (sede principal salvo S7):
 * - S1 Ana 07/10 11:00, cancelada a las 9:00; F1 creada a las 9:40 desde un
 *   pendiente, con un ítem de 50 USD − 4,50 → rellenado, por la lista, 40 min.
 * - S2 Ana 08/10 10:00–11:00, cancelada el 06/10; F2 10:15–10:45 creada 26 h
 *   después → parcial (30 min), sin valorar.
 * - S3 Ana 09/10 9:00, cancelada el 08/10; W sobrecupo (atender sin cita)
 *   creado ANTES de la cancelación → no recuperado.
 * - S4 Luis 14/10 9:00, cancelada; X de Ana a la misma hora → no recuperado.
 * - S5 Ana 15/10 9:00 cancelada a las 8:30 (30 min de aviso) → no es hueco,
 *   pero cuenta en la tasa de cancelación.
 * - S6 Ana 16/10 9:00, cancelada el 15/10 08:00; M (creada el 01/10 para el
 *   20/10, «Adelantar si hay hueco») movida al hueco a las 10:00 por una oferta
 *   ACEPTADA, con un ítem de 1000 VES → rellenado, por la lista, 120 min.
 * - S7 Ana en la sede Norte 21/10 9:00, cancelada el 20/10 08:00; F7 a las
 *   9:00 → rellenado, 60 min, sin valorar.
 * - L 22/10 cancelada sin hora (antigua): solo tasa de cancelación.
 * - NS Ana 23/10 9:00 inasistencia marcada el día antes → hueco, sin relleno.
 * - B Ana 31/10 21:00 (01/11 01:00 UTC) cancelada el 30/10 → del período.
 * - N Ana 01/11 01:00 (05:00 UTC): fuera del período.
 */
async function seedClinicA(): Promise<SeededClinic> {
  const tenant = await raw.tenant.create({
    data: { name: 'dx436-a', subdomain: 'dx436-a' },
  });
  const seed = new ReportSeeder(raw, tenant.id);
  const main = await seed.location('Sede principal');
  const norte = await seed.location('Sede Norte');
  const ana = (await seed.dentist()).userId;
  const luis = await seed.provider('Dr. Luis Bravo');
  const agenda = new Agenda(seed, tenant.id);
  const at = { locationId: main, providerId: ana };

  // S1 + F1 (pendiente de la lista resuelto con F1).
  await agenda.appointment({
    ...at,
    start: local('2026-10-07', '11:00'),
    createdAt: local('2026-10-01', '09:00'),
    cancelledAt: local('2026-10-07', '09:00'),
  });
  const f1 = await agenda.appointment({
    ...at,
    start: local('2026-10-07', '11:00'),
    createdAt: local('2026-10-07', '09:40'),
  });
  await raw.appointmentWaitlistEntry.create({
    data: {
      tenantId: tenant.id,
      locationId: main,
      patientId: f1.patientId,
      status: 'SCHEDULED',
      resolvedAppointmentId: f1.id,
      resolvedAt: local('2026-10-07', '09:40'),
    },
  });
  await agenda.linkValue(f1, 'USD', 50, 4.5);

  // S2 + F2 parcial.
  await agenda.appointment({
    ...at,
    start: local('2026-10-08', '10:00'),
    minutes: 60,
    createdAt: local('2026-10-01', '09:00'),
    cancelledAt: local('2026-10-06', '08:00'),
  });
  await agenda.appointment({
    ...at,
    start: local('2026-10-08', '10:15'),
    createdAt: local('2026-10-07', '10:00'),
  });

  // S3 + sobrecupo anterior a la cancelación.
  await agenda.appointment({
    ...at,
    start: local('2026-10-09', '09:00'),
    createdAt: local('2026-10-01', '09:00'),
    cancelledAt: local('2026-10-08', '11:00'),
  });
  await agenda.appointment({
    ...at,
    start: local('2026-10-09', '09:00'),
    status: AppointmentStatus.COMPLETED,
    createdAt: local('2026-10-08', '08:00'),
    walkInOverbook: true,
  });

  // S4 (Luis) + X (Ana).
  await agenda.appointment({
    locationId: main,
    providerId: luis,
    start: local('2026-10-14', '09:00'),
    createdAt: local('2026-10-01', '09:00'),
    cancelledAt: local('2026-10-13', '09:00'),
  });
  await agenda.appointment({
    ...at,
    start: local('2026-10-14', '09:00'),
    createdAt: local('2026-10-13', '10:00'),
  });

  // S5 tardía (30 min de aviso).
  await agenda.appointment({
    ...at,
    start: local('2026-10-15', '09:00'),
    createdAt: local('2026-10-01', '09:00'),
    cancelledAt: local('2026-10-15', '08:30'),
  });

  // S6 + M adelantada por una oferta aceptada.
  const s6Start = local('2026-10-16', '09:00');
  await agenda.appointment({
    ...at,
    start: s6Start,
    createdAt: local('2026-10-01', '09:00'),
    cancelledAt: local('2026-10-15', '08:00'),
  });
  const m = await agenda.appointment({
    ...at,
    start: s6Start,
    createdAt: local('2026-10-01', '10:00'),
  });
  await raw.auditEvent.create({
    data: {
      tenantId: tenant.id,
      locationId: main,
      actorUserId: ana,
      actorRole: 'DENTIST',
      action: 'UPDATE',
      resourceType: 'APPOINTMENT',
      resourceId: m.id,
      occurredAt: local('2026-10-15', '10:00'),
      metadata: {
        origin: 'PUBLIC_LINK',
        reason: 'OFFER_ACCEPTED',
        move: {
          from: slotIso(local('2026-10-20', '09:00'), 30, ana),
          to: slotIso(s6Start, 30, ana),
        },
      },
    },
  });
  // Un movimiento DENTRO del hueco (no lo mete en él) no cambia la llegada.
  await raw.auditEvent.create({
    data: {
      tenantId: tenant.id,
      locationId: main,
      actorUserId: ana,
      actorRole: 'DENTIST',
      action: 'UPDATE',
      resourceType: 'APPOINTMENT',
      resourceId: m.id,
      occurredAt: local('2026-10-15', '11:00'),
      metadata: {
        reason: 'APPOINTMENT_MOVED',
        move: {
          from: slotIso(s6Start, 30, ana),
          to: slotIso(s6Start, 30, ana),
        },
      },
    },
  });
  const offer = (outcome: 'ACCEPTED' | 'DECLINED' | 'NO_ANSWER') => ({
    tenantId: tenant.id,
    locationId: main,
    slotStart: s6Start,
    slotEnd: plus(s6Start, 30),
    providerId: ana,
    patientId: m.patientId,
    channel: 'PHONE' as const,
    outcome,
    offerDay: new Date('2026-10-15T00:00:00Z'),
    createdById: ana,
    outcomeById: ana,
    outcomeAt: local('2026-10-15', '10:00'),
  });
  await raw.waitlistOffer.create({
    data: { ...offer('ACCEPTED'), appointmentId: m.id },
  });
  await raw.waitlistOffer.create({ data: offer('DECLINED') });
  await raw.waitlistOffer.create({ data: offer('NO_ANSWER') });
  await agenda.linkValue(m, 'VES', 1000);

  // S7 + F7 en la sede Norte.
  await agenda.appointment({
    locationId: norte,
    providerId: ana,
    start: local('2026-10-21', '09:00'),
    createdAt: local('2026-10-01', '09:00'),
    cancelledAt: local('2026-10-20', '08:00'),
  });
  await agenda.appointment({
    locationId: norte,
    providerId: ana,
    start: local('2026-10-21', '09:00'),
    createdAt: local('2026-10-20', '09:00'),
  });

  // L antigua, NS, B y N.
  await agenda.appointment({
    ...at,
    start: local('2026-10-22', '09:00'),
    createdAt: local('2026-10-01', '09:00'),
    legacyCancel: true,
  });
  await agenda.appointment({
    ...at,
    start: local('2026-10-23', '09:00'),
    createdAt: local('2026-10-01', '09:00'),
    noShowMarkedAt: local('2026-10-22', '17:00'),
  });
  await agenda.appointment({
    ...at,
    start: local('2026-10-31', '21:00'),
    createdAt: local('2026-10-01', '09:00'),
    cancelledAt: local('2026-10-30', '09:00'),
  });
  await agenda.appointment({
    ...at,
    start: local('2026-11-01', '01:00'),
    createdAt: local('2026-10-01', '09:00'),
    cancelledAt: local('2026-10-30', '09:00'),
  });
  return { tenantId: tenant.id, main, norte, ana, luis };
}

/** Clínica B: un hueco rellenado en su sede, para el aislamiento. */
async function seedClinicB(): Promise<SeededClinic> {
  const tenant = await raw.tenant.create({
    data: { name: 'dx436-b', subdomain: 'dx436-b' },
  });
  const seed = new ReportSeeder(raw, tenant.id);
  const main = await seed.location('Sede B');
  const ana = (await seed.dentist()).userId;
  const agenda = new Agenda(seed, tenant.id);
  await agenda.appointment({
    locationId: main,
    providerId: ana,
    start: local('2026-10-07', '11:00'),
    createdAt: local('2026-10-01', '09:00'),
    cancelledAt: local('2026-10-07', '09:00'),
  });
  await agenda.appointment({
    locationId: main,
    providerId: ana,
    start: local('2026-10-07', '11:00'),
    createdAt: local('2026-10-07', '09:10'),
  });
  return { tenantId: tenant.id, main, norte: main, ana, luis: ana };
}

describe('Huecos recuperados en la BD (DX-436, int)', () => {
  const context = new TenantContextService();
  const prisma = new PrismaService(context);
  const repo = new PrismaRecoveredSlotsRepository(prisma, context);
  const useCase = new GetRecoveredSlotsUseCase(repo);
  let a: SeededClinic;
  let b: SeededClinic;

  const report = (
    tenantId: string,
    input: {
      locationId?: string;
      providerId?: string;
      allowed?: AllowedLocations;
      from?: string;
      to?: string;
    } = {},
  ): Promise<RecoveredSlotsReport> =>
    context.run(tenantId, () =>
      useCase.execute({
        from: input.from ?? OCTOBER.from,
        to: input.to ?? OCTOBER.to,
        locationId: input.locationId,
        providerId: input.providerId,
        allowedLocationIds: input.allowed ?? 'ALL',
      }),
    );

  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(raw);
    a = await seedClinicA();
    b = await seedClinicB();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await raw.$disconnect();
  });

  it('corre como dentalix_app, sin BYPASSRLS', async () => {
    const [who] = await prisma.$queryRaw<
      { role: string; bypass: boolean }[]
    >`SELECT current_user AS role, rolbypassrls AS bypass
        FROM pg_roles WHERE rolname = current_user`;
    expect(who).toEqual({ role: 'dentalix_app', bypass: false });
  });

  it('los totales cuadran con la agenda fija de octubre', async () => {
    const r = await report(a.tenantId);
    expect(r.restrictedToLocations).toBe(false);
    expect(r.totals).toEqual({
      // S1, S2, S3, S4, S6, S7, NS y B (no S5, tardía; ni L, sin hora; ni N).
      freedSlots: 8,
      freedMinutes: 270,
      filledSlots: 3, // S1, S6, S7
      partiallyFilledSlots: 1, // S2
      recoveredMinutes: 120,
      filledByListSlots: 2, // S1 (pendiente) y S6 (oferta aceptada)
      fillRate: 0.5,
      filledWithin30MinRate: 0,
      filledWithin24hRate: 3 / 8, // S1 40', S6 120', S7 60' (S2: 26 h)
      meanMinutesToFill: (40 + 26 * 60 + 120 + 60) / 4,
      // 16 citas con inicio en octubre (N es de noviembre), 9 canceladas.
      cancellationRate: 9 / 16,
      offers: { sent: 3, accepted: 1, declined: 1, unanswered: 1 },
      recoveredValue: [
        { currency: 'USD', amount: 45.5 },
        { currency: 'VES', amount: 1000 },
      ],
      unvaluedRecoveredSlots: 2, // S2 y S7
    });
  });

  it('por profesional y por semana (días civiles de la sede)', async () => {
    const r = await report(a.tenantId);
    expect(
      r.byProvider.map((p) => [p.providerName, p.freedSlots, p.filledSlots]),
    ).toEqual([
      ['Dr. Luis Bravo', 1, 0],
      ['Dra. Reportes', 7, 3],
    ]);
    const weeks = Object.fromEntries(
      r.byWeek.map((w) => [w.weekStart, w.freedSlots]),
    );
    // B (31/10 21:00 en Caracas, ya 01/11 en UTC) cuenta en la semana del 26.
    expect(weeks).toEqual({
      '2026-09-28': 0,
      '2026-10-05': 3, // S1, S2, S3
      '2026-10-12': 2, // S4, S6
      '2026-10-19': 2, // S7, NS
      '2026-10-26': 1, // B
    });
    const sum = (k: 'freedSlots' | 'filledSlots' | 'recoveredMinutes') =>
      r.byWeek.reduce((s, w) => s + w[k], 0);
    expect(sum('freedSlots')).toBe(r.totals.freedSlots);
    expect(sum('filledSlots')).toBe(r.totals.filledSlots);
    expect(sum('recoveredMinutes')).toBe(r.totals.recoveredMinutes);
  });

  it('filtros: una sede, un profesional', async () => {
    const norte = await report(a.tenantId, { locationId: a.norte });
    expect(norte.totals).toMatchObject({ freedSlots: 1, filledSlots: 1 });
    const luis = await report(a.tenantId, { providerId: a.luis });
    expect(luis.totals).toMatchObject({
      freedSlots: 1,
      filledSlots: 0,
      cancellationRate: 1,
      offers: { sent: 0 },
    });
    expect(luis.byProvider.map((p) => p.providerId)).toEqual([a.luis]);
  });

  it('un miembro restringido a la sede principal no ve la Norte', async () => {
    const r = await report(a.tenantId, { allowed: [a.main] });
    expect(r.restrictedToLocations).toBe(true);
    expect(r.totals).toMatchObject({ freedSlots: 7, filledSlots: 2 });
  });

  it('aislamiento entre clínicas: cada una solo ve lo suyo', async () => {
    const rb = await report(b.tenantId);
    expect(rb.totals).toMatchObject({
      freedSlots: 1,
      filledSlots: 1,
      meanMinutesToFill: 10,
    });
    expect(rb.byProvider).toHaveLength(1);
    // Un profesional de A pedido desde B: vacío (no 500, no datos de A).
    const cross = await report(b.tenantId, { providerId: a.ana });
    expect(cross.totals.freedSlots).toBe(0);
    expect(cross.byProvider).toEqual([]);
  });

  it('la RLS sola ya aísla: el repositorio con las sedes de A y la clínica B fijada → nada', async () => {
    const data = await context.run(b.tenantId, () =>
      repo.load(OCTOBER, { locationIds: [a.main, a.norte] }),
    );
    expect(data.slots).toEqual([]);
    expect(data.counts).toEqual([]);
    expect(data.offers).toEqual([]);
  });
});

describe('Huecos recuperados con 10 000 citas (DX-436, int)', () => {
  const context = new TenantContextService();
  const prisma = new PrismaService(context);
  const repo = new PrismaRecoveredSlotsRepository(prisma, context);
  const useCase = new GetRecoveredSlotsUseCase(repo);
  let tenantId: string;
  let providers: string[];

  const PROVIDERS = 10;
  const DAYS = 31;
  const SLOTS_PER_DAY = 32; // 8:00–24:00 de 30 min

  beforeAll(async () => {
    await prisma.onModuleInit();
    const tenant = await raw.tenant.create({
      data: { name: 'dx436-perf', subdomain: 'dx436-perf' },
    });
    tenantId = tenant.id;
    const seed = new ReportSeeder(raw, tenantId);
    const location = await seed.location('Sede grande');
    providers = [(await seed.dentist()).userId];
    for (let i = 1; i < PROVIDERS; i++) {
      providers.push(await seed.provider(`Profesional ${i}`));
    }
    // Un paciente para las citas originales y otro para los rellenos de cada
    // profesional: nunca se solapan entre sí (EXCLUDE por paciente).
    const patients: string[] = [];
    for (let i = 0; i < PROVIDERS * 2; i++) {
      patients.push(await seed.patient(`perf${i}`));
    }
    const rows: Prisma.AppointmentCreateManyInput[] = [];
    for (let p = 0; p < PROVIDERS; p++) {
      for (let d = 0; d < DAYS; d++) {
        const day = `2026-10-${String(d + 1).padStart(2, '0')}`;
        for (let s = 0; s < SLOTS_PER_DAY; s++) {
          const start = plus(local(day, '08:00'), s * 30);
          const base = {
            tenantId,
            locationId: location,
            providerId: providers[p],
            start,
            end: plus(start, 30),
            createdAt: local('2026-09-01', '09:00'),
          };
          // 1 de cada 5 se cancela con 1 día de aviso y la mitad se rellena.
          if ((p + d + s) % 5 === 0) {
            const cancelledAt = plus(start, -24 * 60);
            rows.push({
              ...base,
              patientId: patients[p],
              status: 'CANCELLED',
              cancelledAt,
              cancelledByKind: 'PATIENT_LINK',
              noticeMinutes: 24 * 60,
              lateCancellation: false,
            });
            if (s % 2 === 0) {
              rows.push({
                ...base,
                patientId: patients[PROVIDERS + p],
                createdAt: plus(cancelledAt, 45),
              });
            }
          } else {
            rows.push({ ...base, patientId: patients[p] });
          }
        }
      }
    }
    for (let i = 0; i < rows.length; i += 2000) {
      await raw.appointment.createMany({ data: rows.slice(i, i + 2000) });
    }
    await raw.$executeRawUnsafe('ANALYZE "appointments"');
  }, 120_000);

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('el informe de un mes con más de 10 000 citas sale en tiempo acotado', async () => {
    const total = await raw.appointment.count({ where: { tenantId } });
    expect(total).toBeGreaterThanOrEqual(10_000);
    const started = Date.now();
    const r = await context.run(tenantId, () =>
      useCase.execute({ ...OCTOBER, allowedLocationIds: 'ALL' }),
    );
    const elapsed = Date.now() - started;
    const cancelled = await raw.appointment.count({
      where: { tenantId, status: 'CANCELLED' },
    });
    expect(r.totals.freedSlots).toBe(cancelled);
    expect(r.totals.filledSlots + r.totals.partiallyFilledSlots).toBe(
      total - PROVIDERS * DAYS * SLOTS_PER_DAY,
    );
    expect(r.totals.meanMinutesToFill).toBe(45);
    expect(r.byProvider).toHaveLength(PROVIDERS);
    // Holgado a propósito (la máquina de CI y la local van cargadas): lo que
    // se vigila es el orden de magnitud, no el milisegundo.
    expect(elapsed).toBeLessThan(15_000);
  });

  it('la búsqueda de rellenos usa un índice de citas, no un recorrido de la tabla', async () => {
    const slot = await raw.appointment.findFirstOrThrow({
      where: { tenantId, status: 'CANCELLED' },
      select: { providerId: true, locationId: true, start: true, end: true },
    });
    const plan = await prisma.runWithTenant(
      tenantId,
      (tx) =>
        tx.$queryRaw<{ 'QUERY PLAN': string }[]>`
        EXPLAIN SELECT c."id" FROM "appointments" c
         WHERE c."tenantId" = ${tenantId}::uuid
           AND c."providerId" = ${slot.providerId}::uuid
           AND c."start" < ${utcTimestamp(slot.end)}
           AND c."start" > ${utcTimestamp(slot.start)} - interval '24 hours'
           AND c."end" > ${utcTimestamp(slot.start)}
           AND c."locationId" = ${slot.locationId}::uuid
           AND c."deletedAt" IS NULL
           AND c."status" <> 'CANCELLED'`,
    );
    const text = plan.map((row) => row['QUERY PLAN']).join('\n');
    expect(text).toMatch(/Index|Bitmap/);
    expect(text).not.toMatch(/Seq Scan on appointments/);
  });
});
