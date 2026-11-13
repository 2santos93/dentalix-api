import { BadRequestException } from '@nestjs/common';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { InMemoryPatientSettingsRepository } from '../__fixtures__/in-memory-patient-settings.repository';
import {
  GetPatientLanguagesUseCase,
  UpdatePatientLanguagesUseCase,
} from './patient-languages.use-cases';

describe('Idiomas de los pacientes (DX-497)', () => {
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
    new UpdatePatientLanguagesUseCase(
      repo,
      audit as unknown as RecordAuditEventUseCase,
    );

  beforeEach(() => {
    repo = new InMemoryPatientSettingsRepository();
    audit.record.mockReset();
  });

  it('lee la lista y el idioma de la clínica', async () => {
    repo.patientLanguages = ['es', 'en'];
    await expect(
      new GetPatientLanguagesUseCase(repo).execute(),
    ).resolves.toEqual({ languages: ['es', 'en'], clinicLanguage: 'es' });
  });

  it('añade en y ca normalizados y audita el antes y el después (sin sede)', async () => {
    await expect(
      update().execute({ languages: ['es', 'EN', 'ca', 'en'] }, ctx),
    ).resolves.toEqual({ languages: ['es', 'en', 'ca'], clinicLanguage: 'es' });
    expect(repo.patientLanguages).toEqual(['es', 'en', 'ca']);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith({
      tenantId: 't-1',
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
        reason: 'PATIENT_LANGUAGES_SETTINGS',
        changedFields: ['patientLanguages'],
        configChange: {
          before: { patientLanguages: ['es'] },
          after: { patientLanguages: ['es', 'en', 'ca'] },
        },
      },
    });
  });

  it('el idioma de la clínica no se puede quitar: vuelve al principio', async () => {
    await expect(
      update().execute({ languages: ['en'] }, ctx),
    ).resolves.toMatchObject({ languages: ['es', 'en'] });
  });

  it('la misma lista es 200 sin auditoría', async () => {
    repo.patientLanguages = ['es', 'en'];
    await update().execute({ languages: ['es', 'en'] }, ctx);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    [['es', 'english']],
    [['es', 'e']],
    [['es', '']],
    [['es', 'en_US!']],
  ])(
    'una etiqueta no válida es 400 y no guarda nada (%j)',
    async (languages) => {
      await expect(update().execute({ languages }, ctx)).rejects.toThrow(
        BadRequestException,
      );
      expect(repo.patientLanguages).toEqual(['es']);
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('más de 20 idiomas es 400', async () => {
    const many = Array.from(
      { length: 21 },
      (_, i) =>
        String.fromCharCode(97 + (i % 26)) +
        String.fromCharCode(97 + Math.floor(i / 26) + 1),
    );
    await expect(update().execute({ languages: many }, ctx)).rejects.toThrow(
      BadRequestException,
    );
  });
});
