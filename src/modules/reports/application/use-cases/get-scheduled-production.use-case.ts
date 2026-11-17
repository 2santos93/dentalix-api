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
  buildForecast,
  buildScheduledView,
  civilDaysOf,
  convertGroups,
  memoizedDailyRates,
  monthOf,
  rateDayFor,
  SCHEDULED_PRODUCTION_DEFINITION_LIST,
  scheduledProductionWarnings,
  type ForecastView,
  type ScheduledProductionDefinition,
  type ScheduledProductionWarning,
  type ScheduledView,
  type StoredRates,
} from '../../domain/scheduled-production';
import {
  SCHEDULED_PRODUCTION_REPOSITORY,
  type ScheduledProductionLocation,
  type ScheduledProductionProfessional,
  type ScheduledProductionRepository,
  type ScheduledProductionScope,
  type UnlinkedAppointmentRow,
} from '../../domain/ports/scheduled-production-repository.port';
import {
  CATALOG_CURRENCY_READER,
  type CatalogCurrencyReader,
} from '../../../dental-catalog/domain/ports/catalog-currency-reader.port';
import { GetRatesForDateUseCase } from '../../../exchange/application/use-cases/get-rates-for-date.use-case';
import { BASE_CURRENCY } from '../../../exchange/domain/exchange-rate-source';

/** Tope del período, en días civiles (ambos inclusive): el de la agenda. */
export const SCHEDULED_PRODUCTION_MAX_DAYS = 62;

export const SCHEDULED_PRODUCTION_INVALID_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const SCHEDULED_PRODUCTION_PERIOD_TOO_LONG_MESSAGE = `El período admite como mucho ${SCHEDULED_PRODUCTION_MAX_DAYS} días.`;
export const SCHEDULED_PRODUCTION_OWN_ONLY_MESSAGE =
  'Solo puedes ver tu propia producción agendada.';
export const SCHEDULED_PRODUCTION_FORBIDDEN_MESSAGE =
  'Solo la administración, los odontólogos y quien tenga acceso a los reportes financieros ven la producción agendada.';

export const SCHEDULED_PRODUCTION_PAGE_SIZE = 25;

/** El reloj del «hoy» de la previsión (inyectable en los tests). */
export const SCHEDULED_PRODUCTION_CLOCK = Symbol('SCHEDULED_PRODUCTION_CLOCK');
export type ScheduledProductionClock = () => Date;

/** Solo la lectura de las tasas YA guardadas: nunca el proveedor externo. */
export type StoredRatesReader = Pick<GetRatesForDateUseCase, 'storedReader'>;

export interface ScheduledProductionActor {
  userId: string;
  role: ClinicRole;
  /** Rol base ∪ permisos extra concedidos (DX-090), los de RolesGuard. */
  permissions: readonly ExtraPermission[];
}

export interface ScheduledProductionInput {
  from: string;
  to: string;
  locationId?: string;
  providerId?: string;
  actor: ScheduledProductionActor;
  /** Sedes del usuario (claim `loc`, DX-089). */
  allowedLocationIds: AllowedLocations;
}

export interface ScheduledProductionUnlinkedInput extends ScheduledProductionInput {
  page?: number;
  pageSize?: number;
}

/** CLINIC = todo lo visible; OWN = solo lo de quien consulta. */
export type ScheduledProductionScopeKind = 'CLINIC' | 'OWN';

export interface ScheduledProductionReport extends Omit<
  ScheduledView,
  'withoutRate'
> {
  period: CivilPeriod;
  currency: string | null;
  scope: ScheduledProductionScopeKind;
  restrictedToLocations: boolean;
  filters: { locationId: string | null; providerId: string | null };
  forecast: ForecastView;
  withoutRate: { appointments: number; items: number };
  unattributedDone: number;
  warnings: ScheduledProductionWarning[];
  definitions: readonly ScheduledProductionDefinition[];
  options: {
    locations: ScheduledProductionLocation[];
    professionals: ScheduledProductionProfessional[];
  };
}

