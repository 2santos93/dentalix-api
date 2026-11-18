import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { locationNotAllowed } from '../../../shared/tenancy/location-access';
import {
  parsePhone,
  phoneRegionOrNull,
} from '../../../shared/phone/phone-number';
import {
  LEAD_AMBIGUOUS_PATIENTS_CODE,
  LEAD_MESSAGES,
  LEAD_STAGES,
  PREDEFINED_LEAD_REASONS,
  cleanText,
  decideManualMove,
  matchCatalogReason,
  splitFullName,
  stepRate,
  type LeadChannelCode,
  type LeadReasonKindCode,
  type LeadStageCode,
} from '../domain/lead-rules';
import {
  LEAD_REPOSITORY,
  type ConvertDecision,
  type LeadListFilter,
  type LeadLocationScope,
  type LeadNoteRow,
  type LeadReportRow,
  type LeadRepository,
  type LeadRow,
  type LockedLead,
  type UpdateLeadPatch,
} from '../domain/lead-repository.port';
import { phoneTakenError } from './lead-errors';

export const LEAD_DEFAULT_PAGE_SIZE = 25;
export const LEAD_MAX_PAGE_SIZE = 100;
export const LEAD_BOARD_DEFAULT_PER_STAGE = 30;
export const LEAD_BOARD_MAX_PER_STAGE = 100;

