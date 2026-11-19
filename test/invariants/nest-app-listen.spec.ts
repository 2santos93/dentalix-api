import { join } from 'node:path';
import {
  findUnlistenedApps,
  isScanned,
  readScannedSources,
} from './nest-app-listen';

// DX-357 (seguimiento de DX-348, M1 de su revisión): toda app HTTP de Nest
// creada en una prueba escucha en 127.0.0.1 antes de que supertest le hable.
// `request(app.getHttpServer())` con la app sin escuchar abre un puerto
// efímero en `::` y llama a 127.0.0.1; en macOS ese puerto puede ser de otro
// proceso: «socket hang up» o 401/403/404 que no vienen de la API. DX-348
// añadió el listen a mano; después entraron seis apps sin él (anamnesis,
// cancelaciones, backfill de imputaciones, país de la sede, acceso del
// paciente, disponibilidad del subdominio), que DX-357 corrigió. Sin lista
// heredada: una spec o fábrica nueva escucha con `listen(0, '127.0.0.1')`,
// pasa por `createE2eApp` / las fábricas de `test/support/`, o usa
// `listenOnEphemeralPort`.

const REPO_ROOT = join(__dirname, '..', '..');

describe('DX-357: las apps de Nest de las pruebas escuchan en 127.0.0.1', () => {
  it('ninguna prueba crea una app sin listen(0, "127.0.0.1")', () => {
    const sources = readScannedSources(REPO_ROOT);
    // El recorrido ve las fábricas y las specs que hoy crean apps; si se
    // queda vacío, la guarda pasaría sin mirar nada.
    const creators = sources.filter((s) =>
      /\bcreateNestApplication\b/.test(s.source),
    );
    expect(creators.map((s) => s.path)).toEqual(
      expect.arrayContaining([
        'test/support/create-e2e-app.ts',
        'test/support/e2e-fixtures.ts',
        'test/patients.e2e-spec.ts',
        'src/shared/storage/upload-slots.http.spec.ts',
      ]),
    );
    expect(findUnlistenedApps(sources)).toEqual([]);
  });

  it('isScanned: test/ entero (también support) y los *.spec.ts de src, no los invariantes', () => {
    expect(isScanned('test/patients.e2e-spec.ts')).toBe(true);
    expect(isScanned('test/support/create-e2e-app.ts')).toBe(true);
    expect(isScanned('test/storage/files.e2e-spec.ts')).toBe(true);
    expect(isScanned('src/shared/storage/upload-slots.http.spec.ts')).toBe(
      true,
    );
    expect(isScanned('src/main.ts')).toBe(false);
    expect(isScanned('test/invariants/nest-app-listen.spec.ts')).toBe(false);
  });

  describe('prueba de mutación: detecta la app sin listen', () => {
    const beforeAllWith = (...lines: string[]) =>
      [
        'beforeAll(async () => {',
        '  const moduleRef = await Test.createTestingModule({',
        '    imports: [AppModule],',
        '  }).compile();',
        ...lines.map((l) => `  ${l}`),
        '});',
        "it('responde', () => request(app.getHttpServer()).get('/').expect(200));",
      ].join('\n');

    it('una spec que solo hace init() y luego supertest', () => {
      expect(
        findUnlistenedApps([
          {
            path: 'test/nueva.e2e-spec.ts',
            source: beforeAllWith(
              'app = moduleRef.createNestApplication();',
              "app.setGlobalPrefix('api/v1');",
              'await app.init();',
            ),
          },
        ]),
      ).toEqual([
        {
          path: 'test/nueva.e2e-spec.ts',
          line: 5,
          app: 'app',
          reason: 'sin-listen',
        },
      ]);
    });

    it('el listen en un comentario no cuenta', () => {
      const found = findUnlistenedApps([
        {
          path: 'test/comentada.int-spec.ts',
          source: beforeAllWith(
            'app = moduleRef.createNestApplication();',
            'await app.init();',
            "// await app.listen(0, '127.0.0.1');",
            "/* await app.listen(0, '127.0.0.1'); */",
          ),
        },
      ]);
      expect(found.map((f) => f.reason)).toEqual(['sin-listen']);
    });

    it('listen sin host o con otro host', () => {
      const found = findUnlistenedApps([
        {
          path: 'test/sin-host.e2e-spec.ts',
          source: beforeAllWith(
            'app = moduleRef.createNestApplication();',
            'await app.listen(0);',
          ),
        },
        {
          path: 'test/todas.e2e-spec.ts',
          source: beforeAllWith(
            'app = moduleRef.createNestApplication();',
            "await app.listen(0, '0.0.0.0');",
          ),
        },
        {
          path: 'test/las-dos.e2e-spec.ts',
          source: beforeAllWith(
            'app = moduleRef.createNestApplication();',
            "await app.listen(0, '127.0.0.1');",
            'await app.listen(3000);',
          ),
        },
      ]);
      expect(found.map((f) => [f.path, f.reason])).toEqual([
        ['test/sin-host.e2e-spec.ts', 'listen-sin-127'],
        ['test/todas.e2e-spec.ts', 'listen-sin-127'],
        ['test/las-dos.e2e-spec.ts', 'listen-sin-127'],
      ]);
    });

    it('la segunda app de la misma spec, aunque la primera escuche', () => {
      // El caso de locations-country.e2e-spec.ts antes de DX-357: la app
      // principal escuchaba y la de /docs-json no.
      const found = findUnlistenedApps([
        {
          path: 'test/dos-apps.e2e-spec.ts',
          source: beforeAllWith(
            'app = moduleRef.createNestApplication();',
            "await app.listen(0, '127.0.0.1');",
            'const docsApp = moduleRef.createNestApplication<INestApplication<App>>();',
            'setupSwagger(docsApp);',
            'await docsApp.init();',
          ),
        },
      ]);
      expect(found).toEqual([
        {
          path: 'test/dos-apps.e2e-spec.ts',
          line: 7,
          app: 'docsApp',
          reason: 'sin-listen',
        },
      ]);
    });

    it('NestFactory.create, una fábrica de support y una app sin variable', () => {
      const found = findUnlistenedApps([
        {
          path: 'test/fabrica.e2e-spec.ts',
          source:
            'const app: INestApplication = await NestFactory.create(AppModule);\nawait app.init();',
        },
        {
          path: 'test/support/otra-fabrica.ts',
          source: [
            'export async function makeApp() {',
            '  const app = moduleRef.createNestApplication();',
            '  await app.init();',
            '  return app;',
            '}',
          ].join('\n'),
        },
        {
          path: 'test/support/anonima.ts',
          source:
            'export const make = () => moduleRef.createNestApplication();',
        },
      ]);
      expect(found.map((f) => [f.path, f.app, f.reason])).toEqual([
        ['test/fabrica.e2e-spec.ts', 'app', 'sin-listen'],
        ['test/support/otra-fabrica.ts', 'app', 'sin-listen'],
        ['test/support/anonima.ts', null, 'sin-variable'],
      ]);
    });

    it('no marca las formas buenas', () => {
      expect(
        findUnlistenedApps([
          {
            path: 'test/buena.e2e-spec.ts',
            source: beforeAllWith(
              'app = moduleRef.createNestApplication<INestApplication<App>>();',
              'await app.init();',
              'await app.listen(0, "127.0.0.1");',
            ),
          },
          {
            path: 'test/efimera.e2e-spec.ts',
            source: beforeAllWith(
              'app = moduleRef.createNestApplication();',
              'await app.init();',
              'http = await listenOnEphemeralPort(app, 20);',
            ),
          },
          {
            path: 'test/this.e2e-spec.ts',
            source: [
              'this.app = moduleRef.createNestApplication();',
              "await this.app.listen(0, '127.0.0.1');",
            ].join('\n'),
          },
          {
            path: 'test/sin-app.e2e-spec.ts',
            source:
              'app = await createE2eApp();\nconst ctx = createNestMicroservice();',
          },
          {
            // Fuera del alcance: código de producción.
            path: 'src/main.ts',
            source:
              'const app = await NestFactory.create(AppModule);\nawait app.listen(3000);',
          },
        ]),
      ).toEqual([]);
    });
  });
});
