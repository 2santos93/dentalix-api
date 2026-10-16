import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ClinicCountry } from '@prisma/client';
import { LOCATION_REPOSITORY } from '../../domain/ports/location-repository.port';
import type {
  Location,
  LocationRepository,
} from '../../domain/ports/location-repository.port';

@Injectable()
export class ListLocationsUseCase {
  constructor(
    @Inject(LOCATION_REPOSITORY) private readonly repo: LocationRepository,
  ) {}
  execute(): Promise<Location[]> {
    return this.repo.list();
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
  }): Promise<Location> {
    return this.repo.create({
      name: input.name.trim(),
      address: input.address?.trim() || undefined,
      country: input.country,
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
      isActive?: boolean;
    },
  ): Promise<Location> {
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
      isActive: patch.isActive,
    });
    if (!updated) throw new NotFoundException('Location not found');
    return updated;
  }
}
