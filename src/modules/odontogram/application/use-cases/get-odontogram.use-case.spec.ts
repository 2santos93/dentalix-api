import { BadRequestException } from '@nestjs/common';
import { CatalogKind } from '@prisma/client';
import { GetOdontogramUseCase } from './get-odontogram.use-case';
import { InMemoryToothRecordRepository } from '../__fixtures__/in-memory-odontogram';

// Bogotá (UTC-5): "hoy" es 2026-10-16 hasta las 05:00 UTC del 17.
const NOW = new Date('2026-10-16T20:00:00.000Z');

function seeded() {
  // Las anulaciones toman la fecha de este reloj: el 16.
  const repo = new InMemoryToothRecordRepository(() => NOW);
  const add = (toothNumber: string, recordedAt: string, notes?: string) =>
    repo.create({
      patientId: 'p1',
      toothNumber,
      surfaces: [],
      kind: CatalogKind.DIAGNOSIS,
      notes,
      recordedAt: new Date(recordedAt),
    });
  return { repo, add };
}

describe('GetOdontogramUseCase', () => {
  it('returns an empty array when the patient has no records', async () => {
    const { repo } = seeded();
    const uc = new GetOdontogramUseCase(repo, () => NOW);

    expect(await uc.execute('p1')).toEqual([]);
  });

  it('groups records by toothNumber, ordered by toothNumber ascending', async () => {
    const { repo, add } = seeded();
    await add('48', '2026-10-01T10:00:00Z');
    await add('11', '2026-10-02T10:00:00Z');
    await add('11', '2026-10-03T10:00:00Z');
    await add('21', '2026-10-04T10:00:00Z');
    const uc = new GetOdontogramUseCase(repo, () => NOW);

    const result = await uc.execute('p1');

    expect(result.map((g) => g.toothNumber)).toEqual(['11', '21', '48']);
    expect(result[0].records).toHaveLength(2);
  });

  it('scopes by patientId (does not leak another patient records)', async () => {
    const { repo, add } = seeded();
    await add('11', '2026-10-01T10:00:00Z');
    const uc = new GetOdontogramUseCase(repo, () => NOW);

    expect(await uc.execute('p2')).toEqual([]);
  });

  it('keeps each record intact inside its group (no data loss/mutation)', async () => {
    const { repo, add } = seeded();
    const record = await add('11', '2026-10-01T10:00:00Z', 'nota importante');
    const uc = new GetOdontogramUseCase(repo, () => NOW);

    expect((await uc.execute('p1'))[0].records[0]).toEqual(record);
  });

  describe('anulación y carta a una fecha (DX-120)', () => {
    it('no pinta lo anulado ni la anulación', async () => {
      const { repo, add } = seeded();
      const target = await add('64', '2026-10-01T10:00:00Z');
      await add('65', '2026-10-02T10:00:00Z');
      await repo.createVoid({
        patientId: 'p1',
        target,
        reason: 'Diente equivocado',
        performedById: 'u1',
      });
      const uc = new GetOdontogramUseCase(repo, () => NOW);

      const result = await uc.execute('p1');

      expect(result.map((g) => g.toothNumber)).toEqual(['65']);
    });

    it('asOf incluye lo anulado después y excluye lo posterior, cortando el día en la zona de la clínica', async () => {
      const { repo, add } = seeded();
      const target = await add('64', '2026-10-01T10:00:00Z');
      // 2026-10-05 a las 23:30 en Bogotá = 04:30 UTC del 6: sigue siendo el 5.
      await add('65', '2026-10-06T04:30:00Z');
      // 2026-10-06 en Bogotá: posterior.
      await add('84', '2026-10-06T15:00:00Z');
      // La anulación de 64 lleva la fecha del reloj del doble: el 16.
      await repo.createVoid({
        patientId: 'p1',
        target,
        reason: 'Diente equivocado',
        performedById: 'u1',
      });
      const uc = new GetOdontogramUseCase(repo, () => NOW);

      const result = await uc.execute('p1', '2026-10-05');

      expect(result.map((g) => g.toothNumber)).toEqual(['64', '65']);
    });

    it.each(['2026-13-01', '16/10/2026', '2026-02-30'])(
      'rechaza con 400 una fecha inválida (%s)',
      async (asOf) => {
        const { repo } = seeded();
        const uc = new GetOdontogramUseCase(repo, () => NOW);
        await expect(uc.execute('p1', asOf)).rejects.toThrow(
          BadRequestException,
        );
      },
    );

    it('rechaza con 400 una fecha futura', async () => {
      const { repo } = seeded();
      const uc = new GetOdontogramUseCase(repo, () => NOW);
      await expect(uc.execute('p1', '2026-10-17')).rejects.toThrow(/futura/);
    });
  });
});
