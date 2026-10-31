import { INestApplication } from '@nestjs/common';
import { CatalogKind, ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { CapturingMailer } from './support/capture-mailer';
import { signaturePng } from './support/png-fixtures';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  MAIL_CONFIG,
  loadMailConfig,
} from '../src/modules/notifications/email/infrastructure/mail-config';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { SIGNATURE_LINK_INVALID_MESSAGE } from '../src/modules/signature-requests/application/use-cases/public-signature.use-cases';

// DX-415 en HTTP real: recepción envía a aceptar el presupuesto «Presentado»
// (opción A de un grupo con B) → el paciente abre el enlace sin sesión, pide
// el código, lo verifica, ve ítems, totales y condiciones y firma → el plan
// pasa a ACCEPTED, la opción B a REJECTED («otra opción aceptada») y la ficha
// muestra la aceptación a distancia con sus evidencias; llega un email de
// confirmación sin importes. Un plan no presentado es 409; si el plan cambia
// tras el envío, el enlace es «Enlace no válido»; la clínica B no lo usa.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const EMAIL = 'marta.rios@example.com';
const TOKEN_IN_TEXT = /\/firmar\/([A-Za-z0-9_-]{43})/;
const CODE_IN_TEXT = /Tu código de verificación es: (\d{6})/;
const SIGNATURE = `data:image/png;base64,${signaturePng(300, 100).toString('base64')}`;
const UA = 'Mozilla/5.0 (iPhone) e2e';

interface BudgetDocument {
  type: string;
  body: string;
  budget: {
    currency: string;
    items: { procedure: string; unitPrice: number; subtotal: number }[];
    totals: {
      currency: string;
      gross: number;
      discount: number;
      net: number;
    }[];
    validUntil: string;
  } | null;
}

