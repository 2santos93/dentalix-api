import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import type {
  LeadChannelCode,
  LeadReasonKindCode,
  LeadStageCode,
} from './lead-rules';

export const LEAD_REPOSITORY = Symbol('LEAD_REPOSITORY');

/**
 * Otra escritura con el mismo E.164 ganó la carrera (leads_tenant_phone_key).
 * Sin datos: el caso de uso vuelve a mirar quién tiene el número y lo redacta
 * con la MISMA regla de sedes que sin carrera (un solo sitio).
 */
export class LeadPhoneRaceError extends Error {
  constructor() {
    super('leads_tenant_phone_key');
    this.name = 'LeadPhoneRaceError';
  }
}

/** Sedes del alcance (DX-089): `undefined` = sin restricción (todas). */
export type LeadLocationScope = readonly string[] | undefined;

export interface LeadRow {
  id: string;
  locationId: string;
  locationName: string;
  fullName: string;
  phone: string | null;
  phoneE164: string | null;
  channel: LeadChannelCode;
  interestReason: string | null;
  stage: LeadStageCode;
  lostReason: string | null;
  ownerId: string | null;
  ownerName: string | null;
  nextActionAt: Date | null;
  nextActionNote: string | null;
  lastContactAt: Date | null;
  scheduledAt: Date | null;
  attendedAt: Date | null;
  lostAt: Date | null;
  convertedPatientId: string | null;
  convertedAt: Date | null;
  firstAppointmentId: string | null;
  anonymizedAt: Date | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  /** «Sin contactar hace más de 24 h», con la hora de la BD. */
  stale: boolean;
}

export interface LeadNoteRow {
  id: string;
  body: string;
  authorId: string;
  authorName: string | null;
  createdAt: Date;
}

export interface LeadListFilter {
  locationIds: LeadLocationScope;
  stage?: LeadStageCode;
  channel?: LeadChannelCode;
  ownerId?: string;
  /** Solo los que no tienen responsable (la fila «Sin responsable» del informe). */
  unowned?: boolean;
  /** Busca en el nombre (sin tildes ni mayúsculas) o en los dígitos del teléfono. */
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
  /** Llegó a la cita (`scheduledAt`) o asistió (`attendedAt`), aunque luego retrocediera. */
  reached?: 'SCHEDULED' | 'ATTENDED';
  stale?: boolean;
}

export interface LeadPage {
  rows: LeadRow[];
  total: number;
}

export interface LeadBoardColumn {
  stage: LeadStageCode;
  total: number;
  rows: LeadRow[];
}

export interface PhoneOwners {
  /** Pacientes vivos con ese E.164 (como mucho 5, los más antiguos primero). */
  patients: { id: string; firstName: string; lastName: string }[];
  /** El prospecto vivo con ese E.164 (único por clínica), si lo hay. */
  lead: { id: string; fullName: string; locationId: string } | null;
}

export interface CreateLeadRepoInput {
  locationId: string;
  fullName: string;
  phone: string;
  phoneE164: string;
  channel: LeadChannelCode;
  interestReason: string | null;
  ownerId: string | null;
  nextActionAt: Date | null;
  nextActionNote: string | null;
  createdById: string;
}

/** Lo que bloquea (FOR UPDATE) una escritura sobre un prospecto. */
export interface LockedLead {
  id: string;
  locationId: string;
  stage: LeadStageCode;
  phone: string | null;
  phoneE164: string | null;
  fullName: string;
  convertedPatientId: string | null;
  anonymizedAt: Date | null;
}

export interface UpdateLeadPatch {
  fullName?: string;
  phone?: string;
  phoneE164?: string;
  channel?: LeadChannelCode;
  interestReason?: string | null;
  ownerId?: string | null;
  nextActionAt?: Date | null;
  nextActionNote?: string | null;
  locationId?: string;
}

export interface StageChange {
  to: LeadStageCode;
  lostReason: string | null;
}

export type ConvertDecision =
  | { kind: 'EXISTING'; patientId: string }
  | { kind: 'LINK'; patientId: string }
  | { kind: 'CREATE'; firstName: string; lastName: string };

export interface ConvertResult {
  patientId: string;
  created: boolean;
  linked: boolean;
}

export interface LeadReportRow {
  key: string | null;
  label: string | null;
  leads: number;
  scheduled: number;
  attended: number;
}

export interface LeadReasonRow {
  id: string;
  kind: LeadReasonKindCode;
  name: string;
}

