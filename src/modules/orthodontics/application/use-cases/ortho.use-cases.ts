import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { OrthoCaseStatus, OrthoTechnique } from '@prisma/client';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { CreateClinicalEntryUseCase } from '../../../clinical-entries/application/use-cases/create-clinical-entry.use-case';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { assertPatientInClinic } from '../../../patients/application/assert-patient-in-clinic';
import { ATTENDING_ROLES } from '../../../staff/domain/attending';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  OrthoCaseRecord,
  OrthoCaseView,
  OrthoFollowUpFilter,
  OrthoFollowUpPage,
  OrthoSettings,
  OrthoVisitView,
} from '../../domain/entities';
import {
  ORTHO_CLOCK,
  ORTHO_REPOSITORY,
  type OrthoClock,
  type OrthoRepository,
} from '../../domain/ports/ortho-repository.port';
import {
  ORTHO_MESSAGES,
  acceptsVisits,
  composeVisitNote,
  isClosedStatus,
  validateCasePlan,
  validateNextVisit,
  validateStatusChange,
  validateVisit,
  validateWireGauges,
  type OrthoCasePlan,
  type OrthoVisitInput,
} from '../../domain/ortho-rules';

export const ORTHO_DEFAULT_PAGE_SIZE = 50;
export const ORTHO_MAX_PAGE_SIZE = 100;
/** Motivo de la evolución que documenta un control. */
export const ORTHO_VISIT_ENTRY_REASON = 'Control de ortodoncia';

function conflict(message: string): ConflictException {
  return new ConflictException(message);
}

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

@Injectable()
export class OrthoSettingsUseCases {
  constructor(
    @Inject(ORTHO_REPOSITORY) private readonly repo: OrthoRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  get(): Promise<OrthoSettings> {
    return this.repo.getSettings();
  }

  /**
   * Solo ADMIN (lo exige la ruta). Se audita como CLINIC_SETTINGS con los
   * nombres de lo que cambió; sin cambio, no hay evento.
   */
  async update(
    input: { enabled?: unknown; wireGauges?: unknown },
    ctx: AuditRequestContext,
  ): Promise<OrthoSettings> {
    const current = await this.repo.getSettings();
    let enabled = current.enabled;
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') {
        throw new BadRequestException(ORTHO_MESSAGES.settingsEnabled);
      }
      enabled = input.enabled;
    }
    let wireGauges = current.wireGauges;
    if (input.wireGauges !== undefined) {
      const parsed = validateWireGauges(input.wireGauges);
      if (!parsed.ok) throw new BadRequestException(parsed.message);
      wireGauges = parsed.value;
    }
    const { before, after } = await this.repo.setSettings({
      enabled,
      wireGauges,
    });
    const changedFields = [
      ...(before.enabled !== after.enabled ? ['enabled'] : []),
      ...(before.wireGauges.join('\n') !== after.wireGauges.join('\n')
        ? ['wireGauges']
        : []),
    ];
    if (changedFields.length > 0) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: null,
        patient: null,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: {
          reason: 'ORTHODONTICS_SETTINGS',
          changedFields,
          ...(before.enabled !== after.enabled
            ? {
                statusChange: {
                  from: before.enabled ? 'ON' : 'OFF',
                  to: after.enabled ? 'ON' : 'OFF',
                },
              }
            : {}),
        },
      });
    }
    return after;
  }
}

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------

export interface CreateOrthoCaseInput {
  technique?: OrthoTechnique;
  startDate?: string;
  estimatedMonths?: number;
  plannedVisits?: number;
  visitIntervalDays?: number;
  bondedOn?: string | null;
  debondedOn?: string | null;
  providerId?: string;
  locationId?: string;
  treatmentPlanId?: string | null;
}

export type UpdateOrthoCaseInput = Omit<CreateOrthoCaseInput, 'locationId'>;

