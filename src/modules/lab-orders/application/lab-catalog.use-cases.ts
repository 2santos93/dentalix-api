import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import type { DentalLabServiceView, DentalLabView } from '../domain/entities';
import {
  LAB_MESSAGES,
  LAB_NAME_MAX,
  optionalText,
} from '../domain/lab-order-rules';
import {
  LAB_REPOSITORY,
  type CatalogWriteResult,
  type LabPatch,
  type LabRepository,
  type LabServicePatch,
} from '../domain/ports/lab-repository.port';

export interface LabFields {
  name?: string;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
  active?: boolean;
}

export interface LabServiceFields {
  name?: string;
  leadTimeBusinessDays?: number;
  referencePrice?: string | null;
  referenceCurrency?: string | null;
  active?: boolean;
}

/** El precio de referencia solo lo ve ADMIN (contrato DX-017). */
export function servicesForRole(
  services: DentalLabServiceView[],
  role: ClinicRole | null,
): DentalLabServiceView[] {
  if (role === ClinicRole.ADMIN) return services;
  return services.map((s) => ({
    ...s,
    referencePrice: null,
    referenceCurrency: null,
  }));
}

export function labForRole(
  lab: DentalLabView,
  role: ClinicRole | null,
): DentalLabView {
  return { ...lab, services: servicesForRole(lab.services, role) };
}

function requiredName(value: string | undefined): string {
  const name = optionalText(value);
  if (name === null || name.length > LAB_NAME_MAX) {
    throw new BadRequestException(LAB_MESSAGES.nameRequired);
  }
  return name;
}

/**
 * El precio tal cual llega (la DTO ya exige un decimal ≥ 0 con hasta 2
 * decimales): se guarda como numeric sin pasar por coma flotante.
 */
function priceText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim();
}

function changed<T extends object>(
  before: T,
  after: T,
  keys: (keyof T)[],
): string[] {
  return keys
    .filter(
      (k) =>
        JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null),
    )
    .map(String);
}

/**
 * Catálogo de laboratorios y sus servicios (DX-017). Solo ADMIN escribe (lo
 * exige la ruta); se audita como DENTAL_LAB con los NOMBRES de los campos que
 * cambiaron (las notas son texto libre: solo su nombre).
 */
