import type { ClinicCountry } from '@prisma/client';
import type { AllergyMatch } from '../allergy-match';
import type { PrescriptionItemContent } from '../prescription-hash';
import type {
  Prescription,
  PrescriptionIssuer,
  PrescriptionPatient,
} from '../entities/prescription.entity';

// Sin `tenantId`: sale del contexto del request, nunca del cliente.
export interface CreatePrescriptionRepoInput {
  locationId: string;
  patientId: string;
  professionalId: string;
  country: ClinicCountry;
  issuedAt: Date;
  dispensationDate: string;
  validUntil: string;
  patientName: string;
  patientDocument: string | null;
  patientBirthYear: number | null;
  clinicalRecordNumber: string | null;
  professionalName: string;
  professionalLicense: string;
  professionalEmail: string | null;
  clinicName: string;
  locationName: string;
  locationAddress: string | null;
  notes: string | null;
  allergyOverride: boolean;
  allergyMatches: AllergyMatch[];
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

export const PRESCRIPTION_REPOSITORY = Symbol('PRESCRIPTION_REPOSITORY');

export interface PrescriptionRepository {
  /** Sede activa del request (o la principal) y el profesional del token. */
  loadIssuer(professionalUserId: string): Promise<PrescriptionIssuer>;

  /** `null` si el paciente no es de la clínica en contexto (RLS). */
  loadPatient(patientId: string): Promise<PrescriptionPatient | null>;

  /** Guarda el registro profesional en la membresía del usuario. */
  saveProfessionalLicense(userId: string, license: string): Promise<void>;

  /**
   * Inserta receta y medicamentos en UNA transacción. No hay `update` de
   * contenido en este puerto (la base también lo impide).
   */
  create(input: CreatePrescriptionRepoInput): Promise<Prescription>;

  /** Del paciente, más reciente primero, con medicamentos. */
  listByPatient(patientId: string): Promise<Prescription[]>;

  /** `null` si no existe o es de otra clínica. */
  findById(
    id: string,
  ): Promise<(Prescription & { clinicLogoUrl: string | null }) | null>;

  /** ISSUED → VOIDED, atómico: dos anulaciones a la vez, solo gana una. */
  void(
    id: string,
    input: VoidPrescriptionRepoInput,
  ): Promise<VoidPrescriptionOutcome>;
}
