import { ClinicRole, ExtraPermission } from '@prisma/client';
import {
  EXTRA_PERMISSIONS,
  roleBasePermissions,
} from '../../src/modules/auth/domain/extra-permissions';
import {
  ALL_CLINIC_ROLES,
  ROUTE_ACCESS,
  RouteAccess,
  sortRoles,
} from './route-access-matrix';

/**
 * DX-208: la matriz de autorización (`ROUTE_ACCESS`) en JSON, para que la web
 * compruebe que su menú, la paleta ⌘K, el índice de Ajustes y las pestañas de
 * Reportes enseñan a cada rol exactamente lo que la API le deja leer
 * (`nav-roles-contract.test.ts` en dentalix-web).
 *
 * Lo escribe `npm run matrix:export [fichero]` (por defecto
 * `dist/route-access.json`); el job «Tipos, unit y build» de la CI lo publica
 * como artefacto y la E2E de la web lo genera desde su checkout de la API.
 *
 * El formato es estable (claves ordenadas, sin fecha ni commit): dos exports de
 * la misma matriz son byte a byte iguales.
 *
 * Semántica de una ruta `roles` (la del RolesGuard, DX-090): la abre quien
 * tenga uno de `roles` O tenga CONCEDIDO (extra, no de serie) uno de
 * `permissions`. `roleBasePermissions` es solo DESCRIPTIVO: es lo que `GET /me`
 * suma a `effectivePermissions` por el rol, y la web decide con esa lista; el
 * contrato lo necesita para no confundir «lo tiene de serie» con «se lo
 * concedieron» (p. ej. RECEPTION tiene PAYMENT_REGISTER de serie, pero una ruta
 * `@Roles(ADMIN) @AllowPermissions(PAYMENT_REGISTER)` le daría 403).
 */
export const ROUTE_ACCESS_EXPORT_FORMAT = 1;

export type ExportedRouteAccess =
  | { kind: 'public'; tenantScoped: boolean }
  | { kind: 'authenticated' }
  | { kind: 'platform' }
  | { kind: 'roles'; roles: ClinicRole[]; permissions: ExtraPermission[] };

export interface RouteAccessExport {
  format: number;
  source: string;
  /** Los 4 roles de clínica, en el orden canónico de la matriz. */
  roles: ClinicRole[];
  /** El catálogo cerrado de permisos extra (DX-090), en su orden. */
  extraPermissions: ExtraPermission[];
  /** Lo que `GET /me` da de serie por rol (no abre rutas por sí solo). */
  roleBasePermissions: Record<ClinicRole, ExtraPermission[]>;
  /** `MÉTODO /ruta` (sin `api/v1`) → acceso, con las claves ordenadas. */
  routes: Record<string, ExportedRouteAccess>;
}

function exportAccess(access: RouteAccess): ExportedRouteAccess {
  switch (access.kind) {
    case 'public':
      return { kind: 'public', tenantScoped: access.tenantScoped };
    case 'authenticated':
      return { kind: 'authenticated' };
    case 'platform':
      return { kind: 'platform' };
    case 'roles': {
      const held = new Set(access.permissions ?? []);
      return {
        kind: 'roles',
        roles: sortRoles(access.roles),
        permissions: EXTRA_PERMISSIONS.filter((p) => held.has(p)),
      };
    }
  }
}

/** La matriz (o otra, en los tests) en el formato exportado. */
export function buildRouteAccessExport(
  matrix: Record<string, RouteAccess> = ROUTE_ACCESS,
): RouteAccessExport {
  const routes: Record<string, ExportedRouteAccess> = {};
  for (const key of Object.keys(matrix).sort()) {
    routes[key] = exportAccess(matrix[key]);
  }
  const roleBase = {} as Record<ClinicRole, ExtraPermission[]>;
  for (const role of ALL_CLINIC_ROLES) {
    roleBase[role] = [...roleBasePermissions(role)];
  }
  return {
    format: ROUTE_ACCESS_EXPORT_FORMAT,
    source: 'test/support/route-access-matrix.ts',
    roles: [...ALL_CLINIC_ROLES],
    extraPermissions: [...EXTRA_PERMISSIONS],
    roleBasePermissions: roleBase,
    routes,
  };
}

/** El JSON tal cual se escribe: 2 espacios y salto de línea final. */
export function serializeRouteAccessExport(data: RouteAccessExport): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}
