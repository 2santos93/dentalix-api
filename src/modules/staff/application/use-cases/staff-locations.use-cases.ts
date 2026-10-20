import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';

export const STAFF_MEMBER_NOT_FOUND_MESSAGE = 'Miembro no encontrado';
export const ADMIN_HAS_ALL_LOCATIONS_MESSAGE =
  'El ADMIN siempre tiene todas las sedes y no se puede restringir.';
export const UNKNOWN_LOCATION_MESSAGE =
  'Alguna sede no existe en esta clínica.';

/**
 * DX-089: sedes en las que puede trabajar un miembro. `all: true` = sin
 * restricción (y entonces `locationIds` va vacío). `all: false` con
 * `locationIds: []` = restringido a sedes que ya no están activas.
 */
export interface StaffLocations {
  all: boolean;
  locationIds: string[];
}

function toStaffLocations(locationIds: string[] | null): StaffLocations {
  return locationIds === null
    ? { all: true, locationIds: [] }
    : { all: false, locationIds };
}

@Injectable()
export class GetStaffLocationsUseCase {
  constructor(
    @Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository,
  ) {}

  async execute(userId: string): Promise<StaffLocations> {
    const found = await this.repo.getLocations(userId);
    if (found.kind === 'NOT_FOUND') {
      throw new NotFoundException(STAFF_MEMBER_NOT_FOUND_MESSAGE);
    }
    return toStaffLocations(found.locationIds);
  }
}

export interface ReplaceStaffLocationsInput {
  userId: string;
  /** `[]` = todas las sedes. */
  locationIds: string[];
  actorUserId: string;
}

@Injectable()
export class ReplaceStaffLocationsUseCase {
  constructor(
    @Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository,
  ) {}

  async execute(input: ReplaceStaffLocationsInput): Promise<StaffLocations> {
    const locationIds = [...new Set(input.locationIds)];
    // La comprobación (miembro activo, no ADMIN, sedes activas de la clínica)
    // y la escritura van en la misma transacción del repositorio.
    const outcome = await this.repo.replaceLocations(
      input.userId,
      locationIds,
      input.actorUserId,
    );
    switch (outcome.kind) {
      case 'NOT_FOUND':
        throw new NotFoundException(STAFF_MEMBER_NOT_FOUND_MESSAGE);
      case 'IS_ADMIN':
        throw new ConflictException(ADMIN_HAS_ALL_LOCATIONS_MESSAGE);
      case 'UNKNOWN_LOCATION':
        throw new BadRequestException(UNKNOWN_LOCATION_MESSAGE);
      case 'UPDATED':
        return toStaffLocations(
          outcome.locationIds.length === 0 ? null : outcome.locationIds,
        );
    }
  }
}
