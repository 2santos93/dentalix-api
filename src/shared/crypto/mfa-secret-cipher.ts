import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { ConfigService } from '@nestjs/config';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

export const MFA_SECRET_CIPHER = Symbol('MFA_SECRET_CIPHER');

/**
 * Cifrado en reposo de los secretos TOTP del MFA de plataforma (SEC-008):
 * AES-256-GCM con una clave derivada (HKDF) de MFA_ENCRYPTION_KEY.
 *
 * El id del usuario va como dato autenticado (AAD): copiar el secreto
 * cifrado de un usuario a la fila de otro no descifra, así que quien pueda
 * escribir en `users` no puede "prestarse" el MFA de otro superadmin.
 *
 * Formato (texto, cabe en una columna TEXT): `v1.<base64url(iv|tag|cifrado)>`.
 */
export class MfaSecretCipher {
  private readonly key: Buffer;
  /** DX-021: clave (distinta, misma maestra) del HMAC de los códigos de recuperación. */
  private readonly recoveryKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new Error('MFA_ENCRYPTION_KEY debe tener 32 bytes');
    }
    this.key = Buffer.from(
      hkdfSync(
        'sha256',
        masterKey,
        Buffer.alloc(0),
        'dentalix-platform-mfa-totp',
        32,
      ),
    );
    this.recoveryKey = Buffer.from(
      hkdfSync(
        'sha256',
        masterKey,
        Buffer.alloc(0),
        'dentalix-mfa-recovery-codes',
        32,
      ),
    );
  }

  /**
   * DX-021: huella de un código de recuperación YA normalizado: HMAC-SHA-256
   * (hex) con una clave derivada de MFA_ENCRYPTION_KEY y ligado al usuario.
   * Los códigos tienen 80 bits de azar, así que no hace falta un hash lento;
   * con la clave fuera de la BD, una copia de la tabla no permite probarlos.
   */
  hashRecoveryCode(code: string, userId: string): string {
    return createHmac('sha256', this.recoveryKey)
      .update(`${userId}:${code}`, 'utf8')
      .digest('hex');
  }

  encrypt(secret: string, userId: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(userId, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(secret, 'utf8'),
      cipher.final(),
    ]);
    const blob = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    return `${VERSION}.${blob.toString('base64url')}`;
  }

  /** Lanza si no es de esta clave, de este usuario o fue alterado. */
  decrypt(stored: string, userId: string): string {
    const [version, payload, ...rest] = stored.split('.');
    if (version !== VERSION || !payload || rest.length > 0) {
      throw new Error('secreto MFA con formato desconocido');
    }
    const blob = Buffer.from(payload, 'base64url');
    if (blob.length <= IV_BYTES + TAG_BYTES) {
      throw new Error('secreto MFA truncado');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      blob.subarray(0, IV_BYTES),
    );
    decipher.setAAD(Buffer.from(userId, 'utf8'));
    decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  }
}

/**
 * MFA_ENCRYPTION_KEY: 32 bytes en hex (64 caracteres) o base64. `null` si
 * falta o no es válida (la validación del arranque ya lo reporta).
 */
export function parseMfaEncryptionKey(raw: string | undefined): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/]{42,43}={0,2}$/.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === 32 ? decoded : null;
  }
  return null;
}

/**
 * Clave maestra del cifrado del MFA. En producción MFA_ENCRYPTION_KEY es
 * obligatoria (la validación del arranque no deja arrancar sin ella). Fuera
 * de producción, si falta, se deriva de JWT_ACCESS_SECRET (ya validado: 32+
 * caracteres) para que el MFA enrolado en desarrollo o en los tests
 * sobreviva a los reinicios sin pedir otra variable.
 */
export function loadMfaMasterKey(
  get: (key: string) => string | undefined,
): Buffer {
  const configured = parseMfaEncryptionKey(get('MFA_ENCRYPTION_KEY'));
  if (configured) return configured;
  if (get('NODE_ENV') === 'production') {
    throw new Error('MFA_ENCRYPTION_KEY es obligatoria en producción');
  }
  const jwtSecret = get('JWT_ACCESS_SECRET');
  if (!jwtSecret) throw new Error('Falta JWT_ACCESS_SECRET');
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(jwtSecret, 'utf8'),
      Buffer.alloc(0),
      'dentalix-platform-mfa-dev-fallback',
      32,
    ),
  );
}

/** Provider de Nest para inyectar el cifrado con `@Inject(MFA_SECRET_CIPHER)`. */
export const mfaSecretCipherProvider = {
  provide: MFA_SECRET_CIPHER,
  inject: [ConfigService],
  useFactory: (config: ConfigService): MfaSecretCipher =>
    new MfaSecretCipher(loadMfaMasterKey((key) => config.get<string>(key))),
};
