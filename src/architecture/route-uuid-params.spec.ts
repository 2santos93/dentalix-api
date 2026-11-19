import { ParseUUIDPipe, PipeTransform, Type } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import {
  collectControllers,
  DiscoveredRoute,
  discoverRoutes,
} from '../../test/support/route-discovery';
import { AppModule } from '../app.module';

// Mismo motivo que en auth-matrix.spec.ts: el ConfigModule real valida el
// entorno al importarse y el job `checks` no lo tiene.
jest.mock('../config/config.module', () => ({
  ConfigModule: class ConfigModule {},
}));

/**
 * DX-111 (BE-019): todo parámetro de ruta que es un id (`:id`, `:patientId`,
 * `:itemId`…) lo lee su handler con `@Param('…', ParseUUIDPipe)`. Un id que no
 * es UUID responde 400 en la propia ruta, sin llegar a Prisma (que lo
 * convertiría en P2023/22P02). Y un `:id` que el handler no lee (BE-007:
 * `/treatment-plans/:id/items/:itemId` solo leía `itemId`) también falla: la
 * ruta promete un recurso padre que nadie comprueba.
 *
 * Exentos: los handlers que responden SIEMPRE 405 (`@HttpCode(405)`, p. ej.
 * «la evolución no se edita»), que no leen nada de la ruta.
 *
 * Los parámetros que no son ids (tokens públicos, nombres de fichero, FDI…)
 * van en NON_ID_PARAMS; uno nuevo obliga a decidir aquí qué es.
 */
const NON_ID_PARAMS = new Set([
  'token', // enlaces públicos: los valida su caso de uso (hash del token)
  'name', // ficheros servidos por la API local
  'fdi', // número de diente FDI
  'kind', // tipo de recall
  'slug', // subdominio
  'code', // código de verificación de receta
  'key', // DX-565: clave del catálogo de mensajes (la valida su caso de uso)
  'channel', // DX-565: canal de un mensaje (EMAIL | WHATSAPP)
  'language', // DX-565: idioma de un mensaje (es | en)
]);

interface ParamArg {
  index: number;
  data?: unknown;
  pipes?: (Type<PipeTransform> | PipeTransform)[];
}

function isUuidPipe(pipe: Type<PipeTransform> | PipeTransform): boolean {
  return (
    pipe === ParseUUIDPipe ||
    pipe instanceof ParseUUIDPipe ||
    (typeof pipe === 'function' && pipe.prototype instanceof ParseUUIDPipe)
  );
}

function paramArgs(route: DiscoveredRoute): ParamArg[] {
  const meta = (Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    route.controllerClass,
    route.handler,
  ) ?? {}) as Record<string, ParamArg>;
  return Object.entries(meta)
    .filter(([key]) => key.split(':')[0] === String(RouteParamtypes.PARAM))
    .map(([, arg]) => arg);
}

function uuidParamProblems(routes: DiscoveredRoute[]): string[] {
  const problems: string[] = [];
  for (const route of routes) {
    const proto = route.controllerClass.prototype as Record<string, object>;
    const httpCode = Reflect.getMetadata(
      HTTP_CODE_METADATA,
      proto[route.handler],
    ) as number | undefined;
    if (httpCode === 405) continue;
    const names = [...route.key.matchAll(/:(\w+)/g)].map((m) => m[1]);
    const args = paramArgs(route);
    if (args.some((a) => a.data === undefined)) {
      problems.push(`${route.key}: @Param() sin nombre (no se puede validar)`);
    }
    for (const name of names) {
      if (NON_ID_PARAMS.has(name)) continue;
      if (!/^id$|Id$/.test(name)) {
        problems.push(
          `${route.key}: :${name} no es un id ni está en NON_ID_PARAMS`,
        );
        continue;
      }
      const arg = args.find((a) => a.data === name);
      if (!arg) {
        problems.push(`${route.key}: :${name} no lo lee el handler`);
      } else if (!(arg.pipes ?? []).some(isUuidPipe)) {
        problems.push(`${route.key}: :${name} sin ParseUUIDPipe`);
      }
    }
  }
  return problems;
}

describe('Parámetros de id en las rutas (DX-111, BE-019)', () => {
  const routes = discoverRoutes(collectControllers(AppModule));

  it('recorre las rutas de verdad', () => {
    expect(routes.length).toBeGreaterThan(300);
    expect(routes.filter((r) => r.key.includes(':id')).length).toBeGreaterThan(
      100,
    );
  });

  it('detecta una ruta sin pipe y un :id que el handler no lee', () => {
    const fake = routes.find(
      (r) => r.key === 'PATCH /treatment-plans/:id/items/:itemId',
    );
    expect(fake).toBeDefined();
    const original = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      fake!.controllerClass,
      fake!.handler,
    ) as Record<string, { data?: unknown; pipes?: unknown[] }>;
    const stripped = Object.fromEntries(
      Object.entries(original)
        .filter(([, a]) => a.data !== 'id')
        .map(([k, a]) => [k, a.data === 'itemId' ? { ...a, pipes: [] } : a]),
    );
    class Probe {}
    Object.defineProperty(Probe.prototype, fake!.handler, {
      value: () => undefined,
    });
    Reflect.defineMetadata(ROUTE_ARGS_METADATA, stripped, Probe, fake!.handler);
    expect(uuidParamProblems([{ ...fake!, controllerClass: Probe }])).toEqual([
      'PATCH /treatment-plans/:id/items/:itemId: :id no lo lee el handler',
      'PATCH /treatment-plans/:id/items/:itemId: :itemId sin ParseUUIDPipe',
    ]);
  });

  it('cada :id / :xxxId lo lee su handler con ParseUUIDPipe', () => {
    expect(uuidParamProblems(routes)).toEqual([]);
  });
});