@Injectable()
export class OrthoCaseUseCases {
  constructor(
    @Inject(ORTHO_REPOSITORY) private readonly repo: OrthoRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
    @Inject(ORTHO_CLOCK) private readonly now: OrthoClock,
    private readonly tenantContext: TenantContextService,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  async list(patientId: string): Promise<OrthoCaseView[]> {
    await assertPatientInClinic(this.patients, patientId);
    return this.repo.listCases(patientId, this.now());
  }

  async get(patientId: string, caseId: string): Promise<OrthoCaseView> {
    const cases = await this.list(patientId);
    const found = cases.find((c) => c.id === caseId);
    if (!found) throw new NotFoundException(ORTHO_MESSAGES.caseNotFound);
    return found;
  }

  async create(
    patientId: string,
    input: CreateOrthoCaseInput,
    actorId: string,
  ): Promise<OrthoCaseView> {
    await assertPatientInClinic(this.patients, patientId);
    await this.assertModuleEnabled();
    const locationId = input.locationId ?? (await this.repo.writeLocationId());
    // DX-089: un miembro acotado no abre un caso en otra sede.
    this.tenantContext.assertLocationAllowed(locationId);
    if (input.locationId && !(await this.repo.locationExists(locationId))) {
      throw new NotFoundException(ORTHO_MESSAGES.locationNotFound);
    }
    const today = await this.repo.today(this.now(), locationId);
    const plan = validateCasePlan(input, today);
    if (!plan.ok) throw new BadRequestException(plan.message);
    const providerId = input.providerId ?? actorId;
    await this.assertProvider(providerId);
    const treatmentPlanId = input.treatmentPlanId ?? null;
    if (treatmentPlanId) await this.assertPlan(patientId, treatmentPlanId);
    const created = await this.repo.createCase({
      ...plan.value,
      patientId,
      locationId,
      providerId,
      treatmentPlanId,
      createdById: actorId,
    });
    if (!created) throw conflict(ORTHO_MESSAGES.activeExists);
    return this.get(patientId, created.id);
  }

  async update(
    patientId: string,
    caseId: string,
    input: UpdateOrthoCaseInput,
  ): Promise<OrthoCaseView> {
    const current = await this.openCase(patientId, caseId);
    const today = await this.repo.today(this.now(), current.locationId);
    const plan = validateCasePlan(input, today, planOf(current));
    if (!plan.ok) throw new BadRequestException(plan.message);
    const providerId = input.providerId ?? current.providerId;
    if (providerId !== current.providerId)
      await this.assertProvider(providerId);
    const treatmentPlanId =
      input.treatmentPlanId === undefined
        ? current.treatmentPlanId
        : input.treatmentPlanId;
    if (treatmentPlanId && treatmentPlanId !== current.treatmentPlanId) {
      await this.assertPlan(patientId, treatmentPlanId);
    }
    await this.repo.updateCase(caseId, {
      plan: plan.value,
      providerId,
      treatmentPlanId,
    });
    return this.get(patientId, caseId);
  }

  /**
   * Retención, fin o abandono (con motivo). Auditado con el estado antes y
   * después (UPDATE ORTHO_CASE, ORTHO_CASE_STATUS); nunca el motivo escrito.
   */
  async changeStatus(
    patientId: string,
    caseId: string,
    input: { status: OrthoCaseStatus; reason?: string | null },
    ctx: AuditRequestContext,
  ): Promise<OrthoCaseView> {
    const current = await this.openCase(patientId, caseId);
    const checked = validateStatusChange(
      current.status,
      input.status,
      input.reason,
    );
    if (!checked.ok) throw new BadRequestException(checked.message);
    const changed = await this.repo.changeStatus(caseId, {
      from: current.status,
      to: input.status,
      reason: checked.value.reason,
      actorId: ctx.actor.userId,
    });
    if (!changed) {
      throw conflict(
        'El caso cambió mientras lo editabas. Recarga la ficha y vuelve a intentarlo.',
      );
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
        reason: 'ORTHO_CASE_STATUS',
        statusChange: { from: current.status, to: input.status },
        params: { caseId },
      },
    });
    return this.get(patientId, caseId);
  }

  /** El caso, abierto (ni finalizado ni abandonado) y de una sede permitida. */
  private async openCase(
    patientId: string,
    caseId: string,
  ): Promise<OrthoCaseRecord> {
    await assertPatientInClinic(this.patients, patientId);
    const current = await this.repo.findCase(patientId, caseId);
    if (!current) throw new NotFoundException(ORTHO_MESSAGES.caseNotFound);
    // SEC-014: una fila sellada con su sede no se escribe desde fuera.
    this.tenantContext.assertRecordLocationAllowed(current.locationId);
    if (isClosedStatus(current.status)) {
      throw conflict(ORTHO_MESSAGES.caseClosed);
    }
    return current;
  }

  private async assertModuleEnabled(): Promise<void> {
    const settings = await this.repo.getSettings();
    if (!settings.enabled) throw conflict(ORTHO_MESSAGES.moduleDisabled);
  }

  private async assertProvider(userId: string): Promise<void> {
    const role = await this.repo.memberRole(userId);
    if (!role) throw new NotFoundException(ORTHO_MESSAGES.providerNotFound);
    if (!(ATTENDING_ROLES as readonly string[]).includes(role)) {
      throw new BadRequestException(
        'El responsable del caso tiene que ser un miembro del equipo que atiende pacientes.',
      );
    }
  }

  private async assertPlan(patientId: string, planId: string): Promise<void> {
    if (!(await this.repo.planOfPatient(patientId, planId))) {
      throw new BadRequestException(ORTHO_MESSAGES.planNotFound);
    }
  }
}

function planOf(c: OrthoCaseRecord): OrthoCasePlan {
  return {
    technique: c.technique,
    startDate: c.startDate,
    estimatedMonths: c.estimatedMonths,
    plannedVisits: c.plannedVisits,
    visitIntervalDays: c.visitIntervalDays,
    bondedOn: c.bondedOn,
    debondedOn: c.debondedOn,
  };
}

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------

