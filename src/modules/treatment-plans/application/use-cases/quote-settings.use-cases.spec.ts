import { BadRequestException } from '@nestjs/common';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { sanitizeAuditMetadata } from '../../../audit/domain/audit-metadata';
import {
  PLATFORM_DEFAULT_QUOTE_VALIDITY_DAYS,
  QUOTE_VALIDITY_DAYS_MESSAGE,
  type QuoteSettings,
} from '../../domain/quote-validity';
import type { QuoteSettingsRepository } from '../../domain/ports/quote-settings-repository.port';
import {
  GetQuoteSettingsUseCase,
  UpdateQuoteSettingsUseCase,
} from './quote-settings.use-cases';

class InMemoryQuoteSettingsRepository implements QuoteSettingsRepository {
  settings: QuoteSettings = {
    validityDays: PLATFORM_DEFAULT_QUOTE_VALIDITY_DAYS,
  };
  writes = 0;

  get(): Promise<QuoteSettings> {
    return Promise.resolve({ ...this.settings });
  }

  set(
    next: QuoteSettings,
  ): Promise<{ before: QuoteSettings; after: QuoteSettings }> {
    this.writes += 1;
    const before = this.settings;
    this.settings = { ...next };
    return Promise.resolve({ before, after: { ...next } });
  }
}

describe('Ajuste de validez del presupuesto (DX-379, D-12)', () => {
  let repo: InMemoryQuoteSettingsRepository;
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
    new UpdateQuoteSettingsUseCase(
      repo,
      audit as unknown as RecordAuditEventUseCase,
    );

  beforeEach(() => {
    repo = new InMemoryQuoteSettingsRepository();
    audit.record.mockReset();
  });

  it('lee el ajuste de la clínica (30 de plataforma)', async () => {
    await expect(new GetQuoteSettingsUseCase(repo).execute()).resolves.toEqual({
      validityDays: 30,
    });
  });

  it('al cambiarlo audita CLINIC_SETTINGS con QUOTE_SETTINGS, el campo y los códigos QT', async () => {
    await expect(update().execute({ validityDays: 15 }, ctx)).resolves.toEqual({
      validityDays: 15,
    });
    expect(repo.settings).toEqual({ validityDays: 15 });
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
        reason: 'QUOTE_SETTINGS',
        changedFields: ['validityDays'],
        statusChange: { from: 'QT_V30', to: 'QT_V15' },
      },
    });
  });

  it('la metadata pasa entera por la lista cerrada de auditoría', async () => {
    await update().execute({ validityDays: 45 }, ctx);
    const [[event]] = audit.record.mock.calls as [[{ metadata: unknown }]];
    expect(sanitizeAuditMetadata(event.metadata)).toEqual(event.metadata);
  });

  it('sin cambios, 200 sin evento de auditoría', async () => {
    await update().execute({ validityDays: 30 }, ctx);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([0, 366, 1.5, -3])(
    'rechaza %p días con el mensaje en español y no escribe',
    async (validityDays) => {
      await expect(update().execute({ validityDays }, ctx)).rejects.toThrow(
        new BadRequestException(QUOTE_VALIDITY_DAYS_MESSAGE),
      );
      expect(repo.writes).toBe(0);
      expect(audit.record).not.toHaveBeenCalled();
    },
  );
});
