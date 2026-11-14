import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantResolverService } from '../src/shared/tenancy/tenant-resolver.service';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  registerBody,
} from './support/location-fixtures';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para el cleanup/seed en
// beforeAll — usa DIRECT_URL (rol owner `dentalix`, superuser), mismo patrón
// que auth.e2e-spec.ts / tenant-host.e2e-spec.ts.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface RegisterResponseBody {
  tenantId: string;
  userId: string;
}

interface BrandingResponseBody {
  name: string;
  primaryColor: string;
  logoUrl: string | null;
}

interface LoginResponseBody {
  accessToken: string;
}

const BY_HOST = '/api/v1/public/tenant/branding/by-host';
const PASSWORD = 'S3cret!!';
// DX-517-ter: clínica B con campos que intentan inyectar CSS/HTML. La API los
// devuelve tal cual (JSON); quien los pinta (la web) los valida/escapa.
const HOSTILE_NAME = '</style><script>alert("x")</script>\' OR 1=1 --';
const HOSTILE_COLOR = 'red};body{display:none';
const A_DOMAIN = 'clinica-sonrisa.com.ve';
const A_PENDING = 'pendiente-sonrisa.com.ve';

describe('Public tenant branding (e2e)', () => {
  let app: INestApplication<App>;
  let tenantId: string;
  let tenantIdB: string;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await app.listen(0, '127.0.0.1');
    await resetDatabase(raw);

    const register = await registerVerified(
      app,
      registerBody(REGIONAL_CARACAS_FIXTURE, {
        clinicName: 'Sonrisa Branding',
        subdomain: 'sonrisa-branding',
        email: 'owner@sonrisa-branding.com',
        password: 'S3cret!!',
        fullName: 'Dr. Owner',
      }),
    );
    tenantId = (register.body as RegisterResponseBody).tenantId;

    await raw.tenant.update({
      where: { id: tenantId },
      data: {
        primaryColor: '#AA1155',
        logoKey: 'https://cdn.example.com/logo.png',
        currencyTexts: { USD: 'US$', VES: 'Bs.' },
      },
    });

    const registerB = await registerVerified(
      app,
      registerBody(REGIONAL_CARACAS_FIXTURE, {
        clinicName: 'Norte Branding',
        subdomain: 'norte-branding',
        email: 'owner@norte-branding.com',
        password: PASSWORD,
        fullName: 'Dra. Norte',
      }),
    );
    tenantIdB = (registerB.body as RegisterResponseBody).tenantId;

    // Un dominio propio VERIFIED de A y uno PENDING (mismo patrón que
    // domains.e2e-spec.ts, por inserción directa: aquí no se prueba el TXT).
    await raw.tenantDomain.create({
      data: {
        tenantId,
        host: A_DOMAIN,
        status: 'VERIFIED',
        verifyToken: 'dx517ter-verified',
        verifiedAt: new Date(),
        expiresAt: null,
      },
    });
    await raw.tenantDomain.create({
      data: {
        tenantId,
        host: A_PENDING,
        status: 'PENDING',
        verifyToken: 'dx517ter-pending',
      },
    });

    tokenA = await login('sonrisa-branding', 'owner@sonrisa-branding.com');
    tokenB = await login('norte-branding', 'owner@norte-branding.com');

    // Después del login: el nombre hostil no debe romper nada más.
    await raw.tenant.update({
      where: { id: tenantIdB },
      data: { name: HOSTILE_NAME, primaryColor: HOSTILE_COLOR },
    });
  });

  async function login(subdomain: string, email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(subdomain))
      .send({ email, password: PASSWORD })
      .expect(201);
    return (res.body as LoginResponseBody).accessToken;
  }

  const A_BRANDING = {
    name: 'Sonrisa Branding',
    primaryColor: '#AA1155',
    logoUrl: 'https://cdn.example.com/logo.png',
    currencyTexts: { USD: 'US$', VES: 'Bs.' },
  };

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('returns the branding for the host-resolved tenant with NO Authorization header', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/public/tenant/branding')
      .set('X-Tenant-Host', hostFor('sonrisa-branding'))
      .expect(200);

    const body = res.body as BrandingResponseBody;
    expect(body).toEqual({
      name: 'Sonrisa Branding',
      primaryColor: '#AA1155',
      logoUrl: 'https://cdn.example.com/logo.png',
      currencyTexts: { USD: 'US$', VES: 'Bs.' },
    });
  });

  it('returns 404 when the host resolves to no tenant', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/public/tenant/branding')
      .set('X-Tenant-Host', hostFor('ghost-branding'))
      .expect(404);
  });

  it('returns 404 when no tenant host header/context is present at all', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/public/tenant/branding')
      .expect(404);
  });

  describe('GET /public/tenant/branding/by-host (DX-517-ter)', () => {
    const byHost = (host?: string) => {
      const req = request(app.getHttpServer()).get(BY_HOST);
      return host === undefined ? req : req.query({ host });
    };

    it('devuelve la marca de la clínica del subdominio, con EXACTAMENTE los cuatro campos públicos', async () => {
      const res = await byHost(hostFor('sonrisa-branding')).expect(200);
      expect(res.body).toEqual(A_BRANDING);
      expect(Object.keys(res.body as object).sort()).toEqual([
        'currencyTexts',
        'logoUrl',
        'name',
        'primaryColor',
      ]);
      expect(JSON.stringify(res.body)).not.toContain(tenantId);
    });

    it('resuelve un dominio propio VERIFIED (también en mayúsculas, con puerto y punto final)', async () => {
      for (const host of [
        A_DOMAIN,
        A_DOMAIN.toUpperCase(),
        `${A_DOMAIN}:443`,
        `${A_DOMAIN}.`,
      ]) {
        const res = await byHost(host).expect(200);
        expect(res.body).toEqual(A_BRANDING);
      }
    });

    it('404 para un dominio PENDING, un host desconocido, el apex, una etiqueta reservada y sin host', async () => {
      for (const host of [
        A_PENDING,
        hostFor('ghost-branding'),
        'localhost',
        'api.localhost',
        'otra.clinica.localhost',
      ]) {
        await byHost(host).expect(404);
      }
      await byHost().expect(404);
    });

    it('un host inválido da el mismo 404 que uno desconocido, sin pasar por el resolutor (ni la BD)', async () => {
      const resolver = app.get(TenantResolverService);
      const unknown = await byHost(hostFor('ghost-branding')).expect(404);
      const spy = jest.spyOn(resolver, 'resolve');
      try {
        for (const host of [
          'demo.dentalix.app:443@evil.com',
          'a..b',
          'sonrisa-branding.localhost%00',
          `${'a'.repeat(296)}.com`,
          'sonrisa-branding.localhost/../x',
        ]) {
          spy.mockClear();
          const res = await byHost(host).expect(404);
          expect(res.body).toEqual(unknown.body);
          // Solo la resolución del host de la PROPIA petición (middleware de
          // siempre); el `host` inválido no llega al resolutor.
          const asked = spy.mock.calls.map(([h]) => h);
          expect(asked).not.toContain(host);
          expect(asked.length).toBeLessThanOrEqual(1);
        }
        // `host` repetido (llega como lista): también 404 sin resolver.
        spy.mockClear();
        await request(app.getHttpServer())
          .get(
            `${BY_HOST}?host=${hostFor('sonrisa-branding')}&host=${hostFor('norte-branding')}`,
          )
          .expect(404);
        expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('responde con Cache-Control: no-store y Pragma: no-cache (200 y 404)', async () => {
      for (const host of [hostFor('sonrisa-branding'), 'a..b']) {
        const res = await byHost(host);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['pragma']).toBe('no-cache');
      }
    });

    it('suplantación: X-Tenant, X-Tenant-Host, X-Forwarded-Host, Host y el token de B no cambian la clínica del parámetro', async () => {
      const spoofed = (host: string, other: string, token: string) =>
        byHost(host)
          .set('X-Tenant', other.split('.')[0])
          .set('X-Tenant-Host', other)
          .set('X-Forwarded-Host', other)
          .set('Host', other)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);

      const a = await spoofed(
        hostFor('sonrisa-branding'),
        hostFor('norte-branding'),
        tokenB,
      );
      expect(a.body).toEqual(A_BRANDING);

      const b = await spoofed(
        hostFor('norte-branding'),
        hostFor('sonrisa-branding'),
        tokenA,
      );
      expect((b.body as BrandingResponseBody).name).toBe(HOSTILE_NAME);

      const custom = await spoofed(A_DOMAIN, hostFor('norte-branding'), tokenB);
      expect(custom.body).toEqual(A_BRANDING);
    });

    it('la ruta de siempre no cambia: sigue resolviendo por el host de la petición', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/public/tenant/branding')
        .query({ host: hostFor('sonrisa-branding') })
        .set('X-Tenant-Host', hostFor('norte-branding'))
        .expect(200);
      expect((res.body as BrandingResponseBody).name).toBe(HOSTILE_NAME);
    });

    it('el token de otra clínica sigue rechazado en las rutas autenticadas (401)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/staff')
        .set('X-Tenant-Host', hostFor('norte-branding'))
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(401);
      // …y la consulta pública de la marca de B no abre nada: el mismo token
      // sigue valiendo solo en el host de A.
      await byHost(hostFor('norte-branding')).expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/staff')
        .set('X-Tenant-Host', hostFor('norte-branding'))
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(401);
      await request(app.getHttpServer())
        .get('/api/v1/staff')
        .set('X-Tenant-Host', hostFor('sonrisa-branding'))
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
    });

    it('devuelve los campos con caracteres de inyección tal cual, como JSON (sin interpretarlos)', async () => {
      const res = await byHost(hostFor('norte-branding')).expect(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      const body = res.body as BrandingResponseBody;
      expect(body.name).toBe(HOSTILE_NAME);
      expect(body.primaryColor).toBe(HOSTILE_COLOR);
      expect(res.text).toContain(JSON.stringify(HOSTILE_NAME));
    });

    it('no pone cookies ni deja contexto de clínica', async () => {
      const res = await byHost(hostFor('sonrisa-branding')).expect(200);
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });
});
