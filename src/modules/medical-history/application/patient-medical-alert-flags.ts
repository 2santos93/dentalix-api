import { Inject, Injectable } from '@nestjs/common';
import {
  NO_ANAMNESIS_FLAGS,
  deriveMedicalAlertFlags,
  type CivilDayInZone,
  type MedicalAlertFlags,
} from '../domain/medical-alert-flags';
import {
  MEDICAL_ALERTS_REPOSITORY,
  type AnamnesisReviewState,
  type MedicalAlertsRepository,
} from '../domain/ports/medical-alerts-repository.port';
import {
  LOCATION_REPOSITORY,
  type LocationRepository,
} from '../../locations/domain/ports/location-repository.port';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { civilDateIn } from '../../../shared/time/civil-day';

export const MEDICAL_ALERTS_CLOCK = Symbol('MEDICAL_ALERTS_CLOCK');

/** Zona de reserva si la clínica no tiene ninguna sede viva (no debería pasar). */
const FALLBACK_TIME_ZONE = 'America/Bogota';

/** Lo que hace falta de una cita para evaluar su alerta el día que ocurre. */
export interface AppointmentForAlerts {
  id: string;
  patientId: string;
  start: Date;
  locationId: string;
}

/**
 * Banderas médicas de un LOTE de pacientes (DX-247, molde
 * `PatientCoverageFlags`): la agenda y el panel «En clínica» las piden para
 * todos a la vez, en un número fijo de consultas (la vigencia, la versión
 * vigente + última confirmación de cada paciente y, para la agenda, las zonas
 * de las sedes). Solo banderas: nunca la historia.
 *
 * El estado de la anamnesis se evalúa por DÍA CIVIL de la sede: el de cada
 * cita en la agenda (preparar la visita del jueves ve lo que valdrá el
 * jueves) y hoy en la sede en la ficha y en «En clínica».
 */
@Injectable()
export class PatientMedicalAlertFlags {
  constructor(
    @Inject(MEDICAL_ALERTS_REPOSITORY)
    private readonly repo: MedicalAlertsRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(MEDICAL_ALERTS_CLOCK) private readonly now: () => Date,
  ) {}

  private async load(
    patientIds: readonly string[],
  ): Promise<{ states: Map<string, AnamnesisReviewState>; months: number }> {
    const [states, months] = await Promise.all([
      this.repo.reviewStates(patientIds),
      this.repo.getValidityMonths(),
    ]);
    return { states, months };
  }

  private flagsOf(
    state: AnamnesisReviewState | undefined,
    months: number,
    at: CivilDayInZone,
  ): MedicalAlertFlags {
    return state
      ? deriveMedicalAlertFlags(
          state.snapshot,
          state.lastConfirmedAt,
          months,
          at,
        )
      : NO_ANAMNESIS_FLAGS;
  }

  /** Banderas de cada paciente evaluadas el día `at` (p. ej. hoy en la sede). */
  async forPatients(
    patientIds: readonly string[],
    at: CivilDayInZone,
  ): Promise<Map<string, MedicalAlertFlags>> {
    const ids = [...new Set(patientIds)];
    const out = new Map<string, MedicalAlertFlags>();
    if (ids.length === 0) return out;
    const { states, months } = await this.load(ids);
    for (const id of ids) out.set(id, this.flagsOf(states.get(id), months, at));
    return out;
  }

  async forPatient(
    patientId: string,
    at: CivilDayInZone,
  ): Promise<MedicalAlertFlags> {
    return (
      (await this.forPatients([patientId], at)).get(patientId) ??
      NO_ANAMNESIS_FLAGS
    );
  }

  /**
   * Banderas de cada CITA (por id), evaluadas el día civil de su inicio en la
   * zona de su sede. Sin N+1: una lectura del lote de pacientes y una de las
   * sedes, sea cual sea el número de citas.
   */
  async forAppointments(
    appointments: readonly AppointmentForAlerts[],
  ): Promise<Map<string, MedicalAlertFlags>> {
    const out = new Map<string, MedicalAlertFlags>();
    if (appointments.length === 0) return out;
    const [{ states, months }, zones] = await Promise.all([
      this.load([...new Set(appointments.map((a) => a.patientId))]),
      this.zonesByLocation(),
    ]);
    for (const a of appointments) {
      const timeZone = zones.byId.get(a.locationId) ?? zones.fallback;
      out.set(
        a.id,
        this.flagsOf(states.get(a.patientId), months, {
          date: civilDateIn(a.start, timeZone),
          timeZone,
        }),
      );
    }
    return out;
  }

  /**
   * Hoy en la sede del request o, en la vista consolidada, en la principal
   * (la primera creada), con el reloj del servidor.
   */
  async todayInSede(): Promise<CivilDayInZone> {
    const zones = await this.zonesByLocation();
    const locationId = this.tenantContext.getLocationId();
    const timeZone =
      (locationId ? zones.byId.get(locationId) : undefined) ?? zones.fallback;
    return { date: civilDateIn(this.now(), timeZone), timeZone };
  }

  private async zonesByLocation(): Promise<{
    byId: Map<string, string>;
    fallback: string;
  }> {
    const list = await this.locations.list();
    return {
      byId: new Map(list.map((l) => [l.id, l.timeZone])),
      fallback: list[0]?.timeZone ?? FALLBACK_TIME_ZONE,
    };
  }
}
