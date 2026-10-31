import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  CatalogKind,
  ClinicRole,
  Prisma,
  PrismaClient,
  Sex,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { applyBodyLimits } from '../src/config/body-limits';
import { PasswordService } from '../src/shared/crypto/password.service';
import { computeConsentHash } from '../src/modules/consents/domain/consent-hash';
import { MAX_SIGNATURE_BYTES } from '../src/modules/consents/domain/signature-image';
import { hostFor } from './support/tenant-host';
import { pngBombBase64, pngLyingBombBase64 } from './support/png-fixtures';
import { registerVerified } from './support/register-verified';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  registerBody,
} from './support/location-fixtures';

// DIRECT_URL (superusuario, sin RLS) solo para sembrar miembros con rol y
// limpiar — mismo criterio que account-statement.e2e-spec.ts. El borrado de
// patient_consents está permitido aquí porque esta conexión no fija
// `app.current_tenant` (ver el trigger de 20261016180000_patient_consents).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const PASSWORD = 'S3cret!!';

// PNG de 1x1 reales (firma + IHDR).
const PNG_A =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_B =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const DATA_A = `data:image/png;base64,${PNG_A}`;
const DATA_B = `data:image/png;base64,${PNG_B}`;

const TEMPLATE_BODY =
  'Yo, {{paciente}} ({{documento}}), autorizo a {{profesional}} de {{clinica}} ' +
  'a realizar: {{tratamiento}}. Fecha: {{fecha}}.';

interface Session {
  tenantId: string;
  accessToken: string;
  subdomain: string;
}

interface TemplateBody {
  id: string;
  title: string;
  body: string;
  active: boolean;
  version: number;
}

interface ConsentBody {
  id: string;
  tenantId: string;
  patientId: string;
  templateId: string;
  templateVersion: number;
  treatmentPlanId: string | null;
  title: string;
  body: string;
  signerType: string;
  signerName: string;
  signerDocument: string | null;
  professionalName: string;
  patientSignature: string;
  professionalSignature: string;
  contentHash: string;
  signedAt: string;
  recordedById: string;
  ipAddress?: string;
  userAgent?: string;
}

interface DocumentBody extends ConsentBody {
  clinic: { name: string; logoUrl: string | null };
  patient: {
    id: string;
    firstName: string;
    docType: string;
    docTypeLabel: string | null;
    docTypeName: string;
    docNumber: string | null;
  };
  integrityOk: boolean;
}

async function cleanup(): Promise<void> {
  await resetDatabase(raw);
}