export interface ScheduledProductionUnlinked {
  items: UnlinkedAppointmentRow[];
  total: number;
  page: number;
  pageSize: number;
}

interface ResolvedScope {
  period: CivilPeriod;
  kind: ScheduledProductionScopeKind;
  locations: ScheduledProductionLocation[];
  scope: ScheduledProductionScope;
}

/**
 * «Producción agendada y previsión del mes» (DX-567): el valor de lo que hay
 * en la agenda del período por día y por profesional, las citas sin
 * tratamiento ligado y, del mes en curso, producido hasta hoy + agendado
 * pendiente = previsión. ADMIN o quien tenga FINANCIAL_REPORTS_VIEW ve toda
 * la clínica (y filtra por profesional); un DENTIST sin el permiso, solo lo
 * suyo; recepción y asistente, nada. Solo las sedes que ve quien consulta
 * (DX-089).
 */
@Injectable()
export class GetScheduledProductionUseCase {
  constructor(
    @Inject(SCHEDULED_PRODUCTION_REPOSITORY)
    private readonly repo: ScheduledProductionRepository,
    // La moneda del catálogo (DX-502-ter): la de todos los importes.
    @Inject(CATALOG_CURRENCY_READER)
    private readonly catalogCurrency: CatalogCurrencyReader,
    // DX-569: solo `storedReader()`, la tasa ya guardada del día (sin proveedor).
    @Inject(GetRatesForDateUseCase)
    private readonly rates: StoredRatesReader,
    @Inject(SCHEDULED_PRODUCTION_CLOCK)
    private readonly clock: ScheduledProductionClock,
  ) {}

  private period(from: string, to: string): CivilPeriod {
    const period = checkPeriodDays(from, to);
    if (!period.ok) {
      throw new BadRequestException(
        period.problem === 'OUT_OF_RANGE'
          ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
          : SCHEDULED_PRODUCTION_INVALID_PERIOD_MESSAGE,
      );
    }
    if (period.days > SCHEDULED_PRODUCTION_MAX_DAYS) {
      throw new BadRequestException(
        SCHEDULED_PRODUCTION_PERIOD_TOO_LONG_MESSAGE,
      );
    }
    return { from: period.from, to: period.to };
  }

  /** Quien ve toda la clínica; el DENTIST, solo lo suyo; el resto, 403. */
  private professionalOf(input: ScheduledProductionInput): {
    professionalId?: string;
    kind: ScheduledProductionScopeKind;
  } {
    if (
      input.actor.role === ClinicRole.ADMIN ||
      input.actor.permissions.includes(ExtraPermission.FINANCIAL_REPORTS_VIEW)
    ) {
      return { professionalId: input.providerId, kind: 'CLINIC' };
    }
    if (input.actor.role !== ClinicRole.DENTIST) {
      throw new ForbiddenException(SCHEDULED_PRODUCTION_FORBIDDEN_MESSAGE);
    }
    if (
      input.providerId !== undefined &&
      input.providerId !== input.actor.userId
    ) {
      throw new ForbiddenException(SCHEDULED_PRODUCTION_OWN_ONLY_MESSAGE);
    }
    return { professionalId: input.actor.userId, kind: 'OWN' };
  }

