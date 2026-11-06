import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { civilDateIn } from '../../../../shared/time/civil-day';
import {
  CHAIR_REPOSITORY,
  type ChairRepository,
} from '../../../chairs/domain/ports/chair-repository.port';
import {
  LOCATION_REPOSITORY,
  type LocationRepository,
} from '../../../locations/domain/ports/location-repository.port';
import {
  CURRENCY_WHITELIST,
  type CurrencyWhitelist,
} from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import type {
  EquipmentCategory,
  EquipmentMaintenance,
  EquipmentRecord,
  EquipmentRiskClass,
  MaintenanceKind,
} from '../../domain/entities/equipment.entity';
import {
  EQUIPMENT_ALREADY_RETIRED_MESSAGE,
  EQUIPMENT_CHAIR_INACTIVE_MESSAGE,
  EQUIPMENT_CHAIR_NOT_FOUND_MESSAGE,
  EQUIPMENT_CHAIR_OTHER_LOCATION_MESSAGE,
  EQUIPMENT_LOCATION_NOT_FOUND_MESSAGE,
  EQUIPMENT_LOCATION_NO_ZONE_MESSAGE,
  EQUIPMENT_NOT_FOUND_MESSAGE,
  EQUIPMENT_RETIRED_MESSAGE,
  MAINTENANCE_ALREADY_VOIDED_MESSAGE,
  MAINTENANCE_NOT_FOUND_MESSAGE,
  UNKNOWN_CURRENCY_MESSAGE,
  maintenanceStatus,
  nextMaintenanceOn,
  resolveMaintenanceNextDue,
  validateEquipmentFields,
  validateMaintenanceFields,
  validateReason,
  validateRetiredOn,
} from '../../domain/equipment-rules';
import {
  EQUIPMENT_CLOCK,
  EQUIPMENT_REPOSITORY,
  type EquipmentClock,
  type EquipmentRepository,
  type EquipmentStatusFilter,
} from '../../domain/ports/equipment-repository.port';
import {
  equipmentView,
  type EquipmentDetailView,
  type EquipmentView,
} from '../equipment-view';

export const EQUIPMENT_PAGE_SIZE_DEFAULT = 50;

