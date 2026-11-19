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
  shiftCivilYears,
  type CivilPeriod,
} from '../../domain/comparison-period';
import {
  ACQUISITION_TOP_REFERRERS,
  buildAcquisition,
  type AcquisitionBody,
} from '../../domain/acquisition';
import {
  ACQUISITION_REPOSITORY,
  type AcquisitionLocation,
  type AcquisitionRepository,
} from '../../domain/ports/acquisition-repository.port';

/** Tope del período por calendario, como los demás reportes: 24 meses. */
export const ACQUISITION_MAX_MONTHS = 24;

export const ACQUISITION_INVALID_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const ACQUISITION_PERIOD_TOO_LONG_MESSAGE =
  'El período admite como mucho 24 meses.';

export interface AcquisitionInput {
  from: string;
  to: string;
  locationId?: string;
  /** Sedes del usuario (claim `loc`, DX-089). */
  allowedLocationIds: AllowedLocations;
}

export interface AcquisitionReport extends AcquisitionBody {
  period: CivilPeriod;
  filters: { locationId: string | null; locationName: string | null };
  options: { locations: AcquisitionLocation[] };
}

/**
 * «Captación» (DX-172): de dónde vienen los pacientes nuevos del período y lo
 * que se les cobró. Un paciente es de la sede de su PRIMERA cita (su sede de
 * captación; la ficha es de la clínica, no de una sede); sin citas, no es de
 * ninguna y solo cuenta para quien ve todas las sedes sin elegir una.
 */
@Injectable()
export class GetAcquisitionUseCase {
  constructor(
    @Inject(ACQUISITION_REPOSITORY)
    private readonly repo: AcquisitionRepository,
  ) {}

  private period(from: string, to: string): CivilPeriod {
    const period = checkPeriodDays(from, to);
    if (!period.ok) {
      throw new BadRequestException(
        period.problem === 'OUT_OF_RANGE'
          ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
          : ACQUISITION_INVALID_PERIOD_MESSAGE,
      );
    }
    if (
      period.to >= shiftCivilYears(period.from, ACQUISITION_MAX_MONTHS / 12)
    ) {
      throw new BadRequestException(ACQUISITION_PERIOD_TOO_LONG_MESSAGE);
    }
    return { from: period.from, to: period.to };
  }

  async execute(input: AcquisitionInput): Promise<AcquisitionReport> {
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
    const locations = await this.repo.listLocations(input.allowedLocationIds);
    const locationIds = locations
      .map((l) => l.id)
      .filter(
        (id) => input.locationId === undefined || id === input.locationId,
      );
    const aggregate = await this.repo.aggregate(
      period,
      {
        locationIds,
        includeWithoutLocation:
          input.allowedLocationIds === 'ALL' && input.locationId === undefined,
      },
      ACQUISITION_TOP_REFERRERS,
    );
    const location = locations.find((l) => l.id === input.locationId);
    return {
      period,
      filters: {
        locationId: location?.id ?? null,
        locationName: location?.name ?? null,
      },
      options: { locations },
      ...buildAcquisition(
        aggregate.catalog,
        aggregate.sums,
        aggregate.sourceAmounts,
        aggregate.referrers,
        aggregate.referrerAmounts,
      ),
    };
  }
}
