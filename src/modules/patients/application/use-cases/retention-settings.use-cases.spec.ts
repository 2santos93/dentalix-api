import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type {
  ClinicRetentionSettingsRepository,
  RetentionSettingsWrite,
} from '../../domain/ports/clinic-retention-settings-repository.port';
import type { StoredRetentionTerm } from '../../domain/retention/retention-term-change';
import {
  GetRetentionSettingsUseCase,
  RETENTION_REDUCTION_UNCONFIRMED,
  RETENTION_SETTINGS_BUSY,
  UpdateRetentionSettingsUseCase,
} from './retention-settings.use-cases';

class FakeRetentionSettingsRepository implements ClinicRetentionSettingsRepository {
  stored: StoredRetentionTerm = {
    years: 15,
    raisedAt: null,
    yearsBeforeRaise: null,
  };
  write: RetentionSettingsWrite = { outcome: 'UNCHANGED', stored: this.stored };
  readonly sets: {
    input: { clinicalRecordRetentionYears: number; confirmReduction: boolean };
    now: Date;
  }[] = [];

  get(): Promise<StoredRetentionTerm> {
    return Promise.resolve(this.stored);
  }

  set(
    input: { clinicalRecordRetentionYears: number; confirmReduction: boolean },
    _ctx: AuditRequestContext,
    now: Date,
  ): Promise<RetentionSettingsWrite> {
    this.sets.push({ input, now });
    return Promise.resolve(this.write);
  }
}

const ctx: AuditRequestContext = {
  tenantId: 't-1',
  locationId: 'l-1',
  actor: { userId: 'u-admin', role: 'ADMIN' },
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};

const NOW = new Date('2026-11-01T12:00:00.000Z');

