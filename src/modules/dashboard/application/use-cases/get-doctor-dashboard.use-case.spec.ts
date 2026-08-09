import { BadRequestException } from '@nestjs/common';
import { GetDoctorDashboardUseCase } from './get-doctor-dashboard.use-case';
import {
  GetPaymentsTotalsUseCase,
  GetPaymentsTotalsInput,
  GetPaymentsTotalsResult,
} from '../../../payments/application/use-cases/get-payments-totals.use-case';
import { InMemoryPaymentRepository } from '../../../payments/application/use-cases/__fixtures__/in-memory-payment.repository';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';
import {
  ListInventoryItemsUseCase,
  ListInventoryItemsInput,
  ListInventoryItemsOutput,
} from '../../../inventory/application/use-cases/list-inventory-items.use-case';
import { InventoryItemWithStock } from '../../../inventory/domain/entities/inventory-item.entity';
import {
  ListAppointmentsUseCase,
  ListAppointmentsInput,
} from '../../../appointments/application/use-cases/list-appointments.use-case';
import { Appointment } from '../../../appointments/domain/entities/appointment.entity';
import {
  ListPatientsUseCase,
  ListPatientsInput,
  ListPatientsOutput,
} from '../../../patients/application/use-cases/list-patients.use-case';
import { AppointmentStatus } from '@prisma/client';

/**
 * Fakes for the 4 reused use cases -- same pattern as
 * `FakeConvertAmountUseCase` in payments/get-payments-totals.use-case.spec.ts:
 * each reused use case here is a concrete class (not an interface port), so
 * a plain object literal isn't structurally assignable to it. Record calls
 * so specs can assert exactly what the dashboard use case forwards
 * downstream, then cast `as unknown as <Class>` at the injection site.
 */
class FakeGetPaymentsTotalsUseCase {
  public readonly calls: GetPaymentsTotalsInput[] = [];
  public result: GetPaymentsTotalsResult = {
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-31T00:00:00.000Z'),
    currency: 'USD',
    totalConverted: 0,
    count: 0,
    byCurrency: {},
  };

  execute(input: GetPaymentsTotalsInput): Promise<GetPaymentsTotalsResult> {
    this.calls.push(input);
    return Promise.resolve(this.result);
  }
}

class FakeListInventoryItemsUseCase {
  public items: InventoryItemWithStock[] = [];
  public readonly calls: ListInventoryItemsInput[] = [];

  // Genuinely honours `lowStockOnly`/`page`/`pageSize` -- same "real fake,
  // not a canned stub" convention as InMemoryInventoryRepository -- so specs
  // that drive this through GetDoctorDashboardUseCase exercise the actual
  // filter-then-paginate order (`total` computed on the FILTERED set, before
  // the page slice) rather than a stand-in that always echoes everything.
  execute(
    input: ListInventoryItemsInput = {},
  ): Promise<ListInventoryItemsOutput> {
    this.calls.push(input);
    const filtered = input.lowStockOnly
      ? this.items.filter((item) => item.lowStock)
      : this.items;
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;
    const start = (page - 1) * pageSize;
    return Promise.resolve({
      items: filtered.slice(start, start + pageSize),
      total: filtered.length,
      page,
      pageSize,
    });
  }
}

class FakeListAppointmentsUseCase {
  public readonly calls: ListAppointmentsInput[] = [];
  public items: Appointment[] = [];

  execute(input: ListAppointmentsInput): Promise<Appointment[]> {
    this.calls.push(input);
    return Promise.resolve(this.items);
  }
}

class FakeListPatientsUseCase {
  public readonly calls: ListPatientsInput[] = [];
  public output: ListPatientsOutput = {
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
  };

  execute(input: ListPatientsInput): Promise<ListPatientsOutput> {
    this.calls.push(input);
    return Promise.resolve(this.output);
  }
}

function makeInventoryItem(
  overrides: Partial<InventoryItemWithStock>,
): InventoryItemWithStock {
  return {
    id: 'item-1',
    tenantId: 'tenant-1',
    name: 'Gloves',
    sku: null,
    unit: 'box',
    minStock: 5,
    notes: null,
    createdById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    stock: 10,
    lowStock: false,
    ...overrides,
  };
}