describe('Presupuesto a distancia (e2e, DX-415)', () => {
  let app: INestApplication<App>;
  let dispatcher: EmailDispatcher;
  const mailer = new CapturingMailer();
  let clinicA: Clinic;
  let clinicB: Clinic;
  let reception: string;
  let patientId: string;
  let catalogItemId: string;

  const server = () => request(app.getHttpServer());
  const as = (clinic: Clinic, token = clinic.adminToken) => {
    const set = (req: request.Test) =>
      req
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`);
    return {
      get: (path: string) => set(server().get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        set(server().post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) =>
        set(server().patch(`/api/v1${path}`)).send(body),
    };
  };
  const pub = (host: string) => ({
    get: (path: string, session?: string) => {
      const req = server()
        .get(`/api/v1/public/sign/${path}`)
        .set('X-Tenant-Host', host);
      return session ? req.set('X-Signature-Session', session) : req;
    },
    post: (path: string, body: object = {}, session?: string) => {
      const req = server()
        .post(`/api/v1/public/sign/${path}`)
        .set('X-Tenant-Host', host)
        .set('User-Agent', UA);
      return (session ? req.set('X-Signature-Session', session) : req).send(
        body,
      );
    },
  });

  /** Plan COP con dos ítems (300 000 − 30 000 y 120 000). */
  async function newPlan(): Promise<string> {
    const plan = await as(clinicA)
      .post(`/patients/${patientId}/treatment-plans`, { currency: 'COP' })
      .expect(201);
    const planId = (plan.body as { id: string }).id;
    await as(clinicA)
      .post(`/treatment-plans/${planId}/items`, {
        toothNumber: '36',
        catalogItemId,
        price: 300000,
        discount: 30000,
      })
      .expect(201);
    await as(clinicA)
      .post(`/treatment-plans/${planId}/items`, {
        toothNumber: '16',
        catalogItemId,
        price: 120000,
      })
      .expect(201);
    return planId;
  }

  async function presentedPlan(): Promise<string> {
    const planId = await newPlan();
    await as(clinicA).post(`/treatment-plans/${planId}/present`).expect(200);
    return planId;
  }

  async function send(planId: string): Promise<{ id: string; token: string }> {
    mailer.clear();
    const res = await as(clinicA, reception)
      .post(`/patients/${patientId}/signature-requests`, {
        type: 'BUDGET',
        channel: 'EMAIL',
        treatmentPlanId: planId,
      })
      .expect(201);
    await dispatcher.whenIdle();
    const match = await mailer.waitFor(EMAIL, TOKEN_IN_TEXT);
    return { id: (res.body as { id: string }).id, token: match[1] };
  }

  async function verified(token: string): Promise<string> {
    mailer.clear();
    await pub(clinicA.host).post(`${token}/code`).expect(200);
    await dispatcher.whenIdle();
    const code = (await mailer.waitFor(EMAIL, CODE_IN_TEXT))[1];
    const res = await pub(clinicA.host)
      .post(`${token}/verify`, { code })
      .expect(200);
    return (res.body as { sessionToken: string }).sessionToken;
  }

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp({
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(mailer);
        builder.overrideProvider(MAIL_CONFIG).useValue({
          ...loadMailConfig((key) => process.env[key]),
          quotas: {
            recipientCooldownSeconds: 0,
            recipientDaily: 1000,
            tenantDaily: 1000,
          },
        });
      },
    });
    dispatcher = app.get(EmailDispatcher);
    clinicA = await registerClinic(app, 'dx415-presupuesto-a');
    clinicB = await registerClinic(app, 'dx415-presupuesto-b');
    const receptionist = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    reception = await loginAs(app, clinicA.host, receptionist.email);
    const patient = await as(clinicA)
      .post('/patients', {
        docType: 'NATIONAL_ID',
        sex: 'F',
        firstName: 'Marta',
        lastName: 'Ríos',
        docNumber: 'DX415-1',
        email: EMAIL,
        birthDate: '1988-05-20',
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
    const catalog = await as(clinicA)
      .post('/catalog/items', {
        code: 'DX415-IMP',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Corona en zirconio',
        color: '#2A2B3C',
        defaultPrice: 1,
      })
      .expect(201);
    catalogItemId = (catalog.body as { id: string }).id;
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('enviar → código → ver el presupuesto → firmar: el plan queda ACCEPTED, la otra opción REJECTED y la ficha ve las evidencias', async () => {
    const planId = await presentedPlan();
    const optionB = (
      (
        await as(clinicA)
          .post(`/treatment-plans/${planId}/alternatives`, {
            optionLabel: 'Opción B',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    await as(clinicA).post(`/treatment-plans/${optionB}/present`).expect(200);

    const { id, token } = await send(planId);
    // El email del enlace no lleva importes ni procedimientos.
    const linkMail = mailer.sent.find((m) => m.to === EMAIL);
    expect(linkMail?.text).not.toMatch(/zirconio|300\.000|300000/i);

    // Sin sesión, el enlace no enseña el presupuesto.
    const view = await pub(clinicA.host).get(token).expect(200);
    expect(view.body).toMatchObject({ type: 'BUDGET' });
    expect(JSON.stringify(view.body)).not.toMatch(/zirconio/i);
    await pub(clinicA.host).get(`${token}/document`).expect(403);

    const session = await verified(token);
    const doc = (
      await pub(clinicA.host).get(`${token}/document`, session).expect(200)
    ).body as BudgetDocument;
    expect(doc.type).toBe('BUDGET');
    expect(doc.body).toMatch(/Al firmar aceptas este presupuesto/);
    expect(doc.budget).toMatchObject({
      currency: 'COP',
      totals: [
        { currency: 'COP', gross: 420000, discount: 30000, net: 390000 },
      ],
    });
    expect(doc.budget?.items.map((i) => i.subtotal)).toEqual([270000, 120000]);

    mailer.clear();
    const signed = await pub(clinicA.host)
      .post(`${token}/sign`, { signature: SIGNATURE, accepted: true }, session)
      .expect(200);
    expect(signed.body).toMatchObject({ type: 'BUDGET' });

    const plans = await raw.treatmentPlan.findMany({
      where: { id: { in: [planId, optionB] } },
      select: { id: true, status: true, rejectionReason: true },
    });
    expect(plans.find((p) => p.id === planId)?.status).toBe('ACCEPTED');
    expect(plans.find((p) => p.id === optionB)).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'OTHER_OPTION_ACCEPTED',
    });
    const items = await raw.treatmentPlanItem.findMany({
      where: { planId, deletedAt: null },
      select: { status: true },
    });
    expect(items.every((i) => i.status === 'ACCEPTED')).toBe(true);

    const quote = await as(clinicA)
      .get(`/patients/${patientId}/treatment-plans/${planId}/quote`)
      .expect(200);
    expect(quote.body).toMatchObject({
      planStatus: 'ACCEPTED',
      acceptance: {
        signerName: 'Marta Ríos',
        integrityOk: true,
        userAgent: UA,
        remote: {
          signatureRequestId: id,
          channel: 'EMAIL',
          destinationMasked: 'ma***@example.com',
        },
      },
    });

    const list = await as(clinicA, reception)
      .get(`/patients/${patientId}/signature-requests`)
      .expect(200);
    expect(
      (list.body as { id: string }[]).find((r) => r.id === id),
    ).toMatchObject({
      type: 'BUDGET',
      status: 'COMPLETE',
      treatmentPlanId: planId,
    });

    // Confirmación al paciente, sin importes ni procedimientos.
    await dispatcher.whenIdle();
    const confirmation = await mailer.waitFor(
      EMAIL,
      /registramos tu aceptación/,
    );
    expect(confirmation.input).not.toMatch(/zirconio|390\.000|390000/i);

    // El enlace ya está usado.
    await pub(clinicA.host).get(token).expect(404);
  });

  it('solo un plan «Presentado»: borrador y aceptado son 409 en español; nada se crea', async () => {
    const draft = await newPlan();
    const before = await raw.signatureRequest.count();
    const res = await as(clinicA, reception)
      .post(`/patients/${patientId}/signature-requests`, {
        type: 'BUDGET',
        channel: 'EMAIL',
        treatmentPlanId: draft,
      })
      .expect(409);
    expect(res.body).toMatchObject({
      message:
        'Solo se envía a aceptar un presupuesto «Presentado»: este está «Borrador».',
    });
    const accepted = await presentedPlan();
    await as(clinicA)
      .patch(`/treatment-plans/${accepted}`, { status: 'ACCEPTED' })
      .expect(200);
    await as(clinicA, reception)
      .post(`/patients/${patientId}/signature-requests`, {
        type: 'BUDGET',
        channel: 'EMAIL',
        treatmentPlanId: accepted,
      })
      .expect(409);
    expect(await raw.signatureRequest.count()).toBe(before);
  });

  it('si el plan cambia después del envío, el enlace es «Enlace no válido» y no se puede firmar', async () => {
    const planId = await presentedPlan();
    const { token } = await send(planId);
    const session = await verified(token);
    const [item] = await raw.treatmentPlanItem.findMany({
      where: { planId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    await as(clinicA)
      .patch(`/treatment-plans/${planId}/items/${item.id}`, { price: 310000 })
      .expect(200);
    const res = await pub(clinicA.host).get(token).expect(404);
    expect(res.body).toMatchObject({ message: SIGNATURE_LINK_INVALID_MESSAGE });
    await pub(clinicA.host)
      .post(`${token}/sign`, { signature: SIGNATURE, accepted: true }, session)
      .expect(404);
    const plan = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: planId },
      select: { status: true },
    });
    expect(plan.status).toBe('PRESENTED');
  });

  it('la clínica B no envía el plan de A ni abre su enlace en su host', async () => {
    const planId = await presentedPlan();
    await as(clinicB)
      .post(`/patients/${patientId}/signature-requests`, {
        type: 'BUDGET',
        channel: 'EMAIL',
        treatmentPlanId: planId,
      })
      .expect(404);
    const { token } = await send(planId);
    await pub(clinicB.host).get(token).expect(404);
    await pub(clinicB.host).post(`${token}/code`).expect(404);
  });
});
