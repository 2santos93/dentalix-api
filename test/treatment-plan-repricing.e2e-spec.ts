import { INestApplication } from '@nestjs/common';
import { CatalogKind, ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { CapturingMailer } from './support/capture-mailer';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { pinCatalogCurrency } from './support/catalog-currency';
import { REGIONAL_CARACAS_FIXTURE } from './support/location-fixtures';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  MAIL_CONFIG,
  loadMailConfig,
} from '../src/modules/notifications/email/infrastructure/mail-config';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { SIGNATURE_LINK_INVALID_MESSAGE } from '../src/modules/signature-requests/application/use-cases/public-signature.use-cases';
import { IDEMPOTENCY_KEY_INVALID_MESSAGE } from '../src/shared/validation/idempotency-key';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import {
  REPRICE_ITEM_NOT_PROPOSED_MESSAGE,
  REPRICE_STALE_MESSAGE,
  repricePlanStatusMessage,
} from '../src/modules/treatment-plans/application/repricing';
import { REPRICE_IDEMPOTENCY_KEY_REQUIRED_MESSAGE } from '../src/modules/treatment-plans/application/use-cases/plan-repricing.use-cases';

// DX-379 (porción B) en HTTP real: plan en VES con el catálogo en USD y tasa
// MANUAL de la clínica; la tasa sube → vista previa → aplicar con
// Idempotency-Key: precios y foto nuevos, validez reiniciada (día de la sede)
// y auditoría con `params.repricingId`. Huella obsoleta → 409 sin cambios;
// enlace de firma a distancia pendiente → deja de valer; la clínica B no ve
// ni toca el plan de A; recepción no recotiza.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const EMAIL = 'luisa.mendez@example.com';
const TOKEN_IN_TEXT = /\/firmar\/([A-Za-z0-9_-]{43})/;
const caracasDay = (offset = 0) =>
  addCivilDays(
    civilDateIn(new Date(), REGIONAL_CARACAS_FIXTURE.timeZone),
    offset,
  );

let keySeq = 0;
const newKey = () =>
  `0190a1b2-c3d4-7e5f-8a9b-${String(++keySeq).padStart(12, '0')}`;

interface Price {
  price: number;
  discount: number;
  total: number;
  listPrice: number | null;
}
interface Preview {
  planId: string;
  currency: string;
  previewHash: string;
  lines: {
    itemId: string;
    before: Price;
    after: Price;
    difference: number;
    changed: boolean;
  }[];
  skipped: { itemId: string; reason: string; currency: string | null }[];
  rate: { currency: string; toPerBase: number } | null;
  previousValidity: { issuedOn: string; validUntil: string } | null;
  validity: { issuedOn: string; validUntil: string };
  totals: { before: number; after: number; difference: number };
}
interface Applied extends Preview {
  repricingId: string;
  appliedAt: string;
  replayed: boolean;
}

