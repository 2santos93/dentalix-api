import { Inject, Injectable } from '@nestjs/common';
import type { OnlineBookingPatientKind } from '@prisma/client';
import {
  APPOINTMENT_REPOSITORY,
  type AppointmentRepository,
} from '../../appointments/domain/ports/appointment-repository.port';
import {
  LOCATION_SCHEDULE_REPOSITORY,
  type LocationScheduleRepository,
} from '../../location-schedule/domain/ports/location-schedule-repository.port';
import {
  SCHEDULE_BLOCK_REPOSITORY,
  type ScheduleBlockRepository,
} from '../../schedule-blocks/domain/ports/schedule-block-repository.port';
import { blockAffects } from '../../schedule-blocks/domain/schedule-block-rules';
import {
  STAFF_REPOSITORY,
  type StaffRepository,
} from '../../staff/domain/ports/staff-repository.port';
import { ATTENDING_ROLES } from '../../staff/domain/attending';
import { attendsAt } from '../../staff/domain/provider-location';
import { ProviderAvailabilityService } from '../../provider-schedule/application/provider-availability.service';
import { holidayOn } from '../../location-calendar/domain/holiday-rules';
import {
  civilRangeInZone,
  isValidTimeZone,
} from '../../../shared/time/civil-day';
import {
  clampOnlineDays,
  computeOnlineSlots,
  type OnlineSlot,
  type ProviderAgenda,
} from '../domain/online-slots';
import {
  durationFor,
  leadFor,
  type OnlineBookingSettings,
} from '../domain/online-booking-settings';
import type { BookableCatalog } from '../domain/ports/online-booking-repository.port';
import { OnlineChairService } from './online-chair.service';

/** Un profesional que la página puede ofrecer. */
export interface PublicProvider {
  id: string;
  fullName: string;
  /** Sedes en las que atiende (ya resueltas: nunca `null`). */
  locationIds: string[];
}

/** Lo ofrecible: sede activa con zona y horario, tipo y profesionales. */
export interface ResolvedChoice {
  location: BookableCatalog['locations'][number] & { timeZone: string };
  type: BookableCatalog['types'][number];
  providers: PublicProvider[];
}

export interface SlotsQuery {
  locationId: string;
  appointmentTypeId: string;
  /** `null` = cualquiera de los que ofrece el tipo en la sede. */
  providerId: string | null;
  patientKind: OnlineBookingPatientKind;
  /** Paciente ya identificado: sus citas también ocupan. */
  patientId: string | null;
  fromDay: string;
  days: number;
  now: Date;
}

export interface SlotsResult {
  timeZone: string;
  durationMinutes: number;
  slots: OnlineSlot[];
  truncated: boolean;
}

/**
 * DX-016: el ÚNICO cálculo de huecos de la reserva online. Lo usan la lista
 * de huecos de la página y la reserva (que exige que el inicio pedido salga
 * aquí antes de crear la cita con `CreateAppointmentUseCase`).
 */
