import {
  AppointmentStatus,
  WaitlistPriority,
  WaitlistStatus,
} from '@prisma/client';
import type {
  WaitlistEntry,
  WaitlistPage,
} from '../../domain/entities/waitlist-entry.entity';
import type {
  CreateWaitlistEntryRepoInput,
  ListWaitlistParams,
  WaitlistRepository,
} from '../../domain/ports/waitlist-repository.port';
import { durationFromAppointment } from '../../domain/waitlist-rules';

/** Lo que el alta automática lee de la cita cancelada o no-show. */
export interface WaitlistSourceAppointment {
  id: string;
  locationId: string;
  patientId: string;
  providerId: string;
  appointmentTypeId: string | null;
  start: Date;
  end: Date;
  status: AppointmentStatus;
}

/**
 * Pendientes en memoria con las MISMAS reglas que Postgres: una sola entrada
 * por cita de origen (el único parcial), y descartar/agendar solo si sigue
 * OPEN. `enqueueFromAppointment` y `markScheduled` son lo que hacen, dentro de
 * su transacción, los repositorios de citas.
 */
export class InMemoryWaitlistRepository implements WaitlistRepository {
  readonly rows: WaitlistEntry[] = [];
  currentLocationId = 'loc1';
  private nextId = 1;
  private clock = Date.parse('2026-10-01T00:00:00.000Z');

  private tick(): Date {
    this.clock += 60_000;
    return new Date(this.clock);
  }

  seed(partial: Partial<WaitlistEntry> = {}): WaitlistEntry {
    const now = this.tick();
    const row: WaitlistEntry = {
      id: `wl-${this.nextId++}`,
      tenantId: 't1',
      locationId: this.currentLocationId,
      patientId: 'p1',
      patientFirstName: 'Ana',
      patientLastName: 'Ruiz',
      patientPhone: null,
      sourceAppointmentId: null,
      sourceAppointment: null,
      providerId: null,
      appointmentTypeId: null,
      appointmentType: null,
      durationMinutes: 30,
      priority: WaitlistPriority.NORMAL,
      preferredWindow: null,
      note: null,
      status: WaitlistStatus.OPEN,
      resolvedAppointmentId: null,
      dismissReason: null,
      createdById: 'u1',
      resolvedById: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
      ...partial,
    };
    this.rows.push(row);
    return row;
  }

  list(params: ListWaitlistParams): Promise<WaitlistPage> {
    const all = this.rows
      .filter((r) => r.status === params.status)
      .filter((r) => !params.locationId || r.locationId === params.locationId)
      .sort(
        (a, b) =>
          Number(b.priority === WaitlistPriority.URGENT) -
            Number(a.priority === WaitlistPriority.URGENT) ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      );
    const start = (params.page - 1) * params.pageSize;
    return Promise.resolve({
      items: all.slice(start, start + params.pageSize),
      total: all.length,
      page: params.page,
      pageSize: params.pageSize,
    });
  }

  findById(id: string): Promise<WaitlistEntry | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }

  create(input: CreateWaitlistEntryRepoInput): Promise<WaitlistEntry> {
    return Promise.resolve(
      this.seed({
        locationId: input.locationId ?? this.currentLocationId,
        patientId: input.patientId,
        providerId: input.providerId,
        appointmentTypeId: input.appointmentTypeId,
        durationMinutes: input.durationMinutes,
        priority: input.priority,
        preferredWindow: input.preferredWindow,
        note: input.note,
        createdById: input.createdById,
      }),
    );
  }

  dismiss(
    id: string,
    reason: string,
    dismissedById: string,
  ): Promise<WaitlistEntry | null> {
    const row = this.rows.find(
      (r) => r.id === id && r.status === WaitlistStatus.OPEN,
    );
    if (!row) return Promise.resolve(null);
    Object.assign(row, {
      status: WaitlistStatus.DISMISSED,
      dismissReason: reason,
      resolvedById: dismissedById,
      resolvedAt: this.tick(),
    });
    return Promise.resolve(row);
  }

  /** Alta automática idempotente: el id nuevo, o `null` si la cita ya tenía. */
  enqueueFromAppointment(
    appointment: WaitlistSourceAppointment,
    createdById: string | null,
  ): string | null {
    if (this.rows.some((r) => r.sourceAppointmentId === appointment.id))
      return null;
    return this.seed({
      locationId: appointment.locationId,
      patientId: appointment.patientId,
      sourceAppointmentId: appointment.id,
      sourceAppointment: {
        start: appointment.start,
        end: appointment.end,
        status: appointment.status,
      },
      providerId: appointment.providerId,
      appointmentTypeId: appointment.appointmentTypeId,
      durationMinutes: durationFromAppointment(
        appointment.start,
        appointment.end,
      ),
      createdById,
    }).id;
  }

  /** Agendar desde la entrada: solo si sigue OPEN. */
  markScheduled(
    entryId: string,
    appointmentId: string,
    by: string | null,
  ): boolean {
    const row = this.rows.find(
      (r) => r.id === entryId && r.status === WaitlistStatus.OPEN,
    );
    if (!row) return false;
    Object.assign(row, {
      status: WaitlistStatus.SCHEDULED,
      resolvedAppointmentId: appointmentId,
      resolvedById: by,
      resolvedAt: this.tick(),
    });
    return true;
  }
}
