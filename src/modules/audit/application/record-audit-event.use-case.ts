import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUDIT_EVENT_REPOSITORY,
  type AuditEventRepository,
} from '../domain/ports/audit-event-repository.port';
import type { AuditEventDraft } from '../domain/audit-event';
import { sanitizeAuditMetadata } from '../domain/audit-metadata';

const MAX_USER_AGENT = 512;

/**
 * Escribe un evento de auditoría (DX-009) y NUNCA lanza.
 *
 * El interceptor lo llama justo DESPUÉS de que el handler terminó bien, así
 * que en una escritura el cambio ya está confirmado: fallar la respuesta
 * llevaría al cliente a reintentar algo que sí se hizo. Por eso un fallo aquí
 * no rompe la petición (ni de lectura ni de escritura) y queda en el log como
 * `error` con el request id (DX-023), la acción y el recurso, para poder
 * reconstruir el evento. Del error se registra solo el tipo: el mensaje de
 * Prisma puede reproducir los valores de la consulta.
 */
@Injectable()
export class RecordAuditEventUseCase {
  private readonly logger = new Logger('Audit');

  constructor(
    @Inject(AUDIT_EVENT_REPOSITORY)
    private readonly repo: AuditEventRepository,
  ) {}

  async record(draft: AuditEventDraft): Promise<void> {
    try {
      await this.repo.insert({
        ...draft,
        userAgent: draft.userAgent?.slice(0, MAX_USER_AGENT) ?? null,
        metadata: sanitizeAuditMetadata(draft.metadata),
      });
    } catch (err) {
      this.logger.error(
        `audit event not recorded: ${draft.action} ${draft.resourceType}`,
        {
          error: err instanceof Error ? err.constructor.name : typeof err,
          action: draft.action,
          resourceType: draft.resourceType,
          resourceId: draft.resourceId,
          tenantId: draft.tenantId,
        },
      );
    }
  }
}