export interface RegisterOrthoVisitInput extends OrthoVisitInput {
  /** Día de la atención `YYYY-MM-DD` (sin cita: hoy por defecto). */
  entryDate?: string;
  /** La cita en la que se hizo el control (de este paciente). */
  appointmentId?: string;
}

@Injectable()
export class OrthoVisitUseCases {
  constructor(
    @Inject(ORTHO_REPOSITORY) private readonly repo: OrthoRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
    private readonly tenantContext: TenantContextService,
    private readonly createEntry: CreateClinicalEntryUseCase,
  ) {}

  async list(patientId: string, caseId: string): Promise<OrthoVisitView[]> {
    await assertPatientInClinic(this.patients, patientId);
    if (!(await this.repo.findCase(patientId, caseId))) {
      throw new NotFoundException(ORTHO_MESSAGES.caseNotFound);
    }
    return this.repo.listVisits(patientId, caseId);
  }

  /**
   * Registra el control: una evolución (inalterable, con las reglas de
   * siempre: cita del paciente, atendida y no futura; fecha no futura; registro
   * profesional del autor) y, en su MISMA transacción, el control
   * estructurado. Se corrige con una adenda de esa evolución.
   */
  async register(
    patientId: string,
    caseId: string,
    input: RegisterOrthoVisitInput,
    actorId: string,
    audit?: AuditRequestContext,
  ): Promise<OrthoVisitView> {
    await assertPatientInClinic(this.patients, patientId);
    const settings = await this.repo.getSettings();
    if (!settings.enabled) throw conflict(ORTHO_MESSAGES.moduleDisabled);
    const current = await this.repo.findCase(patientId, caseId);
    if (!current) throw new NotFoundException(ORTHO_MESSAGES.caseNotFound);
    this.tenantContext.assertRecordLocationAllowed(current.locationId);
    if (!acceptsVisits(current.status)) {
      throw conflict(ORTHO_MESSAGES.caseNotOpenForVisits);
    }
    const checked = validateVisit(input, settings.wireGauges);
    if (!checked.ok) throw new BadRequestException(checked.message);
    const data = checked.value;

    let visitId: string | null = null;
    await this.createEntry.execute(
      patientId,
      {
        entryDate: input.entryDate
          ? new Date(`${input.entryDate}T00:00:00.000Z`)
          : undefined,
        appointmentId: input.appointmentId,
        reason: ORTHO_VISIT_ENTRY_REASON,
        notes: composeVisitNote(data),
      },
      actorId,
      audit,
      async (tx, entry) => {
        if (entry.entryDay < current.startDate) {
          throw new BadRequestException(
            'El control no puede ser anterior al inicio del caso.',
          );
        }
        const nextError = validateNextVisit(
          data.nextVisitProposedOn,
          entry.entryDay,
        );
        if (nextError) throw new BadRequestException(nextError);
        const inserted = await this.repo.insertVisit(tx, {
          ...data,
          patientId,
          caseId,
          clinicalEntryId: entry.id,
          visitDate: entry.entryDay,
          authorId: actorId,
        });
        if (!inserted) throw conflict(ORTHO_MESSAGES.caseNotOpenForVisits);
        visitId = inserted.id;
      },
    );
    const visit = visitId
      ? await this.repo.findVisit(patientId, visitId)
      : null;
    if (!visit) throw new Error('El control recién guardado no se encuentra');
    return visit;
  }
}

// ---------------------------------------------------------------------------
// Lista de la clínica
// ---------------------------------------------------------------------------

function wholeOrDefault(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

@Injectable()
export class OrthoFollowUpUseCase {
  constructor(
    @Inject(ORTHO_REPOSITORY) private readonly repo: OrthoRepository,
    @Inject(ORTHO_CLOCK) private readonly now: OrthoClock,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Casos ACTIVOS con «Atrasado» (último control, o el inicio, hace más de
   * intervalo + 15 días en el día civil de su sede), «Sin próxima cita» y los
   * no-show desde el inicio. Una consulta, sin N+1. Respeta las sedes del
   * miembro (DX-089).
   */
  async execute(input: {
    filter?: OrthoFollowUpFilter;
    locationId?: string;
    providerId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<OrthoFollowUpPage> {
    if (input.locationId) {
      this.tenantContext.assertLocationAllowed(input.locationId);
    }
    const page = wholeOrDefault(input.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = wholeOrDefault(
      input.pageSize,
      ORTHO_DEFAULT_PAGE_SIZE,
      1,
      ORTHO_MAX_PAGE_SIZE,
    );
    const { rows, total } = await this.repo.followUp({
      filter: input.filter ?? 'ALL',
      locationId: input.locationId,
      providerId: input.providerId,
      page,
      pageSize,
      now: this.now(),
    });
    return { items: rows, total, page, pageSize };
  }
}
