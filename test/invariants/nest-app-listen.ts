import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// DX-357 (seguimiento de DX-348): cada app HTTP de Nest que crea una prueba
// tiene que escuchar en 127.0.0.1 (`listen(0, '127.0.0.1')`) antes de que
// supertest le hable. Sin ese listen, `request(app.getHttpServer())` abre un
// puerto efímero en `::` y llama a 127.0.0.1; en macOS ese puerto puede ser
// de otro proceso y la prueba recibe «socket hang up» o un 401/403/404 que no
// viene de la API. DX-348 lo arregló por convención; esto lo convierte en
// regla. Lo usa `nest-app-listen.spec.ts`; va aparte para poder probarlo con
// fuentes sueltas (la prueba de mutación de la guarda).

export interface SourceFile {
  path: string;
  source: string;
}

export interface UnlistenedApp {
  path: string;
  line: number;
  /** Variable que recibe la app, o `null` si no se asigna a ninguna. */
  app: string | null;
  reason: 'sin-listen' | 'listen-sin-127' | 'sin-variable';
}

/**
 * Dónde se crean apps de prueba: todo `test/` (specs y fábricas de
 * `test/support/`) y los `*.spec.ts` de `src/`. `test/invariants/` queda
 * fuera: son analizadores estáticos y sus fuentes de ejemplo (strings con
 * `createNestApplication`) no son apps.
 */
export function isScanned(path: string): boolean {
  if (!path.endsWith('.ts') || path.endsWith('.d.ts')) return false;
  if (path.startsWith('test/')) return !path.startsWith('test/invariants/');
  return path.startsWith('src/') && path.endsWith('.spec.ts');
}

export function readScannedSources(repoRoot: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const path = relative(repoRoot, full).split(sep).join('/');
      if (isScanned(path)) {
        out.push({ path, source: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(join(repoRoot, 'test'));
  walk(join(repoRoot, 'src'));
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * El código sin comentarios (un `listen` en prosa no cuenta), con el mismo
 * número de líneas para poder dar la línea del hallazgo. Respeta `://` de
 * las URL.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// Una app HTTP de Nest: `moduleRef.createNestApplication(...)` (con o sin
// genéricos) o `NestFactory.create(...)`. No `createNestMicroservice` ni
// `createApplicationContext`, que no abren HTTP.
const CREATE_APP = /\bcreateNestApplication\b|\bNestFactory\.create\b(?!\w)/g;
// La variable que la recibe, en la misma sentencia:
// `app = …`, `const docsApp: INestApplication = …`, `this.app = …`.
const ASSIGNED_TO =
  /(?:^|[^\w.$])((?:this\.)?[A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:await\s+)?[^;=]*$/;

function escape(name: string): string {
  return name.replace(/[.$]/g, '\\$&');
}

function lineOf(body: string, index: number): number {
  return body.slice(0, index).split('\n').length;
}

/**
 * Apps de Nest creadas en pruebas que no escuchan en 127.0.0.1:
 * - `sin-listen`: la variable que recibe la app nunca hace
 *   `<app>.listen(0, '127.0.0.1')` ni pasa por `listenOnEphemeralPort(<app>`
 *   (`test/support/listening-app.ts`, que escucha igual).
 * - `listen-sin-127`: la app llama a `listen` con otro host o sin host
 *   (`app.listen(0)` escucha en `::`, el mismo choque).
 * - `sin-variable`: la app no se asigna a una variable (p. ej.
 *   `return moduleRef.createNestApplication()`), así que no se puede seguir;
 *   asígnala y escucha antes de devolverla, como `createE2eApp`.
 */
export function findUnlistenedApps(files: SourceFile[]): UnlistenedApp[] {
  const found: UnlistenedApp[] = [];
  for (const file of files) {
    if (!isScanned(file.path)) continue;
    const body = code(file.source);
    for (const m of body.matchAll(CREATE_APP)) {
      const index = m.index ?? 0;
      const line = lineOf(body, index);
      const statementStart = Math.max(
        body.lastIndexOf(';', index),
        body.lastIndexOf('{', index),
        body.lastIndexOf('}', index),
      );
      const before = body.slice(statementStart + 1, index);
      const app = ASSIGNED_TO.exec(before)?.[1] ?? null;
      if (!app) {
        found.push({ path: file.path, line, app, reason: 'sin-variable' });
        continue;
      }
      const name = escape(app);
      const listens = new RegExp(
        `\\b${name}\\.listen\\(\\s*0\\s*,\\s*(['"])127\\.0\\.0\\.1\\1\\s*\\)` +
          `|\\blistenOnEphemeralPort\\(\\s*${name}\\b`,
      );
      const anyListen = new RegExp(`\\b${name}\\.listen\\(([^)]*)\\)`, 'g');
      const wrongHost = [...body.matchAll(anyListen)].find(
        ([, args]) => !/^\s*0\s*,\s*(['"])127\.0\.0\.1\1\s*$/.test(args),
      );
      if (wrongHost) {
        found.push({
          path: file.path,
          line: lineOf(body, wrongHost.index ?? 0),
          app,
          reason: 'listen-sin-127',
        });
      } else if (!listens.test(body)) {
        found.push({ path: file.path, line, app, reason: 'sin-listen' });
      }
    }
  }
  return found;
}
