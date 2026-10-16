import { BadRequestException } from '@nestjs/common';
import { ClinicRole, PaymentMethod, TreatmentPlanStatus } from '@prisma/client';
import { ListCashPaymentsUseCase } from './list-cash-payments.use-case';
import { InMemoryPaymentRepository } from './__fixtures__/in-memory-payment.repository';
import type {
  CashRegisterPage,
  CashRegisterRow,
  ListCashRegisterParams,
} from '../../domain/ports/payment-repository.port';
import type { VoidActor, VoidSubject } from '../../domain/void-window';
import { CashPayment } from '../../domain/entities/cash-payment.entity';

// 2026-10-16 10:00 en Bogotá (UTC-5): el "hoy" de la sede de las filas.
const NOW = new Date('2026-10-16T15:00:00.000Z');
const clock = (): Date => NOW;
const ADMIN: VoidActor = { userId: 'u-admin', role: ClinicRole.ADMIN };
const RECEPTION: VoidActor = { userId: 'u-recep', role: ClinicRole.RECEPTION };

/** Registrado por recepción hoy (en la sede, Bogotá). */
const OWN_TODAY: VoidSubject = {
  createdById: 'u-recep',
  createdAt: new Date('2026-10-16T13:00:00.000Z'),
  timeZone: 'America/Bogota',
};

function fakeRow(
  id: string,
  overrides: Partial<CashPayment> = {},
  voidSubject: VoidSubject = OWN_TODAY,
): CashRegisterRow {
  const payment: CashPayment = {
    id,
    createdById: voidSubject.createdById,
    paidAt: new Date('2026-10-15T00:00:00.000Z'),
    amount: 100,
    currency: 'COP',
    method: PaymentMethod.CASH,
    notes: null,
    location: { id: 'loc-1', name: 'Sede principal' },
    patient: { id: 'pat-1', fullName: 'Ana Gómez' },
    treatmentPlan: {
      id: 'plan-1',
      status: TreatmentPlanStatus.ACCEPTED,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    },
    ...overrides,
  };
  return { payment, voidSubject };
}

/** El caso de uso con el reloj fijo y el actor dado (ADMIN por defecto). */
function useCaseFor(repo: InMemoryPaymentRepository, actor: VoidActor = ADMIN) {
  const useCase = new ListCashPaymentsUseCase(repo, clock);
  return {
    execute: (input: Parameters<ListCashPaymentsUseCase['execute']>[0]) =>
      useCase.execute(input, actor),
  };
}

/**
 * Espía sobre el fake en memoria: guarda los params con los que se le llamó
 * —la normalización de fechas y página ocurre ANTES de tocar la base, que es
 * lo que prueba este caso de uso— y devuelve la página que se le dé. Mismo
 * enfoque que list-catalog-directory.use-case.spec.ts.
 */
class SpyPaymentRepository extends InMemoryPaymentRepository {
  readonly calls: ListCashRegisterParams[] = [];

  constructor(
    private readonly page: CashRegisterPage = {
      items: [],
      total: 0,
      groups: [],
      scopeLocation: null,
    },
  ) {
    super();
  }

  override listForCashRegister(
    params: ListCashRegisterParams,
  ): Promise<CashRegisterPage> {
    this.calls.push(params);
    return Promise.resolve(this.page);
  }
}

const RANGE = { from: '2026-10-01', to: '2026-10-31' };

const OTHER_AUTHOR: VoidSubject = { ...OWN_TODAY, createdById: 'u-otra' };

