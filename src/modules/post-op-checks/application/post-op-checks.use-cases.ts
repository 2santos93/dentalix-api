import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ClinicRole } from '@prisma/client';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  phoneRegionOrNull,
  whatsAppDigits,
} from '../../../shared/phone/phone-number';
import {
  POST_OP_ATTEMPT_OUTCOMES,
  POST_OP_MESSAGES,
  POST_OP_NOTE_MAX,
  decideAttempt,
  overdueDays,
  seesClinicalDetail,
  type PostOpAttemptOutcomeCode,
  type PostOpCheckOutcomeCode,
  type PostOpCheckStatusCode,
} from '../domain/post-op-check-rules';
import {
  POST_OP_CHECK_REPOSITORY,
  type PostOpCheckRepository,
  type PostOpCheckRow,
  type PostOpCheckScope,
  type PostOpCheckState,
} from '../domain/post-op-check-repository.port';

export const POST_OP_CHECK_DEFAULT_PAGE_SIZE = 25;
export const POST_OP_CHECK_MAX_PAGE_SIZE = 100;

/** `include`: `overdue` (por defecto) = hoy y los vencidos; `today` = solo hoy. */
export type PostOpCheckInclude = 'overdue' | 'today';

export interface PostOpCheckQuery {
  /** Sede pedida; sin ella, la de la cabecera o las permitidas. */
  locationId?: string;
  include?: PostOpCheckInclude;
  page?: number;
  pageSize?: number;
  role: ClinicRole;
}

export interface PostOpCheckAttemptView {
  id: string;
  outcome: PostOpAttemptOutcomeCode;
  note: string | null;
  byId: string;
  byName: string;
  at: Date;
}

export interface PostOpInstructionView {
  deliveryId: string;
  title: string;
  deliveredAt: Date;
}

/** Una fila de la lista. Lo clínico va a null para recepción (`clinicalHidden`). */
export interface PostOpCheckListItem {
  id: string;
  dueOn: string;
  /** Días de retraso respecto a hoy en la sede (0 = vence hoy). */
  overdueDays: number;
  locationId: string;
  patientId: string;
  patientName: string;
  /** Teléfono tal cual (sin ocultar por baja de avisos: es una llamada clínica). */
  patientPhone: string | null;
  /** Dígitos para wa.me, o null si el número no es válido. */
  whatsAppDigits: string | null;
  professionalId: string;
  professionalName: string | null;
  appointmentId: string | null;
  appointmentStart: Date | null;
  attemptsCount: number;
  clinicalHidden: boolean;
  procedureName: string | null;
  attempts: PostOpCheckAttemptView[] | null;
  instructions: PostOpInstructionView[] | null;
}

export interface PostOpCheckList {
  items: PostOpCheckListItem[];
  total: number;
  /** De `total`, los que vencieron antes de hoy. */
  overdue: number;
  page: number;
  pageSize: number;
}

export interface PostOpCheckCountView {
  total: number;
  overdue: number;
}

export interface RecordPostOpAttemptInput {
  outcome: PostOpAttemptOutcomeCode;
  note?: string | null;
}

export interface PostOpCheckView {
  id: string;
  patientId: string;
  locationId: string;
  status: PostOpCheckStatusCode;
  outcome: PostOpCheckOutcomeCode | null;
  dueOn: string;
  closedAt: Date | null;
  closedById: string | null;
  clinicalEntryId: string | null;
  addendumId: string | null;
  attemptId: string;
  attemptsCount: number;
}

/** Reloj inyectable (los tests fijan «ahora»). */
export const POST_OP_CHECKS_CLOCK = Symbol('POST_OP_CHECKS_CLOCK');
export type PostOpChecksClock = () => Date;

