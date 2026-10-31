import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ClosingDismissalReason,
  ClosingQueueSection,
} from '@prisma/client';
import {
  isLocationAllowed,
  locationNotAllowed,
  type AllowedLocations,
} from '../../../shared/tenancy/location-access';
import { requireLocationTimeZone } from '../../../shared/locations/location-time-zone';
import {
  isValidTimeZone,
  PERIOD_DAY_MIN,
  PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
  type ZonedPeriodBranch,
} from '../../../shared/time/civil-day';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  checkClosingPeriod,
  checkDismissal,
  CLOSING_QUEUE_DEFAULT_DAYS,
  CLOSING_QUEUE_SECTION_LIMIT,
  closingProfessional,
  closingWindow,
  sectionsFor,
  type ClosingActor,
  type DismissalInput,
  type DismissalProblem,
} from '../domain/closing-queue-rules';
import {
  CLOSING_QUEUE_NOW,
  CLOSING_QUEUE_REPOSITORY,
  DismissalExistsError,
  type ClosingAppointmentRow,
  type ClosingQueueRepository,
  type ClosingScope,
  type ClosingTreatmentRow,
  type SectionPage,
} from '../domain/ports/closing-queue-repository.port';

export const CLOSING_QUEUE_FORBIDDEN_MESSAGE =
  'Solo la administración, los odontólogos y recepción ven «Pendiente de cerrar».';
export const CLOSING_OWN_ONLY_MESSAGE =
  'Solo puedes ver y cerrar tus propias citas.';
export const CLOSING_SECTION_FORBIDDEN_MESSAGE =
  'Tu rol no cierra esta sección de «Pendiente de cerrar».';
export const CLOSING_INVALID_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const CLOSING_PERIOD_TOO_LONG_MESSAGE =
  'El período admite como mucho 92 días.';
export const DISMISSAL_REASON_TEXT_MESSAGE =
  'Con el motivo «Otro», escribe el motivo (de 3 a 200 caracteres).';
export const DISMISSAL_PLAN_ITEM_REQUIRED_MESSAGE =
  'Indica el tratamiento (planItemId) que descartas.';
export const DISMISSAL_PLAN_ITEM_NOT_ALLOWED_MESSAGE =
  'Solo la sección de tratamiento lleva planItemId.';
export const DISMISSAL_APPOINTMENT_NOT_FOUND_MESSAGE =
  'La cita no existe en esta clínica.';
export const DISMISSAL_NOT_PENDING_MESSAGE =
  'Ese pendiente ya no está en «Pendiente de cerrar»: se cerró o ya se descartó.';

const DISMISSAL_MESSAGES: Record<DismissalProblem, string> = {
  REASON_TEXT: DISMISSAL_REASON_TEXT_MESSAGE,
  PLAN_ITEM_REQUIRED: DISMISSAL_PLAN_ITEM_REQUIRED_MESSAGE,
  PLAN_ITEM_NOT_ALLOWED: DISMISSAL_PLAN_ITEM_NOT_ALLOWED_MESSAGE,
};

export interface ClosingQueueQuery {
  locationId?: string;
  from?: string;
  to?: string;
  professionalId?: string;
  actor: ClosingActor;
  /** Sedes del usuario (claim `loc`, DX-089). */
  allowedLocationIds: AllowedLocations;
  /** Sede activa (cabecera X-Location-Id): acota si no se pide `locationId`. */
  activeLocationId?: string;
}

export interface ClosingSection<T> {
  /** Cuántos hay (exacto aunque `items` llegue recortado). */
  total: number;
  /** Del más antiguo al más reciente, como mucho 200. */
  items: T[];
}

export interface ClosingQueue {
  from: string | null;
  to: string | null;
  defaultDays: number;
  sections: ClosingQueueSection[];
  outcome: ClosingSection<ClosingAppointmentRow> | null;
  evolution: ClosingSection<ClosingAppointmentRow> | null;
  treatment: ClosingSection<ClosingTreatmentRow> | null;
  /** Citas de días anteriores aún «en la clínica» (DX-237): solo se enlazan. */
  staleInClinic: number | null;
  total: number;
  locations: { id: string; name: string }[];
}

export interface ClosingQueueCount {
  total: number;
  outcome: number | null;
  evolution: number | null;
  treatment: number | null;
}

export interface DismissalResult {
  id: string;
  section: ClosingQueueSection;
  appointmentId: string;
  planItemId: string | null;
  reasonCode: ClosingDismissalReason;
  createdAt: Date;
}

