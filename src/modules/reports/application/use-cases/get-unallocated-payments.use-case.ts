import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  isLocationAllowed,
  locationNotAllowed,
  type AllowedLocations,
} from '../../../../shared/tenancy/location-access';
import {
  checkPeriodDays,
  civilDateIn,
  PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
} from '../../../../shared/time/civil-day';
import { fromCents } from '../../../../shared/money/money';
import {
  shiftCivilYears,
  type CivilPeriod,
} from '../../domain/comparison-period';
import {
  UNALLOCATED_PAYMENTS_REPOSITORY,
  type UnallocatedLocation,
  type UnallocatedPaymentRow,
  type UnallocatedPaymentsRepository,
} from '../../domain/ports/unallocated-payments-repository.port';

export const UNALLOCATED_DEFAULT_PAGE_SIZE = 25;
export const UNALLOCATED_MAX_PAGE_SIZE = 100;
/** Tope del período por calendario, como «Producción por procedimiento». */
export const UNALLOCATED_MAX_MONTHS = 24;

export const UNALLOCATED_INVALID_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const UNALLOCATED_PERIOD_TOO_LONG_MESSAGE =
  'El período admite como mucho 24 meses.';

export interface UnallocatedPaymentsInput {
  from: string;
  to: string;
  locationId?: string;
  page?: number;
  pageSize?: number;
  /** Sedes del usuario (claim `loc`, DX-089). */
  allowedLocationIds: AllowedLocations;
}

export interface UnallocatedPaymentView {
  paymentId: string;
  patient: { id: string; fullName: string };
  location: { id: string; name: string };
  /** Día civil del abono en la zona de su sede (AAAA-MM-DD). */
  paidOn: string;
  paymentAmount: number;
  paymentCurrency: string;
  planId: string;
  /** Moneda del plan: `allocated` y `unallocated` van en ella. */
  planCurrency: string;
  allocated: number;
  unallocated: number;
}

export interface UnallocatedTotal {
  currency: string;
  count: number;
  allocated: number;
  unallocated: number;
}

export interface UnallocatedPayments {
  from: string;
  to: string;
  filters: { locationId: string | null; locationName: string | null };
  options: { locations: UnallocatedLocation[] };
  items: UnallocatedPaymentView[];
  total: number;
  page: number;
  pageSize: number;
  /** Por moneda del plan, sobre TODOS los abonos del alcance (no solo la página). */
  totals: UnallocatedTotal[];
  /** Abonos sin tasa para su día: no se pueden imputar y no están en las cifras. */
  paymentsWithoutRateCount: number;
}

function view(row: UnallocatedPaymentRow): UnallocatedPaymentView {
  return {
    paymentId: row.paymentId,
    patient: { id: row.patientId, fullName: row.patientName },
    location: { id: row.locationId, name: row.locationName },
    paidOn: civilDateIn(row.paidAt, row.timeZone),
    paymentAmount: row.paymentAmount,
    paymentCurrency: row.paymentCurrency,
    planId: row.planId,
    planCurrency: row.planCurrency,
    allocated: fromCents(row.allocatedCents),
    unallocated: fromCents(row.unallocatedCents),
  };
}

/**
 * «Cobrado sin imputar / a cuenta» (DX-399): los abonos vivos a un plan que
 * se cobra cuya base (el abono en la moneda del plan) supera lo imputado a
 * sus ítems, con cuánto está imputado y cuánto no. El período son días
 * civiles de la zona de la sede del abono; solo las sedes que ve quien
 * consulta (DX-089). Las cifras salen de las mismas tablas que el detalle de
 * un abono (`payment_plan_amounts` y `payment_allocations`), por moneda del
 * plan y sin convertir.
 */
@Injectable()
export class GetUnallocatedPaymentsUseCase {
  constructor(
    @Inject(UNALLOCATED_PAYMENTS_REPOSITORY)
    private readonly repo: UnallocatedPaymentsRepository,
  ) {}

  private period(from: string, to: string): CivilPeriod {
    const period = checkPeriodDays(from, to);
    if (!period.ok) {
      throw new BadRequestException(
        period.problem === 'OUT_OF_RANGE'
          ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
          : UNALLOCATED_INVALID_PERIOD_MESSAGE,
      );
    }
    if (
      period.to >= shiftCivilYears(period.from, UNALLOCATED_MAX_MONTHS / 12)
    ) {
      throw new BadRequestException(UNALLOCATED_PERIOD_TOO_LONG_MESSAGE);
    }
    return { from: period.from, to: period.to };
  }

  /** Período, sedes visibles y la sede elegida (403 si no es suya o ajena). */
  private async resolve(input: UnallocatedPaymentsInput) {
    const period = this.period(input.from, input.to);
    if (
      input.locationId !== undefined &&
      (!isLocationAllowed(input.allowedLocationIds, input.locationId) ||
        !(await this.repo.locationInClinic(input.locationId)))
    ) {
      throw locationNotAllowed();
    }
    const locations = await this.repo.listLocations(input.allowedLocationIds);
    const location = locations.find((l) => l.id === input.locationId);
    return {
      period,
      locations,
      location,
      scope: {
        locationIds: locations
          .map((l) => l.id)
          .filter(
            (id) => input.locationId === undefined || id === input.locationId,
          ),
      },
    };
  }

  private async build(
    input: UnallocatedPaymentsInput,
    page: { page: number; pageSize: number } | null,
  ): Promise<UnallocatedPayments> {
    const { period, locations, location, scope } = await this.resolve(input);
    const [listed, totals, withoutRate] = await Promise.all([
      this.repo.list(
        period,
        scope,
        page
          ? { skip: (page.page - 1) * page.pageSize, take: page.pageSize }
          : undefined,
      ),
      this.repo.totals(period, scope),
      this.repo.withoutRateCount(period, scope),
    ]);
    return {
      from: period.from,
      to: period.to,
      filters: {
        locationId: location?.id ?? null,
        locationName: location?.name ?? null,
      },
      options: { locations },
      items: listed.rows.map(view),
      total: listed.total,
      page: page?.page ?? 1,
      pageSize: page?.pageSize ?? listed.rows.length,
      totals: totals.map((t) => ({
        currency: t.currency,
        count: t.count,
        allocated: fromCents(t.allocatedCents),
        unallocated: fromCents(t.unallocatedCents),
      })),
      paymentsWithoutRateCount: withoutRate,
    };
  }

  execute(input: UnallocatedPaymentsInput): Promise<UnallocatedPayments> {
    const wholeOrDefault = (
      value: number | undefined,
      fallback: number,
      max: number,
    ) =>
      value === undefined || !Number.isFinite(value)
        ? fallback
        : Math.min(max, Math.max(1, Math.floor(value)));
    return this.build(input, {
      page: wholeOrDefault(input.page, 1, Number.MAX_SAFE_INTEGER),
      pageSize: wholeOrDefault(
        input.pageSize,
        UNALLOCATED_DEFAULT_PAGE_SIZE,
        UNALLOCATED_MAX_PAGE_SIZE,
      ),
    });
  }

  /** El CSV: las mismas filas, todas, sin paginar. */
  exportAll(
    input: Omit<UnallocatedPaymentsInput, 'page' | 'pageSize'>,
  ): Promise<UnallocatedPayments> {
    return this.build(input, null);
  }
}
