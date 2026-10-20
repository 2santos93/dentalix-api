import { Payer } from '../../domain/entities/payer.entity';
import {
  CreatePayerRepoInput,
  PayerRepository,
  UpdatePayerRepoInput,
} from '../../domain/ports/payer-repository.port';
import { payerNameKey } from '../../domain/payer-rules';

/**
 * Repositorio de pagadores en memoria con estado: los tests afirman sobre
 * `rows` igual que un e2e lo haría sobre la tabla. `deleted` guarda los
 * retirados y `liveCoverages` las coberturas vivas por pagador.
 */
export class InMemoryPayerRepository implements PayerRepository {
  readonly rows: Payer[] = [];
  readonly deleted = new Set<string>();
  readonly liveCoverages = new Map<string, number>();
  private nextId = 1;

  seed(partial: Partial<Payer> = {}): Payer {
    const row: Payer = {
      id: `payer-${this.nextId++}`,
      name: 'Sanitas',
      type: 'EPS_CO',
      country: 'CO',
      active: true,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      ...partial,
    };
    this.rows.push(row);
    return row;
  }

  list(params: { includeInactive: boolean }): Promise<Payer[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => !this.deleted.has(r.id))
        .filter((r) => params.includeInactive || r.active)
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
    );
  }

  findById(id: string): Promise<Payer | null> {
    const row = this.rows.find((r) => r.id === id && !this.deleted.has(id));
    return Promise.resolve(row ? { ...row } : null);
  }

  findByNormalizedName(
    nameKey: string,
    excludeId?: string,
  ): Promise<Payer | null> {
    const row = this.rows.find(
      (r) =>
        !this.deleted.has(r.id) &&
        r.id !== excludeId &&
        payerNameKey(r.name) === nameKey,
    );
    return Promise.resolve(row ? { ...row } : null);
  }

  create(input: CreatePayerRepoInput): Promise<Payer> {
    return Promise.resolve(
      this.seed({
        name: input.name,
        type: input.type,
        country: input.country,
        active: input.active,
      }),
    );
  }

  update(id: string, patch: UpdatePayerRepoInput): Promise<Payer> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error('not found');
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.type !== undefined) row.type = patch.type;
    if (patch.country !== undefined) row.country = patch.country;
    if (patch.active !== undefined) row.active = patch.active;
    return Promise.resolve({ ...row });
  }

  softDelete(id: string): Promise<void> {
    this.deleted.add(id);
    const row = this.rows.find((r) => r.id === id);
    if (row) row.active = false;
    return Promise.resolve();
  }

  countLiveCoverages(payerId: string): Promise<number> {
    return Promise.resolve(this.liveCoverages.get(payerId) ?? 0);
  }
}
