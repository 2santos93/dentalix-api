import {
  CanActivate,
  NestInterceptor,
  RequestMethod,
  Type,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ClinicRole } from '@prisma/client';
import { ROLES_KEY } from '../../src/modules/auth/presentation/guards/roles.decorator';

/**
 * Recorrido estático de las rutas de un módulo raíz a partir de los
 * metadatos de Nest (DX-068). Lo comparten la matriz de autorización
 * (`src/auth-matrix.spec.ts`) y la invariante de ids en query y cuerpo
 * (`src/tenant-id-inputs.spec.ts`, DX-207).
 */

export type Guard = Type<CanActivate> | CanActivate;
export type Interceptor = Type<NestInterceptor> | NestInterceptor;
export type Controller = Type<unknown>;
type ModuleRef = Type<unknown> | { module: Type<unknown> } | Promise<unknown>;

export interface DiscoveredRoute {
  /** `MÉTODO /ruta` sin el prefijo global, como en ROUTE_ACCESS. */
  key: string;
  controller: string;
  /** Clase del controlador (para leer los metadatos de sus argumentos). */
  controllerClass: Controller;
  handler: string;
  guards: Guard[];
  interceptors: Interceptor[];
  roles: ClinicRole[] | undefined;
}

const HTTP_METHODS: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

export function metadataList<T>(key: string, target: object): T[] {
  return (Reflect.getMetadata(key, target) as T[] | undefined) ?? [];
}

/** Controladores en el orden en que Nest registra sus rutas. */
export function collectControllers(root: Type<unknown>): Controller[] {
  const seen = new Set<Type<unknown>>();
  const controllers: Controller[] = [];
  const visit = (ref: ModuleRef): void => {
    if (ref instanceof Promise) {
      // Un import asíncrono (p. ej. `forRoot` que devuelve Promise) no se
      // puede inspeccionar en estático: si apareciera, sus controladores
      // quedarían fuera de la matriz sin avisar.
      throw new Error('Import asíncrono de módulo: la matriz no lo recorre');
    }
    const isDynamic = typeof ref === 'object' && 'module' in ref;
    const moduleClass = isDynamic ? ref.module : ref;
    if (seen.has(moduleClass)) return;
    seen.add(moduleClass);
    const dynamicPart = isDynamic
      ? (ref as { imports?: ModuleRef[]; controllers?: Controller[] })
      : {};
    // Mismo orden que DependenciesScanner.scanForModules de Nest: primero el
    // módulo y después sus imports (preorden). Express casa las rutas en el
    // orden en que se registran, así que el orden importa (ver `shadows`).
    controllers.push(
      ...metadataList<Controller>(MODULE_METADATA.CONTROLLERS, moduleClass),
      ...(dynamicPart.controllers ?? []),
    );
    [
      ...metadataList<ModuleRef>(MODULE_METADATA.IMPORTS, moduleClass),
      ...(dynamicPart.imports ?? []),
    ].forEach(visit);
  };
  visit(root);
  return controllers;
}

function pathsOf(target: object): string[] {
  const value = Reflect.getMetadata(PATH_METADATA, target) as
    string | string[] | undefined;
  if (value === undefined) return [''];
  return Array.isArray(value) ? value : [value];
}

function joinPath(...parts: string[]): string {
  const joined = parts
    .flatMap((p) => p.split('/'))
    .filter((segment) => segment.length > 0)
    .join('/');
  return `/${joined}`;
}

/** Rutas de los controladores dados (por defecto, los de un módulo raíz). */
export function discoverRoutes(controllers: Controller[]): DiscoveredRoute[] {
  const reflector = new Reflector();
  const routes: DiscoveredRoute[] = [];
  for (const controller of controllers) {
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const handler = proto[name];
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      if (method === undefined) continue;
      const verb = HTTP_METHODS[method];
      if (!verb) {
        throw new Error(
          `${controller.name}.${name}: método HTTP no previsto en la matriz`,
        );
      }
      const roles = reflector.getAllAndOverride<ClinicRole[] | undefined>(
        ROLES_KEY,
        [handler, controller],
      );
      for (const base of pathsOf(controller)) {
        for (const sub of pathsOf(handler)) {
          routes.push({
            key: `${verb} ${joinPath(base, sub)}`,
            controller: controller.name,
            controllerClass: controller,
            handler: name,
            guards: [
              ...metadataList<Guard>(GUARDS_METADATA, controller),
              ...metadataList<Guard>(GUARDS_METADATA, handler),
            ],
            interceptors: [
              ...metadataList<Interceptor>(INTERCEPTORS_METADATA, controller),
              ...metadataList<Interceptor>(INTERCEPTORS_METADATA, handler),
            ],
            roles,
          });
        }
      }
    }
  }
  return routes;
}
