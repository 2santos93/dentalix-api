import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { LOCATION_SCHEDULE_REPOSITORY } from '../../domain/ports/location-schedule-repository.port';
import type {
  LocationScheduleRepository,
  ReplaceScheduleInput,
} from '../../domain/ports/location-schedule-repository.port';
import { BusinessHours, ScheduleRange } from '../business-hours';

/** Devuelve el horario de la sede en contexto (null = sin configurar). */
@Injectable()
export class GetLocationScheduleUseCase {
  constructor(
    @Inject(LOCATION_SCHEDULE_REPOSITORY)
    private readonly repo: LocationScheduleRepository,
  ) {}

  execute(): Promise<BusinessHours | null> {
    return this.repo.findForCurrentLocation();
  }
}

@Injectable()
export class ReplaceLocationScheduleUseCase {
  constructor(
    @Inject(LOCATION_SCHEDULE_REPOSITORY)
    private readonly repo: LocationScheduleRepository,
  ) {}

  /**
   * La zona ya no se edita aquí: es un dato de la sede (G1, R4). Una web
   * antigua que aún la envía la pasa como `legacyTimeZone` (R15).
   */
  async execute(input: ReplaceScheduleInput): Promise<BusinessHours> {
    for (const range of input.ranges) {
      if (
        !Number.isInteger(range.weekday) ||
        range.weekday < 0 ||
        range.weekday > 6
      ) {
        throw new BadRequestException(
          'weekday debe ser un entero de 0 (domingo) a 6 (sábado)',
        );
      }
      if (
        !Number.isInteger(range.startMinute) ||
        !Number.isInteger(range.endMinute) ||
        range.startMinute < 0 ||
        range.endMinute > 1440
      ) {
        throw new BadRequestException(
          'startMinute/endMinute deben ser enteros entre 0 y 1440',
        );
      }
      if (range.endMinute <= range.startMinute) {
        throw new BadRequestException(
          'El fin de un tramo debe ser posterior a su inicio',
        );
      }
    }

    // Sin tramos solapados en el mismo día: dos tramos que se pisan no
    // significan nada distinto de uno más largo, y hacen ambiguo el mensaje de
    // "horario del día" que se le muestra al usuario.
    if (hasOverlappingRanges(input.ranges)) {
      throw new BadRequestException(
        'Hay tramos solapados en el mismo día; únelos en uno',
      );
    }

    return this.repo.replaceForCurrentLocation({
      ranges: input.ranges,
      legacyTimeZone: input.legacyTimeZone,
    });
  }
}

function hasOverlappingRanges(ranges: ScheduleRange[]): boolean {
  for (let weekday = 0; weekday <= 6; weekday++) {
    const day = ranges
      .filter((r) => r.weekday === weekday)
      .sort((a, b) => a.startMinute - b.startMinute);
    for (let i = 1; i < day.length; i++) {
      // Medio-abierto: que un tramo empiece justo donde acaba el anterior NO es
      // solape (son contiguos), igual que con las citas.
      if (day[i].startMinute < day[i - 1].endMinute) {
        return true;
      }
    }
  }
  return false;
}
