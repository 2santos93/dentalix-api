import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import {
  isLocationAllowed,
  locationNotAllowed,
  type AllowedLocations,
} from '../../../../shared/tenancy/location-access';
import {
  checkPeriodDays,
  PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
} from '../../../../shared/time/civil-day';
import {
  shiftCivilYears,
  type CivilPeriod,
} from '../../domain/comparison-period';
import {
  buildProcedureProduction,
  type ProcedureProduction,
} from '../../domain/production-by-procedure';
import {
  PRODUCTION_BY_PROCEDURE_REPOSITORY,
  type ProductionByProcedureRepository,
  type ProductionItemRow,
  type ProductionLocation,
  type ProductionProfessional,
  type ProductionScope,
} from '../../domain/ports/production-by-procedure-repository.port';

/** Tope del período por calendario: «hasta» anterior a «desde» + 24 meses. */
export const PRODUCTION_MAX_MONTHS = 24;

export const PRODUCTION_INVALID_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const PRODUCTION_PERIOD_TOO_LONG_MESSAGE =
  'El período admite como mucho 24 meses.';
export const PRODUCTION_OWN_ONLY_MESSAGE =
  'Solo puedes ver tu propia producción.';

export interface ProductionActor {
  userId: string;
  role: ClinicRole;
}

export interface ProductionFiltersInput {
  from: string;
  to: string;
  locationId?: string;
  professionalId?: string;
  category?: string;
  actor: ProductionActor;
  /** Sedes del usuario (claim `loc`, DX-089). */
  allowedLocationIds: AllowedLocations;
}

/** CLINIC = toda la producción visible; OWN = solo la de quien consulta. */
export type ProductionScopeKind = 'CLINIC' | 'OWN';

export interface UnattributedTotals {
  currency: string;
  count: number;
  gross: number;
  discounts: number;
  net: number;
}

export interface ProductionByProcedure extends ProcedureProduction {
  from: string;
  to: string;
  scope: ProductionScopeKind;
  filters: {
    locationId: string | null;
    locationName: string | null;
    professionalId: string | null;
    professionalName: string | null;
    category: string | null;
  };
  options: {
    locations: ProductionLocation[];
    professionals: ProductionProfessional[];
    categories: string[];
  };
  /** Realizados «Sin atribuir» (sin fecha o sin sede, DX-305), por moneda. */
  unattributed: UnattributedTotals[];
  hasActivity: boolean;
}

export interface ProductionItemsInput extends ProductionFiltersInput {
  catalogItemId: string;
  currency?: string;
  page?: number;
  pageSize?: number;
}

export interface ProductionItemView extends ProductionItemRow {
  net: number;
}

export interface ProductionItems {
  items: ProductionItemView[];
  total: number;
  page: number;
  pageSize: number;
}

export const PRODUCTION_ITEMS_PAGE_SIZE = 25;

const money = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

interface ResolvedScope {
  period: CivilPeriod;
  scope: ProductionScope;
  kind: ProductionScopeKind;
  locations: ProductionLocation[];
  includeWithoutLocation: boolean;
}

/**
 * «Producción por procedimiento» (DX-423): los ítems de plan REALIZADOS del
 * período, por categoría y código del catálogo, en la sede donde se
 * realizaron (`performedLocationId`, no la del paciente) y solo en las sedes
 * que ve quien consulta. ADMIN ve la de todo el equipo; un DENTIST, solo la
 * suya. Por moneda, sin convertir.
 */
@Injectable()
export class GetProductionByProcedureUseCase {
  constructor(
    @Inject(PRODUCTION_BY_PROCEDURE_REPOSITORY)
    private readonly repo: ProductionByProcedureRepository,
  ) {}

  private period(from: string, to: string): CivilPeriod {
    const period = checkPeriodDays(from, to);
    if (!period.ok) {
      throw new BadRequestException(
        period.problem === 'OUT_OF_RANGE'
          ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
          : PRODUCTION_INVALID_PERIOD_MESSAGE,
      );
    }
    // 24 meses por calendario (el 29/02 + 24 meses cae en el 28/02).
    if (period.to >= shiftCivilYears(period.from, PRODUCTION_MAX_MONTHS / 12)) {
      throw new BadRequestException(PRODUCTION_PERIOD_TOO_LONG_MESSAGE);
    }
    return { from: period.from, to: period.to };
  }

