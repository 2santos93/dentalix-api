import { CatalogKind, ToothRecordStatus, ToothSurface } from '@prisma/client';
import { AddToothRecordUseCase } from './add-tooth-record.use-case';
import { ToothRecord } from '../../domain/entities/tooth-record.entity';
import {
  CreateToothRecordRepoInput,
  ToothRecordRepository,
} from '../../domain/ports/tooth-record-repository.port';

/**
 * A REAL (stateful) in-memory fake — not just a jest-mock object — because
 * part of the behavior under test IS the append-only storage contract
 * itself. `rows` is exposed so tests can assert directly on what got
 * persisted, the same way an e2e test would assert against the real table.
 * Deliberately has NO update/delete method — immutability enforced at the
 * interface level.
 */
class InMemoryToothRecordRepository implements ToothRecordRepository {
  readonly rows: ToothRecord[] = [];
  private nextId = 1;

  create(input: CreateToothRecordRepoInput): Promise<ToothRecord> {
    const row: ToothRecord = {
      id: `tr-${this.nextId++}`,
      tenantId: 't1',
      patientId: input.patientId,
      toothNumber: input.toothNumber,
      surfaces: input.surfaces,
      kind: input.kind,
      catalogItemId: input.catalogItemId ?? null,
      status: input.status ?? ToothRecordStatus.COMPLETED,
      notes: input.notes ?? null,
      clinicalEntryId: input.clinicalEntryId ?? null,
      performedById: input.performedById ?? null,
      recordedAt: input.recordedAt ?? new Date('2026-07-23T00:00:00.000Z'),
      createdAt: new Date('2026-07-23T00:00:00.000Z'),
    };
    // Append-only: push a NEW row, never mutate/replace an existing one.
    this.rows.push(row);
    return Promise.resolve(row);
  }

  listByPatient(patientId: string): Promise<ToothRecord[]> {
    return Promise.resolve(this.rows.filter((r) => r.patientId === patientId));
  }

  listByTooth(patientId: string, toothNumber: string): Promise<ToothRecord[]> {
    return Promise.resolve(
      this.rows.filter(
        (r) => r.patientId === patientId && r.toothNumber === toothNumber,
      ),
    );
  }
}

