import { INestApplication } from '@nestjs/common';
import { CatalogKind, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { CapturingMailer } from './support/capture-mailer';
import {
  type Clinic,
  registerClinic,
  resetDatabase,
} from './support/e2e-fixtures';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  MAIL_CONFIG,
  loadMailConfig,
} from '../src/modules/notifications/email/infrastructure/mail-config';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { seedParProviderRates } from './support/par-provider-rates';

// DX-560 en HTTP real: la descripción para el paciente del catálogo (por
// idioma, con sus 400 en español), la presentación en el presupuesto de la
// clínica (en el idioma del paciente, sin cambiar el hash) y la presentación
// congelada del enlace de aceptación (textos, visitas y la segunda moneda de
// la sede con la tasa guardada del día) en el documento público.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const EMAIL = 'luisa.mendez@example.com';
const TOKEN_IN_TEXT = /\/firmar\/([A-Za-z0-9_-]{43})/;
const CODE_IN_TEXT = /Tu código de verificación es: (\d{6})/;

const DESCRIPTION_ES =
  'Limpieza profunda de las encías para frenar el sangrado.';
const DESCRIPTION_EN = 'Deep cleaning of the gums to stop the bleeding.';

interface CatalogBody {
  id: string;
  patientDescription: { language: string; text: string }[];
}
interface QuoteBody {
  contentHash: string;
  version: number;
  items: { id: string; procedure: string }[];
  presentation: {
    language: string;
    items: {
      itemId: string;
      visit: number;
      label: string;
      language: string;
    }[];
  };
}
interface DocumentBody {
  budget: { items: { procedure: string }[] } | null;
  presentation: {
    language: string;
    items: { index: number; visit: number; label: string; language: string }[];
    visitOrganization: {
      visit: number;
      label: string | null;
      minDaysAfterPrevious: number;
    }[];
    secondCurrency?: {
      currency: string;
      fromPerBase: number;
      toPerBase: number;
      source: string;
      date: string;
    };
  } | null;
}

