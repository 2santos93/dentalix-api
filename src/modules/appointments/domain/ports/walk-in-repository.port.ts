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
  /**
   * DX-510: Idempotency-Key (UUID ya validado) y huella de la petición. Con
   * clave, la transacción espera a la otra petición con la misma clave y, si
   * esa ya creó la cita, la devuelve (`replayed`) en vez de escribir.
   */
  idempotency?: { key: string; fingerprint: string };
}

export interface WalkInWriteResult {
  appointment: Appointment;
  patientCreated: boolean;
  /** Fila de `appointment_reserved_overrides` del sobrecupo, o null. */
  overbookId: string | null;
}

/** DX-510: la cita que creó una Idempotency-Key y la huella de su petición. */
export interface WalkInReplay {
  appointment: Appointment;
  overbookId: string | null;
  fingerprint: string | null;
}

/** Lo que escribió `create`, o la cita que ya había creado la misma clave. */
export type WalkInCreateOutcome =
  | ({ replayed: false } & WalkInWriteResult)
  | ({ replayed: true } & WalkInReplay);

export interface WalkInRepository {
  /**
   * Id del paciente vivo de la clínica (del contexto) con ese documento
   * normalizado (la misma clave que el alta, DX-107/DX-287), o null. Es la
   * consulta previa que deja avisar del duplicado ANTES de buscar hueco; la
   * transacción de `create` lo vuelve a comprobar con el candado tomado.
   */
  findLivePatientIdByDoc(docNumber: string): Promise<string | null>;
  /**
   * Paciente (si es nuevo), cita ARRIVED, motivo del sobrecupo y sus
   * `audit_event`: todo o nada. Un documento de otro paciente vivo da 409
   * `PATIENT_DUPLICATE` con su id; un solape (carrera), el 23P01 de la EXCLUDE.
   */
  create(
    input: WalkInWrite,
    ctx: AuditRequestContext,
  ): Promise<WalkInCreateOutcome>;
  /**
   * DX-510: la cita creada con esta Idempotency-Key en la clínica del
   * contexto (RLS + `tenantId`), con la huella de su petición, o null.
   */
  findByIdempotencyKey(key: string): Promise<WalkInReplay | null>;
}
