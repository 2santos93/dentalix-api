import type {
  OnlineBookingMode,
  OnlineBookingPatientKind,
  OnlineBookingStatus,
  Prisma,
} from '@prisma/client';
import type {
  AuditRequestContext,
  AuditRequestMeta,
} from '../../../audit/domain/audit-request-context';
import type {
  OnlineBookingSettings,
  OnlineTypeSettings,
  OnlineTypeView,
} from '../online-booking-settings';

export const ONLINE_BOOKING_REPOSITORY = Symbol('ONLINE_BOOKING_REPOSITORY');

/** Lo que la página pública puede ofrecer (todo de la clínica del host). */
export interface BookableCatalog {
  clinicName: string;
  /** Sedes activas (sin horario no darán huecos, pero se listan igual). */
  locations: {
    id: string;
    name: string;
    address: string | null;
    timeZone: string | null;
    /** Formato de la sede (BCP 47 y reloj): la página escribe horas con él. */
    locale: string | null;
    hourCycle: string | null;
  }[];
  /** Tipos visibles online, activos y no retirados. */
  types: (OnlineTypeSettings & { name: string; durationMinutes: number })[];
  /** Política de datos vigente (la que se acepta en el formulario). */
  privacyPolicy: {
    id: string;
    version: number;
    policyText: string;
    generalText: string;
  } | null;
}

export interface PatientIdentity {
  firstName: string;
  lastName: string;
  /** Día civil YYYY-MM-DD. */
  birthDate: string;
  email: string;
}

export interface VerificationRow {
  id: string;
  patientId: string | null;
  patientKind: OnlineBookingPatientKind;
  codeHmac: string | null;
  codeExpiresAt: Date | null;
  attempts: number;
  verifiedAt: Date | null;
  lockedAt: Date | null;
}

export interface BookingSession {
  verificationId: string;
  patientId: string;
  patientKind: OnlineBookingPatientKind;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface NewPatientInput {
  firstName: string;
  lastName: string;
  birthDate: string;
  email: string;
  phone: string;
  policyVersionId: string;
}

export interface RequestRowInput {
  locationId: string;
  providerId: string;
  appointmentTypeId: string;
  patientId: string;
  patientKind: OnlineBookingPatientKind;
  start: Date;
  end: Date;
  possibleDuplicate: boolean;
  contactEmail: string | null;
  contactPhone: string | null;
  /** La sesión que la crea (queda gastada en la misma transacción). */
  sessionId: string | null;
}

/** Una fila de la bandeja «Solicitudes online». */
export interface OnlineRequestView {
  id: string;
  status: OnlineBookingStatus;
  mode: OnlineBookingMode;
  patientKind: OnlineBookingPatientKind;
  possibleDuplicate: boolean;
  start: Date;
  end: Date;
  createdAt: Date;
  decidedAt: Date | null;
  contactEmail: string | null;
  contactPhone: string | null;
  appointmentId: string | null;
  location: { id: string; name: string; timeZone: string | null };
  provider: { id: string; fullName: string };
  appointmentType: { id: string; name: string; color: string };
  patient: { id: string; fullName: string };
}

export interface ListRequestsQuery {
  status: OnlineBookingStatus | null;
  /** `undefined` = todas las sedes (sin restricción DX-089). */
  locationIds: string[] | undefined;
  page: number;
  pageSize: number;
}

export interface OnlineBookingRepository {
  // --- Ajustes (ADMIN) -----------------------------------------------------
  getSettings(): Promise<OnlineBookingSettings>;
  /** Guarda y audita (CLINIC_SETTINGS / ONLINE_BOOKING_SETTINGS) si cambia algo. */
  saveSettings(
    next: Omit<OnlineBookingSettings, 'updatedAt'>,
    ctx: AuditRequestContext,
  ): Promise<OnlineBookingSettings>;
  listTypes(): Promise<OnlineTypeView[]>;
  /** `null` si el tipo no es de la clínica (o está retirado). */
  findType(appointmentTypeId: string): Promise<OnlineTypeView | null>;
  saveType(
    input: OnlineTypeSettings,
    ctx: AuditRequestContext,
  ): Promise<OnlineTypeView>;
  /** Sedes activas de la clínica (ids). */
  activeLocationIds(): Promise<string[]>;

