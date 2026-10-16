import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  platformAdminToken,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  ALL_CLINIC_ROLES,
  ROUTE_ACCESS,
  RouteAccess,
} from './support/route-access-matrix';

/**
 * DX-068 (TST-001): matriz rol × ruta en HTTP real.
 *
 * Recorre TODAS las rutas de `ROUTE_ACCESS` (la misma tabla que el unit
 * `src/auth-matrix.spec.ts` ata a los metadatos de los controladores) con un
 * token de cada uno de los 4 roles de una misma clínica:
 *  - rol no permitido → 403 (lo corta RolesGuard antes de validar nada);
 *  - rol permitido → ni 403 ni 401 (puede ser 200, 400 o 404: los ids son
 *    inventados y los cuerpos van vacíos, así que no se escribe nada).
 * Además: sin token → 401 en toda ruta con sesión, y `/platform/*` solo con
 * token de plataforma.
 */

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// Ids que no existen en ninguna clínica. `:fdi` necesita un diente válido.
const FAKE_UUID = '00000000-0000-4000-8000-000000000000';
const PARAM_VALUES: Record<string, string> = { fdi: '11' };

function concretePath(routePath: string): string {
  return routePath.replace(
    /:([A-Za-z]+)/g,
    (_match, name: string) => PARAM_VALUES[name] ?? FAKE_UUID,
  );
}

type Verb = 'get' | 'post' | 'put' | 'patch' | 'delete';

function call(
  app: INestApplication<App>,
  routeKey: string,
  host: string,
  token?: string,
): request.Test {
  const [verb, routePath] = routeKey.split(' ');
  const method = verb.toLowerCase() as Verb;
  const req = request(app.getHttpServer())
    [method](`/api/v1${concretePath(routePath)}`)
    .set('X-Tenant-Host', host);
  if (token) req.set('Authorization', `Bearer ${token}`);
  return method === 'get' || method === 'delete' ? req : req.send({});
}

const entries = Object.entries(ROUTE_ACCESS);
const clinicRoutes = entries.filter(
  (entry): entry is [string, Extract<RouteAccess, { kind: 'roles' }>] =>
    entry[1].kind === 'roles',
);
const authenticatedRoutes = entries
  .filter(([, access]) => access.kind === 'authenticated')
  .map(([key]) => key);
const platformRoutes = entries
  .filter(([, access]) => access.kind === 'platform')
  .map(([key]) => key);
const sessionRoutes = entries
  .filter(([, access]) => access.kind !== 'public')
  .map(([key]) => key);

describe('Role matrix (e2e, DX-068)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  const tokens = {} as Record<ClinicRole, string>;
  let platformToken: string;

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'clinica-roles');
    tokens[ClinicRole.ADMIN] = clinic.adminToken;
    for (const role of ALL_CLINIC_ROLES) {
      if (role === ClinicRole.ADMIN) continue;
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
    platformToken = await platformAdminToken(app, raw);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('la tabla tiene rutas restringidas para cada rol (no es trivial)', () => {
    for (const role of ALL_CLINIC_ROLES) {
      expect(
        clinicRoutes.some(([, access]) => !access.roles.includes(role)),
      ).toBe(role !== ClinicRole.ADMIN);
    }
  });

  describe.each(ALL_CLINIC_ROLES)('rol %s', (role) => {
    const denied = clinicRoutes
      .filter(([, access]) => !access.roles.includes(role))
      .map(([key]) => key);
    const allowed = [
      ...clinicRoutes
        .filter(([, access]) => access.roles.includes(role))
        .map(([key]) => key),
      ...authenticatedRoutes,
    ];

    if (denied.length > 0) {
      it.each(denied)('403 en %s', async (key) => {
        const res = await call(app, key, clinic.host, tokens[role]);
        expect({ key, status: res.status }).toEqual({ key, status: 403 });
      });
    }

    it.each(allowed)('no 403 en %s', async (key) => {
      const res = await call(app, key, clinic.host, tokens[role]);
      expect({
        key,
        forbiddenOrUnauthenticated: [401, 403].includes(res.status),
      }).toEqual({ key, forbiddenOrUnauthenticated: false });
    });

    it.each(platformRoutes)('403 en %s (token de clínica)', async (key) => {
      const res = await call(app, key, 'localhost', tokens[role]);
      expect(res.status).toBe(403);
    });
  });

  describe('plataforma', () => {
    it.each(platformRoutes)(
      '200 en %s con token de superadmin',
      async (key) => {
        await call(app, key, 'localhost', platformToken).expect(200);
      },
    );

    it('el token de plataforma no entra en rutas de clínica', async () => {
      // Lo corta RolesGuard (un token de plataforma no lleva rol de clínica);
      // detrás, TenantContextInterceptor también lo rechazaría (401).
      await call(app, 'GET /patients', clinic.host, platformToken).expect(403);
    });
  });

  describe('sin sesión', () => {
    it.each(sessionRoutes)('401 en %s', async (key) => {
      const res = await call(app, key, clinic.host);
      expect({ key, status: res.status }).toEqual({ key, status: 401 });
    });
  });
});
