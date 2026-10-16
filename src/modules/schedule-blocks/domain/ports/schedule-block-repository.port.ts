import type { ScheduleBlockKind } from '@prisma/client';
import type {
  AffectedAppointment,
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
  createdById: string;
}

export interface UpdateScheduleBlockRepoInput {
  start?: Date;
  end?: Date;
  kind?: ScheduleBlockKind;
  allowsBooking?: boolean;
  note?: string | null;
  updatedById: string;
}

export interface AffectingBlocksQuery {
  providerId: string;
  start: Date;
  end: Date;
  /** Sede de la cita; sin ella, la del request o la sede por defecto. */
  locationId?: string;
}

/** Bloqueos que tocan una cita, con la zona de su sede para redactar mensajes. */
export interface AffectingBlocks {
  locationId: string;
  timeZone: string;
  blocks: ScheduleBlock[];
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
}
