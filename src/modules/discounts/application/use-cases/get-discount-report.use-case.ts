import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  civilDaysInclusive,
  parseCivilDate,
} from '../../../../shared/time/civil-day';
import { discountPercent } from '../../domain/discount-policy';
import {
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
  /** % del descuento sobre el precio del ítem. */
  percent: number;
}

export interface DiscountReport {
  from: string;
  to: string;
  /** Sede del filtro (parámetro o cabecera); null = toda la clínica. */
  scope: { location: { id: string; name: string } | null };
  totals: DiscountReportTotalView[];
  items: DiscountReportRowView[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Informe «Descuentos» (DX-204, solo ADMIN): lo que se descontó en ítems de
 * plan en un periodo, por sede y por quién lo dio. Los totales cuadran con la
 * suma de `discount` de los ítems vivos del periodo; por moneda, sin
 * convertir.
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
    const from = parseCivilDate(input.from);
    const to = parseCivilDate(input.to);
    if (!from || !to || civilDaysInclusive(from, to) < 1) {
      throw new BadRequestException(INVALID_PERIOD_MESSAGE);
    }
    if (civilDaysInclusive(from, to) > DISCOUNT_REPORT_MAX_DAYS) {
      throw new BadRequestException(PERIOD_TOO_LONG_MESSAGE);
    }
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
    const [totals, rows] = await Promise.all([
      this.repo.totals(query),
      this.repo.rows(query, { offset: (page - 1) * pageSize, limit: pageSize }),
    ]);
    return {
      from: query.from,
      to: query.to,
      scope: { location },
      totals: totals.map((t) => ({
        ...t,
        percentOfGross: discountPercent(t.gross, t.discount),
      })),
      items: rows.map(withPercent),
      total: totals.reduce((sum, t) => sum + t.items, 0),
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
  return { ...row, percent: discountPercent(row.price, row.discount) };
}
