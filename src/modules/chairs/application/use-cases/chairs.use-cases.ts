import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Chair } from '../../domain/entities/chair.entity';
import {
  CHAIR_NOT_FOUND_MESSAGE,
  CHAIR_SORT_ORDER_MAX,
  DUPLICATE_CHAIR_NAME_MESSAGE,
  chairNameError,
  chairSortOrderError,
  normalizeChairName,
  sameChairName,
} from '../../domain/chair-rules';
import {
  CHAIR_REPOSITORY,
  type ChairRepository,
} from '../../domain/ports/chair-repository.port';
import { LOCATION_REPOSITORY } from '../../../locations/domain/ports/location-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import { STAFF_REPOSITORY } from '../../../staff/domain/ports/staff-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import { assertAttendsAt } from '../../../staff/domain/provider-location';
import {
  ATTENDING_ROLES,
  NOT_ATTENDING_MESSAGE,
} from '../../../schedule-blocks/domain/schedule-block-rules';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

export const CHAIR_LOCATION_NOT_FOUND_MESSAGE = 'Sede no encontrada';
export const CHAIR_ORDER_MISMATCH_MESSAGE =
  'Envía todos los sillones de la sede, cada uno una vez';

export interface CreateChairInput {
  locationId: string;
  name: string;
  sortOrder?: number;
  defaultProviderId?: string | null;
}

export interface UpdateChairInput {
  name?: string;
  sortOrder?: number;
  /** `null` quita el profesional por defecto. */
  defaultProviderId?: string | null;
}

function assertValid(error: string | null): void {
  if (error !== null) throw new BadRequestException(error);
}

async function assertLocationExists(
  locations: LocationRepository,
  locationId: string,
): Promise<void> {
  if (!(await locations.findById(locationId))) {
    throw new NotFoundException(CHAIR_LOCATION_NOT_FOUND_MESSAGE);
  }
}

/**
 * El profesional por defecto es un miembro ACTIVO de esta clínica (RLS: uno
 * de otra da 404), que atiende pacientes y atiende en la sede del sillón
 * (DX-089). La FK compuesta de la BD repite «miembro de la clínica».
 */
async function assertDefaultProvider(
  staff: StaffRepository,
  providerId: string,
  locationId: string,
): Promise<void> {
  const member = await staff.findById(providerId);
  if (!member) throw new NotFoundException('Profesional no encontrado');
  if (!ATTENDING_ROLES.includes(member.role)) {
    throw new BadRequestException(NOT_ATTENDING_MESSAGE);
  }
  assertAttendsAt(member, locationId);
}

/**
 * «Sillón 1» y «sillón 1» chocan aquí con un 409 claro; el único exacto de
 * la BD (chairs_location_name_key) es la red de una carrera.
 */
async function assertNameFree(
  repo: ChairRepository,
  locationId: string,
  name: string,
  exceptId?: string,
): Promise<void> {
  const chairs = await repo.listByLocation({
    locationId,
    includeInactive: true,
  });
  if (chairs.some((c) => c.id !== exceptId && sameChairName(c.name, name))) {
    throw new ConflictException(DUPLICATE_CHAIR_NAME_MESSAGE);
  }
}

/** Sillón de ESTA clínica (404 si no) en una sede permitida al usuario (403). */
async function loadChair(
  repo: ChairRepository,
  tenantContext: TenantContextService,
  id: string,
): Promise<Chair> {
  const chair = await repo.findById(id);
  if (!chair) throw new NotFoundException(CHAIR_NOT_FOUND_MESSAGE);
  tenantContext.assertLocationAllowed(chair.locationId);
  return chair;
}