  private async resolve(
    input: ScheduledProductionInput,
  ): Promise<ResolvedScope> {
    const { professionalId, kind } = this.professionalOf(input);
    const period = this.period(input.from, input.to);
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
        // Un realizado sin sede no es de ninguna: solo lo ve quien ve todas,
        // y sin elegir una.
        includeWithoutLocation:
          input.allowedLocationIds === 'ALL' && input.locationId === undefined,
        ...(professionalId !== undefined ? { professionalId } : {}),
        currency,
      },
    };
  }

  /** La tasa guardada de un día para pasar `currency` al catálogo. */
  private ratesReader(
    catalog: string,
  ): (day: string, currency: string) => Promise<StoredRates | null> {
    // Los ajustes de la clínica, una vez por petición; cada (día, moneda),
    // una vez (memo).
    const stored = this.rates.storedReader();
    return memoizedDailyRates(async (day, currency) => {
      const currencies = [currency, catalog].filter((c) => c !== BASE_CURRENCY);
      const read = await stored(day, { currencies });
      return read?.rates ?? null;
    });
  }

  async execute(
    input: ScheduledProductionInput,
  ): Promise<ScheduledProductionReport> {
    const resolved = await this.resolve(input);
    const { scope } = resolved;
    const currency = scope.currency;
    const withAmounts = currency !== null;
    const now = this.clock();
    const [scheduled, forecast, professionals] = await Promise.all([
      this.repo.scheduled(resolved.period, scope),
      this.repo.forecast(now, scope, input.locationId ?? null),
      this.repo.listProfessionals(scope.locationIds),
    ]);
    // Hoy de cada sede: lo agendado de un día futuro usa la tasa de hoy.
    const todayOf = new Map<string, string>();
    for (const zone of forecast.window.zones) {
      for (const id of zone.locationIds) todayOf.set(id, zone.today);
    }
    const ratesOf = this.ratesReader(currency ?? BASE_CURRENCY);
    const [amounts, produced, pending] = await Promise.all([
      convertGroups(
        scheduled.amounts,
        currency,
        (g) =>
          rateDayFor(
            g.day,
            todayOf.get(g.locationId) ?? forecast.window.reference.today,
          ),
        ratesOf,
      ),
      convertGroups(forecast.produced, currency, (g) => g.day, ratesOf),
      convertGroups(
        forecast.pending,
        currency,
        (g) =>
          rateDayFor(
            g.day,
            todayOf.get(g.locationId) ?? forecast.window.reference.today,
          ),
        ratesOf,
      ),
    ]);
    const view = buildScheduledView({
      days: civilDaysOf(resolved.period.from, resolved.period.to),
      amounts,
      appointments: scheduled.appointments,
      names: scheduled.names,
      withAmounts,
    });
    const reference = forecast.window.reference;
    const month = monthOf(reference.today);
    const forecastView = buildForecast({
      month,
      today: reference.today,
      produced,
      pending,
      withAmounts,
    });
    const visibleProfessionals =
      resolved.kind === 'OWN'
        ? professionals.filter((p) => p.userId === input.actor.userId)
        : professionals;
    return {
      period: resolved.period,
      currency,
      scope: resolved.kind,
      restrictedToLocations: input.allowedLocationIds !== 'ALL',
      filters: {
        locationId: input.locationId ?? null,
        providerId: scope.professionalId ?? null,
      },
      totals: view.totals,
      byDay: view.byDay,
      byProfessional: view.byProfessional,
      byDayAndProfessional: view.byDayAndProfessional,
      forecast: forecastView,
      withoutRate: view.withoutRate,
      unattributedDone: forecast.unattributedDone,
      warnings: scheduledProductionWarnings({
        currency,
        withoutRate: view.withoutRate.items + forecastView.itemsWithoutRate,
        mixedMonths: forecast.window.zones.some(
          (z) => monthOf(z.today) !== month,
        ),
        unattributedDone: forecast.unattributedDone,
      }),
      definitions: SCHEDULED_PRODUCTION_DEFINITION_LIST,
      options: {
        locations: resolved.locations,
        professionals: visibleProfessionals,
      },
    };
  }

  /** Las citas sin tratamiento ligado (mismo alcance), paginadas. */
  async unlinked(
    input: ScheduledProductionUnlinkedInput,
  ): Promise<ScheduledProductionUnlinked> {
    const resolved = await this.resolve(input);
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? SCHEDULED_PRODUCTION_PAGE_SIZE;
    const result = await this.repo.listUnlinked(
      resolved.period,
      resolved.scope,
      { skip: (page - 1) * pageSize, take: pageSize },
    );
    return { ...result, page, pageSize };
  }
}
