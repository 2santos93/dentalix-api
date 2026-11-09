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
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  registerBody,
} from './support/location-fixtures';
import { PLAN_QUOTE_CLOCK } from '../src/modules/treatment-plans/application/use-cases/plan-quote.use-cases';
import { TREATMENT_PLAN_CLOCK } from '../src/modules/treatment-plans/application/plan-clock';
import { QUOTE_VALIDITY_DAYS_MESSAGE } from '../src/modules/treatment-plans/domain/quote-validity';
import { QUOTE_SETTINGS_FORBIDDEN_MESSAGE } from '../src/modules/treatment-plans/presentation/quote-settings.controller';

// DX-379 (porción A) contra Postgres: el ajuste de días (solo ADMIN, auditado,
// por clínica), presentar e imprimir fijan la validez, reimprimir otro día no
// la mueve, `quoteExpired` con el día civil de la sede (Caracas, UTC−4) y los
// CHECK de la base. Reloj falso en los dos relojes del módulo.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const passwordService = new PasswordService();
const PASSWORD = 'S3cret!!';
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Lunes 9 nov 2026, 11:00 en Caracas.
let now = new Date('2026-11-09T15:00:00.000Z');
const clock = () => now;

interface Session {
  tenantId: string;
  accessToken: string;
  subdomain: string;
}

interface PlanBody {
  id: string;
  status: string;
  quoteIssuedOn: string | null;
  quoteValidUntil: string | null;
  quoteExpired: boolean;
}

interface QuoteBody {
  issuedOn: string;
  validUntil: string;
  validityDays: number;
  contentHash: string;
  planStatus: string;
}