export interface LeadView {
  id: string;
  locationId: string;
  locationName: string;
  fullName: string;
  phone: string | null;
  /** Dígitos para wa.me (el E.164 sin «+»), o null si está anonimizado. */
  whatsAppDigits: string | null;
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
  anonymized: boolean;
  /** «Sin contactar hace más de 24 h» (cuenta en «Mi día»). */
  stale: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeadDetailView extends LeadView {
  notes: LeadNoteRow[];
}

export interface LeadListView {
  items: LeadView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LeadBoardView {
  columns: { stage: LeadStageCode; total: number; items: LeadView[] }[];
}

export interface LeadReportLine {
  key: string | null;
  label: string | null;
  leads: number;
  scheduled: number;
  attended: number;
  /** Con cita / prospectos. */
  scheduledRate: number;
  /** Asistieron / con cita. */
  attendedRate: number;
  /** Asistieron / prospectos. */
  conversionRate: number;
}

export interface LeadReportView {
  from: Date;
  to: Date;
  totals: LeadReportLine;
  byChannel: LeadReportLine[];
  byOwner: LeadReportLine[];
}

export interface CreateLeadInput {
  fullName: string;
  phone: string;
  channel: LeadChannelCode;
  interestReason?: string | null;
  locationId?: string;
  ownerId?: string | null;
  nextActionAt?: Date | null;
  nextActionNote?: string | null;
}

export type UpdateLeadInput = Partial<
  Omit<CreateLeadInput, 'locationId'> & { locationId: string }
>;

export interface LeadQuery {
  locationId?: string;
  stage?: LeadStageCode;
  channel?: LeadChannelCode;
  ownerId?: string;
  unowned?: boolean;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
  reached?: 'SCHEDULED' | 'ATTENDED';
  stale?: boolean;
  page?: number;
  pageSize?: number;
}

/** DX-556 en «¿Quién llama?»: un prospecto con ese número. */
export interface CallerLeadMatch {
  id: string;
  fullName: string;
  stage: LeadStageCode;
  locationId: string;
  convertedPatientId: string | null;
}

export interface ConvertLeadInput {
  firstName?: string;
  lastName?: string;
  patientId?: string;
}

export interface ConvertLeadView {
  patientId: string;
  /** Se creó la ficha ahora (no existía). */
  created: boolean;
  /** Se enlazó a un paciente que ya tenía ese teléfono. */
  linked: boolean;
  lead: LeadView;
}

function whole(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export function toLeadView(row: LeadRow): LeadView {
  return {
    id: row.id,
    locationId: row.locationId,
    locationName: row.locationName,
    fullName: row.fullName,
    phone: row.phone,
    whatsAppDigits: row.phoneE164 ? row.phoneE164.slice(1) : null,
    channel: row.channel,
    interestReason: row.interestReason,
    stage: row.stage,
    lostReason: row.lostReason,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    nextActionAt: row.nextActionAt,
    nextActionNote: row.nextActionNote,
    lastContactAt: row.lastContactAt,
    scheduledAt: row.scheduledAt,
    attendedAt: row.attendedAt,
    lostAt: row.lostAt,
    convertedPatientId: row.convertedPatientId,
    convertedAt: row.convertedAt,
    firstAppointmentId: row.firstAppointmentId,
    anonymized: row.anonymizedAt !== null,
    stale: row.stale,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function reportLine(row: LeadReportRow): LeadReportLine {
  return {
    key: row.key,
    label: row.label,
    leads: row.leads,
    scheduled: row.scheduled,
    attended: row.attended,
    scheduledRate: stepRate(row.scheduled, row.leads),
    attendedRate: stepRate(row.attended, row.scheduled),
    conversionRate: stepRate(row.attended, row.leads),
  };
}

/**
 * DX-556 · Prospectos: alta (con aviso de teléfono repetido), edición, etapas,
 * notas, conversión idempotente en paciente, lista, tablero, contador de
 * «Mi día», informe de conversión, catálogo de motivos y ajustes. Solo ADMIN
 * y RECEPTION (el controlador); por sedes (DX-089).
 */
@Injectable()
export class LeadsUseCases {
  constructor(
    @Inject(LEAD_REPOSITORY) private readonly repo: LeadRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  // -------------------------------------------------------------------------
  // Alcance y validación
  // -------------------------------------------------------------------------

  /** Sede pedida (403 si no es permitida o no es de la clínica) o el alcance. */
  private async scope(locationId?: string): Promise<LeadLocationScope> {
    if (locationId) {
      this.tenantContext.assertLocationAllowed(locationId);
      if (!(await this.repo.locationExists(locationId))) {
        throw locationNotAllowed();
      }
      return [locationId];
    }
    return this.tenantContext.scopeLocationIds();
  }

  private assertWritable(locked: LockedLead): void {
    this.tenantContext.assertRecordLocationAllowed(locked.locationId);
    if (locked.anonymizedAt) {
      throw new ConflictException(LEAD_MESSAGES.anonymized);
    }
  }

  private async readPhone(
    text: string,
    locationId: string,
  ): Promise<{ phone: string; phoneE164: string }> {
    const region = phoneRegionOrNull(await this.repo.phoneRegionOf(locationId));
    const parsed = parsePhone(text, region);
    if (!parsed) throw new BadRequestException(LEAD_MESSAGES.phoneInvalid);
    return { phone: parsed.international, phoneE164: parsed.e164 };
  }

  /**
   * 409 si el número ya es de un paciente vivo o de otro prospecto. Del
   * prospecto de una sede no permitida no se dice cuál (sin id ni nombre).
   */
  private async assertPhoneFree(
    phoneE164: string,
    exclude?: { leadId: string; patientId: string | null },
  ): Promise<void> {
    const owners = await this.repo.phoneOwners(phoneE164, exclude?.leadId);
    const patient = owners.patients.find((p) => p.id !== exclude?.patientId);
    if (patient) {
      throw phoneTakenError({
        kind: 'PATIENT',
        id: patient.id,
        name: `${patient.firstName} ${patient.lastName}`.trim(),
      });
    }
    if (owners.lead) {
      const allowed = this.tenantContext.getAllowedLocationIds();
      const visible =
        allowed === 'ALL' || allowed.includes(owners.lead.locationId);
      throw phoneTakenError({
        kind: 'LEAD',
        id: visible ? owners.lead.id : null,
        name: visible ? owners.lead.fullName : null,
      });
    }
  }

  private async catalog(kind: LeadReasonKindCode): Promise<string[]> {
    const own = (await this.repo.reasons(kind)).map((r) => r.name);
    return [...PREDEFINED_LEAD_REASONS[kind], ...own];
  }

  private async reasonOf(
    kind: LeadReasonKindCode,
    value: string | null | undefined,
  ): Promise<string | null> {
    if (value === undefined || value === null || !cleanText(value)) {
      return null;
    }
    const found = matchCatalogReason(value, await this.catalog(kind));
    if (!found) throw new BadRequestException(LEAD_MESSAGES.reasonNotInCatalog);
    return found;
  }

  private async ownerOf(ownerId: string | null): Promise<string | null> {
    if (ownerId === null) return null;
    if (!(await this.repo.isEligibleOwner(ownerId))) {
      throw new BadRequestException(LEAD_MESSAGES.ownerInvalid);
    }
    return ownerId;
  }

  private nextAction(
    at: Date | null | undefined,
    note: string | null | undefined,
  ): { nextActionAt: Date | null; nextActionNote: string | null } {
    const nextActionNote = cleanText(note);
    const nextActionAt = at ?? null;
    if (nextActionNote && !nextActionAt) {
      throw new BadRequestException(LEAD_MESSAGES.nextActionNoteWithoutDate);
    }
    return { nextActionAt, nextActionNote };
  }

  // -------------------------------------------------------------------------
  // Escrituras
  // -------------------------------------------------------------------------

  async create(
    input: CreateLeadInput,
    audit: AuditRequestContext,
  ): Promise<LeadView> {
    let locationId: string;
    if (input.locationId) {
      [locationId] = (await this.scope(input.locationId)) as string[];
    } else {
      locationId = await this.repo.writeLocationId();
    }
    const fullName = cleanText(input.fullName);
    if (!fullName) {
      throw new BadRequestException('Escribe el nombre del prospecto.');
    }
    const { phone, phoneE164 } = await this.readPhone(input.phone, locationId);
    await this.assertPhoneFree(phoneE164);
    const row = await this.repo.create(
      {
        locationId,
        fullName,
        phone,
        phoneE164,
        channel: input.channel,
        interestReason: await this.reasonOf('INTEREST', input.interestReason),
        // Sin responsable elegido, quien lo da de alta.
        ownerId: await this.ownerOf(
          input.ownerId === undefined ? audit.actor.userId : input.ownerId,
        ),
        ...this.nextAction(input.nextActionAt, input.nextActionNote),
        createdById: audit.actor.userId,
      },
      audit,
    );
    return toLeadView(row);
  }

  async update(
    id: string,
    input: UpdateLeadInput,
    audit: AuditRequestContext,
  ): Promise<LeadView> {
    const current = await this.repo.findById(id);
    if (!current) throw new NotFoundException(LEAD_MESSAGES.notFound);
    this.tenantContext.assertRecordLocationAllowed(current.locationId);
    if (current.anonymizedAt) {
      throw new ConflictException(LEAD_MESSAGES.anonymized);
    }

    const patch: UpdateLeadPatch = {};
    const changed: string[] = [];
    if (
      input.locationId !== undefined &&
      input.locationId !== current.locationId
    ) {
      await this.scope(input.locationId);
      patch.locationId = input.locationId;
      changed.push('locationId');
    }
    if (input.fullName !== undefined) {
      const fullName = cleanText(input.fullName);
      if (!fullName) {
        throw new BadRequestException('Escribe el nombre del prospecto.');
      }
      patch.fullName = fullName;
      changed.push('fullName');
    }
    if (input.phone !== undefined) {
      const read = await this.readPhone(
        input.phone,
        patch.locationId ?? current.locationId,
      );
      if (read.phoneE164 !== current.phoneE164) {
        await this.assertPhoneFree(read.phoneE164, {
          leadId: id,
          patientId: current.convertedPatientId,
        });
      }
      patch.phone = read.phone;
      patch.phoneE164 = read.phoneE164;
      changed.push('phone');
    }
    if (input.channel !== undefined) {
      patch.channel = input.channel;
      changed.push('channel');
    }
    if (input.interestReason !== undefined) {
      patch.interestReason = await this.reasonOf(
        'INTEREST',
        input.interestReason,
      );
      changed.push('interestReason');
    }
    if (input.ownerId !== undefined) {
      patch.ownerId = await this.ownerOf(input.ownerId);
      changed.push('ownerId');
    }
    if (
      input.nextActionAt !== undefined ||
      input.nextActionNote !== undefined
    ) {
      const next = this.nextAction(
        input.nextActionAt !== undefined
          ? input.nextActionAt
          : current.nextActionAt,
        input.nextActionNote !== undefined
          ? input.nextActionNote
          : current.nextActionNote,
      );
      patch.nextActionAt = next.nextActionAt;
      patch.nextActionNote = next.nextActionNote;
      changed.push('nextAction');
    }

    const row = await this.repo.update(
      id,
      patch,
      (locked) => this.assertWritable(locked),
      changed,
      audit,
    );
    if (!row) throw new NotFoundException(LEAD_MESSAGES.notFound);
    return toLeadView(row);
  }

  async changeStage(
    id: string,
    input: { stage: LeadStageCode; lostReason?: string | null },
    audit: AuditRequestContext,
  ): Promise<LeadView> {
    const lostReason =
      input.stage === 'LOST'
        ? await this.reasonOf('LOSS', input.lostReason ?? null)
        : null;
    const row = await this.repo.changeStage(
      id,
      (locked) => {
        this.assertWritable(locked);
        const decision = decideManualMove(
          locked.stage,
          input.stage,
          lostReason,
        );
        if (!decision.ok) {
          switch (decision.reason) {
            case 'LOST_REASON':
              throw new BadRequestException(LEAD_MESSAGES.lostReasonRequired);
            case 'BY_APPOINTMENT':
              throw new ConflictException(LEAD_MESSAGES.stageByAppointment);
            case 'SAME':
              throw new ConflictException(LEAD_MESSAGES.sameStage);
            default:
              throw new ConflictException(LEAD_MESSAGES.stageNotAllowed);
          }
        }
        return { to: input.stage, lostReason };
      },
      audit,
    );
    if (!row) throw new NotFoundException(LEAD_MESSAGES.notFound);
    return toLeadView(row);
  }

  async addNote(
    id: string,
    body: string,
    audit: AuditRequestContext,
  ): Promise<LeadNoteRow> {
    const text = body.trim();
    if (!text) throw new BadRequestException('Escribe la nota.');
    const note = await this.repo.addNote(
      id,
      text,
      (locked) => this.assertWritable(locked),
      audit,
    );
    if (!note) throw new NotFoundException(LEAD_MESSAGES.notFound);
    return note;
  }

  async convert(
    id: string,
    input: ConvertLeadInput,
    audit: AuditRequestContext,
  ): Promise<ConvertLeadView> {
    const result = await this.repo.convert(
      id,
      (locked, candidates): ConvertDecision => {
        this.tenantContext.assertRecordLocationAllowed(locked.locationId);
        // Idempotente: el segundo «Convertir» devuelve el mismo paciente.
        if (locked.convertedPatientId) {
          return { kind: 'EXISTING', patientId: locked.convertedPatientId };
        }
        if (locked.anonymizedAt) {
          throw new ConflictException(LEAD_MESSAGES.anonymized);
        }
        if (input.patientId) {
          if (!candidates.some((c) => c.id === input.patientId)) {
            throw new BadRequestException(LEAD_MESSAGES.patientNotCandidate);
          }
          return { kind: 'LINK', patientId: input.patientId };
        }
        if (candidates.length === 1) {
          return { kind: 'LINK', patientId: candidates[0].id };
        }
        if (candidates.length > 1) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: LEAD_AMBIGUOUS_PATIENTS_CODE,
            message: LEAD_MESSAGES.ambiguousPatients,
            candidates: candidates.map((c) => ({
              id: c.id,
              name: `${c.firstName} ${c.lastName}`.trim(),
            })),
          });
        }
        const split = splitFullName(locked.fullName);
        const firstName = cleanText(input.firstName) ?? split.firstName;
        const lastName = cleanText(input.lastName) ?? split.lastName;
        if (!firstName) {
          throw new BadRequestException('Escribe el nombre del paciente.');
        }
        if (!lastName) {
          throw new BadRequestException(LEAD_MESSAGES.lastNameRequired);
        }
        return { kind: 'CREATE', firstName, lastName };
      },
      audit,
    );
    if (!result) throw new NotFoundException(LEAD_MESSAGES.notFound);
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException(LEAD_MESSAGES.notFound);
    return { ...result, lead: toLeadView(row) };
  }

  // -------------------------------------------------------------------------
  // Lecturas
  // -------------------------------------------------------------------------

  async get(id: string): Promise<LeadDetailView> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException(LEAD_MESSAGES.notFound);
    this.tenantContext.assertRecordLocationAllowed(row.locationId);
    return { ...toLeadView(row), notes: await this.repo.notes(id) };
  }

  private async filter(query: LeadQuery): Promise<LeadListFilter> {
    if (
      query.createdFrom &&
      query.createdTo &&
      query.createdFrom >= query.createdTo
    ) {
      throw new BadRequestException(LEAD_MESSAGES.rangeInvalid);
    }
    return {
      locationIds: await this.scope(query.locationId),
      stage: query.stage,
      channel: query.channel,
      ownerId: query.ownerId,
      unowned: query.unowned,
      q: query.q,
      createdFrom: query.createdFrom,
      createdTo: query.createdTo,
      reached: query.reached,
      stale: query.stale,
    };
  }

  async list(query: LeadQuery): Promise<LeadListView> {
    const page = whole(query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = whole(
      query.pageSize,
      LEAD_DEFAULT_PAGE_SIZE,
      1,
      LEAD_MAX_PAGE_SIZE,
    );
    const result = await this.repo.list(await this.filter(query), {
      page,
      pageSize,
    });
    return {
      items: result.rows.map(toLeadView),
      total: result.total,
      page,
      pageSize,
    };
  }

  async board(
    query: Omit<
      LeadQuery,
      'stage' | 'stale' | 'reached' | 'page' | 'pageSize'
    > & {
      perStage?: number;
    },
  ): Promise<LeadBoardView> {
    const perStage = whole(
      query.perStage,
      LEAD_BOARD_DEFAULT_PER_STAGE,
      1,
      LEAD_BOARD_MAX_PER_STAGE,
    );
    const columns = await this.repo.board(await this.filter(query), perStage);
    return {
      columns: LEAD_STAGES.map((stage) => {
        const column = columns.find((c) => c.stage === stage);
        return {
          stage,
          total: column?.total ?? 0,
          items: (column?.rows ?? []).map(toLeadView),
        };
      }),
    };
  }

  /** Abiertos y «sin contactar hace más de 24 h» del alcance (Mi día). */
  async count(query: { locationId?: string }): Promise<{
    open: number;
    stale: number;
  }> {
    return this.repo.count(await this.scope(query.locationId));
  }

  async report(query: {
    locationId?: string;
    from: Date;
    to: Date;
  }): Promise<LeadReportView> {
    if (query.from >= query.to) {
      throw new BadRequestException(LEAD_MESSAGES.rangeInvalid);
    }
    const filter = {
      locationIds: await this.scope(query.locationId),
      createdFrom: query.from,
      createdTo: query.to,
    };
    const [byChannel, byOwner] = await Promise.all([
      this.repo.report(filter, 'channel'),
      this.repo.report(filter, 'owner'),
    ]);
    const sum = (k: 'leads' | 'scheduled' | 'attended') =>
      byChannel.reduce((acc, r) => acc + r[k], 0);
    return {
      from: query.from,
      to: query.to,
      totals: reportLine({
        key: null,
        label: null,
        leads: sum('leads'),
        scheduled: sum('scheduled'),
        attended: sum('attended'),
      }),
      byChannel: byChannel.map(reportLine),
      byOwner: byOwner.map(reportLine),
    };
  }

  /**
   * «¿Quién llama?» (DX-224 + DX-556): los prospectos vivos con alguno de
   * esos E.164 en las sedes del usuario. Sin número válido, ninguno.
   */
  async byPhones(e164s: readonly string[]): Promise<CallerLeadMatch[]> {
    if (e164s.length === 0) return [];
    return this.repo.findByPhoneE164(
      e164s,
      this.tenantContext.scopeLocationIds(),
    );
  }

  owners(): Promise<{ userId: string; fullName: string; role: string }[]> {
    return this.repo.owners();
  }

  // -------------------------------------------------------------------------
  // Catálogo y ajustes
  // -------------------------------------------------------------------------

  async reasons(kind?: LeadReasonKindCode): Promise<
    {
      id: string | null;
      kind: LeadReasonKindCode;
      name: string;
      predefined: boolean;
    }[]
  > {
    const kinds: LeadReasonKindCode[] = kind ? [kind] : ['INTEREST', 'LOSS'];
    const own = await this.repo.reasons(kind);
    return kinds.flatMap((k) => [
      ...PREDEFINED_LEAD_REASONS[k].map((name) => ({
        id: null,
        kind: k,
        name,
        predefined: true,
      })),
      ...own
        .filter((r) => r.kind === k)
        .map((r) => ({ id: r.id, kind: k, name: r.name, predefined: false })),
    ]);
  }

  async createReason(
    kind: LeadReasonKindCode,
    name: string,
    createdById: string,
  ): Promise<{ id: string; kind: LeadReasonKindCode; name: string }> {
    const clean = cleanText(name);
    if (!clean || clean.length < 2 || clean.length > 60) {
      throw new BadRequestException('El motivo va de 2 a 60 caracteres.');
    }
    if (matchCatalogReason(clean, await this.catalog(kind))) {
      throw new ConflictException(LEAD_MESSAGES.reasonTaken);
    }
    return this.repo.createReason(kind, clean, createdById);
  }

  async deleteReason(id: string): Promise<void> {
    if (!(await this.repo.deleteReason(id))) {
      throw new NotFoundException(LEAD_MESSAGES.reasonNotFound);
    }
  }

  async settings(): Promise<{ lostRetentionMonths: number }> {
    return { lostRetentionMonths: await this.repo.retentionMonths() };
  }

  async updateSettings(
    months: number,
  ): Promise<{ lostRetentionMonths: number }> {
    await this.repo.setRetentionMonths(months);
    return { lostRetentionMonths: months };
  }
}