  // --- Página pública ------------------------------------------------------
  catalog(): Promise<BookableCatalog>;
  /** Fichas vivas con ese nombre (normalizado), nacimiento y email (máx. 2). */
  findExistingPatients(identity: PatientIdentity): Promise<string[]>;
  /** Una ficha parecida a un «nuevo» (nombre+nacimiento o email+nacimiento). */
  findDuplicateCandidate(identity: PatientIdentity): Promise<string | null>;
  countCodesSince(patientId: string, since: Date): Promise<number>;
  /** Crea la verificación; con paciente, audita el envío (en la misma tx). */
  createVerification(
    input: {
      id: string;
      patientId: string | null;
      codeHmac: string;
      codeExpiresAt: Date;
    },
    meta: AuditRequestMeta,
    afterInsert?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void>;
  findVerification(id: string): Promise<VerificationRow | null>;
  /**
   * Cuenta un intento ANTES de comparar (atómico): devuelve la fila solo si
   * seguía viva (sin verificar, sin bloquear, sin caducar y bajo el tope).
   */
  claimAttempt(
    id: string,
    maxAttempts: number,
    now: Date,
  ): Promise<VerificationRow | null>;
  /** Bloquea (y audita) si el intento contado llegó al tope. */
  lockIfExhausted(
    row: VerificationRow,
    maxAttempts: number,
    meta: AuditRequestMeta,
  ): Promise<boolean>;
  /**
   * Tras responder: liga la verificación al paciente que casó, con el HMAC
   * del código real, y audita el envío. `false` si ya no estaba libre.
   */
  attachPatient(
    id: string,
    patientId: string,
    codeHmac: string,
    meta: AuditRequestMeta,
  ): Promise<boolean>;
  /** Gasta el código y abre la sesión (solo si sigue sin usar). */
  markVerified(
    row: VerificationRow,
    session: { tokenHash: string; expiresAt: Date },
    now: Date,
    meta: AuditRequestMeta,
  ): Promise<boolean>;
  /** Sesión sin código para reintentar con la ficha nueva ya creada. */
  createRetrySession(
    patientId: string,
    session: { tokenHash: string; expiresAt: Date },
    now: Date,
  ): Promise<void>;
  findSession(tokenHash: string): Promise<BookingSession | null>;
  /** Ficha nueva + consentimiento + auditoría; `then` va en la misma tx. */
  createNewPatient(
    input: NewPatientInput,
    meta: AuditRequestMeta,
    then?: (tx: Prisma.TransactionClient, patientId: string) => Promise<void>,
  ): Promise<string>;
  /** Solicitud PENDING + su auditoría (y gasta la sesión), en `tx`. */
  insertRequestInTx(
    tx: Prisma.TransactionClient,
    input: RequestRowInput,
    meta: AuditRequestMeta,
  ): Promise<string>;
  /** Reserva directa BOOKED con su cita + auditoría, dentro del alta de la cita. */
  insertBookedInTx(
    tx: Prisma.TransactionClient,
    input: RequestRowInput & { appointmentId: string },
    meta: AuditRequestMeta,
  ): Promise<string>;
  /** `insertRequestInTx` en su propia transacción. */
  createRequest(
    input: RequestRowInput,
    meta: AuditRequestMeta,
  ): Promise<string>;
  /** Nombre de pila y email del paciente (para el acuse). */
  patientContact(
    patientId: string,
  ): Promise<{ firstName: string; email: string | null } | null>;

  // --- Bandeja de recepción -----------------------------------------------
  listRequests(
    query: ListRequestsQuery,
  ): Promise<{ items: OnlineRequestView[]; total: number }>;
  countPending(locationIds: string[] | undefined): Promise<number>;
  findRequest(id: string): Promise<OnlineRequestView | null>;
  /** PENDING → ACCEPTED con su cita, en la tx del alta. `false` si ya no estaba PENDING. */
  acceptInTx(
    tx: Prisma.TransactionClient,
    id: string,
    appointmentId: string,
    ctx: AuditRequestContext,
    patientId: string,
  ): Promise<boolean>;
  /** PENDING → DECLINED. `false` si ya no estaba PENDING. */
  decline(
    id: string,
    ctx: AuditRequestContext,
    patientId: string,
  ): Promise<boolean>;
}
