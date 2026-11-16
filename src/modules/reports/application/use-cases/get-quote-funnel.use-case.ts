import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ClinicRole, ExtraPermission } from '@prisma/client';
import {
  isLocationAllowed,
  locationNotAllowed,
  type AllowedLocations,
} from '../../../../shared/tenancy/location-access';
import {
  checkPeriodDays,
  PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
} from '../../../../shared/time/civil-day';
import type { CivilPeriod } from '../../domain/comparison-period';
import {
  amountOf,
  buildQuoteFunnel,
  QUOTE_FUNNEL_DEFINITION_LIST,
  quoteFunnelWarnings,
  sortRejectionReasons,
  UNATTRIBUTED_PROFESSIONAL_NAME,
  type AcceptanceRate,
  type CountAmount,
  type QuoteFunnelDefinition,
  type QuoteFunnelDetailStep,
  type QuoteFunnelRejectionReason,
  type QuoteFunnelView,
  type QuoteFunnelWarning,
  type RejectionReasonView,
} from '../../domain/quote-funnel';
import {
  QUOTE_FUNNEL_REPOSITORY,
  type QuoteFunnelLocation,
  type QuoteFunnelPresentationRow,
  type QuoteFunnelProfessional,
  type QuoteFunnelRepository,
  type QuoteFunnelScope,
} from '../../domain/ports/quote-funnel-repository.port';
import {
  CATALOG_CURRENCY_READER,
  type CatalogCurrencyReader,
} from '../../../dental-catalog/domain/ports/catalog-currency-reader.port';

/** Tope del período, en días civiles (ambos inclusive). */
export const QUOTE_FUNNEL_MAX_DAYS = 366;

export const QUOTE_FUNNEL_INVALID_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const QUOTE_FUNNEL_PERIOD_TOO_LONG_MESSAGE = `El período admite como mucho ${QUOTE_FUNNEL_MAX_DAYS} días.`;
export const QUOTE_FUNNEL_OWN_ONLY_MESSAGE =
  'Solo puedes ver tus propios presupuestos.';
export const QUOTE_FUNNEL_REASON_NEEDS_REJECTED_MESSAGE =
  'El motivo de rechazo solo filtra las presentaciones rechazadas (step=REJECTED).';

export const QUOTE_FUNNEL_PAGE_SIZE = 25;

export interface QuoteFunnelActor {
  userId: string;
  role: ClinicRole;
  /**
   * Rol base ∪ permisos extra concedidos (DX-090), los que deja RolesGuard en
   * la petición. Vacío si la ruta no los declara.
   */
  permissions: readonly ExtraPermission[];
}

export interface QuoteFunnelInput {
  from: string;
  to: string;
  locationId?: string;
  providerId?: string;
  actor: QuoteFunnelActor;
  /** Sedes del usuario (claim `loc`, DX-089). */
  allowedLocationIds: AllowedLocations;
}

export interface QuoteFunnelPresentationsInput extends QuoteFunnelInput {
  step: QuoteFunnelDetailStep;
  reason?: QuoteFunnelRejectionReason;
  page?: number;
  pageSize?: number;
}

/** CLINIC = todo lo visible; OWN = solo lo que elaboró quien consulta. */
export type QuoteFunnelScopeKind = 'CLINIC' | 'OWN';

export interface QuoteFunnelStepAmounts {
  presented: CountAmount;
  accepted: CountAmount;
  scheduled: CountAmount;
  done: CountAmount;
  collected: CountAmount;
}

export interface QuoteFunnelProfessionalRow extends QuoteFunnelStepAmounts {
  /** null = «Sin atribuir». */
  professionalId: string | null;
  name: string;
  acceptanceRate: AcceptanceRate;
  medianDaysToAccept: number | null;
}

export interface QuoteFunnelReport extends Omit<
  QuoteFunnelView,
  'withoutRate'
> {
  period: CivilPeriod;
  currency: string | null;
  scope: QuoteFunnelScopeKind;
  restrictedToLocations: boolean;
  filters: { locationId: string | null; providerId: string | null };
  rejectionReasons: RejectionReasonView[];
  byProfessional: QuoteFunnelProfessionalRow[];
  withoutRate: { presentations: number };
  warnings: QuoteFunnelWarning[];
  definitions: readonly QuoteFunnelDefinition[];
  options: {
    locations: QuoteFunnelLocation[];
    professionals: QuoteFunnelProfessional[];
  };
}

export interface QuoteFunnelPresentations {
  currency: string | null;
  items: QuoteFunnelPresentationRow[];
  total: number;
  page: number;
  pageSize: number;
}

interface ResolvedScope {
  period: CivilPeriod;
  kind: QuoteFunnelScopeKind;
  locations: QuoteFunnelLocation[];
  scope: QuoteFunnelScope;
}

/**
 * «Embudo de presupuestos» (DX-558): de lo presentado en el período, qué se
 * aceptó, agendó, realizó y cobró hasta hoy, y por qué no se aceptó el resto.
 * ADMIN o quien tenga FINANCIAL_REPORTS_VIEW ve toda la clínica (y puede
 * filtrar por profesional); un DENTIST sin el permiso, solo lo que elaboró él.
 * Solo las sedes que ve quien consulta (DX-089).
 */
@Injectable()
export class GetQuoteFunnelUseCase {
  constructor(
    @Inject(QUOTE_FUNNEL_REPOSITORY)
    private readonly repo: QuoteFunnelRepository,
    // La moneda del catálogo (DX-502-ter): la de todos los importes.
    @Inject(CATALOG_CURRENCY_READER)
    private readonly catalogCurrency: CatalogCurrencyReader,
  ) {}

