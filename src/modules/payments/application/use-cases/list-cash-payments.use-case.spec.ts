import { BadRequestException } from '@nestjs/common';
import { ClinicRole, PaymentMethod, TreatmentPlanStatus } from '@prisma/client';
import {
  CASH_EXPORT_MAX_ROWS,
  CASH_EXPORT_TOO_MANY_MESSAGE,
  CASH_PERIOD_TOO_LONG_MESSAGE,
  INVALID_CASH_PERIOD_MESSAGE,
  ListCashPaymentsUseCase,
} from './list-cash-payments.use-case';
import type { ClinicPaymentMethodEntity } from '../../../payment-methods/domain/payment-method.entity';
import type { PaymentMethodRepository } from '../../../payment-methods/domain/ports/payment-method-repository.port';
import { PERIOD_DAY_OUT_OF_RANGE_MESSAGE } from '../../../../shared/time/civil-day';
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
    paidAt: new Date('2026-10-15T17:00:00.000Z'),
    paidOn: '2026-10-15',
    amount: 100,
    currency: 'COP',
    method: PaymentMethod.CASH,
    paymentMethod: null,
    reference: null,
    notes: null,
    location: { id: 'loc-1', name: 'Sede principal' },
    patient: { id: 'pat-1', fullName: 'Ana Gómez' },
    treatmentPlan: {
      id: 'plan-1',
      status: TreatmentPlanStatus.ACCEPTED,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    },
    openingBalance: null,
    splitId: null,
    splitLines: null,
    ...overrides,
  };
  return { payment, voidSubject };
}

const METHOD_AT = new Date('2026-01-01T00:00:00.000Z');
function medium(
  overrides: Partial<ClinicPaymentMethodEntity>,
): ClinicPaymentMethodEntity {
  return {
    id: 'pm-x',
    tenantId: 't1',
    name: 'Medio',
    kind: 'OTHER',
    active: true,
    requiresReference: false,
    legacyMethod: null,
    createdAt: METHOD_AT,
    updatedAt: METHOD_AT,
    ...overrides,
  };
}

/** Los medios de la clínica del contexto: lo que la RLS deja ver. */
const CLINIC_METHODS = [
  medium({
    id: 'pm-mobile',
    name: 'Pago móvil',
    kind: 'DIGITAL',
    requiresReference: true,
  }),
  medium({
    id: 'pm-cash',
    name: 'Efectivo',
    kind: 'CASH',
    legacyMethod: PaymentMethod.CASH,
  }),
  medium({ id: 'pm-old', name: 'Cheque', active: false }),
];

function methodsRepo(): PaymentMethodRepository {
  return {
    findById: (id: string) =>
      Promise.resolve(CLINIC_METHODS.find((m) => m.id === id) ?? null),
  } as Pick<PaymentMethodRepository, 'findById'> as PaymentMethodRepository;
}

