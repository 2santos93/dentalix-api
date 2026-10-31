import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
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
const ROOT = join(SRC, '..');
const TESTING = join(SRC, 'shared', 'testing');

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

/**
 * Módulos que `source` (el texto de `file`) carga: `import … from`,
 * `export … from`, `import '…'`, `import(…)` y `require(…)`, resueltos a ruta
 * absoluta. Cubre las relativas (`../testing/…`, sin «shared/» delante) y las
 * de `baseUrl` (`src/shared/testing/…`); los paquetes se quedan como están.
 */
function importedPaths(file: string, source: string): string[] {
  const specifier =
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"`]([^'"`]+)['"`]/g;
  return [...source.matchAll(specifier)].map(([, spec]) => {
    if (spec.startsWith('.')) return resolve(dirname(file), spec);
    if (spec.startsWith('src/')) return resolve(ROOT, spec);
    return spec;
  });
}

const importsTesting = (file: string, source: string): boolean =>
  importedPaths(file, source).some(
    (path) => path === TESTING || path.startsWith(TESTING + sep),
  );

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

    it('the guard detects every way of importing src/shared/testing', () => {
      // Romper la guarda a propósito: si alguna de estas formas dejara de
      // detectarse, el test de abajo daría verde con una fuga real.
      const inCrypto = join(SRC, 'shared', 'crypto', 'password.module.ts');
      const inModule = join(SRC, 'modules', 'auth', 'auth.module.ts');
      const leaks: [string, string][] = [
        [
          inCrypto,
          "import { TestPasswordHasher } from '../testing/test-password-hasher';",
        ],
        [
          inCrypto,
          'import { TestPasswordHasher } from "../testing/test-password-hasher";',
        ],
        [inCrypto, "export * from '../testing/test-password-hasher';"],
        [inCrypto, "import '../testing';"],
        [inCrypto, "const t = require('../testing/test-password-hasher');"],
        [
          inCrypto,
          "const t = await import('../testing/test-password-hasher');",
        ],
        [
          inModule,
          "import {\n  TestPasswordHasher,\n} from '../../shared/testing/test-password-hasher';",
        ],
        [
          inModule,
          "import { TestPasswordHasher } from 'src/shared/testing/test-password-hasher';",
        ],
      ];
      for (const [file, source] of leaks) {
        expect([source, importsTesting(file, source)]).toEqual([source, true]);
      }
      // Y no confunde un vecino de nombre parecido ni un paquete.
      expect(
        importsTesting(inCrypto, "import { x } from '../testing-utils/x';"),
      ).toBe(false);
      expect(
        importsTesting(inCrypto, "import * as argon2 from 'argon2';"),
      ).toBe(false);
    });

    it('no production module imports src/shared/testing', () => {
      const production = files.filter(
        (file) =>
          !file.endsWith('.spec.ts') &&
          !file.split(sep).includes('__fixtures__') &&
          !file.startsWith(TESTING + sep),
      );
      expect(production.length).toBeGreaterThan(100);
      expect(
        production
          .filter((file) => importsTesting(file, readFileSync(file, 'utf8')))
          .map((file) => relative(SRC, file)),
      ).toEqual([]);
    });

    it('only password.service.spec.ts runs argon2 at production cost (new PasswordService)', () => {
      const specs = files.filter(
        (file) => file.endsWith('.spec.ts') && !file.startsWith(TESTING + sep),
      );
      expect(matching(specs, /new PasswordService\(/)).toEqual([
        join('shared', 'crypto', 'password.service.spec.ts'),
      ]);
    });
  });
});
