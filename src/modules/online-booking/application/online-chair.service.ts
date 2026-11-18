import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  APPOINTMENT_REPOSITORY,
  type AppointmentRepository,
} from '../../appointments/domain/ports/appointment-repository.port';
import type { Interval } from '../../appointments/domain/openings';
import {
  CHAIR_REPOSITORY,
  type ChairRepository,
} from '../../chairs/domain/ports/chair-repository.port';
import {
  chooseFreeChair,
  type FreeChairChoice,
} from '../../chairs/domain/chair-rules';

/** Intentos ante una carrera por el sillón (como DX-480). */
export const ONLINE_CHAIR_RACE_ATTEMPTS = 3;

/**
 * DX-583: el sillón de la reserva online, con la regla de DX-480
 * (`chooseFreeChair`): sede sin sillones activos → sin sillón (como antes);
 * si no, el primer sillón activo libre en el orden de la agenda; todos
 * ocupados → no hay hueco. «Ocupado» es lo mismo que la EXCLUDE
 * `appointments_no_overlap_per_chair` (`findOverlappingForChair`: vivas no
 * canceladas, también sobrecupos).
 */
@Injectable()
export class OnlineChairService {
  constructor(
    @Inject(CHAIR_REPOSITORY) private readonly chairs: ChairRepository,
    @Inject(APPOINTMENT_REPOSITORY)
    private readonly appointments: AppointmentRepository,
  ) {}

  /**
   * Lo ocupado de cada sillón activo de la sede en `[start, end)`, en el orden
   * de la agenda. Lista vacía = la sede no tiene sillones activos.
   */
  async busyByChair(
    locationId: string,
    start: Date,
    end: Date,
  ): Promise<Interval[][]> {
    const chairs = await this.chairs.listByLocation({
      locationId,
      includeInactive: false,
    });
    const out: Interval[][] = [];
    for (const chair of chairs) {
      out.push(
        (
          await this.appointments.findOverlappingForChair(chair.id, start, end)
        ).map((a) => ({ start: a.start, end: a.end })),
      );
    }
    return out;
  }

  /** El sillón para una cita de la sede en `[start, end)`. */
  async choose(
    locationId: string,
    start: Date,
    end: Date,
  ): Promise<FreeChairChoice> {
    const chairs = await this.chairs.listByLocation({
      locationId,
      includeInactive: false,
    });
    const busy: string[] = [];
    for (const chair of chairs) {
      const [occupied] = await this.appointments.findOverlappingForChair(
        chair.id,
        start,
        end,
      );
      if (occupied) busy.push(chair.id);
    }
    return chooseFreeChair(chairs, busy);
  }

  /**
   * Crea la cita con el sillón elegido justo antes (`create` recibe su id, o
   * `undefined` en una sede sin sillones). El alta valida el sillón y la
   * EXCLUDE decide la carrera; si el alta da 409 y al volver a elegir sale
   * OTRO sillón (el anterior lo ganó otra cita a la vez), se reintenta con
   * él. Si sale el mismo, el 409 era por otra causa (profesional, paciente):
   * se relanza. Sin sillón libre, `noFreeChair()`.
   */
  async withFreeChair<T>(
    slot: { locationId: string; start: Date; end: Date },
    create: (chairId: string | undefined) => Promise<T>,
    noFreeChair: () => Error,
  ): Promise<T> {
    let lastChairId: string | null = null;
    let lastError: ConflictException | null = null;
    for (let attempt = 1; attempt <= ONLINE_CHAIR_RACE_ATTEMPTS; attempt++) {
      const choice = await this.choose(slot.locationId, slot.start, slot.end);
      if (choice.kind === 'ALL_BUSY') throw noFreeChair();
      const chairId = choice.kind === 'CHAIR' ? choice.chairId : undefined;
      if (lastError !== null && chairId === lastChairId) throw lastError;
      try {
        return await create(chairId);
      } catch (error) {
        if (chairId === undefined || !(error instanceof ConflictException)) {
          throw error;
        }
        lastChairId = chairId;
        lastError = error;
      }
    }
    // Solo se llega tras ONLINE_CHAIR_RACE_ATTEMPTS carreras seguidas.
    throw lastError ?? noFreeChair();
  }
}
