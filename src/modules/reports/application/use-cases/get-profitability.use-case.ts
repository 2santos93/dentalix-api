import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  isLocationAllowed,
  locationNotAllowed,
  type AllowedLocations,
} from '../../../../shared/tenancy/location-access';
import {
  checkPeriodDays,
  PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
} from '../../../../shared/time/civil-day';
import { fromCents } from '../../../../shared/money/money';
import type { CivilPeriod } from '../../domain/comparison-period';
import {
  buildProfitabilityRows,
  PROFITABILITY_DEFINITIONS,
  type ExpensePaymentStatus,
  type ProfitabilityBasis,
  type ProfitabilityDefinition,
  type ProfitabilityLocation,
  type ProfitabilityRowView,
  type ProfitabilitySide,
} from '../../domain/profitability';
import {
  PROFITABILITY_REPOSITORY,
  type ProfitabilityRepository,
} from '../../domain/ports/profitability-repository.port';
import { categoryFilterName } from '../../../expenses/domain/expense-categories';

/** Un año (bisiesto incluido), como «Comparar sedes». */
export const PROFITABILITY_MAX_DAYS = 366;
export const PROFITABILITY_LINES_MAX_PAGE_SIZE = 100;
export const PROFITABILITY_LINES_DEFAULT_PAGE_SIZE = 25;

export const PROFITABILITY_INVALID_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const PROFITABILITY_PERIOD_TOO_LONG_MESSAGE = `El período admite como mucho ${PROFITABILITY_MAX_DAYS} días.`;
export const PROFITABILITY_CATEGORY_ONLY_EXPENSES_MESSAGE =
  'La categoría solo filtra los gastos.';

export interface ProfitabilityInput {
  from: string;
  to: string;
  basis: ProfitabilityBasis;
  locationId?: string;
  /** Sedes del usuario (claim `loc`, DX-089). */
  allowedLocationIds: AllowedLocations;
}

export interface ProfitabilityReport {
  from: string;
  to: string;
  basis: ProfitabilityBasis;
  /** La definición de la base: cabecera, columnas y «Cómo se calcula». */
  definition: ProfitabilityDefinition;
  locationId: string | null;
  /** El usuario solo ve algunas sedes (DX-089). */
  restrictedToLocations: boolean;
  locations: ProfitabilityRowView[];
  total: ProfitabilityRowView;
  /** ¿Algún ingreso o gasto en alguna sede? */
  hasActivity: boolean;
}

export interface ProfitabilityLinesInput extends ProfitabilityInput {
  side: ProfitabilitySide;
  currency: string;
  category?: string;
  page?: number;
  pageSize?: number;
}

export interface ProfitabilityLineView {
  id: string;
  date: string;
  locationId: string;
  locationName: string;
  amount: number;
  concept: string | null;
  category: string | null;
  method: string | null;
  paymentStatus: ExpensePaymentStatus | null;
}

export interface ProfitabilityLines {
  from: string;
  to: string;
  basis: ProfitabilityBasis;
  side: ProfitabilitySide;
  currency: string;
  locationId: string | null;
  category: string | null;
  /** Suma de TODAS las filas (no solo de la página): la cifra del informe. */
  total: number;
  count: number;
  page: number;
  pageSize: number;
  lines: ProfitabilityLineView[];
}

/**
 * «Rentabilidad por sede» (DX-410): ingresos − gastos de cada sede que ve
 * quien consulta y del grupo, en base «Caja» o «Devengo» (definiciones en
 * `domain/profitability`), por moneda y con los gastos por categoría. El
 * detalle (`lines`) devuelve las filas que forman cada cifra, con los mismos
 * filtros. La base de datos suma; aquí se valida, se acota a las sedes del
 * usuario y se arman las filas.
 */
@Injectable()
export class GetProfitabilityUseCase {
  constructor(
    @Inject(PROFITABILITY_REPOSITORY)
    private readonly repo: ProfitabilityRepository,
  ) {}

  private validated(from: string, to: string): CivilPeriod {
    const period = checkPeriodDays(from, to);
    if (!period.ok) {
      throw new BadRequestException(
        period.problem === 'OUT_OF_RANGE'
          ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
          : PROFITABILITY_INVALID_PERIOD_MESSAGE,
      );
    }
    if (period.days > PROFITABILITY_MAX_DAYS) {
      throw new BadRequestException(PROFITABILITY_PERIOD_TOO_LONG_MESSAGE);
    }
    return { from: period.from, to: period.to };
  }

  /**
   * Las sedes de la consulta: las visibles, o solo la pedida. Una sede no
   * permitida, ajena o retirada da el MISMO 403 (no dice qué sedes existen).
   */
  private async scope(
    input: ProfitabilityInput,
  ): Promise<ProfitabilityLocation[]> {
    if (
      input.locationId !== undefined &&
      !isLocationAllowed(input.allowedLocationIds, input.locationId)
    ) {
      throw locationNotAllowed();
    }
    const visible = await this.repo.listLocations(input.allowedLocationIds);
    if (input.locationId === undefined) return visible;
    const only = visible.filter((l) => l.id === input.locationId);
    if (only.length === 0) throw locationNotAllowed();
    return only;
  }

  async execute(input: ProfitabilityInput): Promise<ProfitabilityReport> {
    const period = this.validated(input.from, input.to);
    const locations = await this.scope(input);
    const sums = await this.repo.sums(period, input.basis, locations);
    const rows = buildProfitabilityRows(locations, sums.income, sums.expenses);
    return {
      from: period.from,
      to: period.to,
      basis: input.basis,
      definition: PROFITABILITY_DEFINITIONS[input.basis],
      locationId: input.locationId ?? null,
      restrictedToLocations: input.allowedLocationIds !== 'ALL',
      locations: rows.locations,
      total: rows.total,
      hasActivity: rows.total.currencies.length > 0,
    };
  }

  async lines(input: ProfitabilityLinesInput): Promise<ProfitabilityLines> {
    const period = this.validated(input.from, input.to);
    if (input.category !== undefined && input.side !== 'EXPENSE') {
      throw new BadRequestException(
        PROFITABILITY_CATEGORY_ONLY_EXPENSES_MESSAGE,
      );
    }
    // La foto del gasto guarda la grafía canónica de la predefinida; un nombre
    // anterior (DX-274-bis) o con otras mayúsculas filtra por ella.
    const category =
      input.category === undefined
        ? undefined
        : categoryFilterName(input.category);
    const locations = await this.scope(input);
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? PROFITABILITY_LINES_DEFAULT_PAGE_SIZE;
    const result = await this.repo.lines({
      period,
      basis: input.basis,
      side: input.side,
      currency: input.currency,
      category,
      locations,
      page,
      pageSize,
    });
    const nameOf = new Map(locations.map((l) => [l.id, l.name]));
    return {
      from: period.from,
      to: period.to,
      basis: input.basis,
      side: input.side,
      currency: input.currency,
      locationId: input.locationId ?? null,
      category: category ?? null,
      total: fromCents(result.totalCents),
      count: result.count,
      page,
      pageSize,
      lines: result.lines.map((l) => ({
        id: l.id,
        date: l.date,
        locationId: l.locationId,
        locationName: nameOf.get(l.locationId) ?? '',
        amount: fromCents(l.amountCents),
        concept: l.concept,
        category: l.category,
        method: l.method,
        paymentStatus: l.paymentStatus,
      })),
    };
  }
}
