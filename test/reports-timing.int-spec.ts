import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  AppointmentStatus,
  ClinicRole,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { civilPeriodByZone } from '../src/shared/time/civil-day';
import {
  PrismaTimingRepository,
  bookedMinutesSql,
  timingGroupsSql,
} from '../src/modules/reports/infrastructure/prisma-timing.repository';
import {
  GetTimingUseCase,
  TIMING_OWN_ONLY_MESSAGE,
  type TimingInput,
} from '../src/modules/reports/application/use-cases/get-timing.use-case';
import {
  classifyTiming,
  mondayOf,
  percentileCont,
  timingFigures,
  type TimingAggregate,
  type TimingFigures,
} from '../src/modules/reports/domain/timing';
import { PrismaAppointmentRepository } from '../src/modules/appointments/infrastructure/repositories/prisma-appointment.repository';
import { completedWithoutTimes } from '../src/modules/appointments/application/use-cases/list-in-clinic.use-case';
import { resetDatabase } from './support/e2e-fixtures';
import { ReportSeeder } from './support/reports-fixtures';

// DX-275 · «Tiempos» contra Postgres de verdad, como dentalix_app
// (DATABASE_URL, sin BYPASSRLS) con la clínica fijada por runWithTenant.
// `raw` (DIRECT_URL, owner) siembra datos con fechas FIJAS (sedes en
// America/Caracas, UTC−4 sin horario de verano): nada depende del reloj real.
// Las cifras se comparan con una referencia en TypeScript sobre la MISMA
// semilla (`classifyTiming` + `percentileCont`), y algunas, a mano.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const PERIOD = { from: '2026-03-02', to: '2026-03-13' };
const ZONE = 'America/Caracas';

const SOURCE_TABLES = [
  'appointments',
  'appointment_types',
  'locations',
  'provider_schedules',
  'provider_schedule_ranges',
  'provider_schedule_overrides',
  'provider_schedule_override_ranges',
  'schedule_blocks',
  'location_holidays',
  'clinic_memberships',
];

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}
const flatten = (plan: PlanNode): PlanNode[] => [
  plan,
  ...(plan.Plans ?? []).flatMap(flatten),
];

/** Hora de pared de Caracas → instante. */
const local = (day: string, hhmm: string) =>
  new Date(`${day}T${hhmm}:00.000-04:00`);
const plus = (d: Date, minutes: number) =>
  new Date(d.getTime() + minutes * 60_000);

type Who = 'norte' | 'sur';
interface Seed {
  who: Who;
  type: 'endo' | 'limpieza' | null;
  day: string;
  time: string;
  minutes: number;
  status?: AppointmentStatus;
  /** Minutos desde el inicio programado; null = sin la marca. */
  arrived?: number | null;
  seated?: number | null;
  ready?: number | null;
  deleted?: boolean;
}

// Dra. Norte (Sede Norte). 12 endodoncias de 90 min que duran ~120 (+33 %:
// avisa), 5 limpiezas de 30 que duran ~30, dos sin tiempos, dos
// incoherentes, un no-show, una cancelada, una borrada, una que siguió
// agendada y una del domingo 01/03 a las 23:00 de Caracas (03:00 UTC del
// lunes 02/03: fuera del período en la zona de la sede).
const ENDO_DAYS = [
  ['2026-03-02', '08:00'],
  ['2026-03-03', '08:00'],
  ['2026-03-04', '08:00'],
  ['2026-03-05', '08:00'],
  ['2026-03-06', '08:00'],
  ['2026-03-09', '08:00'],
  ['2026-03-10', '08:00'],
  ['2026-03-11', '08:00'],
  ['2026-03-12', '08:00'],
  ['2026-03-13', '08:00'],
  ['2026-03-02', '10:00'],
  ['2026-03-09', '10:00'],
];
const ENDO_ARRIVED = [-10, -5, 0, 3, 7, 10, 15, -15, 2, 20, 30, 1];
const ENDO_SEATED = [5, 8, 12, 10, 15, 20, 25, 0, 6, 35, 40, 9];
const ENDO_CHAIR = [110, 115, 120, 125, 130, 118, 122, 121, 119, 124, 126, 130];
const CLEAN_DAYS = [
  '2026-03-02',
  '2026-03-03',
  '2026-03-04',
  '2026-03-05',
  '2026-03-06',
];
const CLEAN_ARRIVED = [-5, 0, 2, -2, 4];
const CLEAN_SEATED = [2, 3, 10, 0, 6];
const CLEAN_CHAIR = [28, 30, 32, 29, 31];

