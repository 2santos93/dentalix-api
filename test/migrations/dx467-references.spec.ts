import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// DX-467: las migraciones del código de verificación se renombraron al
// rebasar sobre DX-547 (20261126… → 20261127…). Todo id de migración que
// citan sus comentarios, el repositorio de recetas y el README tiene que
// existir: un comentario que apunta a una migración que no existe manda a
// quien lee el runbook al sitio equivocado.

const ROOT = join(__dirname, '../..');
const MIGRATIONS = join(ROOT, 'prisma/migrations');
const ids = new Set(
  readdirSync(MIGRATIONS)
    .filter((name) => /^\d{14}_/.test(name))
    .map((name) => name.slice(0, 14)),
);
const dx467 = [...readdirSync(MIGRATIONS)].filter((n) => n.includes('_dx467_'));

const files = [
  ...dx467.map((n) => join(MIGRATIONS, n, 'migration.sql')),
  join(
    ROOT,
    'src/modules/prescriptions/infrastructure/repositories/prisma-prescription.repository.ts',
  ),
  join(ROOT, 'test/prescription-verification.int-spec.ts'),
];

/** Ids de 14 cifras, y los rangos abreviados `<id>…<6 cifras>`. */
function referencedIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(\d{14})(?:…(\d{6}))?/g)) {
    out.push(m[1]);
    if (m[2]) out.push(`${m[1].slice(0, 8)}${m[2]}`);
  }
  return out;
}

describe('DX-467: referencias a migraciones', () => {
  it('son cinco y van después de las de DX-547', () => {
    expect(dx467.map((n) => n.slice(0, 14)).sort()).toEqual([
      '20261127090000',
      '20261127090100',
      '20261127090200',
      '20261127090300',
      '20261127090400',
    ]);
  });

  it.each(files.map((f) => [f.slice(ROOT.length + 1), f]))(
    '%s solo cita migraciones que existen',
    (_name, file) => {
      const text = readFileSync(file, 'utf8');
      const missing = referencedIds(text).filter((id) => !ids.has(id));
      expect(missing).toEqual([]);
    },
  );

  it('el README cita las de DX-467 con su nombre actual', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const section = readme.slice(
      readme.indexOf('## Receta verificable'),
      readme.indexOf('## Anestesia local'),
    );
    expect(referencedIds(section).filter((id) => !ids.has(id))).toEqual([]);
    expect(section).toContain('20261127090000');
  });
});
