import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { fromCents, toCents } from '../../../../shared/money/money';
import type {
  OrthoAlignersView,
  OrthoBalanceFlag,
  OrthoBilling,
  OrthoCaseAccount,
  OrthoCaseRecord,
} from '../../domain/entities';
import {
  ORTHO_CLOCK,
  ORTHO_REPOSITORY,
  type OrthoClock,
  type OrthoRepository,
} from '../../domain/ports/ortho-repository.port';
import { ORTHO_MESSAGES, isClosedStatus } from '../../domain/ortho-rules';
import {
  ORTHO_BILLING_MESSAGES,
  caseAccount,
  coversArch,
  validateDelivery,
  validateFee,
  validateSeries,
  type AlignerSeriesInput,
  type OrthoFeeInput,
} from '../../domain/ortho-billing';

function conflict(message: string): ConflictException {
  return new ConflictException(message);
}

/** Qué cambió del honorario (nombres, nunca importes) para la auditoría. */
function feeChangedFields(
  before: OrthoCaseRecord['fee'],
  after: OrthoCaseRecord['fee'],
): string[] {
  const keys = [
    'currency',
    'total',
    'initial',
    'perVisit',
    'visitCount',
    'retention',
  ] as const;
  return keys.filter((k) => (before?.[k] ?? null) !== (after?.[k] ?? null));
}

// ---------------------------------------------------------------------------
// Honorario y cuenta
// ---------------------------------------------------------------------------

