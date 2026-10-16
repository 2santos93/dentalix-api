import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, DocType, PrismaClient, Sex } from '@prisma/client';
import { PasswordService } from '../src/shared/crypto/password.service';
import { createE2eApp } from './support/create-e2e-app';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';

// DIRECT_URL (superusuario, sin RLS) solo para sembrar miembros con rol, mirar
// filas y limpiar — mismo criterio que account-statement.e2e-spec.ts.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const PASSWORD = 'S3cret!!';
const USER_AGENT = 'Dentalix-e2e/1.0 (mostrador)';

const POLICY = {
  policyText: 'Política de tratamiento de datos de la clínica (Ley 1581).',
  generalText: 'Autorizo el tratamiento de mis datos personales.',
  sensitiveHealthText:
    'Autorizo el tratamiento de mis datos sensibles de salud (historia clínica). No está obligado a autorizarlo. Finalidad: la atención odontológica.',
  marketingText: 'Autorizo recibir comunicaciones comerciales.',
};

interface Session {
  tenantId: string;
  accessToken: string;
  subdomain: string;
}

interface PolicyBody {
  id: string;
  version: number;
  policyText: string;
  contentHash: string;
  publishedAt: string;
  publishedBy: { id: string; fullName: string };
}

interface ConsentRow {
  id: string;
  scope: string;
  granted: boolean;
  channel: string;
  policyVersion: { id: string; version: number } | null;
  legacyPolicyVersion: string | null;
  recordedAt: string;
  recordedBy: { id: string; fullName: string } | null;
  ipAddress: string | null;
  userAgent: string | null;
}

interface ConsentsBody {
  current: { scope: string; granted: boolean | null }[];
  history: ConsentRow[];
}

interface PatientBody {
  id: string;
  dataConsentAccepted: boolean;
  dataConsentAt: string | null;
  dataConsentPolicyVersion: string | null;
}

async function cleanup(): Promise<void> {
  await raw.dataProcessingConsent.deleteMany();
  await raw.privacyPolicyVersion.deleteMany();
  await raw.medicalHistoryVersion.deleteMany();
  await raw.patient.deleteMany();
  await raw.dentalCatalogItem.deleteMany();
  await raw.locationScheduleRange.deleteMany();
  await raw.locationSchedule.deleteMany();
  await raw.location.deleteMany();
  await raw.clinicMembership.deleteMany();
  await raw.user.deleteMany();
  await raw.tenantDomain.deleteMany();
  await raw.tenant.deleteMany();
}

function stateOf(body: ConsentsBody): Record<string, boolean | null> {
  return Object.fromEntries(body.current.map((c) => [c.scope, c.granted]));
}

