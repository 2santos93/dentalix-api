import { BadRequestException } from '@nestjs/common';
import { planBalanceWithoutLiveRates } from '../../../payments/application/__fixtures__/plan-balance-without-live-rates';
import { locationZonesOf } from '../../../../shared/locations/location-time-zone';
import type {
  OriginPayment,
  PlanCreditFacts,
} from '../../domain/entities/credit-balances.entity';
import type { PatientLedger } from '../../domain/entities/receivables.entity';
import type { CreditBalancesRepository } from '../../domain/ports/credit-balances-repository.port';
import type { ReceivablesLocation } from '../../domain/ports/receivables-repository.port';
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

const paymentAt = (
  iso: string,
  locationId: string,
  planCents: number | null = 0,
): OriginPayment => ({ paidAt: new Date(iso), locationId, planCents });

const planRow = (
  id: string,
  over: Partial<PatientLedger['plans'][number]> = {},
): PatientLedger['plans'][number] => ({
  id,
  status: 'CANCELLED',
  currency: 'USD',
  createdAt: new Date('2026-01-01T12:00:00.000Z'),
  billable: 0,
  agingFrom: new Date('2026-01-01T12:00:00.000Z'),
  ...over,
});

/** Un paciente con un plan cancelado `plan-<id>` con `paid` abonado. */
function ledger(
  patientId: string,
  paid: { currency?: string; amount: number }[],
  over: Partial<PatientLedger> = {},
): PatientLedger {
  return {
    patientId,
    // La sede de la cartera NO decide dónde está el saldo.
    locationId: 'loc-cartera',
    plans: [planRow(`plan-${patientId}`)],
    paid: paid.map((p) => ({
      treatmentPlanId: `plan-${patientId}`,
      currency: p.currency ?? 'USD',
      amount: p.amount,
    })),
    paymentPlans: [],
    ...over,
  };
}

class InMemoryRepository implements CreditBalancesRepository {
  ledgers: PatientLedger[] = [];
  names = new Map<string, string>();
  facts = new Map<string, PlanCreditFacts>();
  allowed: string[] | undefined = undefined;
  readonly nameQueries: string[][] = [];
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
  loadCreditLedgers(): Promise<PatientLedger[]> {
    return Promise.resolve(this.ledgers);
  }
  allowedLocationIds(): string[] | undefined {
    return this.allowed;
  }
  patientNames(ids: readonly string[]): Promise<Map<string, string>> {
    this.nameQueries.push([...ids]);
    return Promise.resolve(
      new Map([...this.names].filter(([id]) => ids.includes(id))),
    );
  }
  planCreditFacts(
    ids: readonly string[],
  ): Promise<Map<string, PlanCreditFacts>> {
    return Promise.resolve(
      new Map([...this.facts].filter(([id]) => ids.includes(id))),
    );
  }

