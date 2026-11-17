import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ClinicRole, ExtraPermission } from '@prisma/client';
import { SCHEDULED_PRODUCTION_DEFINITION_LIST } from '../../domain/scheduled-production';
import type { CivilPeriod } from '../../domain/comparison-period';
import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type {
  ForecastAggregate,
  ScheduledAggregate,
  ScheduledProductionRepository,
  ScheduledProductionScope,
} from '../../domain/ports/scheduled-production-repository.port';
import {
  GetScheduledProductionUseCase,
  SCHEDULED_PRODUCTION_FORBIDDEN_MESSAGE,
  SCHEDULED_PRODUCTION_INVALID_PERIOD_MESSAGE,
  SCHEDULED_PRODUCTION_OWN_ONLY_MESSAGE,
  SCHEDULED_PRODUCTION_PERIOD_TOO_LONG_MESSAGE,
  type ScheduledProductionInput,
  type StoredRatesReader,
} from './get-scheduled-production.use-case';

const MAIN = '00000000-0000-4000-8000-000000000001';
const NORTE = '00000000-0000-4000-8000-000000000002';
const ME = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const NOVEMBER = { from: '2026-11-16', to: '2026-11-22' };
const NOW = new Date('2026-11-17T15:00:00Z');

const SCHEDULED: ScheduledAggregate = {
  amounts: [
    {
      day: '2026-11-17',
      professionalId: ME,
      locationId: MAIN,
      currency: 'USD',
      amount: 100,
      items: 2,
      appointmentIds: [],
    },
    // 3650 VES del 16 (tasa del día: 36,5) = 100 USD.
    {
      day: '2026-11-16',
      professionalId: OTHER,
      locationId: MAIN,
      currency: 'VES',
      amount: 3650,
      items: 1,
      appointmentIds: ['c-ves-16'],
    },
    // Del 20 (futuro): la tasa de HOY (17: 40) → 4000 VES = 100 USD.
    {
      day: '2026-11-20',
      professionalId: OTHER,
      locationId: MAIN,
      currency: 'VES',
      amount: 4000,
      items: 1,
      appointmentIds: ['c-ves-20'],
    },
    // Del 18 (futuro) en EUR: la de hoy no tiene EUR → fuera.
    {
      day: '2026-11-18',
      professionalId: ME,
      locationId: MAIN,
      currency: 'EUR',
      amount: 90,
      items: 1,
      appointmentIds: ['c-eur-18'],
    },
  ],
  appointments: [
    {
      day: '2026-11-17',
      professionalId: ME,
      locationId: MAIN,
      appointments: 2,
      withoutItems: 1,
    },
    {
      day: '2026-11-16',
      professionalId: OTHER,
      locationId: MAIN,
      appointments: 1,
      withoutItems: 0,
    },
  ],
  names: new Map([
    [ME, 'Dra. Pérez'],
    [OTHER, 'Dr. Otro'],
  ]),
  zones: new Map([[MAIN, 'America/Caracas']]),
};

const FORECAST: ForecastAggregate = {
  window: {
    zones: [
      {
        timeZone: 'America/Caracas',
        locationIds: [MAIN, NORTE],
        today: '2026-11-17',
        monthFirst: '2026-11-01',
        monthLast: '2026-11-30',
      },
    ],
    reference: { timeZone: 'America/Caracas', today: '2026-11-17' },
  },
  produced: [
    {
      day: '2026-11-05',
      locationId: MAIN,
      currency: 'USD',
      amount: 300,
      items: 3,
    },
  ],
  pending: [
    {
      day: '2026-11-20',
      locationId: MAIN,
      currency: 'USD',
      amount: 200,
      items: 2,
    },
  ],
  unattributedDone: 0,
};

const RATES: Record<string, Record<string, number>> = {
  '2026-11-16': { VES: 36.5 },
  '2026-11-17': { VES: 40 },
};