function whole(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/**
 * DX-566 · Control postoperatorio: la lista del día, su contador y el
 * registro del desenlace.
 */
@Injectable()
export class PostOpChecksUseCases {
  constructor(
    @Inject(POST_OP_CHECK_REPOSITORY)
    private readonly repo: PostOpCheckRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(POST_OP_CHECKS_CLOCK)
    private readonly clock: PostOpChecksClock,
  ) {}

  /**
   * Sedes del alcance (DX-089): la pedida (403 si no es de las permitidas);
   * sin ella, la de la cabecera; sin cabecera, las permitidas (todas sin
   * restricción).
   */
  private scope(
    locationId: string | undefined,
    include: PostOpCheckInclude | undefined,
  ): PostOpCheckScope {
    if (locationId) this.tenantContext.assertLocationAllowed(locationId);
    return {
      locationIds: locationId
        ? [locationId]
        : this.tenantContext.scopeLocationIds(),
      onlyToday: include === 'today',
      now: this.clock(),
    };
  }

  async list(query: PostOpCheckQuery): Promise<PostOpCheckList> {
    const page = whole(query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = whole(
      query.pageSize,
      POST_OP_CHECK_DEFAULT_PAGE_SIZE,
      1,
      POST_OP_CHECK_MAX_PAGE_SIZE,
    );
    const result = await this.repo.list(
      this.scope(query.locationId, query.include),
      { page, pageSize },
    );
    const clinical = seesClinicalDetail(query.role);
    return {
      items: result.rows.map((row) => toListItem(row, clinical)),
      total: result.total,
      overdue: result.overdue,
      page,
      pageSize,
    };
  }

  count(query: {
    locationId?: string;
    include?: PostOpCheckInclude;
  }): Promise<PostOpCheckCountView> {
    return this.repo.count(this.scope(query.locationId, query.include));
  }

  /**
   * DX-566 · D6. Solo roles clínicos (el controlador ya lo exige). Bloquea el
   * control; 404 si no existe en la clínica, 403 si es de una sede no
   * permitida, 409 si ya está cerrado. «No contesta» suma un intento (al
   * tercero, «No localizado»); el resto cierra con su desenlace. Al cerrar,
   * el desenlace queda en la historia en la misma transacción.
   */
  async recordAttempt(
    checkId: string,
    input: RecordPostOpAttemptInput,
    actor: { userId: string; role: ClinicRole },
    audit: AuditRequestContext,
  ): Promise<PostOpCheckView> {
    if (!seesClinicalDetail(actor.role)) {
      throw new ForbiddenException(POST_OP_MESSAGES.forbidden);
    }
    if (!POST_OP_ATTEMPT_OUTCOMES.includes(input.outcome)) {
      throw new BadRequestException(POST_OP_MESSAGES.invalidOutcome);
    }
    const note = input.note?.trim() ? input.note.trim() : null;
    if (note !== null && note.length > POST_OP_NOTE_MAX) {
      throw new BadRequestException(POST_OP_MESSAGES.noteTooLong);
    }
    const state: PostOpCheckState | null = await this.repo.recordAttempt(
      { checkId, outcome: input.outcome, note, actorId: actor.userId },
      (locked) => {
        this.tenantContext.assertRecordLocationAllowed(locked.locationId);
        if (locked.status !== 'PENDING') {
          throw new ConflictException(POST_OP_MESSAGES.closed);
        }
        return decideAttempt(locked.noAnswers, input.outcome);
      },
      audit,
    );
    if (!state) throw new NotFoundException(POST_OP_MESSAGES.notFound);
    return state;
  }
}

export function toListItem(
  row: PostOpCheckRow,
  clinical: boolean,
): PostOpCheckListItem {
  return {
    id: row.id,
    dueOn: row.dueOn,
    overdueDays: overdueDays(row.dueOn, row.today),
    locationId: row.locationId,
    patientId: row.patientId,
    patientName: row.patientName,
    patientPhone: row.patientPhone,
    whatsAppDigits: whatsAppDigits(
      row.patientPhone,
      phoneRegionOrNull(row.phoneRegion),
    ),
    professionalId: row.professionalId,
    professionalName: row.professionalName,
    appointmentId: row.appointmentId,
    appointmentStart: row.appointmentStart,
    attemptsCount: row.attempts.length,
    clinicalHidden: !clinical,
    procedureName: clinical ? row.procedureName : null,
    attempts: clinical ? row.attempts : null,
    instructions: clinical ? row.instructions : null,
  };
}