describe('Consentimientos informados — /consent-templates y /patients/:id/consents (e2e)', () => {
  let app: INestApplication<App>;
  let clinicA: Session;
  let clinicB: Session;
  let dentistA: string;
  let assistantA: string;
  let receptionA: string;
  let dentistAId: string;
  let patientA: string;
  let otherPatientA: string;
  let patientB: string;
  let planA: string;
  let planOtherPatientA: string;
  let templateA: TemplateBody;
  let templateB: TemplateBody;

  const server = () => app.getHttpServer();

  function as(session: Session, token = session.accessToken) {
    const withAuth = (req: request.Test) =>
      req
        .set('X-Tenant-Host', hostFor(session.subdomain))
        .set('Authorization', `Bearer ${token}`);
    return {
      get: (path: string) => withAuth(request(server()).get(`/api/v1${path}`)),
      post: (path: string, body: object) =>
        withAuth(request(server()).post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) =>
        withAuth(request(server()).patch(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        withAuth(request(server()).put(`/api/v1${path}`)).send(body),
      delete: (path: string) =>
        withAuth(request(server()).delete(`/api/v1${path}`)),
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
    const reg = await registerVerified(
      app,
      registerBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: `Clinica ${subdomain}`,
        subdomain,
        email,
        password: PASSWORD,
        fullName: 'Dr. Owner',
      }),
    );
    return {
      tenantId: (reg.body as { tenantId: string }).tenantId,
      accessToken: await login(subdomain, email),
      subdomain,
    };
  }

  async function member(
    session: Session,
    role: ClinicRole,
    fullName: string,
  ): Promise<{ token: string; userId: string }> {
    const email = `${role.toLowerCase()}@${session.subdomain}.com`;
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await passwordService.hash(PASSWORD),
        fullName,
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
    firstName: string,
    docNumber: string,
    docTypeLabel?: string,
  ): Promise<string> {
    const res = await as(session)
      .post('/patients', {
        firstName,
        lastName: 'Consentida',
        docType: 'NATIONAL_ID',
        docTypeLabel,
        docNumber,
        sex: Sex.F,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function createPlan(patientId: string, catalogItemId: string) {
    const plan = await as(clinicA)
      .post(`/patients/${patientId}/treatment-plans`, { currency: 'USD' })
      .expect(201);
    const planId = (plan.body as { id: string }).id;
    await as(clinicA)
      .post(`/treatment-plans/${planId}/items`, {
        toothNumber: '48',
        catalogItemId,
        price: 100,
      })
      .expect(201);
    return planId;
  }

  function signBody(template: TemplateBody, extra: object = {}): object {
    return {
      templateId: template.id,
      templateVersion: template.version,
      signerType: 'PATIENT',
      patientSignature: DATA_A,
      professionalSignature: DATA_B,
      ...extra,
    };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    applyBodyLimits(app);
    await app.init();
    await app.listen(0, '127.0.0.1');
    await cleanup();

    clinicA = await register('consentimientos-a');
    clinicB = await register('consentimientos-b');
    const dentist = await member(
      clinicA,
      ClinicRole.DENTIST,
      'Dra. Laura Gómez',
    );
    dentistA = dentist.token;
    dentistAId = dentist.userId;
    assistantA = (await member(clinicA, ClinicRole.ASSISTANT, 'Asistente Uno'))
      .token;
    receptionA = (await member(clinicA, ClinicRole.RECEPTION, 'Recepción Uno'))
      .token;

    patientA = await createPatient(clinicA, 'Ana', 'CONS-A-1');
    otherPatientA = await createPatient(clinicA, 'Beatriz', 'CONS-A-2');
    patientB = await createPatient(clinicB, 'Carla', 'CONS-B-1');

    const catalog = await as(clinicA)
      .post('/catalog/items', {
        code: 'CONS-EXO',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Exodoncia simple',
        color: '#2A2B3C',
        defaultPrice: 100,
      })
      .expect(201);
    const catalogItemId = (catalog.body as { id: string }).id;
    planA = await createPlan(patientA, catalogItemId);
    planOtherPatientA = await createPlan(otherPatientA, catalogItemId);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  describe('plantillas', () => {
    it('ADMIN crea plantillas; las variables desconocidas dan 400 y el título repetido 409', async () => {
      const res = await as(clinicA)
        .post('/consent-templates', {
          title: 'Consentimiento de exodoncia',
          body: TEMPLATE_BODY,
        })
        .expect(201);
      templateA = res.body as TemplateBody;
      expect(templateA).toMatchObject({ active: true, version: 1 });

      const bad = await as(clinicA)
        .post('/consent-templates', { title: 'Mala', body: 'Hola {{edad}}' })
        .expect(400);
      expect((bad.body as { message: string }).message).toContain('{{edad}}');

      const dup = await as(clinicA)
        .post('/consent-templates', {
          title: 'Consentimiento de exodoncia',
          body: 'x',
        })
        .expect(409);
      expect((dup.body as { message: string }).message).toMatch(/plantilla/);

      templateB = (
        await as(clinicB)
          .post('/consent-templates', { title: 'De B', body: 'B {{paciente}}' })
          .expect(201)
      ).body as TemplateBody;
    });

    it('los clínicos leen pero no escriben; recepción ni lee', async () => {
      const list = await as(clinicA, dentistA)
        .get('/consent-templates')
        .expect(200);
      expect((list.body as TemplateBody[]).map((t) => t.id)).toEqual([
        templateA.id,
      ]);
      await as(clinicA, assistantA).get('/consent-templates').expect(200);

      await as(clinicA, dentistA)
        .post('/consent-templates', { title: 'X', body: 'x' })
        .expect(403);
      await as(clinicA, dentistA)
        .patch(`/consent-templates/${templateA.id}`, { active: false })
        .expect(403);
      await as(clinicA, receptionA).get('/consent-templates').expect(403);
    });

    it('una clínica no ve ni edita las plantillas de otra', async () => {
      const list = await as(clinicB).get('/consent-templates').expect(200);
      expect((list.body as TemplateBody[]).map((t) => t.id)).toEqual([
        templateB.id,
      ]);
      await as(clinicB)
        .patch(`/consent-templates/${templateA.id}`, { active: false })
        .expect(404);
    });
  });

  describe('firma', () => {
    let signed: ConsentBody;

    it('la vista previa resuelve las variables', async () => {
      const res = await as(clinicA, dentistA)
        .get(
          `/patients/${patientA}/consents/preview?templateId=${templateA.id}&treatmentPlanId=${planA}`,
        )
        .expect(200);
      const body = res.body as { body: string; templateVersion: number };
      expect(body.templateVersion).toBe(1);
      expect(body.body).toContain(
        'Yo, Ana Consentida (Documento nacional CONS-A-1)',
      );
      expect(body.body).toContain(
        'autorizo a Dra. Laura Gómez de Clinica consentimientos-a',
      );
      expect(body.body).toContain('a realizar: Exodoncia simple (diente 48).');
      expect(body.body).not.toContain('{{');
    });

    it('un dentista firma: guarda texto, firmas, hora del servidor, autor y hash', async () => {
      const before = Date.now();
      const res = await as(clinicA, dentistA)
        .post(
          `/patients/${patientA}/consents`,
          signBody(templateA, {
            treatmentPlanId: planA,
            // Campos que el cliente NO puede poner: se descartan.
            signedAt: '2000-01-01T00:00:00.000Z',
            recordedById: patientA,
            tenantId: clinicB.tenantId,
            contentHash: '0'.repeat(64),
          }),
        )
        .set('User-Agent', 'e2e-tablet')
        .expect(201);
      signed = res.body as ConsentBody;

      expect(signed).toMatchObject({
        tenantId: clinicA.tenantId,
        patientId: patientA,
        templateId: templateA.id,
        templateVersion: 1,
        treatmentPlanId: planA,
        title: 'Consentimiento de exodoncia',
        signerType: 'PATIENT',
        signerName: 'Ana Consentida',
        signerDocument: 'Documento nacional CONS-A-1',
        professionalName: 'Dra. Laura Gómez',
        patientSignature: DATA_A,
        professionalSignature: DATA_B,
        recordedById: dentistAId,
      });
      expect(signed.ipAddress).toBeUndefined();
      expect(signed.userAgent).toBeUndefined();
      const signedAt = new Date(signed.signedAt).getTime();
      expect(signedAt).toBeGreaterThanOrEqual(before - 1000);
      expect(signedAt).toBeLessThanOrEqual(Date.now() + 1000);
      expect(signed.contentHash).toBe(
        computeConsentHash({
          title: signed.title,
          body: signed.body,
          signerType: 'PATIENT',
          signerName: signed.signerName,
          signerDocument: signed.signerDocument,
          professionalName: signed.professionalName,
          patientSignature: PNG_A,
          professionalSignature: PNG_B,
          signedAt: new Date(signed.signedAt),
        }),
      );

      const row = await raw.patientConsent.findUniqueOrThrow({
        where: { id: signed.id },
      });
      expect(row.userAgent).toBe('e2e-tablet');
      expect(row.ipAddress).toBeTruthy();
      expect(row.patientSignature).toBe(PNG_A);
    });

    it('un asistente también firma; un tutor necesita nombre y documento', async () => {
      await as(clinicA, assistantA)
        .post(
          `/patients/${patientA}/consents`,
          signBody(templateA, {
            signerType: 'GUARDIAN',
            guardianName: 'Marta',
          }),
        )
        .expect(400);
      const res = await as(clinicA, assistantA)
        .post(
          `/patients/${patientA}/consents`,
          signBody(templateA, {
            signerType: 'GUARDIAN',
            guardianName: 'Marta Consentida',
            guardianDocument: 'DOC 777',
          }),
        )
        .expect(201);
      expect(res.body as ConsentBody).toMatchObject({
        signerType: 'GUARDIAN',
        signerName: 'Marta Consentida',
        signerDocument: 'DOC 777',
      });
    });

    it('400 sin firma del paciente, con una firma que no es PNG o de más de 200 KB', async () => {
      const count = await raw.patientConsent.count();
      for (const extra of [
        { patientSignature: '' },
        { patientSignature: undefined },
        {
          patientSignature: `data:image/png;base64,${Buffer.from('GIF89a no soy png').toString('base64')}`,
        },
        { professionalSignature: '' },
      ]) {
        await as(clinicA, dentistA)
          .post(`/patients/${patientA}/consents`, signBody(templateA, extra))
          .expect(400);
      }

      const header = Buffer.from(PNG_A, 'base64');
      const big = Buffer.concat([
        header,
        Buffer.alloc(MAX_SIGNATURE_BYTES - header.length + 1),
      ]).toString('base64');
      const tooBig = await as(clinicA, dentistA)
        .post(
          `/patients/${patientA}/consents`,
          signBody(templateA, { patientSignature: big }),
        )
        .expect(400);
      expect((tooBig.body as { message: string }).message).toMatch(/200 KB/);
      // La respuesta de error nunca repite la imagen.
      expect(JSON.stringify(tooBig.body)).not.toContain(big.slice(0, 64));
      expect(await raw.patientConsent.count()).toBe(count);
    });

    it('400 rápido con una bomba de descompresión en cualquiera de las dos firmas (SEC-026)', async () => {
      const count = await raw.patientConsent.count();
      const bomb = await as(clinicA, dentistA)
        .post(
          `/patients/${patientA}/consents`,
          signBody(templateA, {
            patientSignature: `data:image/png;base64,${pngBombBase64()}`,
          }),
        )
        .expect(400);
      expect((bomb.body as { message: string }).message).toBe(
        'La firma del paciente tiene unas dimensiones no válidas (máximo 4096 x 1024 píxeles y 4 millones de píxeles en total).',
      );
      const lying = await as(clinicA, dentistA)
        .post(
          `/patients/${patientA}/consents`,
          signBody(templateA, { professionalSignature: pngLyingBombBase64() }),
        )
        .expect(400);
      expect((lying.body as { message: string }).message).toBe(
        'La firma del profesional no es una imagen PNG válida.',
      );
      expect(await raw.patientConsent.count()).toBe(count);
    });

    it('la firma se valida después del paciente: una bomba sobre un paciente ajeno da 404 (SEC-026)', async () => {
      await as(clinicB)
        .post(
          `/patients/${patientA}/consents`,
          signBody(templateB, { patientSignature: pngBombBase64() }),
        )
        .expect(404);
    });

    it('el tope ampliado de cuerpo es solo para la firma: el resto sigue en 100 KB', async () => {
      await as(clinicA)
        .post('/patients', {
          firstName: 'Grande',
          lastName: 'Cuerpo',
          docType: 'NATIONAL_ID',
          notes: 'x'.repeat(150 * 1024),
          sex: Sex.F,
        })
        .expect(413);
    });

    it('recepción no puede firmar ni leer consentimientos (403)', async () => {
      await as(clinicA, receptionA)
        .post(`/patients/${patientA}/consents`, signBody(templateA))
        .expect(403);
      await as(clinicA, receptionA)
        .get(`/patients/${patientA}/consents`)
        .expect(403);
      await as(clinicA, receptionA)
        .get(`/patients/${patientA}/consents/${signed.id}`)
        .expect(403);
    });

    it('el plan tiene que ser de ESE paciente', async () => {
      await as(clinicA, dentistA)
        .post(
          `/patients/${patientA}/consents`,
          signBody(templateA, { treatmentPlanId: planOtherPatientA }),
        )
        .expect(404);
    });

    it('editar la plantilla NO cambia lo firmado; firmar con la versión vieja da 409', async () => {
      const edited = await as(clinicA)
        .patch(`/consent-templates/${templateA.id}`, {
          title: 'Exodoncia (v2)',
          body: 'Texto nuevo para {{paciente}}.',
        })
        .expect(200);
      expect((edited.body as TemplateBody).version).toBe(2);

      const doc = await as(clinicA, dentistA)
        .get(`/patients/${patientA}/consents/${signed.id}`)
        .expect(200);
      const body = doc.body as DocumentBody;
      expect(body.title).toBe('Consentimiento de exodoncia');
      expect(body.body).toBe(signed.body);
      expect(body.contentHash).toBe(signed.contentHash);
      expect(body.integrityOk).toBe(true);
      expect(body.clinic.name).toBe('Clinica consentimientos-a');
      expect(body.patient).toMatchObject({ id: patientA, firstName: 'Ana' });

      await as(clinicA, dentistA)
        .post(`/patients/${patientA}/consents`, signBody(templateA))
        .expect(409);
      templateA = edited.body as TemplateBody;
    });

    it('una plantilla desactivada no se ofrece ni se firma', async () => {
      await as(clinicA)
        .patch(`/consent-templates/${templateA.id}`, { active: false })
        .expect(200);
      const active = await as(clinicA, dentistA)
        .get('/consent-templates?active=true')
        .expect(200);
      expect(active.body).toEqual([]);
      await as(clinicA, dentistA)
        .post(`/patients/${patientA}/consents`, signBody(templateA))
        .expect(400);
      await as(clinicA)
        .patch(`/consent-templates/${templateA.id}`, { active: true })
        .expect(200);
    });

    it('lista los del paciente, sin firmas, más reciente primero', async () => {
      const res = await as(clinicA, dentistA)
        .get(`/patients/${patientA}/consents`)
        .expect(200);
      const list = res.body as ConsentBody[];
      expect(list).toHaveLength(2);
      expect(list[1].id).toBe(signed.id);
      expect(list[0].patientSignature).toBeUndefined();
      expect(list[0].body).toBeUndefined();

      const empty = await as(clinicA, dentistA)
        .get(`/patients/${otherPatientA}/consents`)
        .expect(200);
      expect(empty.body).toEqual([]);
    });

    it('no existe endpoint para modificar ni borrar un consentimiento firmado', async () => {
      const path = `/patients/${patientA}/consents/${signed.id}`;
      await as(clinicA).patch(path, { body: 'alterado' }).expect(404);
      await as(clinicA).put(path, { body: 'alterado' }).expect(404);
      await as(clinicA).delete(path).expect(404);
      await as(clinicA).delete(`/patients/${patientA}/consents`).expect(404);

      const row = await raw.patientConsent.findUniqueOrThrow({
        where: { id: signed.id },
      });
      expect(row.body).toBe(signed.body);
    });
  });

  describe('aislamiento entre clínicas', () => {
    // ISOLATION_COVERS: GET /patients/:patientId/consents
    // ISOLATION_COVERS: GET /patients/:patientId/consents/preview
    // ISOLATION_COVERS: POST /patients/:patientId/consents
    // ISOLATION_COVERS: GET /patients/:patientId/consents/:id
    it('la clínica B no ve ni crea consentimientos sobre pacientes de A', async () => {
      const [consent] = await raw.patientConsent.findMany({
        where: { patientId: patientA },
        take: 1,
      });

      await as(clinicB).get(`/patients/${patientA}/consents`).expect(404);
      await as(clinicB)
        .get(`/patients/${patientA}/consents/${consent.id}`)
        .expect(404);
      await as(clinicB)
        .get(
          `/patients/${patientA}/consents/preview?templateId=${templateB.id}`,
        )
        .expect(404);
      await as(clinicB)
        .post(`/patients/${patientA}/consents`, signBody(templateB))
        .expect(404);
      // Paciente propio con plantilla o plan de A: tampoco.
      await as(clinicB)
        .post(`/patients/${patientB}/consents`, signBody(templateA))
        .expect(404);
      await as(clinicB)
        .post(
          `/patients/${patientB}/consents`,
          signBody(templateB, { treatmentPlanId: planA }),
        )
        .expect(404);
      // Un consentimiento de A pedido bajo un paciente de B.
      await as(clinicB)
        .get(`/patients/${patientB}/consents/${consent.id}`)
        .expect(404);

      expect(
        await raw.patientConsent.count({
          where: { tenantId: clinicB.tenantId },
        }),
      ).toBe(0);
    });
  });

  describe('nombre del documento (DX-327)', () => {
    let template: TemplateBody;

    const read = async (patientId: string, id: string) =>
      (
        await as(clinicA, dentistA)
          .get(`/patients/${patientId}/consents/${id}`)
          .expect(200)
      ).body as DocumentBody;

    beforeAll(async () => {
      template = (
        await as(clinicA)
          .post('/consent-templates', {
            title: 'Consentimiento con documento',
            body: 'Yo, {{paciente}} ({{documento}}), autorizo.',
          })
          .expect(201)
      ).body as TemplateBody;
    });

    it('a new consent signs with the free label', async () => {
      const patient = await createPatient(
        clinicA,
        'Lia',
        'CONS-A-40',
        'ID local',
      );
      const signed = (
        await as(clinicA, dentistA)
          .post(`/patients/${patient}/consents`, signBody(template))
          .expect(201)
      ).body as ConsentBody;
      expect(signed.body).toBe(
        'Yo, Lia Consentida (ID local CONS-A-40), autorizo.',
      );
      expect(signed.signerDocument).toBe('ID local CONS-A-40');

      const doc = await read(patient, signed.id);
      expect(doc.integrityOk).toBe(true);
      expect(doc.patient).toMatchObject({
        docType: 'NATIONAL_ID',
        docTypeLabel: 'ID local',
        docTypeName: 'ID local',
        docNumber: 'CONS-A-40',
      });
    });

    it('legacy signed consent keeps its frozen document and integrity', async () => {
      const patient = await createPatient(clinicA, 'Vera', 'CONS-L-1');
      const signedAt = new Date('2026-10-16T15:00:00.000Z');
      const frozen = {
        title: 'Consentimiento anterior',
        body: 'Yo, Vera Consentida (CC CONS-L-1), autorizo.',
        signerType: 'PATIENT' as const,
        signerName: 'Vera Consentida',
        signerDocument: 'CC CONS-L-1',
        professionalName: 'Dra. Laura Gómez',
        patientSignature: PNG_A,
        professionalSignature: PNG_B,
        signedAt,
      };
      const row = await raw.patientConsent.create({
        data: {
          ...frozen,
          tenantId: clinicA.tenantId,
          patientId: patient,
          templateId: template.id,
          templateVersion: template.version,
          contentHash: computeConsentHash(frozen),
          recordedById: dentistAId,
        },
        select: { id: true },
      });
      await raw.tenant.update({
        where: { id: clinicA.tenantId },
        data: { docTypeNameNationalId: 'Documento A' },
      });
      try {
        const doc = await read(patient, row.id);
        expect(doc).toMatchObject({
          body: frozen.body,
          signerDocument: 'CC CONS-L-1',
          integrityOk: true,
        });
        // La cabecera es en vivo: el nombre local de hoy.
        expect(doc.patient).toMatchObject({
          docType: 'NATIONAL_ID',
          docTypeLabel: null,
          docTypeName: 'Documento A',
        });
      } finally {
        await raw.tenant.update({
          where: { id: clinicA.tenantId },
          data: { docTypeNameNationalId: null },
        });
      }
    });
  });
});