export interface ListEquipmentInput {
  locationId?: string;
  status?: EquipmentStatusFilter;
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface ListEquipmentOutput {
  items: EquipmentView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface EquipmentInput {
  locationId?: string;
  chairId?: string | null;
  name?: string;
  category?: EquipmentCategory;
  brand?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  sanitaryRegistration?: string | null;
  riskClass?: EquipmentRiskClass | null;
  acquiredOn?: string | null;
  maintenanceIntervalMonths?: number | null;
  notes?: string | null;
}

export type CreateEquipmentInput = EquipmentInput & {
  locationId: string;
  name: string;
  category: EquipmentCategory;
};

export interface RecordMaintenanceInput {
  kind: MaintenanceKind;
  performedOn: string;
  technician?: string | null;
  company?: string | null;
  description: string;
  cost?: number | null;
  currency?: string | null;
  nextDueOn?: string | null;
}

/** «Hoy» en la sede del equipo: decide fechas futuras y vencimientos. */
function todayIn(clock: EquipmentClock, timeZone: string | null): string {
  if (!timeZone) {
    throw new BadRequestException(EQUIPMENT_LOCATION_NO_ZONE_MESSAGE);
  }
  return civilDateIn(clock(), timeZone);
}

/** Sede de ESTA clínica (404) permitida al usuario (403), con su zona. */
async function loadLocation(
  locations: LocationRepository,
  tenantContext: TenantContextService,
  locationId: string,
): Promise<{ id: string; timeZone: string | null }> {
  tenantContext.assertLocationAllowed(locationId);
  const location = await locations.findById(locationId);
  if (!location) {
    throw new NotFoundException(EQUIPMENT_LOCATION_NOT_FOUND_MESSAGE);
  }
  return location;
}

/**
 * El sillón es de esta clínica (404 si no: RLS), de la MISMA sede que el
 * equipo (400) y está activo (400). La FK compuesta (tenantId, locationId,
 * chairId) de la BD repite «misma sede».
 */
async function assertChairOfLocation(
  chairs: ChairRepository,
  chairId: string,
  locationId: string,
): Promise<void> {
  const chair = await chairs.findById(chairId);
  if (!chair) throw new NotFoundException(EQUIPMENT_CHAIR_NOT_FOUND_MESSAGE);
  if (chair.locationId !== locationId) {
    throw new BadRequestException(EQUIPMENT_CHAIR_OTHER_LOCATION_MESSAGE);
  }
  if (!chair.active) {
    throw new BadRequestException(EQUIPMENT_CHAIR_INACTIVE_MESSAGE);
  }
}

/** Equipo de ESTA clínica (404) en una sede permitida al usuario (403). */
async function loadEquipment(
  repo: EquipmentRepository,
  tenantContext: TenantContextService,
  id: string,
): Promise<EquipmentRecord> {
  const equipment = await repo.findById(id);
  if (!equipment) throw new NotFoundException(EQUIPMENT_NOT_FOUND_MESSAGE);
  tenantContext.assertLocationAllowed(equipment.locationId);
  return equipment;
}

function assertActive(equipment: EquipmentRecord): void {
  if (equipment.status === 'RETIRED') {
    throw new ConflictException(EQUIPMENT_RETIRED_MESSAGE);
  }
}

function viewOf(record: EquipmentRecord, clock: EquipmentClock): EquipmentView {
  const next = nextMaintenanceOn(record);
  const status =
    record.status === 'ACTIVE' && record.locationTimeZone
      ? maintenanceStatus(next, civilDateIn(clock(), record.locationTimeZone))
      : null;
  return equipmentView(record, next, status);
}

@Injectable()
export class ListEquipmentUseCase {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly repo: EquipmentRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(EQUIPMENT_CLOCK) private readonly clock: EquipmentClock,
  ) {}

  /**
   * Una sede (`locationId`) o, sin ella, la de la cabecera o las permitidas
   * al usuario (la vista consolidada del ADMIN). Por defecto, los activos.
   */
  async execute(input: ListEquipmentInput): Promise<ListEquipmentOutput> {
    let locationIds: string[] | undefined;
    if (input.locationId) {
      await loadLocation(this.locations, this.tenantContext, input.locationId);
      locationIds = [input.locationId];
    } else {
      locationIds = this.tenantContext.scopeLocationIds();
    }
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? EQUIPMENT_PAGE_SIZE_DEFAULT;
    const query = input.query?.trim();
    const { rows, total } = await this.repo.list({
      locationIds,
      status: input.status ?? 'ACTIVE',
      query: query ? query : undefined,
      page,
      pageSize,
    });
    return {
      items: rows.map((r) => viewOf(r, this.clock)),
      total,
      page,
      pageSize,
    };
  }
}

@Injectable()
export class GetEquipmentUseCase {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly repo: EquipmentRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(EQUIPMENT_CLOCK) private readonly clock: EquipmentClock,
  ) {}

  /** Hoja de vida: los datos del equipo y TODOS sus mantenimientos (también anulados). */
  async execute(id: string): Promise<EquipmentDetailView> {
    const equipment = await loadEquipment(this.repo, this.tenantContext, id);
    const maintenances = await this.repo.listMaintenances(id);
    return { ...viewOf(equipment, this.clock), maintenances };
  }
}