const SEEDS: Seed[] = [
  ...ENDO_DAYS.map(([day, time], i): Seed => ({
    who: 'norte',
    type: 'endo',
    day,
    time,
    minutes: 90,
    arrived: ENDO_ARRIVED[i],
    seated: ENDO_SEATED[i],
    ready: ENDO_SEATED[i] + ENDO_CHAIR[i],
  })),
  ...CLEAN_DAYS.map((day, i): Seed => ({
    who: 'norte',
    type: 'limpieza',
    day,
    time: '11:30',
    minutes: 30,
    arrived: CLEAN_ARRIVED[i],
    seated: CLEAN_SEATED[i],
    ready: CLEAN_SEATED[i] + CLEAN_CHAIR[i],
  })),
  // Sin tiempos: completada sin el flujo, y del sillón a la salida sin «Listo».
  {
    who: 'norte',
    type: 'limpieza',
    day: '2026-03-02',
    time: '12:00',
    minutes: 30,
  },
  {
    who: 'norte',
    type: 'limpieza',
    day: '2026-03-03',
    time: '12:00',
    minutes: 30,
    arrived: 0,
    seated: 5,
  },
  // Incoherentes: 0 min en el sillón, y 5 h de espera.
  {
    who: 'norte',
    type: 'limpieza',
    day: '2026-03-04',
    time: '12:00',
    minutes: 30,
    arrived: -3,
    seated: 4,
    ready: 4,
  },
  {
    who: 'norte',
    type: null,
    day: '2026-03-05',
    time: '13:00',
    minutes: 30,
    arrived: 0,
    seated: 300,
    ready: 330,
  },
  {
    who: 'norte',
    type: null,
    day: '2026-03-06',
    time: '12:00',
    minutes: 30,
    status: 'NO_SHOW',
  },
  {
    who: 'norte',
    type: null,
    day: '2026-03-06',
    time: '12:30',
    minutes: 30,
    status: 'CANCELLED',
  },
  {
    who: 'norte',
    type: 'limpieza',
    day: '2026-03-09',
    time: '12:00',
    minutes: 30,
    arrived: 0,
    seated: 1,
    ready: 30,
    deleted: true,
  },
  {
    who: 'norte',
    type: null,
    day: '2026-03-10',
    time: '12:00',
    minutes: 30,
    status: 'SCHEDULED',
  },
  {
    who: 'norte',
    type: 'limpieza',
    day: '2026-03-01',
    time: '23:00',
    minutes: 30,
    arrived: 0,
    seated: 1,
    ready: 30,
  },
  // Dr. Sur (Sede Sur), sin tipo. El domingo 08/03 a las 23:00 de Caracas
  // (03:00 UTC del lunes 09/03) es de la semana del 02/03; el viernes 13/03 a
  // las 23:00 (03:00 UTC del sábado 14/03), del período.
  {
    who: 'sur',
    type: null,
    day: '2026-03-08',
    time: '23:00',
    minutes: 30,
    arrived: 0,
    seated: 10,
    ready: 40,
  },
  {
    who: 'sur',
    type: null,
    day: '2026-03-09',
    time: '15:00',
    minutes: 30,
    arrived: 0,
    seated: 15,
    ready: 45,
  },
  {
    who: 'sur',
    type: null,
    day: '2026-03-13',
    time: '23:00',
    minutes: 30,
    arrived: -5,
    seated: 0,
    ready: 20,
  },
];

interface Clinic {
  tenantId: string;
  norte: string;
  sur: string;
  drNorte: string;
  drSur: string;
  /** Con horario y sin citas. */
  drIdle: string;
  endo: string;
  limpieza: string;
}

