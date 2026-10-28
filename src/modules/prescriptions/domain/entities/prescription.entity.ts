/**
 * Excepción G5.3 (DX-334): recetas emitidas antes de DX-324. La entidad lleva
 * el campo histórico `country`; ninguna regla decide con él (spec R1, R12).
 */
import type { DocType, PrescriptionStatus } from '@prisma/client';
import type { HourCycle } from '../../../../shared/format/regional-format';
import type { AllergyMatch } from '../allergy-match';
import type { LegacyPrescriptionCountry } from '../legacy-prescription';
import type { PrescriptionItemContent } from '../prescription-hash';
import type { SafetyAlert, SafetyAnamnesis } from '../prescription-safety';
import type { PrescriptionSettings } from '../prescription-settings';

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
  /**
   * País de la plantilla legada (v1/v2). En la receta única es solo el dato
   * que la fila sigue llevando en fase 1 (spec D1); la API no lo devuelve.
   */
  country: LegacyPrescriptionCountry;
  /** DX-324: receta única (hash v3); `false` en toda receta anterior. */
  singleFormat: boolean;
  /** DX-324: el ajuste «cantidad en letras» al emitir; `null` en las legadas. */
  printQuantityInWords: boolean | null;
  status: PrescriptionStatus;
  issuedAt: Date;
  /** `YYYY-MM-DD` */
  dispensationDate: string;
  /** `YYYY-MM-DD`, último día en que vale. */
  validUntil: string;
  patientName: string;
  patientDocument: string | null;
  patientBirthYear: number | null;
  /** DX-324: años cumplidos el día de la emisión en la sede, o `null`. */
  patientAgeYears: number | null;
  /** DX-324: peso de la anamnesis vigente, redondeado a 0,1 kg, o `null`. */
  patientWeightKg: number | null;
  clinicalRecordNumber: string | null;
  professionalName: string;
  professionalLicense: string;
  /** DX-324: especialidad del perfil del miembro al emitir, o `null`. */
  professionalSpecialty: string | null;
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

/**
 * Formato ACTUAL de la sede de la receta (spec §4.6, R11), también si está
 * retirada. Tolerante: lo que falte o no sea válido llega como `null`.
 */
export interface PrescriptionLocationFormat {
  timeZone: string | null;
  locale: string | null;
  hourCycle: HourCycle | null;
}

/** La receta con lo que necesita la vista imprimible. */
export interface PrescriptionDocument extends Prescription {
  clinicLogoUrl: string | null;
  locationFormat: PrescriptionLocationFormat;
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

/**
 * Desde dónde y quién emite: sede activa (o la principal), los ajustes de la
 * clínica y el profesional con su perfil (spec §4.3).
 */
export interface PrescriptionIssuer {
  location: {
    id: string;
    name: string;
    address: string | null;
    timeZone: string;
  };
  clinicName: string;
  settings: PrescriptionSettings;
  professional: {
    id: string;
    name: string;
    email: string | null;
    license: string | null;
    specialty: string | null;
  };
}
