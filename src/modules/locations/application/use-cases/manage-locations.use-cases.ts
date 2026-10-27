import {
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
  type HealthRegistrationChange,
  healthRegistrationChange,
  normalizeHealthRegistrationNumber,
} from '../../domain/health-registration';
import {
  COUNTRY_MISSING,
  isRegionalError,
  regionalBadRequest,
  validateRegionalSettings,
} from '../../domain/regional-settings';
import { CURRENCY_WHITELIST } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import type { CurrencyWhitelist } from '../../../treatment-plans/domain/ports/currency-whitelist.port';

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

/**
 * Alta de sede (G1, spec §3.1): país, moneda, zona y formato regional son
 * obligatorios y explícitos (R1, R10); nada se deduce del país (R2). La sede
 * nace revisada (R11). 400 con el mensaje y el campo del primero que falta o
 * no vale, en el orden país, moneda, zona, formato.
 */
@Injectable()
export class CreateLocationUseCase {
  constructor(
    @Inject(LOCATION_REPOSITORY) private readonly repo: LocationRepository,
    @Inject(CURRENCY_WHITELIST) private readonly currencies: CurrencyWhitelist,
  ) {}
  async execute(input: {
    name: string;
    address?: string;
    country?: ClinicCountry;
    currency?: string;
    timeZone?: string;
    locale?: string;
    phone?: string;
  }): Promise<Location> {
    if (!input.country) {
      throw regionalBadRequest('country', COUNTRY_MISSING);
    }
    const regional = await validateRegionalSettings(input, this.currencies);
    if (isRegionalError(regional)) {
      throw regionalBadRequest(regional.field, regional.message);
    }
    return this.repo.create({
      name: input.name.trim(),
      address: input.address?.trim() || undefined,
      country: input.country,
      ...regional,
      phone: input.phone?.trim() || undefined,
    });
  }
}

/**
 * La sede editada y, si cambió el nº de registro sanitario o si se imprime
 * (DX-319), su antes y después para la auditoría.
 */
export interface LocationUpdate {
  location: Location;
  healthRegistration: HealthRegistrationChange | null;
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
      healthRegistrationNumber?: string | null;
      showHealthRegistrationNumber?: boolean;
      phone?: string | null;
      isActive?: boolean;
    },
  ): Promise<LocationUpdate> {
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
      // DX-319: texto libre, sin formato por país; vacío o null lo quita.
      healthRegistrationNumber: normalizeHealthRegistrationNumber(
        patch.healthRegistrationNumber,
      ),
      showHealthRegistrationNumber: patch.showHealthRegistrationNumber,
      phone: normalizePhone(patch.phone),
      isActive: patch.isActive,
    });
    if (!updated) throw new NotFoundException('Location not found');
    return {
      location: updated,
      healthRegistration: healthRegistrationChange(current, updated),
    };
  }
}