@Injectable()
export class ListChairsUseCase {
  constructor(
    @Inject(CHAIR_REPOSITORY) private readonly repo: ChairRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Por defecto solo los activos (el selector del formulario de cita). */
  async execute(params: {
    locationId: string;
    includeInactive?: boolean;
  }): Promise<Chair[]> {
    this.tenantContext.assertLocationAllowed(params.locationId);
    await assertLocationExists(this.locations, params.locationId);
    return this.repo.listByLocation({
      locationId: params.locationId,
      includeInactive: params.includeInactive ?? false,
    });
  }
}

@Injectable()
export class CreateChairUseCase {
  constructor(
    @Inject(CHAIR_REPOSITORY) private readonly repo: ChairRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    @Inject(STAFF_REPOSITORY) private readonly staff: StaffRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(input: CreateChairInput, actorId: string): Promise<Chair> {
    this.tenantContext.assertLocationAllowed(input.locationId);
    await assertLocationExists(this.locations, input.locationId);
    assertValid(chairNameError(input.name));
    const name = normalizeChairName(input.name);
    if (input.sortOrder !== undefined) {
      assertValid(chairSortOrderError(input.sortOrder));
    }
    if (input.defaultProviderId) {
      await assertDefaultProvider(
        this.staff,
        input.defaultProviderId,
        input.locationId,
      );
    }
    await assertNameFree(this.repo, input.locationId, name);
    // Sin orden explícito, al final de la sede.
    const existing = await this.repo.listByLocation({
      locationId: input.locationId,
      includeInactive: true,
    });
    const last = existing.reduce((max, c) => Math.max(max, c.sortOrder), -1);
    return this.repo.create({
      locationId: input.locationId,
      name,
      sortOrder: input.sortOrder ?? Math.min(last + 1, CHAIR_SORT_ORDER_MAX),
      defaultProviderId: input.defaultProviderId ?? null,
      createdById: actorId,
    });
  }
}

@Injectable()
export class UpdateChairUseCase {
  constructor(
    @Inject(CHAIR_REPOSITORY) private readonly repo: ChairRepository,
    @Inject(STAFF_REPOSITORY) private readonly staff: StaffRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Renombrar, cambiar el orden o el profesional por defecto NO toca las
   * citas: el nombre se embebe al leerlas y el profesional solo se propone.
   */
  async execute(
    id: string,
    input: UpdateChairInput,
    actorId: string,
  ): Promise<Chair> {
    const chair = await loadChair(this.repo, this.tenantContext, id);
    let name: string | undefined;
    if (input.name !== undefined) {
      assertValid(chairNameError(input.name));
      name = normalizeChairName(input.name);
      await assertNameFree(this.repo, chair.locationId, name, chair.id);
    }
    if (input.sortOrder !== undefined) {
      assertValid(chairSortOrderError(input.sortOrder));
    }
    if (input.defaultProviderId) {
      await assertDefaultProvider(
        this.staff,
        input.defaultProviderId,
        chair.locationId,
      );
    }
    return this.repo.update(id, {
      name,
      sortOrder: input.sortOrder,
      defaultProviderId: input.defaultProviderId,
      updatedById: actorId,
    });
  }
}

@Injectable()
export class SetChairActiveUseCase {
  constructor(
    @Inject(CHAIR_REPOSITORY) private readonly repo: ChairRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Desactivar en lugar de borrar: el sillón deja de ofrecerse para citas
   * nuevas y de salir como columna, pero sus citas (pasadas y futuras) lo
   * conservan y lo muestran con «(inactivo)».
   */
  async execute(id: string, active: boolean, actorId: string): Promise<Chair> {
    await loadChair(this.repo, this.tenantContext, id);
    return this.repo.update(id, { active, updatedById: actorId });
  }
}

@Injectable()
export class ReorderChairsUseCase {
  constructor(
    @Inject(CHAIR_REPOSITORY) private readonly repo: ChairRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * El orden de las columnas: TODOS los sillones de la sede (activos o no),
   * cada uno una vez. Un id de otra sede o clínica no es de la sede: 400.
   */
  async execute(
    input: { locationId: string; chairIds: string[] },
    actorId: string,
  ): Promise<Chair[]> {
    this.tenantContext.assertLocationAllowed(input.locationId);
    await assertLocationExists(this.locations, input.locationId);
    const current = await this.repo.listByLocation({
      locationId: input.locationId,
      includeInactive: true,
    });
    const wanted = new Set(input.chairIds);
    if (
      wanted.size !== input.chairIds.length ||
      wanted.size !== current.length ||
      current.some((c) => !wanted.has(c.id))
    ) {
      throw new BadRequestException(CHAIR_ORDER_MISMATCH_MESSAGE);
    }
    return this.repo.reorder(input.locationId, input.chairIds, actorId);
  }
}
