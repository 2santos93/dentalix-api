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
import { ORTHO_BILLING_MESSAGES } from '../../domain/ortho-billing';
import {
  OrthoCaseUseCases,
  OrthoSettingsUseCases,
  OrthoVisitUseCases,
} from './ortho.use-cases';
import {
  OrthoAlignerUseCases,
  OrthoBillingUseCases,
} from './ortho-billing.use-cases';

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

const FEE = {
  total: 3_000_000,
  initial: 600_000,
  perVisit: 90_000,
  visitCount: 24,
  retention: 240_000,
};

async function setup() {
  const repo = new InMemoryOrthoRepository();
  const audit = { record: jest.fn() };
  const tenantContext = new TenantContextService();
  const patients = patientsInClinic('p1', 'p2');
  const asAudit = audit as unknown as RecordAuditEventUseCase;
  const cases = new OrthoCaseUseCases(
    repo,
    patients,
    () => NOW,
    tenantContext,
    asAudit,
  );
  const visits = new OrthoVisitUseCases(
    repo,
    patients,
    tenantContext,
    new CreateClinicalEntryUseCase(
      new InMemoryClinicalEntryRepository(),
      patients,
      new InMemoryClinicalNoteTemplateRepository(),
      tenantContext,
      new InMemoryClinicalEntrySettingsRepository(),
    ),
  );
  const billing = new OrthoBillingUseCases(
    repo,
    patients,
    () => NOW,
    tenantContext,
    asAudit,
  );
  const aligners = new OrthoAlignerUseCases(
    repo,
    patients,
    () => NOW,
    tenantContext,
  );
  const settings = new OrthoSettingsUseCases(repo, asAudit);
  const created = await cases.create(
    'p1',
    {
      technique: 'METAL_BRACKETS',
      startDate: '2026-08-10',
      estimatedMonths: 24,
      plannedVisits: 24,
    },
    'dentist-1',
  );
  return {
    repo,
    audit,
    cases,
    visits,
    billing,
    aligners,
    settings,
    caseId: created.id,
  };
}