function setup(
  options: {
    currency?: string | null;
    forecast?: ForecastAggregate;
  } = {},
) {
  const scopes: ScheduledProductionScope[] = [];
  const repo: jest.Mocked<ScheduledProductionRepository> = {
    listLocations: jest.fn((_allowed: AllowedLocations) =>
      Promise.resolve([
        { id: MAIN, name: 'Sede principal', isActive: true },
        { id: NORTE, name: 'Sede Norte', isActive: true },
      ]),
    ),
    locationInClinic: jest.fn((id: string) =>
      Promise.resolve(id === MAIN || id === NORTE),
    ),
    listProfessionals: jest.fn((_locationIds: readonly string[]) =>
      Promise.resolve([
        { userId: OTHER, fullName: 'Dr. Otro' },
        { userId: ME, fullName: 'Dra. Pérez' },
      ]),
    ),
    scheduled: jest.fn((_period, scope: ScheduledProductionScope) => {
      scopes.push(scope);
      return Promise.resolve(SCHEDULED);
    }),
    forecast: jest.fn(
      (_now: Date, _scope: ScheduledProductionScope, _ref: string | null) =>
        Promise.resolve(options.forecast ?? FORECAST),
    ),
    listUnlinked: jest.fn(
      (
        _period: CivilPeriod,
        scope: ScheduledProductionScope,
        _page: { skip: number; take: number },
      ) => {
        scopes.push(scope);
        return Promise.resolve({ items: [], total: 0 });
      },
    ),
  };
  type Stored = ReturnType<StoredRatesReader['storedReader']>;
  const stored = jest.fn<ReturnType<Stored>, Parameters<Stored>>((date) =>
    Promise.resolve(
      RATES[date]
        ? {
            base: 'USD',
            source: 'MANUAL',
            rates: RATES[date],
            rateDate: date,
          }
        : null,
    ),
  );
  // Una lectura de los ajustes por petición: un lector por `execute`.
  const storedReader = jest.fn(() => stored);
  const currency = options.currency === undefined ? 'USD' : options.currency;
  const useCase = new GetScheduledProductionUseCase(
    repo,
    { current: () => Promise.resolve(currency) },
    { storedReader },
    () => NOW,
  );
  return { useCase, repo, scopes, stored, storedReader };
}

const actor = (
  role: ClinicRole,
  permissions: ExtraPermission[] = [],
): ScheduledProductionInput['actor'] => ({ userId: ME, role, permissions });

const input = (
  over: Partial<ScheduledProductionInput> = {},
): ScheduledProductionInput => ({
  ...NOVEMBER,
  actor: actor(ClinicRole.ADMIN),
  allowedLocationIds: 'ALL',
  ...over,
});

