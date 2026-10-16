import {
  Controller,
  Get,
  INestApplication,
  InternalServerErrorException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupSwagger } from '../src/config/swagger';
import { applyBodyLimits } from '../src/config/body-limits';
import { applyObservability } from '../src/shared/observability/apply-observability';
import { AppLogger, LogSink } from '../src/shared/observability/app-logger';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { applySecurity } from '../src/shared/security/apply-security';
import { TenantResolverService } from '../src/shared/tenancy/tenant-resolver.service';
import { hostFor } from './support/tenant-host';

// DX-023: request id, log de acceso sin datos clínicos ni PII, 5xx sin stack
// para el cliente y sondas de salud. La app se arma igual que main.ts, con un
// AppLogger que escribe en memoria (nivel debug) en vez de en la consola: así
// el test lee cada línea y la salida de jest queda limpia.

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUB = 'observa-e2e';
const EMAIL = 'observa@e2e.com';
const PASSWORD = 'Observa-Clave-2026!';
const PATIENT_NAME = 'Gertrudis Zapata';
const PATIENT_DOC = '987654321';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type LogLine = Record<string, unknown>;

// Rutas que solo existen en este test, para provocar errores 5xx.
@Controller('test-boom')
class BoomController {
  @Get()
  boom(): never {
    throw new Error(`fallo interno con ${PATIENT_NAME}`);
  }

  @Get('http')
  http(): never {
    throw new InternalServerErrorException('dependencia caída');
  }
}

async function buildApp(
  lines: LogLine[],
  override?: (b: ReturnType<typeof Test.createTestingModule>) => void,
): Promise<INestApplication<App>> {
  const builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: [BoomController],
  });
  override?.(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  const sink: LogSink = (_stream, line) => {
    lines.push(JSON.parse(line) as LogLine);
  };
  applyObservability(
    app,
    new AppLogger({ level: 'debug', format: 'json' }, sink),
  );
  applySecurity(app);
  applyBodyLimits(app);
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  setupSwagger(app);
  await app.init();
  return app;
}

const accessLines = (lines: LogLine[]): LogLine[] =>
  lines.filter((l) => l.context === 'Access');

