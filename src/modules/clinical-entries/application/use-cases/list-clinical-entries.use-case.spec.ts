import { ListClinicalEntriesUseCase } from './list-clinical-entries.use-case';
import { ClinicalEntry } from '../../domain/entities/clinical-entry.entity';
import {
  ClinicalEntryRepository,
  ListClinicalEntriesParams,
} from '../../domain/ports/clinical-entry-repository.port';

function fakeEntry(
  patientId: string,
  entryDate: string,
  overrides: Partial<ClinicalEntry> = {},
): ClinicalEntry {
  return {
    id: `ce-${patientId}-${entryDate}`,
    tenantId: 't1',
    patientId,
    entryDate: new Date(entryDate),
    reason: null,
    notes: 'Nota',
    performedById: null,
    createdAt: new Date(entryDate),
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<ClinicalEntryRepository> = {},
): ClinicalEntryRepository {
  return {
    create: (): Promise<ClinicalEntry> =>
      Promise.reject(new Error('not implemented in this fake')),
    listByPatient: (): Promise<ClinicalEntry[]> => Promise.resolve([]),
    ...overrides,
  };
}

/**
 * In-memory fake that mirrors the REAL repository contract documented on
 * `ClinicalEntryRepository.listByPatient` and implemented by
 * `PrismaClinicalEntryRepository` (orderBy: { entryDate: 'desc' }): it
 * actually sorts its stored rows by `entryDate` DESC on every read, instead
 * of trusting the caller to have pre-sorted them. Seeded data is inserted
 * OUT OF ORDER on purpose — if this fake's sort were flipped to ASC (or
 * removed), the ordering test below would fail.
 */
class InMemoryClinicalEntryRepository implements ClinicalEntryRepository {
  private readonly store: ClinicalEntry[] = [];

  seed(entries: ClinicalEntry[]): void {
    this.store.push(...entries);
  }

  create(): Promise<ClinicalEntry> {
    return Promise.reject(new Error('not implemented in this fake'));
  }

  listByPatient(
    patientId: string,
    params?: ListClinicalEntriesParams,
  ): Promise<ClinicalEntry[]> {
    const filtered = this.store.filter((entry) => {
      if (entry.patientId !== patientId) return false;
      if (params?.from && entry.entryDate.getTime() < params.from.getTime()) {
        return false;
      }
      if (params?.to && entry.entryDate.getTime() > params.to.getTime()) {
        return false;
      }
      return true;
    });
    const sorted = [...filtered].sort(
      (a, b) => b.entryDate.getTime() - a.entryDate.getTime(),
    );
    return Promise.resolve(sorted);
  }
}

describe('ListClinicalEntriesUseCase', () => {
  it('returns an empty array when the patient has no entries', async () => {
    const repo = makeRepo();
    const uc = new ListClinicalEntriesUseCase(repo);

    const result = await uc.execute('p1');

    expect(result).toEqual([]);
  });

  it('delegates to repo.listByPatient with the patientId (repo owns the desc-by-entryDate ordering)', async () => {
    const entries = [
      fakeEntry('p1', '2026-07-20T00:00:00.000Z'),
      fakeEntry('p1', '2026-07-10T00:00:00.000Z'),
    ];
    const repo = makeRepo({
      listByPatient: (patientId): Promise<ClinicalEntry[]> =>
        Promise.resolve(patientId === 'p1' ? entries : []),
    });
    const uc = new ListClinicalEntriesUseCase(repo);

    const result = await uc.execute('p1');

    expect(result).toBe(entries);
    expect(result[0].entryDate.getTime()).toBeGreaterThan(
      result[1].entryDate.getTime(),
    );
  });

  it('returns entries in strict descending entryDate order (most recent first), given a repo that genuinely sorts out-of-order stored data', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    // Inserted OUT OF ORDER on purpose: 02, then 05, then 01.
    repo.seed([
      fakeEntry('p1', '2026-01-02T00:00:00.000Z'),
      fakeEntry('p1', '2026-01-05T00:00:00.000Z'),
      fakeEntry('p1', '2026-01-01T00:00:00.000Z'),
    ]);
    const uc = new ListClinicalEntriesUseCase(repo);

    const result = await uc.execute('p1');

    expect(result.map((entry) => entry.entryDate.toISOString())).toEqual([
      '2026-01-05T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
    for (let i = 0; i < result.length - 1; i += 1) {
      expect(result[i].entryDate.getTime()).toBeGreaterThan(
        result[i + 1].entryDate.getTime(),
      );
    }
  });

  it('forwards from/to range filters to the repository untouched', async () => {
    let captured: { from?: Date; to?: Date } | undefined;
    const repo = makeRepo({
      listByPatient: (_patientId, params): Promise<ClinicalEntry[]> => {
        captured = params;
        return Promise.resolve([]);
      },
    });
    const uc = new ListClinicalEntriesUseCase(repo);
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-12-31T00:00:00.000Z');

    await uc.execute('p1', { from, to });

    expect(captured).toEqual({ from, to });
  });

  it('scopes by patientId (does not leak another patient entries)', async () => {
    const repo = makeRepo({
      listByPatient: (patientId): Promise<ClinicalEntry[]> =>
        Promise.resolve(
          patientId === 'p1'
            ? [fakeEntry('p1', '2026-01-01T00:00:00.000Z')]
            : [],
        ),
    });
    const uc = new ListClinicalEntriesUseCase(repo);

    const result = await uc.execute('p2');

    expect(result).toEqual([]);
  });
});