@Injectable()
export class OnlineSlotService {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY)
    private readonly appointments: AppointmentRepository,
    @Inject(LOCATION_SCHEDULE_REPOSITORY)
    private readonly schedule: LocationScheduleRepository,
    @Inject(SCHEDULE_BLOCK_REPOSITORY)
    private readonly blocks: ScheduleBlockRepository,
    @Inject(STAFF_REPOSITORY)
    private readonly staff: StaffRepository,
    private readonly availability: ProviderAvailabilityService,
    // DX-583: en una sede con sillones, solo huecos con alguno libre.
    private readonly chairs: OnlineChairService,
  ) {}

  /** Profesionales activos con rol que atiende, con sus sedes resueltas. */
  async providers(activeLocationIds: string[]): Promise<PublicProvider[]> {
    const members = await this.staff.listActive();
    return members
      .filter((m) => ATTENDING_ROLES.includes(m.role))
      .map((m) => ({
        id: m.userId,
        fullName: m.fullName,
        locationIds: activeLocationIds.filter((id) => attendsAt(m, id)),
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'es'));
  }

  /** Los profesionales del tipo en la sede (todos si el tipo no acota). */
  providersFor(
    type: BookableCatalog['types'][number],
    locationId: string,
    providers: readonly PublicProvider[],
  ): PublicProvider[] {
    return providers.filter(
      (p) =>
        p.locationIds.includes(locationId) &&
        (type.providerIds.length === 0 || type.providerIds.includes(p.id)),
    );
  }

  /** ¿El tipo se ofrece en la sede? */
  offeredAt(
    type: BookableCatalog['types'][number],
    locationId: string,
  ): boolean {
    return (
      type.locationIds.length === 0 || type.locationIds.includes(locationId)
    );
  }

  /**
   * Sede, tipo y profesionales válidos para la página, o `null` (cualquier id
   * desconocido, de otra clínica, desactivado o no ofrecido: la misma
   * respuesta).
   */
  resolve(
    catalog: BookableCatalog,
    providers: readonly PublicProvider[],
    locationId: string,
    appointmentTypeId: string,
    providerId: string | null,
  ): ResolvedChoice | null {
    const location = catalog.locations.find((l) => l.id === locationId);
    if (!location?.timeZone || !isValidTimeZone(location.timeZone)) return null;
    const type = catalog.types.find(
      (t) => t.appointmentTypeId === appointmentTypeId,
    );
    if (!type || !this.offeredAt(type, locationId)) return null;
    const offered = this.providersFor(type, locationId, providers);
    const chosen =
      providerId === null
        ? offered
        : offered.filter((p) => p.id === providerId);
    if (chosen.length === 0) return null;
    return {
      location: { ...location, timeZone: location.timeZone },
      type,
      providers: chosen,
    };
  }

  async slots(
    settings: OnlineBookingSettings,
    choice: ResolvedChoice,
    query: SlotsQuery,
  ): Promise<SlotsResult> {
    const timeZone = choice.location.timeZone;
    const durationMinutes = durationFor(
      choice.type,
      choice.type,
      query.patientKind,
    );
    const empty = { timeZone, durationMinutes, slots: [], truncated: false };
    const window = clampOnlineDays(
      query.fromDay,
      query.days,
      timeZone,
      query.now,
      settings.maxAdvanceDays,
    );
    if (!window) return empty;
    const hours = await this.schedule.findByLocation(choice.location.id);
    // Sin horario configurado: la página no ofrece horas que nadie fijó.
    if (!hours || hours.ranges.length === 0) return empty;

    const range = civilRangeInZone(window.fromDay, window.toDay, timeZone);
    const { holidays } = await this.schedule.holidaysOf(choice.location.id);
    // Todos los bloqueos ocupan: también los que dejan agendar con aviso y
    // los huecos reservados (DX-446): la página no los ofrece nunca.
    const blocks = await this.blocks.list({
      from: range.start,
      to: range.end,
      locationId: choice.location.id,
    });

    const agendas: ProviderAgenda[] = [];
    for (const provider of choice.providers) {
      const busy = [
        ...(await this.appointments.findOverlapping(
          provider.id,
          range.start,
          range.end,
        )),
        ...blocks.filter((b) =>
          blockAffects(b, provider.id, choice.location.id),
        ),
      ].map((i) => ({ start: i.start, end: i.end }));
      const rangesOn = await this.availability.rangesByDay(
        provider.id,
        choice.location.id,
        window.fromDay,
        window.toDay,
      );
      agendas.push({ providerId: provider.id, busy, rangesOn });
    }
    const patientBusy = query.patientId
      ? (
          await this.appointments.findOverlappingForPatient(
            query.patientId,
            range.start,
            range.end,
          )
        ).map((i) => ({ start: i.start, end: i.end }))
      : [];

    const chairBusy = await this.chairs.busyByChair(
      choice.location.id,
      range.start,
      range.end,
    );

    const result = computeOnlineSlots({
      fromDay: window.fromDay,
      toDay: window.toDay,
      timeZone,
      ranges: hours.ranges,
      isClosedDay: (day) => holidayOn(day, holidays) !== null,
      providers: agendas,
      patientBusy,
      chairBusy,
      durationMinutes,
      stepMinutes: settings.slotStepMinutes,
      now: query.now,
      minLeadMinutes: leadFor(settings, query.patientKind),
      maxAdvanceDays: settings.maxAdvanceDays,
    });
    return { timeZone, durationMinutes, ...result };
  }
}