describe('Observabilidad (e2e, DX-023)', () => {
  let app: INestApplication<App>;
  const lines: LogLine[] = [];
  let tenantId: string;
  let userId: string;
  let accessToken: string;

  const cleanup = async (): Promise<void> => {
    await raw.clinicMembership.deleteMany({
      where: { tenant: { subdomain: SUB } },
    });
    await raw.user.deleteMany({ where: { email: EMAIL } });
    await raw.tenant.deleteMany({ where: { subdomain: SUB } });
  };

  beforeAll(async () => {
    app = await buildApp(lines);
    await cleanup();
    const register = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        clinicName: 'Observa E2E',
        subdomain: SUB,
        email: EMAIL,
        password: PASSWORD,
        fullName: 'Dra. Observa',
      })
      .expect(201);
    ({ tenantId, userId } = register.body as {
      tenantId: string;
      userId: string;
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(SUB))
      .send({ email: EMAIL, password: PASSWORD })
      .expect(201);
    ({ accessToken } = login.body as { accessToken: string });
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await raw.$disconnect();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  describe('X-Request-Id', () => {
    it('cada respuesta lleva uno nuevo si el cliente no lo manda', async () => {
      const a = await request(app.getHttpServer())
        .get('/api/v1/health')
        .expect(200);
      const b = await request(app.getHttpServer())
        .get('/api/v1/health')
        .expect(200);
      expect(a.headers['x-request-id']).toMatch(UUID);
      expect(b.headers['x-request-id']).toMatch(UUID);
      expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
    });

    it('respeta un id válido del cliente y lo usa en el log', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('X-Request-Id', 'lb-01:req.000042')
        .expect(200);
      expect(res.headers['x-request-id']).toBe('lb-01:req.000042');
      expect(accessLines(lines)[0].requestId).toBe('lb-01:req.000042');
    });

    it('reemplaza un id inválido (intento de inyección en el log)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('X-Request-Id', 'abc"},"level":"fatal')
        .expect(200);
      expect(res.headers['x-request-id']).toMatch(UUID);
      expect(JSON.stringify(lines)).not.toContain('fatal');
    });

    it('también va en las respuestas que corta CORS antes del router', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('Origin', 'https://malicioso.example')
        .expect(403);
      expect(res.headers['x-request-id']).toMatch(UUID);
      expect(accessLines(lines)[0]).toMatchObject({ status: 403, route: null });
    });
  });

  describe('log de acceso', () => {
    it('una línea JSON por petición con request id, ruta plantilla, estado, ms, tenant y usuario', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/patients')
        .query({ query: PATIENT_NAME })
        .set('X-Tenant-Host', hostFor(SUB))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const access = accessLines(lines);
      expect(access).toHaveLength(1);
      expect(access[0]).toMatchObject({
        level: 'info',
        requestId: res.headers['x-request-id'],
        method: 'GET',
        route: '/api/v1/patients',
        status: 200,
        tenantId,
        userId,
      });
      expect(typeof access[0].durationMs).toBe('number');
      expect(typeof access[0].time).toBe('string');
    });

    it('la ruta es la plantilla, no el id real', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/patients/00000000-0000-4000-8000-000000000000')
        .set('X-Tenant-Host', hostFor(SUB))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);
      expect(accessLines(lines)[0]).toMatchObject({
        route: '/api/v1/patients/:id',
        status: 404,
      });
      expect(JSON.stringify(lines)).not.toContain('00000000-0000-4000');
    });

    it('nunca registra cuerpo, contraseñas, tokens, cookies, query ni datos del paciente', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('X-Tenant-Host', hostFor(SUB))
        .set('Cookie', 'dx_refresh=cookie-secreta-123')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(201);
      await request(app.getHttpServer())
        .get('/api/v1/patients')
        .query({ query: `${PATIENT_NAME} ${PATIENT_DOC}` })
        .set('X-Tenant-Host', hostFor(SUB))
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      // 400 de validación: el cuerpo con datos clínicos no llega al log.
      await request(app.getHttpServer())
        .post('/api/v1/patients')
        .set('X-Tenant-Host', hostFor(SUB))
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          firstName: PATIENT_NAME,
          docNumber: PATIENT_DOC,
          allergies: 'penicilina',
        })
        .expect(400);

      expect(accessLines(lines)).toHaveLength(3);
      const text = JSON.stringify(lines);
      for (const leaked of [
        PASSWORD,
        EMAIL,
        accessToken,
        accessToken.split('.')[1],
        'cookie-secreta-123',
        'Gertrudis',
        'Zapata',
        PATIENT_DOC,
        'penicilina',
        'query',
        'Bearer',
      ]) {
        expect(text).not.toContain(leaked);
      }
    });
  });

  describe('errores 5xx', () => {
    it('un error no controlado: 500 genérico con request id, sin stack ni mensaje interno', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/test-boom')
        .expect(500);
      expect(res.body).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Ocurrió un error procesando la solicitud.',
        requestId: res.headers['x-request-id'],
      });
      expect(res.text).not.toContain('at ');
      expect(res.text).not.toContain(PATIENT_NAME);

      const errors = lines.filter((l) => l.level === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        requestId: res.headers['x-request-id'],
        route: '/api/v1/test-boom',
        status: 500,
        error: 'Error',
      });
      expect(String(errors[0].stack)).toMatch(/\n\s+at /);
      expect(accessLines(lines)[0]).toMatchObject({
        requestId: res.headers['x-request-id'],
        status: 500,
      });
    });

    it('un HttpException 5xx conserva su cuerpo y añade el request id', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/test-boom/http')
        .expect(500);
      expect(res.body).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'dependencia caída',
        requestId: res.headers['x-request-id'],
      });
      expect(lines.filter((l) => l.level === 'error')).toHaveLength(1);
    });

    it('un 4xx no lleva requestId en el cuerpo ni se registra como error', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/patients')
        .set('X-Tenant-Host', hostFor(SUB))
        .expect(401);
      expect(res.body).not.toHaveProperty('requestId');
      expect(lines.filter((l) => l.level === 'error')).toEqual([]);
    });
  });

  describe('sondas', () => {
    it('/health: 200 sin resolver tenant (no toca la base)', async () => {
      const resolve = jest.spyOn(app.get(TenantResolverService), 'resolve');
      await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('Host', hostFor(SUB))
        .expect(200, { status: 'ok' });
      await request(app.getHttpServer())
        .get('/api/v1/health/ready')
        .set('Host', hostFor(SUB))
        .expect(200);
      expect(resolve).not.toHaveBeenCalled();
      // El resto de rutas sí lo resuelve.
      await request(app.getHttpServer())
        .get('/api/v1/public/tenant/branding')
        .set('Host', hostFor(SUB));
      expect(resolve).toHaveBeenCalled();
      resolve.mockRestore();
    });

    it('/health/ready: 200 con la base de datos', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/health/ready')
        .expect(200, { status: 'ok', database: 'up' });
    });
  });
});

// Una instancia cuyo cliente de Prisma apunta a un puerto sin Postgres: la
// base "no responde" sin tocar el Postgres compartido de los tests.
describe('Observabilidad sin base de datos (e2e, DX-023)', () => {
  let app: INestApplication<App>;
  const lines: LogLine[] = [];
  const unreachable = new PrismaClient({
    datasources: {
      db: { url: 'postgresql://dentalix:dentalix@127.0.0.1:1/sin_base' },
    },
  });

  beforeAll(async () => {
    app = await buildApp(lines, (builder) => {
      builder.overrideProvider(PrismaService).useValue(unreachable);
    });
  });

  afterAll(async () => {
    await app.close();
    await unreachable.$disconnect();
  });

  it('/health/ready: 503 con request id y sin detalles internos', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(503);
    expect(res.body).toEqual({
      statusCode: 503,
      status: 'unavailable',
      database: 'down',
      requestId: res.headers['x-request-id'],
    });
    expect(res.text).not.toContain('127.0.0.1');
    expect(
      lines.find((l) => l.level === 'warn' && l.context === 'HealthController'),
    ).toMatchObject({ requestId: res.headers['x-request-id'] });
  });

  it('/health: 200 aunque no haya base', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200, { status: 'ok' });
  });
});
