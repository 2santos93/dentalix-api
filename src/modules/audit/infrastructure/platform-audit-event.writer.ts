import type { Prisma } from '@prisma/client';
import { MAX_AUDIT_USER_AGENT } from '../domain/audit-event';
import type { PlatformAuditEventDraft } from '../domain/platform-audit-event';

/** Topes de los CHECK de `platform_audit_events` (DX-220). */
const MAX_REQUEST_ID = 200;
const MAX_IP = 64;

/**
 * DX-359: escribe un evento de plataforma DENTRO de la transacción `tx` del
 * cambio (MFA o contraseña del superadmin): o los dos o ninguno. Metadata
 * vacía a propósito, salvo el mínimo de conservación de DX-330, que lleva
 * `{ before, after }` (ver PlatformAuditEventDraft).
 */
export async function writePlatformAuditEvent(
  tx: Prisma.TransactionClient,
  draft: PlatformAuditEventDraft,
): Promise<void> {
  await tx.platformAuditEvent.create({
    data: {
      actorUserId: draft.actor.userId,
      action: draft.action,
      resourceType: draft.resourceType,
      resourceId: draft.resourceId,
      requestId: draft.actor.requestId?.slice(0, MAX_REQUEST_ID) ?? null,
      ip: draft.actor.ip?.slice(0, MAX_IP) ?? null,
      userAgent: draft.actor.userAgent?.slice(0, MAX_AUDIT_USER_AGENT) ?? null,
      metadata: 'metadata' in draft ? draft.metadata : {},
    },
    select: { id: true },
  });
}