@Injectable()
export class CreateEquipmentUseCase {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly repo: EquipmentRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(CHAIR_REPOSITORY) private readonly chairs: ChairRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(EQUIPMENT_CLOCK) private readonly clock: EquipmentClock,
  ) {}

  async execute(
    input: CreateEquipmentInput,
    actorId: string,
  ): Promise<EquipmentView> {
    const location = await loadLocation(
      this.locations,
      this.tenantContext,
      input.locationId,
    );
    const today = todayIn(this.clock, location.timeZone);
    const fields = validateEquipmentFields(
      {
        name: input.name ?? '',
        brand: input.brand ?? null,
        model: input.model ?? null,
        serialNumber: input.serialNumber ?? null,
        sanitaryRegistration: input.sanitaryRegistration ?? null,
        notes: input.notes ?? null,
        acquiredOn: input.acquiredOn ?? null,
        maintenanceIntervalMonths: input.maintenanceIntervalMonths ?? null,
      },
      today,
    );
    if (input.chairId) {
      await assertChairOfLocation(this.chairs, input.chairId, location.id);
    }
    const saved = await this.repo.create({
      locationId: location.id,
      chairId: input.chairId ?? null,
      name: fields.name!,
      category: input.category,
      brand: fields.brand ?? null,
      model: fields.model ?? null,
      serialNumber: fields.serialNumber ?? null,
      sanitaryRegistration: fields.sanitaryRegistration ?? null,
      riskClass: input.riskClass ?? null,
      acquiredOn: fields.acquiredOn ?? null,
      maintenanceIntervalMonths: fields.maintenanceIntervalMonths ?? null,
      notes: fields.notes ?? null,
      createdById: actorId,
    });
    return viewOf(saved, this.clock);
  }
}

@Injectable()
export class UpdateEquipmentUseCase {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly repo: EquipmentRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(CHAIR_REPOSITORY) private readonly chairs: ChairRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(EQUIPMENT_CLOCK) private readonly clock: EquipmentClock,
  ) {}

  /**
   * Edición parcial. Trasladar el equipo a otra sede quita su sillón, salvo
   * que venga uno de la sede nueva. Dado de baja: 409.
   */
  async execute(
    id: string,
    input: EquipmentInput,
    actorId: string,
  ): Promise<EquipmentView> {
    // Red bajo el DTO: un obligatorio no se borra con null.
    const nulls = input as Record<string, unknown>;
    if (nulls.locationId === null || nulls.category === null) {
      throw new BadRequestException(
        nulls.locationId === null
          ? 'La sede no es válida.'
          : 'El tipo de equipo no es válido.',
      );
    }
    const equipment = await loadEquipment(this.repo, this.tenantContext, id);
    assertActive(equipment);
    const moves =
      input.locationId !== undefined &&
      input.locationId !== equipment.locationId;
    const location = moves
      ? await loadLocation(
          this.locations,
          this.tenantContext,
          input.locationId!,
        )
      : { id: equipment.locationId, timeZone: equipment.locationTimeZone };
    const today = todayIn(this.clock, location.timeZone);
    const fields = validateEquipmentFields(
      {
        name: input.name,
        brand: input.brand,
        model: input.model,
        serialNumber: input.serialNumber,
        sanitaryRegistration: input.sanitaryRegistration,
        notes: input.notes,
        acquiredOn: input.acquiredOn,
        maintenanceIntervalMonths: input.maintenanceIntervalMonths,
      },
      today,
    );
    let chairId: string | null | undefined = input.chairId;
    if (moves && chairId === undefined) chairId = null;
    if (chairId && (moves || chairId !== equipment.chairId)) {
      await assertChairOfLocation(this.chairs, chairId, location.id);
    }
    const saved = await this.repo.update(id, {
      locationId: moves ? location.id : undefined,
      chairId,
      name: fields.name ?? undefined,
      category: input.category,
      brand: fields.brand,
      model: fields.model,
      serialNumber: fields.serialNumber,
      sanitaryRegistration: fields.sanitaryRegistration,
      riskClass: input.riskClass,
      acquiredOn: fields.acquiredOn,
      maintenanceIntervalMonths: fields.maintenanceIntervalMonths,
      notes: fields.notes,
      updatedById: actorId,
    });
    // Otra petición lo dio de baja entre la lectura y la escritura.
    if (!saved) throw new ConflictException(EQUIPMENT_RETIRED_MESSAGE);
    return viewOf(saved, this.clock);
  }
}

