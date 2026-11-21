import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AppointmentStatus, WaitingRoomNameMode } from '@prisma/client';
import {
  hashPublicLinkToken,
  isWellFormedPublicLinkToken,
} from '../../../shared/public-links/public-link-token';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  civilDateIn,
  civilDayRange,
  isValidTimeZone,
} from '../../../shared/time/civil-day';
import { requireLocationFormat } from '../../../shared/locations/location-regional';
import type { HourCycle } from '../../../shared/format/regional-format';
import { minutesSince } from '../../appointments/domain/patient-flow';
import {
  BOARD_COLUMN_LIMIT,
  BOARD_REFRESH_SECONDS,
  WAITING_ROOM_SCREEN_INACTIVE_CODE,
  WAITING_ROOM_SCREEN_INACTIVE_MESSAGE,
  boardKey,
  displayLabel,
} from '../domain/waiting-room';
import {
  WAITING_ROOM_REPOSITORY,
  type BoardRow,
  type WaitingRoomRepository,
} from '../domain/ports/waiting-room-repository.port';

/** Alguien en la sala de espera. LISTA BLANCA: no añadir campos sin DX. */
export interface PublicWaitingItem {
  key: string;
  label: string;
  minutesWaiting: number;
}

/** Alguien que pasó al sillón. LISTA BLANCA: no añadir campos sin DX. */
export interface PublicCalledItem {
  key: string;
  label: string;
  chairName: string | null;
  providerName: string | null;
  minutesSinceCalled: number;
}

/** El tablero del televisor. LISTA BLANCA (test que serializa la respuesta). */
export interface PublicWaitingRoomBoard {
  screenName: string;
  locationName: string;
  nameMode: WaitingRoomNameMode;
  messages: string[];
  soundEnabled: boolean;
  timeZone: string;
  locale: string;
  hourCycle: HourCycle;
  now: Date;
  refreshSeconds: number;
  waiting: PublicWaitingItem[];
  waitingTotal: number;
  called: PublicCalledItem[];
  calledTotal: number;
}

export const WAITING_ROOM_CLOCK = Symbol('WAITING_ROOM_CLOCK');
export type WaitingRoomClock = () => Date;

/** El MISMO 404 para todo lo que no sea una pantalla activa. */
export function inactiveScreen(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    code: WAITING_ROOM_SCREEN_INACTIVE_CODE,
    message: WAITING_ROOM_SCREEN_INACTIVE_MESSAGE,
  });
}

const arrivedOf = (r: BoardRow) => (r.arrivedAt ?? r.start).getTime();
const seatedOf = (r: BoardRow) =>
  (r.seatedAt ?? r.arrivedAt ?? r.start).getTime();

/**
 * DX-588: el tablero público del televisor de la sala de espera, sin sesión.
 * El tenant sale SOLO del host (PublicTenantContextInterceptor); el token
 * solo da la sede de SU pantalla. Token mal formado, desconocido, de otra
 * clínica (RLS), revocado, o de una sede retirada o sin zona: el MISMO 404,
 * comprobado en cada petición (revocar corta en la siguiente).
 *
 * Lo que sale es una lista blanca campo a campo: nombre visible («Ana R.») o
 * turno («Turno 7», sin nombre), estado (columna), sillón y profesional al
 * pasar, y minutos. Nunca motivo, tratamiento, teléfono, documento, importes
 * ni ids internos (la `key` es un HMAC con el id de la pantalla).
 */
@Injectable()
export class PublicWaitingRoomUseCases {
  constructor(
    @Inject(WAITING_ROOM_REPOSITORY)
    private readonly repo: WaitingRoomRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(WAITING_ROOM_CLOCK) private readonly clock: WaitingRoomClock,
  ) {}

  async board(token: string): Promise<PublicWaitingRoomBoard> {
    if (!isWellFormedPublicLinkToken(token)) throw inactiveScreen();
    // Host desconocido: sin tenant no hay RLS que consultar.
    if (!this.tenantContext.getTenantId()) throw inactiveScreen();
    const screen = await this.repo.findForBoardByTokenHash(
      hashPublicLinkToken(token),
    );
    if (!screen || screen.revokedAt !== null || !screen.location.live) {
      throw inactiveScreen();
    }
    const { location } = screen;
    const timeZone = location.timeZone;
    if (!timeZone || !isValidTimeZone(timeZone)) throw inactiveScreen();
    let format: ReturnType<typeof requireLocationFormat>;
    try {
      format = requireLocationFormat(location);
    } catch {
      throw inactiveScreen();
    }

    const now = this.clock();
    const range = civilDayRange(civilDateIn(now, timeZone), timeZone);
    const rows = await this.repo.boardRows({
      locationId: location.id,
      from: range.start,
      to: range.end,
    });
    const label = (r: BoardRow) =>
      displayLabel(screen.nameMode, {
        firstName: r.firstName,
        lastName: r.lastName,
        turnNumber: r.turnNumber,
      });

    // En espera: por orden de llegada (a igualdad, por hora de la cita).
    const waitingRows = rows
      .filter((r) => r.status === AppointmentStatus.ARRIVED)
      .sort(
        (a, b) =>
          arrivedOf(a) - arrivedOf(b) || a.start.getTime() - b.start.getTime(),
      );
    // Pasando a consulta: quien acaba de pasar, arriba.
    const calledRows = rows
      .filter((r) => r.status === AppointmentStatus.IN_CHAIR)
      .sort(
        (a, b) =>
          seatedOf(b) - seatedOf(a) || a.start.getTime() - b.start.getTime(),
      );

    return {
      screenName: screen.name,
      locationName: location.name,
      nameMode: screen.nameMode,
      messages: [...screen.messages],
      soundEnabled: screen.soundEnabled,
      timeZone,
      locale: format.locale,
      hourCycle: format.hourCycle,
      now,
      refreshSeconds: BOARD_REFRESH_SECONDS,
      waiting: waitingRows.slice(0, BOARD_COLUMN_LIMIT).map((r) => ({
        key: boardKey(screen.id, r.appointmentId),
        label: label(r),
        minutesWaiting: minutesSince(new Date(arrivedOf(r)), now),
      })),
      waitingTotal: waitingRows.length,
      called: calledRows.slice(0, BOARD_COLUMN_LIMIT).map((r) => ({
        key: boardKey(screen.id, r.appointmentId),
        label: label(r),
        chairName: r.chairName,
        providerName: r.providerName,
        minutesSinceCalled: minutesSince(new Date(seatedOf(r)), now),
      })),
      calledTotal: calledRows.length,
    };
  }
}
