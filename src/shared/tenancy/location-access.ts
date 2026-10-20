import { ForbiddenException } from '@nestjs/common';

/**
 * DX-089: personal restringido a sedes.
 *
 * Las sedes permitidas viajan en el claim `loc` del access token (ver
 * `TenantJwtPayload`). Sin claim = TODAS las sedes: así lo leen los tokens
 * emitidos antes de DX-089, los ADMIN y el break-glass. Con claim, solo esas;
 * `loc = []` significa NINGUNA (todas sus sedes se desactivaron) y nunca se
 * convierte en "todas".
 */
export const LOCATION_NOT_ALLOWED_CODE = 'LOCATION_NOT_ALLOWED';
export const LOCATION_NOT_ALLOWED_MESSAGE = 'No tienes acceso a esta sede.';
export const NO_ACTIVE_LOCATION_MESSAGE =
  'No tienes ninguna sede activa asignada.';

/** Sedes en las que puede trabajar el usuario del request. */
export type AllowedLocations = readonly string[] | 'ALL';

export function allowedLocationsFromClaim(
  loc: readonly string[] | undefined,
): AllowedLocations {
  return loc === undefined ? 'ALL' : loc;
}

export function isLocationAllowed(
  allowed: AllowedLocations,
  locationId: string,
): boolean {
  return allowed === 'ALL' || allowed.includes(locationId);
}

/** 403 estable (`code`) para una sede fuera de las permitidas. */
export function locationNotAllowed(): ForbiddenException {
  return forbidden(LOCATION_NOT_ALLOWED_MESSAGE);
}

/** 403 para un miembro restringido que no conserva ninguna sede activa. */
export function noActiveLocation(): ForbiddenException {
  return forbidden(NO_ACTIVE_LOCATION_MESSAGE);
}

function forbidden(message: string): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: LOCATION_NOT_ALLOWED_CODE,
    message,
  });
}