  private period(from: string, to: string): CivilPeriod {
    const period = checkPeriodDays(from, to);
    if (!period.ok) {
      throw new BadRequestException(
        period.problem === 'OUT_OF_RANGE'
          ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
          : QUOTE_FUNNEL_INVALID_PERIOD_MESSAGE,
      );
    }
    if (period.days > QUOTE_FUNNEL_MAX_DAYS) {
      throw new BadRequestException(QUOTE_FUNNEL_PERIOD_TOO_LONG_MESSAGE);
    }
    return { from: period.from, to: period.to };
  }

  /** Quien ve toda la clínica; el resto, solo lo suyo (pedir otro es 403). */
  private professionalOf(input: QuoteFunnelInput): {
    professionalId?: string;
    kind: QuoteFunnelScopeKind;
  } {
    if (
      input.actor.role === ClinicRole.ADMIN ||
      input.actor.permissions.includes(ExtraPermission.FINANCIAL_REPORTS_VIEW)
    ) {
      return { professionalId: input.providerId, kind: 'CLINIC' };
    }
    if (
      input.providerId !== undefined &&
      input.providerId !== input.actor.userId
    ) {
      throw new ForbiddenException(QUOTE_FUNNEL_OWN_ONLY_MESSAGE);
    }
    return { professionalId: input.actor.userId, kind: 'OWN' };
  }

  private async resolve(input: QuoteFunnelInput): Promise<ResolvedScope> {
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
    const [locations, currency] = await Promise.all([
      this.repo.listLocations(input.allowedLocationIds),
      this.catalogCurrency.current(),
    ]);
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
        // Una presentación sin sede no es de ninguna: solo la ve quien ve
        // todas, y sin elegir una.
        includeWithoutLocation:
          input.allowedLocationIds === 'ALL' && input.locationId === undefined,
        ...(professionalId !== undefined ? { professionalId } : {}),
        currency,
      },
    };
  }

  async execute(input: QuoteFunnelInput): Promise<QuoteFunnelReport> {
    const resolved = await this.resolve(input);
    const { scope } = resolved;
    const withAmounts = scope.currency !== null;
    const [aggregate, professionals] = await Promise.all([
      this.repo.aggregate(resolved.period, scope),
      this.repo.listProfessionals(
        scope.locationIds,
        scope.includeWithoutLocation,
      ),
    ]);
    const funnel = buildQuoteFunnel(aggregate.total, withAmounts);
    const byProfessional = aggregate.byProfessional
      .map((row): QuoteFunnelProfessionalRow => {
        const view = buildQuoteFunnel(row, withAmounts);
        const [presented, accepted, scheduled, done, collected] = view.steps;
        const pair = (s: (typeof view.steps)[number]) => ({
          count: s.count,
          amount: s.amount,
        });
        return {
          professionalId: row.professionalId,
          name:
            row.professionalId === null
              ? UNATTRIBUTED_PROFESSIONAL_NAME
              : (row.professionalName ?? UNATTRIBUTED_PROFESSIONAL_NAME),
          presented: pair(presented),
          accepted: pair(accepted),
          scheduled: pair(scheduled),
          done: pair(done),
          collected: pair(collected),
          acceptanceRate: view.acceptanceRate,
          medianDaysToAccept: view.medianDaysToAccept,
        };
      })
      // Por presentados (desc), «Sin atribuir» al final, luego por nombre.
      .sort(
        (a, b) =>
          Number(a.professionalId === null) -
            Number(b.professionalId === null) ||
          b.presented.count - a.presented.count ||
          a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }),
      );
    const visibleProfessionals =
      resolved.kind === 'OWN'
        ? professionals.filter((p) => p.userId === input.actor.userId)
        : professionals;
    return {
      period: resolved.period,
      currency: scope.currency,
      scope: resolved.kind,
      restrictedToLocations: input.allowedLocationIds !== 'ALL',
      filters: {
        locationId: input.locationId ?? null,
        providerId: scope.professionalId ?? null,
      },
      ...funnel,
      rejectionReasons: sortRejectionReasons(
        aggregate.rejectionReasons,
        withAmounts,
      ),
      byProfessional,
      warnings: quoteFunnelWarnings(
        scope.currency,
        funnel.withoutRate.presentations,
      ),
      definitions: QUOTE_FUNNEL_DEFINITION_LIST,
      options: {
        locations: resolved.locations,
        professionals: visibleProfessionals,
      },
    };
  }

  /** Las presentaciones de un paso o desenlace (mismo alcance), paginadas. */
  async presentations(
    input: QuoteFunnelPresentationsInput,
  ): Promise<QuoteFunnelPresentations> {
    if (input.reason !== undefined && input.step !== 'REJECTED') {
      throw new BadRequestException(QUOTE_FUNNEL_REASON_NEEDS_REJECTED_MESSAGE);
    }
    const resolved = await this.resolve(input);
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? QUOTE_FUNNEL_PAGE_SIZE;
    const result = await this.repo.listPresentations(
      resolved.period,
      resolved.scope,
      {
        step: input.step,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
      { skip: (page - 1) * pageSize, take: pageSize },
    );
    const money = (value: number | null) => amountOf(value);
    return {
      currency: resolved.scope.currency,
      total: result.total,
      page,
      pageSize,
      items: result.items.map((r) => ({
        ...r,
        presentedAmount: money(r.presentedAmount),
        acceptedAmount: money(r.acceptedAmount),
        scheduledAmount: money(r.scheduledAmount),
        doneAmount: money(r.doneAmount),
        collectedAmount: money(r.collectedAmount),
      })),
    };
  }
}
