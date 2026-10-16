import { ConflictException } from '@nestjs/common';
import type {
  PatientArchiveState,
  PatientRepository,
  PatientRetentionState,
  RetentionExpiringParams,
} from '../../domain/ports/patient-repository.port';
import {
  ArchivePatientUseCase,
  ListRetentionExpiringUseCase,
  PartiallySuppressPatientUseCase,
  SetRetentionExtensionUseCase,
} from './retention.use-cases';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const clock = (): Date => NOW;

function repoWith(retention: PatientRetentionState, pendingAppointments = 0) {
  const state: PatientArchiveState = { ...retention, pendingAppointments };
  const archived: string[] = [];
  const repo = {
    archive: async (
      id: string,
      assert: (s: PatientArchiveState) => void,
    ): Promise<void> => {
      await Promise.resolve();
      assert(state);
      archived.push(id);
    },
    partiallySuppress: jest.fn(
      async (
        _id: string,
        input: { assertAllowed: (s: PatientRetentionState) => void },
      ) => {
        await Promise.resolve();
        input.assertAllowed(state);
        return { id: 'p1' };
      },
    ),
    setRetentionExtension: jest.fn(() => Promise.resolve({ id: 'p1' })),
    listRetentionExpiring: jest.fn((_p: RetentionExpiringParams) =>
      Promise.resolve({ items: [], total: 0 }),
    ),
  };
  return { repo, archived };
}

describe('ArchivePatientUseCase (DX-039)', () => {
  it('archiva un paciente sin atenciones clínicas', async () => {
    const { repo, archived } = repoWith({
      lastAttentionAt: null,
      retentionExtended: 'NONE',
    });
    await new ArchivePatientUseCase(
      repo as unknown as PatientRepository,
      clock,
    ).execute('p1');
    expect(archived).toEqual(['p1']);
  });

  it('409 si la HC está en retención (no archiva)', async () => {
    const { repo, archived } = repoWith({
      lastAttentionAt: new Date('2025-01-10T00:00:00Z'),
      retentionExtended: 'NONE',
    });
    await expect(
      new ArchivePatientUseCase(
        repo as unknown as PatientRepository,
        clock,
      ).execute('p1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(archived).toEqual([]);
  });

  it('409 PATIENT_HAS_PENDING_APPOINTMENTS si tiene citas sin cerrar (no archiva)', async () => {
    const { repo, archived } = repoWith(
      { lastAttentionAt: null, retentionExtended: 'NONE' },
      2,
    );
    const err: unknown = await new ArchivePatientUseCase(
      repo as unknown as PatientRepository,
      clock,
    )
      .execute('p1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'PATIENT_HAS_PENDING_APPOINTMENTS',
      pendingAppointments: 2,
    });
    expect(archived).toEqual([]);
  });
});

describe('PartiallySuppressPatientUseCase', () => {
  it('recorta el motivo y exige que la HC esté en retención', async () => {
    const { repo } = repoWith({
      lastAttentionAt: new Date('2025-01-10T00:00:00Z'),
      retentionExtended: 'NONE',
    });
    await new PartiallySuppressPatientUseCase(
      repo as unknown as PatientRepository,
      clock,
    ).execute('p1', {
      reason: '  Reclamo Ley 1581 del titular  ',
      actorId: 'u1',
    });
    expect(repo.partiallySuppress).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ reason: 'Reclamo Ley 1581 del titular' }),
    );
  });

  it('409 si no está en retención', async () => {
    const { repo } = repoWith({
      lastAttentionAt: null,
      retentionExtended: 'NONE',
    });
    await expect(
      new PartiallySuppressPatientUseCase(
        repo as unknown as PatientRepository,
        clock,
      ).execute('p1', { reason: 'Reclamo Ley 1581', actorId: 'u1' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('SetRetentionExtensionUseCase', () => {
  it('pasa valor, motivo recortado y autor al repositorio', async () => {
    const { repo } = repoWith({
      lastAttentionAt: null,
      retentionExtended: 'NONE',
    });
    await new SetRetentionExtensionUseCase(
      repo as unknown as PatientRepository,
    ).execute('p1', {
      value: 'PERMANENT',
      reason: ' Víctima de DIH (Ley 1448) ',
      actorId: 'u1',
    });
    expect(repo.setRetentionExtension).toHaveBeenCalledWith('p1', {
      value: 'PERMANENT',
      reason: 'Víctima de DIH (Ley 1448)',
      actorId: 'u1',
    });
  });
});

describe('ListRetentionExpiringUseCase', () => {
  it('calcula los cortes de 15 y 30 años con el horizonte y topa la página', async () => {
    const { repo } = repoWith({
      lastAttentionAt: null,
      retentionExtended: 'NONE',
    });
    await new ListRetentionExpiringUseCase(
      repo as unknown as PatientRepository,
      clock,
    ).execute({ withinDays: 30, page: 2, pageSize: 500 });
    expect(repo.listRetentionExpiring).toHaveBeenCalledWith({
      noneBefore: new Date('2011-11-16T00:00:00.000Z'),
      doubleBefore: new Date('1996-11-16T00:00:00.000Z'),
      skip: 50,
      take: 50,
    });
  });
});
