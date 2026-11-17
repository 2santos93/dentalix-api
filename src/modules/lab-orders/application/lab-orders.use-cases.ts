import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { assertPatientInClinic } from '../../patients/application/assert-patient-in-clinic';
import {
  PATIENT_REPOSITORY,
  type PatientRepository,
} from '../../patients/domain/ports/patient-repository.port';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { civilDateIn } from '../../../shared/time/civil-day';
import type {
  DueDateSuggestion,
  LabOrderPage,
  LabOrderPrintView,
  LabOrderRecord,
  LabOrderView,
} from '../domain/entities';
import {
  LAB_MESSAGES,
  LAB_ORDER_CONTENT_FIELDS,
  LAB_ORDER_DEFAULT_PAGE_SIZE,
  LAB_ORDER_MAX_PAGE_SIZE,
  ORDER_DESCRIPTION_MAX,
  ORDER_INSTRUCTIONS_MAX,
  ORDER_MATERIAL_MAX,
  ORDER_SHADE_MAX,
  checkEdit,
  checkTransition,
  deriveLabOrderStatus,
  effectiveBusinessCalendar,
  isCivilDay,
  normalizeCancelReason,
  normalizeTeeth,
  optionalText,
  suggestDueOn,
  type LabOrderAction,
  type LabOrderEditableField,
  type LabOrderStatus,
  type LabRuleError,
} from '../domain/lab-order-rules';
import {
  LAB_CLOCK,
  LAB_REPOSITORY,
  type LabClock,
  type LabOrderWrite,
  type LabRepository,
} from '../domain/ports/lab-repository.port';

/** Lo que llega del cuerpo de alta/edición (undefined = no viene). */
export interface LabOrderFields {
  labId?: string;
  serviceId?: string | null;
  description?: string;
  toothNumbers?: string[] | null;
  shade?: string | null;
  material?: string | null;
  instructions?: string | null;
  dueOn?: string | null;
  treatmentPlanItemId?: string | null;
  appointmentId?: string | null;
  replacesOrderId?: string | null;
}

export interface CreateLabOrderFields extends LabOrderFields {
  locationId?: string;
}

export interface LabOrderListInput {
  locationId?: string;
  statuses?: LabOrderStatus[];
  labId?: string;
  from?: string;
  to?: string;
  overdue?: boolean;
  page?: number;
  pageSize?: number;
}

const PRESCRIBER_ROLES: readonly string[] = [
  ClinicRole.DENTIST,
  ClinicRole.ADMIN,
];

function ruleError(error: LabRuleError): Error {
  return error.kind === 'CONFLICT'
    ? new ConflictException(error.message)
    : new UnprocessableEntityException(error.message);
}

