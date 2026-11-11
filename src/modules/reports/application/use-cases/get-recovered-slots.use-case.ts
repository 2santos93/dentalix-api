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
import {
  buildMetrics,
  isoWeekStart,
  matchRecoveredSlots,
  slotWeek,
  valueAttribution,
  weeksOfPeriod,
  type RecoveredSlotsMetrics,
  type SlotOutcome,
} from '../../domain/recovered-slots';
import {
  RECOVERED_SLOTS_REPOSITORY,
  type RecoveredSlotsData,
  type RecoveredSlotsRepository,
} from '../../domain/ports/recovered-slots-repository.port';

export const RECOVERED_SLOTS_MAX_DAYS = 366;

export const RECOVERED_SLOTS_INVALID_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const RECOVERED_SLOTS_PERIOD_TOO_LONG_MESSAGE = `El período admite como mucho ${RECOVERED_SLOTS_MAX_DAYS} días.`;

export interface RecoveredSlotsInput {
  from: string;
  to: string;
  locationId?: string;
  providerId?: string;
  /** Sedes del usuario (claim `loc`, DX-089). */
  allowedLocationIds: AllowedLocations;
}

export type ProviderRecoveredSlots = {
  providerId: string;
  providerName: string;
} & RecoveredSlotsMetrics;

export type WeekRecoveredSlots = { weekStart: string } & RecoveredSlotsMetrics;

export interface RecoveredSlotsReport {
  from: string;
  to: string;
  locationId: string | null;
  providerId: string | null;
  /** El usuario solo ve algunas sedes (DX-089): los totales son de ellas. */
  restrictedToLocations: boolean;
  totals: RecoveredSlotsMetrics;
  byProvider: ProviderRecoveredSlots[];
  byWeek: WeekRecoveredSlots[];
}

/** Las métricas de una parte del informe (un profesional, una semana). */
function metricsOf(
  data: RecoveredSlotsData,
  outcomes: readonly SlotOutcome[],
  attribution: ReadonlySet<string>,
  keep: {
    outcome: (o: SlotOutcome) => boolean;
    row: (r: { providerId: string; day: string }) => boolean;
  },
): RecoveredSlotsMetrics {
  return buildMetrics(
    outcomes.filter(keep.outcome),
    data.counts.filter(keep.row),
    data.offers.filter(keep.row),
    data.values,
    attribution,
  );
}

/** El informe a partir de lo leído (puro: lo prueban los unit). */
export function buildRecoveredSlotsReport(
  input: {
    from: string;
    to: string;
    locationId: string | null;
    providerId: string | null;
    restrictedToLocations: boolean;
  },
  data: RecoveredSlotsData,
): RecoveredSlotsReport {
  const outcomes = matchRecoveredSlots(data.slots, data.candidates);
  const attribution = valueAttribution(outcomes);
  const all = { outcome: () => true, row: () => true };

  const providerIds = new Set<string>([
    ...data.slots.map((s) => s.providerId),
    ...data.counts.map((c) => c.providerId),
    ...data.offers.map((o) => o.providerId),
  ]);
  const names = new Map(
    data.providers.map((p) => [p.providerId, p.providerName]),
  );
  const byProvider = [...providerIds]
    .map((providerId) => ({
      providerId,
      providerName: names.get(providerId) ?? 'Profesional sin datos',
      ...metricsOf(data, outcomes, attribution, {
        outcome: (o) => o.slot.providerId === providerId,
        row: (r) => r.providerId === providerId,
      }),
    }))
    .sort(
      (a, b) =>
        a.providerName.localeCompare(b.providerName, 'es', {
          sensitivity: 'base',
        }) || (a.providerId < b.providerId ? -1 : 1),
    );

  const byWeek = weeksOfPeriod(input.from, input.to).map((weekStart) => ({
    weekStart,
    ...metricsOf(data, outcomes, attribution, {
      outcome: (o) => slotWeek(o.slot) === weekStart,
      row: (r) => isoWeekStart(r.day) === weekStart,
    }),
  }));

  return {
    ...input,
    totals: metricsOf(data, outcomes, attribution, all),
    byProvider,
    byWeek,
  };
}

/**
 * «Huecos recuperados» (DX-436): cuántos huecos liberó la agenda (cancelación
 * o inasistencia con ≥ 1 h de aviso), cuántos se rellenaron (completos o en
 * parte), cuántos por la lista de espera, en cuánto tiempo, con qué ofertas y
 * qué valor recuperaron; con la tasa de cancelación al lado. Solo las sedes
 * que ve quien consulta (DX-089), en días civiles de la zona de cada sede.
 */
@Injectable()
export class GetRecoveredSlotsUseCase {
  constructor(
    @Inject(RECOVERED_SLOTS_REPOSITORY)
    private readonly repo: RecoveredSlotsRepository,
  ) {}

  async execute(input: RecoveredSlotsInput): Promise<RecoveredSlotsReport> {
    const period = checkPeriodDays(input.from, input.to);
    if (!period.ok) {
      throw new BadRequestException(
        period.problem === 'OUT_OF_RANGE'
          ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
          : RECOVERED_SLOTS_INVALID_PERIOD_MESSAGE,
      );
    }
    if (period.days > RECOVERED_SLOTS_MAX_DAYS) {
      throw new BadRequestException(RECOVERED_SLOTS_PERIOD_TOO_LONG_MESSAGE);
    }
    // Sede ajena a la clínica o no permitida: el MISMO 403, para no decir
    // qué sedes existen.
    if (
      input.locationId !== undefined &&
      (!isLocationAllowed(input.allowedLocationIds, input.locationId) ||
        !(await this.repo.locationInClinic(input.locationId)))
    ) {
      throw locationNotAllowed();
    }
    const visible = await this.repo.listLocationIds(input.allowedLocationIds);
    const locationIds = visible.filter(
      (id) => input.locationId === undefined || id === input.locationId,
    );
    const empty: RecoveredSlotsData = {
      slots: [],
      candidates: [],
      values: new Map(),
      counts: [],
      offers: [],
      providers: [],
    };
    const data =
      locationIds.length === 0
        ? empty
        : await this.repo.load(
            { from: period.from, to: period.to },
            {
              locationIds,
              ...(input.providerId !== undefined
                ? { providerId: input.providerId }
                : {}),
            },
          );
    return buildRecoveredSlotsReport(
      {
        from: period.from,
        to: period.to,
        locationId: input.locationId ?? null,
        providerId: input.providerId ?? null,
        restrictedToLocations: input.allowedLocationIds !== 'ALL',
      },
      data,
    );
  }
}
