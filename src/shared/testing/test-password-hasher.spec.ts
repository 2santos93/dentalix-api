import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as argon2 from 'argon2';
import {
  DUMMY_PASSWORD_HASH,
  PasswordService,
} from '../crypto/password.service';
import {
  TEST_DUMMY_PASSWORD_HASH,
  TestPasswordHasher,
} from './test-password-hasher';

const SRC = join(__dirname, '..', '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** `fichero` (relativo a src/) de cada uno cuyo texto cumple `pattern`. */
const matching = (files: string[], pattern: RegExp): string[] =>
  files
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(SRC, file));

describe('TestPasswordHasher (DX-209)', () => {
  const hasher = new TestPasswordHasher();

  it('hashes with argon2id at the minimum cost, and production verifies it', async () => {
    const hash = await hasher.hash('S3cret!');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=8,p=1,t=1\$/);
    // Mismo formato PHC: el PasswordService de producción lo acepta.
    const production = new PasswordService();
    expect(await production.verify('S3cret!', hash)).toBe(true);
    expect(await production.verify('wrong', hash)).toBe(false);
    expect(await hasher.verify('S3cret!', hash)).toBe(true);
  });

  it('verifies the SEC-017 dummy hash against its cheap twin: never matches', async () => {
    expect(argon2.needsRehash(TEST_DUMMY_PASSWORD_HASH)).toBe(true);
    expect(await hasher.verify('', DUMMY_PASSWORD_HASH)).toBe(false);
    expect(await hasher.verify('S3cret!', DUMMY_PASSWORD_HASH)).toBe(false);
  });

  describe('frontera con producción', () => {
    const files = tsFiles(SRC);
    const testing = join(SRC, 'shared', 'testing') + sep;

    it('no production module imports src/shared/testing', () => {
      const production = files.filter(
        (file) =>
          !file.endsWith('.spec.ts') &&
          !file.split(sep).includes('__fixtures__') &&
          !file.startsWith(testing),
      );
      expect(matching(production, /from '[^']*shared\/testing\//)).toEqual([]);
    });

    it('only password.service.spec.ts runs argon2 at production cost (new PasswordService)', () => {
      const specs = files.filter(
        (file) => file.endsWith('.spec.ts') && !file.startsWith(testing),
      );
      expect(matching(specs, /new PasswordService\(/)).toEqual([
        join('shared', 'crypto', 'password.service.spec.ts'),
      ]);
    });
  });
});
