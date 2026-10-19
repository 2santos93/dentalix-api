import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus, ClinicRole } from '@prisma/client';
import { APPOINTMENT_REPOSITORY } from '../../domain/ports/appointment-repository.port';
import type {
  AppointmentRepository,
  InClinicAppointment,
} from '../../domain/ports/appointment-repository.port';
import { LOCATION_REPOSITORY } from '../../../locations/domain/ports/location-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import {
  civilDateIn,
  civilDayRange,
  parseCivilDate,
} from '../../../../shared/time/civil-day';
import {
  arrivalPunctuality,
  minutesSince,
  type InClinicStatus,
  type Punctuality,
} from '../../domain/patient-flow';

export const IN_CLINIC_NO_LOCATION_MESSAGE =
  'Elige una sede para ver quién está en la clínica.';

export interface ListInClinicInput {
  /** Sede del request (X-Location-Id, ya validada contra la clínica). */
  locationId: string | undefined;
  /** Día civil YYYY-MM-DD en la zona de la sede; por defecto, hoy allí. */
  date?: string;
  role: ClinicRole | null;
  userId: string;
}

/** Una persona del panel: nombre y horas, nada clínico (ni motivo ni notas). */
export interface InClinicItem {
  appointmentId: string;
  patientId: string;
  patientFirstName: string | null;
  patientLastName: string | null;
  providerId: string;
  providerName: string | null;
  start: Date;
  end: Date;
  status: InClinicStatus;
  arrivedAt: Date | null;
  seatedAt: Date | null;
  readyForCheckoutAt: Date | null;
  /** Minutos en el grupo actual: esperando, en el sillón o por cobrar. */
  minutesInStatus: number;
  /** Minutos que esperó (o lleva esperando) desde la llegada hasta el sillón. */
  waitedMinutes: number;
  /** Color del chip: llegó a la hora (verde), hasta 5 min tarde, o después. */
  punctuality: Punctuality;
}

export interface InClinicView {
  date: string;
  locationId: string;
  timeZone: string;
  /** Reloj del servidor con el que se calcularon los minutos. */
  now: Date;
  /** MINE: solo los pacientes del odontólogo («Te esperan»); LOCATION: la sede. */
  scope: 'MINE' | 'LOCATION';
  waiting: InClinicItem[];
  inChair: InClinicItem[];
  readyForCheckout: InClinicItem[];
}

/** Cuándo entró en el grupo en el que está. */
function enteredAt(a: InClinicAppointment): Date {
  if (a.status === AppointmentStatus.READY_FOR_CHECKOUT) {
    return a.readyForCheckoutAt ?? a.start;
  }
  if (a.status === AppointmentStatus.IN_CHAIR) return a.seatedAt ?? a.start;
  return a.arrivedAt ?? a.start;
}

function toItem(a: InClinicAppointment, now: Date): InClinicItem {
  const arrived = a.arrivedAt ?? a.start;
  return {
    appointmentId: a.id,
    patientId: a.patientId,
    patientFirstName: a.patientFirstName,
    patientLastName: a.patientLastName,
    providerId: a.providerId,
    providerName: a.providerName,
    start: a.start,
    end: a.end,
    status: a.status as InClinicStatus,
    arrivedAt: a.arrivedAt,
    seatedAt: a.seatedAt,
    readyForCheckoutAt: a.readyForCheckoutAt,
    minutesInStatus: minutesSince(enteredAt(a), now),
    waitedMinutes: minutesSince(arrived, a.seatedAt ?? now),
    punctuality: arrivalPunctuality(a.start, arrived),
  };
}

/** Quien más lleva en su grupo, primero (a igualdad, por hora de la cita). */
function byEntered(a: InClinicAppointment, b: InClinicAppointment): number {
  return (
    enteredAt(a).getTime() - enteredAt(b).getTime() ||
    a.start.getTime() - b.start.getTime()
  );
}

/**
 * Panel «En clínica» (DX-200): quién está en la sala de espera, en el sillón
 * y listo para cobrar en la sede del request, un día civil en SU zona. Los
 * minutos salen del reloj del servidor. Un DENTIST ve solo sus pacientes;
 * recepción, asistentes y administración, toda la sede.
 */
@Injectable()
export class ListInClinicUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY)
    private readonly repo: AppointmentRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
  ) {}

  async execute(
    input: ListInClinicInput,
    now: Date = new Date(),
  ): Promise<InClinicView> {
    if (!input.locationId) {
      throw new BadRequestException(IN_CLINIC_NO_LOCATION_MESSAGE);
    }
    let day: string | null = null;
    if (input.date !== undefined) {
      day = parseCivilDate(input.date);
      if (day === null) {
        throw new BadRequestException(
          'La fecha tiene que ser un día real en formato AAAA-MM-DD',
        );
      }
    }
    const location = await this.locations.findById(input.locationId);
    if (!location) throw new NotFoundException('Sede no encontrada');
    const timeZone = location.timeZone;
    const date = day ?? civilDateIn(now, timeZone);
    const range = civilDayRange(date, timeZone);
    const mine = input.role === ClinicRole.DENTIST;

    const rows = await this.repo.listInClinic({
      locationId: location.id,
      from: range.start,
      to: range.end,
      ...(mine ? { providerId: input.userId } : {}),
    });
    const items = [...rows].sort(byEntered).map((r) => toItem(r, now));
    const group = (status: InClinicStatus) =>
      items.filter((i) => i.status === status);

    return {
      date,
      locationId: location.id,
      timeZone,
      now,
      scope: mine ? 'MINE' : 'LOCATION',
      waiting: group(AppointmentStatus.ARRIVED),
      inChair: group(AppointmentStatus.IN_CHAIR),
      readyForCheckout: group(AppointmentStatus.READY_FOR_CHECKOUT),
    };
  }
}
