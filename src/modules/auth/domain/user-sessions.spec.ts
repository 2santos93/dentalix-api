import {
  KNOWN_DEVICE_WINDOW_MS,
  deviceFingerprint,
  isSessionIdle,
  isValidSessionIdleMinutes,
  parseDurationMs,
  shouldNotifyNewDevice,
  truncateIp,
} from './user-sessions';
import { decideRefreshRotation } from './refresh-rotation';
import { trustedDeviceLabel } from './user-mfa';

describe('DX-137 · sesiones: dominio', () => {
  describe('truncateIp', () => {
    it.each([
      ['190.202.15.37', '190.202.15.0/24'],
      ['10.0.0.1', '10.0.0.0/24'],
      ['::ffff:200.44.32.12', '200.44.32.0/24'],
      ['2800:a4:1f0e:4a00:1c2b:3d4e:5f60:7182', '2800:a4:1f0e::/48'],
      ['2800:00a4:001f::1', '2800:a4:1f::/48'],
      ['2001:db8::1', '2001:db8:0::/48'],
      ['::1', '0:0:0::/48'],
      ['fe80::1%en0', 'fe80:0:0::/48'],
    ])('%s → %s', (ip, expected) => {
      expect(truncateIp(ip)).toBe(expected);
    });

    it.each([null, undefined, '', 'no-es-ip', '999.1.1.1', 'localhost'])(
      '%p → null (nunca guarda lo que no entiende)',
      (ip) => {
        expect(truncateIp(ip)).toBeNull();
      },
    );

    it('nunca devuelve la IP completa: el último octeto siempre es 0', () => {
      for (let i = 0; i < 256; i += 17) {
        expect(truncateIp(`186.24.7.${i}`)).toBe('186.24.7.0/24');
      }
    });

    it('cumple el CHECK de refresh_sessions."ipPrefix"', () => {
      const check =
        /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.0\/24$|^[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}::\/48$/;
      for (const ip of ['190.202.15.37', '2800:a4:1f0e::9', '::1']) {
        expect(truncateIp(ip)).toMatch(check);
      }
    });
  });

  describe('deviceFingerprint', () => {
    const label = trustedDeviceLabel(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    );

    it('resume el user-agent a navegador y sistema', () => {
      expect(label).toBe('Chrome en Windows');
    });

    it('es estable: mismo usuario, navegador y red → misma huella', () => {
      expect(deviceFingerprint('u1', label, '190.202.15.0/24')).toBe(
        deviceFingerprint('u1', label, '190.202.15.0/24'),
      );
    });

    it('cambia con el usuario, el navegador o la red', () => {
      const base = deviceFingerprint('u1', label, '190.202.15.0/24');
      expect(deviceFingerprint('u2', label, '190.202.15.0/24')).not.toBe(base);
      expect(
        deviceFingerprint('u1', 'Safari en iOS', '190.202.15.0/24'),
      ).not.toBe(base);
      expect(deviceFingerprint('u1', label, '200.44.32.0/24')).not.toBe(base);
      expect(deviceFingerprint('u1', label, null)).not.toBe(base);
    });

    it('es un SHA-256 en hex (cabe en el CHECK) y no deja leer la red', () => {
      const fp = deviceFingerprint('u1', label, '190.202.15.0/24');
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
      expect(fp).not.toContain('190');
    });
  });

  describe('regla de los 90 días', () => {
    const now = new Date('2026-11-18T12:00:00Z');
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

    it('huella nunca vista y el usuario ya tiene otros dispositivos → avisa', () => {
      expect(
        shouldNotifyNewDevice({
          lastSeenAt: null,
          hasOtherKnownDevices: true,
          now,
        }),
      ).toBe(true);
    });

    it('vista hace 89 días → no avisa; hace 91 → avisa', () => {
      expect(
        shouldNotifyNewDevice({
          lastSeenAt: daysAgo(89),
          hasOtherKnownDevices: true,
          now,
        }),
      ).toBe(false);
      expect(
        shouldNotifyNewDevice({
          lastSeenAt: daysAgo(91),
          hasOtherKnownDevices: true,
          now,
        }),
      ).toBe(true);
    });

    it('justo en el límite de 90 días aún es conocida', () => {
      expect(
        shouldNotifyNewDevice({
          lastSeenAt: new Date(now.getTime() - KNOWN_DEVICE_WINDOW_MS),
          hasOtherKnownDevices: true,
          now,
        }),
      ).toBe(false);
    });

    it('primer dispositivo del usuario (sin ninguno conocido) → se aprende sin aviso', () => {
      expect(
        shouldNotifyNewDevice({
          lastSeenAt: null,
          hasOtherKnownDevices: false,
          now,
        }),
      ).toBe(false);
    });
  });

  describe('cierre por inactividad', () => {
    const now = new Date('2026-11-18T12:00:00Z');
    const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

    it('cuenta los minutos de la clínica más un TTL de access', () => {
      const base = { now, idleMinutes: 15, accessTtlMs: 15 * 60_000 };
      expect(isSessionIdle({ ...base, lastActivityAt: minutesAgo(29) })).toBe(
        false,
      );
      expect(isSessionIdle({ ...base, lastActivityAt: minutesAgo(31) })).toBe(
        true,
      );
    });

    it('el refresh de una familia inactiva da `idle` (antes que rotar)', () => {
      const state = {
        currentJti: 'j1',
        previousJti: null,
        rotatedAt: null,
        expiresAt: new Date(now.getTime() + 86_400_000),
        revokedAt: null,
        lastActivityAt: minutesAgo(120),
      };
      expect(
        decideRefreshRotation(state, 'j1', now, 30_000, {
          idleMinutes: 60,
          accessTtlMs: 900_000,
        }),
      ).toBe('idle');
      expect(
        decideRefreshRotation(state, 'j1', now, 30_000, {
          idleMinutes: 240,
          accessTtlMs: 900_000,
        }),
      ).toBe('rotate');
      // Sin política (plataforma), como siempre.
      expect(decideRefreshRotation(state, 'j1', now, 30_000)).toBe('rotate');
    });

    it('una familia revocada sigue siendo `revoked`', () => {
      expect(
        decideRefreshRotation(
          {
            currentJti: 'j1',
            previousJti: null,
            rotatedAt: null,
            expiresAt: now,
            revokedAt: now,
            lastActivityAt: minutesAgo(500),
          },
          'j1',
          now,
          30_000,
          { idleMinutes: 15, accessTtlMs: 900_000 },
        ),
      ).toBe('revoked');
    });

    it.each([
      [15, true],
      [60, true],
      [240, true],
      [14, false],
      [241, false],
      [30.5, false],
    ])('%p minutos válidos: %p', (minutes, valid) => {
      expect(isValidSessionIdleMinutes(minutes)).toBe(valid);
    });

    it.each([
      ['900s', 900_000],
      ['15m', 900_000],
      ['900', 900_000],
      ['1h', 3_600_000],
      ['raro', 900_000],
      [undefined, 900_000],
    ])('JWT_ACCESS_TTL %p → %p ms', (raw, ms) => {
      expect(parseDurationMs(raw)).toBe(ms);
    });
  });
});