describe('AddToothRecordUseCase', () => {
  it('appends a new record and returns it', async () => {
    const repo = new InMemoryToothRecordRepository();
    const uc = new AddToothRecordUseCase(repo);

    const result = await uc.execute(
      'p1',
      {
        toothNumber: '11',
        surfaces: [ToothSurface.OCCLUSAL],
        kind: CatalogKind.DIAGNOSIS,
      },
      'user-1',
    );

    expect(result.patientId).toBe('p1');
    expect(result.toothNumber).toBe('11');
    expect(result.surfaces).toEqual([ToothSurface.OCCLUSAL]);
    expect(result.performedById).toBe('user-1');
    expect(repo.rows).toHaveLength(1);
  });

  it('accepts an empty surfaces array (means whole tooth)', async () => {
    const repo = new InMemoryToothRecordRepository();
    const uc = new AddToothRecordUseCase(repo);

    const result = await uc.execute('p1', {
      toothNumber: '48',
      surfaces: [],
      kind: CatalogKind.PROCEDURE,
    });

    expect(result.surfaces).toEqual([]);
  });

  it('defaults surfaces to empty when omitted entirely', async () => {
    const repo = new InMemoryToothRecordRepository();
    const uc = new AddToothRecordUseCase(repo);

    const result = await uc.execute('p1', {
      toothNumber: '21',
      kind: CatalogKind.PROCEDURE,
    });

    expect(result.surfaces).toEqual([]);
  });

  it.each(['11', '18', '21', '28', '31', '38', '41', '48'])(
    'accepts a valid permanent FDI tooth number (%s)',
    async (toothNumber) => {
      const repo = new InMemoryToothRecordRepository();
      const uc = new AddToothRecordUseCase(repo);

      const result = await uc.execute('p1', {
        toothNumber,
        surfaces: [],
        kind: CatalogKind.DIAGNOSIS,
      });

      expect(result.toothNumber).toBe(toothNumber);
    },
  );

  it.each(['51', '55', '61', '65', '71', '75', '81', '85'])(
    'accepts a valid primary (deciduous) FDI tooth number (%s)',
    async (toothNumber) => {
      const repo = new InMemoryToothRecordRepository();
      const uc = new AddToothRecordUseCase(repo);

      const result = await uc.execute('p1', {
        toothNumber,
        surfaces: [],
        kind: CatalogKind.DIAGNOSIS,
      });

      expect(result.toothNumber).toBe(toothNumber);
    },
  );

  it.each(['99', '10', '00', 'abc', '19', '56', '91', '', '111', '4'])(
    'rejects an invalid FDI tooth number (%s)',
    async (toothNumber) => {
      const repo = new InMemoryToothRecordRepository();
      const uc = new AddToothRecordUseCase(repo);

      await expect(
        uc.execute('p1', {
          toothNumber,
          surfaces: [],
          kind: CatalogKind.DIAGNOSIS,
        }),
      ).rejects.toThrow();
      expect(repo.rows).toHaveLength(0);
    },
  );

  it('rejects an invalid surface value', async () => {
    const repo = new InMemoryToothRecordRepository();
    const uc = new AddToothRecordUseCase(repo);

    await expect(
      uc.execute('p1', {
        toothNumber: '11',
        surfaces: ['BOGUS'] as unknown as ToothSurface[],
        kind: CatalogKind.DIAGNOSIS,
      }),
    ).rejects.toThrow();
    expect(repo.rows).toHaveLength(0);
  });

  it('rejects an invalid kind', async () => {
    const repo = new InMemoryToothRecordRepository();
    const uc = new AddToothRecordUseCase(repo);

    await expect(
      uc.execute('p1', {
        toothNumber: '11',
        surfaces: [],
        kind: 'BOGUS' as unknown as CatalogKind,
      }),
    ).rejects.toThrow();
    expect(repo.rows).toHaveLength(0);
  });

  it('never forwards a tenantId sneaked into the input to the repository (tenant comes from context, not input)', async () => {
    let captured: CreateToothRecordRepoInput | undefined;
    const repo = new InMemoryToothRecordRepository();
    const originalCreate = repo.create.bind(repo);
    repo.create = (input) => {
      captured = input;
      return originalCreate(input);
    };
    const uc = new AddToothRecordUseCase(repo);

    const maliciousInput = {
      toothNumber: '11',
      surfaces: [],
      kind: CatalogKind.DIAGNOSIS,
      tenantId: 'sneaky-tenant',
    } as unknown as Parameters<typeof uc.execute>[1];

    await uc.execute('p1', maliciousInput, 'user-1');

    expect(captured && 'tenantId' in captured).toBe(false);
  });

  it('forwards performedById from the explicit argument, not from the input payload', async () => {
    const repo = new InMemoryToothRecordRepository();
    const uc = new AddToothRecordUseCase(repo);

    const result = await uc.execute(
      'p1',
      { toothNumber: '11', surfaces: [], kind: CatalogKind.DIAGNOSIS },
      'user-77',
    );

    expect(result.performedById).toBe('user-77');
  });

  it('does NOT existence-check catalogItemId/clinicalEntryId — forwards them as given (RLS renders a bad/cross-tenant ref harmless; follow-up)', async () => {
    const repo = new InMemoryToothRecordRepository();
    const uc = new AddToothRecordUseCase(repo);

    const result = await uc.execute('p1', {
      toothNumber: '11',
      surfaces: [],
      kind: CatalogKind.DIAGNOSIS,
      catalogItemId: 'not-a-real-item',
      clinicalEntryId: 'not-a-real-entry',
    });

    expect(result.catalogItemId).toBe('not-a-real-item');
    expect(result.clinicalEntryId).toBe('not-a-real-entry');
  });
});
