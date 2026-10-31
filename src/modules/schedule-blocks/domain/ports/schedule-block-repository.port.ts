import type { ScheduleBlockKind } from '@prisma/client';
import type {
  AffectedAppointment,
  ReservedTypeRef,
  ScheduleBlock,
} from '../entities/schedule-block.entity';

export const SCHEDULE_BLOCK_REPOSITORY = Symbol('SCHEDULE_BLOCK_REPOSITORY');

export interface ListScheduleBlocksParams {
  /** Bloqueos que se solapan con `[from, to)`. */
  from: Date;
  to: Date;
  /**
   * Sede: sus bloqueos de sede y los de profesional en esa sede o en todas.
   * Sin ella, la sede del request (`X-Location-Id`) o, en la vista
   * consolidada, todos.
   */
  locationId?: string;
  /** Solo los bloqueos de estos profesionales (y los de toda la sede). */
  providerIds?: string[];
}

/** Lo que define a quién bloquea un bloqueo: profesional y/o sede. */
export interface ScheduleBlockScope {
  providerId: string | null;
  locationId: string | null;
}

export interface CreateScheduleBlockRepoInput extends ScheduleBlockScope {
  start: Date;
  end: Date;
  kind: ScheduleBlockKind;
  allowsBooking: boolean;
  note: string | null;
  /** DX-446: solo en `RESERVED`; por defecto, `[]` y `null`. */
  reservedForTypeIds?: string[];
  releaseAtMinute?: number | null;
  createdById: string;
}

export interface UpdateScheduleBlockRepoInput {
  start?: Date;
  end?: Date;
  kind?: ScheduleBlockKind;
  allowsBooking?: boolean;
  note?: string | null;
  reservedForTypeIds?: string[];
  releaseAtMinute?: number | null;
  updatedById: string;
}

export interface AffectingBlocksQuery {
  providerId: string;
  start: Date;
  end: Date;
  /** Sede de la cita; sin ella, la del request o la sede por defecto. */
  locationId?: string;
}

/**
 * Bloqueos que tocan una cita, con la zona, el formato y el reloj de su sede
 * para redactar mensajes. Formato y reloj en crudo (G1-B, I4): solo quien
 * pinta un mensaje pide el formato, así que una sede sin reloj no bloquea
 * agendar donde no hay ningún bloqueo.
 */
export interface AffectingBlocks {
  locationId: string;
  timeZone: string;
  locale: string | null;
  hourCycle: string | null;
  blocks: ScheduleBlock[];
  /** DX-446: los tipos que nombran los bloques `RESERVED` de `blocks`. */
  reservedTypes: ReservedTypeRef[];
}

/** DX-446: tipos reservados y zona de las sedes de unos bloques. */
export interface ReservedContext {
  /** Tipos vivos (activos o no) de ESTA clínica entre los pedidos (RLS). */
  types: ReservedTypeRef[];
  /** Zona IANA válida de cada sede pedida que la tenga. */
  timeZones: ReadonlyMap<string, string>;
}

export interface AffectedAppointmentsPage {
  items: AffectedAppointment[];
  total: number;
}

export interface ScheduleBlockRepository {
  list(params: ListScheduleBlocksParams): Promise<ScheduleBlock[]>;
  /** Vivo (sin `deletedAt`) y de esta clínica (RLS), o `null`. */
  findById(id: string): Promise<ScheduleBlock | null>;
  create(input: CreateScheduleBlockRepoInput): Promise<ScheduleBlock>;
  update(
    id: string,
    patch: UpdateScheduleBlockRepoInput,
  ): Promise<ScheduleBlock>;
  /** Borrado lógico. */
  softDelete(id: string, deletedById: string): Promise<void>;
  /**
   * Bloqueos vivos que se solapan con una cita de `providerId` en su sede:
   * los suyos en esa sede o en todas, y los de toda la sede.
   */
  findAffecting(query: AffectingBlocksQuery): Promise<AffectingBlocks>;
  /**
   * Citas vivas (SCHEDULED o CONFIRMED) dentro del rango y del alcance de un
   * bloqueo, las primeras `limit` por hora y el total. No se tocan: se listan
   * para que alguien decida.
   */
  findAffectedAppointments(
    scope: ScheduleBlockScope & { start: Date; end: Date },
    limit: number,
  ): Promise<AffectedAppointmentsPage>;
  /**
   * DX-446: tipos de cita (de esta clínica, bajo RLS; uno ajeno no sale) y
   * zonas de sede para validar y pintar los bloques `RESERVED`.
   */
  reservedContext(
    typeIds: readonly string[],
    locationIds: readonly string[],
  ): Promise<ReservedContext>;
}
