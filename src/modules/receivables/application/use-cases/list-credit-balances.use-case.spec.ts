import { BadRequestException } from '@nestjs/common';
import { planBalanceWithoutLiveRates } from '../../../payments/application/__fixtures__/plan-balance-without-live-rates';
import { locationZonesOf } from '../../../../shared/locations/location-time-zone';
import type { PatientLedger } from '../../domain/entities/receivables.entity';
import type { CreditBalancesRepository } from '../../domain/ports/credit-balances-repository.port';
import type {
  LedgersQuery,
  ReceivablesLocation,
} from '../../domain/ports/receivables-repository.port';
import {
  CREDIT_BALANCES_MAX_PAGE_SIZE,
  ListCreditBalancesUseCase,
} from './list-credit-balances.use-case';

// 03:00 UTC del 4 de noviembre = 23:00 del 3 de noviembre en Caracas (UTC-4).
const NOW = new Date('2026-11-04T03:00:00.000Z');
const NORTE: ReceivablesLocation = {
  id: 'loc-norte',
  name: 'Sede Norte',
  timeZone: 'America/Caracas',
};
const SUR: ReceivablesLocation = {
  id: 'loc-sur',
  name: 'Sede Sur',
  timeZone: 'America/New_York',
};

function ledger(
  patientId: string,
  paid: { currency?: string; amount: number }[],
  overrides: Partial<PatientLedger> & { billable?: number } = {},
): PatientLedger {
  const { billable = 0, ...rest } = overrides;
  return {
    patientId,
    locationId: NORTE.id,
    plans: [
      {
        id: `plan-${patientId}`,
        status: 'CANCELLED',
        currency: 'USD',
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
        billable,
        agingFrom: new Date('2026-01-01T12:00:00.000Z'),
      },
    ],
    paid: paid.map((p) => ({
      treatmentPlanId: `plan-${patientId}`,
      currency: p.currency ?? 'USD',
      amount: p.amount,
    })),
    paymentPlans: [],
    ...rest,
  };
}

class InMemoryRepository implements CreditBalancesRepository {
  ledgers: PatientLedger[] = [];
  names = new Map<string, string>();
  oldest = new Map<string, Date>();
  readonly ledgerQueries: LedgersQuery[] = [];
  readonly nameQueries: string[][] = [];
  readonly oldestQueries: string[][] = [];
  private readonly locations = [NORTE, SUR];

  findLocation(id: string): Promise<ReceivablesLocation | null> {
    return Promise.resolve(this.locations.find((l) => l.id === id) ?? null);
  }
  locationTimeZones(): Promise<(locationId: string | null) => string> {
    const zones = locationZonesOf(this.locations);
    return Promise.resolve((id) => zones.zoneOf(id ?? NORTE.id));
  }
  locationNames(): Promise<Map<string, string>> {
    return Promise.resolve(new Map(this.locations.map((l) => [l.id, l.name])));
  }
  loadCreditLedgers(query: LedgersQuery): Promise<PatientLedger[]> {
    this.ledgerQueries.push(query);
    return Promise.resolve(
      this.ledgers.filter(
        (l) => !query.locationId || l.locationId === query.locationId,
      ),
    );
  }
  patientNames(ids: readonly string[]): Promise<Map<string, string>> {
    this.nameQueries.push([...ids]);
    return Promise.resolve(
      new Map([...this.names].filter(([id]) => ids.includes(id))),
    );
  }
  oldestCreditPayments(ids: readonly string[]): Promise<Map<string, Date>> {
    this.oldestQueries.push([...ids]);
    return Promise.resolve(
      new Map([...this.oldest].filter(([id]) => ids.includes(id))),
    );
  }
}