@Injectable()
export class RetireEquipmentUseCase {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly repo: EquipmentRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(EQUIPMENT_CLOCK) private readonly clock: EquipmentClock,
  ) {}

  /** Baja con fecha (por defecto hoy en la sede) y motivo. No se deshace. */
  async execute(
    id: string,
    input: { retiredOn?: string | null; reason: string },
    actorId: string,
  ): Promise<EquipmentView> {
    const equipment = await loadEquipment(this.repo, this.tenantContext, id);
    if (equipment.status === 'RETIRED') {
      throw new ConflictException(EQUIPMENT_ALREADY_RETIRED_MESSAGE);
    }
    const today = todayIn(this.clock, equipment.locationTimeZone);
    const retiredReason = validateReason(input.reason, 'baja');
    const retiredOn = validateRetiredOn(
      input.retiredOn,
      today,
      equipment.acquiredOn,
    );
    const saved = await this.repo.retire(id, {
      retiredOn,
      retiredReason,
      retiredById: actorId,
    });
    if (!saved) throw new ConflictException(EQUIPMENT_ALREADY_RETIRED_MESSAGE);
    return viewOf(saved, this.clock);
  }
}

@Injectable()
export class RecordMaintenanceUseCase {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly repo: EquipmentRepository,
    @Inject(CURRENCY_WHITELIST) private readonly currencies: CurrencyWhitelist,
    private readonly tenantContext: TenantContextService,
    @Inject(EQUIPMENT_CLOCK) private readonly clock: EquipmentClock,
  ) {}

  /**
   * Registra un mantenimiento y deja fijado su «próximo»: el explícito o, en
   * un preventivo, la fecha + la periodicidad del equipo.
   */
  async execute(
    equipmentId: string,
    input: RecordMaintenanceInput,
    actorId: string,
  ): Promise<EquipmentMaintenance> {
    const equipment = await loadEquipment(
      this.repo,
      this.tenantContext,
      equipmentId,
    );
    assertActive(equipment);
    const today = todayIn(this.clock, equipment.locationTimeZone);
    const fields = validateMaintenanceFields(
      input,
      today,
      equipment.acquiredOn,
    );
    if (fields.currency && !(await this.currencies.has(fields.currency))) {
      throw new BadRequestException(UNKNOWN_CURRENCY_MESSAGE);
    }
    const saved = await this.repo.addMaintenance({
      equipmentId,
      kind: input.kind,
      ...fields,
      nextDueOn: resolveMaintenanceNextDue(
        input.kind,
        fields.performedOn,
        fields.nextDueOn,
        equipment.maintenanceIntervalMonths,
      ),
      createdById: actorId,
    });
    // Otra petición lo dio de baja entre la lectura y el alta.
    if (!saved) throw new ConflictException(EQUIPMENT_RETIRED_MESSAGE);
    return saved;
  }
}

@Injectable()
export class VoidMaintenanceUseCase {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly repo: EquipmentRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Anular con motivo, una vez. El registro sigue en la hoja de vida. */
  async execute(
    equipmentId: string,
    maintenanceId: string,
    reason: string,
    actorId: string,
  ): Promise<EquipmentMaintenance> {
    await loadEquipment(this.repo, this.tenantContext, equipmentId);
    const maintenance = await this.repo.findMaintenance(
      equipmentId,
      maintenanceId,
    );
    if (!maintenance) {
      throw new NotFoundException(MAINTENANCE_NOT_FOUND_MESSAGE);
    }
    if (maintenance.voidedAt !== null) {
      throw new ConflictException(MAINTENANCE_ALREADY_VOIDED_MESSAGE);
    }
    const voidReason = validateReason(reason, 'anulación');
    const voided = await this.repo.voidMaintenance(maintenanceId, {
      voidedById: actorId,
      voidReason,
    });
    if (!voided)
      throw new ConflictException(MAINTENANCE_ALREADY_VOIDED_MESSAGE);
    return voided;
  }
}
