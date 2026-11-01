import type { AuditEventDraft } from '../../audit/domain/audit-event';
import {
  auditDraftFromContext,
  type AuditRequestContext,
} from '../../audit/domain/audit-request-context';
import type { PrivacyPolicyContent } from './entities/privacy-policy.entity';

/** Una versión de la política tal como entra en la auditoría. */
export interface PrivacyPolicySnapshot extends PrivacyPolicyContent {
  version: number;
  contentHash: string;
}

const TEXTS = [
  'generalText',
  'marketingText',
  'policyText',
  'sensitiveHealthText',
] as const satisfies readonly (keyof PrivacyPolicyContent)[];

/**
 * DX-360: publicar una versión de la política de datos (`POST
 * /privacy-policies`). Versión y hash del contenido, antes (la vigente, si
 * había) y después; de los textos, solo cuáles cambiaron frente a la vigente,
 * nunca el texto (es largo y lo guarda la propia versión, `resourceId`).
 * Siempre hay evento: publicar crea una versión nueva aunque repita el texto.
 */
export function privacyPolicyPublishedAuditEvent(
  ctx: AuditRequestContext,
  id: string,
  previous: PrivacyPolicySnapshot | null,
  published: PrivacyPolicySnapshot,
): AuditEventDraft {
  const side = (p: PrivacyPolicySnapshot) => ({
    version: p.version,
    contentHash: p.contentHash,
  });
  const changed = previous
    ? TEXTS.filter((field) => previous[field] !== published[field])
    : [];
  return auditDraftFromContext(ctx, {
    action: 'CREATE',
    resourceType: 'PRIVACY_POLICY',
    resourceId: id,
    metadata: {
      reason: 'PRIVACY_POLICY_PUBLISHED',
      ...(changed.length > 0 ? { changedFields: [...changed] } : {}),
      configChange: previous
        ? { before: side(previous), after: side(published) }
        : { after: side(published) },
    },
  });
}
