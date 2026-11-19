import { ClinicRole, ExtraPermission } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROUTE_ACCESS, RouteAccess } from '../test/support/route-access-matrix';
import {
  buildRouteAccessExport,
  serializeRouteAccessExport,
} from '../test/support/route-access-export';

/**
 * DX-208: `npm run matrix:export` escribe `ROUTE_ACCESS` en JSON para el test
 * de contrato de la web (`nav-roles-contract.test.ts`). Aquí se fija el
 * formato: que no pierda ni invente rutas, que normalice el orden de roles y
 * permisos, y que sea estable byte a byte.
 */
describe('Exportación de la matriz de roles (route-access.json)', () => {
  const data = buildRouteAccessExport();

  it('lleva TODAS las rutas de la matriz, con las claves ordenadas', () => {
    const keys = Object.keys(data.routes);
    expect(keys).toEqual(Object.keys(ROUTE_ACCESS).sort());
    expect(keys.length).toBeGreaterThan(100);
  });

  it('conserva el acceso de cada ruta (roles y permisos extra incluidos)', () => {
    for (const [key, access] of Object.entries(ROUTE_ACCESS)) {
      const exported = data.routes[key];
      expect({ key, kind: exported.kind }).toEqual({ key, kind: access.kind });
      if (access.kind === 'roles' && exported.kind === 'roles') {
        expect({ key, roles: [...exported.roles].sort() }).toEqual({
          key,
          roles: [...access.roles].sort(),
        });
        expect({ key, permissions: [...exported.permissions].sort() }).toEqual({
          key,
          permissions: [...(access.permissions ?? [])].sort(),
        });
      }
      if (access.kind === 'public' && exported.kind === 'public') {
        expect(exported.tenantScoped).toBe(access.tenantScoped);
      }
    }
  });

  it('incluye rutas con permiso extra (DX-090), con su permiso', () => {
    const withPermission = Object.values(data.routes).filter(
      (a) => a.kind === 'roles' && a.permissions.length > 0,
    );
    expect(withPermission.length).toBeGreaterThan(0);
  });

  it('normaliza: roles en el orden canónico, permisos en el del catálogo y siempre `permissions`', () => {
    const matrix: Record<string, RouteAccess> = {
      'GET /b': {
        kind: 'roles',
        roles: [ClinicRole.RECEPTION, ClinicRole.ADMIN],
        permissions: [
          ExtraPermission.FINANCIAL_REPORTS_VIEW,
          ExtraPermission.PAYMENT_REGISTER,
        ],
      },
      'GET /a': { kind: 'roles', roles: [ClinicRole.DENTIST] },
      'GET /c': { kind: 'authenticated' },
      'GET /d': { kind: 'public', tenantScoped: true },
      'GET /e': { kind: 'platform' },
    };
    const out = buildRouteAccessExport(matrix);
    expect(Object.keys(out.routes)).toEqual([
      'GET /a',
      'GET /b',
      'GET /c',
      'GET /d',
      'GET /e',
    ]);
    expect(out.routes['GET /a']).toEqual({
      kind: 'roles',
      roles: ['DENTIST'],
      permissions: [],
    });
    expect(out.routes['GET /b']).toEqual({
      kind: 'roles',
      roles: ['ADMIN', 'RECEPTION'],
      permissions: ['PAYMENT_REGISTER', 'FINANCIAL_REPORTS_VIEW'],
    });
    expect(out.routes['GET /c']).toEqual({ kind: 'authenticated' });
    expect(out.routes['GET /d']).toEqual({
      kind: 'public',
      tenantScoped: true,
    });
    expect(out.routes['GET /e']).toEqual({ kind: 'platform' });
  });

  it('describe los roles, el catálogo y los permisos de serie de cada rol', () => {
    expect(data.format).toBe(1);
    expect(data.roles).toEqual(['ADMIN', 'DENTIST', 'ASSISTANT', 'RECEPTION']);
    expect(data.extraPermissions).toEqual(Object.values(ExtraPermission));
    expect(Object.keys(data.roleBasePermissions)).toEqual(data.roles);
    // De serie (solo descriptivo, `GET /me`): ver extra-permissions.ts.
    expect(data.roleBasePermissions.RECEPTION).toEqual(['PAYMENT_REGISTER']);
    expect(data.roleBasePermissions.DENTIST).toEqual([]);
  });

  it('es estable: dos exportaciones son byte a byte iguales', () => {
    expect(serializeRouteAccessExport(buildRouteAccessExport())).toBe(
      serializeRouteAccessExport(data),
    );
    expect(serializeRouteAccessExport(data).endsWith('}\n')).toBe(true);
  });

  it('`npm run matrix:export <fichero>` escribe ese JSON', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'route-access-'));
    try {
      const out = path.join(dir, 'sub', 'route-access.json');
      execFileSync(
        process.execPath,
        [
          require.resolve('ts-node/dist/bin'),
          '--transpile-only',
          path.join(__dirname, '../test/support/export-route-access.ts'),
          out,
        ],
        { cwd: path.join(__dirname, '..'), stdio: 'pipe' },
      );
      expect(readFileSync(out, 'utf8')).toBe(serializeRouteAccessExport(data));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