describe('GetScheduledProductionUseCase (DX-567)', () => {
  it('ADMIN: toda la clínica, convertido con la tasa guardada del día (futuro: la de hoy) y sin tasa fuera', async () => {
    const { useCase, scopes, stored, storedReader, repo } = setup();
    const r = await useCase.execute(input());
    expect(r).toMatchObject({
      period: NOVEMBER,
      currency: 'USD',
      scope: 'CLINIC',
      restrictedToLocations: false,
      filters: { locationId: null, providerId: null },
      totals: {
        scheduledAmount: 300,
        appointments: 3,
        appointmentsWithoutItems: 1,
      },
      withoutRate: { appointments: 1, items: 1 },
      forecast: {
        month: '2026-11',
        today: '2026-11-17',
        producedToDate: 300,
        scheduledPending: 200,
        forecast: 500,
        itemsWithoutRate: 0,
      },
      unattributedDone: 0,
      warnings: ['WITHOUT_RATE'],
      definitions: SCHEDULED_PRODUCTION_DEFINITION_LIST,
    });
    expect(r.byDay.map((d) => [d.date, d.scheduledAmount])).toEqual([
      ['2026-11-16', 100],
      ['2026-11-17', 100],
      ['2026-11-18', 0],
      ['2026-11-19', 0],
      ['2026-11-20', 100],
      ['2026-11-21', 0],
      ['2026-11-22', 0],
    ]);
    expect(r.byProfessional.map((p) => [p.name, p.scheduledAmount])).toEqual([
      ['Dr. Otro', 200],
      ['Dra. Pérez', 100],
    ]);
    expect(scopes[0]).toEqual({
      locationIds: [MAIN, NORTE],
      includeWithoutLocation: true,
      currency: 'USD',
    });
    // Solo la lectura guardada: el 16 y el 17 (por el 18 y el 20, futuros),
    // una vez cada (día, moneda), con las dos monedas (sin USD).
    expect(stored.mock.calls).toEqual(
      expect.arrayContaining([
        ['2026-11-16', { currencies: ['VES'] }],
        ['2026-11-17', { currencies: ['VES'] }],
        ['2026-11-17', { currencies: ['EUR'] }],
      ]),
    );
    expect(stored).toHaveBeenCalledTimes(3);
    expect(storedReader).toHaveBeenCalledTimes(1);
    expect(repo.forecast.mock.calls).toEqual([[NOW, scopes[0], null]]);
    expect(r.options.professionals.map((p) => p.userId)).toEqual([OTHER, ME]);
  });

  it('FINANCIAL_REPORTS_VIEW (aunque sea recepción): CLINIC, con filtro de profesional libre', async () => {
    const { useCase, scopes } = setup();
    const r = await useCase.execute(
      input({
        actor: actor(ClinicRole.RECEPTION, [
          ExtraPermission.FINANCIAL_REPORTS_VIEW,
        ]),
        providerId: OTHER,
      }),
    );
    expect(r.scope).toBe('CLINIC');
    expect(r.filters.providerId).toBe(OTHER);
    expect(scopes[0].professionalId).toBe(OTHER);
  });

  it('DENTIST sin permiso: OWN (solo lo suyo); pedir a otro es 403', async () => {
    const { useCase, scopes } = setup();
    const r = await useCase.execute(
      input({ actor: actor(ClinicRole.DENTIST) }),
    );
    expect(r.scope).toBe('OWN');
    expect(r.filters.providerId).toBe(ME);
    expect(scopes[0].professionalId).toBe(ME);
    expect(r.options.professionals.map((p) => p.userId)).toEqual([ME]);
    await expect(
      useCase.execute(
        input({ actor: actor(ClinicRole.DENTIST), providerId: OTHER }),
      ),
    ).rejects.toThrow(
      new ForbiddenException(SCHEDULED_PRODUCTION_OWN_ONLY_MESSAGE),
    );
    // Pedirse a sí mismo vale.
    await expect(
      useCase.execute(
        input({ actor: actor(ClinicRole.DENTIST), providerId: ME }),
      ),
    ).resolves.toMatchObject({ scope: 'OWN' });
  });

  it.each([ClinicRole.RECEPTION, ClinicRole.ASSISTANT])(
    '%s sin el permiso: 403 (no ve importes), también en la lista',
    async (role) => {
      const { useCase, repo } = setup();
      await expect(
        useCase.execute(input({ actor: actor(role) })),
      ).rejects.toThrow(
        new ForbiddenException(SCHEDULED_PRODUCTION_FORBIDDEN_MESSAGE),
      );
      await expect(
        useCase.unlinked(input({ actor: actor(role) })),
      ).rejects.toThrow(ForbiddenException);
      expect(repo.scheduled.mock.calls).toHaveLength(0);
      expect(repo.listUnlinked.mock.calls).toHaveLength(0);
    },
  );

  it('sede: no permitida o de otra clínica es el MISMO 403; restringido solo ve las suyas', async () => {
    const { useCase, scopes } = setup();
    await expect(
      useCase.execute(input({ allowedLocationIds: [NORTE], locationId: MAIN })),
    ).rejects.toThrow('No tienes acceso a esta sede.');
    await expect(
      useCase.execute(
        input({ locationId: '00000000-0000-4000-8000-0000000000ff' }),
      ),
    ).rejects.toThrow('No tienes acceso a esta sede.');
    const r = await useCase.execute(input({ locationId: NORTE }));
    expect(r.filters.locationId).toBe(NORTE);
    expect(scopes[0]).toMatchObject({
      locationIds: [NORTE],
      includeWithoutLocation: false,
    });
    const restricted = await useCase.execute(
      input({ allowedLocationIds: [NORTE] }),
    );
    expect(restricted.restrictedToLocations).toBe(true);
    expect(scopes[1].includeWithoutLocation).toBe(false);
  });

  it('período: hasta 62 días; más, al revés o mal formado es 400', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(input({ from: '2026-11-01', to: '2027-01-01' })),
    ).resolves.toBeDefined();
    await expect(
      useCase.execute(input({ from: '2026-11-01', to: '2027-01-02' })),
    ).rejects.toThrow(
      new BadRequestException(SCHEDULED_PRODUCTION_PERIOD_TOO_LONG_MESSAGE),
    );
    await expect(
      useCase.execute(input({ from: '2026-11-20', to: '2026-11-19' })),
    ).rejects.toThrow(
      new BadRequestException(SCHEDULED_PRODUCTION_INVALID_PERIOD_MESSAGE),
    );
    await expect(
      useCase.execute(input({ from: '2026-02-30', to: '2026-03-01' })),
    ).rejects.toThrow(BadRequestException);
  });

  it('sin moneda de catálogo: importes null, aviso, recuentos siguen y no se leen tasas', async () => {
    const { useCase, stored } = setup({ currency: null });
    const r = await useCase.execute(input());
    expect(r.currency).toBeNull();
    expect(r.totals).toEqual({
      scheduledAmount: null,
      appointments: 3,
      appointmentsWithoutItems: 1,
    });
    expect(r.forecast.forecast).toBeNull();
    expect(r.withoutRate).toEqual({ appointments: 0, items: 0 });
    expect(r.warnings).toEqual(['NO_CATALOG_CURRENCY']);
    expect(stored).not.toHaveBeenCalled();
  });

  it('dos zonas en meses distintos: MIXED_MONTHS; realizados sin atribuir: aviso', async () => {
    const { useCase } = setup({
      forecast: {
        ...FORECAST,
        window: {
          zones: [
            {
              timeZone: 'America/Caracas',
              locationIds: [MAIN],
              today: '2026-11-30',
              monthFirst: '2026-11-01',
              monthLast: '2026-11-30',
            },
            {
              timeZone: 'Asia/Tokyo',
              locationIds: [NORTE],
              today: '2026-12-01',
              monthFirst: '2026-12-01',
              monthLast: '2026-12-31',
            },
          ],
          reference: { timeZone: 'America/Caracas', today: '2026-11-30' },
        },
        unattributedDone: 2,
      },
    });
    const r = await useCase.execute(input());
    expect(r.forecast).toMatchObject({ month: '2026-11', today: '2026-11-30' });
    expect(r.unattributedDone).toBe(2);
    expect(r.warnings).toEqual(
      expect.arrayContaining(['MIXED_MONTHS', 'UNATTRIBUTED_DONE']),
    );
  });

  it('la lista sin tratamiento: mismo alcance, página por defecto 25', async () => {
    const { useCase, repo } = setup();
    const r = await useCase.unlinked({
      ...input({ actor: actor(ClinicRole.DENTIST) }),
      page: 3,
    });
    expect(r).toEqual({ items: [], total: 0, page: 3, pageSize: 25 });
    expect(repo.listUnlinked.mock.calls).toEqual([
      [
        NOVEMBER,
        expect.objectContaining({ professionalId: ME }),
        { skip: 50, take: 25 },
      ],
    ]);
  });
});