function wholeOrDefault(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Color, material e instrucciones son datos de salud: recepción no los ve. */
export function redactForRole(
  view: LabOrderView,
  role: ClinicRole | null,
): LabOrderView {
  if (role !== ClinicRole.RECEPTION) return view;
  return {
    ...view,
    shade: null,
    material: null,
    instructions: null,
    clinicalRedacted: true,
  };
}

function limitedText(
  value: string | null | undefined,
  max: number,
  label: string,
): string | null {
  const text = optionalText(value);
  if (text !== null && text.length > max) {
    throw new BadRequestException(`${label} admite hasta ${max} caracteres.`);
  }
  return text;
}

function description(value: string | undefined): string {
  const text = optionalText(value);
  if (text === null || text.length > ORDER_DESCRIPTION_MAX) {
    throw new BadRequestException(LAB_MESSAGES.descriptionRequired);
  }
  return text;
}

function dueOnOf(value: string | null): string | null {
  if (value === null) return null;
  if (!isCivilDay(value))
    throw new BadRequestException(LAB_MESSAGES.dueOnInvalid);
  return value;
}

/**
 * Órdenes de laboratorio (DX-017): alta desde la ficha (o desde un ítem del
 * plan), edición (el contenido solo en borrador), envío, recepción, revisión,
 * anulación con motivo, listas e impresión. Cada cambio deja un evento de
 * auditoría sin texto clínico (nombres de campos, estados y fechas).
 */
@Injectable()
export class LabOrderUseCases {
  constructor(
    @Inject(LAB_REPOSITORY) private readonly repo: LabRepository,
    @Inject(PATIENT_REPOSITORY) private readonly patients: PatientRepository,
    @Inject(LAB_CLOCK) private readonly now: LabClock,
    private readonly tenantContext: TenantContextService,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  // -- Lecturas

  async get(orderId: string, role: ClinicRole | null): Promise<LabOrderView> {
    return redactForRole(await this.readable(orderId), role);
  }

  async listForPatient(
    patientId: string,
    input: { page?: number; pageSize?: number },
    role: ClinicRole | null,
  ): Promise<LabOrderPage> {
    await assertPatientInClinic(this.patients, patientId);
    const page = wholeOrDefault(input.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = wholeOrDefault(
      input.pageSize,
      LAB_ORDER_DEFAULT_PAGE_SIZE,
      1,
      LAB_ORDER_MAX_PAGE_SIZE,
    );
    const { ids, total } = await this.repo.patientOrderIds(
      patientId,
      page,
      pageSize,
      this.allowedLocations(),
    );
    const items = await this.repo.views(ids, this.now());
    return {
      items: items.map((v) => redactForRole(v, role)),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Trabajos de UNA sede (la pedida o la activa), con filtros. Orden:
   * atrasadas primero, luego fecha prometida (sin fecha al final), luego el
   * número más alto.
   */
  async list(
    input: LabOrderListInput,
    role: ClinicRole | null,
  ): Promise<LabOrderPage> {
    const locationId = await this.locationFor(input.locationId);
    if (input.from !== undefined && !isCivilDay(input.from)) {
      throw new BadRequestException(LAB_MESSAGES.fromInvalid);
    }
    if (input.to !== undefined && !isCivilDay(input.to)) {
      throw new BadRequestException(LAB_MESSAGES.dueOnInvalid);
    }
    if (input.from && input.to && input.from > input.to) {
      throw new BadRequestException(LAB_MESSAGES.rangeInvalid);
    }
    const page = wholeOrDefault(input.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = wholeOrDefault(
      input.pageSize,
      LAB_ORDER_DEFAULT_PAGE_SIZE,
      1,
      LAB_ORDER_MAX_PAGE_SIZE,
    );
    const now = this.now();
    const today = await this.repo.today(now, locationId);
    const { ids, total } = await this.repo.listOrderIds({
      locationId,
      statuses: [...new Set(input.statuses ?? [])],
      labId: input.labId,
      from: input.from,
      to: input.to,
      overdue: input.overdue === true,
      today,
      page,
      pageSize,
    });
    const items = await this.repo.views(ids, now);
    return {
      items: items.map((v) => redactForRole(v, role)),
      total,
      page,
      pageSize,
    };
  }

  /** Fecha prometida sugerida: día de inicio + plazo del servicio en días hábiles de la sede. */
  async suggestDueDate(input: {
    locationId?: string;
    serviceId: string;
    from?: string;
  }): Promise<DueDateSuggestion> {
    const locationId = await this.locationFor(input.locationId);
    const service = await this.repo.findService(input.serviceId);
    if (!service) throw new NotFoundException(LAB_MESSAGES.serviceNotFound);
    if (input.from !== undefined && !isCivilDay(input.from)) {
      throw new BadRequestException(LAB_MESSAGES.fromInvalid);
    }
    const from = input.from ?? (await this.repo.today(this.now(), locationId));
    return {
      dueOn: await this.suggestion(
        locationId,
        from,
        service.leadTimeBusinessDays,
      ),
      from,
      leadTimeBusinessDays: service.leadTimeBusinessDays,
    };
  }

  /** La prescripción imprimible, completa (la ruta es solo de roles clínicos). */
  async print(
    orderId: string,
    ctx: AuditRequestContext,
  ): Promise<LabOrderPrintView> {
    const order = await this.readable(orderId);
    const now = this.now();
    const headers = await this.repo.printHeaders(order, now);
    await this.record(ctx, order.patientId, orderId, 'PRINT', {
      reason: 'DENTAL_LAB_ORDER_PRINTED',
    });
    return { order, ...headers, printedAt: now };
  }

  // -- Escrituras

  async create(
    patientId: string,
    input: CreateLabOrderFields,
    ctx: AuditRequestContext,
  ): Promise<LabOrderView> {
    await assertPatientInClinic(this.patients, patientId);
    const membership = await this.repo.membershipOf(ctx.actor.userId);
    if (!membership || !PRESCRIBER_ROLES.includes(membership.role)) {
      throw new ForbiddenException(LAB_MESSAGES.notPrescriber);
    }
    let locationId: string;
    if (input.locationId) {
      this.tenantContext.assertLocationAllowed(input.locationId);
      if (!(await this.repo.locationExists(input.locationId))) {
        throw new NotFoundException(LAB_MESSAGES.locationNotFound);
      }
      locationId = input.locationId;
    } else {
      locationId = await this.repo.writeLocationId();
      this.tenantContext.assertLocationAllowed(locationId);
    }
    const teeth = normalizeTeeth(input.toothNumbers);
    if (!teeth.ok) throw new BadRequestException(teeth.message);
    const content = {
      description: description(input.description),
      shade: limitedText(input.shade, ORDER_SHADE_MAX, 'El color'),
      material: limitedText(input.material, ORDER_MATERIAL_MAX, 'El material'),
      instructions: limitedText(
        input.instructions,
        ORDER_INSTRUCTIONS_MAX,
        'Las instrucciones',
      ),
    };
    if (!input.labId) throw new NotFoundException(LAB_MESSAGES.labNotFound);
    const serviceId = input.serviceId ?? null;
    const lead = await this.assertLabAndService(input.labId, serviceId);
    await this.assertLinks(patientId, {
      treatmentPlanItemId: input.treatmentPlanItemId ?? null,
      appointmentId: input.appointmentId ?? null,
      replacesOrderId: input.replacesOrderId ?? null,
    });
    let dueOn = dueOnOf(input.dueOn ?? null);
    if (dueOn === null && lead !== null) {
      const today = await this.repo.today(this.now(), locationId);
      dueOn = await this.suggestion(locationId, today, lead);
    }
    const id = await this.repo.createOrder({
      patientId,
      locationId,
      professionalMembershipId: membership.id,
      labId: input.labId,
      serviceId,
      treatmentPlanItemId: input.treatmentPlanItemId ?? null,
      appointmentId: input.appointmentId ?? null,
      replacesOrderId: input.replacesOrderId ?? null,
      ...content,
      toothNumbers: teeth.value,
      dueOn,
      createdById: ctx.actor.userId,
    });
    return redactForRole(await this.view(id), ctx.actor.role);
  }

  /**
   * Cambia datos y vínculos. En borrador, todo; tras «Enviada», solo la fecha
   * prometida y la cita de colocación. Recepción solo esas dos (403 si toca el
   * contenido). Auditado con los nombres de lo que cambió y, si cambia la
   * fecha prometida, su antes y después.
   */
  async update(
    orderId: string,
    input: LabOrderFields,
    ctx: AuditRequestContext,
  ): Promise<LabOrderView> {
    const current = await this.writable(orderId);
    const fields = (Object.keys(input) as LabOrderEditableField[]).filter(
      (k) => input[k] !== undefined,
    );
    if (fields.length === 0) {
      throw new BadRequestException(LAB_MESSAGES.emptyUpdate);
    }
    const touchesContent = fields.some((f) =>
      (LAB_ORDER_CONTENT_FIELDS as readonly string[]).includes(f),
    );
    if (touchesContent && ctx.actor.role === ClinicRole.RECEPTION) {
      throw new ForbiddenException(LAB_MESSAGES.receptionContent);
    }
    const editError = checkEdit(current, fields);
    if (editError) throw ruleError(editError);

    const write: LabOrderWrite = {};
    if (input.labId !== undefined || input.serviceId !== undefined) {
      const labId = input.labId ?? current.labId;
      // Otro laboratorio sin servicio nuevo: el anterior ya no vale.
      const serviceId =
        input.serviceId !== undefined
          ? input.serviceId
          : labId === current.labId
            ? current.serviceId
            : null;
      await this.assertLabAndService(labId, serviceId);
      write.labId = labId;
      write.serviceId = serviceId;
    }
    if (input.description !== undefined) {
      write.description = description(input.description);
    }
    if (input.toothNumbers !== undefined) {
      const teeth = normalizeTeeth(input.toothNumbers);
      if (!teeth.ok) throw new BadRequestException(teeth.message);
      write.toothNumbers = teeth.value;
    }
    if (input.shade !== undefined) {
      write.shade = limitedText(input.shade, ORDER_SHADE_MAX, 'El color');
    }
    if (input.material !== undefined) {
      write.material = limitedText(
        input.material,
        ORDER_MATERIAL_MAX,
        'El material',
      );
    }
    if (input.instructions !== undefined) {
      write.instructions = limitedText(
        input.instructions,
        ORDER_INSTRUCTIONS_MAX,
        'Las instrucciones',
      );
    }
    if (input.dueOn !== undefined) write.dueOn = dueOnOf(input.dueOn);
    if (input.replacesOrderId === orderId) {
      throw new UnprocessableEntityException(LAB_MESSAGES.replacesItself);
    }
    await this.assertLinks(current.patientId, {
      treatmentPlanItemId: input.treatmentPlanItemId ?? null,
      appointmentId: input.appointmentId ?? null,
      replacesOrderId: input.replacesOrderId ?? null,
    });
    if (input.treatmentPlanItemId !== undefined) {
      write.treatmentPlanItemId = input.treatmentPlanItemId;
    }
    if (input.appointmentId !== undefined) {
      write.appointmentId = input.appointmentId;
    }
    if (input.replacesOrderId !== undefined) {
      write.replacesOrderId = input.replacesOrderId;
    }

    const changedFields = changedOf(current, write);
    if (changedFields.length > 0) {
      await this.write(current, write);
      await this.record(ctx, current.patientId, orderId, 'UPDATE', {
        reason: 'DENTAL_LAB_ORDER_UPDATED',
        changedFields,
        ...dueOnChange(current.dueOn, write.dueOn),
      });
    }
    return redactForRole(await this.view(orderId), ctx.actor.role);
  }

  /**
   * Marca «Enviada» (hoy). Sin fecha prometida explícita y con servicio: si la
   * orden no tenía fecha o tenía la sugerida al crearla, pasa a la sugerida
   * desde el día del envío (el plazo corre desde que sale); una fecha puesta a
   * mano se respeta.
   */
  async send(
    orderId: string,
    input: { dueOn?: string | null },
    ctx: AuditRequestContext,
  ): Promise<LabOrderView> {
    const current = await this.writable(orderId);
    this.assertStep(current, 'SEND');
    const now = this.now();
    const write: LabOrderWrite = { sentAt: now, sentById: ctx.actor.userId };
    if (input.dueOn !== undefined && input.dueOn !== null) {
      write.dueOn = dueOnOf(input.dueOn);
    } else if (current.serviceId) {
      const service = await this.repo.findService(current.serviceId);
      if (service) {
        const { timeZone } = await this.repo.calendarOf(current.locationId);
        const createdDay = civilDateIn(current.createdAt, timeZone);
        const sentDay = civilDateIn(now, timeZone);
        const lead = service.leadTimeBusinessDays;
        const auto =
          current.dueOn === null ||
          current.dueOn ===
            (await this.suggestion(current.locationId, createdDay, lead));
        if (auto) {
          write.dueOn = await this.suggestion(
            current.locationId,
            sentDay,
            lead,
          );
        }
      }
    }
    return this.step(current, write, 'SEND', ctx);
  }

  async receive(
    orderId: string,
    ctx: AuditRequestContext,
  ): Promise<LabOrderView> {
    const current = await this.writable(orderId);
    this.assertStep(current, 'RECEIVE');
    return this.step(
      current,
      { receivedAt: this.now(), receivedById: ctx.actor.userId },
      'RECEIVE',
      ctx,
    );
  }

  async check(
    orderId: string,
    ctx: AuditRequestContext,
  ): Promise<LabOrderView> {
    const current = await this.writable(orderId);
    this.assertStep(current, 'CHECK');
    return this.step(
      current,
      { checkedAt: this.now(), checkedById: ctx.actor.userId },
      'CHECK',
      ctx,
    );
  }

  /** Anula con motivo (nunca se borra). El motivo no va a la auditoría. */
  async cancel(
    orderId: string,
    input: { reason?: string },
    ctx: AuditRequestContext,
  ): Promise<LabOrderView> {
    const reason = normalizeCancelReason(input.reason);
    if (reason === null)
      throw new BadRequestException(LAB_MESSAGES.cancelReason);
    const current = await this.writable(orderId);
    this.assertStep(current, 'CANCEL');
    return this.step(
      current,
      {
        cancelledAt: this.now(),
        cancelledById: ctx.actor.userId,
        cancelReason: reason,
      },
      'CANCEL',
      ctx,
    );
  }

  // -- Apoyo

  private async view(orderId: string): Promise<LabOrderView> {
    const [view] = await this.repo.views([orderId], this.now());
    if (!view) throw new NotFoundException(LAB_MESSAGES.orderNotFound);
    return view;
  }

  /**
   * La vista de una orden de una sede permitida al miembro (DX-017-bis): la
   * misma regla y el mismo 403 `LOCATION_NOT_ALLOWED` que las escrituras
   * (`writable`), para que leer y escribir respondan igual.
   */
  private async readable(orderId: string): Promise<LabOrderView> {
    const view = await this.view(orderId);
    this.tenantContext.assertRecordLocationAllowed(view.locationId);
    return view;
  }

  /**
   * Sedes permitidas al miembro para las listas sin sede (la ficha del
   * paciente); `undefined` = todas (sin restricción), como DX-572.
   */
  private allowedLocations(): readonly string[] | undefined {
    const allowed = this.tenantContext.getAllowedLocationIds();
    return allowed === 'ALL' ? undefined : allowed;
  }

  /** La orden (404 bajo RLS) de una sede permitida al miembro (SEC-014). */
  private async writable(orderId: string): Promise<LabOrderRecord> {
    const current = await this.repo.findOrder(orderId);
    if (!current) throw new NotFoundException(LAB_MESSAGES.orderNotFound);
    this.tenantContext.assertRecordLocationAllowed(current.locationId);
    return current;
  }

  private assertStep(current: LabOrderRecord, action: LabOrderAction): void {
    const error = checkTransition(current, action);
    if (error) throw ruleError(error);
  }

  private async step(
    current: LabOrderRecord,
    write: LabOrderWrite,
    action: LabOrderAction,
    ctx: AuditRequestContext,
  ): Promise<LabOrderView> {
    await this.write(current, write);
    const from = deriveLabOrderStatus(current);
    const to = deriveLabOrderStatus({
      sentAt: write.sentAt ?? current.sentAt,
      receivedAt: write.receivedAt ?? current.receivedAt,
      checkedAt: write.checkedAt ?? current.checkedAt,
      cancelledAt: write.cancelledAt ?? current.cancelledAt,
    });
    const reason = {
      SEND: 'DENTAL_LAB_ORDER_SENT',
      RECEIVE: 'DENTAL_LAB_ORDER_RECEIVED',
      CHECK: 'DENTAL_LAB_ORDER_CHECKED',
      CANCEL: 'DENTAL_LAB_ORDER_CANCELLED',
    }[action];
    await this.record(
      ctx,
      current.patientId,
      current.id,
      action === 'CANCEL' ? 'VOID' : 'UPDATE',
      {
        reason,
        statusChange: { from, to },
        ...dueOnChange(current.dueOn, write.dueOn),
      },
    );
    return redactForRole(await this.view(current.id), ctx.actor.role);
  }

  private async write(
    current: LabOrderRecord,
    write: LabOrderWrite,
  ): Promise<void> {
    if (!(await this.repo.updateOrder(current.id, current.updatedAt, write))) {
      throw new ConflictException(LAB_MESSAGES.concurrent);
    }
  }

  private async locationFor(locationId: string | undefined): Promise<string> {
    if (locationId) {
      this.tenantContext.assertLocationAllowed(locationId);
      if (!(await this.repo.locationExists(locationId))) {
        throw new NotFoundException(LAB_MESSAGES.locationNotFound);
      }
      return locationId;
    }
    const active = await this.repo.writeLocationId();
    this.tenantContext.assertLocationAllowed(active);
    return active;
  }

  private async suggestion(
    locationId: string,
    from: string,
    leadTimeBusinessDays: number,
  ): Promise<string> {
    const info = await this.repo.calendarOf(locationId);
    return suggestDueOn(
      from,
      leadTimeBusinessDays,
      effectiveBusinessCalendar(info.calendar, info.openWeekdays),
      info.timeZone,
    );
  }

  /** Laboratorio y servicio vivos y coherentes; devuelve el plazo (o null). */
  private async assertLabAndService(
    labId: string,
    serviceId: string | null,
  ): Promise<number | null> {
    const lab = await this.repo.findLab(labId);
    if (!lab) throw new NotFoundException(LAB_MESSAGES.labNotFound);
    if (!lab.active)
      throw new UnprocessableEntityException(LAB_MESSAGES.labInactive);
    if (serviceId === null) return null;
    const service = await this.repo.findService(serviceId);
    if (!service) throw new NotFoundException(LAB_MESSAGES.serviceNotFound);
    if (service.labId !== labId) {
      throw new UnprocessableEntityException(LAB_MESSAGES.serviceOfOtherLab);
    }
    if (!service.active) {
      throw new UnprocessableEntityException(LAB_MESSAGES.serviceInactive);
    }
    return service.leadTimeBusinessDays;
  }

  /** Ítem, cita y orden corregida del MISMO paciente (422 genérico si no). */
  private async assertLinks(
    patientId: string,
    links: {
      treatmentPlanItemId: string | null;
      appointmentId: string | null;
      replacesOrderId: string | null;
    },
  ): Promise<void> {
    if (
      links.treatmentPlanItemId &&
      !(await this.repo.planItemOfPatient(patientId, links.treatmentPlanItemId))
    ) {
      throw new UnprocessableEntityException(LAB_MESSAGES.planItemNotOfPatient);
    }
    if (
      links.appointmentId &&
      !(await this.repo.appointmentOfPatient(patientId, links.appointmentId))
    ) {
      throw new UnprocessableEntityException(
        LAB_MESSAGES.appointmentNotOfPatient,
      );
    }
    if (
      links.replacesOrderId &&
      !(await this.repo.orderOfPatient(patientId, links.replacesOrderId))
    ) {
      throw new UnprocessableEntityException(LAB_MESSAGES.replacesNotOfPatient);
    }
  }

  private async record(
    ctx: AuditRequestContext,
    patientId: string,
    orderId: string,
    action: 'UPDATE' | 'VOID' | 'PRINT',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action,
      resourceType: 'DENTAL_LAB_ORDER',
      resourceId: orderId,
      patient: { kind: 'patient', id: patientId },
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { ...metadata, params: { id: orderId } },
    });
  }
}

/** Nombres de los campos que de verdad cambian (nunca sus valores). */
function changedOf(current: LabOrderRecord, write: LabOrderWrite): string[] {
  const keys: (keyof LabOrderWrite & keyof LabOrderRecord)[] = [
    'labId',
    'serviceId',
    'description',
    'toothNumbers',
    'shade',
    'material',
    'instructions',
    'dueOn',
    'treatmentPlanItemId',
    'appointmentId',
    'replacesOrderId',
  ];
  return keys.filter(
    (k) =>
      write[k] !== undefined &&
      JSON.stringify(write[k]) !== JSON.stringify(current[k]),
  );
}

function dueOnChange(
  before: string | null,
  after: string | null | undefined,
): { dueOn?: { from: string | null; to: string | null } } {
  return after !== undefined && after !== before
    ? { dueOn: { from: before, to: after } }
    : {};
}