describe('Plazo de conservación de la HC (DX-330)', () => {
  let repo: FakeRetentionSettingsRepository;
  let now: Date;
  const update = (platformMinYears = 15) =>
    new UpdateRetentionSettingsUseCase(repo, { platformMinYears }, () => now);
  const get = (platformMinYears = 15) =>
    new GetRetentionSettingsUseCase(repo, { platformMinYears }, () => now);
  const conflictOf = async (
    run: Promise<unknown>,
  ): Promise<Record<string, unknown>> => {
    const error = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConflictException);
    return (error as ConflictException).getResponse() as Record<
      string,
      unknown
    >;
  };

  beforeEach(() => {
    repo = new FakeRetentionSettingsRepository();
    now = NOW;
  });

  describe('range', () => {
    it.each([14, 0, -1, 101, 15.5, Number.NaN])(
      '%p is a 400 with the range and writes nothing',
      async (value) => {
        const error = await update()
          .execute({ clinicalRecordRetentionYears: value }, ctx)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).message).toBe(
          'El plazo de conservación de la historia clínica tiene que ser un número entero de años entre 15 y 100.',
        );
        expect(repo.sets).toHaveLength(0);
      },
    );

    it('says the platform minimum when it is 20', async () => {
      const error = await update(20)
        .execute({ clinicalRecordRetentionYears: 19 }, ctx)
        .catch((e: unknown) => e);
      expect((error as BadRequestException).message).toContain(
        'entre 20 y 100',
      );
      expect((error as BadRequestException).message).not.toContain('15');
    });

    it.each([15, 100])('%p is accepted', async (value) => {
      await update().execute({ clinicalRecordRetentionYears: value }, ctx);
      expect(repo.sets).toHaveLength(1);
    });
  });

  describe('results', () => {
    it('passes the injected clock and a missing confirmReduction as false', async () => {
      await update().execute({ clinicalRecordRetentionYears: 20 }, ctx);
      expect(repo.sets).toEqual([
        {
          input: { clinicalRecordRetentionYears: 20, confirmReduction: false },
          now: NOW,
        },
      ]);
    });

    it('UNCHANGED answers with the stored term and no protected patients', async () => {
      repo.write = { outcome: 'UNCHANGED', stored: repo.stored };
      await expect(
        update().execute({ clinicalRecordRetentionYears: 15 }, ctx),
      ).resolves.toStrictEqual({
        clinicalRecordRetentionYears: 15,
        effectiveYears: 15,
        platformMinimumYears: 15,
        maximumYears: 100,
        correctionWindow: null,
        protectedPatients: 0,
      });
    });

    it('APPLIED answers with the new term, the window and the protected patients', async () => {
      const raisedAt = new Date(NOW.getTime() - 60_000);
      repo.write = {
        outcome: 'APPLIED',
        stored: { years: 20, raisedAt, yearsBeforeRaise: 15 },
        protectedPatients: 3,
      };
      await expect(
        update().execute(
          { clinicalRecordRetentionYears: 20, confirmReduction: true },
          ctx,
        ),
      ).resolves.toStrictEqual({
        clinicalRecordRetentionYears: 20,
        effectiveYears: 20,
        platformMinimumYears: 15,
        maximumYears: 100,
        correctionWindow: {
          previousYears: 15,
          until: new Date(raisedAt.getTime() + 24 * 3_600_000).toISOString(),
        },
        protectedPatients: 3,
      });
    });

    it('a stored term under the platform minimum answers with the minimum as effective', async () => {
      repo.write = {
        outcome: 'APPLIED',
        stored: { years: 15, raisedAt: null, yearsBeforeRaise: null },
        protectedPatients: 0,
      };
      const result = await update(20).execute(
        { clinicalRecordRetentionYears: 20 },
        ctx,
      );
      expect(result).toMatchObject({
        clinicalRecordRetentionYears: 15,
        effectiveYears: 20,
        platformMinimumYears: 20,
      });
    });
  });

  describe('409 RETENTION_REDUCTION_UNCONFIRMED', () => {
    const unconfirmed = (
      protectedPatients: number,
      withinCorrectionWindow = false,
    ): RetentionSettingsWrite => ({
      outcome: 'CONFIRMATION_REQUIRED',
      previousYears: 20,
      newYears: 15,
      referenceYears: 20,
      protectedPatients,
      withinCorrectionWindow,
    });

    it('carries the code and the four fields', async () => {
      repo.write = unconfirmed(2);
      const body = await conflictOf(
        update().execute({ clinicalRecordRetentionYears: 15 }, ctx),
      );
      expect(body).toMatchObject({
        statusCode: 409,
        code: RETENTION_REDUCTION_UNCONFIRMED,
        previousYears: 20,
        newYears: 15,
        protectedPatients: 2,
        withinCorrectionWindow: false,
      });
    });

    it.each([
      [
        0,
        'Vas a reducir el plazo de 20 a 15 años. Ninguna historia en retención mantiene una fecha anterior; el plazo de 15 años se aplica al resto y a las atenciones nuevas. Confirma la reducción para guardarla.',
      ],
      [
        1,
        'Vas a reducir el plazo de 20 a 15 años. 1 historia que hoy se conserva con 20 años mantiene su fecha de fin; el plazo de 15 años se aplica al resto y a las atenciones nuevas. Confirma la reducción para guardarla.',
      ],
      [
        2,
        'Vas a reducir el plazo de 20 a 15 años. 2 historias que hoy se conservan con 20 años mantienen su fecha de fin; el plazo de 15 años se aplica al resto y a las atenciones nuevas. Confirma la reducción para guardarla.',
      ],
    ])('the message with n = %p', async (n, message) => {
      repo.write = unconfirmed(n);
      const body = await conflictOf(
        update().execute({ clinicalRecordRetentionYears: 15 }, ctx),
      );
      expect(body.message).toBe(message);
    });

    it('prefixes the correction inside the window, with the reference term', async () => {
      repo.write = {
        outcome: 'CONFIRMATION_REQUIRED',
        previousYears: 25,
        newYears: 18,
        referenceYears: 20,
        protectedPatients: 2,
        withinCorrectionWindow: true,
      };
      const body = await conflictOf(
        update().execute({ clinicalRecordRetentionYears: 18 }, ctx),
      );
      expect(body.withinCorrectionWindow).toBe(true);
      expect(body.message).toBe(
        'Estás corrigiendo una subida de hace menos de 24 horas: esa subida no deja fechas fijadas. Vas a reducir el plazo de 25 a 18 años. 2 historias que hoy se conservan con 20 años mantienen su fecha de fin; el plazo de 18 años se aplica al resto y a las atenciones nuevas. Confirma la reducción para guardarla.',
      );
    });
  });

  describe('409 RETENTION_SETTINGS_BUSY', () => {
    it.each([
      [
        'CONTENTION',
        'Hay otra operación con los pacientes de la clínica en curso. Intenta de nuevo en unos segundos.',
      ],
      [
        'TIMEOUT',
        'Reducir el plazo está tardando demasiado. Intenta de nuevo en unos minutos; si se repite, avisa a soporte.',
      ],
    ] as const)('%s', async (reason, message) => {
      repo.write = { outcome: 'BUSY', reason };
      const body = await conflictOf(
        update().execute(
          { clinicalRecordRetentionYears: 15, confirmReduction: true },
          ctx,
        ),
      );
      expect(body).toMatchObject({
        statusCode: 409,
        code: RETENTION_SETTINGS_BUSY,
        message,
      });
    });
  });

  describe('GET', () => {
    const raisedAt = new Date('2026-11-01T00:00:00.000Z');
    const raised = (): StoredRetentionTerm => ({
      years: 20,
      raisedAt,
      yearsBeforeRaise: 15,
    });

    it('shows the correction window one millisecond before the 24 h', async () => {
      repo.stored = raised();
      now = new Date(raisedAt.getTime() + 24 * 3_600_000 - 1);
      await expect(get().execute()).resolves.toStrictEqual({
        clinicalRecordRetentionYears: 20,
        effectiveYears: 20,
        platformMinimumYears: 15,
        maximumYears: 100,
        correctionWindow: {
          previousYears: 15,
          until: '2026-11-02T00:00:00.000Z',
        },
      });
    });

    it('closes the window at exactly 24 h', async () => {
      repo.stored = raised();
      now = new Date(raisedAt.getTime() + 24 * 3_600_000);
      await expect(get().execute()).resolves.toMatchObject({
        clinicalRecordRetentionYears: 20,
        correctionWindow: null,
      });
    });

    it('has no window when nothing was raised', async () => {
      await expect(get().execute()).resolves.toMatchObject({
        correctionWindow: null,
      });
    });
  });
});
