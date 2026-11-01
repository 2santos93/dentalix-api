import type { AuditEventDraft } from '../../audit/domain/audit-event';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { configAuditEvent } from '../../audit/domain/config-audit';
import type { Location } from './ports/location-repository.port';

/**
 * DX-360: alta de una sede (`POST /locations`). Su nombre, país, valores
 * regionales y teléfono: datos públicos de la SEDE. La dirección no se
 * guarda (texto libre).
 */
export function locationCreatedAuditEvent(
  ctx: AuditRequestContext,
  location: Location,
): AuditEventDraft {
  return configAuditEvent(ctx, {
    action: 'CREATE',
    resourceType: 'LOCATION',
    resourceId: location.id,
    reason: 'LOCATION_CREATED',
    after: {
      name: location.name,
      country: location.country,
      currency: location.currency,
      timeZone: location.timeZone,
      locale: location.locale,
      hourCycle: location.hourCycle,
      phone: location.phone,
      defaultPhoneRegion: location.defaultPhoneRegion,
    },
  });
}