describe('Actualizar precios de un plan (e2e, DX-379 porción B)', () => {
  let app: INestApplication<App>;
  let dispatcher: EmailDispatcher;
  const mailer = new CapturingMailer();
  let clinicA: Clinic;
  let clinicB: Clinic;
  const tokens: Partial<Record<ClinicRole, string>> = {};
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
      post: (path: string, body: object = {}, key?: string) => {
        const req = set(server().post(`/api/v1${path}`));
        return (key ? req.set('Idempotency-Key', key) : req).send(body);
      },
      patch: (path: string, body: object) =>
        set(server().patch(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        set(server().put(`/api/v1${path}`)).send(body),
    };
  };
  const repricePath = (planId: string, patient = patientId) =>
    `/patients/${patient}/treatment-plans/${planId}/reprice`;

  /** Tasa MANUAL de A (VES por 1 USD) para ayer y hoy en la sede. */
  async function setRate(rate: number): Promise<void> {
    await raw.manualExchangeRate.updateMany({
      where: { tenantId: clinicA.tenantId, currency: 'VES' },
      data: { rate },
    });
  }

  /** Plan en VES presentado, con dos ítems a la tasa de 36 y validez vieja. */
  async function presentedPlan(): Promise<{ planId: string; items: string[] }> {
    await setRate(36);
    const plan = await as(clinicA)
      .post(`/patients/${patientId}/treatment-plans`, { currency: 'VES' })
      .expect(201);
    const planId = (plan.body as { id: string }).id;
    const items: string[] = [];
    for (const toothNumber of ['36', '46']) {
      const item = await as(clinicA)
        .post(`/treatment-plans/${planId}/items`, {
          toothNumber,
          catalogItemId,
        })
        .expect(201);
      items.push((item.body as { id: string }).id);
    }
    await as(clinicA).post(`/treatment-plans/${planId}/present`).expect(200);
    // Presentado hace dos meses: la validez guardada ya venció.
    await raw.treatmentPlan.update({
      where: { id: planId },
      data: {
        quoteIssuedOn: new Date('2026-09-01T00:00:00.000Z'),
        quoteValidUntil: new Date('2026-10-01T00:00:00.000Z'),
      },
    });
    return { planId, items };
  }

  const preview = async (planId: string, token?: string, body: object = {}) =>
    (
      await as(clinicA, token)
        .post(`${repricePath(planId)}/preview`, body)
        .expect(200)
    ).body as Preview;

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
    clinicA = await registerClinic(app, 'dx379b-recotiza-a');
    clinicB = await registerClinic(app, 'dx379b-recotiza-b');
    tokens.ADMIN = clinicA.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const m = await seedMember(raw, clinicA, role);
      tokens[role] = await loginAs(app, clinicA.host, m.email);
    }
    // El catálogo de A en USD y la tasa MANUAL de la clínica (la CI no tiene
    // proveedor): el precio vigente de un plan en VES sale con ella.
    await pinCatalogCurrency(raw, clinicA.tenantId, 'USD');
    await as(clinicA)
      .put('/exchange/settings', { source: 'MANUAL' })
      .expect(200);
    for (const offset of [-1, 0]) {
      await as(clinicA)
        .post('/exchange/manual-rates', {
          date: caracasDay(offset),
          currency: 'VES',
          rate: 36,
        })
        .expect(201);
    }
    const patient = await as(clinicA)
      .post('/patients', {
        docType: 'NATIONAL_ID',
        sex: 'F',
        firstName: 'Luisa',
        lastName: 'Méndez',
        docNumber: 'DX379B-1',
        email: EMAIL,
        birthDate: '1990-03-14',
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
    const catalog = await as(clinicA)
      .post('/catalog/items', {
        code: 'DX379B-ENDO',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Endodoncia molar',
        color: '#2A2B3C',
        defaultPrice: 100,
      })
      .expect(201);
    catalogItemId = (catalog.body as { id: string }).id;
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('recorrido completo: la tasa sube → vista previa → aplicar; precios, foto, validez y auditoría', async () => {
    const { planId, items } = await presentedPlan();
    await setRate(40);

    const p = await preview(planId, tokens.DENTIST);
    expect(p.currency).toBe('VES');
    expect(p.skipped).toEqual([]);
    expect(p.lines).toHaveLength(2);
    for (const line of p.lines) {
      expect(line.before).toMatchObject({ price: 3600, listPrice: 3600 });
      expect(line.after).toMatchObject({ price: 4000, listPrice: 4000 });
      expect(line).toMatchObject({ difference: 400, changed: true });
    }
    expect(p.rate).toMatchObject({ currency: 'USD', toPerBase: 40 });
    expect(p.previousValidity).toEqual({
      issuedOn: '2026-09-01',
      validUntil: '2026-10-01',
    });
    expect(p.validity).toEqual({
      issuedOn: caracasDay(0),
      validUntil: caracasDay(30),
    });
    expect(p.totals).toEqual({ before: 7200, after: 8000, difference: 800 });
    // La vista previa no escribe.
    const untouched = await raw.treatmentPlanItem.findMany({
      where: { id: { in: items } },
    });
    expect(untouched.map((i) => i.price.toNumber())).toEqual([3600, 3600]);

    const key = newKey();
    const res = await as(clinicA, tokens.DENTIST)
      .post(`${repricePath(planId)}/apply`, { previewHash: p.previewHash }, key)
      .expect(200);
    const applied = res.body as Applied;
    expect(applied).toMatchObject({
      previewHash: p.previewHash,
      replayed: false,
      validity: p.validity,
      totals: p.totals,
    });

    const after = await raw.treatmentPlanItem.findMany({
      where: { id: { in: items } },
    });
    for (const item of after) {
      expect(item.price.toNumber()).toBe(4000);
      expect(item.referencePriceInPlan?.toNumber()).toBe(4000);
      expect(item.referenceRateTo?.toNumber()).toBe(40);
      expect(item.catalogCurrency).toBe('USD');
    }
    const plan = (
      await as(clinicA).get(`/treatment-plans/${planId}`).expect(200)
    ).body as {
      quoteIssuedOn: string;
      quoteValidUntil: string;
      quoteExpired: boolean;
    };
    expect(plan).toMatchObject({
      quoteIssuedOn: caracasDay(0),
      quoteValidUntil: caracasDay(30),
      quoteExpired: false,
    });

    const row = await raw.treatmentPlanRepricing.findUniqueOrThrow({
      where: { id: applied.repricingId },
    });
    expect(row).toMatchObject({
      tenantId: clinicA.tenantId,
      planId,
      patientId,
      source: 'MANUAL',
      idempotencyKey: key,
      previewHash: p.previewHash,
      rateCurrency: 'USD',
    });
    expect(row.totalBefore.toNumber()).toBe(7200);
    expect(row.totalAfter.toNumber()).toBe(8000);

    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinicA.tenantId,
        resourceType: 'TREATMENT_PLAN',
        resourceId: planId,
        action: 'UPDATE',
      },
    });
    const repriced = events.filter(
      (e) => (e.metadata as { reason?: string }).reason === 'PLAN_REPRICED',
    );
    expect(repriced).toHaveLength(1);
    expect(repriced[0].patientId).toBe(patientId);
    expect(repriced[0].metadata).toMatchObject({
      params: { patientId, planId, repricingId: applied.repricingId },
    });
    // Ni importes ni la huella en la auditoría.
    expect(JSON.stringify(repriced[0].metadata)).not.toMatch(
      /4000|3600|8000|7200|[0-9a-f]{64}/,
    );

    // Repetir con la misma clave: lo mismo, sin escribir otra vez.
    const again = await as(clinicA, tokens.DENTIST)
      .post(`${repricePath(planId)}/apply`, { previewHash: p.previewHash }, key)
      .expect(200);
    expect(again.body).toMatchObject({
      repricingId: applied.repricingId,
      replayed: true,
      totals: p.totals,
    });
    expect(await raw.treatmentPlanRepricing.count({ where: { planId } })).toBe(
      1,
    );
    // La misma clave con otra petición: 422.
    const reused = await as(clinicA, tokens.DENTIST)
      .post(
        `${repricePath(planId)}/apply`,
        { previewHash: p.previewHash, itemIds: [items[0]] },
        key,
      )
      .expect(422);
    expect(reused.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('huella obsoleta (la tasa cambió desde la vista previa) → 409 y nada cambia', async () => {
    const { planId, items } = await presentedPlan();
    await setRate(40);
    const p = await preview(planId);
    await setRate(42);
    const res = await as(clinicA)
      .post(
        `${repricePath(planId)}/apply`,
        { previewHash: p.previewHash },
        newKey(),
      )
      .expect(409);
    expect(res.body).toMatchObject({
      code: 'REPRICE_PREVIEW_STALE',
      message: REPRICE_STALE_MESSAGE,
    });
    const stored = await raw.treatmentPlanItem.findMany({
      where: { id: { in: items } },
    });
    expect(stored.map((i) => i.price.toNumber())).toEqual([3600, 3600]);
    expect(await raw.treatmentPlanRepricing.count({ where: { planId } })).toBe(
      0,
    );
    const plan = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: planId },
      select: { quoteValidUntil: true },
    });
    expect(plan.quoteValidUntil?.toISOString().slice(0, 10)).toBe('2026-10-01');
  });

  it('Idempotency-Key obligatoria y UUID; huella mal formada → 400', async () => {
    const { planId } = await presentedPlan();
    const p = await preview(planId);
    const path = `${repricePath(planId)}/apply`;
    const missing = await as(clinicA)
      .post(path, { previewHash: p.previewHash })
      .expect(400);
    expect(missing.body).toMatchObject({
      message: REPRICE_IDEMPOTENCY_KEY_REQUIRED_MESSAGE,
    });
    const invalid = await as(clinicA)
      .post(path, { previewHash: p.previewHash }, 'no-es-uuid')
      .expect(400);
    expect(invalid.body).toMatchObject({
      message: IDEMPOTENCY_KEY_INVALID_MESSAGE,
    });
    await as(clinicA).post(path, { previewHash: 'xyz' }, newKey()).expect(400);
    expect(await raw.treatmentPlanRepricing.count({ where: { planId } })).toBe(
      0,
    );
  });

  it('un enlace de firma a distancia pendiente deja de valer al recotizar', async () => {
    const { planId } = await presentedPlan();
    mailer.clear();
    await as(clinicA)
      .post(`/patients/${patientId}/signature-requests`, {
        type: 'BUDGET',
        channel: 'EMAIL',
        treatmentPlanId: planId,
      })
      .expect(201);
    await dispatcher.whenIdle();
    const token = (await mailer.waitFor(EMAIL, TOKEN_IN_TEXT))[1];
    const pub = () =>
      server()
        .get(`/api/v1/public/sign/${token}`)
        .set('X-Tenant-Host', clinicA.host);
    await pub().expect(200);

    await setRate(40);
    const p = await preview(planId);
    await as(clinicA)
      .post(
        `${repricePath(planId)}/apply`,
        { previewHash: p.previewHash },
        newKey(),
      )
      .expect(200);
    const res = await pub().expect(404);
    expect(res.body).toMatchObject({ message: SIGNATURE_LINK_INVALID_MESSAGE });
  });

  it('un borrador sin fechas queda con la validez de hoy', async () => {
    await setRate(36);
    const plan = await as(clinicA)
      .post(`/patients/${patientId}/treatment-plans`, { currency: 'VES' })
      .expect(201);
    const planId = (plan.body as { id: string }).id;
    await as(clinicA)
      .post(`/treatment-plans/${planId}/items`, {
        toothNumber: '11',
        catalogItemId,
      })
      .expect(201);
    await setRate(38);
    const p = await preview(planId);
    expect(p.previousValidity).toBeNull();
    await as(clinicA)
      .post(
        `${repricePath(planId)}/apply`,
        { previewHash: p.previewHash },
        newKey(),
      )
      .expect(200);
    const stored = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: planId },
      select: { status: true, quoteIssuedOn: true, quoteValidUntil: true },
    });
    expect(stored.status).toBe('DRAFT');
    expect(stored.quoteIssuedOn?.toISOString().slice(0, 10)).toBe(
      caracasDay(0),
    );
    expect(stored.quoteValidUntil?.toISOString().slice(0, 10)).toBe(
      caracasDay(30),
    );
  });

  it('plan aceptado → 409; un ítem pedido no propuesto → 409; sin cambios', async () => {
    const accepted = await presentedPlan();
    await as(clinicA)
      .patch(`/treatment-plans/${accepted.planId}`, { status: 'ACCEPTED' })
      .expect(200);
    const res = await as(clinicA)
      .post(`${repricePath(accepted.planId)}/preview`)
      .expect(409);
    expect(res.body).toMatchObject({
      message: repricePlanStatusMessage('ACCEPTED'),
    });
    await as(clinicA)
      .post(
        `${repricePath(accepted.planId)}/apply`,
        { previewHash: 'a'.repeat(64) },
        newKey(),
      )
      .expect(409);

    const open = await presentedPlan();
    await as(clinicA)
      .patch(`/treatment-plans/${open.planId}/items/${open.items[0]}`, {
        status: 'ACCEPTED',
      })
      .expect(200);
    const named = await as(clinicA)
      .post(`${repricePath(open.planId)}/preview`, {
        itemIds: [open.items[0]],
      })
      .expect(409);
    expect(named.body).toMatchObject({
      message: REPRICE_ITEM_NOT_PROPOSED_MESSAGE,
    });
    // Sin nombrar ítems, el aceptado se lista como saltado.
    const p = await preview(open.planId);
    expect(p.skipped).toEqual([
      expect.objectContaining({
        itemId: open.items[0],
        reason: 'NOT_PROPOSED',
      }),
    ]);
    expect(
      await raw.treatmentPlanRepricing.count({
        where: { planId: { in: [accepted.planId, open.planId] } },
      }),
    ).toBe(0);
  });

  it('roles: los que editan ítems (ADMIN, DENTIST, ASSISTANT) recotizan; recepción → 403', async () => {
    const { planId } = await presentedPlan();
    for (const role of [
      ClinicRole.ADMIN,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
    ]) {
      await preview(planId, tokens[role]);
    }
    await as(clinicA, tokens.RECEPTION)
      .post(`${repricePath(planId)}/preview`)
      .expect(403);
    await as(clinicA, tokens.RECEPTION)
      .post(
        `${repricePath(planId)}/apply`,
        { previewHash: 'a'.repeat(64) },
        newKey(),
      )
      .expect(403);
    // La asistente aplica (sin descuentos que suban, no hace falta tope).
    await setRate(40);
    const p = await preview(planId, tokens.ASSISTANT);
    await as(clinicA, tokens.ASSISTANT)
      .post(
        `${repricePath(planId)}/apply`,
        { previewHash: p.previewHash },
        newKey(),
      )
      .expect(200);
  });

  // ISOLATION_COVERS: POST /patients/:patientId/treatment-plans/:planId/reprice/apply
  it('aislamiento: B → 404 en la vista previa y al aplicar sobre el plan de A (reprice/apply con clave válida) y nada de A cambia', async () => {
    const { planId, items } = await presentedPlan();
    await setRate(40);
    const p = await preview(planId);
    await as(clinicB)
      .post(`${repricePath(planId)}/preview`)
      .expect(404);
    await as(clinicB)
      .post(
        `${repricePath(planId)}/apply`,
        { previewHash: p.previewHash },
        newKey(),
      )
      .expect(404);
    // El plan de A con otro paciente en la ruta: 404 también.
    const other = await as(clinicA)
      .post('/patients', {
        docType: 'NATIONAL_ID',
        sex: 'M',
        firstName: 'Pedro',
        lastName: 'Ajeno',
        docNumber: 'DX379B-2',
      })
      .expect(201);
    const otherId = (other.body as { id: string }).id;
    await as(clinicA)
      .post(`${repricePath(planId, otherId)}/preview`)
      .expect(404);
    const stored = await raw.treatmentPlanItem.findMany({
      where: { id: { in: items } },
    });
    expect(stored.map((i) => i.price.toNumber())).toEqual([3600, 3600]);
    expect(await raw.treatmentPlanRepricing.count({ where: { planId } })).toBe(
      0,
    );
  });
});
