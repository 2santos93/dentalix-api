import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';
import { CatalogKind, ToothRecordOrigin, ToothSurface } from '@prisma/client';
import { AddToothRecordUseCase } from './add-tooth-record.use-case';
import { CreateToothRecordRepoInput } from '../../domain/ports/tooth-record-repository.port';
import {
  InMemoryDentitionEventRepository,
  InMemoryToothRecordRepository,
} from '../__fixtures__/in-memory-odontogram';
import { patientsWithBirthDate } from '../__fixtures__/patients-with-birth-date.fake';

const NOW = new Date('2026-10-16T15:00:00.000Z');

/** Paciente adulto sin eventos: todas las posiciones en permanente. */
function makeUseCase(
  repo: InMemoryToothRecordRepository,
  patients = patientsInClinic('p1'),
  events = new InMemoryDentitionEventRepository(),
): AddToothRecordUseCase {
  return new AddToothRecordUseCase(repo, patients, events, () => NOW);
}

describe('AddToothRecordUseCase', () => {
  it('appends a new record and returns it', async () => {
    const repo = new InMemoryToothRecordRepository();
    const uc = makeUseCase(repo);

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
    const uc = makeUseCase(repo);

    const result = await uc.execute('p1', {
      toothNumber: '48',
      surfaces: [],
      kind: CatalogKind.PROCEDURE,
    });

    expect(result.surfaces).toEqual([]);
  });

  it('defaults surfaces to empty when omitted entirely', async () => {
    const repo = new InMemoryToothRecordRepository();
    const uc = makeUseCase(repo);

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
      const uc = makeUseCase(repo);

      const result = await uc.execute('p1', {
        toothNumber,
        surfaces: [],
        kind: CatalogKind.DIAGNOSIS,
      });

      expect(result.toothNumber).toBe(toothNumber);
    },
  );

  it.each(['51', '55', '61', '65', '71', '75', '81', '85'])(
    'accepts a valid primary (deciduous) FDI tooth number (%s) for a 4-year-old',
    async (toothNumber) => {
      const repo = new InMemoryToothRecordRepository();
      const uc = makeUseCase(repo, patientsWithBirthDate({ p1: '2022-05-01' }));

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
      const uc = makeUseCase(repo);

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
    const uc = makeUseCase(repo);

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
    const uc = makeUseCase(repo);

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
    const uc = makeUseCase(repo);

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
    const uc = makeUseCase(repo);

    const result = await uc.execute(
      'p1',
      { toothNumber: '11', surfaces: [], kind: CatalogKind.DIAGNOSIS },
      'user-77',
    );

    expect(result.performedById).toBe('user-77');
  });

  it('does NOT existence-check catalogItemId/clinicalEntryId — forwards them as given (RLS renders a bad/cross-tenant ref harmless; follow-up)', async () => {
    const repo = new InMemoryToothRecordRepository();
    const uc = makeUseCase(repo);

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

describe('AddToothRecordUseCase — pertenencia del paciente (SEC-004)', () => {
  it('rechaza con 404 "Paciente no encontrado" un paciente que no es de la clínica, sin insertar', async () => {
    const repo = new InMemoryToothRecordRepository();
    const uc = makeUseCase(repo);

    await expect(
      uc.execute('p-otra-clinica', {
        toothNumber: '11',
        kind: CatalogKind.DIAGNOSIS,
      }),
    ).rejects.toThrow(new NotFoundException('Paciente no encontrado'));
    expect(repo.rows).toHaveLength(0);
  });
});

describe('AddToothRecordUseCase — origen y dentición (DX-120)', () => {
  it('guarda el origen indicado y THIS_CLINIC por defecto', async () => {
    const repo = new InMemoryToothRecordRepository();
    const uc = makeUseCase(repo);

    const own = await uc.execute('p1', {
      toothNumber: '16',
      kind: CatalogKind.PROCEDURE,
    });
    const brought = await uc.execute('p1', {
      toothNumber: '26',
      kind: CatalogKind.PROCEDURE,
      origin: ToothRecordOrigin.PRE_EXISTING,
    });

    expect(own.origin).toBe(ToothRecordOrigin.THIS_CLINIC);
    expect(brought.origin).toBe(ToothRecordOrigin.PRE_EXISTING);
  });

  it('rechaza con 422 un temporal en una posición en permanente (adulto)', async () => {
    const repo = new InMemoryToothRecordRepository();
    const uc = makeUseCase(repo, patientsWithBirthDate({ p1: '1990-01-01' }));

    await expect(
      uc.execute('p1', { toothNumber: '55', kind: CatalogKind.DIAGNOSIS }),
    ).rejects.toThrow(UnprocessableEntityException);
    await expect(
      uc.execute('p1', { toothNumber: '55', kind: CatalogKind.DIAGNOSIS }),
    ).rejects.toThrow(/temporal.*permanente/);
    expect(repo.rows).toHaveLength(0);
  });

  it('rechaza con 422 un permanente en una posición en temporal (niño de 4 años)', async () => {
    const repo = new InMemoryToothRecordRepository();
    const uc = makeUseCase(repo, patientsWithBirthDate({ p1: '2022-05-01' }));

    await expect(
      uc.execute('p1', { toothNumber: '15', kind: CatalogKind.DIAGNOSIS }),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(repo.rows).toHaveLength(0);
  });

  it('un evento de dentición manda sobre la edad: tras exfoliar el 55, el 55 ya no admite registros', async () => {
    const repo = new InMemoryToothRecordRepository();
    const events = new InMemoryDentitionEventRepository();
    const uc = makeUseCase(
      repo,
      patientsWithBirthDate({ p1: '2019-10-16' }),
      events,
    );
    // 7 años: la posición 15 sigue en temporal por la edad.
    await uc.execute('p1', { toothNumber: '55', kind: CatalogKind.DIAGNOSIS });

    await events.createMany(
      'p1',
      [{ position: '15', dentition: 'PERMANENT', reason: 'EXFOLIATION' }],
      'u1',
    );

    await expect(
      uc.execute('p1', { toothNumber: '55', kind: CatalogKind.DIAGNOSIS }),
    ).rejects.toThrow(UnprocessableEntityException);
    const ok = await uc.execute('p1', {
      toothNumber: '15',
      kind: CatalogKind.DIAGNOSIS,
    });
    expect(ok.toothNumber).toBe('15');
  });

  it('en una posición mixta admite los dos dientes', async () => {
    const repo = new InMemoryToothRecordRepository();
    // 7 años: la posición 11 está mudando (mixta) por la edad.
    const uc = makeUseCase(repo, patientsWithBirthDate({ p1: '2019-10-16' }));

    await uc.execute('p1', { toothNumber: '51', kind: CatalogKind.DIAGNOSIS });
    await uc.execute('p1', { toothNumber: '11', kind: CatalogKind.DIAGNOSIS });

    expect(repo.rows.map((r) => r.toothNumber)).toEqual(['51', '11']);
  });
});
