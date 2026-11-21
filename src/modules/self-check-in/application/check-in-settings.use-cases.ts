import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  generatePublicLinkToken,
  hashPublicLinkToken,
} from '../../../shared/public-links/public-link-token';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { LOCATION_REPOSITORY } from '../../locations/domain/ports/location-repository.port';
import type { LocationRepository } from '../../locations/domain/ports/location-repository.port';
import {
  CHECK_IN_SETTINGS_MESSAGES,
  DEFAULT_CHECK_IN_SETTINGS,
  checkInSettingsError,
  type CheckInSettings,
} from '../domain/check-in-rules';
import {
  CHECK_IN_REPOSITORY,
  type CheckInRepository,
  type LocationCheckInSettingsView,
} from '../domain/ports/check-in-repository.port';

/** Ruta de la página pública del QR en la web: `<host>/llegada/<token>`. */
export const CHECK_IN_QR_PUBLIC_PATH = '/llegada';

/** El QR recién generado: la ÚNICA vez que sale el token. */
export interface CreatedCheckInQr extends LocationCheckInSettingsView {
  token: string;
}

/**
 * DX-265: Ajustes › Llegada de pacientes (solo ADMIN; el rol lo pone el
 * controlador). Ver y cambiar la ventana de «Ya llegué», el umbral de retraso
 * y si el enlace de la cita lo ofrece; generar el QR de la sede (el token sale
 * UNA vez; en la BD, su hash; generar otro invalida el anterior) y retirarlo.
 * Una sede no permitida al usuario: 403 (SEC-014). La auditoría la pone
 * `@Audit` en el controlador.
 */
@Injectable()
export class CheckInSettingsUseCases {
  constructor(
    @Inject(CHECK_IN_REPOSITORY) private readonly repo: CheckInRepository,
    @Inject(LOCATION_REPOSITORY)
    private readonly locations: LocationRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  private async requireLocation(locationId: string): Promise<void> {
    this.tenantContext.assertLocationAllowed(locationId);
    const location = await this.locations.findById(locationId);
    if (!location || !location.isActive) {
      throw new NotFoundException(CHECK_IN_SETTINGS_MESSAGES.locationNotFound);
    }
  }

  async get(locationId: string): Promise<LocationCheckInSettingsView> {
    await this.requireLocation(locationId);
    return (
      (await this.repo.findSettings(locationId)) ?? {
        locationId,
        ...DEFAULT_CHECK_IN_SETTINGS,
        qrActive: false,
        qrCreatedAt: null,
      }
    );
  }

  async update(
    locationId: string,
    patch: Partial<CheckInSettings>,
    actorId: string,
  ): Promise<LocationCheckInSettingsView> {
    await this.requireLocation(locationId);
    const error = checkInSettingsError(patch);
    if (error) throw new BadRequestException(error);
    const clean: Partial<CheckInSettings> = {};
    if (patch.linkEnabled !== undefined) clean.linkEnabled = patch.linkEnabled;
    if (patch.minutesBefore !== undefined)
      clean.minutesBefore = patch.minutesBefore;
    if (patch.minutesAfter !== undefined)
      clean.minutesAfter = patch.minutesAfter;
    if (patch.lateMinutes !== undefined) clean.lateMinutes = patch.lateMinutes;
    return this.repo.saveSettings(locationId, clean, actorId);
  }

  async createQr(
    locationId: string,
    actorId: string,
  ): Promise<CreatedCheckInQr> {
    await this.requireLocation(locationId);
    const token = generatePublicLinkToken();
    const view = await this.repo.setQrToken(
      locationId,
      hashPublicLinkToken(token),
      actorId,
    );
    return { ...view, token };
  }

  /** Idempotente: sin QR, devuelve los ajustes tal cual. */
  async revokeQr(
    locationId: string,
    actorId: string,
  ): Promise<LocationCheckInSettingsView> {
    const current = await this.get(locationId);
    if (!current.qrActive) return current;
    return this.repo.setQrToken(locationId, null, actorId);
  }
}