  /** El DENTIST solo ve lo suyo; pedir lo de otro es 403. */
  private professionalOf(input: ProductionFiltersInput): {
    professionalId?: string;
    kind: ProductionScopeKind;
  } {
    if (input.actor.role === ClinicRole.ADMIN) {
      return { professionalId: input.professionalId, kind: 'CLINIC' };
    }
    if (
      input.professionalId !== undefined &&
      input.professionalId !== input.actor.userId
    ) {
      throw new ForbiddenException(PRODUCTION_OWN_ONLY_MESSAGE);
    }
    return { professionalId: input.actor.userId, kind: 'OWN' };
  }

  private async resolve(input: ProductionFiltersInput): Promise<ResolvedScope> {
    const period = this.period(input.from, input.to);
    const { professionalId, kind } = this.professionalOf(input);
    // Sede ajena a la clínica o no permitida: el MISMO 403, para no decir
    // qué sedes existen.
    if (
      input.locationId !== undefined &&
      (!isLocationAllowed(input.allowedLocationIds, input.locationId) ||
        !(await this.repo.locationInClinic(input.locationId)))
    ) {
      throw locationNotAllowed();
    }
    const locations = await this.repo.listLocations(input.allowedLocationIds);
    const locationIds = locations
      .map((l) => l.id)
      .filter(
        (id) => input.locationId === undefined || id === input.locationId,
      );
    return {
      period,
      kind,
      locations,
      scope: {
        locationIds,
        ...(professionalId !== undefined ? { professionalId } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
      },
      // Un «Sin atribuir» sin sede no es de ninguna: solo lo ve quien ve
      // todas, y sin elegir una.
      includeWithoutLocation:
        input.allowedLocationIds === 'ALL' && input.locationId === undefined,
    };
  }

  async execute(input: ProductionFiltersInput): Promise<ProductionByProcedure> {
    const resolved = await this.resolve(input);
    const { scope } = resolved;
    const [sums, pending, professionals, categories] = await Promise.all([
      scope.locationIds.length === 0
        ? Promise.resolve([])
        : this.repo.aggregate(resolved.period, scope),
      this.repo.unattributed(scope, resolved.includeWithoutLocation),
      // Quien realizó algo en las sedes que ve (ex-miembros incluidos), no
      // todo el equipo: a un miembro restringido no se le enseña el resto.
      this.repo.listProfessionals(resolved.locations.map((l) => l.id)),
      this.repo.listCategories(),
    ]);
    const production = buildProcedureProduction(sums);
    const unattributed = pending
      .filter((p) => p.count > 0)
      .map((p) => ({
        currency: p.currency,
        count: p.count,
        gross: money(p.gross),
        discounts: money(p.discounts),
        net: money(p.gross - p.discounts),
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
    const visibleProfessionals =
      resolved.kind === 'OWN'
        ? professionals.filter((p) => p.userId === input.actor.userId)
        : professionals;
    const location = resolved.locations.find((l) => l.id === input.locationId);
    const professional = professionals.find(
      (p) => p.userId === scope.professionalId,
    );
    return {
      from: resolved.period.from,
      to: resolved.period.to,
      scope: resolved.kind,
      filters: {
        locationId: location?.id ?? null,
        locationName: location?.name ?? null,
        professionalId: scope.professionalId ?? null,
        professionalName: professional?.fullName ?? null,
        category: scope.category ?? null,
      },
      options: {
        locations: resolved.locations,
        professionals: visibleProfessionals,
        categories,
      },
      ...production,
      unattributed,
      hasActivity: production.rows.length > 0 || unattributed.length > 0,
    };
  }

  /**
   * El detalle de una fila: sus ítems con paciente, fecha, profesional y
   * sede. Mismos filtros y alcance que el agregado.
   */
  async items(input: ProductionItemsInput): Promise<ProductionItems> {
    const resolved = await this.resolve(input);
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? PRODUCTION_ITEMS_PAGE_SIZE;
    if (resolved.scope.locationIds.length === 0) {
      return { items: [], total: 0, page, pageSize };
    }
    const result = await this.repo.listItems(
      resolved.period,
      {
        ...resolved.scope,
        catalogItemId: input.catalogItemId,
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
      },
      { skip: (page - 1) * pageSize, take: pageSize },
    );
    return {
      items: result.items.map((i) => ({
        ...i,
        net: money(i.price - i.discount),
      })),
      total: result.total,
      page,
      pageSize,
    };
  }
}
