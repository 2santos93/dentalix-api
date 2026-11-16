import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ClinicRole, ExtraPermission } from '@prisma/client';
import {
  EMPTY_QUOTE_FUNNEL_SUMS,
  QUOTE_FUNNEL_DEFINITION_LIST,
} from '../../domain/quote-funnel';
import type {
  QuoteFunnelAggregate,
  QuoteFunnelRepository,
  QuoteFunnelScope,
} from '../../domain/ports/quote-funnel-repository.port';
import {
  GetQuoteFunnelUseCase,
  QUOTE_FUNNEL_INVALID_PERIOD_MESSAGE,
  QUOTE_FUNNEL_OWN_ONLY_MESSAGE,
  QUOTE_FUNNEL_PERIOD_TOO_LONG_MESSAGE,
  QUOTE_FUNNEL_REASON_NEEDS_REJECTED_MESSAGE,
  type QuoteFunnelInput,
} from './get-quote-funnel.use-case';

const MAIN = '00000000-0000-4000-8000-000000000001';
const NORTE = '00000000-0000-4000-8000-000000000002';
const ME = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };

const AGGREGATE: QuoteFunnelAggregate = {
  total: {
    ...EMPTY_QUOTE_FUNNEL_SUMS,
    presented: 10,
    presentedAmount: 2650,
    accepted: 4,
    acceptedAmount: 1000,
    withoutRate: 1,
    medianSecondsToAccept: 86_400 * 2.5,
  },
  byProfessional: [
    {
      ...EMPTY_QUOTE_FUNNEL_SUMS,
      professionalId: null,
      professionalName: null,
      presented: 6,
      presentedAmount: 650,
    },
    {
      ...EMPTY_QUOTE_FUNNEL_SUMS,
      professionalId: OTHER,
      professionalName: 'Dr. Otro',
      presented: 1,
      presentedAmount: 1000,
    },
    {
      ...EMPTY_QUOTE_FUNNEL_SUMS,
      professionalId: ME,
      professionalName: 'Dra. Pérez',
      presented: 3,
      presentedAmount: 1000,
      accepted: 3,
      acceptedAmount: 1000,
    },
  ],
  rejectionReasons: [
    { reason: 'FEAR', count: 1, amount: 300 },
    { reason: 'PRICE', count: 2, amount: 300 },
  ],
};

function fakeRepo() {
  const scopes: QuoteFunnelScope[] = [];
  const repo: jest.Mocked<QuoteFunnelRepository> = {
    listLocations: jest.fn((allowed) =>
      Promise.resolve(
        [
          { id: MAIN, name: 'Sede principal', isActive: true },
          { id: NORTE, name: 'Sede Norte', isActive: true },
        ].filter((l) => allowed === 'ALL' || allowed.includes(l.id)),
      ),
    ),
    locationInClinic: jest.fn((id) =>
      Promise.resolve([MAIN, NORTE].includes(id)),
    ),
    listProfessionals: jest.fn(() =>
      Promise.resolve([
        { userId: ME, fullName: 'Dra. Pérez' },
        { userId: OTHER, fullName: 'Dr. Otro' },
      ]),
    ),
    aggregate: jest.fn((_period, scope: QuoteFunnelScope) => {
      scopes.push(scope);
      return Promise.resolve(AGGREGATE);
    }),
    listPresentations: jest.fn((_period, scope: QuoteFunnelScope) => {
      scopes.push(scope);
      return Promise.resolve({
        items: [
          {
            groupId: 'g',
            planIds: ['g'],
            firstPlanId: 'g',
            patientId: null,
            patientName: null,
            presentedAt: new Date('2026-10-10T15:00:00Z'),
            locationId: MAIN,
            locationName: 'Sede principal',
            timeZone: 'America/Caracas',
            professionalId: ME,
            professionalName: 'Dra. Pérez',
            optionCount: 1,
            presentedAmount: 100.006,
            acceptedAmount: null,
            scheduledAmount: null,
            doneAmount: null,
            collectedAmount: null,
            outcome: 'PENDING',
            rejectionReason: null,
          },
        ],
        total: 1,
      });
    }),
  };
  return { repo, scopes };
}