async function seedClinic(tenantId: string, suffix: string): Promise<Clinic> {
  const seed = new ReportSeeder(raw, tenantId);
  const norte = await seed.location('Sede Norte');
  const sur = await seed.location('Sede Sur');
  const drNorte = await seed.provider(`Dra. Norte ${suffix}`);
  const drSur = await seed.provider(`Dr. Sur ${suffix}`);
  const drIdle = await seed.provider(`Dr. Libre ${suffix}`);
  const type = async (name: string, durationMinutes: number) =>
    (
      await raw.appointmentType.create({
        data: { tenantId, name, durationMinutes, color: '#7C3AED' },
        select: { id: true },
      })
    ).id;
  const endo = await type('Endodoncia', 90);
  const limpieza = await type('Limpieza', 30);
  const patient = await seed.patient(`Tiempos ${suffix}`);

  // Dra. Norte: lunes a viernes 08:00–12:00 en Norte; Dr. Sur: lunes a
  // miércoles 14:00–18:00 en Sur; Dr. Libre: lunes 08:00–10:00 en Norte.
  const days = (from: number, to: number, start: number, end: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      weekday: from + i,
      startMinute: start * 60,
      endMinute: end * 60,
    }));
  await seed.providerSchedule({
    providerId: drNorte,
    locationId: norte,
    ranges: days(1, 5, 8, 12),
  });
  await seed.providerSchedule({
    providerId: drSur,
    locationId: sur,
    ranges: days(1, 3, 14, 18),
  });
  await seed.providerSchedule({
    providerId: drIdle,
    locationId: norte,
    ranges: days(1, 1, 8, 10),
  });
  // Martes 10/03: solo 08:00–10:00 (excepción DX-233).
  const override = await raw.providerScheduleOverride.create({
    data: {
      tenantId,
      providerId: drNorte,
      locationId: norte,
      date: new Date('2026-03-10'),
    },
    select: { id: true },
  });
  await raw.providerScheduleOverrideRange.create({
    data: {
      tenantId,
      overrideId: override.id,
      providerId: drNorte,
      date: new Date('2026-03-10'),
      startMinute: 480,
      endMinute: 600,
    },
  });
  // Miércoles 11/03: festivo de la sede (DX-316).
  await raw.locationHoliday.create({
    data: {
      tenantId,
      locationId: norte,
      date: new Date('2026-03-11'),
      name: 'Festivo local',
    },
  });
  // Jueves 12/03: vacaciones de la Dra. Norte (DX-122, en todas las sedes);
  // viernes 13/03 10:00–12:00: cierre de la sede; y un almuerzo que SÍ admite
  // citas (no resta).
  await raw.scheduleBlock.create({
    data: {
      tenantId,
      providerId: drNorte,
      start: local('2026-03-12', '00:00'),
      end: local('2026-03-13', '00:00'),
      kind: 'VACATION',
    },
  });
  await raw.scheduleBlock.create({
    data: {
      tenantId,
      locationId: norte,
      start: local('2026-03-13', '10:00'),
      end: local('2026-03-13', '12:00'),
      kind: 'MEETING',
    },
  });
  await raw.scheduleBlock.create({
    data: {
      tenantId,
      locationId: norte,
      providerId: drNorte,
      start: local('2026-03-02', '09:30'),
      end: local('2026-03-02', '10:00'),
      kind: 'LUNCH',
      allowsBooking: true,
    },
  });

  for (const s of SEEDS) {
    const start = local(s.day, s.time);
    const mark = (offset: number | null | undefined) =>
      offset === null || offset === undefined ? null : plus(start, offset);
    await raw.appointment.create({
      data: {
        tenantId,
        locationId: s.who === 'norte' ? norte : sur,
        providerId: s.who === 'norte' ? drNorte : drSur,
        patientId: patient,
        appointmentTypeId:
          s.type === 'endo' ? endo : s.type === 'limpieza' ? limpieza : null,
        start,
        end: plus(start, s.minutes),
        status: s.status ?? 'COMPLETED',
        arrivedAt: mark(s.arrived),
        seatedAt: mark(s.seated),
        readyForCheckoutAt: mark(s.ready),
        ...(s.status === 'CANCELLED'
          ? {
              cancelledAt: plus(start, -1440),
              cancelledByKind: 'PATIENT_LINK' as const,
              noticeMinutes: 1440,
              lateCancellation: false,
            }
          : {}),
        ...(s.deleted ? { deletedAt: local('2026-03-20', '10:00') } : {}),
      },
    });
  }
  return { tenantId, norte, sur, drNorte, drSur, drIdle, endo, limpieza };
}

/** El día civil de Caracas de la cita (las semillas lo dan en hora de pared). */
const inPeriod = (s: Seed) => s.day >= PERIOD.from && s.day <= PERIOD.to;

