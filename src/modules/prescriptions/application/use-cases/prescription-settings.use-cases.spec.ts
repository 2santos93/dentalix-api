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
    next: PrescriptionSettings,
  ): Promise<{ before: PrescriptionSettings; after: PrescriptionSettings }> {
    const before = this.settings;
    this.settings = { ...next };
    return Promise.resolve({ before, after: { ...next } });
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
    };
    await expect(
      new GetPrescriptionSettingsUseCase(repo).execute(),
    ).resolves.toEqual({
      printQuantityInWords: true,
      requireClinicalRecordNumber: true,
      validityDays: 7,
    });
  });

  it('update audits CLINIC_SETTINGS with PRESCRIPTION_SETTINGS, changedFields and RX codes', async () => {
    const next = {
      printQuantityInWords: true,
      requireClinicalRecordNumber: false,
      validityDays: 10,
    };
    await expect(update().execute(next, ctx)).resolves.toEqual(next);
    expect(repo.settings).toEqual(next);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith({
      tenantId: 't-1',
      locationId: 'l-1',
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
});
