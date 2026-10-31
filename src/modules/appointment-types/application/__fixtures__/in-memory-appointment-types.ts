import { AppointmentType } from '../../domain/entities/appointment-type.entity';
import {
  AppointmentTypeRepository,
  CreateAppointmentTypeRepoInput,
  UpdateAppointmentTypeRepoInput,
} from '../../domain/ports/appointment-type-repository.port';

/**
 * Repositorio de tipos en memoria con estado: los tests afirman sobre `rows`
 * igual que un e2e lo haría sobre la tabla. `deleted` guarda los retirados.
 */
export class InMemoryAppointmentTypeRepository implements AppointmentTypeRepository {
  readonly rows: AppointmentType[] = [];
  readonly deleted = new Set<string>();
  private nextId = 1;

  seed(partial: Partial<AppointmentType> = {}): AppointmentType {
    const row: AppointmentType = {
      id: `type-${this.nextId++}`,
      tenantId: 't1',
      name: 'Endodoncia',
      durationMinutes: 90,
      color: '#7C3AED',
      active: true,
      isUrgent: false,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      ...partial,
    };
    this.rows.push(row);
    return row;
  }

  list(params: { includeInactive: boolean }): Promise<AppointmentType[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => !this.deleted.has(r.id))
        .filter((r) => params.includeInactive || r.active)
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  findById(id: string): Promise<AppointmentType | null> {
    const row = this.rows.find((r) => r.id === id && !this.deleted.has(id));
    return Promise.resolve(row ? { ...row } : null);
  }

  create(input: CreateAppointmentTypeRepoInput): Promise<AppointmentType> {
    return Promise.resolve(
      this.seed({
        name: input.name,
        durationMinutes: input.durationMinutes,
        color: input.color,
        active: input.active,
        isUrgent: input.isUrgent ?? false,
      }),
    );
  }

  update(
    id: string,
    input: UpdateAppointmentTypeRepoInput,
  ): Promise<AppointmentType> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error('not found');
    if (input.name !== undefined) row.name = input.name;
    if (input.durationMinutes !== undefined) {
      row.durationMinutes = input.durationMinutes;
    }
    if (input.color !== undefined) row.color = input.color;
    if (input.active !== undefined) row.active = input.active;
    if (input.isUrgent !== undefined) row.isUrgent = input.isUrgent;
    return Promise.resolve({ ...row });
  }

  softDelete(id: string): Promise<void> {
    this.deleted.add(id);
    const row = this.rows.find((r) => r.id === id);
    if (row) row.active = false;
    return Promise.resolve();
  }
}
