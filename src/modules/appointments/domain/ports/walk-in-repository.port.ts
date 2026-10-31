import type { DocumentType, TriageFlag } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { Appointment } from '../entities/appointment.entity';

export const WALK_IN_REPOSITORY = Symbol('WALK_IN_REPOSITORY');

/** Alta mínima (DX-470): nombre y teléfono; el documento, si lo trae. */
export interface WalkInNewPatient {
  firstName: string;
  lastName: string;
  phone: string;
  docType: DocumentType;
  docTypeLabel: string | null;
  docNumber?: string;
}

export type WalkInPatient =
  { kind: 'existing'; id: string } | { kind: 'new'; data: WalkInNewPatient };

/** Lo que «Atender sin cita» escribe en UNA transacción. */
export interface WalkInWrite {
  patient: WalkInPatient;
  providerId: string;
  /** Sede ya resuelta y permitida (cabecera o sede de escritura). */
  locationId: string;
  appointmentTypeId: string;
  start: Date;
  end: Date;
  /** Reloj del servidor: la llegada es ahora. */
  arrivedAt: Date;
  triageFlags: TriageFlag[];
  triageNote: string | null;
  /** Sobrecupo con su motivo (ya validado); `null` = hueco reservado. */
  overbookReason: string | null;
  createdById: string;
}

export interface WalkInWriteResult {
  appointment: Appointment;
  patientCreated: boolean;
  /** Fila de `appointment_reserved_overrides` del sobrecupo, o null. */
  overbookId: string | null;
}

export interface WalkInRepository {
  /**
   * Paciente (si es nuevo), cita ARRIVED, motivo del sobrecupo y sus
   * `audit_event`: todo o nada. Un documento de otro paciente vivo da 409
   * `PATIENT_DUPLICATE` con su id; un solape (carrera), el 23P01 de la EXCLUDE.
   */
  create(
    input: WalkInWrite,
    ctx: AuditRequestContext,
  ): Promise<WalkInWriteResult>;
}