describe('Validez del presupuesto (e2e, DX-379 porción A)', () => {
  let app: INestApplication<App>;
  let clinicA: Session;
  let clinicB: Session;
  const tokens: Partial<Record<ClinicRole, string>> = {};
  let patientA: string;
  let catalogA: string;
  let createdDays: number[] = [];

  const server = () => app.getHttpServer();

  function as(session: Session, token = session.accessToken) {
    const withAuth = (req: request.Test) =>
      req
        .set('X-Tenant-Host', hostFor(session.subdomain))
        .set('Authorization', `Bearer ${token}`);
    return {
      get: (path: string) => withAuth(request(server()).get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        withAuth(request(server()).post(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        withAuth(request(server()).put(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) =>
        withAuth(request(server()).patch(`/api/v1${path}`)).send(body),
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
      registerBody(REGIONAL_CARACAS_FIXTURE, {
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

  async function member(session: Session, role: ClinicRole): Promise<string> {
    const email = `${role.toLowerCase()}@${session.subdomain}.com`;
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await passwordService.hash(PASSWORD),
        fullName: `Miembro ${role}`,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: { tenantId: session.tenantId, userId: user.id, role },
    });
    return login(session.subdomain, email);
  }

  /** Plan en borrador en VES (la moneda del catálogo de la sede) con un ítem. */
  async function draftPlan(): Promise<string> {
    const plan = await as(clinicA)
      .post(`/patients/${patientA}/treatment-plans`, { currency: 'VES' })
      .expect(201);
    const planId = (plan.body as { id: string }).id;
    await as(clinicA)
      .post(`/treatment-plans/${planId}/items`, {
        toothNumber: '36',
        catalogItemId: catalogA,
        price: 450,
      })
      .expect(201);
    return planId;
  }

  const present = async (planId: string) =>
    (await as(clinicA).post(`/treatment-plans/${planId}/present`).expect(200))
      .body as PlanBody;
  const getPlan = async (planId: string) =>
    (await as(clinicA).get(`/treatment-plans/${planId}`).expect(200))
      .body as PlanBody;
  const quotePath = (planId: string) =>
    `/patients/${patientA}/treatment-plans/${planId}/quote`;
  const getQuote = async (planId: string) =>
    (await as(clinicA).get(quotePath(planId)).expect(200)).body as QuoteBody;
  const issue = async (planId: string, token?: string) =>
    (
      await as(clinicA, token)
        .post(`${quotePath(planId)}/issue`)
        .expect(200)
    ).body as QuoteBody;
  const setDays = (validityDays: unknown, token?: string) =>
    as(clinicA, token).put('/treatment-plan-settings', { validityDays });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PLAN_QUOTE_CLOCK)
      .useValue(clock)
      .overrideProvider(TREATMENT_PLAN_CLOCK)
      .useValue(clock)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    applyBodyLimits(app);
    await app.init();
    await app.listen(0, '127.0.0.1');
    await resetDatabase(raw);

    clinicA = await register('validez-a');
    clinicB = await register('validez-b');
    // Lo que deja el alta de clínica, antes de que ningún caso lo toque.
    createdDays = (
      await raw.tenant.findMany({
        where: { id: { in: [clinicA.tenantId, clinicB.tenantId] } },
        select: { quoteValidityDays: true },
      })
    ).map((t) => t.quoteValidityDays);
    tokens.ADMIN = clinicA.accessToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      tokens[role] = await member(clinicA, role);
    }
    const patient = await as(clinicA)
      .post('/patients', {
        firstName: 'Ana',
        lastName: 'Validez',
        docType: 'NATIONAL_ID',
        docNumber: 'VAL-1',
        sex: Sex.F,
      })
      .expect(201);
    patientA = (patient.body as { id: string }).id;
    const catalog = await as(clinicA)
      .post('/catalog/items', {
        code: 'VAL-COR',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Corona',
        color: '#336699',
        defaultPrice: 450,
      })
      .expect(201);
    catalogA = (catalog.body as { id: string }).id;
  });

  // M-7: cada caso empieza con el reloj y el ajuste de plataforma (30) en
  // las dos clínicas, sin depender del orden. Por SQL: no deja auditoría.
  beforeEach(async () => {
    now = new Date('2026-11-09T15:00:00.000Z');
    await raw.tenant.updateMany({
      where: { id: { in: [clinicA.tenantId, clinicB.tenantId] } },
      data: { quoteValidityDays: 30 },
    });
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await app.close();
  });

  describe('ajuste GET/PUT /treatment-plan-settings', () => {
    it('una clínica nueva nace con 30 días y lo leen los cuatro roles', async () => {
      for (const role of Object.keys(tokens) as ClinicRole[]) {
        const res = await as(clinicA, tokens[role])
          .get('/treatment-plan-settings')
          .expect(200);
        expect(res.body).toEqual({ validityDays: 30 });
      }
      expect(
        await raw.tenant.findUniqueOrThrow({
          where: { id: clinicA.tenantId },
          select: { quoteValidityDays: true },
        }),
      ).toEqual({ quoteValidityDays: 30 });
      expect(createdDays).toEqual([30, 30]);
    });

    it('solo ADMIN lo cambia: los demás roles reciben 403 en español y no cambia nada', async () => {
      for (const role of [
        ClinicRole.DENTIST,
        ClinicRole.ASSISTANT,
        ClinicRole.RECEPTION,
      ]) {
        const res = await setDays(15, tokens[role]).expect(403);
        expect((res.body as { message: string }).message).toBe(
          QUOTE_SETTINGS_FORBIDDEN_MESSAGE,
        );
      }
      const res = await as(clinicA).get('/treatment-plan-settings').expect(200);
      expect(res.body).toEqual({ validityDays: 30 });
    });

    it.each([0, 366, 2.5, '30', null])(
      'rechaza %p con 400 en español',
      async (value) => {
        const res = await setDays(value).expect(400);
        expect(JSON.stringify(res.body)).toContain(QUOTE_VALIDITY_DAYS_MESSAGE);
      },
    );

    it('ADMIN lo cambia, queda auditado (QUOTE_SETTINGS, QT_V30 → QT_V15) y no toca otra clínica', async () => {
      const quoteEvents = async () =>
        (
          await raw.auditEvent.findMany({
            where: {
              tenantId: clinicA.tenantId,
              resourceType: 'CLINIC_SETTINGS',
            },
            orderBy: { occurredAt: 'desc' },
          })
        ).filter(
          (e) =>
            (e.metadata as { reason?: string }).reason === 'QUOTE_SETTINGS',
        );
      const before = (await quoteEvents()).length;
      await setDays(15).expect(200).expect({ validityDays: 15 });
      // Mismo valor: 200 sin otro evento.
      await setDays(15).expect(200);
      const quote = await quoteEvents();
      expect(quote).toHaveLength(before + 1);
      expect(quote[0]).toMatchObject({
        action: 'UPDATE',
        metadata: {
          reason: 'QUOTE_SETTINGS',
          changedFields: ['validityDays'],
          statusChange: { from: 'QT_V30', to: 'QT_V15' },
        },
      });
      const other = await as(clinicB)
        .get('/treatment-plan-settings')
        .expect(200);
      expect(other.body).toEqual({ validityDays: 30 });
    });
  });

  describe('presentar e imprimir fijan la validez', () => {
    it('un plan presentado después lleva la fecha calculada con el ajuste (15 días)', async () => {
      await setDays(15).expect(200);
      const planId = await draftPlan();
      const draft = await getPlan(planId);
      expect(draft).toMatchObject({
        quoteIssuedOn: null,
        quoteValidUntil: null,
        quoteExpired: false,
      });
      const presented = await present(planId);
      expect(presented).toMatchObject({
        status: 'PRESENTED',
        quoteIssuedOn: '2026-11-09',
        quoteValidUntil: '2026-11-24',
        quoteExpired: false,
      });
      const quote = await getQuote(planId);
      expect(quote).toMatchObject({
        issuedOn: '2026-11-09',
        validUntil: '2026-11-24',
        validityDays: 15,
      });
    });

    it('reimprimir otro día (y con otro ajuste) devuelve la misma fecha y el mismo hash', async () => {
      await setDays(15).expect(200);
      const planId = await draftPlan();
      await present(planId);
      const first = await issue(planId);
      now = new Date('2026-11-19T15:00:00.000Z');
      await setDays(60).expect(200);
      const again = await issue(planId, tokens.RECEPTION);
      expect(again).toMatchObject({
        issuedOn: '2026-11-09',
        validUntil: '2026-11-24',
        validityDays: 15,
      });
      expect(again.contentHash).toBe(first.contentHash);
      expect((await getQuote(planId)).contentHash).toBe(first.contentHash);
    });

    it('la primera impresión de un borrador fija la validez; el GET no escribe nada', async () => {
      await setDays(20).expect(200);
      const planId = await draftPlan();
      await getQuote(planId);
      expect((await getPlan(planId)).quoteIssuedOn).toBeNull();
      const printed = await issue(planId, tokens.RECEPTION);
      expect(printed).toMatchObject({
        issuedOn: '2026-11-09',
        validUntil: '2026-11-29',
        validityDays: 20,
        planStatus: 'DRAFT',
      });
      expect(await getPlan(planId)).toMatchObject({
        quoteIssuedOn: '2026-11-09',
        quoteValidUntil: '2026-11-29',
      });
      // Queda en la auditoría como PRINT.
      const printEvents = await raw.auditEvent.count({
        where: {
          tenantId: clinicA.tenantId,
          action: 'PRINT',
          resourceId: planId,
        },
      });
      expect(printEvents).toBeGreaterThanOrEqual(2);
      // Presentar después la reemplaza (D-3): cuenta desde la presentación.
      now = new Date('2026-11-12T15:00:00.000Z');
      expect(await present(planId)).toMatchObject({
        quoteIssuedOn: '2026-11-12',
        quoteValidUntil: '2026-12-02',
      });
    });

    it('M-5: imprimir un borrador sin ítems no fija la validez', async () => {
      const plan = await as(clinicA)
        .post(`/patients/${patientA}/treatment-plans`, { currency: 'VES' })
        .expect(201);
      const planId = (plan.body as { id: string }).id;
      await issue(planId);
      expect((await getPlan(planId)).quoteIssuedOn).toBeNull();
    });

    it('M-7: imprimir un plan cancelado, rechazado o aceptado sin firma no fija la validez', async () => {
      const cancelled = await draftPlan();
      await as(clinicA)
        .patch(`/treatment-plans/${cancelled}`, { status: 'CANCELLED' })
        .expect(200);
      const accepted = await draftPlan();
      await as(clinicA)
        .patch(`/treatment-plans/${accepted}`, { status: 'ACCEPTED' })
        .expect(200);
      const rejected = await draftPlan();
      await present(rejected);
      await as(clinicA)
        .post(`/treatment-plans/${rejected}/reject`, { reason: 'PRICE' })
        .expect(200);
      // Sin fechas, como un plan anterior a DX-379.
      await raw.treatmentPlan.update({
        where: { id: rejected },
        data: { quoteIssuedOn: null, quoteValidUntil: null },
      });
      for (const planId of [cancelled, accepted, rejected]) {
        await issue(planId);
        expect(await getPlan(planId)).toMatchObject({
          quoteIssuedOn: null,
          quoteValidUntil: null,
          quoteExpired: false,
        });
      }
    });

    it('M-1: presentar desde una sede sin zona horaria da 409 LOCATION_TIMEZONE_REQUIRED y el plan no cambia', async () => {
      const planId = await draftPlan();
      const location = await raw.location.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true, timeZone: true },
      });
      await raw.location.update({
        where: { id: location.id },
        data: { timeZone: null },
      });
      try {
        const res = await as(clinicA)
          .post(`/treatment-plans/${planId}/present`)
          .expect(409);
        expect(res.body).toMatchObject({ code: 'LOCATION_TIMEZONE_REQUIRED' });
      } finally {
        await raw.location.update({
          where: { id: location.id },
          data: { timeZone: location.timeZone },
        });
      }
      expect(await getPlan(planId)).toMatchObject({
        status: 'DRAFT',
        quoteIssuedOn: null,
      });
    });

    it('añadir un ítem después de presentar no mueve la validez', async () => {
      await setDays(15).expect(200);
      const planId = await draftPlan();
      await present(planId);
      now = new Date('2026-11-15T15:00:00.000Z');
      await as(clinicA)
        .post(`/treatment-plans/${planId}/items`, {
          toothNumber: '16',
          catalogItemId: catalogA,
          price: 450,
        })
        .expect(201);
      expect(await getPlan(planId)).toMatchObject({
        quoteIssuedOn: '2026-11-09',
        quoteValidUntil: '2026-11-24',
      });
    });
  });

  describe('quoteExpired con el día civil de la sede (Caracas)', () => {
    it('vence al terminar el último día en Caracas, también en la lista y en «Presupuestos por seguir»', async () => {
      await setDays(15).expect(200);
      const planId = await draftPlan();
      await present(planId);
      // 24 nov 23:59 en Caracas = 25 nov 03:59 UTC: aún vale.
      now = new Date('2026-11-25T03:59:00.000Z');
      expect((await getPlan(planId)).quoteExpired).toBe(false);
      // 25 nov 00:00 en Caracas: vencido.
      now = new Date('2026-11-25T04:00:00.000Z');
      expect((await getPlan(planId)).quoteExpired).toBe(true);
      const list = await as(clinicA)
        .get(`/patients/${patientA}/treatment-plans`)
        .expect(200);
      expect(
        (list.body as PlanBody[]).find((p) => p.id === planId),
      ).toMatchObject({ quoteValidUntil: '2026-11-24', quoteExpired: true });
      const pending = await as(clinicA)
        .get('/treatment-plans/pending-follow-up?olderThanDays=0&pageSize=100')
        .expect(200);
      expect(
        (
          pending.body as {
            items: {
              planId: string;
              quoteValidUntil: string | null;
              quoteExpired: boolean;
            }[];
          }
        ).items.find((i) => i.planId === planId),
      ).toMatchObject({ quoteValidUntil: '2026-11-24', quoteExpired: true });
    });

    it('esta porción no bloquea aceptar un presupuesto vencido, y mostrarlo un día y firmar otro no da 409', async () => {
      await setDays(15).expect(200);
      const planId = await draftPlan();
      await present(planId);
      const shown = await getQuote(planId);
      now = new Date('2026-12-01T15:00:00.000Z');
      expect((await getPlan(planId)).quoteExpired).toBe(true);
      const res = await as(clinicA)
        .post(`/patients/${patientA}/treatment-plans/${planId}/acceptance`, {
          signerName: 'Ana Validez',
          signature: `data:image/png;base64,${PNG}`,
          contentHash: shown.contentHash,
        })
        .expect(201);
      expect(res.body).toMatchObject({
        issuedOn: '2026-11-09',
        validUntil: '2026-11-24',
        planStatus: 'ACCEPTED',
      });
      // I-1: aceptado, su validez ya no cuenta: nunca sale vencido.
      expect(await getPlan(planId)).toMatchObject({
        status: 'ACCEPTED',
        quoteValidUntil: '2026-11-24',
        quoteExpired: false,
      });
    });

    it('un plan anterior a DX-379 (sin fechas) nunca sale vencido y su presupuesto se compone como hoy', async () => {
      await setDays(15).expect(200);
      const planId = await draftPlan();
      await present(planId);
      // Como lo deja la migración: presentado y sin fechas.
      await raw.treatmentPlan.update({
        where: { id: planId },
        data: { quoteIssuedOn: null, quoteValidUntil: null },
      });
      now = new Date('2027-06-01T15:00:00.000Z');
      expect(await getPlan(planId)).toMatchObject({
        quoteValidUntil: null,
        quoteExpired: false,
      });
      expect(await getQuote(planId)).toMatchObject({
        issuedOn: '2027-06-01',
        validUntil: '2027-06-16',
      });
    });
  });

  describe('base de datos y aislamiento', () => {
    it('CHECK: las dos fechas o ninguna, vence después de emitirse, y 1..365 días', async () => {
      const planId = await draftPlan();
      await expect(
        raw.treatmentPlan.update({
          where: { id: planId },
          data: { quoteIssuedOn: new Date('2026-11-09T00:00:00Z') },
        }),
      ).rejects.toThrow(/treatment_plans_quote_validity_pair_check/);
      await expect(
        raw.treatmentPlan.update({
          where: { id: planId },
          data: {
            quoteIssuedOn: new Date('2026-11-09T00:00:00Z'),
            quoteValidUntil: new Date('2026-11-09T00:00:00Z'),
          },
        }),
      ).rejects.toThrow(/treatment_plans_quote_validity_order_check/);
      for (const days of [0, 366]) {
        await expect(
          raw.tenant.update({
            where: { id: clinicA.tenantId },
            data: { quoteValidityDays: days },
          }),
        ).rejects.toThrow(/tenants_quote_validity_days_check/);
      }
    });

    it('otra clínica no ve ni imprime el plan de A (404) y su ajuste es suyo', async () => {
      const planId = await draftPlan();
      await as(clinicB).get(`/treatment-plans/${planId}`).expect(404);
      await as(clinicB)
        .post(`${quotePath(planId)}/issue`)
        .expect(404);
      expect((await getPlan(planId)).quoteIssuedOn).toBeNull();
      await as(clinicB)
        .put('/treatment-plan-settings', { validityDays: 7 })
        .expect(200);
      const a = await as(clinicA).get('/treatment-plan-settings').expect(200);
      expect((a.body as { validityDays: number }).validityDays).not.toBe(7);
    });
  });
});
