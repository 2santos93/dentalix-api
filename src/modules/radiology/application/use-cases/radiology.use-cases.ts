import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { validateReason } from '../../../equipment/domain/equipment-rules';
import {
  EQUIPMENT_REPOSITORY,
  type EquipmentRepository,
} from '../../../equipment/domain/ports/equipment-repository.port';
import {
  LOCATION_REPOSITORY,
  type LocationRepository,
} from '../../../locations/domain/ports/location-repository.port';
import {
  STAFF_REPOSITORY,
  type StaffRepository,
} from '../../../staff/domain/ports/staff-repository.port';
import type {
  RadiologyLicenseCategory,
  RadiologyRecordKind,
  RadiologyRecordRecord,
} from '../../domain/entities/radiology-record.entity';
import {
  radiologyDueHorizon,
  selectRadiologyDue,
  type RadiologyDueItem,
} from '../../domain/radiology-due';
import {
  RADIOLOGY_ALREADY_VOIDED_MESSAGE,
  RADIOLOGY_EQUIPMENT_NOT_FOUND_MESSAGE,
  RADIOLOGY_EQUIPMENT_NOT_XRAY_MESSAGE,
  RADIOLOGY_EQUIPMENT_OTHER_LOCATION_MESSAGE,
  RADIOLOGY_EQUIPMENT_RETIRED_MESSAGE,
  RADIOLOGY_LOCATION_NOT_FOUND_MESSAGE,
  RADIOLOGY_LOCATION_NO_ZONE_MESSAGE,
  RADIOLOGY_OFFICER_BOTH_MESSAGE,
  RADIOLOGY_OFFICER_NOT_FOUND_MESSAGE,
  RADIOLOGY_RECORD_NOT_FOUND_MESSAGE,
  RADIOLOGY_VOIDED_MESSAGE,
  radiologyStatus,
  validateRadiologyFields,
} from '../../domain/radiology-rules';
import {
  RADIOLOGY_CLOCK,
  RADIOLOGY_REPOSITORY,
  type RadiologyClock,
  type RadiologyRecordStatusFilter,
  type RadiologyRepository,
} from '../../domain/ports/radiology-repository.port';
import {
  radiologyRecordView,
  type RadiologyRecordView,
} from '../radiology-view';

export const RADIOLOGY_PAGE_SIZE_DEFAULT = 50;
/** Cuántos avisos devuelve por defecto «Mi día» (el resto, en Ajustes). */
export const RADIOLOGY_DUE_LIMIT_DEFAULT = 10;
export const RADIOLOGY_DUE_LIMIT_MAX = 50;

export interface ListRadiologyInput {
  locationId?: string;
  kind?: RadiologyRecordKind;
  status?: RadiologyRecordStatusFilter;
  page?: number;
  pageSize?: number;
}

export interface ListRadiologyOutput {
  items: RadiologyRecordView[];
  total: number;
  page: number;
  pageSize: number;
}

/** Campos editables; en la edición, los que no llegan se quedan como están. */
export interface RadiologyInput {
  locationId?: string;
  equipmentId?: string | null;
  category?: RadiologyLicenseCategory | null;
  reference?: string | null;
  issuer?: string;
  issuedOn?: string;
  /** `null` (o vacío): se calcula por el tipo y la categoría. */
  expiresOn?: string | null;
  officerUserId?: string | null;
  officerName?: string | null;
  notes?: string | null;
}

export type CreateRadiologyInput = RadiologyInput & {
  kind: RadiologyRecordKind;
  locationId: string;
  issuer: string;
  issuedOn: string;
};

export interface ListRadiologyDueOutput {
  /** Instante del cálculo. */
  generatedAt: string;
  items: RadiologyDueItem[];
  /** Todos los avisos del alcance (los `items` son los primeros). */
  total: number;
}

/** «Hoy» en la sede del documento: decide la expedición futura y el estado. */
function todayIn(clock: RadiologyClock, timeZone: string | null): string {
  if (!timeZone) {
    throw new BadRequestException(RADIOLOGY_LOCATION_NO_ZONE_MESSAGE);
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
    throw new NotFoundException(RADIOLOGY_LOCATION_NOT_FOUND_MESSAGE);
  }
  return location;
}

