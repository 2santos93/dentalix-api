import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { APPOINTMENT_REPOSITORY } from '../../domain/ports/appointment-repository.port';
import type { AppointmentRepository } from '../../domain/ports/appointment-repository.port';
import {
  MAX_OPENINGS_RANGE_DAYS,
  findOpenings,
  mergeChairOpenings,
  type ChairOpening,
  type Interval,
  type Opening,
} from '../../domain/openings';
import { ChairAssignmentService } from '../chair-assignment';
import type { ChairSummary } from '../../../chairs/domain/entities/chair.entity';
import { LOCATION_SCHEDULE_REPOSITORY } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import type { LocationScheduleRepository } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import { SCHEDULE_BLOCK_REPOSITORY } from '../../../schedule-blocks/domain/ports/schedule-block-repository.port';
import type { ScheduleBlockRepository } from '../../../schedule-blocks/domain/ports/schedule-block-repository.port';
import {
  ATTENDING_ROLES,
  NOT_ATTENDING_MESSAGE,
  blockAffects,
} from '../../../schedule-blocks/domain/schedule-block-rules';
import { LOCATION_REPOSITORY } from '../../../locations/domain/ports/location-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import { STAFF_REPOSITORY } from '../../../staff/domain/ports/staff-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { ProviderAvailabilityService } from '../../../provider-schedule/application/provider-availability.service';
import { DEFAULT_BUSINESS_HOURS } from '../../../../shared/locations/default-business-hours';
import { requireLocationTimeZone } from '../../../../shared/locations/location-time-zone';
import {
  civilDaysInclusive,
  civilRangeInZone,
  parseCivilDate,
} from '../../../../shared/time/civil-day';
import { assertAttendsAt } from '../../../staff/domain/provider-location';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

export interface FindOpeningsInput {
  providerId: string;
  locationId: string;
  /** Días civiles (YYYY-MM-DD) en la zona de la sede, ambos incluidos. */
  from: string;
  to: string;
  durationMinutes: number;
  /** Opcional: las otras citas del paciente también ocupan. */
  patientId?: string;
  /** DX-509-bis: la cita que se mueve no ocupa su propia hora. */
  excludeAppointmentId?: string;
  /** DX-492: el hueco tiene que tener libre alguno de estos sillones. */
  chairIds?: string[];
}

export interface OpeningsView {
  timeZone: string;
  durationMinutes: number;
  openings: (Opening | ChairOpening<ChairSummary>)[];
  truncated: boolean;
  /**
   * DX-533: la sede no tiene horario y se buscó dentro del de alta
   * (`DEFAULT_BUSINESS_HOURS`). La agenda sigue aceptando cualquier hora; la
   * interfaz lo dice para que «no hay huecos a las 23:30» no parezca un fallo.
   */
  defaultHours: boolean;
}

/**
 * «Buscar hueco» (DX-122): huecos libres de un profesional en una sede, dentro
 * del horario de la sede y del horario del profesional en ESA sede (DX-233:
 * sin horario configurado, sin restricción; la excepción de la fecha
 * prevalece), fuera de bloqueos (también de los que dejan agendar:
 * un hueco propuesto no debería caer en el almuerzo) y sin solape con sus
 * citas (de cualquier sede) ni, si se indica, con las del paciente. Con
 * `chairIds` (DX-492), además libres de alguno de esos sillones de la sede,
 * también de sobrecupos: son los que ocupan el sillón en la EXCLUDE.
 */
