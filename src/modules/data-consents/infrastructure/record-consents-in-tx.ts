import { ConflictException } from '@nestjs/common';
import { DataConsentChannel, DataConsentScope, Prisma } from '@prisma/client';
import type {
  ConsentDecision,
  ConsentEvidence,
} from '../domain/entities/data-consent.entity';
import {
  DerivedPatientConsent,
  deriveLegacyPatientConsent,
} from '../domain/consent-state';

export const NO_POLICY_MESSAGE =
  'La clínica aún no ha publicado su política de tratamiento de datos. Un administrador debe publicarla en Ajustes › Privacidad.';
export const OUTDATED_POLICY_MESSAGE =
  'La política de tratamiento de datos cambió mientras se registraba la autorización. Recarga para ver la versión vigente.';

/** Tope del user-agent guardado: evidencia, no un campo para abusar. */
const USER_AGENT_MAX = 512;

function evidenceColumns(evidence: ConsentEvidence): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  return {
    ipAddress: evidence.ipAddress ?? null,
    userAgent: evidence.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
  };
}

export interface VersionedConsentInTx {
  tenantId: string;
  patientId: string;
  policyVersionId: string;
  decisions: ConsentDecision[];
  recordedById: string;
  evidence: ConsentEvidence;
}

/**
 * Inserta las decisiones (canal IN_PERSON) dentro de la transacción de tenant
 * del llamador. Lo usan tanto `POST /patients/:id/data-consents` como el alta
 * del paciente, para que paciente y prueba se creen juntos o no se cree nada.
 *
 * - La política tiene que ser la VIGENTE de la clínica (la que se mostró): la
 *   consulta corre bajo RLS, así que un id de otra clínica tampoco cuenta.
 * - `recordedAt` es la hora del servidor, una sola para todas las filas.
 * - Si hay decisión GENERAL, reescribe el resumen deprecado del paciente.
 *
 * Devuelve ese resumen cuando lo tocó, para que el llamador no relea.
 */
export async function recordConsentsInTx(
  tx: Prisma.TransactionClient,
  input: VersionedConsentInTx,
): Promise<DerivedPatientConsent | null> {
  const current = await tx.privacyPolicyVersion.findFirst({
    orderBy: { version: 'desc' },
    select: { id: true, version: true },
  });
  if (!current) {
    throw new ConflictException(NO_POLICY_MESSAGE);
  }
  if (current.id !== input.policyVersionId) {
    throw new ConflictException(OUTDATED_POLICY_MESSAGE);
  }

  const recordedAt = new Date();
  const evidence = evidenceColumns(input.evidence);
  await tx.dataProcessingConsent.createMany({
    data: input.decisions.map((d) => ({
      tenantId: input.tenantId,
      patientId: input.patientId,
      policyVersionId: current.id,
      scope: d.scope,
      granted: d.granted,
      channel: DataConsentChannel.IN_PERSON,
      recordedById: input.recordedById,
      recordedAt,
      ...evidence,
    })),
  });

  const general = input.decisions.find(
    (d) => d.scope === DataConsentScope.GENERAL,
  );
  if (!general) return null;
  const derived = deriveLegacyPatientConsent({
    granted: general.granted,
    recordedAt,
    policyVersion: current,
    legacyPolicyVersion: null,
  });
  await tx.patient.update({ where: { id: input.patientId }, data: derived });
  return derived;
}

export interface LegacyConsentInTx {
  tenantId: string;
  patientId: string;
  granted: boolean;
  legacyPolicyVersion?: string;
  recordedById?: string;
  evidence: ConsentEvidence;
}

/**
 * Compatibilidad con clientes que aún mandan el booleano deprecado
 * `dataConsentAccepted` al crear el paciente: se guarda como fila GENERAL
 * LEGACY (sin texto versionado, así que no vale como prueba plena) y el
 * resumen del paciente se deriva de ella, igual que en el camino nuevo.
 */
export async function recordLegacyConsentInTx(
  tx: Prisma.TransactionClient,
  input: LegacyConsentInTx,
): Promise<DerivedPatientConsent> {
  const recordedAt = new Date();
  await tx.dataProcessingConsent.create({
    data: {
      tenantId: input.tenantId,
      patientId: input.patientId,
      legacyPolicyVersion: input.legacyPolicyVersion ?? null,
      scope: DataConsentScope.GENERAL,
      granted: input.granted,
      channel: DataConsentChannel.LEGACY,
      recordedById: input.recordedById ?? null,
      recordedAt,
      ...evidenceColumns(input.evidence),
    },
  });
  const derived: DerivedPatientConsent = {
    dataConsentAccepted: input.granted,
    dataConsentAt: recordedAt,
    dataConsentPolicyVersion: input.legacyPolicyVersion ?? null,
  };
  await tx.patient.update({ where: { id: input.patientId }, data: derived });
  return derived;
}