/** Referencia: las cifras de un grupo de semillas, en TypeScript. */
function reference(seeds: Seed[]): TimingFigures {
  const completed = seeds.filter(
    (s) =>
      inPeriod(s) && !s.deleted && (s.status ?? 'COMPLETED') === 'COMPLETED',
  );
  const samples = completed.map((s) => {
    const start = local(s.day, s.time);
    const mark = (o: number | null | undefined) =>
      o === null || o === undefined ? null : plus(start, o);
    return classifyTiming({
      start,
      end: plus(start, s.minutes),
      arrivedAt: mark(s.arrived),
      seatedAt: mark(s.seated),
      readyForCheckoutAt: mark(s.ready),
    });
  });
  const measured = samples.filter((x) => x.kind === 'MEASURED');
  const avg = (xs: number[]) =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  const pick = (f: (x: (typeof measured)[number]) => number | null) =>
    measured.map((x) => f(x) as number);
  const aggregate: TimingAggregate = {
    completed: samples.length,
    measured: measured.length,
    withoutTimes: samples.filter((x) => x.kind === 'WITHOUT_TIMES').length,
    incoherent: samples.filter((x) => x.kind === 'INCOHERENT').length,
    waitAvg: avg(pick((x) => x.waitMinutes)),
    waitP90: percentileCont(
      pick((x) => x.waitMinutes),
      0.9,
    ),
    startDelayAvg: avg(pick((x) => x.startDelayMinutes)),
    startDelayP90: percentileCont(
      pick((x) => x.startDelayMinutes),
      0.9,
    ),
    durationAvg: avg(pick((x) => x.durationMinutes)),
    durationP90: percentileCont(
      pick((x) => x.durationMinutes),
      0.9,
    ),
    plannedAvg: avg(pick((x) => x.plannedMinutes)),
  };
  return timingFigures(aggregate);
}

