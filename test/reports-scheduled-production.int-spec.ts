import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  ClinicRole,
  ExtraPermission,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaCatalogCurrencyReader } from '../src/modules/dental-catalog/infrastructure/prisma-catalog-currency-reader';
import { GetRatesForDateUseCase } from '../src/modules/exchange/application/use-cases/get-rates-for-date.use-case';
import { PrismaExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-exchange-rate.repository';
import { PrismaClinicExchangeSettingsRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-clinic-exchange-settings.repository';
import { PrismaManualExchangeRateRepository } from '../src/modules/exchange/infrastructure/repositories/prisma-manual-exchange-rate.repository';
import { PrismaScheduledProductionRepository } from '../src/modules/reports/infrastructure/prisma-scheduled-production.repository';
import {
  GetScheduledProductionUseCase,
  SCHEDULED_PRODUCTION_FORBIDDEN_MESSAGE,
  SCHEDULED_PRODUCTION_OWN_ONLY_MESSAGE,
  SCHEDULED_PRODUCTION_PERIOD_TOO_LONG_MESSAGE,
  type ScheduledProductionInput,
  type ScheduledProductionReport,
} from '../src/modules/reports/application/use-cases/get-scheduled-production.use-case';
import { resetDatabase } from './support/e2e-fixtures';
import {
  caracas,
  scheduledProductionSeeding,
  type ScheduledClinic,
} from './support/scheduled-production-fixtures';

// DX-567 · «Producción agendada y previsión del mes» contra Postgres de
// verdad, como dentalix_app (DATABASE_URL, sin BYPASSRLS) con la clínica
// fijada por runWithTenant. `raw` (DIRECT_URL, owner) solo siembra. Hoy es el
// martes 17/11/2026 a las 11:00 de Caracas (reloj inyectado). Los criterios
// del ticket, literales: 40 + 60 = 100 al día y al profesional; cancelada e
// inasistencia no suman; citas sin ítems contadas y listadas; previsión =
// producido hasta hoy + agendado pendiente (lo hecho hoy no cuenta doble).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const NOVEMBER = { from: '2026-11-01', to: '2026-11-30' };
const NOW = caracas('2026-11-17', '11:00');

const { withoutTriggers, clinic, plan, appointment, manualRate } =
  scheduledProductionSeeding(raw);

function build(clock: () => Date) {
  const context = new TenantContextService();
  const prisma = new PrismaService(context);
  const repo = new PrismaScheduledProductionRepository(prisma, context);
  // El proveedor externo NUNCA se toca: solo tasas guardadas (DX-569).
  const fetchRates = jest.fn(() =>
    Promise.reject(new Error('el proveedor no se toca')),
  );
  const rates = new GetRatesForDateUseCase(
    new PrismaExchangeRateRepository(prisma),
    { fetchRates },
    new PrismaClinicExchangeSettingsRepository(prisma, context),
    new PrismaManualExchangeRateRepository(prisma, context),
    context,
  );
  const useCase = new GetScheduledProductionUseCase(
    repo,
    new PrismaCatalogCurrencyReader(prisma, context),
    rates,
    clock,
  );
  return { context, prisma, repo, useCase, fetchRates };
}

const day = (r: ScheduledProductionReport, date: string) => {
  const found = r.byDay.find((d) => d.date === date);
  if (!found) throw new Error(`sin día ${date}`);
  return found;
};

describe('Producción agendada y previsión del mes en la BD (DX-567, int)', () => {
  const { context, prisma, repo, useCase, fetchRates } = build(() => NOW);
  let a: ScheduledClinic;
  let b: ScheduledClinic;
  let receptionId: string;

  const actor = (
    c: ScheduledClinic,
    role: ClinicRole = ClinicRole.ADMIN,
    permissions: ExtraPermission[] = [],
    userId = c.dentist.userId,
  ): ScheduledProductionInput['actor'] => ({ userId, role, permissions });

  const report = (
    c: ScheduledClinic,
    extra: Partial<ScheduledProductionInput> = {},
  ) =>
    context.run(c.tenantId, () =>
      useCase.execute({
        ...NOVEMBER,
        actor: actor(c),
        allowedLocationIds: 'ALL',
        ...extra,
      }),
    );

  /** El mes de una clínica: lo mismo en A y B (para la RLS). */
  async function seedNovember(c: ScheduledClinic): Promise<void> {
    // 10/11: dos ítems de 40 y 60 en una cita → 100. La cancelada y la
    // inasistencia (500 y 700) no suman ni cuentan.
    const [i40, i60] = await plan(c, [{ price: 40 }, { price: 60 }]);
    await appointment(c, '2026-11-10', { items: [i40, i60] });
    const [i500] = await plan(c, [{ price: 500 }]);
    await appointment(c, '2026-11-10', {
      items: [i500],
      status: 'CANCELLED',
    });
    const [i700] = await plan(c, [{ price: 700 }]);
    await appointment(c, '2026-11-10', { items: [i700], status: 'NO_SHOW' });
    // El otro profesional, en Norte: 1 000.
    const [i1000] = await plan(c, [{ price: 1000 }]);
    await appointment(c, '2026-11-10', {
      items: [i1000],
      locationId: c.norte,
      providerId: c.otherDentistId,
    });

    // 11/11: sin tratamiento ligado (cuentan y se listan): sin vínculos,
    // con solo un vínculo borrado y con un ítem de un plan borrado. No
    // cuenta la cita borrada. (Los archivados, en «casos de borde».)
    await appointment(c, '2026-11-11');
    const [i999] = await plan(c, [{ price: 999 }]);
    await appointment(c, '2026-11-11', { deletedLinks: [i999] });
    const [i444] = await plan(c, [{ price: 444 }], {
      deletedAt: caracas('2026-11-01'),
    });
    await appointment(c, '2026-11-11', { items: [i444] });
    await appointment(c, '2026-11-11', { deleted: true });

    // 12/11: una cita con un ítem PROPUESTO (ligada, 0) y una vencida sin
    // cerrar con un ítem de 80 que se reagendó al 19/11 (dos vínculos vivos):
    // cuenta una sola vez, en la de inicio más reciente.
    const [proposed] = await plan(c, [{ price: 250, status: 'PROPOSED' }]);
    await appointment(c, '2026-11-12', { items: [proposed] });
    const [i80] = await plan(c, [{ price: 80 }]);
    await appointment(c, '2026-11-12', { items: [i80] });
    await appointment(c, '2026-11-19', { items: [i80] });

    // Bolívares: 365 VES el 13/11 (tasa guardada 36,5 → 10 USD), 100 VES el
    // 14/11 (sin tasa ese día: fuera, con aviso) y 730 VES el 25/11 (futura:
    // la tasa de hoy, 36,5 → 20 USD).
    const [ves365, ves100, ves730] = await plan(
      c,
      [{ price: 365 }, { price: 100 }, { price: 730 }],
      { currency: 'VES' },
    );
    await appointment(c, '2026-11-13', { items: [ves365] });
    await appointment(c, '2026-11-14', { items: [ves100] });
    await appointment(c, '2026-11-25', { items: [ves730] });
    await manualRate(c, '2026-11-13', 'VES', '36.5');
    await manualRate(c, '2026-11-17', 'VES', '36.5');

    // Previsión: 300 realizado el 05/11 (sin cita), 200 del otro profesional
    // en Norte el 06/11, 50 realizado HOY en la cita de hoy (agendado y
    // producido, nunca pendiente) y 120 aceptado en una cita del 20/11.
    await plan(c, [
      {
        price: 300,
        status: 'DONE',
        completedAt: caracas('2026-11-05'),
        performedLocationId: c.main,
        performedById: c.dentist.userId,
      },
    ]);
    await plan(c, [
      {
        price: 200,
        status: 'DONE',
        completedAt: caracas('2026-11-06'),
        performedLocationId: c.norte,
        performedById: c.otherDentistId,
      },
    ]);
    const [today50] = await plan(c, [
      {
        price: 60,
        discount: 10,
        status: 'DONE',
        completedAt: caracas('2026-11-17', '10:30'),
        performedLocationId: c.main,
        performedById: c.dentist.userId,
      },
    ]);
    await appointment(c, '2026-11-17', {
      items: [today50],
      status: 'COMPLETED',
    });
    const [i120] = await plan(c, [{ price: 120 }]);
    await appointment(c, '2026-11-20', { items: [i120] });
    // Un realizado anterior a DX-050 (sin sede ni fecha): aviso aparte.
    await c.seed.unattributedDone({
      patientId: c.patientId,
      currency: 'USD',
      price: 75,
    });
    // Fuera del período (octubre): no entra en noviembre.
    const [october] = await plan(c, [{ price: 9000 }]);
    await appointment(c, '2026-10-30', { items: [october] });
  }

  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(raw);
    a = await clinic('dx567-a');
    b = await clinic('dx567-b');
    await seedNovember(a);
    await seedNovember(b);
    receptionId = await a.seed.provider('Recepción A');
    await raw.clinicMembership.updateMany({
      where: { tenantId: a.tenantId, userId: receptionId },
      data: { role: ClinicRole.RECEPTION },
    });
  }, 120_000);

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('ADMIN: 40 + 60 = 100 al día y al profesional; cancelada e inasistencia no suman', async () => {
    const r = await report(a);
    expect(r.scope).toBe('CLINIC');
    expect(r.currency).toBe('USD');
    expect(r.restrictedToLocations).toBe(false);
    expect(r.byDay).toHaveLength(30);
    expect(r.byDay[0].date).toBe('2026-11-01');
    expect(r.byDay[29].date).toBe('2026-11-30');
    expect(day(r, '2026-11-10')).toEqual({
      date: '2026-11-10',
      scheduledAmount: 1100,
      appointments: 2,
      appointmentsWithoutItems: 0,
    });
    expect(r.byDayAndProfessional).toEqual(
      expect.arrayContaining([
        {
          date: '2026-11-10',
          professionalId: a.dentist.userId,
          scheduledAmount: 100,
          appointments: 1,
        },
        {
          date: '2026-11-10',
          professionalId: a.otherDentistId,
          scheduledAmount: 1000,
          appointments: 1,
        },
      ]),
    );
    // 100 + 1 000 + 10 + 50 + 80 + 120 + 20; 13 citas, 3 sin tratamiento.
    expect(r.totals).toEqual({
      scheduledAmount: 1380,
      appointments: 13,
      appointmentsWithoutItems: 3,
    });
    expect(r.byProfessional).toEqual([
      {
        professionalId: a.otherDentistId,
        name: 'Dr. Otro dx567-a',
        scheduledAmount: 1000,
        appointments: 1,
        appointmentsWithoutItems: 0,
      },
      {
        professionalId: a.dentist.userId,
        name: 'Dra. Reportes',
        scheduledAmount: 380,
        appointments: 12,
        appointmentsWithoutItems: 3,
      },
    ]);
    expect(r.options.locations.map((l) => l.id)).toEqual([a.main, a.norte]);
    expect(r.options.professionals.map((p) => p.userId).sort()).toEqual(
      [a.dentist.userId, a.otherDentistId].sort(),
    );
    expect(r.definitions.map((d) => d.key)).toEqual([
      'SCHEDULED',
      'WITHOUT_ITEMS',
      'PRODUCED_TO_DATE',
      'SCHEDULED_PENDING',
      'FORECAST',
      'WITHOUT_RATE',
    ]);
  });

  it('citas sin tratamiento ligado: se cuentan (no suman 0 en silencio) y se listan', async () => {
    const r = await report(a);
    expect(day(r, '2026-11-11')).toEqual({
      date: '2026-11-11',
      scheduledAmount: 0,
      appointments: 3,
      appointmentsWithoutItems: 3,
    });
    // Un ítem propuesto ligado: la cita tiene tratamiento (vale 0).
    expect(day(r, '2026-11-12')).toMatchObject({
      scheduledAmount: 0,
      appointments: 2,
      appointmentsWithoutItems: 0,
    });
    const list = await context.run(a.tenantId, () =>
      useCase.unlinked({
        ...NOVEMBER,
        actor: actor(a),
        allowedLocationIds: 'ALL',
      }),
    );
    expect(list.total).toBe(3);
    expect(list.page).toBe(1);
    expect(list.pageSize).toBe(25);
    expect(list.items.map((i) => i.start.toISOString())).toEqual(
      [...list.items.map((i) => i.start.toISOString())].sort(),
    );
    expect(list.items[0]).toMatchObject({
      status: 'SCHEDULED',
      patientId: a.patientId,
      patientName: 'Paciente dx567-a',
      appointmentTypeName: null,
      professionalId: a.dentist.userId,
      professionalName: 'Dra. Reportes',
      locationId: a.main,
      locationName: 'Sede principal',
      timeZone: 'America/Caracas',
    });
    const second = await context.run(a.tenantId, () =>
      useCase.unlinked({
        ...NOVEMBER,
        actor: actor(a),
        allowedLocationIds: 'ALL',
        page: 2,
        pageSize: 2,
      }),
    );
    expect(second).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(second.items).toHaveLength(1);
    const beyond = await context.run(a.tenantId, () =>
      useCase.unlinked({
        ...NOVEMBER,
        actor: actor(a),
        allowedLocationIds: 'ALL',
        page: 9,
        pageSize: 2,
      }),
    );
    expect(beyond).toMatchObject({ items: [], total: 3 });
  });

  it('un ítem con dos vínculos vivos cuenta una vez, en la cita de inicio más reciente', async () => {
    const r = await report(a);
    expect(day(r, '2026-11-12').scheduledAmount).toBe(0);
    expect(day(r, '2026-11-19')).toMatchObject({
      scheduledAmount: 80,
      appointments: 1,
    });
    // Un período que solo ve la cita vieja no recupera el ítem.
    const old = await report(a, { from: '2026-11-12', to: '2026-11-12' });
    expect(old.totals.scheduledAmount).toBe(0);
  });

  it('otra moneda: tasa guardada del día (futura: la de hoy); sin tasa → fuera y aviso', async () => {
    const r = await report(a);
    expect(day(r, '2026-11-13').scheduledAmount).toBe(10);
    expect(day(r, '2026-11-14')).toMatchObject({
      scheduledAmount: 0,
      appointments: 1,
    });
    expect(day(r, '2026-11-25').scheduledAmount).toBe(20);
    expect(r.withoutRate).toEqual({ appointments: 1, items: 1 });
    expect(r.warnings).toContain('WITHOUT_RATE');
    expect(fetchRates).not.toHaveBeenCalled();
  });

  it('previsión = producido hasta hoy + agendado pendiente; lo hecho hoy no cuenta doble', async () => {
    const r = await report(a);
    expect(r.forecast).toEqual({
      month: '2026-11',
      today: '2026-11-17',
      // 300 + 200 + 50 (hoy, en una cita de hoy).
      producedToDate: 550,
      // 80 (19/11) + 120 (20/11) + 20 (730 VES el 25/11); el de hoy, no.
      scheduledPending: 220,
      forecast: 770,
      itemsWithoutRate: 0,
    });
    expect(day(r, '2026-11-17').scheduledAmount).toBe(50);
    expect(r.unattributedDone).toBe(1);
    expect(r.warnings).toEqual(['WITHOUT_RATE', 'UNATTRIBUTED_DONE']);
    // La previsión no depende del período elegido.
    const october = await report(a, { from: '2026-10-01', to: '2026-10-31' });
    expect(october.forecast).toEqual(r.forecast);
    expect(october.totals).toEqual({
      scheduledAmount: 9000,
      appointments: 1,
      appointmentsWithoutItems: 0,
    });
  });

  it('DENTIST sin permiso: solo lo suyo (scope OWN); otro profesional es 403', async () => {
    const r = await report(a, { actor: actor(a, ClinicRole.DENTIST) });
    expect(r.scope).toBe('OWN');
    expect(r.filters.providerId).toBe(a.dentist.userId);
    expect(r.totals).toEqual({
      scheduledAmount: 380,
      appointments: 12,
      appointmentsWithoutItems: 3,
    });
    expect(r.byProfessional.map((p) => p.professionalId)).toEqual([
      a.dentist.userId,
    ]);
    expect(r.options.professionals.map((p) => p.userId)).toEqual([
      a.dentist.userId,
    ]);
    expect(r.forecast).toMatchObject({
      producedToDate: 350,
      scheduledPending: 220,
      forecast: 570,
    });
    expect(r.unattributedDone).toBe(0);
    await expect(
      report(a, {
        actor: actor(a, ClinicRole.DENTIST),
        providerId: a.otherDentistId,
      }),
    ).rejects.toThrow(SCHEDULED_PRODUCTION_OWN_ONLY_MESSAGE);
    // La lista sin tratamiento, igual: solo sus citas.
    const own = await context.run(a.tenantId, () =>
      useCase.unlinked({
        ...NOVEMBER,
        actor: actor(a, ClinicRole.DENTIST),
        allowedLocationIds: 'ALL',
      }),
    );
    expect(own.total).toBe(3);
  });

  it('ADMIN filtra por profesional; FINANCIAL_REPORTS_VIEW ve la clínica; recepción sin él, 403', async () => {
    const other = await report(a, { providerId: a.otherDentistId });
    expect(other.totals.scheduledAmount).toBe(1000);
    expect(other.forecast).toMatchObject({
      producedToDate: 200,
      scheduledPending: 0,
      forecast: 200,
    });
    const financial = await report(a, {
      actor: actor(
        a,
        ClinicRole.RECEPTION,
        [ExtraPermission.FINANCIAL_REPORTS_VIEW],
        receptionId,
      ),
    });
    expect(financial.scope).toBe('CLINIC');
    expect(financial.totals.scheduledAmount).toBe(1380);
    for (const role of [ClinicRole.RECEPTION, ClinicRole.ASSISTANT]) {
      await expect(
        report(a, { actor: actor(a, role, [], receptionId) }),
      ).rejects.toThrow(SCHEDULED_PRODUCTION_FORBIDDEN_MESSAGE);
    }
  });

  it('restringido a una sede (DX-089): solo esa; otra sede es 403; período > 62 días es 400', async () => {
    const r = await report(a, { allowedLocationIds: [a.main] });
    expect(r.restrictedToLocations).toBe(true);
    expect(r.options.locations.map((l) => l.id)).toEqual([a.main]);
    expect(r.totals.scheduledAmount).toBe(380);
    expect(r.forecast).toMatchObject({
      producedToDate: 350,
      scheduledPending: 220,
    });
    // Un realizado sin sede no es de ninguna: no se avisa a quien no ve todas.
    expect(r.unattributedDone).toBe(0);
    await expect(
      report(a, { allowedLocationIds: [a.main], locationId: a.norte }),
    ).rejects.toThrow(ForbiddenException);
    // Una sede de otra clínica: el mismo 403.
    await expect(report(a, { locationId: b.main })).rejects.toThrow(
      'No tienes acceso a esta sede.',
    );
    const norte = await report(a, { locationId: a.norte });
    expect(norte.totals.scheduledAmount).toBe(1000);
    await expect(
      report(a, { from: '2026-10-01', to: '2026-12-02' }),
    ).rejects.toThrow(SCHEDULED_PRODUCTION_PERIOD_TOO_LONG_MESSAGE);
  });

  it('RLS: otra clínica no se ve (filtros de B con A fijada → nada)', async () => {
    const own = await report(b);
    expect(own.totals.scheduledAmount).toBe(1380);
    const scope = {
      locationIds: [b.main, b.norte],
      includeWithoutLocation: false,
      currency: 'USD',
    };
    const crossed = await context.run(a.tenantId, () =>
      repo.scheduled(NOVEMBER, scope),
    );
    expect(crossed.appointments).toEqual([]);
    expect(crossed.amounts).toEqual([]);
    // La RLS sola ya aísla: el tenant explícito de B con la clínica A fijada
    // en la transacción → nada.
    const asB = new TenantContextService();
    const crossedRepo = new PrismaScheduledProductionRepository(prisma, asB);
    const rls = await context.run(a.tenantId, () =>
      asB.run(b.tenantId, () =>
        Promise.all([
          crossedRepo.scheduled(NOVEMBER, scope),
          crossedRepo.listUnlinked(NOVEMBER, scope, { skip: 0, take: 25 }),
        ]),
      ),
    );
    expect(rls[0].appointments).toEqual([]);
    expect(rls[0].amounts).toEqual([]);
    expect(rls[1]).toEqual({ items: [], total: 0 });
    // La previsión ni siquiera ve las sedes de B: sin sede activa, 409.
    await expect(
      context.run(a.tenantId, () =>
        asB.run(b.tenantId, () => crossedRepo.forecast(NOW, scope, null)),
      ),
    ).rejects.toThrow(ConflictException);
  });
});

