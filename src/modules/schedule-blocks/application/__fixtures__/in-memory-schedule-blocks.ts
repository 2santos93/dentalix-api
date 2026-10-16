import type {
  AffectedAppointment,
  ScheduleBlock,
} from '../../domain/entities/schedule-block.entity';
import type {
  AffectingBlocks,
  AffectingBlocksQuery,
  AffectedAppointmentsPage,
  CreateScheduleBlockRepoInput,
  ListScheduleBlocksParams,
  ScheduleBlockRepository,
  ScheduleBlockScope,
  UpdateScheduleBlockRepoInput,
} from '../../domain/ports/schedule-block-repository.port';
import { blockAffects, overlapsBlock } from '../../domain/schedule-block-rules';

/**
 * Bloqueos en memoria con las MISMAS reglas que el repositorio de Prisma
 * (alcance, solape medio abierto, borrado lógico). `appointments` son las
 * citas que `findAffectedAppointments` mira; `currentLocationId` hace de sede
 * del request.
 */
export class InMemoryScheduleBlockRepository implements ScheduleBlockRepository {
  readonly rows: (ScheduleBlock & { deletedAt: Date | null })[] = [];
  readonly appointments: AffectedAppointment[] = [];
  currentLocationId = 'loc1';
  timeZone = 'America/Bogota';
  private nextId = 1;

  seed(partial: Partial<ScheduleBlock> = {}): ScheduleBlock {
    const row = {
      id: `block-${this.nextId++}`,
      tenantId: 't1',
      locationId: null,
      providerId: 'prov1',
      start: new Date('2026-10-20T13:00:00.000Z'),
      end: new Date('2026-10-25T00:00:00.000Z'),
      kind: 'VACATION' as const,
      allowsBooking: false,
      note: null,
      createdById: 'u1',
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      ...partial,
      deletedAt: null,
    };
    this.rows.push(row);
    return this.toEntity(row);
  }

  private toEntity(
    row: ScheduleBlock & { deletedAt: Date | null },
  ): ScheduleBlock {
    return {
      id: row.id,
      tenantId: row.tenantId,
      locationId: row.locationId,
      providerId: row.providerId,
      start: row.start,
      end: row.end,
      kind: row.kind,
      allowsBooking: row.allowsBooking,
      note: row.note,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private live() {
    return this.rows.filter((r) => r.deletedAt === null);
  }

  list(params: ListScheduleBlocksParams): Promise<ScheduleBlock[]> {
    const location = params.locationId;
    return Promise.resolve(
      this.live()
        .filter((r) => overlapsBlock(r, params.from, params.to))
        .filter(
          (r) =>
            !location || r.locationId === null || r.locationId === location,
        )
        .filter(
          (r) =>
            !params.providerIds ||
            r.providerId === null ||
            params.providerIds.includes(r.providerId),
        )
        .sort((a, b) => a.start.getTime() - b.start.getTime())
        .map((r) => this.toEntity(r)),
    );
  }

  findById(id: string): Promise<ScheduleBlock | null> {
    const row = this.live().find((r) => r.id === id);
    return Promise.resolve(row ? this.toEntity(row) : null);
  }

  create(input: CreateScheduleBlockRepoInput): Promise<ScheduleBlock> {
    return Promise.resolve(
      this.seed({
        providerId: input.providerId,
        locationId: input.locationId,
        start: input.start,
        end: input.end,
        kind: input.kind,
        allowsBooking: input.allowsBooking,
        note: input.note,
        createdById: input.createdById,
      }),
    );
  }

  update(
    id: string,
    patch: UpdateScheduleBlockRepoInput,
  ): Promise<ScheduleBlock> {
    const row = this.live().find((r) => r.id === id);
    if (!row) return Promise.reject(new Error(`not found ${id}`));
    const fields = {
      start: patch.start,
      end: patch.end,
      kind: patch.kind,
      allowsBooking: patch.allowsBooking,
      note: patch.note,
    };
    Object.assign(
      row,
      Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== undefined),
      ),
    );
    return Promise.resolve(this.toEntity(row));
  }

  softDelete(id: string): Promise<void> {
    const row = this.live().find((r) => r.id === id);
    if (row) row.deletedAt = new Date();
    return Promise.resolve();
  }

  findAffecting(query: AffectingBlocksQuery): Promise<AffectingBlocks> {
    const locationId = query.locationId ?? this.currentLocationId;
    return Promise.resolve({
      locationId,
      timeZone: this.timeZone,
      blocks: this.live()
        .filter((r) => blockAffects(r, query.providerId, locationId))
        .filter((r) => overlapsBlock(r, query.start, query.end))
        .map((r) => this.toEntity(r)),
    });
  }

  findAffectedAppointments(
    scope: ScheduleBlockScope & { start: Date; end: Date },
    limit: number,
  ): Promise<AffectedAppointmentsPage> {
    const all: AffectedAppointment[] = this.appointments
      .filter((a) => a.status === 'SCHEDULED' || a.status === 'CONFIRMED')
      .filter((a) => a.start < scope.end && a.end > scope.start)
      .filter((a) => blockAffects(scope, a.providerId, a.locationId))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    return Promise.resolve({ items: all.slice(0, limit), total: all.length });
  }
}
