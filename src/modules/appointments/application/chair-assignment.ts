import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Chair } from '../../chairs/domain/entities/chair.entity';
import {
  chairAssignmentProblem,
  chairOverlapMessage,
} from '../../chairs/domain/chair-rules';
import {
  CHAIR_REPOSITORY,
  type ChairRepository,
} from '../../chairs/domain/ports/chair-repository.port';
import { LOCATION_REPOSITORY } from '../../locations/domain/ports/location-repository.port';
import type { LocationRepository } from '../../locations/domain/ports/location-repository.port';
import { regionalFormat } from '../../../shared/format/regional-format';
import { APPOINTMENT_REPOSITORY } from '../domain/ports/appointment-repository.port';
import { overlapConflict } from './appointment-overlap-error';
import type { AppointmentRepository } from '../domain/ports/appointment-repository.port';

/**
 * DX-211: el sillón de una cita al agendarla o moverla. Lo comparten
 * CreateAppointmentUseCase y UpdateAppointmentUseCase para que el pre-check y
 * el backstop de la EXCLUDE (appointments_no_overlap_per_chair) respondan
 * EXACTAMENTE lo mismo. Con la cita sin sillón no se llama: nada cambia.
 */
@Injectable()
export class ChairAssignmentService {
  constructor(
    @Inject(CHAIR_REPOSITORY) private readonly chairs: ChairRepository,
    @Inject(APPOINTMENT_REPOSITORY)
    private readonly appointments: AppointmentRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
  ) {}

  /**
   * El sillón, si la cita de la sede `locationId` puede llevarlo: 404 si no
   * es de esta clínica (RLS), 400 si es de otra sede o, con `requireActive`,
   * si está desactivado.
   */
  async load(
    chairId: string,
    opts: { locationId: string; requireActive: boolean },
  ): Promise<Chair> {
    const chair = await this.chairs.findById(chairId);
    const problem = chairAssignmentProblem(chair, opts);
    if (problem?.status === 404) throw new NotFoundException(problem.message);
    if (problem) throw new BadRequestException(problem.message);
    return chair!;
  }

  /**
   * 409 si otra cita viva y no cancelada ocupa el sillón en `[start, end)`.
   * DX-492-bis: al mover (`moving`), con el código y el ámbito de los demás
   * solapes, para que la web ofrezca el siguiente hueco.
   */
  async assertFree(
    chair: Chair,
    slot: { locationId: string; start: Date; end: Date; excludeId?: string },
    opts: { moving?: boolean } = {},
  ): Promise<void> {
    const [occupied] = await this.appointments.findOverlappingForChair(
      chair.id,
      slot.start,
      slot.end,
      slot.excludeId,
    );
    if (occupied) {
      throw conflict(
        await this.message(chair.name, slot.locationId, occupied),
        opts,
      );
    }
  }

  /**
   * El 409 cuando la BD resolvió una carrera (23P01 de la EXCLUDE): ya con la
   * otra cita escrita, se busca para dar sus horas; si no aparece, sin horas.
   */
  async raceConflict(
    chairId: string,
    slot: { start: Date; end: Date; excludeId?: string },
    opts: { moving?: boolean } = {},
  ): Promise<ConflictException> {
    const chair = await this.chairs.findById(chairId);
    const name = chair?.name ?? '';
    const [occupied] = await this.appointments.findOverlappingForChair(
      chairId,
      slot.start,
      slot.end,
      slot.excludeId,
    );
    if (!chair || !occupied) {
      return conflict(chairOverlapMessage(name, null), opts);
    }
    return conflict(await this.message(name, chair.locationId, occupied), opts);
  }

  /**
   * Horas en la zona y el formato (locale y reloj) de la sede, con el helper
   * regional. Una sede sin esos datos (réplica anterior a G1 aún sin barrer)
   * no se rellena con ningunos: el mensaje va sin horas.
   */
  private async message(
    chairName: string,
    locationId: string,
    occupied: { start: Date; end: Date },
  ): Promise<string> {
    const location = await this.locations.findById(locationId);
    const hourCycle = location?.hourCycle;
    if (
      !location?.timeZone ||
      !location.locale ||
      (hourCycle !== 'h12' && hourCycle !== 'h23')
    ) {
      return chairOverlapMessage(chairName, null);
    }
    const fmt = regionalFormat({ locale: location.locale, hourCycle });
    return chairOverlapMessage(chairName, {
      from: fmt.time(occupied.start, location.timeZone),
      to: fmt.time(occupied.end, location.timeZone),
    });
  }
}

/** El 409 del sillón: al mover, con código y ámbito; si no, solo el mensaje. */
function conflict(
  message: string,
  opts: { moving?: boolean },
): ConflictException {
  return opts.moving
    ? overlapConflict('chair', message)
    : new ConflictException(message);
}
