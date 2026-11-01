import type { ClinicFiscalData } from '../../../../shared/clinic/clinic-fiscal';
import type { AllergyMatch } from '../allergy-match';
import type { PrescriptionItemContent } from '../prescription-hash';
import type { SafetyAlert } from '../prescription-safety';
import type {
  Prescription,
  PrescriptionIssuer,
  PrescriptionLocationFormat,
  PrescriptionPatient,
} from '../entities/prescription.entity';

/**
 * Lo que el caso de uso sella y lo que se inserta: el mismo objeto. Sin
 * `tenantId` (sale del contexto del request, nunca del cliente) y sin el país
 * de la sede, que en fase 1 escribe el propio repositorio (spec D1).
 */
export interface CreatePrescriptionRepoInput {
  locationId: string;
  patientId: string;
  professionalId: string;
  singleFormat: true;
  printQuantityInWords: boolean;
  issuedAt: Date;
  dispensationDate: string;
  validUntil: string;
  patientName: string;
  patientDocument: string | null;
  patientBirthYear: number | null;
  patientAgeYears: number | null;
  patientWeightKg: number | null;
  clinicalRecordNumber: string | null;
  professionalName: string;
  professionalLicense: string;
  professionalSpecialty: string | null;
  professionalEmail: string | null;
  clinicName: string;
  locationName: string;
  locationAddress: string | null;
  notes: string | null;
  allergyOverride: boolean;
  allergyMatches: AllergyMatch[];
  safetyRulesVersion: string;
  safetyAlerts: SafetyAlert[];
  safetyOverrideReason: string | null;
  contentHash: string;
  items: PrescriptionItemContent[];
}

export interface VoidPrescriptionRepoInput {
  voidedById: string;
  voidedAt: Date;
  reason: string;
}

export type VoidPrescriptionOutcome =
  | { kind: 'VOIDED'; prescription: Prescription }
  | { kind: 'NOT_FOUND' }
  | { kind: 'ALREADY_VOIDED' };

/** La receta guardada con lo que la vista imprimible lee de la clínica y la sede. */
export type StoredPrescription = Prescription & {
  clinicLogoUrl: string | null;
  /** DX-019: datos fiscales de HOY (fuera del contenido con hash). */
  clinicFiscal: ClinicFiscalData;
  locationFormat: PrescriptionLocationFormat;
};

export const PRESCRIPTION_REPOSITORY = Symbol('PRESCRIPTION_REPOSITORY');

export interface PrescriptionRepository {
  /** Sede activa del request (o la principal) y el profesional del token. */
  loadIssuer(professionalUserId: string): Promise<PrescriptionIssuer>;

  /**
   * `null` si el paciente no es de la clínica en contexto (RLS). Con su
   * anamnesis vigente (DX-300), leída en la misma transacción y bajo RLS.
   */
  loadPatient(patientId: string): Promise<PrescriptionPatient | null>;

  /** Guarda el registro profesional en la membresía del usuario. */
  saveProfessionalLicense(userId: string, license: string): Promise<void>;

  /**
   * Inserta receta y medicamentos en UNA transacción. No hay `update` de
   * contenido en este puerto (la base también lo impide). En fase 1 copia en
   * la fila, en esa misma transacción, el país actual de la sede como dato.
   */
  create(input: CreatePrescriptionRepoInput): Promise<Prescription>;

  /** Del paciente, más reciente primero, con medicamentos. */
  listByPatient(patientId: string): Promise<Prescription[]>;

  /**
   * `null` si no existe o es de otra clínica. Con el formato actual de su
   * sede, también si está retirada.
   */
  findById(id: string): Promise<StoredPrescription | null>;

  /** ISSUED → VOIDED, atómico: dos anulaciones a la vez, solo gana una. */
  void(
    id: string,
    input: VoidPrescriptionRepoInput,
  ): Promise<VoidPrescriptionOutcome>;
}
