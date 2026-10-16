import { CatalogKind } from '@prisma/client';
import { GetToothTimelineUseCase } from './get-tooth-timeline.use-case';
import { InMemoryToothRecordRepository } from '../__fixtures__/in-memory-odontogram';

function repoWith(names: Record<string, string> = {}) {
  const repo = new InMemoryToothRecordRepository(
    () => new Date('2026-10-16T15:00:00.000Z'),
    names,
  );
  const add = (
    patientId: string,
    toothNumber: string,
    recordedAt: string,
    performedById?: string,
  ) =>
    repo.create({
      patientId,
      toothNumber,
      surfaces: [],
      kind: CatalogKind.DIAGNOSIS,
      performedById,
      recordedAt: new Date(recordedAt),
    });
  return { repo, add };
}

describe('GetToothTimelineUseCase', () => {
  it('returns an empty array when the tooth has no records', async () => {
    const { repo } = repoWith();
    expect(await new GetToothTimelineUseCase(repo).execute('p1', '11')).toEqual(
      [],
    );
  });

  it('returns records most recent first, scoped by patient and tooth', async () => {
    const { repo, add } = repoWith();
    // Inserted OUT OF ORDER on purpose.
    await add('p1', '11', '2026-01-02T00:00:00.000Z');
    await add('p1', '11', '2026-01-05T00:00:00.000Z');
    await add('p1', '11', '2026-01-01T00:00:00.000Z');
    await add('p1', '48', '2026-01-03T00:00:00.000Z');
    await add('p2', '11', '2026-01-04T00:00:00.000Z');

    const result = await new GetToothTimelineUseCase(repo).execute('p1', '11');

    expect(result.map((r) => r.recordedAt.toISOString())).toEqual([
      '2026-01-05T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
  });

  it('marca el anulado con motivo, autor y fecha, sin listar la anulación aparte (DX-120)', async () => {
    const { repo, add } = repoWith({ u1: 'Dra. Autora', u2: 'Dr. Admin' });
    const target = await add('p1', '64', '2026-10-01T10:00:00.000Z', 'u1');
    await add('p1', '64', '2026-10-02T10:00:00.000Z', 'u1');
    await repo.createVoid({
      patientId: 'p1',
      target,
      reason: 'Registrado en el diente equivocado',
      performedById: 'u2',
    });

    const result = await new GetToothTimelineUseCase(repo).execute('p1', '64');

    expect(result).toHaveLength(2);
    const voided = result.find((r) => r.id === target.id);
    expect(voided?.performedByName).toBe('Dra. Autora');
    expect(voided?.void).toMatchObject({
      reason: 'Registrado en el diente equivocado',
      performedById: 'u2',
      performedByName: 'Dr. Admin',
    });
    expect(result.find((r) => r.id !== target.id)?.void).toBeNull();
  });
});
