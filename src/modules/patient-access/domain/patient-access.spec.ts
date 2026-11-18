import * as crypto from 'node:crypto';

jest.mock('node:crypto', () => {
  const actual =
    jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});
import {
  PATIENT_ACCESS_LOCK_MINUTES,
  PATIENT_ACCESS_MAX_ATTEMPTS,
  birthDateMatches,
  buildPatientAccessUrl,
  decideVerification,
  isLinkLive,
  normalizeBirthDate,
  normalizeScopes,
  patientAccessExpiresAt,
  patientAccessWhatsAppMessage,
  retryAfterSeconds,
  scopesSentence,
  storedBirthDate,
} from './patient-access';

const NOW = new Date('2026-11-18T15:00:00.000Z');

describe('normalizeBirthDate (DX-101)', () => {
  it('acepta un día civil real AAAA-MM-DD (con espacios alrededor)', () => {
    expect(normalizeBirthDate('1990-05-21')).toBe('1990-05-21');
    expect(normalizeBirthDate(' 2000-02-29 ')).toBe('2000-02-29');
  });

  it('rechaza fechas que no existen, otros formatos y lo que no es texto', () => {
    for (const bad of [
      '1990-02-30',
      '2001-02-29',
      '1990-13-01',
      '21/05/1990',
      '1990-5-21',
      '19900521',
      '',
      null,
      undefined,
      19900521,
      { birthDate: '1990-05-21' },
    ]) {
      expect(normalizeBirthDate(bad)).toBeNull();
    }
  });

  it('la guardada (medianoche UTC) se lee como su día civil', () => {
    expect(storedBirthDate(new Date('1990-05-21T00:00:00.000Z'))).toBe(
      '1990-05-21',
    );
  });
});

describe('birthDateMatches (DX-101): comparación en tiempo constante', () => {
  it('casa solo con la misma fecha', () => {
    expect(birthDateMatches('1990-05-21', '1990-05-21')).toBe(true);
    expect(birthDateMatches('1990-05-22', '1990-05-21')).toBe(false);
    expect(birthDateMatches('1991-05-21', '1990-05-21')).toBe(false);
  });

  it('sin fecha dada o sin fecha guardada nunca casa', () => {
    expect(birthDateMatches(null, '1990-05-21')).toBe(false);
    expect(birthDateMatches('1990-05-21', null)).toBe(false);
    expect(birthDateMatches(null, null)).toBe(false);
  });

  it('compara con timingSafeEqual sobre resúmenes de la misma longitud, también sin enlace', () => {
    const spy = crypto.timingSafeEqual as unknown as jest.Mock;
    spy.mockClear();
    birthDateMatches('1990-05-21', '1990-05-21');
    birthDateMatches('1990-05-21', null);
    birthDateMatches(null, null);
    expect(spy).toHaveBeenCalledTimes(3);
    for (const [a, b] of spy.mock.calls as [Buffer, Buffer][]) {
      expect(a.length).toBe(32);
      expect(b.length).toBe(32);
    }
  });
});

describe('decideVerification (DX-101): contador y bloqueo', () => {
  const fresh = { failedAttempts: 0, lockedUntil: null };

  it('acierto: vuelve a cero e informa los fallos previos (agregados)', () => {
    expect(
      decideVerification({ failedAttempts: 3, lockedUntil: null }, true, NOW),
    ).toEqual({ kind: 'OK', failedAttemptsBefore: 3 });
  });

  it('los 4 primeros fallos cuentan; el quinto bloquea 30 minutos', () => {
    let state: { failedAttempts: number; lockedUntil: Date | null } = fresh;
    for (let i = 1; i < PATIENT_ACCESS_MAX_ATTEMPTS; i++) {
      const d = decideVerification(state, false, NOW);
      expect(d).toEqual({ kind: 'WRONG', failedAttempts: i });
      state = { failedAttempts: i, lockedUntil: null };
    }
    const lock = decideVerification(state, false, NOW);
    expect(lock).toEqual({
      kind: 'LOCK',
      failedAttempts: 5,
      lockedUntil: new Date(
        NOW.getTime() + PATIENT_ACCESS_LOCK_MINUTES * 60_000,
      ),
    });
  });

  it('durante el bloqueo, 429 aunque la fecha sea buena', () => {
    const lockedUntil = new Date(NOW.getTime() + 60_000);
    expect(
      decideVerification({ failedAttempts: 5, lockedUntil }, true, NOW),
    ).toEqual({ kind: 'LOCKED', lockedUntil });
  });

  it('un bloqueo vencido empieza de cero', () => {
    const lockedUntil = new Date(NOW.getTime() - 1);
    expect(
      decideVerification({ failedAttempts: 5, lockedUntil }, false, NOW),
    ).toEqual({ kind: 'WRONG', failedAttempts: 1 });
    expect(
      decideVerification({ failedAttempts: 5, lockedUntil }, true, NOW),
    ).toEqual({ kind: 'OK', failedAttemptsBefore: 0 });
  });

  it('retryAfterSeconds redondea hacia arriba y nunca baja de 1', () => {
    expect(retryAfterSeconds(new Date(NOW.getTime() + 1_500), NOW)).toBe(2);
    expect(retryAfterSeconds(new Date(NOW.getTime() - 10), NOW)).toBe(1);
  });
});

describe('apartados, caducidad y mensaje (DX-101)', () => {
  it('normalizeScopes quita repetidos y ordena (citas, presupuestos, cuenta)', () => {
    expect(normalizeScopes(['ACCOUNT', 'APPOINTMENTS', 'ACCOUNT'])).toEqual([
      'APPOINTMENTS',
      'ACCOUNT',
    ]);
  });

  it('la caducidad son N días exactos', () => {
    expect(patientAccessExpiresAt(NOW, 14).toISOString()).toBe(
      '2026-12-02T15:00:00.000Z',
    );
  });

  it('vivo = sin revocar y sin caducar (el bloqueo no cuenta)', () => {
    const later = new Date(NOW.getTime() + 1);
    expect(isLinkLive({ revokedAt: null, expiresAt: later }, NOW)).toBe(true);
    expect(isLinkLive({ revokedAt: NOW, expiresAt: later }, NOW)).toBe(false);
    expect(isLinkLive({ revokedAt: null, expiresAt: NOW }, NOW)).toBe(false);
  });

  it('la URL es la de la página pública de la web', () => {
    expect(buildPatientAccessUrl('https://sonrisa.dentalix.app', 'abc')).toBe(
      'https://sonrisa.dentalix.app/mi-clinica/abc',
    );
  });

  it('el WhatsApp dice qué se comparte, sin importes ni tratamientos', () => {
    expect(scopesSentence(['PLANS'])).toBe('tus presupuestos');
    expect(scopesSentence(['ACCOUNT', 'APPOINTMENTS', 'PLANS'])).toBe(
      'tus citas, tus presupuestos y tu estado de cuenta',
    );
    const text = patientAccessWhatsAppMessage({
      firstName: 'María',
      clinicName: 'Clínica Sonrisa Caracas',
      scopes: ['APPOINTMENTS', 'ACCOUNT'],
      url: 'https://sonrisa.dentalix.app/mi-clinica/abc',
      expiresAtLabel: '2 de diciembre de 2026',
    });
    expect(text).toContain('Hola María');
    expect(text).toContain('tus citas y tu estado de cuenta');
    expect(text).toContain('fecha de nacimiento');
    expect(text).toContain('https://sonrisa.dentalix.app/mi-clinica/abc');
    expect(text).not.toMatch(/\d+[.,]\d{2}|USD|VES|Bs/);
  });
});