interface Resolved {
  sections: ClosingQueueSection[];
  scope: ClosingScope;
  locations: { id: string; name: string }[];
  from: string | null;
  to: string | null;
}

/**
 * «Pendiente de cerrar» (DX-439): las citas de días anteriores que quedaron
 * sin desenlace, atendidas sin evolución o con tratamiento ligado sin marcar
 * como hecho. Cerrar se hace con los endpoints de siempre (estado de la cita,
 * evolución, ítem DONE); aquí solo se lista y se descarta con motivo.
 */
@Injectable()
export class ClosingQueueUseCases {
  constructor(
    @Inject(CLOSING_QUEUE_REPOSITORY)
    private readonly repo: ClosingQueueRepository,
    @Inject(CLOSING_QUEUE_NOW)
    private readonly now: () => Date,
  ) {}

  private async resolve(query: ClosingQueueQuery): Promise<Resolved> {
    const sections = sectionsFor(query.actor.role);
    if (sections.length === 0) {
      throw new ForbiddenException(CLOSING_QUEUE_FORBIDDEN_MESSAGE);
    }
    const professional = closingProfessional(query.actor, query.professionalId);
    if (!professional.ok) {
      throw new ForbiddenException(CLOSING_OWN_ONLY_MESSAGE);
    }
    const period = checkClosingPeriod(query.from, query.to);
    if (!period.ok) {
      throw new BadRequestException(
        period.problem === 'OUT_OF_RANGE'
          ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
          : period.problem === 'TOO_LONG'
            ? CLOSING_PERIOD_TOO_LONG_MESSAGE
            : CLOSING_INVALID_PERIOD_MESSAGE,
      );
    }
    const locationId = query.locationId ?? query.activeLocationId;
    const all = await this.repo.listLocations(query.allowedLocationIds);
    // Sede ajena a la clínica o no permitida: el MISMO 403, para no decir
    // qué sedes existen.
    if (
      locationId !== undefined &&
      (!isLocationAllowed(query.allowedLocationIds, locationId) ||
        !all.some((l) => l.id === locationId))
    ) {
      throw locationNotAllowed();
    }
    const picked =
      locationId === undefined ? all : all.filter((l) => l.id === locationId);
    // Una sede pedida necesita su zona (409 si no la tiene); entre varias, una
    // sin zona no tiene «hoy» y se queda fuera.
    if (locationId !== undefined) requireLocationTimeZone(picked[0]);
    const zones = new Map(
      picked
        .filter((l) => l.timeZone !== null && isValidTimeZone(l.timeZone))
        .map((l) => [l.id, l.timeZone!] as const),
    );
    const branches = closingWindow(this.now(), zones, {
      from: period.from,
      to: period.to,
    });
    return {
      sections,
      scope: {
        branches,
        ...(professional.professionalId !== undefined
          ? { professionalId: professional.professionalId }
          : {}),
      },
      locations: all.map((l) => ({ id: l.id, name: l.name })),
      from: period.from ?? null,
      to: period.to ?? null,
    };
  }

  private section<T>(
    visible: boolean,
    scope: ClosingScope,
    read: (scope: ClosingScope, limit: number) => Promise<SectionPage<T>>,
    limit: number,
  ): Promise<SectionPage<T> | null> {
    if (!visible) return Promise.resolve(null);
    if (scope.branches.length === 0) {
      return Promise.resolve({ rows: [], total: 0 });
    }
    return read(scope, limit);
  }

  private async read(resolved: Resolved, limit: number) {
    const { sections, scope } = resolved;
    const has = (s: ClosingQueueSection) => sections.includes(s);
    const [outcome, evolution, treatment, stale] = await Promise.all([
      this.section(
        has('OUTCOME'),
        scope,
        (s, l) => this.repo.outcome(s, l),
        limit,
      ),
      this.section(
        has('EVOLUTION'),
        scope,
        (s, l) => this.repo.evolution(s, l),
        limit,
      ),
      this.section(
        has('TREATMENT'),
        scope,
        (s, l) => this.repo.treatment(s, l),
        limit,
      ),
      has('OUTCOME') && scope.branches.length > 0
        ? this.repo.staleInClinic(scope)
        : Promise.resolve(has('OUTCOME') ? 0 : null),
    ]);
    const total =
      (outcome?.total ?? 0) + (evolution?.total ?? 0) + (treatment?.total ?? 0);
    return { outcome, evolution, treatment, stale, total };
  }