describe('Presentación del plan al paciente (e2e, DX-560)', () => {
  let app: INestApplication<App>;
  let dispatcher: EmailDispatcher;
  let dropParRates: (() => Promise<void>) | undefined;
  const mailer = new CapturingMailer();
  let clinic: Clinic;
  let patientId: string;
  let describedId: string;
  let bareId: string;

  const server = () => request(app.getHttpServer());
  const as = () => {
    const set = (req: request.Test) =>
      req
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`);
    return {
      get: (path: string) => set(server().get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        set(server().post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) =>
        set(server().patch(`/api/v1${path}`)).send(body),
    };
  };
  const pub = {
    get: (path: string, session?: string) => {
      const req = server()
        .get(`/api/v1/public/sign/${path}`)
        .set('X-Tenant-Host', clinic.host);
      return session ? req.set('X-Signature-Session', session) : req;
    },
    post: (path: string, body: object = {}) =>
      server()
        .post(`/api/v1/public/sign/${path}`)
        .set('X-Tenant-Host', clinic.host)
        .send(body),
  };

  /** Plan USD presentado: la limpieza (visita 1) y la resina (visita 2). */
  async function presentedPlan(): Promise<{ planId: string; items: string[] }> {
    const plan = await as()
      .post(`/patients/${patientId}/treatment-plans`, { currency: 'USD' })
      .expect(201);
    const planId = (plan.body as { id: string }).id;
    const first = await as()
      .post(`/treatment-plans/${planId}/items`, {
        toothNumber: '16',
        catalogItemId: describedId,
        price: 80,
      })
      .expect(201);
    const second = await as()
      .post(`/treatment-plans/${planId}/items`, {
        toothNumber: '26',
        catalogItemId: bareId,
        price: 45,
      })
      .expect(201);
    const items = [first, second].map((r) => (r.body as { id: string }).id);
    await raw.treatmentPlanItem.update({
      where: { id: items[1] },
      data: { visit: 2 },
    });
    await as().post(`/treatment-plans/${planId}/present`).expect(200);
    return { planId, items };
  }

  async function sendAndOpen(
    planId: string,
    secondCurrency?: string,
    beforeOpening?: () => Promise<void>,
  ): Promise<DocumentBody> {
    mailer.clear();
    await as()
      .post(`/patients/${patientId}/signature-requests`, {
        type: 'BUDGET',
        channel: 'EMAIL',
        treatmentPlanId: planId,
        ...(secondCurrency ? { secondCurrency } : {}),
      })
      .expect(201);
    await dispatcher.whenIdle();
    const token = (await mailer.waitFor(EMAIL, TOKEN_IN_TEXT))[1];
    await beforeOpening?.();
    mailer.clear();
    await pub.post(`${token}/code`).expect(200);
    await dispatcher.whenIdle();
    const code = (await mailer.waitFor(EMAIL, CODE_IN_TEXT))[1];
    const verified = await pub.post(`${token}/verify`, { code }).expect(200);
    const session = (verified.body as { sessionToken: string }).sessionToken;
    return (await pub.get(`${token}/document`, session).expect(200))
      .body as DocumentBody;
  }

  beforeAll(async () => {
    await resetDatabase(raw);
    // La tasa del día ya guardada (VES a la par): la que lee `stored()`.
    dropParRates = await seedParProviderRates(raw, ['VES']);
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
    clinic = await registerClinic(app, 'dx560-presentacion');
    await raw.tenant.update({
      where: { id: clinic.tenantId },
      data: { patientLanguages: ['es', 'en'] },
    });
    const patient = await as()
      .post('/patients', {
        docType: 'NATIONAL_ID',
        sex: 'F',
        firstName: 'Luisa',
        lastName: 'Méndez',
        docNumber: 'V-18456321',
        email: EMAIL,
        birthDate: '1985-03-14',
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
    const bare = await as()
      .post('/catalog/items', {
        code: 'DX560-RES',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Restauración con resina compuesta',
        labelEn: 'Composite filling',
        color: '#2A2B3C',
        defaultPrice: 45,
      })
      .expect(201);
    bareId = (bare.body as CatalogBody).id;
    expect((bare.body as CatalogBody).patientDescription).toEqual([]);
  });

  afterAll(async () => {
    await dropParRates?.();
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('catálogo: guarda y devuelve la descripción por idioma, ordenada, y la edita entera', async () => {
    const created = await as()
      .post('/catalog/items', {
        code: 'DX560-TAR',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Tartrectomía',
        color: '#00AA88',
        defaultPrice: 80,
        patientDescription: [
          { language: 'en', text: DESCRIPTION_EN },
          { language: 'es', text: `  ${DESCRIPTION_ES}  ` },
        ],
      })
      .expect(201);
    const body = created.body as CatalogBody;
    describedId = body.id;
    expect(body.patientDescription).toEqual([
      { language: 'es', text: DESCRIPTION_ES },
      { language: 'en', text: DESCRIPTION_EN },
    ]);

    // PATCH sin el campo no lo toca.
    const untouched = await as()
      .patch(`/catalog/items/${describedId}`, { labelEs: 'Tartrectomía' })
      .expect(200);
    expect((untouched.body as CatalogBody).patientDescription).toHaveLength(2);

    // La lista es el mapa entero: sin «en», se quita.
    const onlyEs = await as()
      .patch(`/catalog/items/${describedId}`, {
        patientDescription: [{ language: 'es', text: DESCRIPTION_ES }],
      })
      .expect(200);
    expect((onlyEs.body as CatalogBody).patientDescription).toEqual([
      { language: 'es', text: DESCRIPTION_ES },
    ]);
    await as()
      .patch(`/catalog/items/${describedId}`, {
        patientDescription: [
          { language: 'es', text: DESCRIPTION_ES },
          { language: 'en', text: DESCRIPTION_EN },
        ],
      })
      .expect(200);

    const listed = await as().get('/catalog/items').expect(200);
    expect(
      (listed.body as CatalogBody[]).find((i) => i.id === describedId)
        ?.patientDescription,
    ).toEqual([
      { language: 'es', text: DESCRIPTION_ES },
      { language: 'en', text: DESCRIPTION_EN },
    ]);
  });

  it.each([
    [
      [{ language: 'pt', text: 'Limpeza.' }],
      'Ese idioma no está entre los idiomas de los pacientes de la clínica.',
    ],
    [
      [{ language: 'es', text: 'a'.repeat(301) }],
      'La descripción para el paciente no puede tener más de 300 caracteres.',
    ],
    [
      [{ language: 'es', text: 'Más en www.clinica-demo.com.ve' }],
      'La descripción para el paciente no admite enlaces ni HTML: escríbela como texto.',
    ],
    [
      [{ language: 'es', text: 'Texto <b>con</b> HTML' }],
      'La descripción para el paciente no admite enlaces ni HTML: escríbela como texto.',
    ],
    [
      [
        { language: 'es', text: 'Uno.' },
        { language: 'ES', text: 'Dos.' },
      ],
      'Ese idioma está repetido en la descripción para el paciente.',
    ],
    [null, 'La descripción para el paciente debe ir en una lista.'],
  ])('catálogo: 400 en español con %j', async (patientDescription, message) => {
    const res = await as()
      .patch(`/catalog/items/${bareId}`, { patientDescription })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain(message);
  });

  it('el presupuesto de la clínica trae la presentación en el idioma del paciente sin cambiar el hash', async () => {
    const { planId, items } = await presentedPlan();
    const path = `/patients/${patientId}/treatment-plans/${planId}/quote`;
    const es = (await as().get(path).expect(200)).body as QuoteBody;
    expect(es.presentation).toEqual({
      language: 'es',
      items: [
        { itemId: items[0], visit: 1, label: DESCRIPTION_ES, language: 'es' },
        {
          itemId: items[1],
          visit: 2,
          label: 'Restauración con resina compuesta',
          language: 'es',
        },
      ],
    });
    // El contenido sellado sigue con el nombre del catálogo.
    expect(es.items.map((i) => i.procedure)).toEqual([
      'Tartrectomía',
      'Restauración con resina compuesta',
    ]);

    await raw.patient.update({
      where: { id: patientId },
      data: { preferredLanguage: 'en' },
    });
    try {
      const en = (await as().get(path).expect(200)).body as QuoteBody;
      expect(en.presentation).toEqual({
        language: 'en',
        items: [
          {
            itemId: items[0],
            visit: 1,
            label: DESCRIPTION_EN,
            language: 'en',
          },
          // Sin descripción: el nombre del catálogo en inglés.
          {
            itemId: items[1],
            visit: 2,
            label: 'Composite filling',
            language: 'en',
          },
        ],
      });
      expect(en.contentHash).toBe(es.contentHash);
      expect(en.version).toBe(es.version);
    } finally {
      await raw.patient.update({
        where: { id: patientId },
        data: { preferredLanguage: null },
      });
    }
  });

  it('el enlace de aceptación congela la presentación con la segunda moneda de la sede (VES) y su tasa guardada; editar el catálogo tras enviar no lo invalida ni cambia el texto', async () => {
    const { planId } = await presentedPlan();
    // Entre el envío y la apertura, la clínica cambia la descripción: el
    // enlace sigue valiendo (budgetStillMatches: no está en lo sellado) y el
    // paciente ve el texto congelado.
    const doc = await sendAndOpen(planId, undefined, async () => {
      await as()
        .patch(`/catalog/items/${describedId}`, {
          patientDescription: [{ language: 'es', text: 'Otro texto.' }],
        })
        .expect(200);
    });
    try {
      expect(doc.presentation).toMatchObject({
        language: 'es',
        items: [
          { index: 0, visit: 1, label: DESCRIPTION_ES, language: 'es' },
          {
            index: 1,
            visit: 2,
            label: 'Restauración con resina compuesta',
            language: 'es',
          },
        ],
        visitOrganization: [
          { visit: 1, label: null, minDaysAfterPrevious: 0 },
          { visit: 2, label: null, minDaysAfterPrevious: 0 },
        ],
        secondCurrency: {
          currency: 'VES',
          fromPerBase: 1,
          toPerBase: 1,
          source: 'AUTOMATIC',
        },
      });
      expect(JSON.stringify(doc.presentation)).not.toContain('Otro texto');
      expect(doc.presentation?.secondCurrency?.date).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
      // La foto firmada no cambia: sigue con el nombre del catálogo.
      expect(doc.budget?.items.map((i) => i.procedure)).toEqual([
        'Tartrectomía',
        'Restauración con resina compuesta',
      ]);
    } finally {
      await as()
        .patch(`/catalog/items/${describedId}`, {
          patientDescription: [
            { language: 'es', text: DESCRIPTION_ES },
            { language: 'en', text: DESCRIPTION_EN },
          ],
        })
        .expect(200);
    }
  });

  it('sede en la moneda del plan: sin elegir no hay bloque; la segunda elegida (VES) sí, y una inválida es 400', async () => {
    const location = await raw.location.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, deletedAt: null },
      select: { id: true, currency: true },
    });
    await raw.location.update({
      where: { id: location.id },
      data: { currency: 'USD' },
    });
    try {
      const none = await sendAndOpen((await presentedPlan()).planId);
      expect(none.presentation).not.toHaveProperty('secondCurrency');

      const ves = await sendAndOpen((await presentedPlan()).planId, 'VES');
      expect(ves.presentation?.secondCurrency).toMatchObject({
        currency: 'VES',
        fromPerBase: 1,
        toPerBase: 1,
      });

      const { planId } = await presentedPlan();
      const post = (secondCurrency: string) =>
        as().post(`/patients/${patientId}/signature-requests`, {
          type: 'BUDGET',
          channel: 'EMAIL',
          treatmentPlanId: planId,
          secondCurrency,
        });
      expect(JSON.stringify((await post('USD').expect(400)).body)).toContain(
        'La segunda moneda debe ser distinta de la del presupuesto.',
      );
      expect(JSON.stringify((await post('XXX').expect(400)).body)).toContain(
        'La segunda moneda no está en el catálogo de monedas.',
      );
      expect(JSON.stringify((await post('ves').expect(400)).body)).toContain(
        'La segunda moneda debe ser un código ISO 4217',
      );
    } finally {
      await raw.location.update({
        where: { id: location.id },
        data: { currency: location.currency },
      });
    }
  });

  it('un enlace anterior a DX-560 (sin presentación guardada) da presentation null', async () => {
    const { planId } = await presentedPlan();
    mailer.clear();
    await as()
      .post(`/patients/${patientId}/signature-requests`, {
        type: 'BUDGET',
        channel: 'EMAIL',
        treatmentPlanId: planId,
      })
      .expect(201);
    await dispatcher.whenIdle();
    const token = (await mailer.waitFor(EMAIL, TOKEN_IN_TEXT))[1];
    // Como una fila anterior a la columna (el guard no deja tocarla: se
    // siembra sin triggers de usuario).
    await raw.$transaction([
      raw.$executeRaw`SET LOCAL session_replication_role = replica`,
      raw.$executeRaw`UPDATE "signature_requests" SET "budgetPresentation" = NULL WHERE "treatmentPlanId" = ${planId}::uuid`,
    ]);
    mailer.clear();
    await pub.post(`${token}/code`).expect(200);
    await dispatcher.whenIdle();
    const code = (await mailer.waitFor(EMAIL, CODE_IN_TEXT))[1];
    const verified = await pub.post(`${token}/verify`, { code }).expect(200);
    const session = (verified.body as { sessionToken: string }).sessionToken;
    const doc = (await pub.get(`${token}/document`, session).expect(200))
      .body as DocumentBody;
    expect(doc.presentation).toBeNull();
    expect(doc.budget?.items).toHaveLength(2);
  });
});