/**
 * El equipo es de esta clínica (404 si no: RLS), de la MISMA sede que el
 * documento (400), de rayos X (400) y activo (400). La FK compuesta
 * (tenantId, locationId, equipmentId) de la BD repite «misma sede».
 */
async function assertXrayOfLocation(
  equipment: EquipmentRepository,
  equipmentId: string,
  locationId: string,
): Promise<void> {
  const found = await equipment.findById(equipmentId);
  if (!found) {
    throw new NotFoundException(RADIOLOGY_EQUIPMENT_NOT_FOUND_MESSAGE);
  }
  if (found.locationId !== locationId) {
    throw new BadRequestException(RADIOLOGY_EQUIPMENT_OTHER_LOCATION_MESSAGE);
  }
  if (found.category !== 'XRAY') {
    throw new BadRequestException(RADIOLOGY_EQUIPMENT_NOT_XRAY_MESSAGE);
  }
  if (found.status !== 'ACTIVE') {
    throw new BadRequestException(RADIOLOGY_EQUIPMENT_RETIRED_MESSAGE);
  }
}

/** El encargado del personal es un miembro ACTIVO de esta clínica (404 si no). */
async function assertOfficer(
  staff: StaffRepository,
  officerUserId: string,
): Promise<void> {
  if (!(await staff.findById(officerUserId))) {
    throw new NotFoundException(RADIOLOGY_OFFICER_NOT_FOUND_MESSAGE);
  }
}

function assertOneOfficer(
  officerUserId: string | null | undefined,
  officerName: string | null | undefined,
): void {
  if (officerUserId && officerName && officerName.trim() !== '') {
    throw new BadRequestException(RADIOLOGY_OFFICER_BOTH_MESSAGE);
  }
}

/** Documento de ESTA clínica (404) en una sede permitida al usuario (403). */
async function loadRecord(
  repo: RadiologyRepository,
  tenantContext: TenantContextService,
  id: string,
): Promise<RadiologyRecordRecord> {
  const record = await repo.findById(id);
  if (!record) throw new NotFoundException(RADIOLOGY_RECORD_NOT_FOUND_MESSAGE);
  tenantContext.assertLocationAllowed(record.locationId);
  return record;
}

function viewOf(
  record: RadiologyRecordRecord,
  clock: RadiologyClock,
): RadiologyRecordView {
  const status =
    record.voidedAt === null && record.locationTimeZone
      ? radiologyStatus(
          record.expiresOn,
          civilDateIn(clock(), record.locationTimeZone),
          record.renewed,
        )
      : null;
  return radiologyRecordView(record, status);
}

@Injectable()
export class ListRadiologyRecordsUseCase {
  constructor(
    @Inject(RADIOLOGY_REPOSITORY) private readonly repo: RadiologyRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(RADIOLOGY_CLOCK) private readonly clock: RadiologyClock,
  ) {}

