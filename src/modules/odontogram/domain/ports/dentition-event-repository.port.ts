import { DentitionEventReason, DentitionType } from '@prisma/client';
import type { DentitionEvent } from '../dentition';

// Sin tenant, fecha ni autor en cada ítem: el tenant sale del contexto, la
// fecha la pone la BD y el autor llega aparte desde `req.user.sub`.
export interface CreateDentitionEventItem {
  position: string;
  dentition: DentitionType;
  reason: DentitionEventReason;
}

export const DENTITION_EVENT_REPOSITORY = Symbol('DENTITION_EVENT_REPOSITORY');

/**
 * Eventos de dentición (DX-120). APPEND-ONLY: solo inserta y lista; la BD
 * rechaza UPDATE/DELETE con un trigger.
 */
export interface DentitionEventRepository {
  /** Todos los eventos del paciente, en orden cronológico (recordedAt, id). */
  listByPatient(patientId: string): Promise<DentitionEvent[]>;

  /** Inserta los eventos en UNA transacción (todos o ninguno). */
  createMany(
    patientId: string,
    items: readonly CreateDentitionEventItem[],
    performedById: string,
  ): Promise<DentitionEvent[]>;
}
