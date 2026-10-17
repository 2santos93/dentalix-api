import { BadRequestException } from '@nestjs/common';
import type {
  DebtorCollections,
  DebtorDetails,
  PatientLedger,
} from '../../domain/entities/receivables.entity';
import type {
  LedgersQuery,
  ReceivablesLocation,
  ReceivablesRepository,
} from '../../domain/ports/receivables-repository.port';
import {
  GetReceivablesAgingUseCase,
  RECEIVABLES_MAX_PAGE_SIZE,
} from './get-receivables-aging.use-case';

const NOW = new Date('2026-10-17T15:00:00.000Z');
const NORTE: ReceivablesLocation = {
  id: 'loc-norte',
  name: 'Sede Norte',
  timeZone: 'America/Bogota',
};

function ledger(
  patientId: string,
  billable: number,
  agingFrom: string,
  overrides: Partial<PatientLedger> = {},
): PatientLedger {
  return {
    patientId,
    locationId: NORTE.id,
    plans: [
      {
        id: `plan-${patientId}`,
        status: 'ACCEPTED',
        currency: 'COP',
        createdAt: new Date(agingFrom),
        billable,
        agingFrom: new Date(agingFrom),
      },
    ],
    paid: [],
    paymentPlans: [],
    ...overrides,
  };
}

function details(patientId: string, name: string): DebtorDetails {
  return {
    patientId,
    firstName: name,
    lastName: 'Prueba',
    phone: '300 123 4567',
    countryCode: 'CO',
    lastPayment: null,
  };
}

class InMemoryReceivablesRepository implements ReceivablesRepository {
  ledgers: PatientLedger[] = [];
  debtors: DebtorDetails[] = [];
  readonly ledgerQueries: LedgersQuery[] = [];
  readonly debtorQueries: string[][] = [];

  findLocation(id: string): Promise<ReceivablesLocation | null> {
    return Promise.resolve(id === NORTE.id ? NORTE : null);
  }

  locationTimeZones(): Promise<Map<string, string>> {
    return Promise.resolve(new Map([[NORTE.id, NORTE.timeZone]]));
  }

  loadLedgers(query: LedgersQuery): Promise<PatientLedger[]> {
    this.ledgerQueries.push(query);
    return Promise.resolve(
      this.ledgers.filter(
        (l) => !query.locationId || l.locationId === query.locationId,
      ),
    );
  }

  loadDebtors(patientIds: readonly string[]): Promise<DebtorDetails[]> {
    this.debtorQueries.push([...patientIds]);
    return Promise.resolve(
      this.debtors.filter((d) => patientIds.includes(d.patientId)),
    );
  }

  // DX-150: cobranza.
  openPromisePatients = new Set<string>();
  providerOf = new Map<string, string>();
  collections = new Map<string, DebtorCollections>();
  readonly collectionQueries: string[][] = [];

  patientsWithOpenPromise(): Promise<Set<string>> {
    return Promise.resolve(new Set(this.openPromisePatients));
  }

  patientsOfProvider(providerId: string): Promise<Set<string>> {
    return Promise.resolve(
      new Set(
        [...this.providerOf]
          .filter(([, provider]) => provider === providerId)
          .map(([patientId]) => patientId),
      ),
    );
  }

  loadCollections(
    patientIds: readonly string[],
  ): Promise<Map<string, DebtorCollections>> {
    this.collectionQueries.push([...patientIds]);
    return Promise.resolve(
      new Map([...this.collections].filter(([id]) => patientIds.includes(id))),
    );
  }
}