  /**
   * Una sede (`locationId`) o, sin ella, la de la cabecera o las permitidas
   * al usuario (vista consolidada). Por defecto, los vivos.
   */
  async execute(input: ListRadiologyInput): Promise<ListRadiologyOutput> {
    let locationIds: string[] | undefined;
    if (input.locationId) {
      await loadLocation(this.locations, this.tenantContext, input.locationId);
      locationIds = [input.locationId];
    } else {
      locationIds = this.tenantContext.scopeLocationIds();
    }
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? RADIOLOGY_PAGE_SIZE_DEFAULT;
    // `loc = []`: ninguna sede, nada que leer.
    const { rows, total } =
      locationIds !== undefined && locationIds.length === 0
        ? { rows: [], total: 0 }
        : await this.repo.list({
            locationIds,
            kind: input.kind,
            status: input.status ?? 'LIVE',
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
export class GetRadiologyRecordUseCase {
  constructor(
    @Inject(RADIOLOGY_REPOSITORY) private readonly repo: RadiologyRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(RADIOLOGY_CLOCK) private readonly clock: RadiologyClock,
  ) {}

  async execute(id: string): Promise<RadiologyRecordView> {
    return viewOf(
      await loadRecord(this.repo, this.tenantContext, id),
      this.clock,
    );
  }
}

@Injectable()
export class CreateRadiologyRecordUseCase {
  constructor(
    @Inject(RADIOLOGY_REPOSITORY) private readonly repo: RadiologyRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(EQUIPMENT_REPOSITORY)
    private readonly equipment: EquipmentRepository,
    @Inject(STAFF_REPOSITORY) private readonly staff: StaffRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(RADIOLOGY_CLOCK) private readonly clock: RadiologyClock,
  ) {}

  /** Alta: sin vencimiento, se calcula (licencia I 5 años, II 4; control 2). */
  async execute(
    input: CreateRadiologyInput,
    actorId: string,
  ): Promise<RadiologyRecordView> {
    const location = await loadLocation(
      this.locations,
      this.tenantContext,
      input.locationId,
    );
    const today = todayIn(this.clock, location.timeZone);
    assertOneOfficer(input.officerUserId, input.officerName);
    const fields = validateRadiologyFields(
      {
        kind: input.kind,
        category: input.category,
        reference: input.reference,
        issuer: input.issuer,
        issuedOn: input.issuedOn,
        expiresOn: input.expiresOn,
        officerName: input.officerName,
        notes: input.notes,
      },
      today,
    );
    if (input.equipmentId) {
      await assertXrayOfLocation(
        this.equipment,
        input.equipmentId,
        location.id,
      );
    }
    if (input.officerUserId) {
      await assertOfficer(this.staff, input.officerUserId);
    }
    const saved = await this.repo.create({
      locationId: location.id,
      equipmentId: input.equipmentId ?? null,
      ...fields,
      officerUserId: input.officerUserId ?? null,
      createdById: actorId,
    });
    return viewOf(saved, this.clock);
  }
}

@Injectable()
export class UpdateRadiologyRecordUseCase {
  constructor(
    @Inject(RADIOLOGY_REPOSITORY) private readonly repo: RadiologyRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(EQUIPMENT_REPOSITORY)
    private readonly equipment: EquipmentRepository,
    @Inject(STAFF_REPOSITORY) private readonly staff: StaffRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(RADIOLOGY_CLOCK) private readonly clock: RadiologyClock,
  ) {}

  /**
   * Edición parcial (el tipo no cambia). El vencimiento: el que llega; `null`
   * lo recalcula; si no llega y cambian la expedición o la categoría, también
   * se recalcula (si no, se conserva). Cambiar de sede quita el equipo, salvo
   * que venga uno de la sede nueva. Anulado: 409.
   */
  async execute(
    id: string,
    input: RadiologyInput,
    actorId: string,
  ): Promise<RadiologyRecordView> {
    // Red bajo el DTO: un obligatorio no se borra con null.
    const nulls = input as Record<string, unknown>;
    for (const [key, message] of [
      ['locationId', 'La sede no es válida.'],
      ['issuer', 'Escribe la entidad emisora.'],
      ['issuedOn', 'La fecha de expedición no es válida (AAAA-MM-DD).'],
    ] as const) {
      if (nulls[key] === null) throw new BadRequestException(message);
    }
    const current = await loadRecord(this.repo, this.tenantContext, id);
    if (current.voidedAt !== null) {
      throw new ConflictException(RADIOLOGY_VOIDED_MESSAGE);
    }
    const moves =
      input.locationId !== undefined && input.locationId !== current.locationId;
    const location = moves
      ? await loadLocation(
          this.locations,
          this.tenantContext,
          input.locationId!,
        )
      : { id: current.locationId, timeZone: current.locationTimeZone };
    const today = todayIn(this.clock, location.timeZone);

    const officerUserId =
      input.officerUserId !== undefined
        ? input.officerUserId
        : input.officerName
          ? null
          : current.officerUserId;
    const officerName =
      input.officerName !== undefined
        ? input.officerName
        : input.officerUserId
          ? null
          : current.officerName;
    assertOneOfficer(officerUserId, officerName);

    const issuedOn = input.issuedOn ?? current.issuedOn;
    const category =
      input.category !== undefined ? input.category : current.category;
    const recalculates =
      input.expiresOn === null ||
      (input.expiresOn === undefined &&
        (issuedOn !== current.issuedOn || category !== current.category));
    const fields = validateRadiologyFields(
      {
        kind: current.kind,
        category,
        reference:
          input.reference !== undefined ? input.reference : current.reference,
        issuer: input.issuer ?? current.issuer,
        issuedOn,
        expiresOn: recalculates ? null : (input.expiresOn ?? current.expiresOn),
        officerName,
        notes: input.notes !== undefined ? input.notes : current.notes,
      },
      today,
    );

    let equipmentId =
      input.equipmentId !== undefined ? input.equipmentId : current.equipmentId;
    if (moves && input.equipmentId === undefined) equipmentId = null;
    if (equipmentId && (moves || equipmentId !== current.equipmentId)) {
      await assertXrayOfLocation(this.equipment, equipmentId, location.id);
    }
    if (officerUserId && officerUserId !== current.officerUserId) {
      await assertOfficer(this.staff, officerUserId);
    }
    const { kind: _kind, ...editable } = fields;
    const saved = await this.repo.update(id, {
      ...editable,
      locationId: location.id,
      equipmentId,
      officerUserId,
      updatedById: actorId,
    });
    // Otra petición lo anuló entre la lectura y la escritura.
    if (!saved) throw new ConflictException(RADIOLOGY_VOIDED_MESSAGE);
    return viewOf(saved, this.clock);
  }
}

@Injectable()
export class VoidRadiologyRecordUseCase {
  constructor(
    @Inject(RADIOLOGY_REPOSITORY) private readonly repo: RadiologyRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(RADIOLOGY_CLOCK) private readonly clock: RadiologyClock,
  ) {}

  /** Anular con motivo, una vez. El documento sigue en el expediente, marcado. */
  async execute(
    id: string,
    reason: string,
    actorId: string,
  ): Promise<RadiologyRecordView> {
    const record = await loadRecord(this.repo, this.tenantContext, id);
    if (record.voidedAt !== null) {
      throw new ConflictException(RADIOLOGY_ALREADY_VOIDED_MESSAGE);
    }
    const voidReason = validateReason(reason, 'anulación');
    const voided = await this.repo.void(id, {
      voidedById: actorId,
      voidReason,
    });
    if (!voided) throw new ConflictException(RADIOLOGY_ALREADY_VOIDED_MESSAGE);
    return viewOf(voided, this.clock);
  }
}

/**
 * DX-544 · «Rayos X: licencias y control de calidad» en «Mi día»: los
 * documentos vivos y sin renovar vencidos o que vencen en ≤90 días, en la
 * sede activa (o las permitidas al usuario; sin restricción ni cabecera, toda
 * la clínica), como los mantenimientos de DX-543. La BD preselecciona hasta
 * el día UTC + 91 y el dominio decide con el «hoy» de cada sede.
 */
@Injectable()
export class ListRadiologyDueUseCase {
  constructor(
    @Inject(RADIOLOGY_REPOSITORY) private readonly repo: RadiologyRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(RADIOLOGY_CLOCK) private readonly clock: RadiologyClock,
  ) {}

  async execute(input: { limit?: number }): Promise<ListRadiologyDueOutput> {
    const now = this.clock();
    const locationIds = this.tenantContext.scopeLocationIds();
    const records =
      locationIds !== undefined && locationIds.length === 0
        ? []
        : await this.repo.listDueCandidates({
            locationIds,
            expiresOnOrBefore: radiologyDueHorizon(now),
          });
    const all = selectRadiologyDue(records, now);
    return {
      generatedAt: now.toISOString(),
      items: all.slice(0, input.limit ?? RADIOLOGY_DUE_LIMIT_DEFAULT),
      total: all.length,
    };
  }
}
