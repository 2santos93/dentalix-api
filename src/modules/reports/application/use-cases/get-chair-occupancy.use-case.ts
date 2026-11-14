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
  buildLocationOccupancy,
  type LocationOccupancy,
} from '../../domain/chair-occupancy';
import {
  CHAIR_OCCUPANCY_REPOSITORY,
  type ChairOccupancyLocationData,
  type ChairOccupancyRepository,
} from '../../domain/ports/chair-occupancy-repository.port';

export const CHAIR_OCCUPANCY_MAX_DAYS = 366;

export const CHAIR_OCCUPANCY_INVALID_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const CHAIR_OCCUPANCY_PERIOD_TOO_LONG_MESSAGE = `El período admite como mucho ${CHAIR_OCCUPANCY_MAX_DAYS} días.`;

export interface ChairOccupancyInput {
  from: string;
  to: string;
  locationId?: string;
  /** Sedes del usuario (claim `loc`, DX-089). */
  allowedLocationIds: AllowedLocations;
}

export type LocationChairOccupancy = {
  locationId: string;
  locationName: string;
  timeZone: string;
} & LocationOccupancy;

export interface ChairOccupancyReport {
  from: string;
  to: string;
  locationId: string | null;
  /** El usuario solo ve algunas sedes (DX-089). */
  restrictedToLocations: boolean;
  locations: LocationChairOccupancy[];
}

/** El informe a partir de lo leído (puro: lo prueban los unit). */
export function buildChairOccupancyReport(
  input: {
    from: string;
    to: string;
    locationId: string | null;
    restrictedToLocations: boolean;
  },
  data: readonly ChairOccupancyLocationData[],
): ChairOccupancyReport {
  return {
    ...input,
    locations: data.map((l) => ({
      locationId: l.locationId,
      locationName: l.locationName,
      timeZone: l.timeZone,
      ...buildLocationOccupancy({
        from: input.from,
        to: input.to,
        timeZone: l.timeZone,
        ranges: l.ranges,
        closures: l.closures,
        holidays: l.holidays,
        chairs: l.chairs,
        appointments: l.appointments,
      }),
    })),
  };
}

/**
 * «Ocupación por sillón» (DX-481): por sede y sillón, los minutos abiertos
 * (horario de la sede − cierres de toda la sede − festivos), reservados (citas
 * no canceladas) y atendidos (COMPLETED), con las inasistencias aparte y las
 * citas sin sillón en su fila. Solo las sedes que ve quien consulta (DX-089),
 * en días civiles de la zona de cada sede.
 */
@Injectable()
export class GetChairOccupancyUseCase {
  constructor(
    @Inject(CHAIR_OCCUPANCY_REPOSITORY)
    private readonly repo: ChairOccupancyRepository,
  ) {}

  async execute(input: ChairOccupancyInput): Promise<ChairOccupancyReport> {
    const period = checkPeriodDays(input.from, input.to);
    if (!period.ok) {
      throw new BadRequestException(
        period.problem === 'OUT_OF_RANGE'
          ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
          : CHAIR_OCCUPANCY_INVALID_PERIOD_MESSAGE,
      );
    }
    if (period.days > CHAIR_OCCUPANCY_MAX_DAYS) {
      throw new BadRequestException(CHAIR_OCCUPANCY_PERIOD_TOO_LONG_MESSAGE);
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
    const data =
      locationIds.length === 0
        ? []
        : await this.repo.load(
            { from: period.from, to: period.to },
            locationIds,
          );
    return buildChairOccupancyReport(
      {
        from: period.from,
        to: period.to,
        locationId: input.locationId ?? null,
        restrictedToLocations: input.allowedLocationIds !== 'ALL',
      },
      data,
    );
  }
}