@Injectable()
export class LabCatalogUseCases {
  constructor(
    @Inject(LAB_REPOSITORY) private readonly repo: LabRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  async list(
    includeInactive: boolean,
    role: ClinicRole | null,
  ): Promise<DentalLabView[]> {
    const labs = await this.repo.listLabs(includeInactive);
    return labs.map((lab) => labForRole(lab, role));
  }

  async createLab(
    input: LabFields,
    ctx: AuditRequestContext,
  ): Promise<DentalLabView> {
    const result = await this.repo.createLab({
      name: requiredName(input.name),
      contactName: optionalText(input.contactName),
      phone: optionalText(input.phone),
      email: optionalText(input.email),
      notes: optionalText(input.notes),
    });
    const lab = this.unwrap(result);
    await this.record(ctx, 'CREATE', lab.id, 'DENTAL_LAB_CREATED', []);
    return labForRole(lab, ctx.actor.role);
  }

  async updateLab(
    labId: string,
    input: LabFields,
    ctx: AuditRequestContext,
  ): Promise<DentalLabView> {
    const patch: LabPatch = {};
    if (input.name !== undefined) patch.name = requiredName(input.name);
    for (const key of ['contactName', 'phone', 'email', 'notes'] as const) {
      if (input[key] !== undefined) patch[key] = optionalText(input[key]);
    }
    if (input.active !== undefined) patch.active = input.active;
    const { before, after } = this.unwrap(
      await this.repo.updateLab(labId, patch),
    );
    const fields = changed(before, after, [
      'name',
      'contactName',
      'phone',
      'email',
      'notes',
      'active',
    ]);
    if (fields.length > 0) {
      await this.record(ctx, 'UPDATE', labId, 'DENTAL_LAB_UPDATED', fields, {
        ...(before.active !== after.active
          ? {
              statusChange: {
                from: before.active ? 'ACTIVE' : 'INACTIVE',
                to: after.active ? 'ACTIVE' : 'INACTIVE',
              },
            }
          : {}),
      });
    }
    return labForRole(after, ctx.actor.role);
  }

  async createService(
    labId: string,
    input: LabServiceFields,
    ctx: AuditRequestContext,
  ): Promise<DentalLabServiceView> {
    if (!(await this.repo.findLab(labId))) {
      throw new NotFoundException(LAB_MESSAGES.labNotFound);
    }
    const price = this.pricePair(input.referencePrice, input.referenceCurrency);
    const service = this.unwrap(
      await this.repo.createService(labId, {
        name: requiredName(input.name),
        leadTimeBusinessDays: input.leadTimeBusinessDays ?? 0,
        ...price,
      }),
      'SERVICE',
    );
    await this.record(ctx, 'CREATE', labId, 'DENTAL_LAB_SERVICE_CREATED', [], {
      params: { serviceId: service.id },
    });
    return servicesForRole([service], ctx.actor.role)[0];
  }

  async updateService(
    labId: string,
    serviceId: string,
    input: LabServiceFields,
    ctx: AuditRequestContext,
  ): Promise<DentalLabServiceView> {
    const patch: LabServicePatch = {};
    if (input.name !== undefined) patch.name = requiredName(input.name);
    if (input.leadTimeBusinessDays !== undefined) {
      patch.leadTimeBusinessDays = input.leadTimeBusinessDays;
    }
    if (input.active !== undefined) patch.active = input.active;
    if (
      input.referencePrice !== undefined ||
      input.referenceCurrency !== undefined
    ) {
      const current = await this.repo.findService(serviceId);
      if (!current || current.labId !== labId) {
        throw new NotFoundException(LAB_MESSAGES.serviceNotFound);
      }
      Object.assign(
        patch,
        this.pricePair(
          input.referencePrice === undefined
            ? current.referencePrice
            : input.referencePrice,
          input.referenceCurrency === undefined
            ? current.referenceCurrency
            : input.referenceCurrency,
        ),
      );
    }
    const { before, after } = this.unwrap(
      await this.repo.updateService(labId, serviceId, patch),
      'SERVICE',
    );
    const fields = changed(before, after, [
      'name',
      'leadTimeBusinessDays',
      'referencePrice',
      'referenceCurrency',
      'active',
    ]);
    if (fields.length > 0) {
      await this.record(
        ctx,
        'UPDATE',
        labId,
        'DENTAL_LAB_SERVICE_UPDATED',
        fields,
        { params: { serviceId } },
      );
    }
    return servicesForRole([after], ctx.actor.role)[0];
  }

  private pricePair(
    price: string | null | undefined,
    currency: string | null | undefined,
  ): { referencePrice: string | null; referenceCurrency: string | null } {
    const p = priceText(price);
    const c = optionalText(currency)?.toUpperCase() ?? null;
    if ((p === null) !== (c === null)) {
      throw new BadRequestException(LAB_MESSAGES.priceCurrencyPair);
    }
    return { referencePrice: p, referenceCurrency: c };
  }

  private unwrap<T>(
    result: CatalogWriteResult<T>,
    kind: 'LAB' | 'SERVICE' = 'LAB',
  ): T {
    switch (result.kind) {
      case 'OK':
        return result.value;
      case 'NAME_TAKEN':
        throw new ConflictException(
          kind === 'LAB'
            ? LAB_MESSAGES.labNameTaken
            : LAB_MESSAGES.serviceNameTaken,
        );
      case 'LIMIT':
        throw new ConflictException(
          kind === 'LAB' ? LAB_MESSAGES.labsLimit : LAB_MESSAGES.servicesLimit,
        );
      case 'NOT_FOUND':
        throw new NotFoundException(
          kind === 'LAB'
            ? LAB_MESSAGES.labNotFound
            : LAB_MESSAGES.serviceNotFound,
        );
      case 'CURRENCY_UNKNOWN':
        throw new UnprocessableEntityException(LAB_MESSAGES.currencyUnknown);
    }
  }

  private async record(
    ctx: AuditRequestContext,
    action: 'CREATE' | 'UPDATE',
    labId: string,
    reason: string,
    changedFields: string[],
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action,
      resourceType: 'DENTAL_LAB',
      resourceId: labId,
      patient: null,
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        reason,
        ...(changedFields.length > 0 ? { changedFields } : {}),
        ...extra,
      },
    });
  }
}