  async list(query: ClosingQueueQuery): Promise<ClosingQueue> {
    const resolved = await this.resolve(query);
    const r = await this.read(resolved, CLOSING_QUEUE_SECTION_LIMIT);
    const view = <T>(page: SectionPage<T> | null): ClosingSection<T> | null =>
      page === null ? null : { total: page.total, items: page.rows };
    return {
      from: resolved.from,
      to: resolved.to,
      defaultDays: CLOSING_QUEUE_DEFAULT_DAYS,
      sections: resolved.sections,
      outcome: view(r.outcome),
      evolution: view(r.evolution),
      treatment: view(r.treatment),
      staleInClinic: r.stale,
      total: r.total,
      locations: resolved.locations,
    };
  }

  /** El contador del menú: mismos filtros, sin filas. */
  async count(query: ClosingQueueQuery): Promise<ClosingQueueCount> {
    const r = await this.read(await this.resolve(query), 1);
    return {
      total: r.total,
      outcome: r.outcome?.total ?? null,
      evolution: r.evolution?.total ?? null,
      treatment: r.treatment?.total ?? null,
    };
  }

  /**
   * Descarta UN pendiente con su motivo: comprueba que el rol cierra esa
   * sección, que la cita es de una sede permitida (y suya, si es DENTIST) y
   * que sigue pendiente; no toca la cita. Descarte y auditoría van juntos.
   */
  async dismiss(
    input: DismissalInput,
    actor: ClosingActor,
    allowed: AllowedLocations,
    ctx: AuditRequestContext,
  ): Promise<DismissalResult> {
    const checked = checkDismissal(input);
    if (!checked.ok) {
      throw new BadRequestException(DISMISSAL_MESSAGES[checked.problem]);
    }
    const dismissal = checked.value;
    if (!sectionsFor(actor.role).includes(dismissal.section)) {
      throw new ForbiddenException(CLOSING_SECTION_FORBIDDEN_MESSAGE);
    }
    const appointment = await this.repo.findAppointment(
      dismissal.appointmentId,
    );
    if (!appointment) {
      throw new NotFoundException(DISMISSAL_APPOINTMENT_NOT_FOUND_MESSAGE);
    }
    if (!isLocationAllowed(allowed, appointment.locationId)) {
      throw locationNotAllowed();
    }
    const professional = closingProfessional(actor, undefined);
    if (
      professional.ok &&
      professional.professionalId !== undefined &&
      professional.professionalId !== appointment.providerId
    ) {
      throw new ForbiddenException(CLOSING_OWN_ONLY_MESSAGE);
    }
    const [location] = await this.repo.listLocations([appointment.locationId]);
    const zone = requireLocationTimeZone(
      location ?? { id: appointment.locationId, timeZone: null },
    );
    // Pendiente en cualquier día anterior a hoy, no solo en la ventana de la
    // lista: se descarta lo que se ve con cualquier período.
    const branches: ZonedPeriodBranch[] = closingWindow(
      this.now(),
      new Map([[appointment.locationId, zone]]),
      { from: PERIOD_DAY_MIN },
    );
    const scope: ClosingScope = {
      branches,
      appointmentId: appointment.id,
      ...(dismissal.planItemId !== null
        ? { planItemId: dismissal.planItemId }
        : {}),
    };
    const pending =
      branches.length === 0
        ? { total: 0 }
        : dismissal.section === 'OUTCOME'
          ? await this.repo.outcome(scope, 1)
          : dismissal.section === 'EVOLUTION'
            ? await this.repo.evolution(scope, 1)
            : await this.repo.treatment(scope, 1);
    if (pending.total === 0) {
      throw new ConflictException(DISMISSAL_NOT_PENDING_MESSAGE);
    }
    try {
      const saved = await this.repo.createDismissal(
        {
          ...dismissal,
          patientId: appointment.patientId,
          locationId: appointment.locationId,
        },
        ctx,
      );
      return {
        id: saved.id,
        section: dismissal.section,
        appointmentId: dismissal.appointmentId,
        planItemId: dismissal.planItemId,
        reasonCode: dismissal.reasonCode,
        createdAt: saved.createdAt,
      };
    } catch (err) {
      if (err instanceof DismissalExistsError) {
        throw new ConflictException(DISMISSAL_NOT_PENDING_MESSAGE);
      }
      throw err;
    }
  }
}
