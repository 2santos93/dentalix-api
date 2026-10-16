import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { OutgoingEmail } from '../domain/email-message';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Cifrado del mensaje pendiente en `email_outbox.payload` (AES-256-GCM) y
 * hash del destinatario (HMAC-SHA256). Las dos claves se derivan con HKDF de
 * MAIL_ENCRYPTION_KEY, así que una no revela la otra.
 *
 * Formato: iv (12) | tag (16) | texto cifrado de `JSON(OutgoingEmail)`.
 */
export class EmailPayloadCipher {
  private readonly encKey: Buffer;
  private readonly hashKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new Error('MAIL_ENCRYPTION_KEY debe tener 32 bytes');
    }
    this.encKey = Buffer.from(
      hkdfSync(
        'sha256',
        masterKey,
        Buffer.alloc(0),
        'dentalix-email-outbox-enc',
        32,
      ),
    );
    this.hashKey = Buffer.from(
      hkdfSync(
        'sha256',
        masterKey,
        Buffer.alloc(0),
        'dentalix-email-outbox-to-hash',
        32,
      ),
    );
  }

  encrypt(message: OutgoingEmail): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const plain = Buffer.from(JSON.stringify(message), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  /** Lanza si el payload no es de esta clave o fue alterado (GCM autentica). */
  decrypt(payload: Buffer): OutgoingEmail {
    if (payload.length <= IV_BYTES + TAG_BYTES) {
      throw new Error('payload de email truncado');
    }
    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([
      decipher.update(payload.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8')) as OutgoingEmail;
  }

  /** HMAC del correo normalizado (minúsculas, sin espacios): 64 hex. */
  hashRecipient(email: string): string {
    return createHmac('sha256', this.hashKey)
      .update(email.trim().toLowerCase())
      .digest('hex');
  }
}

/**
 * MAIL_ENCRYPTION_KEY: 32 bytes en hex (64 caracteres) o en base64. `null` si
 * falta o no es válida (la validación del arranque ya lo reporta).
 */
export function parseMailEncryptionKey(raw: string | undefined): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }
  if (/^[A-Za-z0-9+/]{42,43}={0,2}$/.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === 32 ? decoded : null;
  }
  return null;
}
