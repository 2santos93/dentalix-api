import type {
  AuditEventDraft,
  AuditEventFilter,
  AuditEventView,
} from '../audit-event';
import type { AuditCursor } from '../audit-cursor';

export const AUDIT_EVENT_REPOSITORY = Symbol('AUDIT_EVENT_REPOSITORY');

export interface AuditEventRepository {
  /**
   * Una sola escritura (INSERT) por evento, en su propia transacción con el
   * tenant del evento fijado (RLS). Antes, como mucho una lectura para
   * resolver el paciente o el actor.
   */
  insert(draft: AuditEventDraft): Promise<void>;
  /** Hasta `take` eventos después de `cursor`, más reciente primero. */
  list(
    tenantId: string,
    filter: AuditEventFilter,
    cursor: AuditCursor | null,
    take: number,
  ): Promise<AuditEventView[]>;
  /** Zona de la sede activa o, sin ella, de la sede principal. */
  clinicTimeZone(tenantId: string, locationId?: string): Promise<string>;
}
