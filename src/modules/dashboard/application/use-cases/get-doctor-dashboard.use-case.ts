import { BadRequestException, Injectable } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import {
  GetPaymentsTotalsUseCase,
  GetPaymentsTotalsResult,
} from '../../../payments/application/use-cases/get-payments-totals.use-case';
import { ListInventoryItemsUseCase } from '../../../inventory/application/use-cases/list-inventory-items.use-case';
import { ListAppointmentsUseCase } from '../../../appointments/application/use-cases/list-appointments.use-case';
import { ListPatientsUseCase } from '../../../patients/application/use-cases/list-patients.use-case';

const DEFAULT_UPCOMING_LIMIT = 5;
// Wide-enough window to surface "next N" appointments without requiring the
// caller to know the range in advance: ListAppointmentsUseCase.execute()
// takes a mandatory {from,to} range (see appointments/list-appointments.
// use-case.ts), so we pass [now, now + UPCOMING_WINDOW_DAYS] and then
// filter/sort/limit here -- composing in the dashboard use case rather than
// changing the owner module's contract (per the plan's guidance).
const UPCOMING_WINDOW_DAYS = 90;

export interface GetDoctorDashboardInput {
  from: Date;
  to: Date;
  currency: string;
  upcomingLimit?: number;
}

export interface DashboardLowStockItem {
  id: string;
  name: string;
  unit: string;
  stock: number;
  minStock: number;
}

export interface DashboardUpcomingAppointment {
  id: string;
  patientId: string;
  /** Joined from Patient (see `Appointment.patientFirstName`) so the dashboard can name the patient without fetching the patient list — which capped at 100 and rendered a UUID past that. */
  patientFirstName: string | null;
  patientLastName: string | null;
  providerId: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
}

export interface GetDoctorDashboardResult {
  period: { from: Date; to: Date };
  /** "Incomes of the period" — Σ payments (abonos) received, converted to
   * the requested currency by each payment's own paidAt date (see
   * GetPaymentsTotalsUseCase, which replaced the old sales-based metric —
   * see docs/plans/2026-07-24-payments-pivot.md). */
  incomes: GetPaymentsTotalsResult;
  lowStockItems: {
    count: number;
    items: DashboardLowStockItem[];
  };
  upcomingAppointments: DashboardUpcomingAppointment[];
  patientCount: number;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Aggregates the "doctor dashboard" view purely by composing 4 existing use
 * cases via DI -- never touching a repository directly (see the plan at
 * docs/plans/2026-07-24-dashboard.md and DashboardModule, which imports
 * PaymentsModule/InventoryModule/AppointmentsModule/PatientsModule for
 * exactly this). Mirrors the cross-module reuse pattern already used by
 * GetPaymentsTotalsUseCase injecting ConvertAmountUseCase (PaymentsModule
 * imports ExchangeModule, which exports it).
 */
@Injectable()
export class GetDoctorDashboardUseCase {
  constructor(
    private readonly getPaymentsTotals: GetPaymentsTotalsUseCase,
    private readonly listInventoryItems: ListInventoryItemsUseCase,
    private readonly listAppointments: ListAppointmentsUseCase,
    private readonly listPatients: ListPatientsUseCase,
  ) {}

  async execute(
    input: GetDoctorDashboardInput,
  ): Promise<GetDoctorDashboardResult> {
    if (!isValidDate(input.from)) {
      throw new BadRequestException('from must be a valid date');
    }
    if (!isValidDate(input.to)) {
      throw new BadRequestException('to must be a valid date');
    }
    if (input.from > input.to) {
      throw new BadRequestException('from must be <= to');
    }
    if (!input.currency || !input.currency.trim()) {
      throw new BadRequestException('currency is required');
    }
    const upcomingLimit = input.upcomingLimit ?? DEFAULT_UPCOMING_LIMIT;
    if (!Number.isInteger(upcomingLimit) || upcomingLimit < 1) {
      throw new BadRequestException('upcomingLimit must be an integer >= 1');
    }

    // Currency format/support itself is validated downstream by
    // GetPaymentsTotalsUseCase -> ConvertAmountUseCase (unsupported currency
    // throws BadRequestException there) -- not duplicated here.
    const [incomes, inventoryPage, patients] = await Promise.all([
      this.getPaymentsTotals.execute({
        from: input.from,
        to: input.to,
        currency: input.currency,
      }),
      // ListInventoryItemsUseCase.execute() now returns a paginated envelope
      // (feat(inventory): búsqueda, paginación y filtro de bajo stock) --
      // request `pageSize: 100` (its MAX_PAGE_SIZE) so this count stays
      // correct for the same range of inventories the patients list below
      // already accepts capping at (see `patientFirstName` comment above).
      this.listInventoryItems.execute({ pageSize: 100 }),
      this.listPatients.execute({}),
    ]);

    const lowStock = inventoryPage.items.filter((item) => item.lowStock);

    const now = new Date();
    const windowEnd = new Date(
      now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const appointmentsInWindow = await this.listAppointments.execute({
      from: now,
      to: windowEnd,
    });

    const upcomingAppointments = appointmentsInWindow
      .filter((appt) => appt.start >= now)
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .slice(0, upcomingLimit)
      .map((appt) => ({
        id: appt.id,
        patientId: appt.patientId,
        patientFirstName: appt.patientFirstName,
        patientLastName: appt.patientLastName,
        providerId: appt.providerId,
        start: appt.start,
        end: appt.end,
        status: appt.status,
      }));

    return {
      period: { from: input.from, to: input.to },
      incomes,
      lowStockItems: {
        count: lowStock.length,
        items: lowStock.map((item) => ({
          id: item.id,
          name: item.name,
          unit: item.unit,
          stock: item.stock,
          minStock: item.minStock,
        })),
      },
      upcomingAppointments,
      patientCount: patients.total,
    };
  }
}
