import { Logger } from '@nestjs/common';
import { RecordAuditEventUseCase } from './record-audit-event.use-case';
import type { AuditEventRepository } from '../domain/ports/audit-event-repository.port';
import type { AuditEventDraft } from '../domain/audit-event';

function draft(overrides: Partial<AuditEventDraft> = {}): AuditEventDraft {
  return {
    tenantId: '00000000-0000-4000-8000-000000000001',
    locationId: null,
    actor: {
      kind: 'user',
      userId: '00000000-0000-4000-8000-000000000002',
      role: 'DENTIST',
    },
    action: 'VIEW',
    resourceType: 'MEDICAL_HISTORY',
    resourceId: null,
    patient: { kind: 'patient', id: '00000000-0000-4000-8000-000000000003' },
    requestId: 'req-000001',
    ip: '127.0.0.1',
    userAgent: 'jest',
    metadata: {},
    ...overrides,
  };
}

function repoWith(
  insert: jest.Mock<Promise<void>, [AuditEventDraft]>,
): AuditEventRepository {
  return {
    insert,
    list: jest.fn(),
    clinicTimeZone: jest.fn(),
  };
}

describe('RecordAuditEventUseCase (DX-009)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('escribe UN evento con la metadata saneada', async () => {
    const insert = jest
      .fn<Promise<void>, [AuditEventDraft]>()
      .mockResolvedValue(undefined);
    const useCase = new RecordAuditEventUseCase(repoWith(insert));
    await useCase.record(
      draft({
        metadata: {
          changedFields: ['allergies'],
          // Una clave que no está en la lista no llega a la BD.
          ...({ note: 'alérgica a la penicilina' } as object),
        },
      }),
    );
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0].metadata).toEqual({
      changedFields: ['allergies'],
    });
  });

  it('recorta un user agent desmesurado', async () => {
    const insert = jest
      .fn<Promise<void>, [AuditEventDraft]>()
      .mockResolvedValue(undefined);
    await new RecordAuditEventUseCase(repoWith(insert)).record(
      draft({ userAgent: 'x'.repeat(5000) }),
    );
    expect(insert.mock.calls[0][0].userAgent).toHaveLength(512);
  });

  it('si la BD falla NO lanza: lo deja en el log (tipo del error, sin su mensaje)', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const failure = new Error('insert failed: Paula Pérez');
    const insert = jest
      .fn<Promise<void>, [AuditEventDraft]>()
      .mockRejectedValue(failure);
    await expect(
      new RecordAuditEventUseCase(repoWith(insert)).record(draft()),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(error.mock.calls[0]);
    expect(logged).toContain('Error');
    expect(logged).toContain('VIEW');
    expect(logged).toContain('MEDICAL_HISTORY');
    expect(logged).not.toContain('Paula');
  });
});
