import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  RECEIPT_SETTINGS_REPOSITORY,
  type LocationReceiptLegendView,
  type ReceiptSettingsRepository,
} from '../../domain/ports/receipt-settings-repository.port';
import {
  RECEIPT_LEGEND_MAX,
  RECEIPT_LEGEND_MESSAGE,
  RECEIPT_TITLE_MAX,
  RECEIPT_TITLE_MESSAGE,
  normalizeReceiptText,
  type ClinicReceiptSettings,
} from '../../domain/receipt-settings';

export const RECEIPT_SETTINGS_LOCATION_NOT_FOUND_MESSAGE =
  'No encontramos esa sede en la clínica.';

/** DX-515: lo que ve Ajustes › Caja y la ficha de cada sede. */
export interface ReceiptSettingsView extends ClinicReceiptSettings {
  locations: LocationReceiptLegendView[];
}

function text(
  value: string | null | undefined,
  max: number,
  message: string,
): string | null {
  const normalized = normalizeReceiptText(value, max);
  if (normalized === undefined) throw new BadRequestException(message);
  return normalized;
}

@Injectable()
export class GetReceiptSettingsUseCase {
  constructor(
    @Inject(RECEIPT_SETTINGS_REPOSITORY)
    private readonly repo: ReceiptSettingsRepository,
  ) {}

  async execute(): Promise<ReceiptSettingsView> {
    const [clinic, locations] = await Promise.all([
      this.repo.getClinic(),
      this.repo.listLocations(),
    ]);
    return { ...clinic, locations };
  }
}

/**
 * Cambia el título y la leyenda del recibo de la clínica (solo ADMIN, lo
 * exige la ruta). Vacío = sin configurar. Aplica a los recibos que se emitan
 * desde ahora: los ya emitidos conservan su foto (append-only).
 */
@Injectable()
export class UpdateReceiptSettingsUseCase {
  constructor(
    @Inject(RECEIPT_SETTINGS_REPOSITORY)
    private readonly repo: ReceiptSettingsRepository,
  ) {}

  async execute(
    input: { title?: string | null; legend?: string | null },
    ctx: AuditRequestContext,
  ): Promise<ClinicReceiptSettings> {
    return this.repo.setClinic(
      {
        title: text(input.title, RECEIPT_TITLE_MAX, RECEIPT_TITLE_MESSAGE),
        legend: text(input.legend, RECEIPT_LEGEND_MAX, RECEIPT_LEGEND_MESSAGE),
      },
      ctx,
    );
  }
}

/**
 * La leyenda propia de una sede (solo ADMIN): `override` false vuelve a la de
 * la clínica (y la leyenda guardada se borra); `override` con leyenda vacía =
 * la sede no imprime ninguna.
 */
@Injectable()
export class UpdateLocationReceiptLegendUseCase {
  constructor(
    @Inject(RECEIPT_SETTINGS_REPOSITORY)
    private readonly repo: ReceiptSettingsRepository,
  ) {}

  async execute(
    locationId: string,
    input: { override: boolean; legend?: string | null },
    ctx: AuditRequestContext,
  ): Promise<LocationReceiptLegendView> {
    const legend = input.override
      ? text(input.legend, RECEIPT_LEGEND_MAX, RECEIPT_LEGEND_MESSAGE)
      : null;
    const saved = await this.repo.setLocation(
      locationId,
      { override: input.override, legend },
      ctx,
    );
    if (!saved) {
      throw new NotFoundException(RECEIPT_SETTINGS_LOCATION_NOT_FOUND_MESSAGE);
    }
    return saved;
  }
}
