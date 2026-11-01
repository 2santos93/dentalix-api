import { ConflictException } from '@nestjs/common';
import type { Chair } from '../../domain/entities/chair.entity';
import {
  DUPLICATE_CHAIR_NAME_MESSAGE,
  sameChairName,
} from '../../domain/chair-rules';
import type {
  ChairRepository,
  CreateChairRepoInput,
  UpdateChairRepoInput,
} from '../../domain/ports/chair-repository.port';

/**
 * Repositorio de sillones en memoria con estado: los tests afirman sobre
 * `rows` como un e2e lo haría sobre la tabla. El nombre es único por sede
 * (sin distinguir mayúsculas, como el índice de la BD).
 */
export class InMemoryChairRepository implements ChairRepository {
  readonly rows: Chair[] = [];
  private nextId = 1;

  seed(partial: Partial<Chair> = {}): Chair {
    const row: Chair = {
      id: `chair-${this.nextId++}`,
      tenantId: 't1',
      locationId: 'loc1',
      name: `Sillón ${this.nextId - 1}`,
      sortOrder: this.rows.length,
      defaultProviderId: null,
      active: true,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      ...partial,
    };
    this.rows.push(row);
    return { ...row };
  }

  listByLocation(params: {
    locationId: string;
    includeInactive: boolean;
  }): Promise<Chair[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.locationId === params.locationId)
        .filter((r) => params.includeInactive || r.active)
        .sort(
          (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
        )
        .map((r) => ({ ...r })),
    );
  }

  findById(id: string): Promise<Chair | null> {
    const row = this.rows.find((r) => r.id === id);
    return Promise.resolve(row ? { ...row } : null);
  }

  findByIds(ids: readonly string[]): Promise<Chair[]> {
    return Promise.resolve(
      this.rows.filter((r) => ids.includes(r.id)).map((r) => ({ ...r })),
    );
  }

  private assertUniqueName(locationId: string, name: string, id?: string) {
    if (
      this.rows.some(
        (r) =>
          r.locationId === locationId &&
          sameChairName(r.name, name) &&
          r.id !== id,
      )
    ) {
      throw new ConflictException(DUPLICATE_CHAIR_NAME_MESSAGE);
    }
  }

  create(input: CreateChairRepoInput): Promise<Chair> {
    this.assertUniqueName(input.locationId, input.name);
    return Promise.resolve(
      this.seed({
        locationId: input.locationId,
        name: input.name,
        sortOrder: input.sortOrder,
        defaultProviderId: input.defaultProviderId,
      }),
    );
  }

  update(id: string, input: UpdateChairRepoInput): Promise<Chair> {
    const row = this.rows.find((r) => r.id === id)!;
    if (input.name !== undefined)
      this.assertUniqueName(row.locationId, input.name, id);
    if (input.name !== undefined) row.name = input.name;
    if (input.sortOrder !== undefined) row.sortOrder = input.sortOrder;
    if (input.defaultProviderId !== undefined) {
      row.defaultProviderId = input.defaultProviderId;
    }
    if (input.active !== undefined) row.active = input.active;
    return Promise.resolve({ ...row });
  }

  reorder(locationId: string, chairIds: readonly string[]): Promise<Chair[]> {
    chairIds.forEach((id, index) => {
      const row = this.rows.find((r) => r.id === id);
      if (row) row.sortOrder = index;
    });
    return this.listByLocation({ locationId, includeInactive: true });
  }
}
