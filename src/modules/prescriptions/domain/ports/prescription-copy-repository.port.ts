import type { ContactChannel, Prisma } from '@prisma/client';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import type { PrescriptionCopyChannel } from '../prescription-copy-link';
import type { PrescriptionCopyResponsible } from '../prescription-copy-recipient';

export const PRESCRIPTION_COPY_REPOSITORY = Symbol(
  'PRESCRIPTION_COPY_REPOSITORY',
);

/**
 * DX-468: lo que hace falta para enviar la copia de una receta (clínica del
 * contexto, RLS): la receta, su sede (permiso, zona, formato y región
 * telefónica), el paciente vivo con sus contactos y sus responsables vivos.
 */
export interface PrescriptionCopyTarget {
  prescriptionId: string;
  patientId: string;
  status: 'ISSUED' | 'VOIDED';
  clinicName: string;
  location: {
    id: string;
    timeZone: string | null;
    locale: string | null;
    hourCycle: string | null;
    phoneRegion: string | null;
  };
  patient: {
    firstName: string;
    birthDate: Date | null;
    email: string | null;
    phone: string | null;
    reminderOptOutAt: Date | null;
    contactChannel: ContactChannel;
    /** BCP 47 del paciente (DX-497); null = el de la clínica. */
    preferredLanguage: string | null;
  };
  responsibles: PrescriptionCopyResponsible[];
  majorityAge: number;
}

export interface IssuePrescriptionCopyLinkInput {
  /** Elegido antes: el email lo lleva como referencia. */
  id: string;
  prescriptionId: string;
  patientId: string;
  channel: PrescriptionCopyChannel;
  destinationMasked: string;
  tokenHash: string;
  expiresAt: Date;
  createdById: string;
  now: Date;
  /**
   * Corre en la MISMA transacción tras crear el enlace (encola el email). Si
   * falla, se deshace todo: el enlace anterior NO se invalida (DX-463).
   */
  enqueue?: (tx: Prisma.TransactionClient) => Promise<void>;
}

export type IssuePrescriptionCopyLinkOutcome =
  | { kind: 'ISSUED' }
  /** La anularon entre la lectura y el envío: no sale nada. */
  | { kind: 'VOIDED' }
  | { kind: 'NOT_FOUND' };

/** Un enlace buscado por el hash del token (RLS de la clínica del host). */
export interface PrescriptionCopyLinkRow {
  id: string;
  prescriptionId: string;
  patientId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface PrescriptionCopyRepository {
  /** null si no existe en esta clínica o su paciente está archivado. */
  loadTarget(prescriptionId: string): Promise<PrescriptionCopyTarget | null>;
  /**
   * En UNA transacción: comprueba bajo candado que el paciente sigue vivo
   * (409 si no, DX-476) y que la receta sigue emitida, invalida el enlace
   * vivo anterior de la receta, crea el nuevo y ejecuta `enqueue`.
   */
  issueLink(
    input: IssuePrescriptionCopyLinkInput,
  ): Promise<IssuePrescriptionCopyLinkOutcome>;
  /** null también si el paciente está archivado (DX-461). */
  findLinkByTokenHash(
    tokenHash: string,
  ): Promise<PrescriptionCopyLinkRow | null>;
  /**
   * Audita la apertura: VIEW de PRESCRIPTION sin usuario, origen
   * PUBLIC_LINK, reason PRESCRIPTION_COPY_OPENED. Solo ids.
   */
  recordOpened(input: {
    prescriptionId: string;
    locationId: string;
    meta: AuditRequestMeta;
  }): Promise<void>;
  /** Marca de la clínica del host para la cabecera de la página. */
  findClinicBranding(): Promise<{
    name: string;
    primaryColor: string | null;
    logoUrl: string | null;
  } | null>;
}
