import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type {
  ClinicReceiptSettings,
  LocationReceiptLegend,
} from '../receipt-settings';

export const RECEIPT_SETTINGS_REPOSITORY = Symbol(
  'RECEIPT_SETTINGS_REPOSITORY',
);

/** Una sede viva de la clínica con su leyenda del recibo (DX-515). */
export interface LocationReceiptLegendView extends LocationReceiptLegend {
  locationId: string;
  name: string;
  isActive: boolean;
}

/**
 * DX-515: título y leyenda del recibo de la clínica y leyenda propia de cada
 * sede. Cada cambio deja su evento de auditoría (antes y después) en la MISMA
 * transacción; si nada cambió, no hay evento.
 */
export interface ReceiptSettingsRepository {
  getClinic(): Promise<ClinicReceiptSettings>;
  listLocations(): Promise<LocationReceiptLegendView[]>;
  setClinic(
    next: ClinicReceiptSettings,
    ctx: AuditRequestContext,
  ): Promise<ClinicReceiptSettings>;
  /** `null` si la sede no existe o no es de la clínica (RLS). */
  setLocation(
    locationId: string,
    next: LocationReceiptLegend,
    ctx: AuditRequestContext,
  ): Promise<LocationReceiptLegendView | null>;
}
