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
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  MAIL_CONFIG,
  loadMailConfig,
} from '../src/modules/notifications/email/infrastructure/mail-config';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { SIGNATURE_LINK_INVALID_MESSAGE } from '../src/modules/signature-requests/application/use-cases/public-signature.use-cases';
import { addCivilDays } from '../src/shared/time/civil-day';
import { fixedSedeDay } from './support/sede-clock';
import { TREATMENT_PLAN_CLOCK } from '../src/modules/treatment-plans/application/plan-clock';
import { EXCHANGE_RATE_CLOCK } from '../src/modules/exchange/application/use-cases/manual-exchange-rates.use-cases';
import {
  PLAN_QUOTE_CLOCK,
  QUOTE_CHANGED_MESSAGE,
} from '../src/modules/treatment-plans/application/use-cases/plan-quote.use-cases';

// DX-417 en HTTP real: aceptar en la clínica solo una parte del presupuesto.
// Plan en VES (catálogo en USD a la tasa manual de 36) con tres ítems a 3600.
// Vista previa (pura) → firma de lo elegido: el original queda ACCEPTED con
// ellos y el resto pasa, con su mismo id, a un plan nuevo PRESENTED enlazado,
// que aparece en «Presupuestos por seguir» y se acepta después. Los 400, 404
// y 409 en español; parcial + vencido en los dos modos; roles, otra clínica,
// auditoría y la solicitud a distancia del original, que deja de valer.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const EMAIL = 'rosa.blanco@example.com';
const TOKEN_IN_TEXT = /\/firmar\/([A-Za-z0-9_-]{43})/;
// «Hoy» FIJO de la sede (DX-460).
const SEDE = fixedSedeDay();
const sedeDay = (offset = 0) => addCivilDays(SEDE.day, offset);

interface Total {
  currency: string;
  gross: number;
  discount: number;
  net: number;
}
interface QuoteDoc {
  contentHash: string;
  planStatus: string;
  validUntil: string;
  items: { id: string; unitPrice: number }[];
  totals: Total[];
  acceptance: {
    integrityOk: boolean;
    expiredMode: string | null;
    repricingId: string | null;
    pendingPlanId: string | null;
    pendingItemIds: string[] | null;
    pendingTotal: number | null;
  } | null;
}
interface PartialPreview {
  accepted: QuoteDoc;
  pending: { items: { id: string; unitPrice: number }[]; totals: Total[] };
  original: { totals: Total[] };
  repricing: { previewHash: string } | null;
}
interface PlanDto {
  id: string;
  status: string;
  splitFromPlanId: string | null;
  partialPendingPlanId?: string | null;
  quoteExpired: boolean;
  quoteValidUntil: string | null;
  optionGroupId: string | null;
  items?: { id: string; status: string }[];
}

