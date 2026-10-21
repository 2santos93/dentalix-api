import type { SafetyFlags } from './entities/medical-history.entity';
import { anamnesisStatus, type AnamnesisStatus } from './anamnesis-validity';
import { isFlaggedAllergen } from './safety-flags';

/**
 * Alertas que la agenda puede nombrar (DX-247), en el orden del banner de la
 * ficha. Son las banderas DERIVADAS (`deriveSafetyFlags`) más
 * `alergiaMarcada`: una alergia marcada como alerta que no es de las
 * conocidas. Nunca el texto del alérgeno, de la condición ni del medicamento.
 */
export const MEDICAL_ALERT_CODES = [
  'embarazo',
  'anticoagulantes',
  'bifosfonatos',
  'diabetes',
  'profilaxisAntibiotica',
  'alergiaAnestesico',
  'alergiaPenicilina',
  'alergiaLatex',
  'alergiaMarcada',
] as const;
export type MedicalAlertCode = (typeof MEDICAL_ALERT_CODES)[number];

/**
 * Lo único de la anamnesis que llega a la agenda, al panel «En clínica» y a
 * la cabecera de la ficha: banderas mínimas (Ley 1581 / RGPD), no la historia.
 */
export interface MedicalAlertFlags {
  hasCriticalAlert: boolean;
  /** `profilaxisAntibiotica`: la cita avisa «Requiere premedicación». */
  requiresPremedication: boolean;
  anamnesisStatus: AnamnesisStatus;
  alerts: MedicalAlertCode[];
  /** Última versión o última confirmación «Sin cambios hoy»; null si no hay. */
  anamnesisReviewedAt: Date | null;
}

/** La versión vigente de la anamnesis, reducida a lo que hace falta aquí. */
export interface AnamnesisSnapshot {
  versionId: string;
  /** null en filas sin el JSON de banderas (anteriores a su derivación). */
  safetyFlags: SafetyFlags | null;
  hasCriticalAlert: boolean;
  /** Alérgenos con `esAlerta`: se leen en el servidor y no salen de él. */
  alertAllergens: string[];
  createdAt: Date;
}

export const NO_ANAMNESIS_FLAGS: MedicalAlertFlags = {
  hasCriticalAlert: false,
  requiresPremedication: false,
  anamnesisStatus: 'MISSING',
  alerts: [],
  anamnesisReviewedAt: null,
};

/** La revisión que cuenta: la más reciente entre la versión y la confirmación. */
export function lastAnamnesisReview(
  versionCreatedAt: Date,
  lastConfirmedAt: Date | null,
): Date {
  return lastConfirmedAt && lastConfirmedAt > versionCreatedAt
    ? lastConfirmedAt
    : versionCreatedAt;
}

export function deriveMedicalAlertFlags(
  snapshot: AnamnesisSnapshot | null,
  lastConfirmedAt: Date | null,
  validityMonths: number,
  now: Date,
): MedicalAlertFlags {
  if (!snapshot) return NO_ANAMNESIS_FLAGS;
  const flags = snapshot.safetyFlags;
  const alerts: MedicalAlertCode[] = MEDICAL_ALERT_CODES.filter(
    (code) => code !== 'alergiaMarcada' && flags?.[code] === true,
  );
  if (snapshot.alertAllergens.some((a) => !isFlaggedAllergen(a))) {
    alerts.push('alergiaMarcada');
  }
  const reviewedAt = lastAnamnesisReview(snapshot.createdAt, lastConfirmedAt);
  return {
    hasCriticalAlert: snapshot.hasCriticalAlert,
    requiresPremedication: flags?.profilaxisAntibiotica === true,
    anamnesisStatus: anamnesisStatus(reviewedAt, validityMonths, now),
    alerts,
    anamnesisReviewedAt: reviewedAt,
  };
}