export interface LeadPhoneMatch {
  id: string;
  fullName: string;
  stage: LeadStageCode;
  locationId: string;
  convertedPatientId: string | null;
}

/**
 * Todo bajo RLS (`runWithTenant`); las sedes las decide el caso de uso. Las
 * escrituras bloquean el prospecto y llaman a `decide` con la fila
 * bloqueada antes de escribir (403/409 sin escribir nada), y dejan su
 * `audit_event` en la MISMA transacción.
 */
export interface LeadRepository {
  locationExists(locationId: string): Promise<boolean>;
  /** Sede en la que se escribe sin sede pedida (DX-089: `writeLocationId`). */
  writeLocationId(): Promise<string>;
  /** Región por defecto de la sede (lectura del teléfono). */
  phoneRegionOf(locationId: string): Promise<string | null>;
  /** Miembro vivo de la clínica con rol ADMIN o RECEPTION. */
  isEligibleOwner(userId: string): Promise<boolean>;
  owners(): Promise<{ userId: string; fullName: string; role: string }[]>;
  phoneOwners(phoneE164: string, excludeLeadId?: string): Promise<PhoneOwners>;

  create(
    input: CreateLeadRepoInput,
    audit: AuditRequestContext,
  ): Promise<LeadRow>;
  findById(id: string): Promise<LeadRow | null>;
  notes(id: string): Promise<LeadNoteRow[]>;
  update(
    id: string,
    patch: UpdateLeadPatch,
    decide: (locked: LockedLead) => void,
    changedFields: string[],
    audit: AuditRequestContext,
  ): Promise<LeadRow | null>;
  changeStage(
    id: string,
    decide: (locked: LockedLead) => StageChange,
    audit: AuditRequestContext,
  ): Promise<LeadRow | null>;
  addNote(
    id: string,
    body: string,
    decide: (locked: LockedLead) => void,
    audit: AuditRequestContext,
  ): Promise<LeadNoteRow | null>;
  /**
   * Conversión idempotente: con el prospecto bloqueado, `decide` recibe los
   * pacientes vivos con su teléfono y dice si devolver el ya enlazado,
   * enlazar uno o crear la ficha mínima.
   */
  convert(
    id: string,
    decide: (
      locked: LockedLead,
      candidates: PhoneOwners['patients'],
    ) => ConvertDecision,
    audit: AuditRequestContext,
  ): Promise<ConvertResult | null>;

  list(
    filter: LeadListFilter,
    page: { page: number; pageSize: number },
  ): Promise<LeadPage>;
  board(
    filter: Omit<LeadListFilter, 'stage' | 'stale' | 'reached'>,
    perStage: number,
  ): Promise<LeadBoardColumn[]>;
  count(
    locationIds: LeadLocationScope,
  ): Promise<{ open: number; stale: number }>;
  report(
    filter: Pick<LeadListFilter, 'locationIds' | 'createdFrom' | 'createdTo'>,
    by: 'channel' | 'owner',
  ): Promise<LeadReportRow[]>;

  /** Los prospectos vivos con alguno de esos E.164, en las sedes del alcance. */
  findByPhoneE164(
    e164s: readonly string[],
    locationIds: LeadLocationScope,
  ): Promise<LeadPhoneMatch[]>;

  /** Un evento VIEW LEAD (LEAD_CALLER_LOOKUP) por prospecto devuelto; nunca el número. */
  auditPhoneLookup(
    leadIds: readonly string[],
    audit: AuditRequestContext,
  ): Promise<void>;
  reasons(kind?: LeadReasonKindCode): Promise<LeadReasonRow[]>;
  createReason(
    kind: LeadReasonKindCode,
    name: string,
    createdById: string,
  ): Promise<LeadReasonRow>;
  /** Borrado lógico; `false` si no existe (o ya estaba retirado). */
  deleteReason(id: string): Promise<boolean>;

  retentionMonths(): Promise<number>;
  setRetentionMonths(months: number): Promise<void>;
}

export const LEAD_RETENTION_REPOSITORY = Symbol('LEAD_RETENTION_REPOSITORY');

/** La retención (trabajo programado, sin usuario ni contexto de petición). */
export interface LeadRetentionRepository {
  tenantIds(): Promise<string[]>;
  /**
   * Anonimiza los perdidos de la clínica con `lostAt` anterior a ahora (BD)
   * menos sus meses, borra sus notas y deja un `audit_event` por prospecto
   * (origin JOB). Devuelve cuántos.
   */
  anonymizeExpired(tenantId: string): Promise<number>;
}