@Injectable()
export class OrthoBillingUseCases {
  constructor(
    @Inject(ORTHO_REPOSITORY) private readonly repo: OrthoRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
    @Inject(ORTHO_CLOCK) private readonly now: OrthoClock,
    private readonly tenantContext: TenantContextService,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  /**
   * La cuenta del caso: honorario, realizado, pagado (lo imputado a sus
   * cargos, DX-051), saldo y saldo vencido. La leen los cuatro roles (recepción
   * cobra); no trae ningún dato clínico.
   */
  async account(patientId: string, caseId: string): Promise<OrthoCaseAccount> {
    await assertPatientInClinic(this.patients, patientId);
    const record = await this.repo.findCase(patientId, caseId);
    if (!record) throw new NotFoundException(ORTHO_MESSAGES.caseNotFound);
    return this.accountOf(record);
  }

  /** Las cuentas de los casos con honorario del paciente (para recepción). */
  async accounts(patientId: string): Promise<OrthoCaseAccount[]> {
    await assertPatientInClinic(this.patients, patientId);
    const records = await this.repo.casesWithFee(patientId);
    const out: OrthoCaseAccount[] = [];
    for (const r of records) out.push(await this.accountOf(r));
    return out;
  }

  /**
   * Pone, cambia o quita (`null`) el honorario de un caso abierto aún sin
   * aceptar. La moneda es la del plan ligado o, sin plan, la de la sede del
   * caso. El reparto tiene que cuadrar con el total (400 en español).
   */
  async setFee(
    patientId: string,
    caseId: string,
    input: OrthoFeeInput | null,
    ctx: AuditRequestContext,
  ): Promise<OrthoCaseAccount> {
    const current = await this.openCase(patientId, caseId);
    if (current.fee?.acceptedAt) {
      throw conflict(ORTHO_BILLING_MESSAGES.feeAccepted);
    }
    let next: Parameters<OrthoRepository['setFee']>[1] = null;
    if (input) {
      const checked = validateFee(input);
      if (!checked.ok) throw new BadRequestException(checked.message);
      const source = await this.repo.feeCurrencySource(caseId);
      const currency = source.planCurrency ?? source.locationCurrency;
      if (!currency) throw conflict(ORTHO_BILLING_MESSAGES.noCurrency);
      next = { split: checked.value, currency };
    }
    const updated = await this.repo.setFee(caseId, next, ctx.actor.userId);
    if (!updated) throw conflict(ORTHO_BILLING_MESSAGES.feeAccepted);
    const changedFields = feeChangedFields(current.fee, updated.fee);
    if (changedFields.length > 0) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
        action: 'UPDATE',
        resourceType: 'ORTHO_CASE',
        resourceId: caseId,
        patient: { kind: 'patient', id: patientId },
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: {
          reason: 'ORTHO_FEE_UPDATED',
          changedFields,
          params: { caseId },
        },
      });
    }
    return this.accountOf(updated);
  }

  /**
   * «Aceptar el honorario»: crea en el plan ligado (o en uno nuevo
   * «Ortodoncia» si no hay) la inicial (ya realizada), un ítem por control y
   * el retiro, para cobrarlos con los abonos y recibos de siempre. Si el plan
   * ligado ya tiene cuotas activas, no se duplica el cargo: solo se apuntan.
   */
  async acceptFee(
    patientId: string,
    caseId: string,
    ctx: AuditRequestContext,
  ): Promise<OrthoCaseAccount> {
    const current = await this.openCase(patientId, caseId);
    if (!current.fee) throw conflict(ORTHO_BILLING_MESSAGES.feeMissing);
    if (current.fee.acceptedAt) {
      throw conflict(ORTHO_BILLING_MESSAGES.feeAccepted);
    }
    const result = await this.repo.acceptFee({
      patientId,
      caseId,
      actorId: ctx.actor.userId,
      technique: current.technique,
    });
    switch (result.outcome) {
      case 'OK':
        break;
      case 'NOT_FOUND':
        throw new NotFoundException(ORTHO_MESSAGES.caseNotFound);
      case 'CLOSED':
        throw conflict(ORTHO_MESSAGES.caseClosed);
      case 'NO_FEE':
        throw conflict(ORTHO_BILLING_MESSAGES.feeMissing);
      case 'ALREADY_ACCEPTED':
        throw conflict(ORTHO_BILLING_MESSAGES.feeAccepted);
      case 'PLAN_NOT_ACCEPTED':
        throw conflict(ORTHO_BILLING_MESSAGES.planNotAccepted);
      case 'PLAN_SIGNED':
        throw conflict(ORTHO_BILLING_MESSAGES.planSigned);
      case 'PLAN_CLOSED':
        throw conflict(ORTHO_BILLING_MESSAGES.planClosed);
      case 'PLAN_CURRENCY':
        throw conflict(ORTHO_BILLING_MESSAGES.planCurrency);
      case 'NO_CURRENCY':
        throw conflict(ORTHO_BILLING_MESSAGES.noCurrency);
    }
    await this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'UPDATE',
      resourceType: 'ORTHO_CASE',
      resourceId: caseId,
      patient: { kind: 'patient', id: patientId },
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        reason: result.paymentPlanId
          ? 'ORTHO_FEE_ACCEPTED_PAYMENT_PLAN'
          : 'ORTHO_FEE_ACCEPTED',
        params: { caseId, treatmentPlanId: result.planId },
      },
    });
    return this.account(patientId, caseId);
  }

  /** Marca «Ortodoncia: saldo vencido» de un lote (agenda, En clínica). */
  overdueFlags(
    patientIds: readonly string[],
  ): Promise<Map<string, OrthoBalanceFlag>> {
    return this.repo.overdueFlags(patientIds, this.now());
  }

  private async accountOf(record: OrthoCaseRecord): Promise<OrthoCaseAccount> {
    const settings = await this.repo.getSettings();
    const fee = record.fee;
    const billing: OrthoBilling = !fee
      ? 'NONE'
      : !fee.acceptedAt
        ? 'PENDING'
        : fee.paymentPlanId
          ? 'PAYMENT_PLAN'
          : 'PLAN_ITEMS';
    const facts = await this.repo.accountFacts(
      record.patientId,
      record.id,
      this.now(),
    );
    if (!facts) throw new NotFoundException(ORTHO_MESSAGES.caseNotFound);
    const base = {
      caseId: record.id,
      patientId: record.patientId,
      status: record.status,
      startDate: record.startDate,
      plannedVisits: record.plannedVisits,
      visitsDone: facts.visitsDone,
      billing,
      currency: fee?.currency ?? null,
      treatmentPlanId: record.treatmentPlanId,
      fee,
      overdueDays: settings.overdueDays,
      paymentPlan: facts.paymentPlan,
    };
    if (billing !== 'PLAN_ITEMS' || !fee) {
      return {
        ...base,
        billed: null,
        paid: null,
        balance: null,
        remaining: null,
        overdue: null,
        overdueSince: null,
        overdueAgeDays: 0,
        hasOverdue: false,
        visitsCharged: 0,
        removedCharges: 0,
      };
    }
    const figures = caseAccount(
      facts.charges,
      facts.today,
      settings.overdueDays,
    );
    const totalCents = toCents(fee.total);
    return {
      ...base,
      billed: fromCents(figures.billedCents),
      paid: fromCents(figures.paidCents),
      balance: fromCents(figures.balanceCents),
      remaining: fromCents(Math.max(0, totalCents - figures.billedCents)),
      overdue: fromCents(figures.overdueCents),
      overdueSince: figures.overdueSince,
      overdueAgeDays: figures.overdueAgeDays,
      hasOverdue: figures.overdueCents > 0,
      visitsCharged: figures.visitsCharged,
      removedCharges: figures.removedCharges,
    };
  }

  /** El caso, abierto y de una sede permitida (como las escrituras de DX-190). */
  private async openCase(
    patientId: string,
    caseId: string,
  ): Promise<OrthoCaseRecord> {
    await assertPatientInClinic(this.patients, patientId);
    const current = await this.repo.findCase(patientId, caseId);
    if (!current) throw new NotFoundException(ORTHO_MESSAGES.caseNotFound);
    this.tenantContext.assertRecordLocationAllowed(current.locationId);
    if (isClosedStatus(current.status)) {
      throw conflict(ORTHO_MESSAGES.caseClosed);
    }
    return current;
  }
}

