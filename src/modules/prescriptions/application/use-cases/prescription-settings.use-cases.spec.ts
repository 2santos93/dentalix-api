import { BadRequestException } from '@nestjs/common';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS,
  PRESCRIPTION_VALIDITY_DAYS_MESSAGE,
  type PrescriptionSettings,
} from '../../domain/prescription-settings';
import type { PrescriptionSettingsRepository } from '../../domain/ports/prescription-settings-repository.port';
import {
  GetPrescriptionSettingsUseCase,
  UpdatePrescriptionSettingsUseCase,
} from './prescription-settings.use-cases';

class InMemoryPrescriptionSettingsRepository implements PrescriptionSettingsRepository {
  settings: PrescriptionSettings = {
    ...PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS,
  };

  get(): Promise<PrescriptionSettings> {
    return Promise.resolve({ ...this.settings });
  }

  set(
    next: Parameters<PrescriptionSettingsRepository['set']>[0],
  ): Promise<{ before: PrescriptionSettings; after: PrescriptionSettings }> {
    const before = this.settings;
    // DX-468: sin pie en la entrada, se queda el que había.
    this.settings = {
      ...next,
      patientCopyFooter:
        next.patientCopyFooter === undefined
          ? before.patientCopyFooter
          : next.patientCopyFooter,
    };
    return Promise.resolve({ before, after: { ...this.settings } });
  }
}

describe('Ajustes de la receta de la clínica (DX-324)', () => {
  let repo: InMemoryPrescriptionSettingsRepository;
  const audit = { record: jest.fn() };
  const ctx: AuditRequestContext = {
    tenantId: 't-1',
    locationId: 'l-1',
    actor: { userId: 'u-admin', role: 'ADMIN' },
    requestId: 'req-1',
    ip: null,
    userAgent: null,
  };
  const update = () =>
    new UpdatePrescriptionSettingsUseCase(
      repo,
      audit as unknown as RecordAuditEventUseCase,
    );

  beforeEach(() => {
    repo = new InMemoryPrescriptionSettingsRepository();
    audit.record.mockReset();
  });

  it('reads the clinic prescription settings', async () => {
    repo.settings = {
      printQuantityInWords: true,
      requireClinicalRecordNumber: true,
      validityDays: 7,
      patientCopyFooter: null,
    };
    await expect(
      new GetPrescriptionSettingsUseCase(repo).execute(),
    ).resolves.toEqual({
      printQuantityInWords: true,
      requireClinicalRecordNumber: true,
      validityDays: 7,
      patientCopyFooter: null,
    });
  });

  it('update audits CLINIC_SETTINGS with PRESCRIPTION_SETTINGS, changedFields and RX codes', async () => {
    const next = {
      printQuantityInWords: true,
      requireClinicalRecordNumber: false,
      validityDays: 10,
    };
    await expect(update().execute(next, ctx)).resolves.toEqual({
      ...next,
      patientCopyFooter: null,
    });
    expect(repo.settings).toEqual({ ...next, patientCopyFooter: null });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith({
      tenantId: 't-1',
      // DX-363: con sede activa en el contexto, el evento va sin sede.
      locationId: null,
      actor: { kind: 'user', userId: 'u-admin', role: 'ADMIN' },
      action: 'UPDATE',
      resourceType: 'CLINIC_SETTINGS',
      resourceId: null,
      patient: null,
      requestId: 'req-1',
      ip: null,
      userAgent: null,
      metadata: {
        reason: 'PRESCRIPTION_SETTINGS',
        changedFields: ['printQuantityInWords', 'validityDays'],
        statusChange: { from: 'RX_W0_H0_V30', to: 'RX_W1_H0_V10' },
      },
    });
  });

  it('same values are 200 without audit', async () => {
    await expect(
      update().execute({ ...PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS }, ctx),
    ).resolves.toEqual(PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([0, 366, 1.5])(
    'validity 0, 366 and 1.5 are 400 with PRESCRIPTION_VALIDITY_DAYS_MESSAGE (%p)',
    async (validityDays) => {
      const error = await update()
        .execute(
          {
            printQuantityInWords: true,
            requireClinicalRecordNumber: true,
            validityDays,
          },
          ctx,
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe(
        PRESCRIPTION_VALIDITY_DAYS_MESSAGE,
      );
      expect(repo.settings).toEqual(PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS);
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  describe('pie de la copia para el paciente (DX-468)', () => {
    const base = {
      printQuantityInWords: false,
      requireClinicalRecordNumber: false,
      validityDays: 30,
    };

    it('se guarda recortado y queda en changedFields (sin el texto en el evento)', async () => {
      const saved = await update().execute(
        { ...base, patientCopyFooter: '  Copia informativa.  ' },
        ctx,
      );
      expect(saved.patientCopyFooter).toBe('Copia informativa.');
      const calls = audit.record.mock.calls as unknown as [
        { metadata: { changedFields: string[] } },
      ][];
      const event = calls[0][0];
      expect(event.metadata.changedFields).toEqual(['patientCopyFooter']);
      expect(JSON.stringify(event)).not.toContain('Copia informativa');
    });

    it('vacío vuelve al de plataforma (null); ausente no lo toca', async () => {
      repo.settings = { ...base, patientCopyFooter: 'Texto anterior' };
      await expect(update().execute(base, ctx)).resolves.toMatchObject({
        patientCopyFooter: 'Texto anterior',
      });
      await expect(
        update().execute({ ...base, patientCopyFooter: '   ' }, ctx),
      ).resolves.toMatchObject({ patientCopyFooter: null });
    });

    it('más de 300 caracteres: 400 sin escribir', async () => {
      const error = await update()
        .execute({ ...base, patientCopyFooter: 'x'.repeat(301) }, ctx)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(repo.settings.patientCopyFooter).toBeNull();
    });
  });
});