describe('Producción agendada: casos de borde (DX-567, int)', () => {
  const { context, prisma, useCase, fetchRates } = build(() => NOW);
  let c: ScheduledClinic;
  let archived: string;

  const report = (extra: Partial<ScheduledProductionInput> = {}) =>
    context.run(c.tenantId, () =>
      useCase.execute({
        ...NOVEMBER,
        actor: {
          userId: c.dentist.userId,
          role: ClinicRole.ADMIN,
          permissions: [],
        },
        allowedLocationIds: 'ALL',
        ...extra,
      }),
    );

  beforeAll(async () => {
    await prisma.onModuleInit();
    // Tasas AUTOMÁTICAS: sin la caché del proveedor de ese día, «sin tasa»
    // (nunca se le llama). El 06/11 no tiene caché en esta base.
    c = await clinic('dx567-edge', { rateSource: 'AUTOMATIC' });
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: '2026-11-06' },
    });

    // Paciente ARCHIVADO (deletedAt): sus citas siguen contando y la sin
    // tratamiento se lista marcada.
    archived = await c.seed.patient('Archivado');
    const [i333] = await plan(c, [{ price: 333 }], { patientId: archived });
    await appointment(c, '2026-11-03', { items: [i333], patientId: archived });
    await appointment(c, '2026-11-04', { patientId: archived });
    await raw.patient.update({
      where: { id: archived },
      data: { deletedAt: caracas('2026-11-12') },
    });

    // Reagendado a una cita nueva que luego se CANCELÓ: cuenta en la vieja.
    const [i70] = await plan(c, [{ price: 70 }]);
    await appointment(c, '2026-11-05', { items: [i70] });
    await appointment(c, '2026-11-21', { items: [i70], status: 'CANCELLED' });

    // Aceptado ligado a una cita de este mes y a una del siguiente: cuenta en
    // la de diciembre (no es pendiente de noviembre).
    const [i25] = await plan(c, [{ price: 25 }]);
    await appointment(c, '2026-11-24', { items: [i25] });
    await appointment(c, '2026-12-03', { items: [i25] });

    // Bolívares sin tasa del día (AUTOMÁTICA, sin caché).
    const [ves] = await plan(c, [{ price: 500 }], { currency: 'VES' });
    await appointment(c, '2026-11-06', { items: [ves] });

    // Realizado del mes SIN sede (ni quién): fuera de lo producido, avisado.
    await plan(c, [
      { price: 40, status: 'DONE', completedAt: caracas('2026-11-10') },
    ]);
  }, 60_000);

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('las citas de un paciente archivado cuentan; la sin tratamiento se lista con patientArchived', async () => {
    const r = await report();
    expect(r.byDay.find((d) => d.date === '2026-11-03')).toEqual({
      date: '2026-11-03',
      scheduledAmount: 333,
      appointments: 1,
      appointmentsWithoutItems: 0,
    });
    expect(r.byDay.find((d) => d.date === '2026-11-04')).toMatchObject({
      appointments: 1,
      appointmentsWithoutItems: 1,
    });
    const list = await context.run(c.tenantId, () =>
      useCase.unlinked({
        ...NOVEMBER,
        actor: {
          userId: c.dentist.userId,
          role: ClinicRole.ADMIN,
          permissions: [],
        },
        allowedLocationIds: 'ALL',
      }),
    );
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      patientId: archived,
      patientName: 'Paciente Archivado',
      patientArchived: true,
    });
  });

  it('reagendado a una cita nueva cancelada: cuenta en la vieja', async () => {
    const r = await report();
    expect(r.byDay.find((d) => d.date === '2026-11-05')?.scheduledAmount).toBe(
      70,
    );
    expect(r.byDay.find((d) => d.date === '2026-11-21')).toMatchObject({
      scheduledAmount: 0,
      appointments: 0,
    });
  });

  it('aceptado ligado a este mes y al siguiente: cuenta en diciembre y no es pendiente', async () => {
    const r = await report();
    expect(r.byDay.find((d) => d.date === '2026-11-24')).toMatchObject({
      scheduledAmount: 0,
      appointments: 1,
      appointmentsWithoutItems: 0,
    });
    expect(r.forecast).toMatchObject({
      producedToDate: 0,
      scheduledPending: 0,
      forecast: 0,
    });
    const december = await report({ from: '2026-12-01', to: '2026-12-05' });
    expect(
      december.byDay.find((d) => d.date === '2026-12-03')?.scheduledAmount,
    ).toBe(25);
    // 333 + 70 (los 500 VES, sin tasa); citas del 03, 04, 05, 06 y 24 (la
    // cancelada del 21 y la de diciembre, no).
    expect(r.totals).toEqual({
      scheduledAmount: 403,
      appointments: 5,
      appointmentsWithoutItems: 1,
    });
  });

  it('tasas AUTOMÁTICAS sin la del día: WITHOUT_RATE sin llamar al proveedor', async () => {
    const r = await report();
    expect(r.byDay.find((d) => d.date === '2026-11-06')).toMatchObject({
      scheduledAmount: 0,
      appointments: 1,
    });
    expect(r.withoutRate).toEqual({ appointments: 1, items: 1 });
    expect(r.warnings).toContain('WITHOUT_RATE');
    expect(fetchRates).not.toHaveBeenCalled();
  });

  it('realizado del mes sin sede: fuera de lo producido, en unattributedDone solo para quien ve todas', async () => {
    const r = await report();
    expect(r.unattributedDone).toBe(1);
    expect(r.warnings).toContain('UNATTRIBUTED_DONE');
    expect(r.forecast.producedToDate).toBe(0);
    const restricted = await report({ allowedLocationIds: [c.main] });
    expect(restricted.unattributedDone).toBe(0);
    const chosen = await report({ locationId: c.main });
    expect(chosen.unattributedDone).toBe(0);
  });
});

