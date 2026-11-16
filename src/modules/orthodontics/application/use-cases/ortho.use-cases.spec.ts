import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { CreateClinicalEntryUseCase } from '../../../clinical-entries/application/use-cases/create-clinical-entry.use-case';
import {
  InMemoryClinicalEntryRepository,
  InMemoryClinicalEntrySettingsRepository,
} from '../../../clinical-entries/application/__fixtures__/in-memory-clinical-entries';
import { InMemoryClinicalNoteTemplateRepository } from '../../../clinical-note-templates/application/__fixtures__/in-memory-clinical-note-templates';
import { patientsInClinic } from '../../../patients/application/__fixtures__/patients-in-clinic.fake';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { InMemoryOrthoRepository } from '../__fixtures__/in-memory-ortho';
import { ORTHO_MESSAGES } from '../../domain/ortho-rules';
import {
  ORTHO_MAX_PAGE_SIZE,
  OrthoCaseUseCases,
  OrthoFollowUpUseCase,
  OrthoSettingsUseCases,
  OrthoVisitUseCases,
} from './ortho.use-cases';

// Reloj fijo: 16-11-2026 11:00 en Caracas (UTC−4).
const NOW = new Date('2026-11-16T15:00:00.000Z');

const ctx: AuditRequestContext = {
  tenantId: 't1',
  locationId: null,
  actor: { userId: 'dentist-1', role: 'DENTIST' },
  requestId: 'req-1',
  ip: '203.0.113.9',
  userAgent: 'jest',
};

function setup() {
  const repo = new InMemoryOrthoRepository();
  const entries = new InMemoryClinicalEntryRepository();
  const audit = { record: jest.fn() };
  const tenantContext = new TenantContextService();
  const patients = patientsInClinic('p1', 'p2');
  const cases = new OrthoCaseUseCases(
    repo,
    patients,
    () => NOW,
    tenantContext,
    audit as unknown as RecordAuditEventUseCase,
  );
  const createEntry = new CreateClinicalEntryUseCase(
    entries,
    patients,
    new InMemoryClinicalNoteTemplateRepository(),
    tenantContext,
    new InMemoryClinicalEntrySettingsRepository(),
  );
  const visits = new OrthoVisitUseCases(
    repo,
    patients,
    tenantContext,
    createEntry,
  );
  const settings = new OrthoSettingsUseCases(
    repo,
    audit as unknown as RecordAuditEventUseCase,
  );
  const followUp = new OrthoFollowUpUseCase(repo, () => NOW, tenantContext);
  return { repo, entries, audit, cases, visits, settings, followUp };
}

const CASE_24 = {
  technique: 'METAL_BRACKETS' as const,
  startDate: '2026-08-10',
  estimatedMonths: 24,
  plannedVisits: 24,
};

