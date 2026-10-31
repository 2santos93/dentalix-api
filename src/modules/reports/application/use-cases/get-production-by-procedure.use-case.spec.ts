import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type { CivilPeriod } from '../../domain/comparison-period';
import type { ProcedureSums } from '../../domain/production-by-procedure';
import type {
  ProductionByProcedureRepository,
  ProductionItemRow,
  ProductionLocation,
  ProductionProfessional,
  ProductionScope,
  UnattributedSums,
} from '../../domain/ports/production-by-procedure-repository.port';
import {
  GetProductionByProcedureUseCase,
  PRODUCTION_INVALID_PERIOD_MESSAGE,
  PRODUCTION_OWN_ONLY_MESSAGE,
  PRODUCTION_PERIOD_TOO_LONG_MESSAGE,
} from './get-production-by-procedure.use-case';
import { LOCATION_NOT_ALLOWED_MESSAGE } from '../../../../shared/tenancy/location-access';

const A = 'loc-a';
const B = 'loc-b';
const ADMIN = { userId: 'u-admin', role: ClinicRole.ADMIN };
const DENTIST = { userId: 'u-dent', role: ClinicRole.DENTIST };

class FakeRepo implements ProductionByProcedureRepository {
  locations: ProductionLocation[] = [
    { id: A, name: 'Sede A', isActive: true },
    { id: B, name: 'Sede B', isActive: true },
  ];
  professionals: ProductionProfessional[] = [
    { userId: 'u-dent', fullName: 'Dra. Ana' },
    { userId: 'u-other', fullName: 'Dr. Otro' },
  ];
  sums: ProcedureSums[] = [];
  pending: UnattributedSums[] = [];
  undated: UnattributedSums[] = [];
  items: ProductionItemRow[] = [];
  calls: {
    aggregate?: [CivilPeriod, ProductionScope];
    unattributed?: [CivilPeriod, ProductionScope, boolean];
    listItems?: [CivilPeriod, ProductionScope, { skip: number; take: number }];
    listProfessionals?: string[];
  } = {};

  listLocations(allowed: AllowedLocations) {
    return Promise.resolve(
      this.locations.filter((l) => allowed === 'ALL' || allowed.includes(l.id)),
    );
  }
  locationInClinic(id: string) {
    return Promise.resolve(this.locations.some((l) => l.id === id));
  }
  listProfessionals(locationIds: readonly string[]) {
    this.calls.listProfessionals = [...locationIds];
    return Promise.resolve(this.professionals);
  }
  listCategories() {
    return Promise.resolve(['Operatoria', 'Prevención']);
  }
  aggregate(period: CivilPeriod, scope: ProductionScope) {
    this.calls.aggregate = [period, scope];
    return Promise.resolve(this.sums);
  }
  unattributed(
    period: CivilPeriod,
    scope: ProductionScope,
    includeWithoutLocation: boolean,
  ) {
    this.calls.unattributed = [period, scope, includeWithoutLocation];
    return Promise.resolve({ inPeriod: this.pending, undated: this.undated });
  }
  listItems(
    period: CivilPeriod,
    scope: ProductionScope,
    page: { skip: number; take: number },
  ) {
    this.calls.listItems = [period, scope, page];
    return Promise.resolve({ items: this.items, total: this.items.length });
  }
}

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };

