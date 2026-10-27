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
  RegionalWrite,
} from '../../domain/ports/location-repository.port';
import {
  type HealthRegistrationChange,
  healthRegistrationChange,
  normalizeHealthRegistrationNumber,
} from '../../domain/health-registration';
import {
  COUNTRY_MISSING,
  REGIONAL_CHANGE_MESSAGES,
  REGIONAL_NULL_MESSAGE,
  type RegionalError,
  type RegionalField,
  isRegionalError,
  regionalBadRequest,
  validateCurrency,
  validateLocale,
  validateRegionalSettings,
  validateTimeZone,
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

/** Moneda, zona y formato de una sede en la auditoría (G1, R13). */
export interface AuditRegionalSide {
  currency: string | null;
  timeZone: string | null;
  locale: string | null;
}

export interface RegionalSettingsChange {
  before: AuditRegionalSide;
  after: AuditRegionalSide;
  /** La sede quedó marcada como revisada con esta edición. */
  reviewed: boolean;
}

/**
 * La sede editada y, si cambió el nº de registro sanitario o si se imprime
 * (DX-319), su antes y después para la auditoría. `regionalSettings` va
 * cuando la edición traía moneda, zona, formato o la confirmación (G1).
 */
export interface LocationUpdate {
  location: Location;
  healthRegistration: HealthRegistrationChange | null;
  regionalSettings: RegionalSettingsChange | null;
}

function regionalConflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

const regionalSide = (l: Location): AuditRegionalSide => ({
  currency: l.currency,
  timeZone: l.timeZone,
  locale: l.locale,
});

@Injectable()
export class UpdateLocationUseCase {
  constructor(
    @Inject(LOCATION_REPOSITORY) private readonly repo: LocationRepository,
    @Inject(CURRENCY_WHITELIST) private readonly currencies: CurrencyWhitelist,
  ) {}

  /**
   * Valida los campos regionales presentes (spec §3.2). `null` es 400; un
   * campo ausente no se toca.
   */
  private async validateProvided(patch: {
    currency?: string | null;
    timeZone?: string | null;
    locale?: string | null;
  }): Promise<Partial<Record<RegionalField, string>>> {
    const out: Partial<Record<RegionalField, string>> = {};
    const checks: [
      RegionalField,
      string | null | undefined,
      () => Promise<string | RegionalError> | string | RegionalError,
    ][] = [
      [
        'currency',
        patch.currency,
        () => validateCurrency(patch.currency, this.currencies),
      ],
      ['timeZone', patch.timeZone, () => validateTimeZone(patch.timeZone)],
      ['locale', patch.locale, () => validateLocale(patch.locale)],
    ];
    for (const [field, raw, validate] of checks) {
      if (raw === undefined) continue;
      if (raw === null) throw regionalBadRequest(field, REGIONAL_NULL_MESSAGE);
      const result = await validate();
      if (typeof result !== 'string') {
        throw regionalBadRequest(result.field, result.message);
      }
      out[field] = result;
    }
    return out;
  }

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
      currency?: string | null;
      timeZone?: string | null;
      locale?: string | null;
      confirmRegionalSettings?: true;
      confirmRegionalChange?: true;
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

    const regional = await this.validateProvided(patch);
    const touchesRegional =
      Object.keys(regional).length > 0 ||
      patch.currency !== undefined ||
      patch.timeZone !== undefined ||
      patch.locale !== undefined ||
      patch.confirmRegionalSettings === true;

    const base = {
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
    };

    if (!touchesRegional) {
      const updated = await this.repo.update(id, base);
      if (!updated) throw new NotFoundException('Location not found');
      return {
        location: updated,
        healthRegistration: healthRegistrationChange(current, updated),
        regionalSettings: null,
      };
    }

    let before: AuditRegionalSide | null = null;
    let reviewed = false;
    const updated = await this.repo.updateRegional(
      id,
      base,
      async (ctx): Promise<RegionalWrite> => {
        const cur = ctx.current;
        before = regionalSide(cur);
        // Rellenar un NULL (réplica antigua sin barrer) no es un «cambio».
        const differs = (field: RegionalField): boolean =>
          regional[field] !== undefined && regional[field] !== cur[field];
        const moved = (field: RegionalField): boolean =>
          differs(field) && cur[field] !== null;

        if (moved('currency') || moved('timeZone')) {
          // Decisión 2: con la fila bloqueada, la caja abierta gana a la
          // confirmación.
          if (await ctx.hasOpenCashSession()) {
            throw regionalConflict(
              'LOCATION_REGIONAL_CASH_OPEN',
              REGIONAL_CHANGE_MESSAGES.cashOpen,
            );
          }
          if (
            patch.confirmRegionalChange !== true &&
            (await ctx.hasRegionalHistory())
          ) {
            throw regionalConflict(
              'LOCATION_REGIONAL_CHANGE_UNCONFIRMED',
              [
                moved('currency') &&
                  REGIONAL_CHANGE_MESSAGES.currency(cur.currency ?? ''),
                moved('timeZone') && REGIONAL_CHANGE_MESSAGES.timeZone,
              ]
                .filter(Boolean)
                .join(' '),
            );
          }
        }

        reviewed =
          patch.confirmRegionalSettings === true ||
          differs('currency') ||
          differs('timeZone') ||
          differs('locale');
        return {
          currency: differs('currency') ? regional.currency : undefined,
          timeZone: differs('timeZone') ? regional.timeZone : undefined,
          locale: differs('locale') ? regional.locale : undefined,
          reviewed,
        };
      },
    );
    if (!updated || !before) throw new NotFoundException('Location not found');
    return {
      location: updated,
      healthRegistration: healthRegistrationChange(current, updated),
      regionalSettings: { before, after: regionalSide(updated), reviewed },
    };
  }
}
