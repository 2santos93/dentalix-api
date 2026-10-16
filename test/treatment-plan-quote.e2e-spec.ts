import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  CatalogKind,
  ClinicRole,
  DocType,
  PrismaClient,
  Sex,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { applyBodyLimits } from '../src/config/body-limits';
import { PasswordService } from '../src/shared/crypto/password.service';
import { MAX_SIGNATURE_BYTES } from '../src/modules/consents/domain/signature-image';
import { hostFor } from './support/tenant-host';

// DIRECT_URL (superusuario, sin RLS) solo para sembrar miembros con rol,
// inspeccionar y limpiar. Borrar treatment_plan_acceptances está permitido aquí
// porque esta conexión no fija `app.current_tenant` (ver el trigger de
// 20261016213000_treatment_plan_acceptances).
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const PASSWORD = 'S3cret!!';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SIGNATURE = `data:image/png;base64,${PNG}`;

interface Session {
  tenantId: string;
  accessToken: string;
  subdomain: string;
}

interface QuoteBody {
  planId: string;
  patientId: string;
  planStatus: string;
  currency: string;
  clinicName: string;
  clinicLogoUrl: string | null;
  location: { id: string; name: string; address: string | null };
  patient: { name: string; document: string | null };
  professionalName: string | null;
  issuedOn: string;
  validUntil: string;
  validityDays: number;
  items: {
    id: string;
    toothNumber: string;
    surfaces: string[];
    procedure: string;
    quantity: number;
    unitPrice: number;
    discount: number;
    subtotal: number;
  }[];
  totals: { currency: string; gross: number; discount: number; net: number }[];
  contentHash: string;
  acceptance: null | {
    signerName: string;
    signature: string;
    acceptedAt: string;
    acceptedByName: string;
    acceptanceHash: string;
    integrityOk: boolean;
  };
}

async function cleanup(): Promise<void> {
  await raw.treatmentPlanAcceptance.deleteMany();
  await raw.patientConsent.deleteMany();
  await raw.toothRecord.deleteMany();
  await raw.payment.deleteMany();
  await raw.treatmentPlanItem.deleteMany();
  await raw.treatmentPlan.deleteMany();
  await raw.dentalCatalogItem.deleteMany();
  await raw.patient.deleteMany();
  await raw.locationScheduleRange.deleteMany();
  await raw.locationSchedule.deleteMany();
  await raw.location.deleteMany();
  await raw.clinicMembership.deleteMany();
  await raw.user.deleteMany();
  await raw.tenantDomain.deleteMany();
  await raw.tenant.deleteMany();
}