@Injectable()
export class FindOpeningsUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY)
    private readonly appointments: AppointmentRepository,
    @Inject(LOCATION_SCHEDULE_REPOSITORY)
    private readonly schedule: LocationScheduleRepository,
    @Inject(SCHEDULE_BLOCK_REPOSITORY)
    private readonly blocks: ScheduleBlockRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(STAFF_REPOSITORY)
    private readonly staff: StaffRepository,
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
    private readonly tenantContext: TenantContextService,
    // DX-233: solo donde el profesional trabaja en esa sede.
    private readonly availability: ProviderAvailabilityService,
    private readonly chairs: ChairAssignmentService,
  ) {}

  async execute(input: FindOpeningsInput): Promise<OpeningsView> {
    if (
      parseCivilDate(input.from) === null ||
      parseCivilDate(input.to) === null
    ) {
      throw new BadRequestException(
        'Las fechas tienen que ser días reales en formato AAAA-MM-DD',
      );
    }
    const days = civilDaysInclusive(input.from, input.to);
    if (days < 1) {
      throw new BadRequestException(
        'La fecha final no puede ser anterior a la inicial',
      );
    }
    if (days > MAX_OPENINGS_RANGE_DAYS) {
      throw new BadRequestException(
        `Busca huecos de como mucho ${MAX_OPENINGS_RANGE_DAYS} días a la vez`,
      );
    }

    this.tenantContext.assertLocationAllowed(input.locationId);
    const location = await this.locations.findById(input.locationId);
    if (!location) throw new NotFoundException('Sede no encontrada');
    const provider = await this.staff.findById(input.providerId);
    if (!provider) throw new NotFoundException('Profesional no encontrado');
    if (!ATTENDING_ROLES.includes(provider.role)) {
      throw new BadRequestException(NOT_ATTENDING_MESSAGE);
    }
    assertAttendsAt(provider, input.locationId);
    if (input.patientId && !(await this.patients.findById(input.patientId))) {
      throw new NotFoundException('Paciente no encontrado');
    }
    // DX-509-bis: la cita que se mueve tiene que ser de esta clínica (como
    // el resto de ids de la consulta).
    if (
      input.excludeAppointmentId &&
      !(await this.appointments.findById(input.excludeAppointmentId))
    ) {
      throw new NotFoundException('Cita no encontrada');
    }

    const chairs = [];
    for (const chairId of new Set(input.chairIds)) {
      chairs.push(
        await this.chairs.load(chairId, {
          locationId: input.locationId,
          requireActive: true,
        }),
      );
    }

    // Sin horario configurado la agenda no se restringe, pero proponer huecos
    // a las 3 de la mañana no ayuda: se usa el horario por defecto del alta.
    const hours = await this.schedule.findByLocation(input.locationId);
    // G1 (R4): la zona es la de la sede, tenga o no horario.
    const timeZone = requireLocationTimeZone(location);
    const defaultHours = !hours || hours.ranges.length === 0;
    const ranges = defaultHours ? DEFAULT_BUSINESS_HOURS : hours.ranges;
    const range = civilRangeInZone(input.from, input.to, timeZone);

    const busy: Interval[] = [
      ...(await this.appointments.findOverlapping(
        input.providerId,
        range.start,
        range.end,
        input.excludeAppointmentId,
      )),
      ...(input.patientId
        ? await this.appointments.findOverlappingForPatient(
            input.patientId,
            range.start,
            range.end,
            input.excludeAppointmentId,
          )
        : []),
      ...(
        await this.blocks.list({
          from: range.start,
          to: range.end,
          locationId: input.locationId,
        })
      ).filter((b) => blockAffects(b, input.providerId, input.locationId)),
    ].map((i) => ({ start: i.start, end: i.end }));

    const providerRangesOn = await this.availability.rangesByDay(
      input.providerId,
      input.locationId,
      input.from,
      input.to,
    );

    const now = new Date();
    const openingsWith = (extraBusy: readonly Interval[]) =>
      findOpenings({
        fromDay: input.from,
        toDay: input.to,
        timeZone,
        ranges,
        busy: [...busy, ...extraBusy],
        durationMinutes: input.durationMinutes,
        now,
        providerRangesOn,
      });

    if (chairs.length === 0) {
      return {
        timeZone,
        durationMinutes: input.durationMinutes,
        defaultHours,
        ...openingsWith([]),
      };
    }
    const perChair = [];
    for (const chair of chairs) {
      const occupied = await this.appointments.findOverlappingForChair(
        chair.id,
        range.start,
        range.end,
        input.excludeAppointmentId,
      );
      perChair.push({
        chair: { id: chair.id, name: chair.name, active: chair.active },
        result: openingsWith(occupied),
      });
    }
    return {
      timeZone,
      durationMinutes: input.durationMinutes,
      defaultHours,
      ...mergeChairOpenings(perChair),
    };
  }
}