describe('GetProductionByProcedureUseCase (DX-423)', () => {
  let repo: FakeRepo;
  let useCase: GetProductionByProcedureUseCase;

  beforeEach(() => {
    repo = new FakeRepo();
    useCase = new GetProductionByProcedureUseCase(repo);
  });

  it('ADMIN: todas sus sedes, todo el equipo; los «Sin atribuir» sin sede cuentan', async () => {
    repo.sums = [
      {
        catalogItemId: 'c1',
        code: 'D2391',
        label: 'Resina',
        category: 'Operatoria',
        currency: 'COP',
        count: 3,
        gross: 280,
        discounts: 20,
        catalogCount: 3,
        catalogSum: 300,
        catalogPricedNet: 260,
      },
    ];
    repo.pending = [{ currency: 'COP', count: 1, gross: 50, discounts: 10 }];
    const r = await useCase.execute({
      ...OCTOBER,
      actor: ADMIN,
      allowedLocationIds: 'ALL',
    });
    expect(repo.calls.aggregate).toEqual([OCTOBER, { locationIds: [A, B] }]);
    expect(repo.calls.unattributed).toEqual([
      OCTOBER,
      { locationIds: [A, B] },
      true,
    ]);
    expect(r.scope).toBe('CLINIC');
    expect(r.rows[0]).toMatchObject({ net: 260, averageNet: 86.67 });
    expect(r.unattributed).toEqual([
      { currency: 'COP', count: 1, gross: 50, discounts: 10, net: 40 },
    ]);
    expect(r.hasActivity).toBe(true);
    expect(r.filters).toEqual({
      locationId: null,
      locationName: null,
      professionalId: null,
      professionalName: null,
      category: null,
    });
    expect(r.options).toEqual({
      locations: repo.locations,
      professionals: repo.professionals,
      categories: ['Operatoria', 'Prevención'],
    });
  });

  it('DENTIST: solo su producción (el filtro de profesional es él) y solo él en las opciones', async () => {
    const r = await useCase.execute({
      ...OCTOBER,
      actor: DENTIST,
      allowedLocationIds: 'ALL',
    });
    expect(repo.calls.aggregate?.[1]).toEqual({
      locationIds: [A, B],
      professionalId: 'u-dent',
    });
    expect(repo.calls.unattributed?.[1].professionalId).toBe('u-dent');
    expect(r.scope).toBe('OWN');
    expect(r.options.professionals).toEqual([
      { userId: 'u-dent', fullName: 'Dra. Ana' },
    ]);
    expect(r.filters.professionalName).toBe('Dra. Ana');
  });

  it('DENTIST que pide la de otro profesional: 403', async () => {
    await expect(
      useCase.execute({
        ...OCTOBER,
        professionalId: 'u-other',
        actor: DENTIST,
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toEqual(new ForbiddenException(PRODUCTION_OWN_ONLY_MESSAGE));
  });

  it('ADMIN filtra por profesional, sede y categoría', async () => {
    const r = await useCase.execute({
      ...OCTOBER,
      professionalId: 'u-other',
      locationId: B,
      category: 'Operatoria',
      actor: ADMIN,
      allowedLocationIds: 'ALL',
    });
    expect(repo.calls.aggregate?.[1]).toEqual({
      locationIds: [B],
      professionalId: 'u-other',
      category: 'Operatoria',
    });
    // Con una sede elegida, los «Sin atribuir» sin sede no son de ella.
    expect(repo.calls.unattributed?.[2]).toBe(false);
    expect(r.filters).toEqual({
      locationId: B,
      locationName: 'Sede B',
      professionalId: 'u-other',
      professionalName: 'Dr. Otro',
      category: 'Operatoria',
    });
  });

  it('miembro restringido a A: los profesionales salen de lo realizado en A, no del equipo entero', async () => {
    await useCase.execute({
      ...OCTOBER,
      actor: ADMIN,
      allowedLocationIds: [A],
    });
    expect(repo.calls.listProfessionals).toEqual([A]);
  });

  it('miembro restringido a A: solo A, y sin los «Sin atribuir» sin sede', async () => {
    await useCase.execute({
      ...OCTOBER,
      actor: ADMIN,
      allowedLocationIds: [A],
    });
    expect(repo.calls.aggregate?.[1].locationIds).toEqual([A]);
    expect(repo.calls.unattributed).toEqual([
      OCTOBER,
      { locationIds: [A] },
      false,
    ]);
  });

  it('sede de otra clínica y sede no permitida: el mismo 403 (no dice qué sedes existen)', async () => {
    await expect(
      useCase.execute({
        ...OCTOBER,
        locationId: 'ajena',
        actor: ADMIN,
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({
        message: LOCATION_NOT_ALLOWED_MESSAGE,
      }) as unknown,
    });
    await expect(
      useCase.execute({
        ...OCTOBER,
        locationId: B,
        actor: ADMIN,
        allowedLocationIds: [A],
      }),
    ).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({
        message: LOCATION_NOT_ALLOWED_MESSAGE,
      }) as unknown,
    });
  });

  it('período al revés: 400; de más de 24 meses por calendario: 400', async () => {
    await expect(
      useCase.execute({
        from: '2026-10-31',
        to: '2026-10-01',
        actor: ADMIN,
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toEqual(
      new BadRequestException(PRODUCTION_INVALID_PERIOD_MESSAGE),
    );
    await expect(
      useCase.execute({
        from: '2024-10-31',
        to: '2026-11-01',
        actor: ADMIN,
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toEqual(
      new BadRequestException(PRODUCTION_PERIOD_TOO_LONG_MESSAGE),
    );
    // 24 meses y un día: 731 días, pero «hasta» ya no es anterior a «desde» + 24 meses.
    await expect(
      useCase.execute({
        from: '2025-01-01',
        to: '2027-01-01',
        actor: ADMIN,
        allowedLocationIds: 'ALL',
      }),
    ).rejects.toEqual(
      new BadRequestException(PRODUCTION_PERIOD_TOO_LONG_MESSAGE),
    );
    // 24 meses justos (con un 29 de febrero) caben.
    await expect(
      useCase.execute({
        from: '2023-11-01',
        to: '2025-10-31',
        actor: ADMIN,
        allowedLocationIds: 'ALL',
      }),
    ).resolves.toBeDefined();
  });

  it('solo realizados sin fecha: aviso aparte (undated) y el período sigue vacío', async () => {
    repo.undated = [{ currency: 'COP', count: 1, gross: 90000, discounts: 0 }];
    const r = await useCase.execute({
      from: '2020-01-01',
      to: '2020-01-31',
      actor: ADMIN,
      allowedLocationIds: 'ALL',
    });
    expect(r.hasActivity).toBe(false);
    expect(r.unattributed).toEqual([]);
    expect(r.undated).toEqual([
      { currency: 'COP', count: 1, gross: 90000, discounts: 0, net: 90000 },
    ]);
  });

  it('sin producción ni «Sin atribuir»: hasActivity false', async () => {
    const r = await useCase.execute({
      ...OCTOBER,
      actor: ADMIN,
      allowedLocationIds: 'ALL',
    });
    expect(r.hasActivity).toBe(false);
    expect(r.rows).toEqual([]);
    expect(r.totals).toEqual([]);
  });

  it('sin sedes visibles: no consulta la producción con sede', async () => {
    const r = await useCase.execute({
      ...OCTOBER,
      actor: ADMIN,
      allowedLocationIds: [],
    });
    expect(repo.calls.aggregate).toBeUndefined();
    expect(r.hasActivity).toBe(false);
  });

  describe('items (detalle de una fila)', () => {
    it('mismos filtros + procedimiento y moneda, paginado; neto por ítem', async () => {
      repo.items = [
        {
          id: 'i1',
          completedAt: new Date('2026-10-05T15:00:00Z'),
          patientId: 'p1',
          patientName: 'Ana Pérez',
          professionalId: 'u-dent',
          professionalName: 'Dra. Ana',
          locationId: A,
          locationName: 'Sede A',
          timeZone: 'America/Bogota',
          toothNumber: '16',
          currency: 'COP',
          price: 80,
          discount: 20,
        },
      ];
      const r = await useCase.items({
        ...OCTOBER,
        catalogItemId: 'c1',
        currency: 'COP',
        page: 2,
        pageSize: 10,
        actor: DENTIST,
        allowedLocationIds: 'ALL',
      });
      expect(repo.calls.listItems).toEqual([
        OCTOBER,
        {
          locationIds: [A, B],
          professionalId: 'u-dent',
          catalogItemId: 'c1',
          currency: 'COP',
        },
        { skip: 10, take: 10 },
      ]);
      expect(r).toMatchObject({ total: 1, page: 2, pageSize: 10 });
      expect(r.items[0]).toMatchObject({ net: 60, patientName: 'Ana Pérez' });
    });

    it('DENTIST pidiendo los ítems de otro: 403', async () => {
      await expect(
        useCase.items({
          ...OCTOBER,
          catalogItemId: 'c1',
          professionalId: 'u-other',
          actor: DENTIST,
          allowedLocationIds: 'ALL',
        }),
      ).rejects.toEqual(new ForbiddenException(PRODUCTION_OWN_ONLY_MESSAGE));
    });
  });
});