// ---------------------------------------------------------------------------
// Alineadores
// ---------------------------------------------------------------------------

@Injectable()
export class OrthoAlignerUseCases {
  constructor(
    @Inject(ORTHO_REPOSITORY) private readonly repo: OrthoRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
    @Inject(ORTHO_CLOCK) private readonly now: OrthoClock,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Las series del caso y la vigente de cada arcada, con la bandeja de hoy. */
  async list(patientId: string, caseId: string): Promise<OrthoAlignersView> {
    await assertPatientInClinic(this.patients, patientId);
    const record = await this.repo.findCase(patientId, caseId);
    if (!record) throw new NotFoundException(ORTHO_MESSAGES.caseNotFound);
    const today = await this.repo.today(this.now(), record.locationId);
    const series = await this.repo.listAlignerSeries(caseId, today);
    const latest = (arch: 'UPPER' | 'LOWER') =>
      [...series].reverse().find((s) => coversArch(s.arch, arch))?.id ?? null;
    return {
      today,
      series,
      upperSeriesId: latest('UPPER'),
      lowerSeriesId: latest('LOWER'),
    };
  }

  /** Abre una serie (o un refinamiento de otra del mismo caso). */
  async createSeries(
    patientId: string,
    caseId: string,
    input: AlignerSeriesInput & { refinementOfId?: string | null },
    actorId: string,
  ): Promise<OrthoAlignersView> {
    await this.openCase(patientId, caseId);
    const checked = validateSeries(input);
    if (!checked.ok) throw new BadRequestException(checked.message);
    const refinementOfId = input.refinementOfId ?? null;
    if (
      refinementOfId &&
      !(await this.repo.seriesOfCase(caseId, refinementOfId))
    ) {
      throw new BadRequestException(ORTHO_BILLING_MESSAGES.refinementNotFound);
    }
    await this.repo.createAlignerSeries({
      caseId,
      ...checked.value,
      refinementOfId,
      createdById: actorId,
    });
    return this.list(patientId, caseId);
  }

  /**
   * Registra una entrega (de la bandeja X a la Y, seguidas). Desde el control:
   * `visitId` (del mismo caso) y, sin fecha, el día de ese control.
   */
  async addDelivery(
    patientId: string,
    caseId: string,
    seriesId: string,
    input: {
      fromTray?: number;
      toTray?: number;
      deliveredOn?: string;
      visitId?: string;
    },
    actorId: string,
  ): Promise<OrthoAlignersView> {
    const record = await this.openCase(patientId, caseId);
    let deliveredOn = input.deliveredOn;
    const visitId = input.visitId ?? null;
    if (visitId) {
      const visit = await this.repo.visitOfCase(caseId, visitId);
      if (!visit) {
        throw new BadRequestException(ORTHO_BILLING_MESSAGES.visitNotFound);
      }
      deliveredOn ??= visit.visitDate;
    }
    const today = await this.repo.today(this.now(), record.locationId);
    deliveredOn ??= today;
    const result = await this.repo.addAlignerDelivery({
      caseId,
      seriesId,
      visitId,
      createdById: actorId,
      validate: (series, previous) =>
        validateDelivery(
          {
            fromTray: input.fromTray,
            toTray: input.toTray,
            deliveredOn,
          },
          series,
          previous,
          { caseStart: record.startDate, today },
        ),
    });
    if (result.outcome === 'SERIES_NOT_FOUND') {
      throw new NotFoundException(ORTHO_BILLING_MESSAGES.seriesNotFound);
    }
    if (result.outcome === 'CASE_CLOSED') {
      throw conflict(ORTHO_MESSAGES.caseClosed);
    }
    if (result.outcome === 'INVALID') {
      throw new BadRequestException(result.message);
    }
    return this.list(patientId, caseId);
  }

  private async openCase(
    patientId: string,
    caseId: string,
  ): Promise<OrthoCaseRecord> {
    await assertPatientInClinic(this.patients, patientId);
    const settings = await this.repo.getSettings();
    if (!settings.enabled) throw conflict(ORTHO_MESSAGES.moduleDisabled);
    const current = await this.repo.findCase(patientId, caseId);
    if (!current) throw new NotFoundException(ORTHO_MESSAGES.caseNotFound);
    this.tenantContext.assertRecordLocationAllowed(current.locationId);
    if (isClosedStatus(current.status)) {
      throw conflict(ORTHO_MESSAGES.caseClosed);
    }
    return current;
  }
}
