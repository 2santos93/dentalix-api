import { CatalogKind, ToothRecordStatus } from '@prisma/client';
import { GetOdontogramUseCase } from './get-odontogram.use-case';
import { ToothRecord } from '../../domain/entities/tooth-record.entity';
import { ToothRecordRepository } from '../../domain/ports/tooth-record-repository.port';

function fakeRecord(
  patientId: string,
  toothNumber: string,
  overrides: Partial<ToothRecord> = {},
): ToothRecord {
  return {
    id: `tr-${patientId}-${toothNumber}-${Math.random()}`,
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
    recordedAt: new Date('2026-07-23T00:00:00.000Z'),
    createdAt: new Date('2026-07-23T00:00:00.000Z'),
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

describe('GetOdontogramUseCase', () => {
  it('returns an empty array when the patient has no records', async () => {
    const repo = makeRepo();
    const uc = new GetOdontogramUseCase(repo);

    const result = await uc.execute('p1');

    expect(result).toEqual([]);
  });

  it('groups records by toothNumber', async () => {
    const records = [
      fakeRecord('p1', '11'),
      fakeRecord('p1', '11'),
      fakeRecord('p1', '48'),
    ];
    const repo = makeRepo({
      listByPatient: (patientId): Promise<ToothRecord[]> =>
        Promise.resolve(patientId === 'p1' ? records : []),
    });
    const uc = new GetOdontogramUseCase(repo);

    const result = await uc.execute('p1');

    expect(result).toHaveLength(2);
    const tooth11 = result.find((g) => g.toothNumber === '11');
    const tooth48 = result.find((g) => g.toothNumber === '48');
    expect(tooth11?.records).toHaveLength(2);
    expect(tooth48?.records).toHaveLength(1);
  });

  it('returns groups ordered by toothNumber ascending (stable projection output)', async () => {
    const records = [
      fakeRecord('p1', '48'),
      fakeRecord('p1', '11'),
      fakeRecord('p1', '21'),
    ];
    const repo = makeRepo({
      listByPatient: (): Promise<ToothRecord[]> => Promise.resolve(records),
    });
    const uc = new GetOdontogramUseCase(repo);

    const result = await uc.execute('p1');

    expect(result.map((g) => g.toothNumber)).toEqual(['11', '21', '48']);
  });

  it('scopes by patientId (does not leak another patient records)', async () => {
    const repo = makeRepo({
      listByPatient: (patientId): Promise<ToothRecord[]> =>
        Promise.resolve(patientId === 'p1' ? [fakeRecord('p1', '11')] : []),
    });
    const uc = new GetOdontogramUseCase(repo);

    const result = await uc.execute('p2');

    expect(result).toEqual([]);
  });

  it('keeps each record intact inside its group (no data loss/mutation)', async () => {
    const record = fakeRecord('p1', '11', { notes: 'nota importante' });
    const repo = makeRepo({
      listByPatient: (): Promise<ToothRecord[]> => Promise.resolve([record]),
    });
    const uc = new GetOdontogramUseCase(repo);

    const result = await uc.execute('p1');

    expect(result[0].records[0]).toEqual(record);
  });
});