describe('DX-190 · casos de ortodoncia', () => {
  it('DENTIST crea un caso de 24 meses y 24 controles; con 3 controles la barra marca 3/24 y el arco actual es el del último', async () => {
    const { cases, visits, entries } = setup();
    const created = await cases.create('p1', CASE_24, 'dentist-1');
    expect(created).toMatchObject({
      status: 'ACTIVE',
      providerId: 'dentist-1',
      locationId: 'loc-1',
      visitIntervalDays: 30,
      progress: { visitsDone: 0, plannedVisits: 24 },
    });

    const wires = [
      ['2026-09-10', '0.014', '0.014'],
      ['2026-10-10', '0.016', '0.016'],
      ['2026-11-10', '0.016x0.022', '0.018'],
    ] as const;
    for (const [entryDate, upper, lower] of wires) {
      await visits.register(
        'p1',
        created.id,
        {
          entryDate,
          upperWire: { material: 'NITI', gauge: upper },
          lowerWire: { material: 'STEEL', gauge: lower },
          hygieneIndex: 1,
        },
        'dentist-1',
      );
    }

    const [view] = await cases.list('p1');
    expect(view.progress).toMatchObject({
      visitsDone: 3,
      plannedVisits: 24,
      monthsElapsed: 3,
      estimatedMonths: 24,
    });
    expect(view.currentUpperWire).toEqual({
      material: 'NITI',
      gauge: '0.016x0.022',
    });
    expect(view.currentLowerWire).toEqual({
      material: 'STEEL',
      gauge: '0.018',
    });
    expect(view.lastVisitDate).toBe('2026-11-10');
    expect(view.overdue).toBe(false);
    // Cada control es una evolución con su texto.
    expect(entries.rows).toHaveLength(3);
    expect(entries.rows[2].reason).toBe('Control de ortodoncia');
    expect(entries.rows[2].notes).toContain('Arco superior: NiTi 0.016x0.022.');
  });

  it('un segundo caso activo para el mismo paciente da 409 en español', async () => {
    const { cases } = setup();
    await cases.create('p1', CASE_24, 'dentist-1');
    await expect(cases.create('p1', CASE_24, 'dentist-1')).rejects.toEqual(
      new ConflictException(ORTHO_MESSAGES.activeExists),
    );
  });

  it('con el caso en retención se puede abrir otro activo', async () => {
    const { cases } = setup();
    const first = await cases.create('p1', CASE_24, 'dentist-1');
    await cases.changeStatus('p1', first.id, { status: 'RETENTION' }, ctx);
    await expect(
      cases.create('p1', CASE_24, 'dentist-1'),
    ).resolves.toMatchObject({ status: 'ACTIVE' });
  });

  it('un caso de otra clínica (o de otro paciente) da 404', async () => {
    const { cases, visits } = setup();
    const created = await cases.create('p1', CASE_24, 'dentist-1');
    await expect(
      cases.update('p2', created.id, { plannedVisits: 20 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(visits.list('p2', created.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      cases.create('p-ajeno', CASE_24, 'dentist-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('con el módulo apagado no se abren casos ni se registran controles (409)', async () => {
    const { cases, visits, repo } = setup();
    const created = await cases.create('p1', CASE_24, 'dentist-1');
    repo.settings.enabled = false;
    await expect(cases.create('p2', CASE_24, 'dentist-1')).rejects.toEqual(
      new ConflictException(ORTHO_MESSAGES.moduleDisabled),
    );
    await expect(
      visits.register('p1', created.id, { hygieneIndex: 2 }, 'dentist-1'),
    ).rejects.toEqual(new ConflictException(ORTHO_MESSAGES.moduleDisabled));
  });

  it('el responsable tiene que atender pacientes y el plan ser del paciente', async () => {
    const { cases } = setup();
    await expect(
      cases.create(
        'p1',
        { ...CASE_24, providerId: 'assistant-1' },
        'dentist-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      cases.create('p1', { ...CASE_24, providerId: 'nadie' }, 'dentist-1'),
    ).rejects.toEqual(new NotFoundException(ORTHO_MESSAGES.providerNotFound));
    await expect(
      cases.create(
        'p2',
        { ...CASE_24, treatmentPlanId: 'plan-1' },
        'dentist-1',
      ),
    ).rejects.toEqual(new BadRequestException(ORTHO_MESSAGES.planNotFound));
    await expect(
      cases.create(
        'p1',
        { ...CASE_24, treatmentPlanId: 'plan-1' },
        'dentist-1',
      ),
    ).resolves.toMatchObject({ treatmentPlanId: 'plan-1' });
  });

  it('el inicio no puede ser futuro en el día civil de la sede', async () => {
    const { cases } = setup();
    await expect(
      cases.create('p1', { ...CASE_24, startDate: '2026-11-17' }, 'dentist-1'),
    ).rejects.toEqual(
      new BadRequestException('La fecha de inicio no puede ser futura.'),
    );
  });

  it('cerrar el caso: queda auditado con el estado antes y después, sin el motivo; uno cerrado ya no cambia', async () => {
    const { cases, audit } = setup();
    const created = await cases.create('p1', CASE_24, 'dentist-1');
    const closed = await cases.changeStatus(
      'p1',
      created.id,
      { status: 'ABANDONED', reason: 'Se mudó a otra ciudad' },
      ctx,
    );
    expect(closed).toMatchObject({
      status: 'ABANDONED',
      statusReason: 'Se mudó a otra ciudad',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        resourceType: 'ORTHO_CASE',
        resourceId: created.id,
        patient: { kind: 'patient', id: 'p1' },
        metadata: {
          reason: 'ORTHO_CASE_STATUS',
          statusChange: { from: 'ACTIVE', to: 'ABANDONED' },
          params: { caseId: created.id },
        },
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('mudó');
    await expect(
      cases.update('p1', created.id, { plannedVisits: 10 }),
    ).rejects.toEqual(new ConflictException(ORTHO_MESSAGES.caseClosed));
    await expect(
      cases.changeStatus('p1', created.id, { status: 'FINISHED' }, ctx),
    ).rejects.toEqual(new ConflictException(ORTHO_MESSAGES.caseClosed));
  });

  it('abandonar sin motivo da 400', async () => {
    const { cases } = setup();
    const created = await cases.create('p1', CASE_24, 'dentist-1');
    await expect(
      cases.changeStatus('p1', created.id, { status: 'ABANDONED' }, ctx),
    ).rejects.toEqual(
      new BadRequestException('Indica el motivo del abandono del caso.'),
    );
  });
});

describe('DX-190 · controles', () => {
  it('no se registra un control en un caso finalizado (409)', async () => {
    const { cases, visits, entries } = setup();
    const created = await cases.create('p1', CASE_24, 'dentist-1');
    await cases.changeStatus('p1', created.id, { status: 'FINISHED' }, ctx);
    await expect(
      visits.register(
        'p1',
        created.id,
        { entryDate: '2026-11-16', hygieneIndex: 1 },
        'dentist-1',
      ),
    ).rejects.toEqual(
      new ConflictException(ORTHO_MESSAGES.caseNotOpenForVisits),
    );
    expect(entries.rows).toHaveLength(0);
  });

  it('en retención sí admite controles', async () => {
    const { cases, visits } = setup();
    const created = await cases.create('p1', CASE_24, 'dentist-1');
    await cases.changeStatus('p1', created.id, { status: 'RETENTION' }, ctx);
    await expect(
      visits.register(
        'p1',
        created.id,
        { entryDate: '2026-11-16', note: 'Retenedor en buen estado' },
        'dentist-1',
      ),
    ).resolves.toMatchObject({ visitNumber: 1, visitDate: '2026-11-16' });
  });

  it('el próximo control no posterior o un control anterior al inicio: 400 y no queda evolución', async () => {
    const { cases, visits, entries } = setup();
    const created = await cases.create('p1', CASE_24, 'dentist-1');
    await expect(
      visits.register(
        'p1',
        created.id,
        {
          entryDate: '2026-11-16',
          hygieneIndex: 1,
          nextVisitProposedOn: '2026-11-16',
        },
        'dentist-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      visits.register(
        'p1',
        created.id,
        { entryDate: '2026-08-01', hygieneIndex: 1 },
        'dentist-1',
      ),
    ).rejects.toEqual(
      new BadRequestException(
        'El control no puede ser anterior al inicio del caso.',
      ),
    );
    expect(entries.rows).toHaveLength(0);
  });

  it('un calibre que no está en la lista de la clínica da 400', async () => {
    const { cases, visits } = setup();
    const created = await cases.create('p1', CASE_24, 'dentist-1');
    await expect(
      visits.register(
        'p1',
        created.id,
        { upperWire: { material: 'NITI', gauge: '0.099' } },
        'dentist-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('el historial va del más reciente al más antiguo con su número', async () => {
    const { cases, visits } = setup();
    const created = await cases.create('p1', CASE_24, 'dentist-1');
    for (const entryDate of ['2026-09-10', '2026-10-10']) {
      await visits.register(
        'p1',
        created.id,
        { entryDate, hygieneIndex: 2 },
        'dentist-1',
      );
    }
    const list = await visits.list('p1', created.id);
    expect(list.map((v) => [v.visitNumber, v.visitDate])).toEqual([
      [2, '2026-10-10'],
      [1, '2026-09-10'],
    ]);
  });
});

describe('DX-190 · ajustes y lista de seguimiento', () => {
  it('cambiar los ajustes audita qué cambió; sin cambio no hay evento', async () => {
    const { settings, audit, repo } = setup();
    repo.settings.enabled = false;
    await settings.update({ enabled: true, wireGauges: ['0.014'] }, ctx);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'CLINIC_SETTINGS',
        metadata: {
          reason: 'ORTHODONTICS_SETTINGS',
          changedFields: ['enabled', 'wireGauges'],
          statusChange: { from: 'OFF', to: 'ON' },
        },
      }),
    );
    audit.record.mockReset();
    await settings.update({ enabled: true }, ctx);
    expect(audit.record).not.toHaveBeenCalled();
    await expect(settings.update({ wireGauges: [] }, ctx)).rejects.toEqual(
      new BadRequestException(ORTHO_MESSAGES.settingsGauges),
    );
  });

  it('la lista pasa el reloj, el filtro y acota la página', async () => {
    const { followUp, repo } = setup();
    await followUp.execute({ filter: 'OVERDUE', pageSize: 1000, page: 0 });
    expect(repo.lastFollowUpQuery).toEqual({
      filter: 'OVERDUE',
      locationId: undefined,
      providerId: undefined,
      page: 1,
      pageSize: ORTHO_MAX_PAGE_SIZE,
      now: NOW,
    });
  });
});
