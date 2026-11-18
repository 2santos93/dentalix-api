import { ClinicRole } from '@prisma/client';
import type {
  DataConsentRecord,
  PatientDataConsents,
} from '../domain/entities/data-consent.entity';

/**
 * DX-092 (SEC-027): la IP y el user-agent con que el personal registró una
 * autorización de datos son evidencia técnica sobre el PERSONAL, no sobre el
 * paciente. Solo los ve ADMIN — el mismo criterio que el registro de
 * auditoría (`AUDIT_READ_ROLES`), que lleva la IP y el user-agent de cada
 * acceso. Al resto de roles les llegan a `null` (la forma de la respuesta no
 * cambia). En la base se guardan siempre.
 */
export function canSeeConsentEvidence(role: ClinicRole | undefined): boolean {
  return role === ClinicRole.ADMIN;
}

function withoutEvidence(record: DataConsentRecord): DataConsentRecord {
  return { ...record, ipAddress: null, userAgent: null };
}

export function consentsForViewer(
  consents: PatientDataConsents,
  role: ClinicRole | undefined,
): PatientDataConsents {
  if (canSeeConsentEvidence(role)) return consents;
  return {
    current: consents.current.map((status) => ({
      ...status,
      latest: status.latest ? withoutEvidence(status.latest) : null,
    })),
    history: consents.history.map(withoutEvidence),
  };
}
