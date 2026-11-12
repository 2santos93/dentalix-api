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
  patientLinkRows,
  type PatientLinkCounts,
  type PatientLinkMetrics,
  type PatientLinkType,
} from '../../domain/patient-links';
import {
  PATIENT_LINKS_REPOSITORY,
  type PatientLinksData,
  type PatientLinksRepository,
} from '../../domain/ports/patient-links-repository.port';

export const PATIENT_LINKS_MAX_DAYS = 366;

export const PATIENT_LINKS_INVALID_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const PATIENT_LINKS_PERIOD_TOO_LONG_MESSAGE = `El período admite como mucho ${PATIENT_LINKS_MAX_DAYS} días.`;

/** El reloj del informe: decide qué enlaces ya caducaron. */
export const PATIENT_LINKS_CLOCK = Symbol('PATIENT_LINKS_CLOCK');
export type PatientLinksClock = () => Date;

export interface PatientLinksInput {
  from: string;
  to: string;
  locationId?: string;
  /** Sedes del usuario (claim `loc`, DX-089). */
  allowedLocationIds: AllowedLocations;
}

export interface LocationPatientLinks {
  locationId: string;
  locationName: string;
  timeZone: string;
  rows: PatientLinkMetrics[];
}

export interface PatientLinksReport {
  from: string;
  to: string;
  locationId: string | null;
  /** El usuario solo ve algunas sedes (DX-089): los totales son de ellas. */
  restrictedToLocations: boolean;
  /** Instante con el que se decidió qué enlaces ya caducaron. */
  asOf: Date;
  /** Todas las sedes visibles juntas, un tipo por fila. */
  totals: PatientLinkMetrics[];
  locations: LocationPatientLinks[];
}

/** El informe a partir de lo leído (puro: lo prueban los unit). */
export function buildPatientLinksReport(
  input: {
    from: string;
    to: string;
    locationId: string | null;
    restrictedToLocations: boolean;
    asOf: Date;
  },
  data: PatientLinksData,
): PatientLinksReport {
  const byLocation = new Map<string, Map<PatientLinkType, PatientLinkCounts>>();
  const totals = new Map<PatientLinkType, PatientLinkCounts>();
  for (const row of data.rows) {
    const { linkType, locationId, ...counts } = row;
    if (locationId === null) {
      totals.set(linkType, counts);
      continue;
    }
    const map =
      byLocation.get(locationId) ??
      new Map<PatientLinkType, PatientLinkCounts>();
    map.set(linkType, counts);
    byLocation.set(locationId, map);
  }
  return {
    ...input,
    totals: patientLinkRows(totals),
    locations: data.locations.map((l) => ({
      ...l,
      rows: patientLinkRows(
        byLocation.get(l.locationId) ??
          new Map<PatientLinkType, PatientLinkCounts>(),
      ),
    })),
  };
}

/**
 * «Enlaces del paciente» (DX-424): por tipo de enlace y sede, cuántos se
 * enviaron en el período, cuántos de ellos se abrieron, se completaron o
 * caducaron sin abrirse, con las tasas sobre los enviados y la mediana de
 * horas hasta completarlos. Solo las sedes que ve quien consulta (DX-089), en
 * días civiles de la zona de cada sede. Sin datos de pacientes.
 */
@Injectable()
export class GetPatientLinksUseCase {
  constructor(
    @Inject(PATIENT_LINKS_REPOSITORY)
    private readonly repo: PatientLinksRepository,
    @Inject(PATIENT_LINKS_CLOCK) private readonly clock: PatientLinksClock,
  ) {}

  async execute(input: PatientLinksInput): Promise<PatientLinksReport> {
    const period = checkPeriodDays(input.from, input.to);
    if (!period.ok) {
      throw new BadRequestException(
        period.problem === 'OUT_OF_RANGE'
          ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
          : PATIENT_LINKS_INVALID_PERIOD_MESSAGE,
      );
    }
    if (period.days > PATIENT_LINKS_MAX_DAYS) {
      throw new BadRequestException(PATIENT_LINKS_PERIOD_TOO_LONG_MESSAGE);
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
    const asOf = this.clock();
    const data =
      locationIds.length === 0
        ? { locations: [], rows: [] }
        : await this.repo.load(
            { from: period.from, to: period.to },
            locationIds,
            asOf,
          );
    return buildPatientLinksReport(
      {
        from: period.from,
        to: period.to,
        locationId: input.locationId ?? null,
        restrictedToLocations: input.allowedLocationIds !== 'ALL',
        asOf,
      },
      data,
    );
  }
}