describe('ListCashPaymentsUseCase', () => {
  it('convierte from/to (días civiles, ambos inclusive) en [from 00:00Z, to+1 00:00Z)', async () => {
    const repo = new SpyPaymentRepository();
    await useCaseFor(repo).execute({
      from: '2026-10-15',
      to: '2026-10-15',
    });

    expect(repo.calls[0].from.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    expect(repo.calls[0].toExclusive.toISOString()).toBe(
      '2026-10-16T00:00:00.000Z',
    );
  });

  it('cruza fin de mes y de año sin desbordar el día siguiente', async () => {
    const repo = new SpyPaymentRepository();
    await useCaseFor(repo).execute({
      from: '2026-12-01',
      to: '2026-12-31',
    });

    expect(repo.calls[0].toExclusive.toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('rechaza from posterior a to', async () => {
    const repo = new SpyPaymentRepository();
    await expect(
      useCaseFor(repo).execute({
        from: '2026-10-02',
        to: '2026-10-01',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.calls).toHaveLength(0);
  });

  it('acepta exactamente 366 días y rechaza 367', async () => {
    const repo = new SpyPaymentRepository();
    const useCase = useCaseFor(repo);

    // 2028 es bisiesto: 2028-01-01..2028-12-31 son 366 días.
    await expect(
      useCase.execute({ from: '2028-01-01', to: '2028-12-31' }),
    ).resolves.toBeDefined();
    await expect(
      useCase.execute({ from: '2026-01-01', to: '2027-01-02' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza una fecha que no existe en el calendario (2026-02-30)', async () => {
    const repo = new SpyPaymentRepository();
    await expect(
      useCaseFor(repo).execute({
        from: '2026-02-30',
        to: '2026-03-01',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('traduce la página a skip/take, con el tope de pageSize', async () => {
    const repo = new SpyPaymentRepository();
    const useCase = useCaseFor(repo);

    await useCase.execute({ ...RANGE, page: 3, pageSize: 10 });
    await useCase.execute({ ...RANGE, pageSize: 5000 });
    await useCase.execute({ ...RANGE, page: 0, pageSize: -4 });

    expect(repo.calls[0]).toMatchObject({ skip: 20, take: 10 });
    expect(repo.calls[1]).toMatchObject({ skip: 0, take: 100 });
    expect(repo.calls[2]).toMatchObject({ skip: 0, take: 20 });
  });

  it('pasa el método tal cual y lo omite si no viene', async () => {
    const repo = new SpyPaymentRepository();
    const useCase = useCaseFor(repo);

    await useCase.execute({ ...RANGE, method: PaymentMethod.TRANSFER });
    await useCase.execute(RANGE);

    expect(repo.calls[0].method).toBe(PaymentMethod.TRANSFER);
    expect(repo.calls[1].method).toBeUndefined();
  });

  it('devuelve filas, total, página efectiva, rango y alcance de sede', async () => {
    const repo = new SpyPaymentRepository({
      items: [fakeRow('p1')],
      total: 41,
      groups: [],
      scopeLocation: { id: 'loc-2', name: 'Sede Norte' },
    });

    const out = await useCaseFor(repo).execute({
      ...RANGE,
      page: 2,
      pageSize: 25,
    });

    expect(out).toMatchObject({
      items: [expect.objectContaining({ id: 'p1' })],
      total: 41,
      page: 2,
      pageSize: 25,
      from: '2026-10-01',
      to: '2026-10-31',
      scope: { location: { id: 'loc-2', name: 'Sede Norte' } },
    });
  });

  it('resume por moneda y por método+moneda, sumando en centavos (sin deriva de coma flotante)', async () => {
    const repo = new SpyPaymentRepository({
      items: [],
      total: 6,
      scopeLocation: null,
      groups: [
        { currency: 'USD', method: PaymentMethod.CARD, total: 0.1, count: 1 },
        { currency: 'USD', method: PaymentMethod.CASH, total: 0.2, count: 2 },
        { currency: 'COP', method: null, total: 50000, count: 1 },
        {
          currency: 'COP',
          method: PaymentMethod.CASH,
          total: 150000.55,
          count: 2,
        },
      ],
    });

    const { summary } = await useCaseFor(repo).execute(RANGE);

    expect(summary.count).toBe(6);
    // 0.1 + 0.2 en coma flotante es 0.30000000000000004.
    expect(summary.byCurrency).toEqual([
      { currency: 'COP', total: 200000.55, count: 3 },
      { currency: 'USD', total: 0.3, count: 3 },
    ]);
    // Orden estable: por método (orden del enum, "sin método" al final) y
    // dentro del método por moneda.
    expect(summary.byMethod).toEqual([
      {
        method: PaymentMethod.CASH,
        currency: 'COP',
        total: 150000.55,
        count: 2,
      },
      { method: PaymentMethod.CASH, currency: 'USD', total: 0.2, count: 2 },
      { method: PaymentMethod.CARD, currency: 'USD', total: 0.1, count: 1 },
      { method: null, currency: 'COP', total: 50000, count: 1 },
    ]);
  });

  it('un período sin pagos devuelve un resumen vacío, no un error', async () => {
    const repo = new SpyPaymentRepository();
    const out = await useCaseFor(repo).execute(RANGE);

    expect(out.summary).toEqual({ count: 0, byCurrency: [], byMethod: [] });
    expect(out.items).toEqual([]);
  });

  describe('canVoid por fila (DX-057)', () => {
    function pageWith(...items: CashRegisterRow[]): CashRegisterPage {
      return { items, total: items.length, groups: [], scopeLocation: null };
    }
    const OTHER_USER: VoidSubject = { ...OTHER_AUTHOR };
    const OWN_YESTERDAY: VoidSubject = {
      ...OWN_TODAY,
      // 23:30 del 15 en Bogotá: es 16 en UTC, pero no "hoy" en la sede.
      createdAt: new Date('2026-10-16T04:30:00.000Z'),
    };

    it('recepción: true solo en sus abonos de hoy (día de la sede)', async () => {
      const repo = new SpyPaymentRepository(
        pageWith(
          fakeRow('own-today'),
          fakeRow('other-user', {}, OTHER_USER),
          fakeRow('own-yesterday', {}, OWN_YESTERDAY),
          fakeRow('legacy', {}, { ...OWN_TODAY, createdById: null }),
        ),
      );

      const out = await useCaseFor(repo, RECEPTION).execute(RANGE);

      expect(
        out.items.map((item) => [item.id, item.canVoid, item.createdById]),
      ).toEqual([
        ['own-today', true, 'u-recep'],
        ['other-user', false, 'u-otra'],
        ['own-yesterday', false, 'u-recep'],
        ['legacy', false, null],
      ]);
    });

    it('ADMIN: true en todas las filas', async () => {
      const repo = new SpyPaymentRepository(
        pageWith(
          fakeRow('other-user', {}, OTHER_USER),
          fakeRow('own-yesterday', {}, OWN_YESTERDAY),
        ),
      );

      const out = await useCaseFor(repo, ADMIN).execute(RANGE);

      expect(out.items.map((item) => item.canVoid)).toEqual([true, true]);
    });

    it('no expone la zona horaria ni el alta interna en la fila', async () => {
      const repo = new SpyPaymentRepository(pageWith(fakeRow('p1')));
      const out = await useCaseFor(repo, RECEPTION).execute(RANGE);
      expect(out.items[0]).not.toHaveProperty('voidSubject');
      expect(out.items[0]).not.toHaveProperty('timeZone');
    });
  });
});