describe('Autorización de datos Ley 1581 — /privacy-policies y /patients/:id/data-consents (e2e)', () => {
  let app: INestApplication<App>;
  let clinicA: Session;
  let clinicB: Session;
  let receptionA: string;
  let receptionAId: string;
  let dentistA: string;

  const server = () => app.getHttpServer();

  function as(session: Session, token = session.accessToken) {
    const withHeaders = (req: request.Test) =>
      req
        .set('X-Tenant-Host', hostFor(session.subdomain))
        .set('Authorization', `Bearer ${token}`)
        .set('User-Agent', USER_AGENT);
    return {
      get: (path: string) =>
        withHeaders(request(server()).get(`/api/v1${path}`)),
      post: (path: string, body: object) =>
        withHeaders(request(server()).post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) =>
        withHeaders(request(server()).patch(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        withHeaders(request(server()).put(`/api/v1${path}`)).send(body),
      delete: (path: string) =>
        withHeaders(request(server()).delete(`/api/v1${path}`)),
    };
  }

  async function login(subdomain: string, email: string): Promise<string> {
    const res = await request(server())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(subdomain))
      .send({ email, password: PASSWORD })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function register(subdomain: string): Promise<Session> {
    const email = `owner@${subdomain}.com`;
    const reg = await registerVerified(app, {
      clinicName: `Clinica ${subdomain}`,
      subdomain,
      email,
      password: PASSWORD,
      fullName: 'Dr. Owner',
    });
    return {
      tenantId: (reg.body as { tenantId: string }).tenantId,
      accessToken: await login(subdomain, email),
      subdomain,
    };
  }

  async function member(
    session: Session,
    role: ClinicRole,
  ): Promise<{ token: string; userId: string }> {
    const email = `${role.toLowerCase()}@${session.subdomain}.com`;
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await passwordService.hash(PASSWORD),
        fullName: `Staff ${role}`,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: { tenantId: session.tenantId, userId: user.id, role },
    });
    return { token: await login(session.subdomain, email), userId: user.id };
  }

  async function createPatient(
    session: Session,
    docNumber: string,
    extra: object = {},
    token = session.accessToken,
  ): Promise<PatientBody> {
    const res = await as(session, token)
      .post('/patients', {
        firstName: 'Ana',
        lastName: 'Datos',
        docType: DocType.CC,
        docNumber,
        sex: Sex.F,
        ...extra,
      })
      .expect(201);
    return res.body as PatientBody;
  }

  async function currentPolicy(session: Session): Promise<PolicyBody | null> {
    const res = await as(session).get('/privacy-policies').expect(200);
    return (res.body as { current: PolicyBody | null }).current;
  }

  beforeAll(async () => {
    // Montada como main.ts: el filtro global (con el de Prisma) da los 409.
    app = await createE2eApp();
    await cleanup();

    clinicA = await register('datos-a');
    clinicB = await register('datos-b');
    const reception = await member(clinicA, ClinicRole.RECEPTION);
    receptionA = reception.token;
    receptionAId = reception.userId;
    dentistA = (await member(clinicA, ClinicRole.DENTIST)).token;
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await app.close();
  });

  describe('sin política publicada', () => {
    it('GET devuelve vigente null e historial vacío', async () => {
      const res = await as(clinicA).get('/privacy-policies').expect(200);
      expect(res.body).toEqual({ current: null, history: [] });
    });

    it('registrar una autorización da 409 y no crea filas', async () => {
      const patient = await createPatient(clinicA, 'SIN-POL-1');
      const res = await as(clinicA)
        .post(`/patients/${patient.id}/data-consents`, {
          policyVersionId: '00000000-0000-4000-8000-000000000000',
          decisions: [{ scope: 'GENERAL', granted: true }],
        })
        .expect(409);
      expect((res.body as { message: string }).message).toMatch(
        /no ha publicado/,
      );
      expect(
        await raw.dataProcessingConsent.count({
          where: { patientId: patient.id },
        }),
      ).toBe(0);
    });
  });

  describe('publicar la política', () => {
    it('solo ADMIN publica (recepción y dentista: 403)', async () => {
      await as(clinicA, receptionA)
        .post('/privacy-policies', POLICY)
        .expect(403);
      await as(clinicA, dentistA).post('/privacy-policies', POLICY).expect(403);
    });

    it('rechaza un texto de datos sensibles sin las frases obligatorias (400)', async () => {
      const res = await as(clinicA)
        .post('/privacy-policies', {
          ...POLICY,
          sensitiveHealthText: 'Autorizo el uso de mis datos de salud.',
        })
        .expect(400);
      expect((res.body as { message: string }).message).toMatch(
        /no está obligado.*datos sensibles.*finalidad/,
      );
      expect(await currentPolicy(clinicA)).toBeNull();
    });

    it('ADMIN publica v1; todos los roles la leen', async () => {
      const res = await as(clinicA)
        .post('/privacy-policies', POLICY)
        .expect(201);
      const v1 = res.body as PolicyBody;
      expect(v1.version).toBe(1);
      expect(v1.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(v1.publishedBy.fullName).toBe('Dr. Owner');
      const seen = await as(clinicA, receptionA)
        .get('/privacy-policies')
        .expect(200);
      expect((seen.body as { current: PolicyBody }).current.id).toBe(v1.id);
    });

    it('no existe ruta para editar ni borrar una política publicada', async () => {
      const v1 = (await currentPolicy(clinicA)) as PolicyBody;
      await as(clinicA)
        .patch(`/privacy-policies/${v1.id}`, { policyText: 'cambio' })
        .expect(404);
      await as(clinicA)
        .put(`/privacy-policies/${v1.id}`, { policyText: 'cambio' })
        .expect(404);
      await as(clinicA).delete(`/privacy-policies/${v1.id}`).expect(404);
      const after = (await currentPolicy(clinicA)) as PolicyBody;
      expect(after).toEqual(v1);
    });
  });

  describe('autorización en el alta del paciente', () => {
    it('sin acción explícita no se crea ninguna fila', async () => {
      const patient = await createPatient(clinicA, 'ALTA-0');
      expect(patient.dataConsentAccepted).toBe(false);
      const res = await as(clinicA)
        .get(`/patients/${patient.id}/data-consents`)
        .expect(200);
      const body = res.body as ConsentsBody;
      expect(body.history).toEqual([]);
      expect(stateOf(body)).toEqual({
        GENERAL: null,
        SENSITIVE_HEALTH: null,
        MARKETING: null,
      });
    });

    it('recepción registra GENERAL + SENSITIVE_HEALTH con toda la evidencia', async () => {
      const policy = (await currentPolicy(clinicA)) as PolicyBody;
      const before = Date.now();
      const patient = await createPatient(
        clinicA,
        'ALTA-1',
        {
          dataConsents: {
            policyVersionId: policy.id,
            decisions: [
              { scope: 'GENERAL', granted: true },
              { scope: 'SENSITIVE_HEALTH', granted: true },
            ],
          },
          // Campo deprecado: ya no se acepta del cliente (hora del servidor).
          dataConsentAt: '2001-01-01T00:00:00.000Z',
        },
        receptionA,
      );
      const res = await as(clinicA)
        .get(`/patients/${patient.id}/data-consents`)
        .expect(200);
      const body = res.body as ConsentsBody;
      expect(body.history).toHaveLength(2);
      for (const row of body.history) {
        expect(row).toMatchObject({
          granted: true,
          channel: 'IN_PERSON',
          policyVersion: { id: policy.id, version: 1 },
          recordedBy: { id: receptionAId, fullName: 'Staff RECEPTION' },
          userAgent: USER_AGENT,
        });
        expect(row.ipAddress).toBeTruthy();
        expect(new Date(row.recordedAt).getTime()).toBeGreaterThanOrEqual(
          before - 1000,
        );
      }
      expect(stateOf(body)).toEqual({
        GENERAL: true,
        SENSITIVE_HEALTH: true,
        MARKETING: null,
      });
      // Resumen deprecado, derivado de la fila GENERAL.
      expect(patient.dataConsentAccepted).toBe(true);
      expect(patient.dataConsentPolicyVersion).toBe('v1');
      expect(patient.dataConsentAt).toBe(
        body.history.find((r) => r.scope === 'GENERAL')?.recordedAt,
      );
    });

    it('la IP sale de req.ip: X-Forwarded-For solo cuenta con TRUST_PROXY', async () => {
      const policy = (await currentPolicy(clinicA)) as PolicyBody;
      const SPOOFED = '203.0.113.77';
      const express = app.getHttpAdapter().getInstance() as {
        set: (key: string, value: unknown) => void;
      };
      const record = async (docNumber: string) => {
        const patient = await createPatient(clinicA, docNumber);
        await as(clinicA)
          .post(`/patients/${patient.id}/data-consents`, {
            policyVersionId: policy.id,
            decisions: [{ scope: 'GENERAL', granted: true }],
          })
          .set('X-Forwarded-For', SPOOFED)
          .expect(201);
        return raw.dataProcessingConsent.findFirstOrThrow({
          where: { patientId: patient.id },
        });
      };

      // TRUST_PROXY=false (.env.test): la cabecera del cliente no se cree.
      const untrusted = await record('IP-SIN-PROXY');
      expect(untrusted.ipAddress).toBeTruthy();
      expect(untrusted.ipAddress).not.toBe(SPOOFED);

      // TRUST_PROXY=true (1 salto, como applySecurity): la pone el proxy.
      express.set('trust proxy', 1);
      try {
        const trusted = await record('IP-CON-PROXY');
        expect(trusted.ipAddress).toBe(SPOOFED);
      } finally {
        express.set('trust proxy', false);
      }
    });

    it('si la autorización falla, el paciente tampoco se crea', async () => {
      await as(clinicA)
        .post('/patients', {
          firstName: 'Ana',
          lastName: 'Datos',
          docType: DocType.CC,
          docNumber: 'ALTA-FALLA',
          sex: Sex.F,
          dataConsents: {
            policyVersionId: '00000000-0000-4000-8000-000000000000',
            decisions: [{ scope: 'GENERAL', granted: true }],
          },
        })
        .expect(409);
      expect(
        await raw.patient.count({ where: { docNumber: 'ALTA-FALLA' } }),
      ).toBe(0);
    });

    it('el booleano deprecado de un cliente antiguo queda como fila LEGACY', async () => {
      const patient = await createPatient(clinicA, 'ALTA-LEGACY', {
        dataConsentAccepted: true,
        dataConsentPolicyVersion: 'v1',
      });
      expect(patient.dataConsentAccepted).toBe(true);
      const body = (
        await as(clinicA)
          .get(`/patients/${patient.id}/data-consents`)
          .expect(200)
      ).body as ConsentsBody;
      expect(body.history).toEqual([
        expect.objectContaining({
          scope: 'GENERAL',
          granted: true,
          channel: 'LEGACY',
          policyVersion: null,
          legacyPolicyVersion: 'v1',
        }),
      ]);
    });
  });

  describe('POST /patients/:id/data-consents', () => {
    let patientId: string;
    let policyId: string;

    beforeAll(async () => {
      policyId = ((await currentPolicy(clinicA)) as PolicyBody).id;
      patientId = (await createPatient(clinicA, 'REG-1')).id;
    });

    it('rechaza una petición sin decisiones o con scopes repetidos (400)', async () => {
      await as(clinicA)
        .post(`/patients/${patientId}/data-consents`, {
          policyVersionId: policyId,
          decisions: [],
        })
        .expect(400);
      await as(clinicA)
        .post(`/patients/${patientId}/data-consents`, {
          policyVersionId: policyId,
          decisions: [
            { scope: 'MARKETING', granted: true },
            { scope: 'MARKETING', granted: false },
          ],
        })
        .expect(400);
      expect(
        await raw.dataProcessingConsent.count({ where: { patientId } }),
      ).toBe(0);
    });

    it('un dentista registra la aceptación de MARKETING', async () => {
      const res = await as(clinicA, dentistA)
        .post(`/patients/${patientId}/data-consents`, {
          policyVersionId: policyId,
          decisions: [{ scope: 'MARKETING', granted: true }],
        })
        .expect(201);
      expect(stateOf(res.body as ConsentsBody).MARKETING).toBe(true);
    });

    it('revocar MARKETING crea una fila granted=false que pasa a ser la vigente', async () => {
      const res = await as(clinicA, receptionA)
        .post(`/patients/${patientId}/data-consents`, {
          policyVersionId: policyId,
          decisions: [{ scope: 'MARKETING', granted: false }],
        })
        .expect(201);
      const body = res.body as ConsentsBody;
      expect(stateOf(body).MARKETING).toBe(false);
      expect(body.history.map((r) => [r.scope, r.granted])).toEqual([
        ['MARKETING', false],
        ['MARKETING', true],
      ]);
      // La aceptación original sigue intacta en la BD.
      expect(
        await raw.dataProcessingConsent.count({
          where: { patientId, scope: 'MARKETING' },
        }),
      ).toBe(2);
    });

    it('no existe ruta para editar ni borrar una autorización', async () => {
      const rowId = (
        await raw.dataProcessingConsent.findFirstOrThrow({
          where: { patientId },
        })
      ).id;
      await as(clinicA)
        .patch(`/patients/${patientId}/data-consents/${rowId}`, {
          granted: true,
        })
        .expect(404);
      await as(clinicA)
        .put(`/patients/${patientId}/data-consents`, { granted: true })
        .expect(404);
      await as(clinicA)
        .delete(`/patients/${patientId}/data-consents/${rowId}`)
        .expect(404);
      await as(clinicA)
        .delete(`/patients/${patientId}/data-consents`)
        .expect(404);
    });

    it('tras publicar v2, una decisión contra v1 da 409; v1 queda intacta', async () => {
      const v1 = (await currentPolicy(clinicA)) as PolicyBody;
      const v2 = (
        await as(clinicA)
          .post('/privacy-policies', { ...POLICY, policyText: 'Versión 2.' })
          .expect(201)
      ).body as PolicyBody;
      expect(v2.version).toBe(2);
      await as(clinicA)
        .post(`/patients/${patientId}/data-consents`, {
          policyVersionId: v1.id,
          decisions: [{ scope: 'GENERAL', granted: true }],
        })
        .expect(409);
      const all = (await as(clinicA).get('/privacy-policies').expect(200))
        .body as { current: PolicyBody; history: PolicyBody[] };
      expect(all.current.id).toBe(v2.id);
      expect(all.history.map((p) => p.version)).toEqual([2, 1]);
      expect(all.history[1]).toEqual(v1);
    });
  });

  describe('aislamiento por clínica (RLS)', () => {
    let patientA: string;

    beforeAll(async () => {
      const policy = (await currentPolicy(clinicA)) as PolicyBody;
      patientA = (
        await createPatient(clinicA, 'RLS-A', {
          dataConsents: {
            policyVersionId: policy.id,
            decisions: [{ scope: 'GENERAL', granted: true }],
          },
        })
      ).id;
    });

    it('la clínica B no ve la política de la clínica A', async () => {
      expect(await currentPolicy(clinicB)).toBeNull();
    });

    it('la clínica B no lee ni escribe las autorizaciones de un paciente de A (404)', async () => {
      await as(clinicB).get(`/patients/${patientA}/data-consents`).expect(404);
      await as(clinicB).post('/privacy-policies', POLICY).expect(201);
      const policyB = (await currentPolicy(clinicB)) as PolicyBody;
      await as(clinicB)
        .post(`/patients/${patientA}/data-consents`, {
          policyVersionId: policyB.id,
          decisions: [{ scope: 'MARKETING', granted: true }],
        })
        .expect(404);
      expect(
        await raw.dataProcessingConsent.count({
          where: { patientId: patientA },
        }),
      ).toBe(1);
    });

    it('la clínica B no puede usar la política de A para su propio paciente (409)', async () => {
      const policyA = (await currentPolicy(clinicA)) as PolicyBody;
      const patientB = await createPatient(clinicB, 'RLS-B');
      await as(clinicB)
        .post(`/patients/${patientB.id}/data-consents`, {
          policyVersionId: policyA.id,
          decisions: [{ scope: 'GENERAL', granted: true }],
        })
        .expect(409);
    });
  });
});
