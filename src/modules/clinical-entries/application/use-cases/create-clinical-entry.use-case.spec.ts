import { CreateClinicalEntryUseCase } from './create-clinical-entry.use-case';
import { ClinicalEntry } from '../../domain/entities/clinical-entry.entity';
import {
  ClinicalEntryRepository,
  CreateClinicalEntryRepoInput,
  ListClinicalEntriesParams,
} from '../../domain/ports/clinical-entry-repository.port';

/**
 * A REAL (stateful) in-memory fake — not just a jest-mock object — because
 * part of the behavior under test IS the append-only storage contract
 * itself. `rows` is exposed so tests can assert directly on what got
 * persisted, the same way an e2e test would assert against the real table.
 * Deliberately has NO update/delete method — immutability enforced at the
 * interface level.
 */
class InMemoryClinicalEntryRepository implements ClinicalEntryRepository {
  readonly rows: ClinicalEntry[] = [];
  private nextId = 1;

  create(input: CreateClinicalEntryRepoInput): Promise<ClinicalEntry> {
    const row: ClinicalEntry = {
      id: `ce-${this.nextId++}`,
      tenantId: 't1',
      patientId: input.patientId,
      entryDate: input.entryDate ?? new Date('2026-07-23T00:00:00.000Z'),
      reason: input.reason ?? null,
      notes: input.notes,
      performedById: input.performedById ?? null,
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
    };
    // Append-only: push a NEW row, never mutate/replace an existing one.
    this.rows.push(row);
    return Promise.resolve(row);
  }

  listByPatient(
    patientId: string,
    params?: ListClinicalEntriesParams,
  ): Promise<ClinicalEntry[]> {
    let entries = this.rows.filter((r) => r.patientId === patientId);
    if (params?.from) {
      entries = entries.filter((r) => r.entryDate >= params.from!);
    }
    if (params?.to) {
      entries = entries.filter((r) => r.entryDate <= params.to!);
    }
    entries.sort((a, b) => b.entryDate.getTime() - a.entryDate.getTime());
    return Promise.resolve(entries);
  }
}

describe('CreateClinicalEntryUseCase', () => {
  it('appends a new entry and returns it', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = new CreateClinicalEntryUseCase(repo);

    const result = await uc.execute(
      'p1',
      { notes: 'Control de rutina, sin novedad' },
      'user-1',
    );

    expect(result.patientId).toBe('p1');
    expect(result.notes).toBe('Control de rutina, sin novedad');
    expect(result.performedById).toBe('user-1');
    expect(repo.rows).toHaveLength(1);
  });

  it('defaults entryDate to now when not provided', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = new CreateClinicalEntryUseCase(repo);
    const before = new Date();

    const result = await uc.execute('p1', { notes: 'Nota' }, 'user-1');

    const after = new Date();
    expect(result.entryDate.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.entryDate.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('uses the provided entryDate when given', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = new CreateClinicalEntryUseCase(repo);
    const explicitDate = new Date('2025-01-15T10:00:00.000Z');

    const result = await uc.execute(
      'p1',
      { notes: 'Nota con fecha', entryDate: explicitDate },
      'user-1',
    );

    expect(result.entryDate).toEqual(explicitDate);
  });

  it('rejects blank notes (notes is required content, not just a required field)', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = new CreateClinicalEntryUseCase(repo);

    await expect(
      uc.execute('p1', { notes: '   ' }, 'user-1'),
    ).rejects.toThrow();
    expect(repo.rows).toHaveLength(0);
  });

  it('never forwards a tenantId sneaked into the input to the repository (tenant comes from context, not input)', async () => {
    let captured: CreateClinicalEntryRepoInput | undefined;
    const repo = new InMemoryClinicalEntryRepository();
    const originalCreate = repo.create.bind(repo);
    repo.create = (input) => {
      captured = input;
      return originalCreate(input);
    };
    const uc = new CreateClinicalEntryUseCase(repo);

    const maliciousInput = {
      notes: 'Nota',
      tenantId: 'sneaky-tenant',
    } as unknown as Parameters<typeof uc.execute>[1];

    await uc.execute('p1', maliciousInput, 'user-1');

    expect(captured && 'tenantId' in captured).toBe(false);
  });

  it('forwards performedById from the explicit argument, not from the input payload', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const uc = new CreateClinicalEntryUseCase(repo);

    const result = await uc.execute('p1', { notes: 'Nota' }, 'user-77');

    expect(result.performedById).toBe('user-77');
  });
});