describe('Presupuesto imprimible y aceptación firmada — /patients/:id/treatment-plans/:planId/{quote,acceptance} (e2e, DX-012)', () => {
  let app: INestApplication<App>;
  let clinicA: Session;
  let clinicB: Session;
  let dentistA: string;
  let assistantA: string;
  let receptionA: string;
  let patientA: string;
  let otherPatientA: string;
  let patientB: string;
  let catalogA: string;
  let planA: string;
  let itemA1: string;
  let planB: string;
  let northLocationA: string;
  let locationB: string;

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
    const reg = await request(server())
      .post('/api/v1/auth/register')
      .send({
        clinicName: `Clinica ${subdomain}`,
        subdomain,
        email,
        password: PASSWORD,
        fullName: 'Dr. Owner',
      })
      .expect(201);
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
  ): Promise<string> {
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
    return login(session.subdomain, email);
  }

  async function createPatient(
    session: Session,
    firstName: string,
    docNumber: string,
  ): Promise<string> {
    const res = await as(session)
      .post('/patients', {
        firstName,
        lastName: 'Presupuesto',
        docType: DocType.CC,
        docNumber,
        sex: Sex.F,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function createCatalog(session: Session, code: string) {
    const res = await as(session)
      .post('/catalog/items', {
        code,
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Corona de zirconio',
        color: '#336699',
        defaultPrice: 1000,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function createPlan(
    session: Session,
    patientId: string,
    token = session.accessToken,
  ): Promise<string> {
    const res = await as(session, token)
      .post(`/patients/${patientId}/treatment-plans`, { currency: 'USD' })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function addItem(
    session: Session,
    planId: string,
    body: object,
  ): Promise<string> {
    const res = await as(session)
      .post(`/treatment-plans/${planId}/items`, body)
      .expect(201);
    return (res.body as { id: string }).id;
  }

  const quotePath = (patientId: string, planId: string) =>
    `/patients/${patientId}/treatment-plans/${planId}/quote`;
  const acceptPath = (patientId: string, planId: string) =>
    `/patients/${patientId}/treatment-plans/${planId}/acceptance`;

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
    await cleanup();

    clinicA = await register('presupuesto-a');
    clinicB = await register('presupuesto-b');
    dentistA = await member(clinicA, ClinicRole.DENTIST, 'Dra. Laura Gómez');
    assistantA = await member(clinicA, ClinicRole.ASSISTANT, 'Asistente Uno');
    receptionA = await member(clinicA, ClinicRole.RECEPTION, 'Recepción Uno');

    patientA = await createPatient(clinicA, 'Ana', 'PRES-A-1');
    otherPatientA = await createPatient(clinicA, 'Beatriz', 'PRES-A-2');
    patientB = await createPatient(clinicB, 'Carla', 'PRES-B-1');
    catalogA = await createCatalog(clinicA, 'PRES-COR');

    planA = await createPlan(clinicA, patientA, dentistA);
    itemA1 = await addItem(clinicA, planA, {
      toothNumber: '36',
      catalogItemId: catalogA,
      price: 1000,
      discount: 150.5,
    });
    await addItem(clinicA, planA, {
      toothNumber: '16',
      surfaces: ['OCCLUSAL', 'MESIAL'],
      catalogItemId: catalogA,
      price: 200,
    });

    const north = await as(clinicA)
      .post('/locations', { name: 'Sede Norte', address: 'Cra 7 # 100-20' })
      .expect(201);
    northLocationA = (north.body as { id: string }).id;
    const catalogB = await createCatalog(clinicB, 'PRES-COR-B');
    planB = await createPlan(clinicB, patientB);
    await addItem(clinicB, planB, {
      toothNumber: '11',
      catalogItemId: catalogB,
    });
    const locB = await raw.location.findFirstOrThrow({
      where: { tenantId: clinicB.tenantId },
      select: { id: true },
    });
    locationB = locB.id;
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await app.close();
  });

  describe('GET …/quote', () => {
    it('compone el presupuesto: clínica, sede, paciente, profesional, ítems, totales y validez de 30 días', async () => {
      const res = await as(clinicA).get(quotePath(patientA, planA)).expect(200);
      const quote = res.body as QuoteBody;

      expect(quote.planId).toBe(planA);
      expect(quote.planStatus).toBe('DRAFT');
      expect(quote.clinicName).toBe('Clinica presupuesto-a');
      expect(quote.location.name).toBeTruthy();
      expect(quote.patient).toEqual({
        name: 'Ana Presupuesto',
        document: 'CC PRES-A-1',
      });
      expect(quote.professionalName).toBe('Dra. Laura Gómez');
      expect(quote.validityDays).toBe(30);
      const issued = new Date(`${quote.issuedOn}T00:00:00Z`);
      const until = new Date(`${quote.validUntil}T00:00:00Z`);
      expect((until.getTime() - issued.getTime()) / 86_400_000).toBe(30);
      expect(quote.items).toEqual([
        expect.objectContaining({
          id: itemA1,
          toothNumber: '36',
          procedure: 'Corona de zirconio',
          quantity: 1,
          unitPrice: 1000,
          discount: 150.5,
          subtotal: 849.5,
        }),
        expect.objectContaining({
          toothNumber: '16',
          surfaces: ['OCCLUSAL', 'MESIAL'],
          discount: 0,
          subtotal: 200,
        }),
      ]);
      expect(quote.totals).toEqual([
        { currency: 'USD', gross: 1200, discount: 150.5, net: 1049.5 },
      ]);
      expect(quote.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(quote.acceptance).toBeNull();
    });

    it('la sede del encabezado es la del request (X-Location-Id)', async () => {
      const res = await as(clinicA)
        .get(quotePath(patientA, planA))
        .set('X-Location-Id', northLocationA)
        .expect(200);
      expect((res.body as QuoteBody).location).toEqual({
        id: northLocationA,
        name: 'Sede Norte',
        address: 'Cra 7 # 100-20',
      });
    });

    it('la sede de otra clínica en X-Location-Id no vale (400)', async () => {
      await as(clinicA)
        .get(quotePath(patientA, planA))
        .set('X-Location-Id', locationB)
        .expect(400);
    });

    it('recepción, asistente y odontólogo pueden imprimirlo', async () => {
      for (const token of [receptionA, assistantA, dentistA]) {
        await as(clinicA, token).get(quotePath(patientA, planA)).expect(200);
      }
    });

    it('otra clínica recibe 404 (su paciente y su plan, o el plan ajeno)', async () => {
      await as(clinicB).get(quotePath(patientA, planA)).expect(404);
      await as(clinicA).get(quotePath(patientB, planB)).expect(404);
      await as(clinicA).get(quotePath(patientA, planB)).expect(404);
    });

    it('el plan de otro paciente de la misma clínica: 404', async () => {
      await as(clinicA).get(quotePath(otherPatientA, planA)).expect(404);
    });

    it('ids que no son UUID: 400', async () => {
      await as(clinicA).get(quotePath('nope', planA)).expect(400);
      await as(clinicA).get(quotePath(patientA, 'nope')).expect(400);
    });

    it('un plan sin ítems se puede imprimir con totales en cero', async () => {
      const empty = await createPlan(clinicA, otherPatientA);
      const res = await as(clinicA)
        .get(quotePath(otherPatientA, empty))
        .expect(200);
      const quote = res.body as QuoteBody;
      expect(quote.items).toEqual([]);
      expect(quote.totals).toEqual([
        { currency: 'USD', gross: 0, discount: 0, net: 0 },
      ]);
      expect(quote.professionalName).toBe('Dr. Owner');
    });
  });

  describe('POST …/acceptance', () => {
    let shownHash: string;

    beforeAll(async () => {
      const res = await as(clinicA, dentistA).get(quotePath(patientA, planA));
      shownHash = (res.body as QuoteBody).contentHash;
    });

    it('recepción no puede aceptar (403): el permiso sigue las reglas del plan', async () => {
      await as(clinicA, receptionA)
        .post(acceptPath(patientA, planA), {
          signerName: 'Ana Presupuesto',
          signature: SIGNATURE,
          contentHash: shownHash,
        })
        .expect(403);
    });

    it('sin firma no se acepta (400)', async () => {
      for (const signature of ['', 'data:image/jpeg;base64,AAAA']) {
        await as(clinicA, dentistA)
          .post(acceptPath(patientA, planA), {
            signerName: 'Ana',
            signature,
            contentHash: shownHash,
          })
          .expect(400);
      }
      await as(clinicA, dentistA)
        .post(acceptPath(patientA, planA), {
          signerName: 'Ana',
          contentHash: shownHash,
        })
        .expect(400);
    });

    it('una firma de más de 200 KB: 400', async () => {
      const big = Buffer.alloc(MAX_SIGNATURE_BYTES + 3, 0);
      Buffer.from(PNG, 'base64').copy(big);
      await as(clinicA, dentistA)
        .post(acceptPath(patientA, planA), {
          signerName: 'Ana',
          signature: big.toString('base64'),
          contentHash: shownHash,
        })
        .expect(400);
    });

    it('un plan sin ítems no se acepta (400)', async () => {
      const empty = await createPlan(clinicA, otherPatientA);
      const quote = await as(clinicA).get(quotePath(otherPatientA, empty));
      await as(clinicA, dentistA)
        .post(acceptPath(otherPatientA, empty), {
          signerName: 'Beatriz',
          signature: SIGNATURE,
          contentHash: (quote.body as QuoteBody).contentHash,
        })
        .expect(400);
    });

    it('otra clínica: 404', async () => {
      await as(clinicB)
        .post(acceptPath(patientA, planA), {
          signerName: 'Ana',
          signature: SIGNATURE,
          contentHash: shownHash,
        })
        .expect(404);
    });

    it('si el presupuesto cambió desde que se mostró: 409 y no se firma', async () => {
      await as(clinicA, dentistA)
        .post(acceptPath(patientA, planA), {
          signerName: 'Ana',
          signature: SIGNATURE,
          contentHash: 'f'.repeat(64),
        })
        .expect(409);
      expect(
        await raw.treatmentPlanAcceptance.count({ where: { planId: planA } }),
      ).toBe(0);
    });

    it('acepta con la firma: registra quién, cuándo y el hash del contenido presentado', async () => {
      const before = Date.now();
      const res = await as(clinicA, dentistA)
        .post(acceptPath(patientA, planA), {
          signerName: '  Ana Presupuesto ',
          signature: SIGNATURE,
          contentHash: shownHash,
        })
        .set('User-Agent', 'tableta-recepcion')
        .expect(201);
      const quote = res.body as QuoteBody;
      expect(quote.planStatus).toBe('ACCEPTED');
      expect(quote.contentHash).toBe(shownHash);
      expect(quote.acceptance).toEqual({
        signerName: 'Ana Presupuesto',
        signature: SIGNATURE,
        acceptedAt: expect.any(String) as string,
        acceptedByName: 'Dra. Laura Gómez',
        acceptanceHash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
        integrityOk: true,
      });
      expect(
        new Date(quote.acceptance!.acceptedAt).getTime(),
      ).toBeGreaterThanOrEqual(before - 1000);

      const row = await raw.treatmentPlanAcceptance.findFirstOrThrow({
        where: { planId: planA },
      });
      expect(row).toMatchObject({
        tenantId: clinicA.tenantId,
        patientId: patientA,
        signerName: 'Ana Presupuesto',
        signature: PNG,
        contentHash: shownHash,
        userAgent: 'tableta-recepcion',
      });
      // El plan pasa a ACCEPTED y sus ítems propuestos, a aceptados.
      const items = await raw.treatmentPlanItem.findMany({
        where: { planId: planA },
      });
      expect(items.map((i) => i.status)).toEqual(['ACCEPTED', 'ACCEPTED']);
    });

    it('volver a firmar: 409', async () => {
      await as(clinicA, dentistA)
        .post(acceptPath(patientA, planA), {
          signerName: 'Ana',
          signature: SIGNATURE,
          contentHash: shownHash,
        })
        .expect(409);
    });

    it('el detalle del plan dice quién firmó y cuándo', async () => {
      const res = await as(clinicA)
        .get(`/treatment-plans/${planA}`)
        .expect(200);
      const plan = res.body as {
        status: string;
        acceptance: { signerName: string; acceptedAt: string } | null;
      };
      expect(plan.status).toBe('ACCEPTED');
      expect(plan.acceptance).toEqual({
        signerName: 'Ana Presupuesto',
        acceptedAt: expect.any(String) as string,
      });
    });

    it('los ítems del plan firmado no admiten cambios (409)', async () => {
      await as(clinicA)
        .post(`/treatment-plans/${planA}/items`, {
          toothNumber: '11',
          catalogItemId: catalogA,
        })
        .expect(409);
      await as(clinicA)
        .patch(`/treatment-plans/${planA}/items/${itemA1}`, { price: 1 })
        .expect(409);
      await as(clinicA)
        .patch(`/treatment-plans/${planA}/items/${itemA1}`, { discount: 0 })
        .expect(409);
      await as(clinicA)
        .patch(`/treatment-plans/${planA}/items/${itemA1}`, {
          status: 'PROPOSED',
        })
        .expect(409);
      await as(clinicA)
        .delete(`/treatment-plans/${planA}/items/${itemA1}`)
        .expect(409);
      await as(clinicA)
        .patch(`/treatment-plans/${planA}`, { currency: 'EUR' })
        .expect(409);
      await as(clinicA)
        .patch(`/treatment-plans/${planA}`, { status: 'DRAFT' })
        .expect(409);
    });

    it('el tratamiento sí avanza: el ítem pasa a realizado', async () => {
      const res = await as(clinicA)
        .patch(`/treatment-plans/${planA}/items/${itemA1}`, { status: 'DONE' })
        .expect(200);
      expect((res.body as { status: string }).status).toBe('DONE');
    });

    it('la vista imprimible enseña la foto firmada aunque cambie el catálogo, y sigue íntegra', async () => {
      await as(clinicA)
        .patch(`/catalog/items/${catalogA}`, { labelEs: 'Nombre nuevo' })
        .expect(200);
      const res = await as(clinicA, receptionA)
        .get(quotePath(patientA, planA))
        .set('X-Location-Id', northLocationA)
        .expect(200);
      const quote = res.body as QuoteBody;
      expect(quote.contentHash).toBe(shownHash);
      expect(quote.items.map((i) => i.procedure)).toEqual([
        'Corona de zirconio',
        'Corona de zirconio',
      ]);
      // La sede es la de la firma, no la del request.
      expect(quote.location.id).not.toBe(northLocationA);
      expect(quote.acceptance?.integrityOk).toBe(true);
      expect(quote.acceptance?.signature).toBe(SIGNATURE);
    });

    it('si la fila se altera por fuera de la app, integrityOk=false', async () => {
      await raw.$executeRaw`ALTER TABLE "treatment_plan_acceptances" DISABLE TRIGGER "treatment_plan_acceptances_immutable"`;
      try {
        await raw.treatmentPlanAcceptance.updateMany({
          where: { planId: planA },
          data: { signerName: 'Otra persona' },
        });
      } finally {
        await raw.$executeRaw`ALTER TABLE "treatment_plan_acceptances" ENABLE TRIGGER "treatment_plan_acceptances_immutable"`;
      }
      const res = await as(clinicA).get(quotePath(patientA, planA)).expect(200);
      expect((res.body as QuoteBody).acceptance?.integrityOk).toBe(false);
    });

    it('el saldo y el estado de cuenta descuentan el descuento del ítem', async () => {
      const balance = await as(clinicA)
        .get(`/treatment-plans/${planA}/balance`)
        .expect(200);
      expect((balance.body as { billable: number }).billable).toBe(1049.5);
      const statement = await as(clinicA)
        .get(`/patients/${patientA}/account-statement`)
        .expect(200);
      const plans = (
        statement.body as { plans: { id: string; budgeted: number }[] }
      ).plans;
      expect(plans.find((p) => p.id === planA)?.budgeted).toBe(1049.5);
    });
  });
});
