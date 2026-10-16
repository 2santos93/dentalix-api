import { DataConsentChannel, DataConsentScope } from '@prisma/client';
import type { UserRef } from './privacy-policy.entity';

export { DataConsentChannel, DataConsentScope };

/** Una decisión explícita del titular sobre un scope. */
export interface ConsentDecision {
  scope: DataConsentScope;
  granted: boolean;
}

/** Evidencia técnica de la petición que registró la decisión. */
export interface ConsentEvidence {
  ipAddress?: string;
  userAgent?: string;
}

/** Una fila de `data_processing_consents` (append-only). */
export interface DataConsentRecord {
  id: string;
  patientId: string;
  scope: DataConsentScope;
  granted: boolean;
  channel: DataConsentChannel;
  /** Versión de política aceptada; `null` solo en filas LEGACY. */
  policyVersion: { id: string; version: number } | null;
  /** Etiqueta de versión que traía el booleano antiguo; solo LEGACY. */
  legacyPolicyVersion: string | null;
  /** Hora del servidor. */
  recordedAt: Date;
  /** `null` solo en filas LEGACY migradas del booleano. */
  recordedBy: UserRef | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/** Estado vigente de un scope: su última fila, o ninguna decisión aún. */
export interface ScopeConsentStatus {
  scope: DataConsentScope;
  /** `null` = el titular aún no ha decidido sobre este scope. */
  granted: boolean | null;
  latest: DataConsentRecord | null;
}

export interface PatientDataConsents {
  /** Un elemento por scope, siempre en el orden de `CONSENT_SCOPES`. */
  current: ScopeConsentStatus[];
  /** Todas las filas, de la más reciente a la más antigua. */
  history: DataConsentRecord[];
}
