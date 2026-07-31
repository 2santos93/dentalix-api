import { CatalogKind, ToothRecordStatus } from '@prisma/client';
import { GetToothTimelineUseCase } from './get-tooth-timeline.use-case';
import { ToothRecord } from '../../domain/entities/tooth-record.entity';
import { ToothRecordRepository } from '../../domain/ports/tooth-record-repository.port';

function fakeRecord(
  patientId: string,
  toothNumber: string,
  recordedAt: string,
  overrides: Partial<ToothRecord> = {},
): ToothRecord {
  return {
    id: `tr-${patientId}-${toothNumber}-${recordedAt}`,
    tenantId: 't1',
    patientId,
    toothNumber,
    surfaces: [],
    kind: CatalogKind.DIAGNOSIS,
    catalogItemId: null,
    status: ToothRecordStatus.COMPLETED,
    notes: null,
    clinicalEntryId: null,
    performedById: null,
    sourcePlanItemId: null,
    recordedAt: new Date(recordedAt),
    createdAt: new Date(recordedAt),
    ...overrides,
  };
}

function makeRepo(
  overrides: Partial<ToothRecordRepository> = {},
): ToothRecordRepository {
  return {
    create: (): Promise<ToothRecord> =>
      Promise.reject(new Error('not implemented in this fake')),
    listByPatient: (): Promise<ToothRecord[]> => Promise.resolve([]),
    listByTooth: (): Promise<ToothRecord[]> => Promise.resolve([]),
    findBySourcePlanItem: (): Promise<ToothRecord | null> =>
      Promise.resolve(null),
    ...overrides,
  };
}

/**
 * In-memory fake that mirrors the REAL repository contract documented on
 * `ToothRecordRepository.listByTooth` (recordedAt DESC): it actually sorts
 * its stored rows on every read, instead of trusting the caller to have
 * pre-sorted them. Seeded data is inserted OUT OF ORDER on purpose — if this
 * fake's sort were flipped to ASC (or removed) the ordering test would fail.
 */
class InMemoryToothRecordRepository implements ToothRecordRepository {
  private readonly store: ToothRecord[] = [];

  seed(records: ToothRecord[]): void {
    this.store.push(...records);
  }

  create(): Promise<ToothRecord> {
    return Promise.reject(new Error('not implemented in this fake'));
  }

  listByPatient(): Promise<ToothRecord[]> {
    return Promise.resolve([...this.store]);
  }

  listByTooth(patientId: string, toothNumber: string): Promise<ToothRecord[]> {
    const filtered = this.store.filter(
      (r) => r.patientId === patientId && r.toothNumber === toothNumber,
    );
    const sorted = [...filtered].sort(
      (a, b) => b.recordedAt.getTime() - a.recordedAt.getTime(),
    );
    return Promise.resolve(sorted);
  }

  findBySourcePlanItem(planItemId: string): Promise<ToothRecord | null> {
    return Promise.resolve(
      this.store.find((r) => r.sourcePlanItemId === planItemId) ?? null,
    );
  }
}

describe('GetToothTimelineUseCase', () => {
  it('returns an empty array when the tooth has no records', async () => {
    const repo = makeRepo();
    const uc = new GetToothTimelineUseCase(repo);

    const result = await uc.execute('p1', '11');

    expect(result).toEqual([]);
  });

  it('delegates to repo.listByTooth with patientId + toothNumber', async () => {
    let captured: [string, string] | undefined;
    const records = [fakeRecord('p1', '11', '2026-07-20T00:00:00.000Z')];
    const repo = makeRepo({
      listByTooth: (patientId, toothNumber): Promise<ToothRecord[]> => {
        captured = [patientId, toothNumber];
        return Promise.resolve(records);
      },
    });
    const uc = new GetToothTimelineUseCase(repo);

    const result = await uc.execute('p1', '11');

    expect(captured).toEqual(['p1', '11']);
    expect(result).toBe(records);
  });

  it('returns records in strict descending recordedAt order (most recent first), given a repo that genuinely sorts out-of-order stored data', async () => {
    const repo = new InMemoryToothRecordRepository();
    // Inserted OUT OF ORDER on purpose: 02, then 05, then 01.
    repo.seed([
      fakeRecord('p1', '11', '2026-01-02T00:00:00.000Z'),
      fakeRecord('p1', '11', '2026-01-05T00:00:00.000Z'),
      fakeRecord('p1', '11', '2026-01-01T00:00:00.000Z'),
    ]);
    const uc = new GetToothTimelineUseCase(repo);

    const result = await uc.execute('p1', '11');

    expect(result.map((r) => r.recordedAt.toISOString())).toEqual([
      '2026-01-05T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
    for (let i = 0; i < result.length - 1; i += 1) {
      expect(result[i].recordedAt.getTime()).toBeGreaterThan(
        result[i + 1].recordedAt.getTime(),
      );
    }
  });

  it('scopes by toothNumber (does not mix another tooth of the same patient)', async () => {
    const repo = new InMemoryToothRecordRepository();
    repo.seed([
      fakeRecord('p1', '11', '2026-01-01T00:00:00.000Z'),
      fakeRecord('p1', '48', '2026-01-02T00:00:00.000Z'),
    ]);
    const uc = new GetToothTimelineUseCase(repo);

    const result = await uc.execute('p1', '11');

    expect(result).toHaveLength(1);
    expect(result[0].toothNumber).toBe('11');
  });

  it('scopes by patientId (does not leak another patient records for the same tooth)', async () => {
    const repo = new InMemoryToothRecordRepository();
    repo.seed([
      fakeRecord('p1', '11', '2026-01-01T00:00:00.000Z'),
      fakeRecord('p2', '11', '2026-01-02T00:00:00.000Z'),
    ]);
    const uc = new GetToothTimelineUseCase(repo);

    const result = await uc.execute('p1', '11');

    expect(result).toHaveLength(1);
    expect(result[0].patientId).toBe('p1');
  });
});
