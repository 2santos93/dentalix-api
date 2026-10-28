import { BadRequestException } from '@nestjs/common';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { MAJORITY_AGE_MESSAGE } from '../../domain/responsible-parties/majority-age';
import type { PatientSettingsRepository } from '../../domain/ports/patient-settings-repository.port';
import {
  GetPatientSettingsUseCase,
  UpdatePatientSettingsUseCase,
} from './patient-settings.use-cases';

class InMemoryPatientSettingsRepository implements PatientSettingsRepository {
  majorityAge = 18;

  getMajorityAge(): Promise<number> {
    return Promise.resolve(this.majorityAge);
  }

  setMajorityAge(age: number): Promise<{ before: number; after: number }> {
    const before = this.majorityAge;
    this.majorityAge = age;
    return Promise.resolve({ before, after: age });
  }
}

describe('Mayoría de edad de la clínica (DX-328)', () => {
  let repo: InMemoryPatientSettingsRepository;
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
    new UpdatePatientSettingsUseCase(
      repo,
      audit as unknown as RecordAuditEventUseCase,
    );

  beforeEach(() => {
    repo = new InMemoryPatientSettingsRepository();
    audit.record.mockReset();
  });

  it('reads the clinic majority age', async () => {
    repo.majorityAge = 20;
    await expect(
      new GetPatientSettingsUseCase(repo).execute(),
    ).resolves.toEqual({ majorityAge: 20 });
  });

  it('update majority age audits AGE_18 → AGE_16', async () => {
    await expect(update().execute({ majorityAge: 16 }, ctx)).resolves.toEqual({
      majorityAge: 16,
    });
    expect(repo.majorityAge).toBe(16);
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
        reason: 'MAJORITY_AGE_SETTINGS',
        statusChange: { from: 'AGE_18', to: 'AGE_16' },
      },
    });
  });

  it('same value is 200 without audit', async () => {
    await expect(update().execute({ majorityAge: 18 }, ctx)).resolves.toEqual({
      majorityAge: 18,
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([13, 22, 18.5])(
    '13, 22 and 18.5 are 400 with the message (%p)',
    async (majorityAge) => {
      const error = await update()
        .execute({ majorityAge }, ctx)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe(MAJORITY_AGE_MESSAGE);
      expect(repo.majorityAge).toBe(18);
      expect(audit.record).not.toHaveBeenCalled();
    },
  );
});