describe('GetReceivablesAgingUseCase', () => {
  let repo: InMemoryReceivablesRepository;
  let useCase: GetReceivablesAgingUseCase;

  beforeEach(() => {
    repo = new InMemoryReceivablesRepository();
    useCase = new GetReceivablesAgingUseCase(repo, () => NOW);
    repo.ledgers = [
      ledger('p-reciente', 100000, '2026-10-07T17:00:00.000Z'), // 10 días
      ledger('p-antiguo', 500000, '2026-06-19T17:00:00.000Z'), // 120 días
      ledger('p-medio', 200000, '2026-08-03T17:00:00.000Z'), // 75 días
      // Al día: no sale.
      ledger('p-al-dia', 100, '2026-01-01T17:00:00.000Z', {
        paid: [
          { treatmentPlanId: 'plan-p-al-dia', currency: 'COP', amount: 100 },
        ],
      }),
      // Solo saldo a favor: no es deudor, no sale.
      ledger('p-a-favor', 100, '2026-01-01T17:00:00.000Z', {
        paid: [
          { treatmentPlanId: 'plan-p-a-favor', currency: 'COP', amount: 300 },
        ],
      }),
    ];
    repo.debtors = [
      details('p-reciente', 'Rita'),
      details('p-antiguo', 'Ana'),
      details('p-medio', 'Mario'),
    ];
  });

  it('ordena a los deudores de la sede por antigüedad, con totales por tramo y moneda', async () => {
    const out = await useCase.execute({ locationId: NORTE.id });

    expect(out.scope).toEqual({ location: { id: NORTE.id, name: NORTE.name } });
    expect(out.asOf).toBe('2026-10-17');
    expect(out.items.map((r) => [r.patient.id, r.oldestAgeDays])).toEqual([
      ['p-antiguo', 120],
      ['p-medio', 75],
      ['p-reciente', 10],
    ]);
    expect(out.total).toBe(3);
    expect(out.totals).toEqual([
      {
        currency: 'COP',
        patients: 3,
        balance: 800000,
        debt: 800000,
        credit: 0,
        buckets: {
          current: 0,
          days0to30: 100000,
          days31to60: 0,
          days61to90: 200000,
          over90: 500000,
        },
      },
    ]);
    expect(out.items[0]).toMatchObject({
      patient: {
        id: 'p-antiguo',
        fullName: 'Ana Prueba',
        phone: '300 123 4567',
        whatsApp: '573001234567',
      },
      locationId: NORTE.id,
      ageApproximate: true,
      lastPayment: null,
      nextInstallment: null,
    });
    expect(repo.ledgerQueries).toEqual([{ locationId: NORTE.id }]);
  });

  it('filtra por antigüedad mínima (> 90 días)', async () => {
    const out = await useCase.execute({
      locationId: NORTE.id,
      minAgeDays: 91,
    });
    expect(out.items.map((r) => r.patient.id)).toEqual(['p-antiguo']);
    expect(out.totals[0]).toMatchObject({ patients: 1, debt: 500000 });
  });

  it('filtra por saldo mínimo', async () => {
    const out = await useCase.execute({ minBalance: 150000 });
    expect(out.items.map((r) => r.patient.id)).toEqual([
      'p-antiguo',
      'p-medio',
    ]);
  });

  it('filtra por moneda: solo esa moneda en filas y totales', async () => {
    repo.ledgers.push(
      ledger('p-usd', 0, '2026-10-01T17:00:00.000Z', {
        plans: [
          {
            id: 'plan-usd',
            status: 'ACCEPTED',
            currency: 'USD',
            createdAt: NOW,
            billable: 50,
            agingFrom: new Date('2026-10-01T17:00:00.000Z'),
          },
        ],
      }),
    );
    repo.debtors.push(details('p-usd', 'Uriel'));

    const usd = await useCase.execute({ currency: 'USD' });
    expect(usd.items.map((r) => r.patient.id)).toEqual(['p-usd']);
    expect(usd.totals.map((t) => t.currency)).toEqual(['USD']);
    expect(usd.items[0].currencies.map((c) => c.currency)).toEqual(['USD']);

    const all = await useCase.execute({});
    expect(all.totals.map((t) => t.currency)).toEqual(['COP', 'USD']);
  });

  it('pagina con tope y pide el contacto SOLO de la página', async () => {
    const page2 = await useCase.execute({ page: 2, pageSize: 2 });
    expect(page2.items.map((r) => r.patient.id)).toEqual(['p-reciente']);
    expect(page2).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    // Los totales son de TODAS las filas filtradas, no de la página.
    expect(page2.totals[0].patients).toBe(3);
    expect(repo.debtorQueries).toEqual([['p-reciente']]);

    const capped = await useCase.execute({ pageSize: 5000 });
    expect(capped.pageSize).toBe(RECEIVABLES_MAX_PAGE_SIZE);
  });

  it('una sede que no es de la clínica es un 400 en español', async () => {
    await expect(useCase.execute({ locationId: 'otra' })).rejects.toThrow(
      new BadRequestException('La sede no es de esta clínica.'),
    );
  });

  it('el último abono lleva su día civil en la zona de su sede', async () => {
    repo.debtors[1].lastPayment = {
      // 02:00 UTC del 1-oct = 21:00 del 30-sep en Bogotá.
      paidAt: new Date('2026-10-01T02:00:00.000Z'),
      timeZone: 'America/Bogota',
      amount: 50000,
      currency: 'COP',
    };
    const out = await useCase.execute({});
    expect(out.items[0].lastPayment).toEqual({
      paidOn: '2026-09-30',
      amount: 50000,
      currency: 'COP',
    });
  });

  it('exporta TODAS las filas filtradas, sin paginar', async () => {
    const rows = await useCase.exportRows({ minAgeDays: 1 });
    expect(rows.map((r) => r.patient.id)).toEqual([
      'p-antiguo',
      'p-medio',
      'p-reciente',
    ]);
  });

  describe('cobranza (DX-150)', () => {
    it('el CSV lleva el día de la última gestión en la zona de la sede de la deuda', async () => {
      // 21:00 del 15/10 en Bogotá = 02:00 UTC del 16/10.
      repo.collections.set('p-antiguo', {
        lastNote: {
          channel: 'CALL',
          outcome: 'NO_ANSWER',
          createdAt: new Date('2026-10-16T02:00:00.000Z'),
        },
        promise: null,
      });
      const rows = await useCase.exportRows({});
      expect(rows.find((r) => r.patient.id === 'p-antiguo')?.lastNoteOn).toBe(
        '2026-10-15',
      );
      expect(rows.find((r) => r.patient.id === 'p-medio')?.lastNoteOn).toBe(
        null,
      );
    });

    it('cada fila trae su última gestión y su compromiso, pedidos solo para la página', async () => {
      repo.collections.set('p-antiguo', {
        lastNote: {
          channel: 'CALL',
          outcome: 'PROMISED_PAYMENT',
          createdAt: new Date('2026-10-16T15:00:00.000Z'),
        },
        promise: {
          id: 'prom-1',
          amount: 200000,
          currency: 'COP',
          dueDate: '2026-11-15',
          status: 'OPEN',
        },
      });
      const out = await useCase.execute({ locationId: NORTE.id, pageSize: 2 });
      expect(out.items[0]).toMatchObject({
        patient: { id: 'p-antiguo' },
        lastNote: { channel: 'CALL', outcome: 'PROMISED_PAYMENT' },
        promise: { id: 'prom-1', status: 'OPEN', dueDate: '2026-11-15' },
      });
      expect(out.items[1]).toMatchObject({ lastNote: null, promise: null });
      expect(repo.collectionQueries).toEqual([['p-antiguo', 'p-medio']]);
    });

    it('hasPromise=true deja solo a quien tiene un compromiso abierto; false, al resto', async () => {
      repo.openPromisePatients = new Set(['p-medio']);
      const con = await useCase.execute({
        locationId: NORTE.id,
        hasPromise: true,
      });
      expect(con.items.map((r) => r.patient.id)).toEqual(['p-medio']);
      expect(con.totals[0]).toMatchObject({ patients: 1, debt: 200000 });
      const sin = await useCase.execute({
        locationId: NORTE.id,
        hasPromise: false,
      });
      expect(sin.items.map((r) => r.patient.id)).toEqual([
        'p-antiguo',
        'p-reciente',
      ]);
    });

    it('providerId deja a los pacientes atendidos por última vez por ese profesional', async () => {
      repo.providerOf = new Map([
        ['p-antiguo', 'dr-a'],
        ['p-reciente', 'dr-a'],
        ['p-medio', 'dr-b'],
      ]);
      const out = await useCase.execute({
        locationId: NORTE.id,
        providerId: 'dr-a',
      });
      expect(out.items.map((r) => r.patient.id)).toEqual([
        'p-antiguo',
        'p-reciente',
      ]);
    });
  });
});
