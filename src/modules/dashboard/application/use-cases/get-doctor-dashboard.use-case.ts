import { BadRequestException, Injectable } from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import {
  GetPaymentsTotalsUseCase,
  GetPaymentsTotalsResult,
} from '../../../payments/application/use-cases/get-payments-totals.use-case';
import {
  addCivilDays,
  civilDaysInclusive,
  parseCivilDate,
} from '../../../../shared/time/civil-day';
import { ListInventoryItemsUseCase } from '../../../inventory/application/use-cases/list-inventory-items.use-case';
import { ListUpcomingAppointmentsUseCase } from '../../../appointments/application/use-cases/list-upcoming-appointments.use-case';
import { CountPatientsUseCase } from '../../../patients/application/use-cases/count-patients.use-case';

const DEFAULT_UPCOMING_LIMIT = 5;
/**
 * Tope de `upcomingLimit` (DX-043, DB-008): la BD devuelve exactamente esas
 * citas, así que el parámetro no puede ser arbitrario. El DTO responde 400 en
 * español por encima; aquí se repite para los llamadores internos.
 */
export const MAX_UPCOMING_LIMIT = 50;
// Ventana de las «próximas citas»: [ahora, ahora + 90 días). El corte en
// `upcomingLimit` lo hace la BD (ListUpcomingAppointmentsUseCase, con take e
// índice por (tenantId, start)); antes se leían todas las citas de la ventana
// y se cortaban aquí en memoria.
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
  /** Primer día civil del período (YYYY-MM-DD), inclusive. */
  from: string;
  /** Día civil (YYYY-MM-DD) siguiente al último del período: EXCLUSIVO. */
  to: string;
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
  incomes: Omit<GetPaymentsTotalsResult, 'from' | 'to'> & {
    from: Date;
    to: Date;
  };
  lowStockItems: {
    count: number;
    items: DashboardLowStockItem[];
  };
  upcomingAppointments: DashboardUpcomingAppointment[];
  patientCount: number;
}

/**
 * El día civil como medianoche UTC: así se ha devuelto siempre el período en
 * la respuesta (`period`, `incomes.from/to`), y se mantiene para no romper el
 * contrato. Es solo una etiqueta del día; el corte real se hace en la zona de
 * cada sede (DX-097).
 */
function civilDateLabel(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function requireCivilDate(value: string, field: 'from' | 'to'): string {
  const day = typeof value === 'string' ? parseCivilDate(value) : null;
  if (day === null) {
    throw new BadRequestException(
      `${field} must be a valid calendar date (YYYY-MM-DD)`,
    );
  }
  return day;
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
    private readonly listUpcomingAppointments: ListUpcomingAppointmentsUseCase,
    private readonly countPatients: CountPatientsUseCase,
  ) {}

  async execute(
    input: GetDoctorDashboardInput,
  ): Promise<GetDoctorDashboardResult> {
    const from = requireCivilDate(input.from, 'from');
    const to = requireCivilDate(input.to, 'to');
    // `to` es exclusivo: from = to es un período vacío; from > to, un error.
    const days = civilDaysInclusive(from, to) - 1;
    if (days < 0) {
      throw new BadRequestException('from must be <= to');
    }
    if (!input.currency || !input.currency.trim()) {
      throw new BadRequestException('currency is required');
    }
    const upcomingLimit = input.upcomingLimit ?? DEFAULT_UPCOMING_LIMIT;
    if (
      !Number.isInteger(upcomingLimit) ||
      upcomingLimit < 1 ||
      upcomingLimit > MAX_UPCOMING_LIMIT
    ) {
      throw new BadRequestException(
        `upcomingLimit debe ser un entero entre 1 y ${MAX_UPCOMING_LIMIT}.`,
      );
    }

    // Currency format/support itself is validated downstream by
    // GetPaymentsTotalsUseCase -> ConvertAmountUseCase (unsupported currency
    // throws BadRequestException there) -- not duplicated here.
    //
    // Los ingresos van por días CIVILES, inclusive: `from`..`to - 1`, que cada
    // sede corta a medianoche de su zona (DX-097). Un período vacío no consulta.
    const [totals, inventoryPage, patientCount] = await Promise.all([
      days === 0
        ? Promise.resolve(null)
        : this.getPaymentsTotals.execute({
            from,
            to: addCivilDays(to, -1),
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
      // COUNT, no una página de pacientes (DB-008).
      this.countPatients.execute(),
    ]);

    // Ya vienen todos bajo mínimo: filtrar otra vez sería redundante.
    const lowStock = inventoryPage.items;

    const now = new Date();
    const windowEnd = new Date(
      now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const upcoming = await this.listUpcomingAppointments.execute({
      from: now,
      to: windowEnd,
      limit: upcomingLimit,
    });

    const upcomingAppointments = upcoming.map((appt) => ({
      id: appt.id,
      patientId: appt.patientId,
      patientFirstName: appt.patientFirstName,
      patientLastName: appt.patientLastName,
      providerId: appt.providerId,
      start: appt.start,
      end: appt.end,
      status: appt.status,
    }));

    const period = { from: civilDateLabel(from), to: civilDateLabel(to) };
    const incomes = totals
      ? { ...totals, ...period }
      : {
          ...period,
          currency: input.currency.trim().toUpperCase(),
          totalConverted: 0,
          count: 0,
          byCurrency: {},
        };

    return {
      period,
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
      patientCount,
    };
  }
}
