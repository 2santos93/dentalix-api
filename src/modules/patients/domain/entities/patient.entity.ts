import {
  ContactChannel,
  DocType,
  ReminderOptOutSource,
  RetentionExtension,
  Sex,
  WhatsappOptInSource,
} from '@prisma/client';

/**
 * API-facing shape of a Patient. Deliberately NOT the raw Prisma model:
 * repositories must `mapToEntity` before returning across the port boundary
 * (see auth module's PrismaAuthRepository for the same convention).
 */
export interface Patient {
  id: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  docType: DocType;
  docNumber: string | null;
  birthDate: Date | null;
  sex: Sex;
  phone: string | null;
  email: string | null;
  address: string | null;
  countryCode: string | null;
  cityId: number | null;
  notes: string | null;
  dataConsentAccepted: boolean;
  dataConsentAt: Date | null;
  dataConsentPolicyVersion: string | null;
  maritalStatus: string | null;
  occupation: string | null;
  insurerEps: string | null;
  physicianName: string | null;
  physicianPhone: string | null;
  emergencyContactName: string | null;
  emergencyContactRelationship: string | null;
  emergencyContactPhone: string | null;
  guardianName: string | null;
  guardianDocNumber: string | null;
  createdById: string | null;
  /** DX-039: última atención clínica (la mantiene la BD; nunca retrocede). */
  lastAttentionAt: Date | null;
  retentionExtended: RetentionExtension;
  /**
   * Último día (incluido, `YYYY-MM-DD`) hasta el que se conserva la HC.
   * `null` sin atenciones clínicas o con retención PERMANENT (ver
   * `underRetention`).
   */
  retentionUntil: string | null;
  /** Si hoy la HC está en retención legal (no se puede archivar). */
  underRetention: boolean;
  /** DX-039: cuándo se vaciaron los datos no clínicos (supresión parcial). */
  partiallySuppressedAt: Date | null;
  /**
   * DX-128: canal de los avisos automáticos, opt-in de WhatsApp y baja de los
   * recordatorios (van en la ficha, y así en la exportación y el derecho de
   * acceso). Se cambian por `PATCH /patients/:id/communication`.
   */
  contactChannel: ContactChannel;
  whatsappOptInAt: Date | null;
  whatsappOptInSource: WhatsappOptInSource | null;
  whatsappOptInById: string | null;
  reminderOptOutAt: Date | null;
  reminderOptOutSource: ReminderOptOutSource | null;
  createdAt: Date;
  updatedAt: Date;
}
