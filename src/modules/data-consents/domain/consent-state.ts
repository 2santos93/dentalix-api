import { BadRequestException } from '@nestjs/common';
import { DataConsentScope } from '@prisma/client';
import type {
  ConsentDecision,
  DataConsentRecord,
  ScopeConsentStatus,
} from './entities/data-consent.entity';
import { policyVersionLabel } from './privacy-policy-content';

/** Orden de presentación de los scopes (y de `current` en las respuestas). */
export const CONSENT_SCOPES: DataConsentScope[] = [
  DataConsentScope.GENERAL,
  DataConsentScope.SENSITIVE_HEALTH,
  DataConsentScope.MARKETING,
];

function latestFirst(a: DataConsentRecord, b: DataConsentRecord): number {
  return b.recordedAt.getTime() - a.recordedAt.getTime();
}

/** Historial de la más reciente a la más antigua. */
export function sortHistory(history: DataConsentRecord[]): DataConsentRecord[] {
  return [...history].sort(latestFirst);
}

/**
 * Estado vigente: para cada scope, su ÚLTIMA fila. Una revocación es una fila
 * más (`granted = false`), así que gana a la aceptación anterior sin tocarla.
 */
export function currentConsentByScope(
  history: DataConsentRecord[],
): ScopeConsentStatus[] {
  const sorted = sortHistory(history);
  return CONSENT_SCOPES.map((scope) => {
    const latest = sorted.find((r) => r.scope === scope) ?? null;
    return { scope, granted: latest ? latest.granted : null, latest };
  });
}

export interface DerivedPatientConsent {
  dataConsentAccepted: boolean;
  dataConsentAt: Date | null;
  dataConsentPolicyVersion: string | null;
}

/**
 * Los campos deprecados `Patient.dataConsent*` son un resumen de la última
 * fila GENERAL: se siguen escribiendo para los clientes que aún los leen.
 */
export function deriveLegacyPatientConsent(
  latestGeneral: Pick<
    DataConsentRecord,
    'granted' | 'recordedAt' | 'policyVersion' | 'legacyPolicyVersion'
  > | null,
): DerivedPatientConsent {
  if (!latestGeneral) {
    return {
      dataConsentAccepted: false,
      dataConsentAt: null,
      dataConsentPolicyVersion: null,
    };
  }
  return {
    dataConsentAccepted: latestGeneral.granted,
    dataConsentAt: latestGeneral.recordedAt,
    dataConsentPolicyVersion: latestGeneral.policyVersion
      ? policyVersionLabel(latestGeneral.policyVersion.version)
      : latestGeneral.legacyPolicyVersion,
  };
}

export const EMPTY_DECISIONS_MESSAGE =
  'Indica al menos una decisión explícita del paciente.';
export const DUPLICATE_SCOPE_MESSAGE =
  'Cada tipo de autorización solo puede aparecer una vez por registro.';

/**
 * Una petición registra decisiones EXPLÍCITAS: al menos una, y como mucho una
 * por scope (dos para el mismo scope en el mismo instante no tendrían orden).
 */
export function assertValidDecisions(decisions: ConsentDecision[]): void {
  if (decisions.length === 0) {
    throw new BadRequestException(EMPTY_DECISIONS_MESSAGE);
  }
  const scopes = new Set(decisions.map((d) => d.scope));
  if (scopes.size !== decisions.length) {
    throw new BadRequestException(DUPLICATE_SCOPE_MESSAGE);
  }
}
