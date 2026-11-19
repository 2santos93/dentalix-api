import {
  TRUSTED_DEVICE_LABELS,
  UNKNOWN_DEVICE_LABEL,
  trustedDeviceLabel,
} from '../../auth/domain/user-mfa';
import { truncateIp } from '../../auth/domain/user-sessions';
import { auditIp, auditUserAgent } from './audit-network';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

describe('auditIp (DX-582: la IP del evento, como DX-137)', () => {
  it.each([
    ['190.202.15.77', '190.202.15.0/24'],
    ['::ffff:190.202.15.77', '190.202.15.0/24'],
    ['2800:a4:1f:9c::1', '2800:a4:1f::/48'],
    ['  10.0.0.1 ', '10.0.0.0/24'],
  ])('%s → %s', (ip, expected) => {
    expect(auditIp(ip)).toBe(expected);
  });

  it('es la MISMA truncación que las sesiones (truncateIp)', () => {
    for (const ip of ['203.0.113.72', '2001:db8:85a3::8a2e:370:7334']) {
      expect(auditIp(ip)).toBe(truncateIp(ip));
    }
  });

  it('idempotente: lo ya truncado (sesiones de DX-137) llega igual', () => {
    for (const ip of ['127.0.0.1', '190.202.15.77', '2800:a4:1f:9c::1']) {
      const once = auditIp(ip);
      expect(auditIp(once)).toBe(once);
    }
  });

  it('nunca guarda lo que no entiende: ni basura ni un prefijo inventado', () => {
    for (const ip of [
      'no-es-una-ip',
      'int',
      '190.202.15.77/24',
      '190.202.15.0/8',
      '190.202.15.0/32',
      '/24',
    ]) {
      expect(auditIp(ip)).toBeNull();
    }
  });

  it('sin IP: null', () => {
    expect(auditIp(null)).toBeNull();
    expect(auditIp(undefined)).toBeNull();
    expect(auditIp('')).toBeNull();
  });
});

describe('auditUserAgent (DX-582: el navegador del evento, como DX-137)', () => {
  it('resume con trustedDeviceLabel', () => {
    expect(auditUserAgent(CHROME_MAC)).toBe('Chrome en macOS');
    expect(auditUserAgent(SAFARI_IPHONE)).toBe('Safari en iOS');
    expect(auditUserAgent('dx009-e2e-agent')).toBe(UNKNOWN_DEVICE_LABEL);
  });

  it('nunca deja pasar el user-agent en bruto, por largo que sea', () => {
    const raw = `${CHROME_MAC} ${'x'.repeat(5000)}`;
    expect(auditUserAgent(raw)).toBe('Chrome en macOS');
  });

  it('idempotente: una etiqueta ya resumida llega igual (no como desconocido)', () => {
    for (const label of TRUSTED_DEVICE_LABELS) {
      expect(auditUserAgent(label)).toBe(label);
    }
  });

  it('sin cabecera: null (no «Dispositivo desconocido»)', () => {
    expect(auditUserAgent(null)).toBeNull();
    expect(auditUserAgent(undefined)).toBeNull();
    expect(auditUserAgent('')).toBeNull();
  });

  it('la lista cerrada de etiquetas es exactamente lo que trustedDeviceLabel puede dar', () => {
    const browsers = {
      Edge: 'Chrome/130.0 Safari/537.36 Edg/130.0',
      Firefox: 'Gecko/20100101 Firefox/131.0',
      Chrome: 'Chrome/130.0.0.0 Safari/537.36',
      Safari: 'Version/17.5 Safari/605.1.15',
      '': '',
    };
    const systems = {
      iOS: '(iPhone; CPU iPhone OS 17_5 like Mac OS X)',
      Android: '(Linux; Android 14; Pixel 8)',
      macOS: '(Macintosh; Intel Mac OS X 10_15_7)',
      Windows: '(Windows NT 10.0; Win64; x64)',
      Linux: '(X11; Linux x86_64)',
      '': '',
    };
    const produced = new Set<string>();
    for (const b of Object.values(browsers)) {
      for (const s of Object.values(systems)) {
        produced.add(trustedDeviceLabel(`Mozilla/5.0 ${s} ${b}`));
      }
    }
    expect([...produced].sort()).toEqual([...TRUSTED_DEVICE_LABELS].sort());
  });
});