describe('Producción agendada con dos sedes en zonas distintas (DX-567, int)', () => {
  // El 30/11 a las 16:00 de Caracas ya es 01/12 a las 05:00 en Tokio.
  const LATE = new Date('2026-11-30T20:00:00Z');
  const { context, prisma, useCase } = build(() => LATE);
  let c: ScheduledClinic;

  const report = (extra: Partial<ScheduledProductionInput> = {}) =>
    context.run(c.tenantId, () =>
      useCase.execute({
        ...NOVEMBER,
        actor: {
          userId: c.dentist.userId,
          role: ClinicRole.ADMIN,
          permissions: [],
        },
        allowedLocationIds: 'ALL',
        ...extra,
      }),
    );

  beforeAll(async () => {
    await prisma.onModuleInit();
    c = await clinic('dx567-zones');
    await raw.location.update({
      where: { id: c.norte },
      data: { timeZone: 'Asia/Tokyo' },
    });
    // La misma hora UTC (10/11 16:00): el 10/11 en Caracas, el 11/11 en
    // Tokio.
    const start = new Date('2026-11-10T16:00:00Z');
    const [ten] = await plan(c, [{ price: 10 }]);
    await appointment(c, '2026-11-10', { items: [ten], start });
    const tokyoPatient = await c.seed.patient('Tokio');
    const [ninety] = await plan(c, [{ price: 90 }], {
      patientId: tokyoPatient,
    });
    await appointment(c, '2026-11-11', {
      items: [ninety],
      start,
      locationId: c.norte,
      providerId: c.otherDentistId,
      patientId: tokyoPatient,
    });
    // Aceptado en una cita del 30/11 de Caracas: pendiente (hoy) allí.
    const [pending] = await plan(c, [{ price: 45 }]);
    await appointment(c, '2026-11-30', {
      items: [pending],
      start: new Date('2026-11-30T21:00:00Z'),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('cada cita cae en el día civil de su sede', async () => {
    const r = await report();
    expect(day(r, '2026-11-10').scheduledAmount).toBe(10);
    expect(day(r, '2026-11-11').scheduledAmount).toBe(90);
  });

  it('cada sede usa su mes: la principal da el mes y avisa MIXED_MONTHS', async () => {
    const r = await report();
    expect(r.forecast).toMatchObject({
      month: '2026-11',
      today: '2026-11-30',
      scheduledPending: 45,
    });
    expect(r.warnings).toContain('MIXED_MONTHS');
    const tokyo = await report({ locationId: c.norte });
    expect(tokyo.forecast).toMatchObject({
      month: '2026-12',
      today: '2026-12-01',
      scheduledPending: 0,
    });
    expect(tokyo.warnings).not.toContain('MIXED_MONTHS');
  });
});

describe('Producción agendada: 12 profesionales y 62 días en una sede (DX-567, int)', () => {
  const { context, prisma, useCase } = build(() => NOW);
  const PERIOD = { from: '2026-10-01', to: '2026-12-01' };
  let c: ScheduledClinic;
  let professionals: string[];

  const input = (): ScheduledProductionInput => ({
    ...PERIOD,
    actor: {
      userId: c.dentist.userId,
      role: ClinicRole.ADMIN,
      permissions: [],
    },
    allowedLocationIds: 'ALL',
  });

  beforeAll(async () => {
    await prisma.onModuleInit();
    c = await clinic('dx567-perf');
    professionals = [c.dentist.userId];
    for (let n = 1; n < 12; n++) {
      professionals.push(await c.seed.provider(`Dr. Perf ${n}`));
    }
    const t = c.tenantId;
    const catalog = await raw.dentalCatalogItem.create({
      data: {
        tenantId: t,
        code: 'RES-PERF',
        kind: 'PROCEDURE',
        labelEs: 'Resina',
        color: '#123456',
      },
    });
    const providers = `ARRAY[${professionals.map((p) => `'${p}'::uuid`).join(',')}]`;
    // Con los triggers (el código de paciente lo pone la BD).
    await raw.$executeRawUnsafe(`
      INSERT INTO "patients" ("id", "tenantId", "firstName", "lastName",
        "createdAt", "updatedAt")
      SELECT md5('dx567-patient-' || g)::uuid, '${t}', 'Paciente', 'Perf ' || g,
             now(), now()
        FROM generate_series(0, 199) AS g`);
    await withoutTriggers(async (tx) => {
      // 4 000 citas en 62 días: g = (franja · 62 + día) · 12 + profesional.
      // Una hora por franja; los 12 de una franja, pacientes distintos.
      await tx.$executeRawUnsafe(`
        INSERT INTO "appointments" ("id", "tenantId", "locationId",
          "patientId", "providerId", "start", "end", "status", "createdAt",
          "updatedAt")
        SELECT md5('dx567-appt-' || g)::uuid, '${t}', '${c.main}',
               md5('dx567-patient-' || (g % 200))::uuid,
               (${providers})[(g % 12) + 1],
               TIMESTAMP '2026-10-01 12:00' + ((g / 12) % 62) * INTERVAL '1 day' + ((g / 12) / 62) * INTERVAL '1 hour',
               TIMESTAMP '2026-10-01 12:30' + ((g / 12) % 62) * INTERVAL '1 day' + ((g / 12) / 62) * INTERVAL '1 hour',
               (CASE WHEN g % 25 = 0 THEN 'CANCELLED'
                     WHEN g % 25 = 1 THEN 'NO_SHOW'
                     WHEN ((g / 12) % 62) < 47 THEN 'COMPLETED'
                     ELSE 'SCHEDULED' END)::"AppointmentStatus",
               now(), now()
          FROM generate_series(0, 3999) AS g`);
      // La historia (20 000 citas de 2024–2025): no es del período.
      await tx.$executeRawUnsafe(`
        INSERT INTO "appointments" ("id", "tenantId", "locationId",
          "patientId", "providerId", "start", "end", "status", "createdAt",
          "updatedAt")
        SELECT md5('dx567-old-' || g)::uuid, '${t}', '${c.main}',
               md5('dx567-patient-' || (g % 200))::uuid,
               (${providers})[(g % 12) + 1],
               TIMESTAMP '2024-01-01 12:00' + g * INTERVAL '1 hour',
               TIMESTAMP '2024-01-01 12:30' + g * INTERVAL '1 hour',
               'COMPLETED', now(), now()
          FROM generate_series(0, 19999) AS g`);
      // Un plan por cita (salvo 1 de cada 10: sin tratamiento) con 2 ítems.
      await tx.$executeRawUnsafe(`
        INSERT INTO "treatment_plans" ("id", "tenantId", "patientId", "status",
          "currency", "createdById", "createdAt", "updatedAt", "acceptedAt")
        SELECT md5('dx567-plan-' || a."id")::uuid, a."tenantId", a."patientId",
               'ACCEPTED', 'USD', a."providerId", now(), now(), now()
          FROM "appointments" a
         WHERE a."tenantId" = '${t}' AND a."start" >= '2026-10-01'
           AND get_byte(decode(md5(a."id"::text), 'hex'), 0) % 10 <> 0`);
      await tx.$executeRawUnsafe(`
        INSERT INTO "treatment_plan_items" ("id", "tenantId", "planId",
          "patientId", "toothNumber", "catalogItemId", "price", "discount",
          "status", "completedAt", "performedLocationId", "performedById",
          "performedByMembershipId", "createdAt", "updatedAt")
        SELECT md5('dx567-item-' || a."id" || '-' || n)::uuid, a."tenantId",
               md5('dx567-plan-' || a."id")::uuid, a."patientId",
               (10 + n)::text, '${catalog.id}', 50 + n * 10, 0,
               (CASE WHEN a."status" = 'COMPLETED' THEN 'DONE' ELSE 'ACCEPTED' END)::"TreatmentPlanItemStatus",
               CASE WHEN a."status" = 'COMPLETED' THEN a."start" END,
               CASE WHEN a."status" = 'COMPLETED' THEN a."locationId" END,
               CASE WHEN a."status" = 'COMPLETED' THEN a."providerId" END,
               CASE WHEN a."status" = 'COMPLETED' THEN m."id" END,
               now(), now()
          FROM "appointments" a
          JOIN "clinic_memberships" m
            ON m."tenantId" = a."tenantId" AND m."userId" = a."providerId"
          CROSS JOIN generate_series(1, 2) AS n
         WHERE a."tenantId" = '${t}' AND a."start" >= '2026-10-01'
           AND get_byte(decode(md5(a."id"::text), 'hex'), 0) % 10 <> 0`);
      await tx.$executeRawUnsafe(`
        INSERT INTO "appointment_plan_items" ("tenantId", "patientId",
          "appointmentId", "planItemId", "createdAt")
        SELECT a."tenantId", a."patientId", a."id",
               md5('dx567-item-' || a."id" || '-' || n)::uuid, now()
          FROM "appointments" a
          CROSS JOIN generate_series(1, 2) AS n
         WHERE a."tenantId" = '${t}' AND a."start" >= '2026-10-01'
           AND get_byte(decode(md5(a."id"::text), 'hex'), 0) % 10 <> 0`);
    });
    for (const table of [
      'patients',
      'appointments',
      'treatment_plans',
      'treatment_plan_items',
      'appointment_plan_items',
    ]) {
      await raw.$executeRawUnsafe(`ANALYZE "${table}"`);
    }
  }, 300_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await prisma.onModuleDestroy();
    await raw.$disconnect();
  });

  async function best<T>(
    run: () => Promise<T>,
  ): Promise<{ ms: number[]; result: T }> {
    // La primera llamada abre las conexiones del pool: no es lo que se mide.
    let result = await run();
    const ms: number[] = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      result = await run();
      ms.push(performance.now() - started);
    }
    return { ms, result };
  }

  it('62 días con 12 profesionales (~4 000 citas, ~7 200 vínculos) en menos de 300 ms como dentalix_app', async () => {
    const { ms, result } = await best(() =>
      context.run(c.tenantId, () => useCase.execute(input())),
    );
    // 4 000 citas menos 160 canceladas y 160 inasistencias.
    expect(result.totals.appointments).toBe(3_680);
    expect(result.byDay).toHaveLength(62);
    expect(result.byProfessional).toHaveLength(12);
    expect(result.totals.appointmentsWithoutItems).toBeGreaterThan(0);
    expect(result.totals.scheduledAmount).toBeGreaterThan(0);
    expect(result.forecast.producedToDate).toBeGreaterThan(0);
    expect(result.forecast.scheduledPending).toBeGreaterThan(0);
    console.info(
      `DX-567 · producción agendada, 12 profesionales, 62 días: ${ms.map((v) => v.toFixed(0)).join(' / ')} ms`,
    );
    expect(Math.min(...ms)).toBeLessThan(300);
  }, 120_000);

  it('la 1.ª página de citas sin tratamiento en menos de 300 ms', async () => {
    const { ms, result } = await best(() =>
      context.run(c.tenantId, () => useCase.unlinked(input())),
    );
    expect(result.total).toBeGreaterThan(0);
    expect(result.items).toHaveLength(25);
    console.info(
      `DX-567 · citas sin tratamiento (1.ª página), 62 días: ${ms.map((v) => v.toFixed(0)).join(' / ')} ms`,
    );
    expect(Math.min(...ms)).toBeLessThan(300);
  }, 120_000);

  it('las consultas de citas no recorren appointments entera (EXPLAIN sin Seq Scan)', async () => {
    // Captura las consultas de lo agendado, lo pendiente y la lista tal como
    // las manda el repositorio.
    const captured: Prisma.Sql[] = [];
    const original = prisma.runWithTenant.bind(prisma) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const spy = jest
      .spyOn(prisma, 'runWithTenant')
      .mockImplementation((...args: unknown[]) => {
        const at = typeof args[0] === 'function' ? 0 : 1;
        const fn = args[at] as (tx: Prisma.TransactionClient) => unknown;
        args[at] = (tx: Prisma.TransactionClient) =>
          fn(
            new Proxy(tx, {
              get(target, prop, receiver) {
                if (prop !== '$queryRaw') {
                  return Reflect.get(target, prop, receiver) as unknown;
                }
                return (query: TemplateStringsArray, ...values: unknown[]) => {
                  const sql = Prisma.sql(query, ...values);
                  if (
                    sql.sql.includes('"appts" AS MATERIALIZED') ||
                    sql.sql.includes('count(*) OVER ()')
                  ) {
                    captured.push(sql);
                  }
                  return target.$queryRaw(sql);
                };
              },
            }),
          );
        return original(...args);
      });
    try {
      await context.run(c.tenantId, async () => {
        await useCase.execute(input());
        await useCase.unlinked(input());
      });
    } finally {
      spy.mockRestore();
    }
    // Agendado, pendiente y la lista.
    expect(captured).toHaveLength(3);
    for (const query of captured) {
      const plan = await prisma.runWithTenant(c.tenantId, (tx) =>
        tx.$queryRaw<{ 'QUERY PLAN': string }[]>(Prisma.sql`EXPLAIN ${query}`),
      );
      const text = plan.map((row) => row['QUERY PLAN']).join('\n');
      expect(text).not.toMatch(/Seq Scan on appointments/);
    }
  });
});