function build(currency: string | null = 'USD') {
  const { repo, scopes } = fakeRepo();
  const useCase = new GetQuoteFunnelUseCase(repo, {
    current: () => Promise.resolve(currency),
  });
  return { useCase, repo, scopes };
}

const actor = (
  role: ClinicRole,
  permissions: ExtraPermission[] = [],
): QuoteFunnelInput['actor'] => ({ userId: ME, role, permissions });

const input = (extra: Partial<QuoteFunnelInput> = {}): QuoteFunnelInput => ({
  ...OCTOBER,
  actor: actor(ClinicRole.ADMIN),
  allowedLocationIds: 'ALL',
  ...extra,
});

describe('GetQuoteFunnelUseCase (DX-558)', () => {
  it('ADMIN: toda la clínica, con las definiciones, avisos y profesionales ordenados', async () => {
    const { useCase, scopes } = build();
    const r = await useCase.execute(input());
    expect(r.scope).toBe('CLINIC');
    expect(r.currency).toBe('USD');
    expect(r.restrictedToLocations).toBe(false);
    expect(scopes[0]).toEqual({
      locationIds: [MAIN, NORTE],
      includeWithoutLocation: true,
      currency: 'USD',
    });
    expect(r.acceptanceRate).toEqual({ byCount: 40, byAmount: 37.7 });
    expect(r.medianDaysToAccept).toBe(2.5);
    expect(r.warnings).toEqual(['WITHOUT_RATE']);
    expect(r.definitions).toBe(QUOTE_FUNNEL_DEFINITION_LIST);
    // Por presentados desc; «Sin atribuir» al final.
    expect(r.byProfessional.map((p) => p.name)).toEqual([
      'Dra. Pérez',
      'Dr. Otro',
      'Sin atribuir',
    ]);
    expect(r.byProfessional[0]).toMatchObject({
      presented: { count: 3, amount: 1000 },
      accepted: { count: 3, amount: 1000 },
      acceptanceRate: { byCount: 100, byAmount: 100 },
    });
    expect(r.rejectionReasons.map((x) => x.reason)).toEqual(['PRICE', 'FEAR']);
    expect(r.options.professionals).toHaveLength(2);
  });

  it('ADMIN puede filtrar por profesional', async () => {
    const { useCase, scopes } = build();
    const r = await useCase.execute(input({ providerId: OTHER }));
    expect(scopes[0].professionalId).toBe(OTHER);
    expect(r.filters).toEqual({ locationId: null, providerId: OTHER });
  });

  it('DENTIST: solo lo suyo (OWN), sin pedirlo; su fila y su opción', async () => {
    const { useCase, scopes } = build();
    const r = await useCase.execute(
      input({ actor: actor(ClinicRole.DENTIST) }),
    );
    expect(r.scope).toBe('OWN');
    expect(scopes[0].professionalId).toBe(ME);
    expect(r.filters.providerId).toBe(ME);
    expect(r.options.professionals).toEqual([
      { userId: ME, fullName: 'Dra. Pérez' },
    ]);
  });

  it('DENTIST pidiendo a otro profesional → 403 sin consultar', async () => {
    const { useCase, repo } = build();
    await expect(
      useCase.execute(
        input({ actor: actor(ClinicRole.DENTIST), providerId: OTHER }),
      ),
    ).rejects.toThrow(new ForbiddenException(QUOTE_FUNNEL_OWN_ONLY_MESSAGE));
    expect(repo.aggregate).not.toHaveBeenCalled();
    // Pedirse a sí mismo vale.
    await expect(
      useCase.execute(
        input({ actor: actor(ClinicRole.DENTIST), providerId: ME }),
      ),
    ).resolves.toMatchObject({ scope: 'OWN' });
  });

  it('DENTIST (o asistente) con FINANCIAL_REPORTS_VIEW: toda la clínica', async () => {
    const { useCase, scopes } = build();
    const r = await useCase.execute(
      input({
        actor: actor(ClinicRole.ASSISTANT, [
          ExtraPermission.FINANCIAL_REPORTS_VIEW,
        ]),
        providerId: OTHER,
      }),
    );
    expect(r.scope).toBe('CLINIC');
    expect(scopes[0].professionalId).toBe(OTHER);
  });

  it('sede: ajena o no permitida → el mismo 403; con sede, sin lo presentado sin sede', async () => {
    const { useCase, scopes } = build();
    await expect(
      useCase.execute(input({ allowedLocationIds: [NORTE], locationId: MAIN })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      useCase.execute(
        input({ locationId: '00000000-0000-4000-8000-0000000000ff' }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await useCase.execute(input({ locationId: NORTE }));
    expect(scopes.at(-1)).toMatchObject({
      locationIds: [NORTE],
      includeWithoutLocation: false,
    });
  });

  it('restringido a sedes: solo las suyas, sin lo presentado sin sede', async () => {
    const { useCase, scopes } = build();
    const r = await useCase.execute(input({ allowedLocationIds: [NORTE] }));
    expect(r.restrictedToLocations).toBe(true);
    expect(r.options.locations.map((l) => l.id)).toEqual([NORTE]);
    expect(scopes[0]).toMatchObject({
      locationIds: [NORTE],
      includeWithoutLocation: false,
    });
  });

  it('período: inválido, al revés, fuera de rango o de más de 366 días → 400', async () => {
    const { useCase } = build();
    await expect(
      useCase.execute(input({ from: '2026-02-30', to: '2026-03-01' })),
    ).rejects.toThrow(
      new BadRequestException(QUOTE_FUNNEL_INVALID_PERIOD_MESSAGE),
    );
    await expect(
      useCase.execute(input({ from: '2026-10-31', to: '2026-10-01' })),
    ).rejects.toThrow(
      new BadRequestException(QUOTE_FUNNEL_INVALID_PERIOD_MESSAGE),
    );
    await expect(
      useCase.execute(input({ from: '1999-12-31', to: '2000-01-31' })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      useCase.execute(input({ from: '2025-10-01', to: '2026-10-02' })),
    ).rejects.toThrow(
      new BadRequestException(QUOTE_FUNNEL_PERIOD_TOO_LONG_MESSAGE),
    );
    // 366 días (año bisiesto) sí.
    await expect(
      useCase.execute(input({ from: '2028-01-01', to: '2028-12-31' })),
    ).resolves.toBeDefined();
  });

  it('sin moneda de catálogo: importes null y aviso NO_CATALOG_CURRENCY', async () => {
    const { useCase, scopes } = build(null);
    const r = await useCase.execute(input());
    expect(scopes[0].currency).toBeNull();
    expect(r.currency).toBeNull();
    expect(r.warnings).toEqual(['NO_CATALOG_CURRENCY']);
    expect(r.steps.every((s) => s.amount === null)).toBe(true);
    expect(r.withoutRate).toEqual({ presentations: 0 });
  });

  it('detalle: mismo alcance, paginado (25 por defecto) y redondeado', async () => {
    const { useCase, repo, scopes } = build();
    const r = await useCase.presentations({
      ...input({ actor: actor(ClinicRole.DENTIST) }),
      step: 'PENDING',
    });
    expect(scopes[0].professionalId).toBe(ME);
    expect(repo.listPresentations).toHaveBeenCalledWith(
      OCTOBER,
      expect.any(Object),
      { step: 'PENDING' },
      { skip: 0, take: 25 },
    );
    expect(r).toMatchObject({
      currency: 'USD',
      total: 1,
      page: 1,
      pageSize: 25,
    });
    expect(r.items[0].presentedAmount).toBe(100.01);
    await useCase.presentations({
      ...input(),
      step: 'REJECTED',
      reason: 'PRICE',
      page: 3,
      pageSize: 10,
    });
    expect(repo.listPresentations).toHaveBeenLastCalledWith(
      OCTOBER,
      expect.any(Object),
      { step: 'REJECTED', reason: 'PRICE' },
      { skip: 20, take: 10 },
    );
  });

  it('detalle: el motivo solo con step=REJECTED (400)', async () => {
    const { useCase } = build();
    await expect(
      useCase.presentations({ ...input(), step: 'ACCEPTED', reason: 'PRICE' }),
    ).rejects.toThrow(
      new BadRequestException(QUOTE_FUNNEL_REASON_NEEDS_REJECTED_MESSAGE),
    );
  });
});
