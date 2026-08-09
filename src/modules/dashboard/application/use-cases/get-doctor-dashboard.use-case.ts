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

// Cuántos insumos bajo mínimo se listan en la tarjeta. El CONTADOR no depende
// de esto (sale de `total`, ya filtrado en el módulo de inventario); esto solo
// acota la lista que se pinta. 100 es el MAX_PAGE_SIZE de
// ListInventoryItemsUseCase -- el mismo techo técnico que ya acepta
// ListPatientsUseCase (ver el comentario de `patientFirstName` más abajo):
// una clínica con más de 100 insumos bajo mínimo a la vez vería la lista
// corta, pero nunca el contador.
const LOW_STOCK_PREVIEW_SIZE = 100;

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
      // `lowStockOnly` hace el filtrado en el módulo dueño de la regla de
      // signos (ListInventoryItemsUseCase), así que `total` es el número REAL
      // de insumos bajo mínimo, calculado ANTES de cortar por página -- el
      // contador de la tarjeta no depende de `pageSize` ni puede quedarse
      // corto aunque la clínica tenga cientos de insumos. `pageSize` acota
      // solo la lista (`items`) que se pinta debajo del contador.
      this.listInventoryItems.execute({
        lowStockOnly: true,
        pageSize: LOW_STOCK_PREVIEW_SIZE,
      }),
      this.listPatients.execute({}),
    ]);

    // Ya vienen todos bajo mínimo: filtrar otra vez sería redundante.
    const lowStock = inventoryPage.items;

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
        // Total real, no el tamaño de la página listada arriba.
        count: inventoryPage.total,
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
