import {
  PATIENT_ACCESS_COOKIE,
  derivePatientAccessSessionKey,
  readCookie,
  signPatientAccessSession,
  verifyPatientAccessSession,
} from './patient-access-session';

const KEY = derivePatientAccessSessionKey('secreto-de-prueba-0123456789abcdef');
const OTHER_KEY = derivePatientAccessSessionKey(
  'otro-secreto-0123456789abcdef',
);
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-18T15:00:00.000Z');
const LATER = new Date(NOW.getTime() + 30 * 60_000);

describe('sesión del portal del paciente (DX-101)', () => {
  it('firma y verifica: devuelve el enlace y la caducidad', () => {
    const value = signPatientAccessSession(KEY, TENANT_A, LINK, LATER);
    expect(verifyPatientAccessSession(KEY, TENANT_A, value, NOW)).toEqual({
      linkId: LINK,
      expiresAt: LATER,
    });
  });

  it('no lleva ni el paciente ni los apartados', () => {
    const value = signPatientAccessSession(KEY, TENANT_A, LINK, LATER);
    expect(value.split('.')).toHaveLength(5);
    expect(value).not.toContain(TENANT_A);
  });

  it('dos sesiones del mismo enlace no son iguales (nonce)', () => {
    expect(signPatientAccessSession(KEY, TENANT_A, LINK, LATER)).not.toBe(
      signPatientAccessSession(KEY, TENANT_A, LINK, LATER),
    );
  });

  it('la de otra clínica (host manipulado) no vale', () => {
    const value = signPatientAccessSession(KEY, TENANT_A, LINK, LATER);
    expect(verifyPatientAccessSession(KEY, TENANT_B, value, NOW)).toBeNull();
  });

  it('caducada no vale', () => {
    const value = signPatientAccessSession(KEY, TENANT_A, LINK, LATER);
    expect(verifyPatientAccessSession(KEY, TENANT_A, value, LATER)).toBeNull();
  });

  it('con otra clave, manipulada o mal formada no vale', () => {
    const value = signPatientAccessSession(KEY, TENANT_A, LINK, LATER);
    expect(
      verifyPatientAccessSession(OTHER_KEY, TENANT_A, value, NOW),
    ).toBeNull();
    const parts = value.split('.');
    const otherLink = '44444444-4444-4444-8444-444444444444';
    const swapped = [parts[0], otherLink, ...parts.slice(2)].join('.');
    expect(verifyPatientAccessSession(KEY, TENANT_A, swapped, NOW)).toBeNull();
    const longer = [
      parts[0],
      parts[1],
      String(LATER.getTime() + 3_600_000),
      parts[3],
      parts[4],
    ].join('.');
    expect(verifyPatientAccessSession(KEY, TENANT_A, longer, NOW)).toBeNull();
    for (const bad of [
      undefined,
      '',
      'v1',
      'v2.' + parts.slice(1).join('.'),
      `${value}.x`,
      'x'.repeat(500),
    ]) {
      expect(verifyPatientAccessSession(KEY, TENANT_A, bad, NOW)).toBeNull();
    }
  });

  it('lee la cookie por su nombre exacto entre otras', () => {
    expect(
      readCookie(
        `dentalix_rt=abc; ${PATIENT_ACCESS_COOKIE}=v1.x; otra=1`,
        PATIENT_ACCESS_COOKIE,
      ),
    ).toBe('v1.x');
    expect(
      readCookie(`${PATIENT_ACCESS_COOKIE}x=1`, PATIENT_ACCESS_COOKIE),
    ).toBeUndefined();
    expect(readCookie(undefined, PATIENT_ACCESS_COOKIE)).toBeUndefined();
  });
});