describe('«Tiempos» en la BD (DX-275, int)', () => {
  const context = new TenantContextService();
  const prisma = new PrismaService(context);
  const repo = new PrismaTimingRepository(prisma, context);
  const useCase = new GetTimingUseCase(repo);
  let a: Clinic;
  let b: Clinic;
  let admin: string;

  const input = (over: Partial<TimingInput> = {}): TimingInput => ({
    ...PERIOD,
    actor: { userId: admin, role: ClinicRole.ADMIN },
    allowedLocationIds: 'ALL',
    ...over,
  });
  const run = <T>(clinic: Clinic, fn: () => Promise<T>) =>
    context.run(clinic.tenantId, fn);

  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(raw);
    for (const sub of ['dx275-a', 'dx275-b']) {
      await raw.tenant.create({ data: { name: sub, subdomain: sub } });
    }
    const tenants = await raw.tenant.findMany({
      where: { subdomain: { in: ['dx275-a', 'dx275-b'] } },
      orderBy: { subdomain: 'asc' },
    });
    a = await seedClinic(tenants[0].id, 'A');
    b = await seedClinic(tenants[1].id, 'B');
    admin = '00000000-0000-4000-8275-000000000001';
  }, 180_000);

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

  it('totales, por profesional y por semana = la referencia en TypeScript (p90 con percentile_cont)', async () => {
    const report = await run(a, () => useCase.execute(input()));
    expect(report.totals).toEqual(reference(SEEDS));
    // A mano: 12 endodoncias + 5 limpiezas + 3 de Sur medidas; 2 sin
    // tiempos; 2 incoherentes (0 min en el sillón, 5 h de espera).
    expect(report.totals).toMatchObject({
      completed: 24,
      measured: 20,
      withoutTimes: 2,
      incoherent: 2,
    });
    const norte = report.byProfessional.find(
      (r) => r.providerId === a.drNorte,
    )!;
    const sur = report.byProfessional.find((r) => r.providerId === a.drSur)!;
    expect(norte).toEqual({
      providerId: a.drNorte,
      providerName: 'Dra. Norte A',
      ...reference(SEEDS.filter((s) => s.who === 'norte')),
    });
    expect(sur).toEqual({
      providerId: a.drSur,
      providerName: 'Dr. Sur A',
      ...reference(SEEDS.filter((s) => s.who === 'sur')),
    });
    // Semanas en la zona de la sede: el domingo 08/03 23:00 es del 02/03.
    expect(report.byWeek.map((w) => w.weekStart)).toEqual([
      '2026-03-02',
      '2026-03-09',
    ]);
    for (const week of report.byWeek) {
      expect(week).toMatchObject(
        reference(SEEDS.filter((s) => mondayOf(s.day) === week.weekStart)),
      );
    }
    expect(report.byWeek[1]).toMatchObject({
      from: '2026-03-09',
      to: '2026-03-13',
    });
  });

  it('por tipo: la endodoncia (90 min, ~120 reales en 12 citas) avisa; la limpieza no; «Sin tipo» al final', async () => {
    const report = await run(a, () => useCase.execute(input()));
    expect(
      report.byAppointmentType.map((r) => [
        r.appointmentTypeName,
        r.catalogDurationMinutes,
        r.measured,
        r.exceedsPlanned,
      ]),
    ).toEqual([
      ['Endodoncia', 90, 12, true],
      ['Limpieza', 30, 5, false],
      ['Sin tipo de cita', null, 3, false],
    ]);
    const endo = report.byAppointmentType[0];
    expect(endo).toMatchObject(
      reference(SEEDS.filter((s) => s.type === 'endo')),
    );
    expect(endo.plannedAvgMinutes).toBe(90);
    expect(endo.durationVsPlannedPercent).toBe(35.2);
    expect(report.byAppointmentType[1]).toMatchObject(
      reference(SEEDS.filter((s) => s.type === 'limpieza')),
    );
  });

  it('ocupación: horario − excepción − festivo − vacaciones − cierre; citadas, atendidas, no-show y libres por semana', async () => {
    const report = await run(a, () => useCase.execute(input()));
    const norte = report.occupancy.professionals.find(
      (p) => p.providerId === a.drNorte,
    )!;
    // Semana 1: 5 × 240. Semana 2: lunes 240, martes 120 (excepción),
    // miércoles festivo, jueves de vacaciones, viernes 240 − 120 (cierre).
    expect(norte.weeks.map((w) => w.availableMinutes)).toEqual([1200, 480]);
    // Citadas (no canceladas ni borradas, también la que siguió agendada y
    // el no-show): semana 1 = 6×90 + 5×30 + 5×30 (sin tiempos ×2,
    // incoherentes ×2, no-show) = 840; semana 2 = 6×90 + 30 (agendada) = 570.
    expect(norte.weeks.map((w) => w.bookedMinutes)).toEqual([840, 570]);
    expect(norte.weeks.map((w) => w.attendedMinutes)).toEqual([810, 540]);
    expect(norte.weeks.map((w) => w.noShowMinutes)).toEqual([30, 0]);
    expect(norte.weeks.map((w) => w.freeMinutes)).toEqual([360, 0]);
    expect(norte).toMatchObject({
      hasSchedule: true,
      availableMinutes: 1680,
      bookedMinutes: 1410,
      attendedMinutes: 1350,
      noShowMinutes: 30,
      freeMinutes: 360,
      occupancyPercent: 80.4,
    });
    const sur = report.occupancy.professionals.find(
      (p) => p.providerId === a.drSur,
    )!;
    expect(sur).toMatchObject({
      availableMinutes: 1440,
      attendedMinutes: 90,
      occupancyPercent: 6.3,
    });
    // Con horario y sin citas: sale, a 0 %.
    const idle = report.occupancy.professionals.find(
      (p) => p.providerId === a.drIdle,
    )!;
    expect(idle).toMatchObject({
      availableMinutes: 240,
      bookedMinutes: 0,
      freeMinutes: 240,
      occupancyPercent: 0,
    });
    expect(report.occupancy.totals).toMatchObject({
      availableMinutes: 1680 + 1440 + 240,
      attendedMinutes: 1350 + 90,
    });
  });

  it('filtro por sede y DENTIST: solo lo suyo; pedir a otro es 403', async () => {
    const sur = await run(a, () =>
      useCase.execute(input({ locationId: a.sur })),
    );
    expect(sur.totals).toEqual(reference(SEEDS.filter((s) => s.who === 'sur')));
    expect(sur.occupancy.professionals.map((p) => p.providerId)).toEqual([
      a.drSur,
    ]);

    const own = await run(a, () =>
      useCase.execute(
        input({ actor: { userId: a.drNorte, role: ClinicRole.DENTIST } }),
      ),
    );
    expect(own.scope).toBe('OWN');
    expect(own.byProfessional.map((r) => r.providerId)).toEqual([a.drNorte]);
    expect(own.totals).toEqual(
      reference(SEEDS.filter((s) => s.who === 'norte')),
    );
    expect(own.occupancy.professionals.map((p) => p.providerId)).toEqual([
      a.drNorte,
    ]);
    expect(own.options.professionals.map((p) => p.userId)).toEqual([a.drNorte]);
    await expect(
      run(a, () =>
        useCase.execute(
          input({
            actor: { userId: a.drNorte, role: ClinicRole.DENTIST },
            providerId: a.drSur,
          }),
        ),
      ),
    ).rejects.toThrow(new ForbiddenException(TIMING_OWN_ONLY_MESSAGE));
  });

  it('una sede de otra clínica es 404; un profesional de otra clínica da un informe vacío', async () => {
    await expect(
      run(a, () => useCase.execute(input({ locationId: b.norte }))),
    ).rejects.toBeInstanceOf(NotFoundException);
    const report = await run(a, () =>
      useCase.execute(input({ providerId: b.drNorte })),
    );
    expect(report).toMatchObject({
      byProfessional: [],
      occupancy: { professionals: [] },
      hasData: false,
    });
  });

  it('la RLS sola ya aísla: las consultas de B con la clínica A fijada → nada', async () => {
    const branches = civilPeriodByZone(
      PERIOD.from,
      PERIOD.to,
      new Map([
        [b.norte, ZONE],
        [b.sur, ZONE],
      ]),
    );
    const params = { tenantId: b.tenantId, branches };
    const [groups, booked] = await prisma.runWithTenant(a.tenantId, (tx) =>
      Promise.all([
        tx.$queryRaw<unknown[]>(timingGroupsSql(params)),
        tx.$queryRaw<unknown[]>(bookedMinutesSql(params)),
      ]),
    );
    // GROUPING SETS con () da la fila del total aunque no haya citas.
    expect(groups).toEqual([
      expect.objectContaining({ grouping: 7, completed: 0, measured: 0 }),
    ]);
    expect(booked).toEqual([]);
    const crossed = new PrismaTimingRepository(prisma, context);
    const data = await context.run(a.tenantId, () =>
      crossed.load(PERIOD, { locationIds: [b.norte, b.sur] }),
    );
    expect(data.capacities).toEqual([]);
    expect(data.booked).toEqual([]);
  });

  it('plan: las dos pasadas por citas van por índice, sin Seq Scan', async () => {
    const branches = civilPeriodByZone(
      PERIOD.from,
      PERIOD.to,
      new Map([
        [a.norte, ZONE],
        [a.sur, ZONE],
      ]),
    );
    for (const sql of [
      timingGroupsSql({ tenantId: a.tenantId, branches }),
      bookedMinutesSql({ tenantId: a.tenantId, branches }),
    ]) {
      const rows = await prisma.runWithTenant(a.tenantId, async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        return tx.$queryRaw<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(
          Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`,
        );
      });
      const nodes = flatten(rows[0]['QUERY PLAN'][0].Plan);
      const appointments = nodes.filter(
        (n) => n['Relation Name'] === 'appointments',
      );
      // Con tan pocas filas el planificador elige cualquier índice que
      // sirva (también la EXCLUDE de solapes); el índice con volumen lo fija
      // la prueba de carga (reports-timing-load.int-spec.ts).
      expect(appointments.length).toBeGreaterThan(0);
      expect(appointments.filter((n) => n['Node Type'] === 'Seq Scan')).toEqual(
        [],
      );
    }
  });

  it('panel «En clínica»: las completadas del día sin tiempos válidos (listCompletedFlow + la misma regla)', async () => {
    const appointments = new PrismaAppointmentRepository(prisma, context);
    const rows = await run(a, () =>
      appointments.listCompletedFlow({
        locationId: a.norte,
        from: local('2026-03-04', '00:00'),
        to: local('2026-03-05', '00:00'),
      }),
    );
    // Endodoncia 08:00, limpieza 11:30 y la incoherente de 12:00.
    expect(rows).toHaveLength(3);
    const flagged = completedWithoutTimes(rows);
    expect(flagged.map((f) => [f.start.toISOString(), f.timingIssue])).toEqual([
      [local('2026-03-04', '12:00').toISOString(), 'INCOHERENT'],
    ]);
    expect(flagged[0].providerName).toBe('Dra. Norte A');
    const other = await run(a, () =>
      appointments.listCompletedFlow({
        locationId: a.norte,
        from: local('2026-03-02', '00:00'),
        to: local('2026-03-03', '00:00'),
        providerId: a.drSur,
      }),
    );
    expect(other).toEqual([]);
  });
});
