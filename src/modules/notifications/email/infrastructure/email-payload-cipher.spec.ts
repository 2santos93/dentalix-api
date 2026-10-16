import { randomBytes } from 'node:crypto';
import {
  EmailPayloadCipher,
  parseMailEncryptionKey,
} from './email-payload-cipher';

const message = {
  to: 'ana.perez@clinica.co',
  subject: 'Te invitaron',
  html: '<p>https://demo.dentalix.app/invitacion/SECRET-TOKEN</p>',
  text: 'https://demo.dentalix.app/invitacion/SECRET-TOKEN',
};

describe('EmailPayloadCipher', () => {
  const cipher = new EmailPayloadCipher(randomBytes(32));

  it('ida y vuelta, y el cifrado no contiene el email ni el token', () => {
    const payload = cipher.encrypt(message);
    expect(payload.toString('latin1')).not.toContain('ana.perez');
    expect(payload.toString('latin1')).not.toContain('SECRET-TOKEN');
    expect(cipher.decrypt(payload)).toEqual(message);
  });

  it('iv aleatorio: dos cifrados del mismo mensaje difieren', () => {
    expect(cipher.encrypt(message).equals(cipher.encrypt(message))).toBe(false);
  });

  it('rechaza un payload alterado o de otra clave', () => {
    const payload = cipher.encrypt(message);
    payload[payload.length - 1] ^= 0xff;
    expect(() => cipher.decrypt(payload)).toThrow();
    const other = new EmailPayloadCipher(randomBytes(32));
    expect(() => other.decrypt(cipher.encrypt(message))).toThrow();
    expect(() => cipher.decrypt(Buffer.alloc(10))).toThrow('truncado');
  });

  it('hash del destinatario estable, normalizado y no reversible a simple vista', () => {
    const h = cipher.hashRecipient(' Ana.Perez@Clinica.co ');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(cipher.hashRecipient('ana.perez@clinica.co'));
    expect(h).not.toBe(
      new EmailPayloadCipher(randomBytes(32)).hashRecipient(
        'ana.perez@clinica.co',
      ),
    );
  });

  it('exige una clave de 32 bytes', () => {
    expect(() => new EmailPayloadCipher(randomBytes(16))).toThrow('32 bytes');
  });
});

describe('parseMailEncryptionKey', () => {
  it('acepta hex de 64 y base64 de 32 bytes', () => {
    const key = randomBytes(32);
    expect(parseMailEncryptionKey(key.toString('hex'))?.equals(key)).toBe(true);
    expect(parseMailEncryptionKey(key.toString('base64'))?.equals(key)).toBe(
      true,
    );
  });

  it('rechaza vacío, corto o con otro formato', () => {
    expect(parseMailEncryptionKey(undefined)).toBeNull();
    expect(parseMailEncryptionKey('')).toBeNull();
    expect(parseMailEncryptionKey('abc')).toBeNull();
    expect(
      parseMailEncryptionKey(randomBytes(16).toString('base64')),
    ).toBeNull();
    expect(parseMailEncryptionKey('z'.repeat(64))).toBeNull();
  });
});
