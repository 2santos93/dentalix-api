import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ClinicCountry } from '@prisma/client';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { LOCATION_REPOSITORY } from '../../domain/ports/location-repository.port';
import type {
  Location,
  LocationRepository,
} from '../../domain/ports/location-repository.port';
import {
  REPS_FORMAT_MESSAGE,
  isValidRepsCode,
  normalizeRepsCode,
} from '../../../../shared/validation/health-codes';

/**
 * DX-222: teléfono recortado; vacío o null = quitarlo (null), ausente = no
 * tocarlo (undefined).
 */
function normalizePhone(
  phone: string | null | undefined,
): string | null | undefined {
  if (phone === undefined) return undefined;
  return phone?.trim() || null;
}

/**
 * Sedes de la clínica. DX-089: un miembro restringido solo ve las suyas (el
 * selector de sede, la agenda y la caja no le ofrecen las demás); el ADMIN
 * y quien no tiene restricción, todas.
 */
@Injectable()
export class ListLocationsUseCase {
  constructor(
    @Inject(LOCATION_REPOSITORY) private readonly repo: LocationRepository,
    private readonly tenantContext: TenantContextService,
  ) {}
  async execute(): Promise<Location[]> {
    const locations = await this.repo.list();
    const allowed = this.tenantContext.getAllowedLocationIds();
    return allowed === 'ALL'
      ? locations
      : locations.filter((location) => allowed.includes(location.id));
  }
}

@Injectable()
export class CreateLocationUseCase {
  constructor(
    @Inject(LOCATION_REPOSITORY) private readonly repo: LocationRepository,
  ) {}
  execute(input: {
    name: string;
    address?: string;
    country?: ClinicCountry;
    phone?: string;
  }): Promise<Location> {
    return this.repo.create({
      name: input.name.trim(),
      address: input.address?.trim() || undefined,
      country: input.country,
      phone: input.phone?.trim() || undefined,
    });
  }
}

@Injectable()
export class UpdateLocationUseCase {
  constructor(
    @Inject(LOCATION_REPOSITORY) private readonly repo: LocationRepository,
  ) {}

  async execute(
    id: string,
    patch: {
      name?: string;
      address?: string;
      country?: ClinicCountry;
      repsHabilitationCode?: string | null;
      phone?: string | null;
      isActive?: boolean;
    },
  ): Promise<Location> {
    // DX-212: código REPS normalizado (vacío = quitarlo) o 400 con el formato.
    const reps = normalizeRepsCode(patch.repsHabilitationCode);
    if (reps && !isValidRepsCode(reps)) {
      throw new BadRequestException(REPS_FORMAT_MESSAGE);
    }
    const current = await this.repo.findById(id);
    if (!current) throw new NotFoundException('Location not found');

    // Una clínica no puede quedarse sin ninguna sede activa: citas, pagos e
    // inventario EXIGEN sede, así que desactivar la última dejaría la clínica
    // sin poder operar. Mismo criterio que el "último administrador".
    if (
      patch.isActive === false &&
      current.isActive &&
      (await this.repo.countActive()) <= 1
    ) {
      throw new ConflictException('Cannot deactivate the last active location');
    }

    const updated = await this.repo.update(id, {
      name: patch.name?.trim(),
      address: patch.address?.trim(),
      country: patch.country,
      repsHabilitationCode: reps,
      phone: normalizePhone(patch.phone),
      isActive: patch.isActive,
    });
    if (!updated) throw new NotFoundException('Location not found');
    return updated;
  }
}
