import type {
  ClinicCountry,
  DocType,
  PrescriptionStatus,
} from '@prisma/client';
import type { AllergyMatch } from '../allergy-match';
import type { PrescriptionItemContent } from '../prescription-hash';

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
  /** `alergeno` de cada alergia de la anamnesis vigente. */
  allergies: string[];
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
