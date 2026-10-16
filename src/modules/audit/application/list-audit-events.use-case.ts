import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { AuditAction, AuditResourceType } from '@prisma/client';
import {
  AUDIT_EVENT_REPOSITORY,
  type AuditEventRepository,
} from '../domain/ports/audit-event-repository.port';
import type { AuditEventFilter, AuditEventView } from '../domain/audit-event';
import { decodeAuditCursor, encodeAuditCursor } from '../domain/audit-cursor';

export type AuditClock = () => Date;
export const AUDIT_CLOCK = Symbol('AUDIT_CLOCK');

const DAY_MS = 86_400_000;
/** Sin fechas se ven los últimos 30 días. */
export const DEFAULT_RANGE_DAYS = 30;
/** Tope del rango pedido: un año, bisiesto incluido. */
export const MAX_RANGE_DAYS = 366;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export interface ListAuditEventsInput {
  tenantId: string;
  /** Sede activa (X-Location-Id): solo decide la zona de referencia. */
  locationId?: string;
  patientId?: string;
  actorUserId?: string;
  action?: AuditAction;
  resourceType?: AuditResourceType;
  /** Instante ISO 8601, incluido. */
  from?: string;
  /** Instante ISO 8601, excluido. */
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface ListAuditEventsOutput {
  items: AuditEventView[];
  /** `null` en la última página. */
  nextCursor: string | null;
  /** Zona de la sede activa o principal: con ella la web arma los filtros. */
  timeZone: string;
}

/**
 * Lista paginada por cursor de la auditoría de la clínica (solo ADMIN, lo
 * exige el controlador). Rango acotado (por defecto 30 días, como mucho 366)
 * y límite acotado (por defecto 50, como mucho 100): una consulta nunca
 * recorre el histórico entero.
 */
@Injectable()
export class ListAuditEventsUseCase {
  constructor(
    @Inject(AUDIT_EVENT_REPOSITORY)
    private readonly repo: AuditEventRepository,
    @Inject(AUDIT_CLOCK)
    private readonly now: AuditClock,
  ) {}

  private range(input: ListAuditEventsInput): { from: Date; to: Date } {
    const defaultSpan = DEFAULT_RANGE_DAYS * DAY_MS;
    const now = this.now();
    let to = input.to ? new Date(input.to) : null;
    let from = input.from ? new Date(input.from) : null;
    if (!to) {
      to = from
        ? new Date(Math.min(from.getTime() + defaultSpan, now.getTime()))
        : now;
    }
    if (!from) from = new Date(to.getTime() - defaultSpan);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from/to must be ISO 8601 instants');
    }
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('from must be before to');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      throw new BadRequestException(
        `The range cannot exceed ${MAX_RANGE_DAYS} days`,
      );
    }
    return { from, to };
  }

  async execute(input: ListAuditEventsInput): Promise<ListAuditEventsOutput> {
    const { from, to } = this.range(input);
    const cursor = input.cursor ? decodeAuditCursor(input.cursor) : null;
    if (input.cursor && !cursor) {
      throw new BadRequestException('Invalid cursor');
    }
    const limit = Math.min(
      Math.max(input.limit ?? DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const filter: AuditEventFilter = {
      ...(input.patientId ? { patientId: input.patientId } : {}),
      ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.resourceType ? { resourceType: input.resourceType } : {}),
      from,
      to,
    };
    const [rows, timeZone] = await Promise.all([
      this.repo.list(input.tenantId, filter, cursor, limit + 1),
      this.repo.clinicTimeZone(input.tenantId, input.locationId),
    ]);
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeAuditCursor({ occurredAt: last.occurredAt, id: last.id })
          : null,
      timeZone,
    };
  }
}
