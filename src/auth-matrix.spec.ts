import { CanActivate, NestInterceptor, Type } from '@nestjs/common';
import {
  ROUTE_ACCESS,
  RouteAccess,
  sortRoles,
} from '../test/support/route-access-matrix';
import {
  collectControllers,
  DiscoveredRoute,
  discoverRoutes,
} from '../test/support/route-discovery';
import { AppModule } from './app.module';
import { JwtAuthGuard } from './modules/auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from './modules/auth/presentation/guards/roles.guard';
import { PlatformAdminGuard } from './modules/platform/presentation/guards/platform-admin.guard';
import { PublicTenantContextInterceptor } from './shared/tenancy/public-tenant-context.interceptor';
import { TenantContextInterceptor } from './shared/tenancy/tenant-context.interceptor';

// El ConfigModule real valida el entorno (secretos JWT, URLs de BD) al
// IMPORTARSE (`NestConfigModule.forRoot` corre al evaluar el decorador), y el
// job `checks` de la CI no tiene entorno. No declara controladores, así que
// sustituirlo por un módulo vacío no quita ninguna ruta del recorrido.
jest.mock('./config/config.module', () => ({
  ConfigModule: class ConfigModule {},
}));

/**
 * DX-068 (TST-001): la autorización de CADA ruta de la API está fijada en
 * `test/support/route-access-matrix.ts`. Este test recorre el árbol de módulos
 * de AppModule, lee los metadatos de Nest (guards, interceptores, `@Roles`) de
 * cada handler y exige que coincidan con la tabla.
 */

function guardIndex(route: DiscoveredRoute, guard: Type<CanActivate>): number {
  return route.guards.findIndex(
    (g) => g === guard || g instanceof (guard as new (...a: never[]) => object),
  );
}

function hasInterceptor(
  route: DiscoveredRoute,
  interceptor: Type<NestInterceptor>,
): boolean {
  return route.interceptors.some(
    (i) =>
      i === interceptor ||
      i instanceof (interceptor as new (...a: never[]) => object),
  );
}

/**
 * Acceso EFECTIVO de una ruta según sus metadatos. Lanza si la combinación es
 * incoherente: esas combinaciones dejan la ruta más abierta de lo que aparenta
 * su código (p. ej. un `@Roles` sin RolesGuard no lo aplica nadie).
 */
function effectiveAccess(route: DiscoveredRoute): RouteAccess {
  const where = `${route.key} (${route.controller}.${route.handler})`;
  const jwt = guardIndex(route, JwtAuthGuard);
  const rolesGuard = guardIndex(route, RolesGuard);
  const platform = guardIndex(route, PlatformAdminGuard);
  const hasRoles = route.roles !== undefined && route.roles.length > 0;
  const tenantScoped = hasInterceptor(route, TenantContextInterceptor);

  if (jwt === -1) {
    if (rolesGuard !== -1 || platform !== -1 || hasRoles) {
      throw new Error(
        `${where}: RolesGuard/PlatformAdminGuard/@Roles sin JwtAuthGuard`,
      );
    }
    if (tenantScoped) {
      throw new Error(
        `${where}: TenantContextInterceptor en una ruta sin sesión`,
      );
    }
    return {
      kind: 'public',
      tenantScoped: hasInterceptor(route, PublicTenantContextInterceptor),
    };
  }
  if (platform !== -1) {
    if (platform < jwt || rolesGuard !== -1 || hasRoles || tenantScoped) {
      throw new Error(
        `${where}: la ruta de plataforma debe llevar solo JwtAuthGuard y luego PlatformAdminGuard`,
      );
    }
    return { kind: 'platform' };
  }
  if (hasRoles !== (rolesGuard !== -1)) {
    throw new Error(
      `${where}: @Roles y RolesGuard deben ir juntos (uno sin el otro no restringe nada)`,
    );
  }
  if (!hasRoles) {
    if (tenantScoped) {
      throw new Error(
        `${where}: ruta de clínica (TenantContextInterceptor) sin @Roles`,
      );
    }
    return { kind: 'authenticated' };
  }
  if (rolesGuard < jwt) {
    throw new Error(
      `${where}: RolesGuard antes que JwtAuthGuard (no hay usuario)`,
    );
  }
  if (!tenantScoped) {
    throw new Error(
      `${where}: @Roles sin TenantContextInterceptor (el token no se ata al host)`,
    );
  }
  return { kind: 'roles', roles: sortRoles(route.roles ?? []) };
}

/** `/a/:x/b` con un segmento fijo `b` lo captura antes `/a/:x` si va antes. */
function shadows(earlier: string, later: string): boolean {
  const [verbA, pathA] = earlier.split(' ');
  const [verbB, pathB] = later.split(' ');
  if (verbA !== verbB) return false;
  const segA = pathA.split('/');
  const segB = pathB.split('/');
  if (segA.length !== segB.length) return false;
  return segA.every(
    (s, i) => s === segB[i] || (s.startsWith(':') && !segB[i].startsWith(':')),
  );
}

describe('Matriz de autorización de AppModule (DX-068, TST-001)', () => {
  const routes = discoverRoutes(collectControllers(AppModule));

  it('recorre los controladores de verdad (no una lista vacía)', () => {
    expect(new Set(routes.map((r) => r.controller)).size).toBeGreaterThan(30);
  });

  it('no declara dos veces el mismo método + ruta', () => {
    const keys = routes.map((r) => r.key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('ninguna ruta queda tapada por otra con parámetro registrada antes', () => {
    const shadowed: string[] = [];
    routes.forEach((later, j) => {
      routes.slice(0, j).forEach((earlier) => {
        if (earlier.key !== later.key && shadows(earlier.key, later.key)) {
          shadowed.push(`${later.key} queda tapada por ${earlier.key}`);
        }
      });
    });
    expect(shadowed).toEqual([]);
  });

  it('cada ruta tiene una entrada en la tabla y ninguna entrada sobra', () => {
    const discovered = routes.map((r) => r.key).sort();
    const expected = Object.keys(ROUTE_ACCESS).sort();
    expect({
      sinEntradaEnLaTabla: discovered.filter((k) => !expected.includes(k)),
      entradaSinRuta: expected.filter((k) => !discovered.includes(k)),
    }).toEqual({ sinEntradaEnLaTabla: [], entradaSinRuta: [] });
  });

  it('el acceso efectivo de cada ruta coincide con la tabla', () => {
    const actual = Object.fromEntries(
      routes.map((r) => [r.key, effectiveAccess(r)]),
    );
    expect(actual).toEqual(ROUTE_ACCESS);
  });
});
