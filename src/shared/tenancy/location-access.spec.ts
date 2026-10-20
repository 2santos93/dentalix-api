import { ForbiddenException } from '@nestjs/common';
import {
  LOCATION_NOT_ALLOWED_CODE,
  LOCATION_NOT_ALLOWED_MESSAGE,
  NO_ACTIVE_LOCATION_MESSAGE,
  allowedLocationsFromClaim,
  isLocationAllowed,
  locationNotAllowed,
  noActiveLocation,
} from './location-access';

describe('location-access (DX-089)', () => {
  describe('allowedLocationsFromClaim', () => {
    it('sin claim `loc` → todas las sedes (tokens viejos, ADMIN, break-glass)', () => {
      expect(allowedLocationsFromClaim(undefined)).toBe('ALL');
    });

    it('`loc = []` → ninguna sede (nunca se convierte en ALL)', () => {
      expect(allowedLocationsFromClaim([])).toEqual([]);
    });

    it('`loc` con sedes → esas sedes', () => {
      expect(allowedLocationsFromClaim(['a', 'b'])).toEqual(['a', 'b']);
    });
  });

  describe('isLocationAllowed', () => {
    it('ALL permite cualquier sede', () => {
      expect(isLocationAllowed('ALL', 'x')).toBe(true);
    });

    it('una lista solo permite sus sedes', () => {
      expect(isLocationAllowed(['a'], 'a')).toBe(true);
      expect(isLocationAllowed(['a'], 'b')).toBe(false);
      expect(isLocationAllowed([], 'a')).toBe(false);
    });
  });

  it('locationNotAllowed → 403 con code estable y mensaje en español', () => {
    const err = locationNotAllowed();
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      code: LOCATION_NOT_ALLOWED_CODE,
      message: 'No tienes acceso a esta sede.',
    });
    expect(LOCATION_NOT_ALLOWED_MESSAGE).toBe('No tienes acceso a esta sede.');
    expect(LOCATION_NOT_ALLOWED_CODE).toBe('LOCATION_NOT_ALLOWED');
  });

  it('noActiveLocation → 403 con el mismo code y mensaje propio', () => {
    const err = noActiveLocation();
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      code: 'LOCATION_NOT_ALLOWED',
      message: NO_ACTIVE_LOCATION_MESSAGE,
    });
    expect(NO_ACTIVE_LOCATION_MESSAGE).toBe(
      'No tienes ninguna sede activa asignada.',
    );
  });
});
