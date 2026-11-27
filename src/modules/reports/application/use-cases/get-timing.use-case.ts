import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
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
import { addCivilMonths } from '../../../recall/domain/recall-rules';
import type { CivilPeriod } from '../../domain/comparison-period';
import {
  buildOccupancy,
  EMPTY_TIMING_AGGREGATE,
  exceedsPlanned,
  TIMING_MAX_MONTHS,
  TIMING_SCOPE_NOTE,
  TIMING_THRESHOLDS,
  timingDefinitions,
  timingFigures,
  weeksOf,
  type OccupancyFigures,
  type ProviderOccupancyWeek,
  type TimingDefinition,
  type TimingFigures,
  type TimingThresholds,
} from '../../domain/timing';
import {
  TIMING_REPOSITORY,
  type TimingGroupRow,
  type TimingLocation,
  type TimingProfessionalOption,
  type TimingRepository,
} from '../../domain/ports/timing-repository.port';

export const TIMING_FORBIDDEN_MESSAGE =
  'Solo la administración y los odontólogos ven los tiempos de la agenda.';
export const TIMING_OWN_ONLY_MESSAGE = 'Solo puedes ver tus propios tiempos.';
export const TIMING_INVALID_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const TIMING_PERIOD_TOO_LONG_MESSAGE =
  'El período admite como mucho 12 meses.';
export const TIMING_LOCATION_NOT_FOUND_MESSAGE = 'Sede no encontrada.';

export const UNNAMED_PROFESSIONAL = 'Profesional sin nombre';
export const UNTYPED_APPOINTMENTS = 'Sin tipo de cita';

export interface TimingActor {
  userId: string;
  role: ClinicRole;
}

export interface TimingInput {
  from: string;
  to: string;
  locationId?: string;
  providerId?: string;
  actor: TimingActor;
  /** Sedes del usuario (claim `loc`, DX-089). */
  allowedLocationIds: AllowedLocations;
}

/** CLINIC: toda la clínica (ADMIN); OWN: solo lo del odontólogo. */
export type TimingScopeKind = 'CLINIC' | 'OWN';

export interface TimingFilters {
  locationId: string | null;
  locationName: string | null;
  providerId: string | null;
  providerName: string | null;
}

export interface TimingProfessionalRow extends TimingFigures {
  providerId: string;
  providerName: string;
}

export interface TimingTypeRow extends TimingFigures {
  /** null = las citas sin tipo. */
  appointmentTypeId: string | null;
  appointmentTypeName: string;
  /** Duración del tipo en el catálogo (hoy); null sin tipo. */
  catalogDurationMinutes: number | null;
  /** Aviso: se excede > 20 % en ≥ 10 citas medidas. */
  exceedsPlanned: boolean;
}

export interface TimingWeekRow extends TimingFigures {
  weekStart: string;
  /** La semana recortada al período. */
  from: string;
  to: string;
}

export interface TimingOccupancyRow extends OccupancyFigures {
  providerId: string;
  providerName: string;
  hasSchedule: boolean;
  weeks: ProviderOccupancyWeek[];
}

export interface TimingReport {
  from: string;
  to: string;
  scope: TimingScopeKind;
  filters: TimingFilters;
  options: {
    locations: TimingLocation[];
    professionals: TimingProfessionalOption[];
  };
  totals: TimingFigures;
  byProfessional: TimingProfessionalRow[];
  byAppointmentType: TimingTypeRow[];
  byWeek: TimingWeekRow[];
  occupancy: {
    professionals: TimingOccupancyRow[];
    totals: OccupancyFigures;
  };
  thresholds: TimingThresholds;
  scopeNote: string;
  definitions: TimingDefinition[];
  /** false = «Sin citas atendidas ni agenda en el período». */
  hasData: boolean;
}

/** El período: fechas válidas y como mucho 12 meses por calendario. */
export function timingPeriod(from: string, to: string): CivilPeriod {
  const period = checkPeriodDays(from, to);
  if (!period.ok) {
    throw new BadRequestException(
      period.problem === 'OUT_OF_RANGE'
        ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
        : TIMING_INVALID_PERIOD_MESSAGE,
    );
  }
  if (period.to >= addCivilMonths(period.from, TIMING_MAX_MONTHS)) {
    throw new BadRequestException(TIMING_PERIOD_TOO_LONG_MESSAGE);
  }
  return { from: period.from, to: period.to };
}

/**
 * Alcance del ticket: ADMIN ve todos los profesionales; un DENTIST, solo lo
 * suyo (aunque no lo pida; pedir a otro es 403). El resto de roles no llega
 * (403 del guard); aquí se repite por si el caso de uso se usa sin él. No
 * mira FINANCIAL_REPORTS_VIEW: no es un reporte financiero.
 */
export function timingScopeOf(
  actor: TimingActor,
  providerId: string | undefined,
): { providerId?: string; kind: TimingScopeKind } {
  if (actor.role === ClinicRole.ADMIN) {
    return {
      ...(providerId !== undefined ? { providerId } : {}),
      kind: 'CLINIC',
    };
  }
  if (actor.role !== ClinicRole.DENTIST) {
    throw new ForbiddenException(TIMING_FORBIDDEN_MESSAGE);
  }
  if (providerId !== undefined && providerId !== actor.userId) {
    throw new ForbiddenException(TIMING_OWN_ONLY_MESSAGE);
  }
  return { providerId: actor.userId, kind: 'OWN' };
}