describe('Aceptación parcial del presupuesto (e2e, DX-417)', () => {
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
      post: (path: string, body: object = {}) =>
        set(server().post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) =>
        set(server().patch(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        set(server().put(`/api/v1${path}`)).send(body),
    };
  };
  const planPath = (planId: string) =>
    `/patients/${patientId}/treatment-plans/${planId}`;

  async function setRate(rate: number): Promise<void> {
    await raw.manualExchangeRate.updateMany({
      where: { tenantId: clinicA.tenantId, currency: 'VES' },
      data: { rate },
    });
  }

  /** Plan en VES con tres ítems a 3600 (sin presentar). */
  async function draftPlan(): Promise<{ planId: string; items: string[] }> {
    await setRate(36);
    const plan = await as(clinicA)
      .post(`/patients/${patientId}/treatment-plans`, { currency: 'VES' })
      .expect(201);
    const planId = (plan.body as { id: string }).id;
    const items: string[] = [];
    for (const toothNumber of ['16', '36', '46']) {
      const item = await as(clinicA)
        .post(`/treatment-plans/${planId}/items`, {
          toothNumber,
          catalogItemId,
        })
        .expect(201);
      items.push((item.body as { id: string }).id);
    }
    return { planId, items };
  }

  async function presentedPlan() {
    const plan = await draftPlan();
    await as(clinicA)
      .post(`/treatment-plans/${plan.planId}/present`)
      .expect(200);
    return plan;
  }

  /** Presentado y vencido el 1/10/2026. */
  async function expiredPlan() {
    const plan = await presentedPlan();
    await raw.treatmentPlan.update({
      where: { id: plan.planId },
      data: {
        quoteIssuedOn: new Date('2026-09-01T00:00:00.000Z'),
        quoteValidUntil: new Date('2026-10-01T00:00:00.000Z'),
      },
    });
    return plan;
  }

  const preview = (planId: string, body: object, token = tokens.DENTIST) =>
    as(clinicA, token).post(
      `${planPath(planId)}/acceptance/partial-preview`,
      body,
    );

  const shownPreview = async (planId: string, body: object) =>
    (await preview(planId, body).expect(200)).body as PartialPreview;

  const accept = (planId: string, body: object, token = tokens.DENTIST) =>
    as(clinicA, token).post(`${planPath(planId)}/acceptance`, {
      signerName: 'Rosa Blanco',
      signature: `data:image/png;base64,${PNG}`,
      ...body,
    });

  const plan = async (planId: string) =>
    (await as(clinicA).get(`/treatment-plans/${planId}`).expect(200))
      .body as PlanDto;

  /** Nada escrito: el plan sigue presentado con sus tres ítems propuestos. */
  async function expectUntouched(planId: string, items: string[]) {
    const rows = await raw.treatmentPlanItem.findMany({
      where: { id: { in: items } },
    });
    expect(rows.map((i) => [i.planId, i.status])).toEqual(
      items.map(() => [planId, 'PROPOSED']),
    );
    expect(
      await raw.treatmentPlan.findUniqueOrThrow({
        where: { id: planId },
        select: { status: true },
      }),
    ).toEqual({ status: 'PRESENTED' });
    expect(await raw.treatmentPlanAcceptance.count({ where: { planId } })).toBe(
      0,
    );
    expect(
      await raw.treatmentPlan.count({ where: { splitFromPlanId: planId } }),
    ).toBe(0);
  }

  async function events(planId: string, action: 'SIGN' | 'VIEW') {
    return raw.auditEvent.findMany({
      where: {
        tenantId: clinicA.tenantId,
        resourceType: 'TREATMENT_PLAN',
        resourceId: planId,
        action,
      },
    });
  }

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp({
      override: (builder) => {
        builder.overrideProvider(TREATMENT_PLAN_CLOCK).useValue(() => SEDE.at);
        builder.overrideProvider(PLAN_QUOTE_CLOCK).useValue(() => SEDE.at);
        builder.overrideProvider(EXCHANGE_RATE_CLOCK).useValue(() => SEDE.at);
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
    clinicA = await registerClinic(app, 'dx417-parcial-a');
    clinicB = await registerClinic(app, 'dx417-parcial-b');
    tokens.ADMIN = clinicA.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const m = await seedMember(raw, clinicA, role);
      tokens[role] = await loginAs(app, clinicA.host, m.email);
    }
    await pinCatalogCurrency(raw, clinicA.tenantId, 'USD');
    await as(clinicA)
      .put('/exchange/settings', { source: 'MANUAL' })
      .expect(200);
    for (const offset of [-1, 0]) {
      await as(clinicA)
        .post('/exchange/manual-rates', {
          date: sedeDay(offset),
          currency: 'VES',
          rate: 36,
        })
        .expect(201);
    }
    const patient = await as(clinicA)
      .post('/patients', {
        docType: 'NATIONAL_ID',
        sex: 'F',
        firstName: 'Rosa',
        lastName: 'Blanco',
        docNumber: 'DX417-1',
        email: EMAIL,
        birthDate: '1985-07-02',
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
    const catalog = await as(clinicA)
      .post('/catalog/items', {
        code: 'DX417-RES',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Resina compuesta',
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

  it('flujo feliz: vista previa → firma; original ACCEPTED con lo elegido y pendiente PRESENTED enlazado, con totales que cuadran', async () => {
    const { planId, items } = await presentedPlan();
    const p = await shownPreview(planId, { itemIds: [items[2], items[0]] });
    expect(p.accepted.planStatus).toBe('PRESENTED');
    expect(p.accepted.items.map((i) => i.id)).toEqual([items[0], items[2]]);
    expect(p.pending.items.map((i) => i.id)).toEqual([items[1]]);
    expect(p.accepted.totals[0]).toMatchObject({ currency: 'VES', net: 7200 });
    expect(p.pending.totals[0]).toMatchObject({ currency: 'VES', net: 3600 });
    expect(p.original.totals[0]).toMatchObject({ currency: 'VES', net: 10800 });
    expect(p.repricing).toBeNull();
    await expectUntouched(planId, items);
    const [view] = await events(planId, 'VIEW');
    expect(view.metadata).toMatchObject({ reason: 'ACCEPT_PARTIAL_PREVIEW' });

    const res = await accept(planId, {
      contentHash: p.accepted.contentHash,
      partial: { itemIds: [items[0], items[2]] },
    }).expect(201);
    const doc = res.body as QuoteDoc;
    expect(doc.planStatus).toBe('ACCEPTED');
    expect(doc.contentHash).toBe(p.accepted.contentHash);
    expect(doc.totals[0].net).toBe(7200);
    const pendingPlanId = doc.acceptance!.pendingPlanId!;
    expect(doc.acceptance).toMatchObject({
      integrityOk: true,
      expiredMode: null,
      pendingItemIds: [items[1]],
      pendingTotal: 3600,
    });

    const original = await plan(planId);
    expect(original).toMatchObject({
      status: 'ACCEPTED',
      splitFromPlanId: null,
      partialPendingPlanId: pendingPlanId,
    });
    expect(original.items!.map((i) => [i.id, i.status]).sort()).toEqual(
      [
        [items[0], 'ACCEPTED'],
        [items[2], 'ACCEPTED'],
      ].sort(),
    );
    const pending = await plan(pendingPlanId);
    expect(pending).toMatchObject({
      status: 'PRESENTED',
      splitFromPlanId: planId,
      partialPendingPlanId: null,
      optionGroupId: null,
      quoteExpired: false,
      quoteValidUntil: sedeDay(30),
    });
    expect(pending.items!.map((i) => [i.id, i.status])).toEqual([
      [items[1], 'PROPOSED'],
    ]);
    // La lista del paciente enlaza los dos.
    const list = (
      await as(clinicA)
        .get(`/patients/${patientId}/treatment-plans`)
        .expect(200)
    ).body as PlanDto[];
    expect(list.find((x) => x.id === planId)).toMatchObject({
      partialPendingPlanId: pendingPlanId,
    });
    expect(list.find((x) => x.id === pendingPlanId)).toMatchObject({
      splitFromPlanId: planId,
    });
    // El documento firmado lo dice (reimpreso).
    const reprinted = (
      await as(clinicA)
        .get(`${planPath(planId)}/quote`)
        .expect(200)
    ).body as QuoteDoc;
    expect(reprinted.acceptance).toMatchObject({
      integrityOk: true,
      pendingPlanId,
      pendingTotal: 3600,
    });
    // Auditoría sin importes.
    const [sign] = await events(planId, 'SIGN');
    expect(sign.metadata).toEqual({
      params: { patientId, planId, pendingPlanId },
      reason: 'PLAN_PARTIALLY_ACCEPTED',
    });

    // El pendiente sale en «Presupuestos por seguir» con su antigüedad.
    await raw.treatmentPlan.updateMany({
      where: { id: { in: [planId, pendingPlanId] } },
      data: { presentedAt: new Date(SEDE.at.getTime() - 10 * 86_400_000) },
    });
    const follow = (
      await as(clinicA)
        .get('/treatment-plans/pending-follow-up?olderThanDays=7')
        .expect(200)
    ).body as { items: { planId: string; total: number }[] };
    expect(follow.items.map((i) => i.planId)).toContain(pendingPlanId);
    expect(follow.items.map((i) => i.planId)).not.toContain(planId);
    expect(follow.items.find((i) => i.planId === pendingPlanId)).toMatchObject({
      total: 3600,
    });

    // Y se acepta después, entero, con su propio presupuesto.
    const rest = (
      await as(clinicA)
        .get(`${planPath(pendingPlanId)}/quote`)
        .expect(200)
    ).body as QuoteDoc;
    await accept(pendingPlanId, { contentHash: rest.contentHash }).expect(201);
    expect((await plan(pendingPlanId)).status).toBe('ACCEPTED');
  });

  it('las reglas en español: todos o ninguno → 400, ítem ajeno → 404, borrador o ya aceptado → 409, hash del entero → 409; nada se escribe', async () => {
    const { planId, items } = await presentedPlan();
    const all = await preview(planId, { itemIds: items }).expect(400);
    expect(all.body).toMatchObject({
      message: 'Has elegido todos los procedimientos: acéptalo entero.',
    });
    const none = await preview(planId, { itemIds: [] }).expect(400);
    expect(JSON.stringify(none.body)).toContain(
      'Elige al menos un procedimiento para aceptar.',
    );
    const other = await draftPlan();
    const foreign = await preview(planId, {
      itemIds: [other.items[0]],
    }).expect(404);
    expect(foreign.body).toMatchObject({
      message: 'Algún ítem no existe o no es de este plan de tratamiento.',
    });
    const draft = await preview(other.planId, {
      itemIds: [other.items[0]],
    }).expect(409);
    expect(draft.body).toMatchObject({
      code: 'PARTIAL_PLAN_NOT_PRESENTED',
      message: 'Solo un presupuesto presentado se acepta en parte.',
    });
    const whole = (
      await as(clinicA)
        .get(`${planPath(planId)}/quote`)
        .expect(200)
    ).body as QuoteDoc;
    const changed = await accept(planId, {
      contentHash: whole.contentHash,
      partial: { itemIds: [items[0]] },
    }).expect(409);
    expect(changed.body).toMatchObject({ message: QUOTE_CHANGED_MESSAGE });
    const allSign = await accept(planId, {
      contentHash: whole.contentHash,
      partial: { itemIds: items },
    }).expect(400);
    expect(allSign.body).toMatchObject({
      message: 'Has elegido todos los procedimientos: acéptalo entero.',
    });
    await expectUntouched(planId, items);

    // Un ítem ya realizado dejado fuera: 400.
    await as(clinicA, tokens.DENTIST)
      .patch(`/treatment-plans/${planId}/items/${items[1]}`, { status: 'DONE' })
      .expect(200);
    const done = await preview(planId, { itemIds: [items[0]] }).expect(400);
    expect(done.body).toMatchObject({
      message:
        'Los procedimientos ya aceptados o realizados forman parte de lo aceptado.',
    });
    await shownPreview(planId, { itemIds: [items[0], items[1]] });

    // Aceptado (sin firma) por el PATCH: 409 con su código.
    await as(clinicA, tokens.DENTIST)
      .patch(`/treatment-plans/${planId}`, { status: 'ACCEPTED' })
      .expect(200);
    const accepted = await preview(planId, { itemIds: [items[0]] }).expect(409);
    expect(accepted.body).toMatchObject({
      code: 'PARTIAL_PLAN_ALREADY_ACCEPTED',
      message: 'El plan ya está aceptado: no se puede aceptar en parte.',
    });
  });

  it('con un abono vivo: 409 y nada se escribe', async () => {
    const { planId, items } = await presentedPlan();
    const p = await shownPreview(planId, { itemIds: [items[0]] });
    // El abono, sembrado directo (el cobro por la API exige caja abierta).
    const location = await raw.location.findFirstOrThrow({
      where: { tenantId: clinicA.tenantId },
    });
    await raw.payment.create({
      data: {
        tenantId: clinicA.tenantId,
        locationId: location.id,
        treatmentPlanId: planId,
        patientId,
        amount: 100,
        currency: 'VES',
        paidAt: SEDE.at,
      },
    });
    const res = await accept(planId, {
      contentHash: p.accepted.contentHash,
      partial: { itemIds: [items[0]] },
    }).expect(409);
    expect(res.body).toMatchObject({
      message:
        'El plan tiene abonos registrados: no se acepta en parte. Anula los abonos o acéptalo entero.',
    });
    await expectUntouched(planId, items);
  });

  it('vencido con los precios originales: firma lo elegido con motivo y el pendiente nace vencido', async () => {
    const { planId, items } = await expiredPlan();
    const p = await shownPreview(planId, { itemIds: [items[0]] });
    const noChoice = await accept(planId, {
      contentHash: p.accepted.contentHash,
      partial: { itemIds: [items[0]] },
    }).expect(409);
    expect(noChoice.body).toMatchObject({ code: 'QUOTE_EXPIRED' });
    await expectUntouched(planId, items);

    const res = await accept(planId, {
      contentHash: p.accepted.contentHash,
      partial: { itemIds: [items[0]] },
      expired: { mode: 'ORIGINAL_PRICES', reason: 'LOYALTY' },
    }).expect(201);
    const doc = res.body as QuoteDoc;
    expect(doc.validUntil).toBe('2026-10-01');
    const pendingPlanId = doc.acceptance!.pendingPlanId!;
    expect(doc.acceptance).toMatchObject({
      expiredMode: 'ORIGINAL_PRICES',
      pendingItemIds: [items[1], items[2]],
      pendingTotal: 7200,
    });
    expect(await plan(pendingPlanId)).toMatchObject({
      status: 'PRESENTED',
      quoteExpired: true,
      quoteValidUntil: '2026-10-01',
    });
    const [sign] = await events(planId, 'SIGN');
    expect(sign.metadata).toEqual({
      params: { patientId, planId, pendingPlanId },
      reason: 'QUOTE_EXPIRED_ORIGINAL_PRICES',
    });
  });

  it('vencido actualizando los precios: recotiza TODO, parte después y el pendiente hereda la validez nueva', async () => {
    const { planId, items } = await expiredPlan();
    await setRate(40);
    const p = await shownPreview(planId, {
      itemIds: [items[0]],
      reprice: true,
    });
    expect(p.repricing).not.toBeNull();
    expect(p.accepted.items.map((i) => i.unitPrice)).toEqual([4000]);
    expect(p.accepted.validUntil).toBe(sedeDay(30));
    expect(p.pending.items.map((i) => i.unitPrice)).toEqual([4000, 4000]);
    expect(p.original.totals[0].net).toBe(12000);
    // La vista previa no deja nada escrito.
    await expectUntouched(planId, items);
    expect(await raw.treatmentPlanRepricing.count({ where: { planId } })).toBe(
      0,
    );

    const res = await accept(planId, {
      contentHash: p.accepted.contentHash,
      partial: { itemIds: [items[0]] },
      expired: {
        mode: 'REPRICE',
        repricePreviewHash: p.repricing!.previewHash,
      },
    }).expect(201);
    const doc = res.body as QuoteDoc;
    expect(doc.contentHash).toBe(p.accepted.contentHash);
    const repricing = await raw.treatmentPlanRepricing.findFirstOrThrow({
      where: { planId },
    });
    const pendingPlanId = doc.acceptance!.pendingPlanId!;
    expect(doc.acceptance).toMatchObject({
      expiredMode: 'REPRICE',
      repricingId: repricing.id,
      pendingTotal: 8000,
    });
    expect(await plan(pendingPlanId)).toMatchObject({
      status: 'PRESENTED',
      quoteExpired: false,
      quoteValidUntil: sedeDay(30),
    });
    const moved = await raw.treatmentPlanItem.findMany({
      where: { planId: pendingPlanId },
    });
    expect(moved.map((i) => i.price.toNumber())).toEqual([4000, 4000]);
    const [sign] = await events(planId, 'SIGN');
    expect(sign.metadata).toEqual({
      params: { patientId, planId, repricingId: repricing.id, pendingPlanId },
      reason: 'QUOTE_EXPIRED_REPRICED',
    });
  });

  it('roles y otra clínica: asistente y recepción 403; la clínica B no ve el plan (404) y nada cambia', async () => {
    const { planId, items } = await presentedPlan();
    for (const role of [ClinicRole.ASSISTANT, ClinicRole.RECEPTION]) {
      await preview(planId, { itemIds: [items[0]] }, tokens[role]).expect(403);
      await accept(
        planId,
        { contentHash: 'a'.repeat(64), partial: { itemIds: [items[0]] } },
        tokens[role],
      ).expect(403);
    }
    await as(clinicB)
      .post(`${planPath(planId)}/acceptance/partial-preview`, {
        itemIds: [items[0]],
      })
      .expect(404);
    await as(clinicB)
      .post(`${planPath(planId)}/acceptance`, {
        signerName: 'Ajena',
        signature: `data:image/png;base64,${PNG}`,
        contentHash: 'a'.repeat(64),
        partial: { itemIds: [items[0]] },
      })
      .expect(404);
    await expectUntouched(planId, items);
  });

  it('la solicitud de firma a distancia del original deja de valer tras aceptarlo en parte', async () => {
    const { planId, items } = await presentedPlan();
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
    await server()
      .get(`/api/v1/public/sign/${token}`)
      .set('X-Tenant-Host', clinicA.host)
      .expect(200);

    const p = await shownPreview(planId, { itemIds: [items[0]] });
    await accept(planId, {
      contentHash: p.accepted.contentHash,
      partial: { itemIds: [items[0]] },
    }).expect(201);

    const res = await server()
      .get(`/api/v1/public/sign/${token}`)
      .set('X-Tenant-Host', clinicA.host)
      .expect(404);
    expect(res.body).toMatchObject({ message: SIGNATURE_LINK_INVALID_MESSAGE });
  });
});