describe('DX-285 · honorario del caso', () => {
  it('3.000.000 en la moneda de la sede con inicial, 24 controles y retiro se guarda (sin aceptar)', async () => {
    const { billing, caseId, audit, repo } = await setup();
    repo.feeSource = { planCurrency: null, locationCurrency: 'VES' };
    const account = await billing.setFee('p1', caseId, FEE, ctx);
    expect(account).toMatchObject({
      billing: 'PENDING',
      currency: 'VES',
      fee: { total: 3_000_000, visitCount: 24, acceptedAt: null },
      billed: null,
    });
    const [[event]] = audit.record.mock.calls as [[Record<string, unknown>]];
    expect(event).toMatchObject({
      resourceType: 'ORTHO_CASE',
      metadata: {
        reason: 'ORTHO_FEE_UPDATED',
        changedFields: [
          'currency',
          'total',
          'initial',
          'perVisit',
          'visitCount',
          'retention',
        ],
      },
    });
    // Ningún importe en la auditoría.
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('3000000');
  });

  it('un reparto que no suma el total da 400 en español', async () => {
    const { billing, caseId } = await setup();
    await expect(
      billing.setFee('p1', caseId, { ...FEE, visitCount: 23 }, ctx),
    ).rejects.toThrow(new BadRequestException(ORTHO_BILLING_MESSAGES.feeSplit));
  });

  it('la moneda es la del plan ligado si lo hay; sin moneda de la sede, 409', async () => {
    const { billing, caseId, repo } = await setup();
    repo.feeSource = { planCurrency: 'USD', locationCurrency: 'VES' };
    const a = await billing.setFee(
      'p1',
      caseId,
      {
        total: 2400,
        initial: 480,
        perVisit: 72,
        visitCount: 24,
        retention: 192,
      },
      ctx,
    );
    expect(a.currency).toBe('USD');
    repo.feeSource = { planCurrency: null, locationCurrency: null };
    await expect(billing.setFee('p1', caseId, FEE, ctx)).rejects.toThrow(
      new ConflictException(ORTHO_BILLING_MESSAGES.noCurrency),
    );
  });

  it('aceptado: la inicial queda realizada y el control 3 de 24 realiza 3 controles; el honorario ya no cambia', async () => {
    const { billing, visits, caseId, cases } = await setup();
    await billing.setFee('p1', caseId, FEE, ctx);
    const accepted = await billing.acceptFee('p1', caseId, ctx);
    expect(accepted).toMatchObject({
      billing: 'PLAN_ITEMS',
      billed: 600_000,
      paid: 0,
      balance: 600_000,
      remaining: 2_400_000,
      visitsCharged: 0,
    });
    for (const entryDate of ['2026-09-10', '2026-10-10', '2026-11-10']) {
      await visits.register(
        'p1',
        caseId,
        { entryDate, hygieneIndex: 1 },
        'dentist-1',
      );
    }
    const account = await billing.account('p1', caseId);
    expect(account).toMatchObject({
      billed: 600_000 + 270_000,
      visitsCharged: 3,
      visitsDone: 3,
      balance: 870_000,
      hasOverdue: false,
    });
    await expect(billing.setFee('p1', caseId, FEE, ctx)).rejects.toThrow(
      new ConflictException(ORTHO_BILLING_MESSAGES.feeAccepted),
    );
    await expect(billing.acceptFee('p1', caseId, ctx)).rejects.toThrow(
      new ConflictException(ORTHO_BILLING_MESSAGES.feeAccepted),
    );
    // El plan ligado ya no cambia.
    await expect(
      cases.update('p1', caseId, { treatmentPlanId: null }),
    ).rejects.toThrow(
      new ConflictException(ORTHO_BILLING_MESSAGES.feeLockedPlan),
    );
  });

  it('aceptar sin honorario, 409; los motivos del plan ligado salen en español', async () => {
    const { billing, caseId, repo } = await setup();
    await expect(billing.acceptFee('p1', caseId, ctx)).rejects.toThrow(
      new ConflictException(ORTHO_BILLING_MESSAGES.feeMissing),
    );
    await billing.setFee('p1', caseId, FEE, ctx);
    for (const [outcome, message] of [
      ['PLAN_SIGNED', ORTHO_BILLING_MESSAGES.planSigned],
      ['PLAN_NOT_ACCEPTED', ORTHO_BILLING_MESSAGES.planNotAccepted],
      ['PLAN_CLOSED', ORTHO_BILLING_MESSAGES.planClosed],
      ['PLAN_CURRENCY', ORTHO_BILLING_MESSAGES.planCurrency],
    ] as const) {
      repo.acceptOutcome = outcome;
      await expect(billing.acceptFee('p1', caseId, ctx)).rejects.toThrow(
        new ConflictException(message),
      );
    }
  });

  it('un caso de otro paciente o de otra clínica da 404', async () => {
    const { billing, caseId } = await setup();
    await expect(billing.account('p2', caseId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(billing.account('p1', 'case-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('el umbral del saldo vencido se cambia en los ajustes y se audita por nombre', async () => {
    const { settings, audit } = await setup();
    const after = await settings.update(
      { overdueDays: 45 },
      { ...ctx, actor: { userId: 'admin-1', role: 'ADMIN' } },
    );
    expect(after.overdueDays).toBe(45);
    const [[event]] = audit.record.mock.calls as [[Record<string, unknown>]];
    expect(event).toMatchObject({
      metadata: { changedFields: ['overdueDays'] },
    });
    await expect(settings.update({ overdueDays: 0 }, ctx)).rejects.toThrow(
      new BadRequestException(ORTHO_BILLING_MESSAGES.overdueDays),
    );
  });
});

describe('DX-285 · alineadores', () => {
  it('20 bandejas a 14 días: entregas 1–4 y 5–8 desde el control; la bandeja sale por fecha', async () => {
    const { aligners, visits, caseId } = await setup();
    const opened = await aligners.createSeries(
      'p1',
      caseId,
      { arch: 'BOTH', brand: 'Marca X', totalTrays: 20, daysPerTray: 14 },
      'dentist-1',
    );
    const seriesId = opened.series[0].id;
    expect(opened).toMatchObject({
      upperSeriesId: seriesId,
      lowerSeriesId: seriesId,
    });
    const visit = await visits.register(
      'p1',
      caseId,
      { entryDate: '2026-10-20', hygieneIndex: 1 },
      'dentist-1',
    );
    await aligners.addDelivery(
      'p1',
      caseId,
      seriesId,
      { fromTray: 1, toTray: 4, deliveredOn: '2026-09-01' },
      'dentist-1',
    );
    const view = await aligners.addDelivery(
      'p1',
      caseId,
      seriesId,
      { fromTray: 5, toTray: 8, visitId: visit.id },
      'dentist-1',
    );
    // Del control: su día (20-10). La 5 empieza al terminar la 4 (27-10).
    expect(view.series[0].deliveries[1]).toMatchObject({
      deliveredOn: '2026-10-20',
      visitId: visit.id,
    });
    // Hoy 16-11: 76 días desde el 01-09 → bandeja 6 (empezó el 10-11).
    expect(view.series[0]).toMatchObject({
      state: 'IN_PROGRESS',
      currentTray: 6,
      lastDeliveredTray: 8,
    });
    await expect(
      aligners.addDelivery(
        'p1',
        caseId,
        seriesId,
        { fromTray: 10, toTray: 12 },
        'dentist-1',
      ),
    ).rejects.toThrow(
      new BadRequestException(ORTHO_BILLING_MESSAGES.deliveryOrder(9)),
    );
  });

  it('un refinamiento abre una serie nueva y la anterior se conserva', async () => {
    const { aligners, caseId } = await setup();
    const first = await aligners.createSeries(
      'p1',
      caseId,
      { arch: 'UPPER', brand: 'Marca X', totalTrays: 20, daysPerTray: 14 },
      'dentist-1',
    );
    const refined = await aligners.createSeries(
      'p1',
      caseId,
      {
        arch: 'UPPER',
        brand: 'Marca X',
        totalTrays: 8,
        daysPerTray: 7,
        refinementOfId: first.series[0].id,
      },
      'dentist-1',
    );
    expect(refined.series.map((s) => s.sequence)).toEqual([1, 2]);
    expect(refined.upperSeriesId).toBe(refined.series[1].id);
    expect(refined.lowerSeriesId).toBeNull();
    await expect(
      aligners.createSeries(
        'p1',
        caseId,
        {
          arch: 'UPPER',
          brand: 'Marca X',
          totalTrays: 8,
          daysPerTray: 7,
          refinementOfId: 'series-otra',
        },
        'dentist-1',
      ),
    ).rejects.toThrow(
      new BadRequestException(ORTHO_BILLING_MESSAGES.refinementNotFound),
    );
  });

  it('la entrega de una serie que no es del caso, 404; un control de otro caso, 400', async () => {
    const { aligners, caseId } = await setup();
    await expect(
      aligners.addDelivery(
        'p1',
        caseId,
        'series-x',
        { fromTray: 1, toTray: 4 },
        'dentist-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      aligners.addDelivery(
        'p1',
        caseId,
        'series-x',
        { fromTray: 1, toTray: 4, visitId: 'visit-x' },
        'dentist-1',
      ),
    ).rejects.toThrow(
      new BadRequestException(ORTHO_BILLING_MESSAGES.visitNotFound),
    );
  });
});
