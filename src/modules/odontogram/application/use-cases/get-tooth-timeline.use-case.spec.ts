import { BadRequestException } from '@nestjs/common';
import { CatalogKind } from '@prisma/client';
import { GetToothTimelineUseCase } from './get-tooth-timeline.use-case';
import { InMemoryToothRecordRepository } from '../__fixtures__/in-memory-odontogram';

// Caracas va a UTC-4 todo el año: el 2026-10-16 15:00Z es mediodía allí.
const NOW = () => new Date('2026-10-16T15:00:00.000Z');

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
    expect(
      await new GetToothTimelineUseCase(repo, NOW).execute('p1', '11'),
    ).toEqual([]);
  });

  it('returns records most recent first, scoped by patient and tooth', async () => {
    const { repo, add } = repoWith();
    // Inserted OUT OF ORDER on purpose.
    await add('p1', '11', '2026-01-02T00:00:00.000Z');
    await add('p1', '11', '2026-01-05T00:00:00.000Z');
    await add('p1', '11', '2026-01-01T00:00:00.000Z');
    await add('p1', '48', '2026-01-03T00:00:00.000Z');
    await add('p2', '11', '2026-01-04T00:00:00.000Z');

    const result = await new GetToothTimelineUseCase(repo, NOW).execute(
      'p1',
      '11',
    );

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

    const result = await new GetToothTimelineUseCase(repo, NOW).execute(
      'p1',
      '64',
    );

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

  describe('asOf en el día de la sede (DX-132)', () => {
    it('corta al final del día civil de Caracas, no de UTC', async () => {
      const { repo, add } = repoWith();
      // 2026-10-01 23:30 en Caracas = 2026-10-02 03:30Z (otro día en UTC).
      const lateLocal = await add('p1', '11', '2026-10-02T03:30:00.000Z');
      // 2026-10-02 00:30 en Caracas: ya no entra en la carta del día 1.
      await add('p1', '11', '2026-10-02T04:30:00.000Z');

      const result = await new GetToothTimelineUseCase(repo, NOW).execute(
        'p1',
        '11',
        '2026-10-01',
      );

      expect(result.map((r) => r.id)).toEqual([lateLocal.id]);
    });

    it('lo anulado DESPUÉS de la fecha sale sin anular, como en la carta de ese día', async () => {
      const { repo, add } = repoWith({ u1: 'Dra. Autora' });
      const target = await add('p1', '64', '2026-10-01T14:00:00.000Z', 'u1');
      // La anulación la fecha el reloj del repo: 2026-10-16.
      await repo.createVoid({
        patientId: 'p1',
        target,
        reason: 'Registrado en el diente equivocado',
        performedById: 'u1',
      });
      const useCase = new GetToothTimelineUseCase(repo, NOW);

      const before = await useCase.execute('p1', '64', '2026-10-10');
      const today = await useCase.execute('p1', '64', '2026-10-16');

      expect(before).toHaveLength(1);
      expect(before[0].void).toBeNull();
      expect(today[0].void?.reason).toBe('Registrado en el diente equivocado');
    });

    it('una fecha futura en la zona de la sede da 400 ODONTOGRAM_AS_OF_FUTURE', async () => {
      const { repo } = repoWith();
      const err = await new GetToothTimelineUseCase(repo, NOW)
        .execute('p1', '11', '2026-10-17')
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        statusCode: 400,
        code: 'ODONTOGRAM_AS_OF_FUTURE',
        message: 'La fecha de la carta no puede ser futura',
      });
    });

    it('una fecha que no existe da 400 ODONTOGRAM_AS_OF_INVALID', async () => {
      const { repo } = repoWith();
      await expect(
        new GetToothTimelineUseCase(repo, NOW).execute(
          'p1',
          '11',
          '2026-02-30',
        ),
      ).rejects.toMatchObject({
        response: { code: 'ODONTOGRAM_AS_OF_INVALID' },
      });
    });
  });
});