  /** Un plan cancelado cuyo dinero se cobró en `locationId` el `iso`. */
  paidAt(patientId: string, iso: string, locationId: string): void {
    this.facts.set(`plan-${patientId}`, {
      planLocationId: null,
      ownPayments: [paymentAt(iso, locationId, 1)],
      transferredPayments: [],
    });
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

  const seed = (
    id: string,
    amount: number,
    locationId = NORTE.id,
    iso = '2026-10-20T16:00:00.000Z',
  ) => {
    repo.ledgers.push(ledger(id, [{ amount }]));
    repo.names.set(id, `Paciente ${id}`);
    repo.paidAt(id, iso, locationId);
  };

  it('ordena por moneda y luego por importe descendente, y desempata por paciente', async () => {
    seed('p-b', 50);
    seed('p-a', 50);
    seed('p-grande', 900);
    repo.ledgers.push(
      ledger('p-ves', [{ currency: 'VES', amount: 99999 }], {
        plans: [planRow('plan-p-ves', { currency: 'VES' })],
      }),
    );
    repo.names.set('p-ves', 'Paciente p-ves');
    repo.paidAt('p-ves', '2026-10-20T16:00:00.000Z', NORTE.id);

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

  it('quien no tiene saldo a favor (ya traspasado o devuelto, o con deuda) no sale', async () => {
    repo.ledgers = [
      ledger('p-devuelto', []),
      ledger('p-deuda', [{ amount: 20 }], {
        plans: [planRow('plan-p-deuda', { status: 'ACCEPTED', billable: 100 })],
      }),
    ];
    repo.names.set('p-devuelto', 'A');
    repo.names.set('p-deuda', 'B');

    const page = await useCase.execute({});

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.totals).toEqual([]);
  });

  it('pagina y solo pide nombres de la página', async () => {
    seed('p-1', 30);
    seed('p-2', 29);
    seed('p-3', 28);

    const second = await useCase.execute({ page: 2, pageSize: 2 });

    expect(second.items.map((r) => r.patient.id)).toEqual(['p-3']);
    expect(second.total).toBe(3);
    expect(repo.nameQueries).toEqual([['p-3']]);
  });

  it('recorta pageSize al tope', async () => {
    expect((await useCase.execute({ pageSize: 100000 })).pageSize).toBe(
      CREDIT_BALANCES_MAX_PAGE_SIZE,
    );
  });

  describe('sede: el saldo está donde está el dinero, no donde fue la última cita', () => {
    it('sin sede en el plan, la del abono que lo originó (aunque la cartera del paciente sea otra)', async () => {
      seed('p-1', 40, SUR.id);

      const [row] = (await useCase.execute({})).items;

      expect(row.location).toEqual({ id: SUR.id, name: SUR.name });
    });

    it('la sede del propio plan manda sobre la del abono', async () => {
      seed('p-1', 40, SUR.id);
      repo.facts.set('plan-p-1', {
        planLocationId: NORTE.id,
        ownPayments: [paymentAt('2026-10-20T16:00:00.000Z', SUR.id, 1)],
        transferredPayments: [],
      });

      const [row] = (await useCase.execute({})).items;

      expect(row.location?.id).toBe(NORTE.id);
    });

    it('un paciente con saldo en dos sedes sale en dos filas; la suma es el total por moneda', async () => {
      repo.ledgers.push(
        ledger('p-1', [], {
          plans: [planRow('plan-n'), planRow('plan-s')],
          paid: [
            { treatmentPlanId: 'plan-n', currency: 'USD', amount: 70 },
            { treatmentPlanId: 'plan-s', currency: 'USD', amount: 30 },
          ],
        }),
      );
      repo.names.set('p-1', 'Ana');
      repo.facts.set('plan-n', {
        planLocationId: null,
        ownPayments: [paymentAt('2026-10-20T16:00:00.000Z', NORTE.id, 7000)],
        transferredPayments: [],
      });
      repo.facts.set('plan-s', {
        planLocationId: null,
        ownPayments: [paymentAt('2026-10-21T16:00:00.000Z', SUR.id, 3000)],
        transferredPayments: [],
      });

      const page = await useCase.execute({});

      expect(page.items.map((r) => [r.location?.id, r.amount])).toEqual([
        [NORTE.id, 70],
        [SUR.id, 30],
      ]);
      expect(page.totals).toEqual([
        { currency: 'USD', patients: 1, amount: 100 },
      ]);
    });

    it('dos planes del mismo paciente en la misma sede y moneda se suman en una fila', async () => {
      repo.ledgers.push(
        ledger('p-1', [], {
          plans: [planRow('plan-a'), planRow('plan-b')],
          paid: [
            { treatmentPlanId: 'plan-a', currency: 'USD', amount: 10 },
            { treatmentPlanId: 'plan-b', currency: 'USD', amount: 5 },
          ],
        }),
      );
      repo.names.set('p-1', 'Ana');
      for (const [plan, day] of [
        ['plan-a', '2026-10-20'],
        ['plan-b', '2026-10-02'],
      ]) {
        repo.facts.set(plan, {
          planLocationId: null,
          ownPayments: [paymentAt(`${day}T16:00:00.000Z`, NORTE.id, 1)],
          transferredPayments: [],
        });
      }

      const page = await useCase.execute({});

      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ amount: 15, since: '2026-10-02' });
    });

    it('un miembro restringido solo ve las filas de sus sedes; las sin sede, tampoco', async () => {
      seed('p-norte', 10, NORTE.id);
      seed('p-sur', 20, SUR.id);
      repo.ledgers.push(ledger('p-sin', [{ amount: 5 }]));
      repo.names.set('p-sin', 'Sin sede');
      repo.allowed = [SUR.id];

      const page = await useCase.execute({});

      expect(page.items.map((r) => r.patient.id)).toEqual(['p-sur']);
      expect(page.total).toBe(1);
    });

    it('sin restricción, todo, también lo que no tiene sede', async () => {
      seed('p-norte', 10, NORTE.id);
      repo.ledgers.push(ledger('p-sin', [{ amount: 5 }]));
      repo.names.set('p-sin', 'Sin sede');

      const page = await useCase.execute({});

      expect(page.items.map((r) => r.patient.id)).toEqual(['p-norte', 'p-sin']);
      expect(page.items[1].location).toBeNull();
    });

    it('?locationId filtra por esa atribución, y una sede que no es de la clínica es 400', async () => {
      seed('p-norte', 10, NORTE.id);
      seed('p-sur', 20, SUR.id);

      const sur = await useCase.execute({ locationId: SUR.id });
      expect(sur.items.map((r) => r.patient.id)).toEqual(['p-sur']);
      expect(sur.scope.location).toEqual({ id: SUR.id, name: SUR.name });

      await expect(useCase.execute({ locationId: 'otra' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('aviso de abonos sin tasa: respeta el mismo filtro de sede que las filas', () => {
    /** Plan USD con un abono en VES «sin tasa» (no suma) cobrado en `locationId`. */
    const withMissingRate = (id: string, locationId: string) => {
      repo.ledgers.push(
        ledger(id, [{ amount: 130 }], {
          plans: [
            planRow(`plan-${id}`, {
              status: 'ACCEPTED',
              billable: 100,
              otherCurrency: {
                based: 0,
                pending: [
                  {
                    id: `pay-${id}`,
                    currency: 'VES',
                    amount: 5400,
                    paidAt: new Date('2026-10-06T15:00:00.000Z'),
                    locationId,
                    exchangeRateCurrency: 'USD',
                    frozenRate: null,
                  },
                ],
              },
            }),
          ],
        }),
      );
      repo.names.set(id, id);
      repo.paidAt(id, '2026-10-05T15:00:00.000Z', locationId);
    };

    it('un miembro de Norte no cuenta los abonos sin tasa de Sur; sin restricción, los dos', async () => {
      withMissingRate('p-norte', NORTE.id);
      withMissingRate('p-sur', SUR.id);

      expect((await useCase.execute({})).paymentsWithoutRateCount).toBe(2);

      repo.allowed = [NORTE.id];
      expect((await useCase.execute({})).paymentsWithoutRateCount).toBe(1);
      repo.allowed = undefined;
      expect(
        (await useCase.execute({ locationId: SUR.id }))
          .paymentsWithoutRateCount,
      ).toBe(1);
    });

    it('un plan con deuda (sin fila) y un abono sin tasa se cuenta en la sede de su abono', async () => {
      withMissingRate('p-sur', SUR.id);
      repo.ledgers[0].paid = [];
      repo.allowed = [NORTE.id];
      expect((await useCase.execute({})).paymentsWithoutRateCount).toBe(0);
      repo.allowed = [SUR.id];
      expect((await useCase.execute({})).paymentsWithoutRateCount).toBe(1);
    });
  });

  it('filtra por moneda', async () => {
    seed('p-1', 10);
    expect((await useCase.execute({ currency: 'VES' })).items).toEqual([]);
  });

  describe('antigüedad: el día civil del abono que originó el saldo, en SU sede', () => {
    it('01:00 UTC del 20 de octubre es el 19 en Caracas', async () => {
      seed('p-1', 40, NORTE.id, '2026-10-20T01:00:00.000Z');

      const [row] = (await useCase.execute({})).items;

      expect(row.since).toBe('2026-10-19');
      // Hoy en Caracas es el 3 de noviembre (23:00): 15 días.
      expect(row.ageDays).toBe(15);
    });

    it('un abono hecho en otra sede se fecha en la zona de ESA sede, no de la fila', async () => {
      repo.ledgers.push(ledger('p-1', [{ amount: 40 }]));
      repo.names.set('p-1', 'Ana');
      repo.facts.set('plan-p-1', {
        planLocationId: NORTE.id,
        ownPayments: [paymentAt('2026-11-02T04:30:00.000Z', SUR.id, 1)],
        transferredPayments: [],
      });

      const [row] = (await useCase.execute({})).items;

      // 04:30 UTC del 2 de noviembre: 23:30 del 1 en Nueva York (UTC-5), pero
      // 00:30 del 2 en Caracas (UTC-4), la zona de la fila.
      expect(row.since).toBe('2026-11-01');
      expect(row.location?.id).toBe(NORTE.id);
    });

    it('sin abono fechable, la fila sale sin antigüedad', async () => {
      repo.ledgers.push(ledger('p-1', [{ amount: 40 }]));
      repo.names.set('p-1', 'Ana');

      const [row] = (await useCase.execute({})).items;

      expect(row.since).toBeNull();
      expect(row.ageDays).toBeNull();
    });
  });

  it('«hoy» es el de la sede del alcance', async () => {
    seed('p-1', 10);
    const page = await useCase.execute({});
    expect(page.asOf).toBe('2026-11-03');
    expect(page.scope.location).toBeNull();
  });
});
