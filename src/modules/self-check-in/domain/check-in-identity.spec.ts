import {
  checkInClientKey,
  checkInDocumentKey,
  documentMatches,
  lockedUntil,
  normalizeCheckInDocument,
  retryAfterSeconds,
} from './check-in-identity';

describe('DX-265 · identificación con el QR', () => {
  it('el documento se compara sin puntos, guiones ni espacios', () => {
    const given = normalizeCheckInDocument('v-12.345.678')!;
    expect(given).toBe('V12345678');
    expect(documentMatches(given, 'V-12345678')).toBe(true);
    expect(documentMatches(given, 'V 12 345 678')).toBe(true);
    expect(documentMatches(given, 'E-12345678')).toBe(false);
    expect(documentMatches(given, 'V-12345679')).toBe(false);
  });

  it('solo dígitos vale por el documento con la letra de tipo delante', () => {
    const given = normalizeCheckInDocument('12345678')!;
    expect(documentMatches(given, 'V-12345678')).toBe(true);
    expect(documentMatches(given, '12345678')).toBe(true);
    // Con letra escrita, la letra cuenta.
    expect(
      documentMatches(normalizeCheckInDocument('E12345678')!, 'V-12345678'),
    ).toBe(false);
  });

  it('sin documento guardado nunca casa', () => {
    expect(documentMatches('12345678', null)).toBe(false);
  });

  it('documento vacío, demasiado corto o demasiado largo: null', () => {
    expect(normalizeCheckInDocument('')).toBeNull();
    expect(normalizeCheckInDocument('--')).toBeNull();
    expect(normalizeCheckInDocument('12')).toBeNull();
    expect(normalizeCheckInDocument('1'.repeat(41))).toBeNull();
    expect(normalizeCheckInDocument(42)).toBeNull();
  });

  it('la clave del cliente no lleva la IP y separa sedes y clínicas', () => {
    const a = checkInClientKey('t1', 'l1', '203.0.113.7');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('203.0.113.7');
    expect(checkInClientKey('t1', 'l2', '203.0.113.7')).not.toBe(a);
    expect(checkInClientKey('t2', 'l1', '203.0.113.7')).not.toBe(a);
  });

  it('bloqueo vigente y Retry-After', () => {
    const now = new Date('2027-03-10T14:00:00.000Z');
    const until = new Date('2027-03-10T14:15:00.000Z');
    const state = { failedAttempts: 5, firstFailedAt: now, lockedUntil: until };
    expect(lockedUntil(state, now)).toEqual(until);
    expect(lockedUntil(state, until)).toBeNull();
    expect(lockedUntil(null, now)).toBeNull();
    expect(retryAfterSeconds(until, now)).toBe(900);
    expect(retryAfterSeconds(now, now)).toBe(1);
  });

  it('la clave por documento cuenta igual con o sin la letra, separa sedes y no lleva el documento', () => {
    const a = checkInDocumentKey('t1', 'l1', 'V-12.345.678');
    expect(checkInDocumentKey('t1', 'l1', '12345678')).toBe(a);
    expect(checkInDocumentKey('t1', 'l2', '12345678')).not.toBe(a);
    expect(checkInDocumentKey('t1', 'l1', 'V-12345679')).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('12345678');
    expect(checkInDocumentKey('t1', 'l1', '--')).not.toBe(a);
  });
});
