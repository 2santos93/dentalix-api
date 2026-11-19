import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * DX-582: todo evento nuevo de `audit_events` guarda la IP TRUNCADA y el
 * navegador RESUMIDO (como las sesiones de DX-137). Eso se hace en un único
 * punto, `writeAuditEvent` (prisma-audit-event.repository.ts): el interceptor
 * @Audit, RecordAuditEventUseCase, el login y los casos de uso que auditan en
 * su transacción pasan por él.
 *
 * Esta guarda recorre `src/` y falla si otro fichero de producción INSERTA en
 * `audit_events` sin pasar por ahí: Prisma `.auditEvent.create|createMany|
 * createManyAndReturn|upsert|update|updateMany`, una creación anidada
 * (`auditEvents: { create… }`) o SQL `INSERT INTO [public.]["]audit_events["]`.
 * Un escritor nuevo tiene que llamar a `writeAuditEvent` (o a
 * RecordAuditEventUseCase), no escribir la fila a mano.
 *
 * Límite: es textual. Los triggers y funciones SQL viven en las migraciones
 * (prisma/migrations), no en src; a fecha de DX-582 ninguna función de la BD
 * inserta en `audit_events` (solo la copia única de DX-102, sin IP nueva).
 */
const SRC = join(__dirname, '..');

const WRITES = new RegExp(
  [
    String.raw`\.auditEvent\.(?:create|createMany|createManyAndReturn|upsert|update|updateMany)\s*\(`,
    String.raw`\bauditEvents?\s*:\s*\{\s*(?:create|createMany|connectOrCreate|upsert)\b`,
    String.raw`INSERT\s+INTO\s+(?:public\.)?"?audit_events"?(?![\w"])`,
  ].join('|'),
  'gi',
);

/** El único escritor admitido (con una sola escritura). */
const SINGLE_POINT =
  'modules/audit/infrastructure/prisma-audit-event.repository.ts';

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

const isProduction = (file: string): boolean =>
  !file.endsWith('.spec.ts') && !file.split(sep).includes('__fixtures__');

const rel = (file: string) => relative(SRC, file).split(sep).join('/');

describe('escritores de audit_events: un único punto (DX-582)', () => {
  const writers = tsFiles(SRC)
    .filter(isProduction)
    .map((file) => ({
      file: rel(file),
      writes: [...readFileSync(file, 'utf8').matchAll(WRITES)].length,
    }))
    .filter((w) => w.writes > 0);

  it('solo writeAuditEvent inserta en audit_events (ahí se trunca la IP y se resume el user-agent)', () => {
    expect(writers).toEqual([{ file: SINGLE_POINT, writes: 1 }]);
  });

  it('writeAuditEvent aplica la IP truncada y el navegador resumido', () => {
    const source = readFileSync(join(SRC, SINGLE_POINT), 'utf8');
    expect(source).toMatch(/ip:\s*auditIp\(draft\.ip\)/);
    expect(source).toMatch(/auditUserAgent\(draft\.userAgent\)/);
  });
});
