import { BadRequestException } from '@nestjs/common';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { InMemoryClinicalNoteTemplateRepository } from '../../../clinical-note-templates/application/__fixtures__/in-memory-clinical-note-templates';
import {
  InMemoryClinicalEntryRepository,
  InMemoryClinicalEntrySettingsRepository,
} from '../__fixtures__/in-memory-clinical-entries';
import { PROFESSIONAL_LICENSE_MISSING_MESSAGE } from '../../domain/author-license';
import { CreateClinicalEntryUseCase } from './create-clinical-entry.use-case';
import {
  GetClinicalEntrySettingsUseCase,
  GetClinicalEntrySigningUseCase,
  UpdateClinicalEntrySettingsUseCase,
} from './clinical-entry-settings.use-cases';

const MISSING = {
  code: 'PROFESSIONAL_LICENSE_MISSING',
  message: PROFESSIONAL_LICENSE_MISSING_MESSAGE,
};

function setup() {
  const repo = new InMemoryClinicalEntryRepository();
  const settings = new InMemoryClinicalEntrySettingsRepository();
  const uc = new CreateClinicalEntryUseCase(
    repo,
    patientsInClinic('p1'),
    new InMemoryClinicalNoteTemplateRepository(),
    new TenantContextService(),
    settings,
  );
  return { repo, settings, uc };
}

describe('CreateClinicalEntryUseCase · registro profesional del autor (DX-540)', () => {
  it('aviso activo y autor sin registro: se guarda y la respuesta trae el aviso', async () => {
    const { repo, settings, uc } = setup();
    settings.value = { warnMissingProfessionalLicense: true };

    const entry = await uc.execute('p1', { notes: 'Control' }, 'u-sin');

    expect(repo.rows).toHaveLength(1);
    expect(entry.authorProfessionalLicense).toBeNull();
    expect(entry.warnings).toEqual([MISSING]);
  });

  it('aviso activo y autor con registro: sin aviso y el número queda en la evolución', async () => {
    const { repo, settings, uc } = setup();
    settings.value = { warnMissingProfessionalLicense: true };
    repo.licenses.set('u-con', ' RP-778 ');

    const entry = await uc.execute('p1', { notes: 'Control' }, 'u-con');

    expect(entry.warnings).toEqual([]);
    expect(entry.authorProfessionalLicense).toBe('RP-778');
    expect(repo.rows[0].authorProfessionalLicense).toBe('RP-778');
  });

  it('aviso desactivado (lo de fábrica): nunca avisa, pero el registro se congela igual', async () => {
    const { repo, uc } = setup();
    repo.licenses.set('u-con', 'RP-1');

    const sin = await uc.execute('p1', { notes: 'A' }, 'u-sin');
    const con = await uc.execute('p1', { notes: 'B' }, 'u-con');

    expect(sin.warnings).toEqual([]);
    expect(con.warnings).toEqual([]);
    expect(con.authorProfessionalLicense).toBe('RP-1');
  });

  it('cambiar el registro después no altera la evolución ya firmada', async () => {
    const { repo, uc } = setup();
    repo.licenses.set('u-con', 'RP-OLD');
    await uc.execute('p1', { notes: 'Primera' }, 'u-con');

    repo.licenses.set('u-con', 'RP-NEW');
    await uc.execute('p1', { notes: 'Segunda' }, 'u-con');

    expect(repo.rows.map((r) => r.authorProfessionalLicense)).toEqual([
      'RP-OLD',
      'RP-NEW',
    ]);
  });

  it('un error de validación no guarda ni avisa', async () => {
    const { repo, settings, uc } = setup();
    settings.value = { warnMissingProfessionalLicense: true };

    await expect(uc.execute('p1', { notes: '  ' }, 'u-sin')).rejects.toThrow(
      BadRequestException,
    );
    expect(repo.rows).toHaveLength(0);
  });
});

describe('GetClinicalEntrySigningUseCase (DX-540)', () => {
  it('antes de firmar: el registro del usuario, el ajuste y el aviso que saldría', async () => {
    const repo = new InMemoryClinicalEntryRepository();
    const settings = new InMemoryClinicalEntrySettingsRepository();
    settings.value = { warnMissingProfessionalLicense: true };
    const uc = new GetClinicalEntrySigningUseCase(repo, settings);

    await expect(uc.execute('u-sin')).resolves.toEqual({
      professionalLicense: null,
      warnMissingProfessionalLicense: true,
      warnings: [MISSING],
    });

    repo.licenses.set('u-con', 'RP-9');
    await expect(uc.execute('u-con')).resolves.toEqual({
      professionalLicense: 'RP-9',
      warnMissingProfessionalLicense: true,
      warnings: [],
    });
  });

  it('con el aviso desactivado no anuncia nada', async () => {
    const uc = new GetClinicalEntrySigningUseCase(
      new InMemoryClinicalEntryRepository(),
      new InMemoryClinicalEntrySettingsRepository(),
    );
    await expect(uc.execute('u-sin')).resolves.toEqual({
      professionalLicense: null,
      warnMissingProfessionalLicense: false,
      warnings: [],
    });
  });
});

describe('Ajustes de las evoluciones (DX-540)', () => {
  const audit = { record: jest.fn() };
  const ctx: AuditRequestContext = {
    tenantId: 't-1',
    locationId: 'l-1',
    actor: { userId: 'u-admin', role: 'ADMIN' },
    requestId: 'req-1',
    ip: null,
    userAgent: null,
  };

  beforeEach(() => audit.record.mockReset());

  it('lee el ajuste de la clínica (desactivado de fábrica)', async () => {
    const settings = new InMemoryClinicalEntrySettingsRepository();
    await expect(
      new GetClinicalEntrySettingsUseCase(settings).execute(),
    ).resolves.toEqual({ warnMissingProfessionalLicense: false });
  });

  it('activarlo lo guarda y lo audita como CLINIC_SETTINGS con OFF → ON', async () => {
    const settings = new InMemoryClinicalEntrySettingsRepository();
    const uc = new UpdateClinicalEntrySettingsUseCase(
      settings,
      audit as unknown as RecordAuditEventUseCase,
    );

    await expect(
      uc.execute({ warnMissingProfessionalLicense: true }, ctx),
    ).resolves.toEqual({ warnMissingProfessionalLicense: true });

    expect(settings.value).toEqual({ warnMissingProfessionalLicense: true });
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
        reason: 'CLINICAL_ENTRY_LICENSE_WARNING',
        statusChange: { from: 'OFF', to: 'ON' },
      },
    });
  });

  it('sin cambio: responde igual y no audita', async () => {
    const settings = new InMemoryClinicalEntrySettingsRepository();
    const uc = new UpdateClinicalEntrySettingsUseCase(
      settings,
      audit as unknown as RecordAuditEventUseCase,
    );
    await uc.execute({ warnMissingProfessionalLicense: false }, ctx);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rechaza un valor que no es booleano', async () => {
    const uc = new UpdateClinicalEntrySettingsUseCase(
      new InMemoryClinicalEntrySettingsRepository(),
      audit as unknown as RecordAuditEventUseCase,
    );
    await expect(
      uc.execute(
        { warnMissingProfessionalLicense: 'sí' as unknown as boolean },
        ctx,
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
