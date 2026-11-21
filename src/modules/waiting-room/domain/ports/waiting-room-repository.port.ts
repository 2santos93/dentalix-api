import type { AppointmentStatus, WaitingRoomNameMode } from '@prisma/client';

/** DX-588: una pantalla de sala de espera (nunca con su token ni su hash). */
export interface WaitingRoomScreen {
  id: string;
  locationId: string;
  name: string;
  nameMode: WaitingRoomNameMode;
  messages: string[];
  soundEnabled: boolean;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWaitingRoomScreenRepoInput {
  locationId: string;
  name: string;
  tokenHash: string;
  nameMode: WaitingRoomNameMode;
  messages: string[];
  soundEnabled: boolean;
  createdById: string;
}

export interface UpdateWaitingRoomScreenRepoInput {
  name?: string;
  nameMode?: WaitingRoomNameMode;
  messages?: string[];
  soundEnabled?: boolean;
}

/** La pantalla de un token con lo que el tablero necesita de su sede. */
export interface ScreenForBoard extends WaitingRoomScreen {
  location: {
    id: string;
    name: string;
    timeZone: string | null;
    locale: string | null;
    hourCycle: string | null;
    /** Sede activa y sin borrar. */
    live: boolean;
  };
}

/**
 * Una persona del tablero, leída con SOLO lo que el tablero puede mostrar:
 * ni motivo, ni notas, ni tratamiento, ni teléfono, ni documento, ni importes.
 */
export interface BoardRow {
  appointmentId: string;
  status: AppointmentStatus;
  firstName: string | null;
  lastName: string | null;
  turnNumber: number | null;
  start: Date;
  arrivedAt: Date | null;
  seatedAt: Date | null;
  chairName: string | null;
  providerName: string | null;
}

export const WAITING_ROOM_REPOSITORY = Symbol('WAITING_ROOM_REPOSITORY');

export interface WaitingRoomRepository {
  /** Pantallas de la clínica (RLS), opcionalmente de una sede; vivas primero. */
  list(params: { locationIds?: string[] }): Promise<WaitingRoomScreen[]>;
  findById(id: string): Promise<WaitingRoomScreen | null>;
  create(input: CreateWaitingRoomScreenRepoInput): Promise<WaitingRoomScreen>;
  /** Solo si sigue sin revocar (condición y cambio en la misma sentencia); null si no. */
  update(
    id: string,
    patch: UpdateWaitingRoomScreenRepoInput,
    actorId: string,
  ): Promise<WaitingRoomScreen | null>;
  /** Revoca (idempotente: una revocada se devuelve tal cual). */
  revoke(id: string, actorId: string): Promise<WaitingRoomScreen | null>;
  /** La pantalla de un hash de token en la clínica del contexto (RLS). */
  findForBoardByTokenHash(tokenHash: string): Promise<ScreenForBoard | null>;
  /**
   * Quién está en la sala de espera o en el sillón en la sede, entre las
   * citas que empiezan en `[from, to)`.
   */
  boardRows(params: {
    locationId: string;
    from: Date;
    to: Date;
  }): Promise<BoardRow[]>;
}