const sortByName = <T extends { providerName: string }>(rows: T[]) =>
  rows.sort((a, b) =>
    a.providerName.localeCompare(b.providerName, 'es', { sensitivity: 'base' }),
  );

/**
 * «Tiempos» (DX-275): espera en sala, retraso de inicio y duración real
 * frente a la programada por profesional, tipo de cita y semana, con las
 * citas sin tiempos e incoherentes contadas aparte, y la ocupación histórica
 * por profesional y semana. Todo en la zona horaria de cada sede.
 *
 * Una sede que no es de la clínica (o retirada) es 404; una de la clínica
 * fuera de las del usuario (DX-089), el 403 de siempre.
 */
@Injectable()
export class GetTimingUseCase {
  constructor(
    @Inject(TIMING_REPOSITORY)
    private readonly repo: TimingRepository,
  ) {}

  async execute(input: TimingInput): Promise<TimingReport> {
    const { providerId, kind } = timingScopeOf(input.actor, input.providerId);
    const period = timingPeriod(input.from, input.to);
    if (input.locationId !== undefined) {
      if (!(await this.repo.locationInClinic(input.locationId))) {
        throw new NotFoundException(TIMING_LOCATION_NOT_FOUND_MESSAGE);
      }
      if (!isLocationAllowed(input.allowedLocationIds, input.locationId)) {
        throw locationNotAllowed();
      }
    }
    const locations = await this.repo.listLocations(input.allowedLocationIds);
    const locationIds = locations
      .map((l) => l.id)
      .filter(
        (id) => input.locationId === undefined || id === input.locationId,
      );
    const [data, professionals] = await Promise.all([
      this.repo.load(period, {
        locationIds,
        ...(providerId !== undefined ? { providerId } : {}),
      }),
      this.repo.listProfessionals(locations.map((l) => l.id)),
    ]);
    const nameOf = (id: string) =>
      data.names.get(id) ??
      professionals.find((p) => p.userId === id)?.fullName ??
      UNNAMED_PROFESSIONAL;

    const of = (set: TimingGroupRow['set']) =>
      data.groups.filter((g) => g.set === set);
    const [total] = of('TOTAL');

    const byProfessional = sortByName(
      of('PROFESSIONAL').map((g): TimingProfessionalRow => ({
        providerId: g.providerId as string,
        providerName: nameOf(g.providerId as string),
        ...timingFigures(g),
      })),
    );

    const byAppointmentType = of('TYPE')
      .map((g): TimingTypeRow => {
        const type =
          g.appointmentTypeId !== null
            ? data.types.get(g.appointmentTypeId)
            : undefined;
        const figures = timingFigures(g);
        return {
          appointmentTypeId: g.appointmentTypeId,
          appointmentTypeName:
            g.appointmentTypeId === null
              ? UNTYPED_APPOINTMENTS
              : (type?.name ?? 'Tipo de cita'),
          catalogDurationMinutes: type?.durationMinutes ?? null,
          ...figures,
          exceedsPlanned: exceedsPlanned(figures, g.appointmentTypeId !== null),
        };
      })
      // Primero los que avisan, luego por nombre; «Sin tipo», al final.
      .sort(
        (a, b) =>
          Number(a.appointmentTypeId === null) -
            Number(b.appointmentTypeId === null) ||
          Number(b.exceedsPlanned) - Number(a.exceedsPlanned) ||
          a.appointmentTypeName.localeCompare(b.appointmentTypeName, 'es', {
            sensitivity: 'base',
          }),
      );

    // Todas las semanas del período, también las que no tienen citas.
    const weekGroups = new Map(of('WEEK').map((g) => [g.weekStart, g]));
    const byWeek = weeksOf(period).map((w): TimingWeekRow => ({
      ...w,
      ...timingFigures(weekGroups.get(w.weekStart) ?? EMPTY_TIMING_AGGREGATE),
    }));

    const occupancy = buildOccupancy(period, data.capacities, data.booked);
    const occupancyRows = sortByName(
      occupancy.professionals.map((p): TimingOccupancyRow => ({
        ...p,
        providerName: nameOf(p.providerId),
      })),
    ).map(({ providerId, providerName, hasSchedule, weeks, ...figures }) => ({
      providerId,
      providerName,
      hasSchedule,
      ...figures,
      weeks,
    }));

    const location = locations.find((l) => l.id === input.locationId);
    const totals = timingFigures(total ?? EMPTY_TIMING_AGGREGATE);
    return {
      from: period.from,
      to: period.to,
      scope: kind,
      filters: {
        locationId: location?.id ?? null,
        locationName: location?.name ?? null,
        providerId: providerId ?? null,
        providerName:
          providerId !== undefined
            ? (professionals.find((p) => p.userId === providerId)?.fullName ??
              data.names.get(providerId) ??
              null)
            : null,
      },
      options: {
        locations,
        professionals:
          kind === 'OWN'
            ? professionals.filter((p) => p.userId === input.actor.userId)
            : professionals,
      },
      totals,
      byProfessional,
      byAppointmentType,
      byWeek,
      occupancy: { professionals: occupancyRows, totals: occupancy.totals },
      thresholds: TIMING_THRESHOLDS,
      scopeNote: TIMING_SCOPE_NOTE,
      definitions: timingDefinitions(),
      hasData: totals.completed > 0 || occupancyRows.length > 0,
    };
  }
}
