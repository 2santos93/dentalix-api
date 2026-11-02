import { ConflictException, NotFoundException } from '@nestjs/common';
import type {
  PatientArchiveState,
  PatientRepository,
  PatientRetentionState,
  RetentionExpiringParams,
} from '../../domain/ports/patient-repository.port';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { PatientPublicLinksReader } from '../../domain/ports/patient-public-links.port';
import {
  ArchivePatientUseCase,
  CountPatientLivePublicLinksUseCase,
  ListRetentionExpiringUseCase,
  PartiallySuppressPatientUseCase,
  SetRetentionExtensionUseCase,
} from './retention.use-cases';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const clock = (): Date => NOW;
const CTX: AuditRequestContext = {
  tenantId: 't1',
  locationId: null,
  actor: { userId: 'u1', role: 'ADMIN' },
  requestId: 'req-1',
  ip: '203.0.113.1',
  userAgent: 'jest',
};

function repoWith(
  retention: Partial<PatientRetentionState>,
  pendingAppointments = 0,
) {
  const state: PatientArchiveState = {
    lastAttentionAt: null,
    retentionExtended: 'NONE',
    retentionFloorUntil: null,
    years: 15,
    ...retention,
    pendingAppointments,
  };
  const archived: string[] = [];
  const revocations: { now: Date; ctx: AuditRequestContext }[] = [];
  const repo = {
    archive: async (
      id: string,
      assert: (s: PatientArchiveState) => void,
      revocation: { now: Date; ctx: AuditRequestContext },
    ): Promise<void> => {
      await Promise.resolve();
      assert(state);
      archived.push(id);
      revocations.push(revocation);
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
  return { repo, archived, revocations };
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
    ).execute('p1', CTX);
    expect(archived).toEqual(['p1']);
  });

  it('DX-461: anula los enlaces con la hora del reloj y quién archiva', async () => {
    const { repo, revocations } = repoWith({
      lastAttentionAt: null,
      retentionExtended: 'NONE',
    });
    await new ArchivePatientUseCase(
      repo as unknown as PatientRepository,
      clock,
    ).execute('p1', CTX);
    expect(revocations).toEqual([{ now: NOW, ctx: CTX }]);
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
      ).execute('p1', CTX),
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
      .execute('p1', CTX)
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
      reason: '  Solicitud del paciente sobre sus datos  ',
      actorId: 'u1',
    });
    expect(repo.partiallySuppress).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        reason: 'Solicitud del paciente sobre sus datos',
      }),
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
      ).execute('p1', { reason: 'Solicitud del paciente', actorId: 'u1' }),
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
      reason: ' Caso especial de la clínica ',
      actorId: 'u1',
    });
    expect(repo.setRetentionExtension).toHaveBeenCalledWith('p1', {
      value: 'PERMANENT',
      reason: 'Caso especial de la clínica',
      actorId: 'u1',
    });
  });
});

describe('ArchivePatientUseCase con el plazo de la clínica (DX-330)', () => {
  it('una atención vencida con 15 no se archiva con 20 ni con suelo', async () => {
    const lastAttentionAt = new Date('2010-06-15T00:00:00Z');
    for (const retention of [
      { lastAttentionAt, years: 20 },
      {
        lastAttentionAt,
        retentionFloorUntil: new Date('2030-06-15T00:00:00Z'),
      },
    ]) {
      const { repo, archived } = repoWith(retention);
      await expect(
        new ArchivePatientUseCase(
          repo as unknown as PatientRepository,
          clock,
        ).execute('p1', CTX),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(archived).toEqual([]);
    }
  });
});

describe('ListRetentionExpiringUseCase', () => {
  it('pasa el día siguiente al horizonte, sin años, y topa la página', async () => {
    const { repo } = repoWith({
      lastAttentionAt: null,
      retentionExtended: 'NONE',
    });
    await new ListRetentionExpiringUseCase(
      repo as unknown as PatientRepository,
      clock,
    ).execute({ withinDays: 30, page: 2, pageSize: 500 });
    expect(repo.listRetentionExpiring).toHaveBeenCalledWith({
      horizonNext: new Date('2026-11-16T00:00:00.000Z'),
      skip: 50,
      take: 50,
    });
  });
});

describe('CountPatientLivePublicLinksUseCase (DX-461)', () => {
  const counts = {
    slotOffers: 1,
    consentSignatures: 0,
    budgetSignatures: 2,
    signedPdfCopies: 0,
    anamnesis: 1,
  };

  it('devuelve los enlaces vivos por tipo y el total, a la hora del reloj', async () => {
    const countLive = jest.fn(() => Promise.resolve(counts));
    const reader: PatientPublicLinksReader = { countLive };
    await expect(
      new CountPatientLivePublicLinksUseCase(reader, clock).execute('p1'),
    ).resolves.toEqual({ ...counts, total: 4 });
    expect(countLive).toHaveBeenCalledWith('p1', NOW);
  });

  it('404 si el paciente no existe (o ya está archivado) en la clínica', async () => {
    const reader: PatientPublicLinksReader = {
      countLive: () => Promise.resolve(null),
    };
    await expect(
      new CountPatientLivePublicLinksUseCase(reader, clock).execute('p1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
