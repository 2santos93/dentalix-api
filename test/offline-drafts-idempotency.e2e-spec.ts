import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { CatalogKind, Prisma, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import {
  REGIONAL_CARACAS_FIXTURE,
  registerBody as clinicRegisterBody,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';
import { PasswordService } from '../src/shared/crypto/password.service';
import { createAppValidationPipe } from '../src/shared/validation/app-validation-pipe';

// DX-574: las altas que la web reintenta tras un corte de red (evolución,
// anamnesis, plan, ítem del plan y receta) con Idempotency-Key, por HTTP:
// repetir la MISMA petición devuelve el registro original, sin otra fila ni
// otro evento de auditoría; otra petición con la misma clave es 422; dos
// envíos A LA VEZ con la misma clave dejan UN registro. Y GET /me/draft-key:
// una clave por usuario y clínica, sin caché.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUBDOMAINS = ['dx574-a', 'dx574-b'];
const PASSWORD = 'S3cret!!';
const RUN = randomUUID().slice(0, 8);

interface Session {
  email: string;
  tenantId: string;
  userId: string;
  token: string;
  subdomain: string;
}

describe('DX-574 · Idempotency-Key de las altas clínicas (e2e)', () => {
  let app: INestApplication<App>;
  let a: Session;
  let b: Session;
  let patientId: string;

  const http = () => request(app.getHttpServer());
  const as = (s: Session, key?: string) => {
    const withHeaders = (r: request.Test) => {
      r.set('X-Tenant-Host', hostFor(s.subdomain)).set(
        'Authorization',
        `Bearer ${s.token}`,
      );
      if (key) r.set('Idempotency-Key', key);
      return r;
    };
    return {
      post: (path: string, body: object) =>
        withHeaders(http().post(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        withHeaders(http().put(`/api/v1${path}`)).send(body),
      get: (path: string) => withHeaders(http().get(`/api/v1${path}`)),
    };
  };

  async function clinic(subdomain: string): Promise<Session> {
    // Email único por corrida: purgar la clínica no borra al usuario global.
    const email = `owner-${RUN}@${subdomain}.com`;
    const reg = await registerVerified(
      app,
      clinicRegisterBody(REGIONAL_CARACAS_FIXTURE, {
        clinicName: `Clínica ${subdomain}`,
        subdomain,
        email,
        password: PASSWORD,
        fullName: 'Dra. María González',
      }),
    );
    const login = await http()
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(subdomain))
      .send({ email, password: PASSWORD })
      .expect(201);
    const body = reg.body as { tenantId: string; userId: string };
    return {
      email,
      tenantId: body.tenantId,
      userId: body.userId,
      token: (login.body as { accessToken: string }).accessToken,
      subdomain,
    };
  }

  const auditCount = (tenantId: string, resourceId: string) =>
    raw.auditEvent.count({
      where: { tenantId, resourceId, action: { in: ['CREATE', 'UPDATE'] } },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    await app.listen(0, '127.0.0.1');
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    a = await clinic(SUBDOMAINS[0]);
    b = await clinic(SUBDOMAINS[1]);
    const patient = await as(a)
      .post('/patients', {
        firstName: 'Ana',
        lastName: 'Rodríguez',
        docType: 'NATIONAL_ID',
        docNumber: 'V-18765432',
        sex: Sex.F,
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
  });

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await app.close();
    await raw.$disconnect();
  });

  describe('evolución (POST /patients/:id/clinical-entries)', () => {
    const path = () => `/patients/${patientId}/clinical-entries`;
    const body = { notes: 'Obturación 36 con resina compuesta, sin dolor.' };

    it('repetida con la misma clave: el mismo registro, una fila y un evento', async () => {
      const key = randomUUID();
      const first = await as(a, key).post(path(), body).expect(201);
      const again = await as(a, key).post(path(), body).expect(201);
      const id = (first.body as { id: string }).id;
      expect((again.body as { id: string }).id).toBe(id);
      expect(
        await raw.clinicalEntry.count({ where: { idempotencyKey: key } }),
      ).toBe(1);
      expect(await auditCount(a.tenantId, id)).toBe(1);
    });

    it('la misma clave con otro texto: 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const key = randomUUID();
      await as(a, key).post(path(), body).expect(201);
      const res = await as(a, key)
        .post(path(), { notes: 'Otro texto' })
        .expect(422);
      expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    });

    it('una clave que no es UUID: 400', async () => {
      await as(a, 'no-es-uuid').post(path(), body).expect(400);
    });

    it('tres envíos a la vez con la misma clave dejan UNA evolución', async () => {
      const key = randomUUID();
      const results = await Promise.all(
        [0, 1, 2].map(() => as(a, key).post(path(), body)),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      const ids = new Set(results.map((r) => (r.body as { id: string }).id));
      expect(ids.size).toBe(1);
      expect(
        await raw.clinicalEntry.count({ where: { idempotencyKey: key } }),
      ).toBe(1);
    });
  });

  describe('anamnesis (PUT /patients/:id/medical-history)', () => {
    const path = () => `/patients/${patientId}/medical-history`;

    it('repetida con la misma clave no añade otra versión; a la vez, una sola', async () => {
      const key = randomUUID();
      const body = { notes: 'Hipertensión controlada con losartán 50 mg' };
      const first = await as(a, key).put(path(), body).expect(200);
      const again = await as(a, key).put(path(), body).expect(200);
      expect((again.body as { id: string }).id).toBe(
        (first.body as { id: string }).id,
      );

      const racing = randomUUID();
      const results = await Promise.all(
        [0, 1, 2].map(() =>
          as(a, racing).put(path(), { notes: 'Alergia al látex' }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(
        await raw.medicalHistoryVersion.count({
          where: { patientId, idempotencyKey: { in: [key, racing] } },
        }),
      ).toBe(2);
      expect(
        await raw.medicalHistoryVersion.count({ where: { patientId } }),
      ).toBe(2);
    });
  });

  describe('plan y sus ítems', () => {
    it('el plan y el ítem repetidos con su clave no se duplican, tampoco a la vez', async () => {
      const catalog = await as(a)
        .post('/catalog/items', {
          code: 'RES-574',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Resina compuesta',
          color: '#2A2B3C',
          defaultPrice: 45,
        })
        .expect(201);
      const catalogItemId = (catalog.body as { id: string }).id;

      const planKey = randomUUID();
      // La sede de Caracas cotiza en VES: plan y catálogo en la misma moneda.
      const planBody = { currency: 'VES', notes: 'Plan de operatoria' };
      const plans = await Promise.all(
        [0, 1, 2].map(() =>
          as(a, planKey).post(
            `/patients/${patientId}/treatment-plans`,
            planBody,
          ),
        ),
      );
      expect(plans.map((r) => r.status)).toEqual([201, 201, 201]);
      const planIds = new Set(plans.map((r) => (r.body as { id: string }).id));
      expect(planIds.size).toBe(1);
      const [planId] = [...planIds];

      const itemKey = randomUUID();
      const itemBody = { toothNumber: '36', catalogItemId, notes: 'Oclusal' };
      const first = await as(a, itemKey).post(
        `/treatment-plans/${planId}/items`,
        itemBody,
      );
      expect(first.status).toBe(201);
      const racing = await Promise.all(
        [0, 1].map(() =>
          as(a, itemKey).post(`/treatment-plans/${planId}/items`, itemBody),
        ),
      );
      for (const r of racing) {
        expect(r.status).toBe(201);
        expect((r.body as { id: string }).id).toBe(
          (first.body as { id: string }).id,
        );
      }
      expect(await raw.treatmentPlanItem.count({ where: { planId } })).toBe(1);
      expect(
        await auditCount(a.tenantId, (first.body as { id: string }).id),
      ).toBe(1);

      await as(a, itemKey)
        .post(`/treatment-plans/${planId}/items`, {
          ...itemBody,
          toothNumber: '46',
        })
        .expect(422);
    });
  });

  describe('receta (POST /patients/:id/prescriptions)', () => {
    const ibuprofeno = {
      activeIngredient: 'Ibuprofeno',
      concentration: '400 mg',
      pharmaceuticalForm: 'Tableta',
      route: 'Oral',
      dose: '1 tableta',
      frequency: 'Cada 8 horas',
      durationDays: 3,
      totalQuantity: 9,
      quantityUnit: 'tabletas',
    };

    it('repetida con la misma clave: la misma receta (mismo código), también a la vez', async () => {
      const key = randomUUID();
      const body = { items: [ibuprofeno], professionalLicense: 'MPPS-45678' };
      const results = await Promise.all(
        [0, 1, 2].map(() =>
          as(a, key).post(`/patients/${patientId}/prescriptions`, body),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      const codes = new Set(
        results.map(
          (r) => (r.body as { verificationCode: string }).verificationCode,
        ),
      );
      expect(codes.size).toBe(1);
      expect(
        await raw.prescription.count({ where: { idempotencyKey: key } }),
      ).toBe(1);

      await as(a, key)
        .post(`/patients/${patientId}/prescriptions`, {
          ...body,
          notes: 'Tomar con comida',
        })
        .expect(422);
    });
  });

  describe('aislamiento por clínica', () => {
    it('la misma clave en otra clínica no ve ni devuelve el registro ajeno', async () => {
      const key = randomUUID();
      await as(a, key)
        .post(`/patients/${patientId}/clinical-entries`, { notes: 'De A' })
        .expect(201);
      // En B el paciente no existe: 404, nunca la evolución de A.
      await as(b, key)
        .post(`/patients/${patientId}/clinical-entries`, { notes: 'De A' })
        .expect(404);
    });
  });

  async function login(subdomain: string, email: string): Promise<string> {
    const res = await http()
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(subdomain))
      .send({ email, password: PASSWORD })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  const sidOf = (token: string): string =>
    (
      JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
      ) as { sid: string }
    ).sid;

  const draftKey = (s: Session, token: string) =>
    http()
      .get('/api/v1/me/draft-key')
      .set('X-Tenant-Host', hostFor(s.subdomain))
      .set('Authorization', `Bearer ${token}`);

  describe('GET /me/draft-key', () => {
    it('32 bytes, la misma al volver a pedirla, distinta en otra clínica, sin caché', async () => {
      const first = await as(a).get('/me/draft-key').expect(200);
      const again = await as(a).get('/me/draft-key').expect(200);
      const other = await as(b).get('/me/draft-key').expect(200);
      const key = (first.body as { key: string; version: number }).key;
      expect(Buffer.from(key, 'base64')).toHaveLength(32);
      expect((first.body as { version: number }).version).toBe(1);
      expect((again.body as { key: string }).key).toBe(key);
      expect((other.body as { key: string }).key).not.toBe(key);
      expect(first.headers['cache-control']).toContain('no-store');
    });

    it('sesión revocada (cerrada desde «Sesiones» o por «No fui yo»): 401 aunque el access token no haya caducado', async () => {
      const token = await login(a.subdomain, a.email);
      await draftKey(a, token).expect(200);
      await raw.refreshSession.update({
        where: { id: sidOf(token) },
        data: { revokedAt: new Date() },
      });
      await draftKey(a, token).expect(401);
    });

    it('membresía retirada: 401', async () => {
      const email = `dentista-${RUN}@${a.subdomain}.com`;
      const user = await raw.user.create({
        data: {
          email,
          fullName: 'Dr. José Hernández',
          passwordHash: await new PasswordService().hash(PASSWORD),
          emailVerifiedAt: new Date(),
        },
      });
      const membership = await raw.clinicMembership.create({
        data: { tenantId: a.tenantId, userId: user.id, role: 'DENTIST' },
      });
      const token = await login(a.subdomain, email);
      await draftKey(a, token).expect(200);
      await raw.clinicMembership.update({
        where: { id: membership.id },
        data: { deletedAt: new Date() },
      });
      await draftKey(a, token).expect(401);
    });

    it('tokenVersion nueva (contraseña o MFA): el token viejo da 401 y la sesión nueva recibe OTRA clave', async () => {
      const token = await login(b.subdomain, b.email);
      const before = await draftKey(b, token).expect(200);
      await raw.user.update({
        where: { id: b.userId },
        data: { tokenVersion: { increment: 1 } },
      });
      await draftKey(b, token).expect(401);
      const fresh = await login(b.subdomain, b.email);
      const after = await draftKey(b, fresh).expect(200);
      expect((after.body as { key: string }).key).not.toBe(
        (before.body as { key: string }).key,
      );
    });

    it('sin sesión: 401', async () => {
      await http()
        .get('/api/v1/me/draft-key')
        .set('X-Tenant-Host', hostFor(a.subdomain))
        .expect(401);
    });
  });
});