function makeAppointment(overrides: Partial<Appointment>): Appointment {
  return {
    id: 'appt-1',
    tenantId: 'tenant-1',
    patientId: 'patient-1',
    patientFirstName: null,
    patientLastName: null,
    providerId: 'provider-1',
    start: new Date('2026-08-01T10:00:00.000Z'),
    end: new Date('2026-08-01T11:00:00.000Z'),
    status: AppointmentStatus.SCHEDULED,
    reason: null,
    notes: null,
    createdById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('GetDoctorDashboardUseCase', () => {
  function makeUseCase() {
    const incomesUc = new FakeGetPaymentsTotalsUseCase();
    const inventoryUc = new FakeListInventoryItemsUseCase();
    const appointmentsUc = new FakeListAppointmentsUseCase();
    const patientsUc = new FakeListPatientsUseCase();

    const uc = new GetDoctorDashboardUseCase(
      incomesUc as unknown as GetPaymentsTotalsUseCase,
      inventoryUc as unknown as ListInventoryItemsUseCase,
      appointmentsUc as unknown as ListAppointmentsUseCase,
      patientsUc as unknown as ListPatientsUseCase,
    );

    return { incomesUc, inventoryUc, appointmentsUc, patientsUc, uc };
  }

  const baseInput = {
    from: new Date('2026-07-01T00:00:00.000Z'),
    to: new Date('2026-07-31T00:00:00.000Z'),
    currency: 'USD',
  };

  it('forwards {from,to,currency} to GetPaymentsTotalsUseCase and returns its result', async () => {
    const { incomesUc, uc } = makeUseCase();
    incomesUc.result = {
      from: baseInput.from,
      to: baseInput.to,
      currency: 'USD',
      totalConverted: 1234.5,
      count: 3,
      byCurrency: { USD: 1234.5 },
    };

    const result = await uc.execute(baseInput);

    expect(incomesUc.calls).toEqual([
      { from: baseInput.from, to: baseInput.to, currency: 'USD' },
    ]);
    expect(result.incomes).toEqual(incomesUc.result);
    expect(result.period).toEqual({ from: baseInput.from, to: baseInput.to });
  });

  it('includes ONLY low-stock items in lowStockItems, with a matching count', async () => {
    const { inventoryUc, uc } = makeUseCase();
    inventoryUc.items = [
      makeInventoryItem({
        id: 'i1',
        name: 'Gloves',
        stock: 2,
        minStock: 5,
        lowStock: true,
      }),
      makeInventoryItem({
        id: 'i2',
        name: 'Masks',
        stock: 50,
        minStock: 10,
        lowStock: false,
      }),
      makeInventoryItem({
        id: 'i3',
        name: 'Anesthetic',
        stock: 0,
        minStock: 3,
        lowStock: true,
        unit: 'vial',
      }),
    ];

    const result = await uc.execute(baseInput);

    expect(result.lowStockItems.count).toBe(2);
    expect(result.lowStockItems.items).toEqual([
      { id: 'i1', name: 'Gloves', unit: 'box', stock: 2, minStock: 5 },
      { id: 'i3', name: 'Anesthetic', unit: 'vial', stock: 0, minStock: 3 },
    ]);
    // The dashboard delegates the filter to ListInventoryItemsUseCase itself
    // (`lowStockOnly: true`) rather than fetching everything and filtering
    // here -- this is what keeps `count` exact regardless of the preview
    // `pageSize` (see the next test).
    expect(inventoryUc.calls).toEqual([{ lowStockOnly: true, pageSize: 100 }]);
  });

  it('reports the TRUE low-stock count even when it exceeds the preview pageSize (100)', async () => {
    const { inventoryUc, uc } = makeUseCase();
    const LOW_STOCK_COUNT = 105; // > the dashboard's 100-item preview page
    inventoryUc.items = Array.from({ length: LOW_STOCK_COUNT }, (_, i) =>
      makeInventoryItem({
        id: `low-${i}`,
        name: `Item ${String(i).padStart(3, '0')}`,
        stock: 1,
        minStock: 5,
        lowStock: true,
      }),
    );

    const result = await uc.execute(baseInput);

    // This is the regression the count must NOT reproduce: before delegating
    // `lowStockOnly` to the repo, the dashboard fetched one page (capped at
    // 100) and counted `.length` on it -- silently truncating the count for
    // any clinic with more than 100 simultaneous low-stock items.
    expect(result.lowStockItems.count).toBe(LOW_STOCK_COUNT);
    expect(result.lowStockItems.items).toHaveLength(100);
  });

  it('filters out past appointments, sorts ascending by start, and respects upcomingLimit', async () => {
    const { appointmentsUc, uc } = makeUseCase();
    const now = new Date('2026-07-15T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);

    appointmentsUc.items = [
      makeAppointment({
        id: 'future-late',
        start: new Date('2026-08-10T09:00:00.000Z'),
        end: new Date('2026-08-10T10:00:00.000Z'),
      }),
      makeAppointment({
        id: 'past',
        start: new Date('2026-07-01T09:00:00.000Z'),
        end: new Date('2026-07-01T10:00:00.000Z'),
      }),
      makeAppointment({
        id: 'future-early',
        start: new Date('2026-07-16T09:00:00.000Z'),
        end: new Date('2026-07-16T10:00:00.000Z'),
      }),
      makeAppointment({
        id: 'future-mid',
        start: new Date('2026-07-20T09:00:00.000Z'),
        end: new Date('2026-07-20T10:00:00.000Z'),
      }),
    ];

    const result = await uc.execute({ ...baseInput, upcomingLimit: 2 });

    expect(result.upcomingAppointments.map((a) => a.id)).toEqual([
      'future-early',
      'future-mid',
    ]);
    expect(result.upcomingAppointments[0]).toEqual({
      id: 'future-early',
      patientId: 'patient-1',
      // Carried through from the appointment, so the dashboard can name the
      // patient without a `GET /patients?pageSize=100` lookup (which capped
      // at 100 and left a raw UUID on screen past that).
      patientFirstName: null,
      patientLastName: null,
      providerId: 'provider-1',
      start: new Date('2026-07-16T09:00:00.000Z'),
      end: new Date('2026-07-16T10:00:00.000Z'),
      status: AppointmentStatus.SCHEDULED,
    });

    jest.useRealTimers();
  });

  it("carries the appointment's joined patient name into upcomingAppointments", async () => {
    const { appointmentsUc, uc } = makeUseCase();
    jest.useFakeTimers().setSystemTime(new Date('2026-07-15T12:00:00.000Z'));

    appointmentsUc.items = [
      makeAppointment({
        id: 'future-named',
        patientFirstName: 'Ana',
        patientLastName: 'García',
        start: new Date('2026-07-16T09:00:00.000Z'),
        end: new Date('2026-07-16T10:00:00.000Z'),
      }),
    ];

    const result = await uc.execute(baseInput);

    // Without this the dashboard had to resolve the name itself via
    // `GET /patients?pageSize=100` — a UUID on screen past 100 patients.
    expect(result.upcomingAppointments[0].patientFirstName).toBe('Ana');
    expect(result.upcomingAppointments[0].patientLastName).toBe('García');

    jest.useRealTimers();
  });

  it('defaults upcomingLimit to 5 when not provided', async () => {
    const { appointmentsUc, uc } = makeUseCase();
    const now = new Date('2026-07-15T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);

    appointmentsUc.items = Array.from({ length: 7 }, (_, i) =>
      makeAppointment({
        id: `future-${i}`,
        start: new Date(now.getTime() + (i + 1) * 24 * 60 * 60 * 1000),
        end: new Date(now.getTime() + (i + 1) * 24 * 60 * 60 * 1000 + 3600000),
      }),
    );

    const result = await uc.execute(baseInput);

    expect(result.upcomingAppointments).toHaveLength(5);
    expect(result.upcomingAppointments.map((a) => a.id)).toEqual([
      'future-0',
      'future-1',
      'future-2',
      'future-3',
      'future-4',
    ]);

    jest.useRealTimers();
  });

  it('equals patientCount to the mocked ListPatientsUseCase total', async () => {
    const { patientsUc, uc } = makeUseCase();
    patientsUc.output = { items: [], total: 42, page: 1, pageSize: 20 };

    const result = await uc.execute(baseInput);

    expect(result.patientCount).toBe(42);
  });

  it('rejects a from > to range with a clear error', async () => {
    const { uc } = makeUseCase();

    await expect(
      uc.execute({
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: new Date('2026-07-01T00:00:00.000Z'),
        currency: 'USD',
      }),
    ).rejects.toThrow(/from.*to|to.*from/i);
  });

  it('rejects a blank currency with a clear error', async () => {
    const { uc } = makeUseCase();

    await expect(uc.execute({ ...baseInput, currency: '  ' })).rejects.toThrow(
      /currency/i,
    );
  });

  // IMP-4b (end-to-end): a single stored payment with an unconvertible
  // currency must not fail the WHOLE dashboard. Wires the REAL
  // GetPaymentsTotalsUseCase (not the fake above) over an in-memory payment
  // repo, plus a ConvertAmountUseCase double that throws for one currency,
  // to prove the resilience added in GetPaymentsTotalsUseCase.execute()
  // actually prevents GetDoctorDashboardUseCase's Promise.all from
  // rejecting wholesale (stock/patients/appointments would otherwise be
  // dragged down by one bad income row).
  it('does not fail wholesale when one payment has an unconvertible currency', async () => {
    const paymentRepo = new InMemoryPaymentRepository();
    paymentRepo.seedPayment({
      id: 'p-good',
      currency: 'USD',
      amount: 100,
      paidAt: new Date('2026-07-10T00:00:00.000Z'),
    });
    paymentRepo.seedPayment({
      id: 'p-bad',
      currency: 'ZZZ',
      amount: 999,
      paidAt: new Date('2026-07-11T00:00:00.000Z'),
    });

    // Mirrors the REAL ConvertAmountUseCase contract: an unsupported
    // currency rejects with a `BadRequestException` whose message starts
    // with "unsupported currency" (see convert-amount.use-case.ts) -- that
    // is the ONLY error shape GetPaymentsTotalsUseCase's narrowed catch
    // treats as "safe to skip" (IMP-4b). A generic `Error` here would no
    // longer be swallowed and would (correctly) fail this test's
    // "wholesale dashboard resilience" assertion.
    class FailingForZzzConvertAmountUseCase {
      execute(input: { amount: number; from: string; to: string }) {
        if (input.from === 'ZZZ') {
          return Promise.reject(
            new BadRequestException('unsupported currency: ZZZ'),
          );
        }
        return Promise.resolve({
          ...input,
          date: '2026-07-10',
          result: input.amount,
          rateUsed: 1,
        });
      }
    }

    const realIncomesUc = new GetPaymentsTotalsUseCase(
      paymentRepo,
      new FailingForZzzConvertAmountUseCase() as unknown as ConvertAmountUseCase,
    );

    const inventoryUc = new FakeListInventoryItemsUseCase();
    const appointmentsUc = new FakeListAppointmentsUseCase();
    const patientsUc = new FakeListPatientsUseCase();
    patientsUc.output = { items: [], total: 7, page: 1, pageSize: 20 };

    const uc = new GetDoctorDashboardUseCase(
      realIncomesUc,
      inventoryUc as unknown as ListInventoryItemsUseCase,
      appointmentsUc as unknown as ListAppointmentsUseCase,
      patientsUc as unknown as ListPatientsUseCase,
    );

    const result = await uc.execute({
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-07-31T00:00:00.000Z'),
      currency: 'USD',
    });

    // Only the good payment contributes; the whole dashboard still
    // resolves (patients/stock/appointments included) instead of throwing.
    expect(result.incomes.totalConverted).toBe(100);
    expect(result.incomes.count).toBe(2);
    expect(result.patientCount).toBe(7);
  });
});
