import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LOCATION_REPOSITORY,
  type LocationRepository,
} from '../../locations/domain/ports/location-repository.port';
import { civilDateIn, civilWeekday } from '../../../shared/time/civil-day';
import {
  PROVIDER_SCHEDULE_REPOSITORY,
  type ProviderScheduleRepository,
} from '../domain/ports/provider-schedule-repository.port';
import {
  describeRanges,
  providerRangesOn,
  providerWorksAt,
  weekdayName,
  type MinuteRange,
} from '../domain/provider-availability';

/** Código del aviso de una cita fuera del horario del profesional. */
export const PROVIDER_OFF_SCHEDULE = 'PROVIDER_OFF_SCHEDULE';

export const PROVIDER_OFF_SCHEDULE_STRICT_SUFFIX =
  'La clínica no permite citar fuera del horario del profesional.';

export interface ProviderSlotCheck {
  providerId: string;
  /** Sede de la cita; sin ella, la sede EN CONTEXTO (como el repo de citas). */
  locationId?: string;
  start: Date;
  end: Date;
}

/** Un aviso que no impide agendar, con su código para la web. */
export interface ScheduleWarning {
  code: typeof PROVIDER_OFF_SCHEDULE;
  message: string;
}

function dayMonth(day: string): string {
  const [, m, d] = day.split('-');
  return `${d}/${m}`;
}

/**
 * Regla `providerWorksAt` contra la BD (DX-233), para la agenda, «Buscar
 * hueco» y «Ocupar este hueco». Exportada por ProviderScheduleModule.
 */
@Injectable()
export class ProviderAvailabilityService {
  constructor(
    @Inject(PROVIDER_SCHEDULE_REPOSITORY)
    private readonly repo: ProviderScheduleRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
  ) {}

  /**
   * Agendar o mover una cita: si cae fuera del horario del profesional en la
   * sede, devuelve el aviso (por defecto) o lanza 409 (modo estricto de la
   * clínica). Dentro del horario o sin horario configurado, `null`.
   */
  async warnOrReject(slot: ProviderSlotCheck): Promise<ScheduleWarning | null> {
    const message = await this.offScheduleMessage(slot);
    if (message === null) return null;
    if (await this.repo.getStrict()) {
      throw new ConflictException(
        `${message} ${PROVIDER_OFF_SCHEDULE_STRICT_SUFFIX}`,
      );
    }
    return { code: PROVIDER_OFF_SCHEDULE, message };
  }

  /** Mensaje en español si la cita cae fuera de horario; si no, `null`. */
  async offScheduleMessage(slot: ProviderSlotCheck): Promise<string | null> {
    const locationId =
      slot.locationId ?? (await this.repo.resolveCurrentLocationId());
    const location = await this.locations.findById(locationId);
    if (!location) throw new NotFoundException('Sede no encontrada');
    const day = civilDateIn(slot.start, location.timeZone);
    const snapshot = (
      await this.repo.findSnapshots([slot.providerId], { from: day, to: day })
    ).get(slot.providerId)!;
    if (
      providerWorksAt(
        snapshot,
        locationId,
        slot.start,
        slot.end,
        location.timeZone,
      )
    ) {
      return null;
    }
    const ranges = providerRangesOn(snapshot, locationId, day) ?? [];
    const weekday = weekdayName(civilWeekday(day));
    return ranges.length === 0
      ? `Fuera del horario del profesional: no trabaja en ${location.name} el ${weekday} ${dayMonth(day)}.`
      : `Fuera del horario del profesional en ${location.name} (${weekday} ${dayMonth(day)}: ${describeRanges(ranges)}).`;
  }

  /**
   * «Buscar hueco»: los tramos del profesional en la sede para cada día del
   * período (`null` = ese día sin restricción).
   */
  async rangesByDay(
    providerId: string,
    locationId: string,
    from: string,
    to: string,
  ): Promise<(day: string) => MinuteRange[] | null> {
    const snapshot = (
      await this.repo.findSnapshots([providerId], { from, to })
    ).get(providerId)!;
    return (day) => providerRangesOn(snapshot, locationId, day);
  }

  /**
   * «Ocupar este hueco»: predicado «¿este profesional atiende `[start, end)`
   * en la sede?» para varios profesionales de una vez (una consulta).
   */
  async attendancePredicate(
    providerIds: readonly string[],
    locationId: string,
    timeZone: string,
    from: string,
    to: string,
  ): Promise<(providerId: string, start: Date, end: Date) => boolean> {
    const snapshots = await this.repo.findSnapshots(providerIds, { from, to });
    return (providerId, start, end) => {
      const snapshot = snapshots.get(providerId);
      return snapshot
        ? providerWorksAt(snapshot, locationId, start, end, timeZone)
        : true;
    };
  }
}
