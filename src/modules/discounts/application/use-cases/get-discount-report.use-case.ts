import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  checkPeriodDays,
  PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
} from '../../../../shared/time/civil-day';
import { discountPercent } from '../../domain/discount-policy';
import {
  type AgreementReductionTotal,
  DISCOUNT_REPORT_REPOSITORY,
  type DiscountReportQuery,
  type DiscountReportRepository,
  type DiscountReportRow,
} from '../../domain/ports/discount-report-repository.port';

export const DISCOUNT_REPORT_DEFAULT_PAGE_SIZE = 50;
export const DISCOUNT_REPORT_MAX_PAGE_SIZE = 200;
/** Un año (bisiesto incluido), como el registro de auditoría. */
export const DISCOUNT_REPORT_MAX_DAYS = 366;

export const INVALID_PERIOD_MESSAGE =
  'El periodo no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const PERIOD_TOO_LONG_MESSAGE = `El periodo admite como mucho ${DISCOUNT_REPORT_MAX_DAYS} días.`;
export const UNKNOWN_LOCATION_MESSAGE = 'La sede no es de esta clínica.';

export interface DiscountReportInput extends DiscountReportQuery {
  page?: number;
  pageSize?: number;
}

export interface DiscountReportTotalView {
  currency: string;
  items: number;
  gross: number;
  discount: number;
  /** Descuento sobre el bruto de esos mismos ítems, en % con 2 decimales. */
  percentOfGross: number;
}

export interface DiscountReportRowView extends DiscountReportRow {
  /**
   * % del descuento total sobre el precio de referencia del ítem (el de
   * catálogo si el precio se rebajó; si no, el precio). SEC-041.
   */
  percent: number;
  /** SEC-047: % de la rebaja de convenio sobre el precio de catálogo. */
  agreementPercent: number;
}

export interface DiscountReport {
  from: string;
  to: string;
  /** Sede del filtro (parámetro o cabecera); null = toda la clínica. */
  scope: { location: { id: string; name: string } | null };
  totals: DiscountReportTotalView[];
  /** SEC-047: rebajas de convenio por moneda, aparte de `totals`. */
  agreementTotals: AgreementReductionTotal[];
  /** Líneas del detalle (descuentos y rebajas de convenio). */
  items: DiscountReportRowView[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Informe «Descuentos» (DX-204, solo ADMIN): lo que se descontó en ítems de
 * plan en un periodo, por sede y por quién lo dio. Los totales cuadran con la
 * suma del descuento efectivo (rebaja de precio frente al catálogo + `discount`,
 * SEC-041) de los ítems vivos del periodo; por moneda, sin convertir.
 */
@Injectable()
export class GetDiscountReportUseCase {
  constructor(
    @Inject(DISCOUNT_REPORT_REPOSITORY)
    private readonly repo: DiscountReportRepository,
  ) {}

  private async validated(input: DiscountReportQuery): Promise<{
    query: DiscountReportQuery;
    location: { id: string; name: string } | null;
  }> {
    const period = checkPeriodDays(input.from, input.to);
    if (!period.ok) {
      throw new BadRequestException(
        period.problem === 'OUT_OF_RANGE'
          ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
          : INVALID_PERIOD_MESSAGE,
      );
    }
    if (period.days > DISCOUNT_REPORT_MAX_DAYS) {
      throw new BadRequestException(PERIOD_TOO_LONG_MESSAGE);
    }
    const { from, to } = period;
    const location = input.locationId
      ? await this.repo.findLocation(input.locationId)
      : null;
    if (input.locationId && !location) {
      throw new BadRequestException(UNKNOWN_LOCATION_MESSAGE);
    }
    return {
      query: {
        from,
        to,
        locationId: input.locationId,
        professionalId: input.professionalId,
      },
      location,
    };
  }

  async execute(input: DiscountReportInput): Promise<DiscountReport> {
    const { query, location } = await this.validated(input);
    const page = input.page ?? 1;
    const pageSize = Math.min(
      input.pageSize ?? DISCOUNT_REPORT_DEFAULT_PAGE_SIZE,
      DISCOUNT_REPORT_MAX_PAGE_SIZE,
    );
    const [summary, rows] = await Promise.all([
      this.repo.summary(query),
      this.repo.rows(query, { offset: (page - 1) * pageSize, limit: pageSize }),
    ]);
    return {
      from: query.from,
      to: query.to,
      scope: { location },
      totals: summary.totals.map((t) => ({
        ...t,
        percentOfGross: discountPercent(t.gross, t.discount),
      })),
      agreementTotals: summary.agreementTotals,
      items: rows.map(withPercent),
      total: summary.rows,
      page,
      pageSize,
    };
  }

  /** Todas las filas del periodo (CSV), con los mismos filtros. */
  async exportRows(
    input: DiscountReportQuery,
  ): Promise<DiscountReportRowView[]> {
    const { query } = await this.validated(input);
    return (await this.repo.rows(query)).map(withPercent);
  }
}

function withPercent(row: DiscountReportRow): DiscountReportRowView {
  return {
    ...row,
    percent: discountPercent(row.price + row.priceReduction, row.discount),
    agreementPercent:
      row.basePrice === null
        ? 0
        : discountPercent(row.basePrice, row.agreementReduction),
  };
}
