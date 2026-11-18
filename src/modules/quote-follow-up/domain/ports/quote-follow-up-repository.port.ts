import type { Prisma } from '@prisma/client';
import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { PreparedEmail } from '../../../notifications/email/application/email-outbox.service';
import type { FollowUpSignatureRequestInsert } from '../../../signature-requests/infrastructure/prisma-signature-request.repository';
import type {
  FollowUpContactFacts,
  FollowUpGroupFacts,
  FollowUpSettingsFacts,
  FollowUpSkipReason,
  RecordedStep,
} from '../quote-follow-up-schedule';
import type {
  QuoteFollowUpSettingsInput,
  QuoteFollowUpSettingsSnapshot,
} from '../quote-follow-up-settings';

export const QUOTE_FOLLOW_UP_REPOSITORY = Symbol('QUOTE_FOLLOW_UP_REPOSITORY');
export const QUOTE_FOLLOW_UP_CLOCK = Symbol('QUOTE_FOLLOW_UP_CLOCK');
export type QuoteFollowUpClock = () => Date;

/** Ajustes de una sede viva tal como los ve Ajustes (sin fila = por defecto, apagado). */
export interface LocationQuoteFollowUpSettingsView extends QuoteFollowUpSettingsSnapshot {
  locationId: string;
  locationName: string;
  /** null = la sede nunca se configuró. */
  updatedAt: Date | null;
}

/** Una sede con el seguimiento activo, para el barrido. */
export interface SweepLocation {
  locationId: string;
  settings: FollowUpSettingsFacts;
}

/** Un grupo que podría tener un paso pendiente (el barrido decide cuál). */
export interface SweepCandidate {
  groupId: string;
  presentedAt: Date;
  recorded: RecordedStep[];
}

/** Todo lo que decide un aviso, leído bajo RLS (y, en la transacción, bajo candado). */
export interface FollowUpGroupSnapshot {
  facts: FollowUpGroupFacts;
  settings: FollowUpSettingsFacts | null;
  contact: FollowUpContactFacts;
  patient: { archived: boolean; preferredLanguage: string | null };
  /** Plan → su profesional (quien lo elaboró, DENTIST o ADMIN activo) o null. */
  professionals: Record<string, string | null>;
}

/** Lo que se registra al omitir un paso (y los anteriores SUPERSEDED). */
export interface RecordSkipInput {
  groupId: string;
  step: number;
  superseded: number[];
  reason: FollowUpSkipReason;
  planIds: string[];
  now: Date;
  /** Se vuelve a decidir con la foto bajo candado: false = cambió, no se escribe. */
  stillHolds: (snapshot: FollowUpGroupSnapshot) => boolean;
}

export interface SendInput {
  id: string;
  groupId: string;
  step: number;
  superseded: number[];
  now: Date;
  requests: FollowUpSignatureRequestInsert[];
  email: PreparedEmail;
  recipientMasked: string;
  language: string;
  languageFallbackFrom: string | null;
  stillHolds: (snapshot: FollowUpGroupSnapshot) => boolean;
  /**
   * Cancela los emails aún pendientes de los enlaces que el aviso anula: el
   * del enlace (signature-request) y el del aviso anterior que lo llevaba
   * (quote-follow-up).
   */
  cancelSuperseded: (
    tx: Prisma.TransactionClient,
    superseded: { signatureRequestIds: string[]; followUpMessageIds: string[] },
  ) => Promise<void>;
  /** I1: cupo de emails del seguimiento en 24 h por clínica. */
  dailyCap: number;
  /** I1 (b): el enlace de baja, que se guarda en la misma transacción. */
  optOut: { tokenHash: string; expiresAt: Date };
}

/** DEFERRED (I2): el plan tiene un enlace de la clínica vigente: se aplaza. */
export type WriteOutcome = 'DONE' | 'ALREADY_DONE' | 'CHANGED' | 'DEFERRED';

export interface PauseOutcome {
  kind: 'OK' | 'NOT_FOUND' | 'NOT_OPEN' | 'ALREADY';
  groupId?: string;
  locationId?: string | null;
  pausedAt?: Date | null;
  pausedById?: string | null;
}

/** Fila del informe: un paso registrado con lo que pasó después. */
export interface FollowUpReportRow {
  step: number;
  status: 'SENT' | 'SKIPPED';
  reason: FollowUpSkipReason | null;
  /** Alguna solicitud del envío se abrió (`openedAt`). */
  opened: boolean;
  /** Algún plan del grupo se aceptó en [sentAt, sentAt + 14 d]. */
  acceptedWithin14Days: boolean;
}

export interface FollowUpReportScope {
  /** Instantes [desde, hasta) del período en la zona de cada sede. */
  periods: { locationId: string; from: Date; to: Date }[];
  /** Solo los grupos cuyo plan raíz elaboró este usuario (DENTIST, OWN). */
  professionalId?: string;
}

export interface QuoteFollowUpRepository {
  listSettings(): Promise<LocationQuoteFollowUpSettingsView[]>;
  saveSettings(
    locationId: string,
    input: QuoteFollowUpSettingsInput,
    audit: AuditRequestContext,
  ): Promise<LocationQuoteFollowUpSettingsView | null>;

  /** Clínicas vivas (`tenants` no tiene RLS). */
  tenantIds(): Promise<string[]>;
  sweepLocations(tenantId: string): Promise<SweepLocation[]>;
  sweepCandidates(
    tenantId: string,
    locationId: string,
    presentedSince: Date,
    now: Date,
  ): Promise<SweepCandidate[]>;
  /** I1: emails `quote-follow-up` de la clínica en las últimas 24 h. */
  followUpEmailsLast24h(tenantId: string): Promise<number>;

  /** La foto del grupo (clínica del contexto); null si no existe o nunca se presentó. */
  loadGroup(groupId: string, now: Date): Promise<FollowUpGroupSnapshot | null>;
  recordSkip(input: RecordSkipInput): Promise<WriteOutcome>;
  send(input: SendInput): Promise<WriteOutcome>;

  setPaused(input: {
    planId: string;
    paused: boolean;
    userId: string;
    now: Date;
    /** SEC-045: las sedes de presentación del grupo (403 si el miembro no ve alguna), bajo candado. */
    assertLocation: (locationIds: string[]) => void;
  }): Promise<PauseOutcome>;

  reportRows(scope: FollowUpReportScope): Promise<FollowUpReportRow[]>;
  /** Sedes vivas que ve quien consulta (DX-089), con su zona (o null). */
  reportLocations(allowed: AllowedLocations): Promise<ReportLocation[]>;
}

export interface ReportLocation {
  id: string;
  name: string;
  timeZone: string | null;
}

/** I1: el seguimiento superó su cupo de emails de 24 h en la clínica. */
export class FollowUpQuotaExceededError extends Error {
  constructor() {
    super('Cupo diario del seguimiento de presupuestos agotado');
    this.name = 'FollowUpQuotaExceededError';
  }
}