describe('ListCreditBalancesUseCase (DX-430)', () => {
  let repo: InMemoryRepository;
  let useCase: ListCreditBalancesUseCase;

  beforeEach(() => {
    repo = new InMemoryRepository();
    useCase = new ListCreditBalancesUseCase(
      repo,
      () => NOW,
      planBalanceWithoutLiveRates(),
    );
  });

  it('ordena por moneda y luego por importe descendente, y desempata por paciente', async () => {
    repo.ledgers = [
      ledger('p-b', [{ amount: 50 }]),
      ledger('p-a', [{ amount: 50 }]),
      ledger('p-grande', [{ amount: 900 }]),
      ledger('p-ves', [{ currency: 'VES', amount: 99999 }], {
        plans: [
          {
            id: 'plan-p-ves',
            status: 'CANCELLED',
            currency: 'VES',
            createdAt: new Date('2026-01-01T12:00:00.000Z'),
            billable: 0,
            agingFrom: new Date('2026-01-01T12:00:00.000Z'),
          },
        ],
      }),
    ];
    for (const id of ['p-a', 'p-b', 'p-grande', 'p-ves']) {
      repo.names.set(id, `Paciente ${id}`);
    }

    const page = await useCase.execute({});

    expect(page.items.map((r) => [r.patient.id, r.currency, r.amount])).toEqual(
      [
        ['p-grande', 'USD', 900],
        ['p-a', 'USD', 50],
        ['p-b', 'USD', 50],
        ['p-ves', 'VES', 99999],
      ],
    );
    expect(page.total).toBe(4);
    expect(page.totals).toEqual([
      { currency: 'USD', patients: 3, amount: 1000 },
      { currency: 'VES', patients: 1, amount: 99999 },
    ]);
  });

  it('un paciente con saldo en dos monedas sale en dos filas', async () => {
    repo.ledgers = [
      ledger('p-1', [{ amount: 10 }], {
        plans: [
          ...ledger('p-1', []).plans,
          {
            id: 'plan-ves',
            status: 'CANCELLED',
            currency: 'VES',
            createdAt: new Date('2026-01-01T12:00:00.000Z'),
            billable: 0,
            agingFrom: new Date('2026-01-01T12:00:00.000Z'),
          },
        ],
        paid: [
          { treatmentPlanId: 'plan-p-1', currency: 'USD', amount: 10 },
          { treatmentPlanId: 'plan-ves', currency: 'VES', amount: 360 },
        ],
      }),
    ];
    repo.names.set('p-1', 'Ana Pérez');

    const page = await useCase.execute({});

    expect(page.items.map((r) => [r.currency, r.amount])).toEqual([
      ['USD', 10],
      ['VES', 360],
    ]);
  });

  it('quien no tiene saldo a favor (ya traspasado o devuelto, o con deuda) no sale', async () => {
    repo.ledgers = [
      // Traspasado/devuelto por completo: lo abonado y el asiento se anulan.
      ledger('p-devuelto', []),
      // Plan vivo con deuda: nada a favor.
      ledger('p-deuda', [{ amount: 20 }], {
        billable: 100,
        plans: [
          {
            id: 'plan-p-deuda',
            status: 'ACCEPTED',
            currency: 'USD',
            createdAt: new Date('2026-01-01T12:00:00.000Z'),
            billable: 100,
            agingFrom: new Date('2026-01-01T12:00:00.000Z'),
          },
        ],
      }),
    ];
    repo.names.set('p-devuelto', 'A');
    repo.names.set('p-deuda', 'B');

    const page = await useCase.execute({});

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.totals).toEqual([]);
  });

  it('pagina y solo pide nombres y fechas de la página', async () => {
    repo.ledgers = ['p-1', 'p-2', 'p-3'].map((id, i) =>
      ledger(id, [{ amount: 30 - i }]),
    );
    for (const id of ['p-1', 'p-2', 'p-3']) repo.names.set(id, id);

    const second = await useCase.execute({ page: 2, pageSize: 2 });

    expect(second.items.map((r) => r.patient.id)).toEqual(['p-3']);
    expect(second.total).toBe(3);
    expect(second.page).toBe(2);
    expect(second.pageSize).toBe(2);
    expect(repo.nameQueries).toEqual([['p-3']]);
    expect(repo.oldestQueries).toEqual([['plan-p-3']]);
  });

  it('recorta pageSize al tope', async () => {
    const page = await useCase.execute({ pageSize: 100000 });
    expect(page.pageSize).toBe(CREDIT_BALANCES_MAX_PAGE_SIZE);
  });

  it('la antigüedad es el día civil de la SEDE del abono más antiguo, no el día UTC', async () => {
    // 01:00 UTC del 20 de octubre = 21:00 del 19 en Caracas.
    repo.ledgers = [ledger('p-1', [{ amount: 40 }])];
    repo.names.set('p-1', 'Ana Pérez');
    repo.oldest.set('plan-p-1', new Date('2026-10-20T01:00:00.000Z'));

    const [row] = (await useCase.execute({})).items;

    expect(row.since).toBe('2026-10-19');
    // Hoy en Caracas es 3 de noviembre (23:00): 15 días.
    expect(row.ageDays).toBe(15);
  });

  it('con varios planes en la moneda, fecha el abono más antiguo de todos', async () => {
    repo.ledgers = [
      ledger('p-1', [], {
        plans: ['a', 'b'].map((id) => ({
          id: `plan-${id}`,
          status: 'CANCELLED' as const,
          currency: 'USD',
          createdAt: new Date('2026-01-01T12:00:00.000Z'),
          billable: 0,
          agingFrom: new Date('2026-01-01T12:00:00.000Z'),
        })),
        paid: [
          { treatmentPlanId: 'plan-a', currency: 'USD', amount: 10 },
          { treatmentPlanId: 'plan-b', currency: 'USD', amount: 20 },
        ],
      }),
    ];
    repo.names.set('p-1', 'Ana Pérez');
    repo.oldest.set('plan-a', new Date('2026-10-25T16:00:00.000Z'));
    repo.oldest.set('plan-b', new Date('2026-10-02T16:00:00.000Z'));

    const [row] = (await useCase.execute({})).items;

    expect(row.amount).toBe(30);
    expect(row.since).toBe('2026-10-02');
  });

  it('sin abono fechable, la fila sale sin antigüedad (no se inventa)', async () => {
    repo.ledgers = [ledger('p-1', [{ amount: 40 }])];
    repo.names.set('p-1', 'Ana Pérez');

    const [row] = (await useCase.execute({})).items;

    expect(row.since).toBeNull();
    expect(row.ageDays).toBeNull();
  });

  it('filtra por sede y por moneda, y rechaza una sede que no es de la clínica (400)', async () => {
    repo.ledgers = [
      ledger('p-norte', [{ amount: 10 }]),
      ledger('p-sur', [{ amount: 10 }], { locationId: SUR.id }),
    ];
    repo.names.set('p-norte', 'Norte');
    repo.names.set('p-sur', 'Sur');

    const sur = await useCase.execute({ locationId: SUR.id });
    expect(sur.items.map((r) => r.patient.id)).toEqual(['p-sur']);
    expect(sur.scope.location).toEqual({ id: SUR.id, name: SUR.name });
    expect(repo.ledgerQueries).toEqual([{ locationId: SUR.id }]);

    const ves = await useCase.execute({ currency: 'VES' });
    expect(ves.items).toEqual([]);

    await expect(useCase.execute({ locationId: 'otra' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('cada fila lleva la sede de su paciente y la fecha de «hoy» de la sede pedida', async () => {
    repo.ledgers = [ledger('p-norte', [{ amount: 10 }])];
    repo.names.set('p-norte', 'Norte');

    const page = await useCase.execute({});

    expect(page.items[0].location).toEqual({ id: NORTE.id, name: NORTE.name });
    expect(page.asOf).toBe('2026-11-03');
    expect(page.scope.location).toBeNull();
  });
});