/** El caso de uso con el reloj fijo y el actor dado (ADMIN por defecto). */
function useCaseFor(repo: InMemoryPaymentRepository, actor: VoidActor = ADMIN) {
  const useCase = new ListCashPaymentsUseCase(repo, clock, methodsRepo());
  return {
    execute: (input: Parameters<ListCashPaymentsUseCase['execute']>[0]) =>
      useCase.execute(input, actor),
    exportAll: (input: Parameters<ListCashPaymentsUseCase['exportAll']>[0]) =>
      useCase.exportAll(input, actor),
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
  it('pasa from/to como días CIVILES (ambos inclusive): la zona la pone el repositorio por sede (DX-097)', async () => {
    const repo = new SpyPaymentRepository();
    await useCaseFor(repo).execute({
      from: '2026-10-15',
      to: '2026-10-15',
    });

    expect(repo.calls[0]).toMatchObject({
      from: '2026-10-15',
      to: '2026-10-15',
    });
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

  it.each([
    [{ from: '2026-10-02', to: '2026-10-01' }, INVALID_CASH_PERIOD_MESSAGE],
    [{ from: '2026-01-01', to: '2027-01-02' }, CASH_PERIOD_TOO_LONG_MESSAGE],
    [{ from: '9999-12-30', to: '9999-12-31' }, PERIOD_DAY_OUT_OF_RANGE_MESSAGE],
    [{ from: '2026-10-01', to: '2101-01-01' }, PERIOD_DAY_OUT_OF_RANGE_MESSAGE],
  ])('400 en español sin consultar (BE-044): %j', async (input, message) => {
    const repo = new SpyPaymentRepository();
    await expect(useCaseFor(repo).execute(input)).rejects.toThrow(
      new BadRequestException(message),
    );
    expect(repo.calls).toHaveLength(0);
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

  describe('filtro por medio de pago de la clínica (DX-395)', () => {
    it('un medio propio: el repositorio filtra por su id, sin método antiguo', async () => {
      const repo = new SpyPaymentRepository();
      await useCaseFor(repo).execute({
        ...RANGE,
        paymentMethodId: 'pm-mobile',
      });

      expect(repo.calls[0].paymentMethod).toEqual({
        id: 'pm-mobile',
        legacyMethod: null,
      });
    });

    it('un medio inicial lleva su método: cuenta los abonos de réplicas anteriores sin medio', async () => {
      const repo = new SpyPaymentRepository();
      await useCaseFor(repo).execute({ ...RANGE, paymentMethodId: 'pm-cash' });

      expect(repo.calls[0].paymentMethod).toEqual({
        id: 'pm-cash',
        legacyMethod: PaymentMethod.CASH,
      });
    });

    it('un medio desactivado también filtra (sus abonos anteriores siguen en caja)', async () => {
      const repo = new SpyPaymentRepository();
      await useCaseFor(repo).execute({ ...RANGE, paymentMethodId: 'pm-old' });

      expect(repo.calls[0].paymentMethod).toEqual({
        id: 'pm-old',
        legacyMethod: null,
      });
    });

    it('un medio que no es de esta clínica: 400 en español, sin consultar la caja', async () => {
      const repo = new SpyPaymentRepository();
      await expect(
        useCaseFor(repo).execute({ ...RANGE, paymentMethodId: 'pm-de-otra' }),
      ).rejects.toThrow(
        new BadRequestException('Medio de pago no encontrado en esta clínica.'),
      );
      expect(repo.calls).toHaveLength(0);
    });

    it('sin medio no filtra por medio', async () => {
      const repo = new SpyPaymentRepository();
      await useCaseFor(repo).execute(RANGE);

      expect(repo.calls[0].paymentMethod).toBeUndefined();
    });
  });

  describe('exportAll: el CSV de la caja (DX-395)', () => {
    it('pide todas las filas del período (sin paginar) con los mismos filtros', async () => {
      const repo = new SpyPaymentRepository({
        items: [fakeRow('p1'), fakeRow('p2')],
        total: 2,
        groups: [],
        scopeLocation: null,
      });

      const out = await useCaseFor(repo).exportAll({
        ...RANGE,
        method: PaymentMethod.TRANSFER,
        paymentMethodId: 'pm-mobile',
      });

      expect(repo.calls[0]).toMatchObject({
        from: '2026-10-01',
        to: '2026-10-31',
        method: PaymentMethod.TRANSFER,
        paymentMethod: { id: 'pm-mobile', legacyMethod: null },
        skip: 0,
        take: CASH_EXPORT_MAX_ROWS + 1,
      });
      expect(out.items.map((i) => i.id)).toEqual(['p1', 'p2']);
    });

    it(`más de ${CASH_EXPORT_MAX_ROWS} abonos: 400 en español`, async () => {
      const repo = new SpyPaymentRepository({
        items: Array.from({ length: CASH_EXPORT_MAX_ROWS + 1 }, (_, i) =>
          fakeRow(`p${i}`),
        ),
        total: CASH_EXPORT_MAX_ROWS + 1,
        groups: [],
        scopeLocation: null,
      });

      await expect(useCaseFor(repo).exportAll(RANGE)).rejects.toThrow(
        new BadRequestException(CASH_EXPORT_TOO_MANY_MESSAGE),
      );
    });

    it('valida el período igual que la caja', async () => {
      const repo = new SpyPaymentRepository();
      await expect(
        useCaseFor(repo).exportAll({ from: '2026-10-02', to: '2026-10-01' }),
      ).rejects.toThrow(new BadRequestException(INVALID_CASH_PERIOD_MESSAGE));
      expect(repo.calls).toHaveLength(0);
    });
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

  it('DX-377: totaliza por medio y moneda; dos medios del mismo método suman en el método', async () => {
    const efectivo = { id: 'pm-cash', name: 'Efectivo' };
    const movil = { id: 'pm-mobile', name: 'Pago móvil' };
    const transferencia = { id: 'pm-transfer', name: 'Transferencia' };
    const repo = new SpyPaymentRepository({
      items: [],
      total: 5,
      scopeLocation: null,
      groups: [
        {
          currency: 'COP',
          method: PaymentMethod.TRANSFER,
          paymentMethod: movil,
          total: 100.1,
          count: 2,
        },
        {
          currency: 'COP',
          method: PaymentMethod.TRANSFER,
          paymentMethod: transferencia,
          total: 0.2,
          count: 1,
        },
        {
          currency: 'USD',
          method: PaymentMethod.CASH,
          paymentMethod: efectivo,
          total: 10,
          count: 1,
        },
        {
          currency: 'COP',
          method: null,
          paymentMethod: null,
          total: 5,
          count: 1,
        },
      ],
    });

    const { summary } = await useCaseFor(repo).execute(RANGE);

    expect(summary.byMethod).toEqual([
      { method: PaymentMethod.CASH, currency: 'USD', total: 10, count: 1 },
      {
        method: PaymentMethod.TRANSFER,
        currency: 'COP',
        total: 100.3,
        count: 3,
      },
      { method: null, currency: 'COP', total: 5, count: 1 },
    ]);
    expect(summary.byPaymentMethod).toEqual([
      {
        paymentMethodId: 'pm-cash',
        name: 'Efectivo',
        currency: 'USD',
        total: 10,
        count: 1,
      },
      {
        paymentMethodId: 'pm-mobile',
        name: 'Pago móvil',
        currency: 'COP',
        total: 100.1,
        count: 2,
      },
      {
        paymentMethodId: 'pm-transfer',
        name: 'Transferencia',
        currency: 'COP',
        total: 0.2,
        count: 1,
      },
      {
        paymentMethodId: null,
        name: null,
        currency: 'COP',
        total: 5,
        count: 1,
      },
    ]);
  });

  it('un período sin pagos devuelve un resumen vacío, no un error', async () => {
    const repo = new SpyPaymentRepository();
    const out = await useCaseFor(repo).execute(RANGE);

    expect(out.summary).toEqual({
      count: 0,
      byCurrency: [],
      byMethod: [],
      byPaymentMethod: [],
    });
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

  describe('día de registro por fila (DX-067)', () => {
    function pageWith(...items: CashRegisterRow[]): CashRegisterPage {
      return { items, total: items.length, groups: [], scopeLocation: null };
    }

    it('registeredOn es el día civil del alta EN LA SEDE y registeredToday lo compara con hoy allí', async () => {
      const repo = new SpyPaymentRepository(
        pageWith(
          // Alta hoy 08:00 en Bogotá, con fecha de pago de ayer.
          fakeRow('today'),
          // 23:30 del 15 en Bogotá: en UTC ya es 16, pero en la sede no es hoy.
          fakeRow(
            'late-yesterday',
            {},
            { ...OWN_TODAY, createdAt: new Date('2026-10-16T04:30:00.000Z') },
          ),
          // 20:00 del 16 en Madrid: allí ya es 16, en UTC también.
          fakeRow(
            'madrid',
            {},
            {
              ...OWN_TODAY,
              createdAt: new Date('2026-10-16T18:00:00.000Z'),
              timeZone: 'Europe/Madrid',
            },
          ),
        ),
      );

      const out = await useCaseFor(repo, RECEPTION).execute(RANGE);

      expect(
        out.items.map((item) => [
          item.id,
          item.registeredOn,
          item.registeredToday,
        ]),
      ).toEqual([
        ['today', '2026-10-16', true],
        ['late-yesterday', '2026-10-15', false],
        ['madrid', '2026-10-16', true],
      ]);
    });

    it('no depende del rol: ADMIN ve el mismo día de registro', async () => {
      const repo = new SpyPaymentRepository(pageWith(fakeRow('p1')));
      const out = await useCaseFor(repo, ADMIN).execute(RANGE);
      expect(out.items[0]).toMatchObject({
        registeredOn: '2026-10-16',
        registeredToday: true,
      });
    });
  });
});
