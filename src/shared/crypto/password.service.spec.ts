import * as argon2 from 'argon2';
import { DUMMY_PASSWORD_HASH, PasswordService } from './password.service';

// DX-209 (TST-024): el ÚNICO spec que corre argon2 con el coste de producción
// y que lo fija. El resto de unit usan `TestPasswordHasher`
// (shared/testing/), y test-password-hasher.spec.ts vigila que nadie más
// instancie `PasswordService` en un spec.
describe('PasswordService', () => {
  const svc = new PasswordService();

  it('hashes with the production cost: argon2id v1.3, 64 MiB, t=3, p=4', async () => {
    const hash = await svc.hash('S3cret!');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,p=4,t=3\$/);
  });

  it('hashes and verifies a password', async () => {
    const hash = await svc.hash('S3cret!');
    expect(hash).not.toBe('S3cret!');
    expect(await svc.verify('S3cret!', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await svc.hash('S3cret!');
    expect(await svc.verify('wrong', hash)).toBe(false);
  });
});

describe('DUMMY_PASSWORD_HASH', () => {
  it('is an argon2id hash with the SAME cost parameters as hash() (same verify time)', () => {
    // needsRehash compara m/t/p/versión con las opciones dadas: si alguien
    // sube el coste de hash() sin regenerar el ficticio, este test lo delata.
    expect(DUMMY_PASSWORD_HASH.startsWith('$argon2id$')).toBe(true);
    expect(argon2.needsRehash(DUMMY_PASSWORD_HASH)).toBe(false);
  });

  it('never matches a password', async () => {
    const svc = new PasswordService();
    expect(await svc.verify('', DUMMY_PASSWORD_HASH)).toBe(false);
    expect(await svc.verify('S3cret!', DUMMY_PASSWORD_HASH)).toBe(false);
  });
});
