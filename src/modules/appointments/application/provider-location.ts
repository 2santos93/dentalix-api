import { BadRequestException } from '@nestjs/common';
import type { StaffMember } from '../../staff/domain/entities/staff-member.entity';

/**
 * DX-121d: un profesional restringido a sedes (DX-089, `membership_locations`)
 * solo atiende en ellas; uno sin restricción (y todo ADMIN), en todas.
 */
export const PROVIDER_NOT_AT_LOCATION_MESSAGE =
  'Algún profesional no atiende en esta sede.';

export function attendsAt(
  member: Pick<StaffMember, 'locationIds'>,
  locationId: string,
): boolean {
  return member.locationIds == null || member.locationIds.includes(locationId);
}

/** 400 si el profesional no atiende en la sede objetivo. */
export function assertAttendsAt(
  member: Pick<StaffMember, 'locationIds'>,
  locationId: string,
): void {
  if (!attendsAt(member, locationId)) {
    throw new BadRequestException(PROVIDER_NOT_AT_LOCATION_MESSAGE);
  }
}
