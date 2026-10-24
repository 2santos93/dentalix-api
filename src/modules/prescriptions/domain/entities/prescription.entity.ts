import type {
  ClinicCountry,
  DocType,
  PrescriptionStatus,
} from '@prisma/client';
import type { AllergyMatch } from '../allergy-match';
import type { PrescriptionItemContent } from '../prescription-hash';
import type { SafetyAlert, SafetyAnamnesis } from '../prescription-safety';

export interface PrescriptionItem extends PrescriptionItemContent {
  id: string;
}

/**
 * Receta EMITIDA (DX-013): foto congelada de los datos legales. No hay forma
 * de editarla (ni puerto, ni endpoint, ni la base lo deja); solo se anula, y
 * la anulación guarda quién, cuándo y por qué.
 */
export interface Prescription {
  id: string;
  tenantId: string;
  locationId: string;
  patientId: string;
  professionalId: string;
  country: ClinicCountry;
  status: PrescriptionStatus;
  issuedAt: Date;
  /** `YYYY-MM-DD` */
  dispensationDate: string;
  /** `YYYY-MM-DD`, último día en que vale. */
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
  /** DX-300: versión de las reglas; null en recetas anteriores. */
  safetyRulesVersion: string | null;
  /** DX-300: avisos calculados al emitir; null en recetas anteriores. */
  safetyAlerts: SafetyAlert[] | null;
  /** DX-300: motivo de la confirmación de los avisos bloqueantes. */
  safetyOverrideReason: string | null;
  contentHash: string;
  voidedAt: Date | null;
  voidedById: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  items: PrescriptionItem[];
}

/** La receta con lo que necesita la vista imprimible. */
export interface PrescriptionDocument extends Prescription {
  clinicLogoUrl: string | null;
  /** `true` si el hash guardado coincide con el recalculado al leer. */
  integrityOk: boolean;
}

/** Datos del paciente que la receta copia y valida. */
export interface PrescriptionPatient {
  id: string;
  firstName: string;
  lastName: string;
  docType: DocType;
  docNumber: string | null;
  birthDate: Date | null;
  /**
   * Lo que la receta segura (DX-300) lee de la anamnesis VIGENTE: alergias
   * (lista y casillas), medicación habitual, embarazo, anticoagulantes,
   * bifosfonatos y peso. null = el paciente no tiene anamnesis.
   */
  anamnesis: SafetyAnamnesis | null;
}

/** Desde dónde y quién emite: sede activa (o la principal) y profesional. */
export interface PrescriptionIssuer {
  location: {
    id: string;
    name: string;
    address: string | null;
    country: ClinicCountry;
    timeZone: string;
  };
  clinicName: string;
  professional: {
    id: string;
    name: string;
    email: string | null;
    license: string | null;
  };
}
