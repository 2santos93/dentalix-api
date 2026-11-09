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
import { addCivilDays } from '../src/shared/time/civil-day';
import { fixedSedeDay } from './support/sede-clock';
import { TREATMENT_PLAN_CLOCK } from '../src/modules/treatment-plans/application/plan-clock';
import { EXCHANGE_RATE_CLOCK } from '../src/modules/exchange/application/use-cases/manual-exchange-rates.use-cases';
import {
  PLAN_ACCEPTED_CONFLICT_MESSAGE,
  PLAN_QUOTE_CLOCK,
  QUOTE_CHANGED_MESSAGE,
} from '../src/modules/treatment-plans/application/use-cases/plan-quote.use-cases';
import {
  EXPIRED_NOT_EXPIRED_MESSAGE,
  EXPIRED_NOTE_REQUIRED_MESSAGE,
  EXPIRED_REASON_REQUIRED_MESSAGE,
} from '../src/modules/treatment-plans/domain/expired-quote-acceptance';

// DX-379 (porción C) en HTTP real: aceptar en la clínica un presupuesto
// vencido. Plan en VES con el catálogo en USD y tasa MANUAL de la clínica;
// validez guardada vencida el 1/10/2026. Sin elegir cómo → 409 QUOTE_EXPIRED;
// con los precios originales y motivo → firma el presupuesto vencido y lo
// deja dicho en la aceptación; actualizando los precios → vista previa (sin
// escribir) y firma del presupuesto recotizado en UNA transacción (si algo
// falla, nada queda). El PATCH «Aceptado» y el envío a distancia, bloqueados.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// «Hoy» FIJO de la sede (DX-460): el mediodía de ayer en Caracas, en los
// relojes del plan, del presupuesto y de las tasas.
const SEDE = fixedSedeDay();
const sedeDay = (offset = 0) => addCivilDays(SEDE.day, offset);

interface QuoteDoc {
  contentHash: string;
  planStatus: string;
  issuedOn: string;
  validUntil: string;
  items: { unitPrice: number }[];
  acceptance: {
    quoteValidUntil: string | null;
    expiredMode: string | null;
    expiredReason: string | null;
    expiredNote: string | null;
    repricingId: string | null;
    integrityOk: boolean;
  } | null;
}
interface RepricePreview {
  repricing: {
    previewHash: string;
    validityRenewed: boolean;
    validity: { issuedOn: string; validUntil: string } | null;
    lines: { after: { price: number } }[];
  };
  quote: QuoteDoc;
}

describe('Aceptar un presupuesto vencido (e2e, DX-379 porción C)', () => {
  let app: INestApplication<App>;
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

  /** Plan en VES presentado, dos ítems a la tasa de 36, validez vencida. */
  async function expiredPlan(): Promise<{ planId: string; items: string[] }> {
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
    await raw.treatmentPlan.update({
      where: { id: planId },
      data: {
        quoteIssuedOn: new Date('2026-09-01T00:00:00.000Z'),
        quoteValidUntil: new Date('2026-10-01T00:00:00.000Z'),
      },
    });
    return { planId, items };
  }

  const quote = async (planId: string) =>
    (
      await as(clinicA)
        .get(`${planPath(planId)}/quote`)
        .expect(200)
    ).body as QuoteDoc;

  const accept = (planId: string, body: object, token = tokens.DENTIST) =>
    as(clinicA, token).post(`${planPath(planId)}/acceptance`, {
      signerName: 'Luisa Méndez',
      signature: `data:image/png;base64,${PNG}`,
      ...body,
    });

  const repricePreview = async (planId: string) =>
    (
      await as(clinicA, tokens.DENTIST)
        .post(`${planPath(planId)}/acceptance/reprice-preview`)
        .expect(200)
    ).body as RepricePreview;

  /** Nada escrito: ítems a 3600, validez vencida, sin aceptación ni recotización. */
  async function expectUntouched(planId: string, items: string[]) {
    const prices = await raw.treatmentPlanItem.findMany({
      where: { id: { in: items } },
    });
    expect(prices.map((i) => i.price.toNumber())).toEqual([3600, 3600]);
    expect(prices.map((i) => i.status)).toEqual(['PROPOSED', 'PROPOSED']);
    const plan = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: planId },
      select: { status: true, quoteValidUntil: true },
    });
    expect(plan.status).toBe('PRESENTED');
    expect(plan.quoteValidUntil?.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(await raw.treatmentPlanAcceptance.count({ where: { planId } })).toBe(
      0,
    );
    expect(await raw.treatmentPlanRepricing.count({ where: { planId } })).toBe(
      0,
    );
  }

  async function signEvents(planId: string) {
    return raw.auditEvent.findMany({
      where: {
        tenantId: clinicA.tenantId,
        resourceType: 'TREATMENT_PLAN',
        resourceId: planId,
        action: 'SIGN',
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
      },
    });
    clinicA = await registerClinic(app, 'dx379c-vencido-a');
    clinicB = await registerClinic(app, 'dx379c-vencido-b');
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
        firstName: 'Luisa',
        lastName: 'Méndez',
        docNumber: 'DX379C-1',
        email: 'luisa.mendez@example.com',
        birthDate: '1990-03-14',
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
    const catalog = await as(clinicA)
      .post('/catalog/items', {
        code: 'DX379C-ENDO',
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

  it('sin elegir cómo: 409 QUOTE_EXPIRED en español con la fecha de la sede; el plan se ve vencido', async () => {
    const { planId, items } = await expiredPlan();
    const plan = (
      await as(clinicA).get(`/treatment-plans/${planId}`).expect(200)
    ).body as { quoteExpired: boolean; quoteValidUntil: string };
    expect(plan).toMatchObject({
      quoteExpired: true,
      quoteValidUntil: '2026-10-01',
    });
    const shown = await quote(planId);
    const res = await accept(planId, { contentHash: shown.contentHash }).expect(
      409,
    );
    expect(res.body).toMatchObject({
      code: 'QUOTE_EXPIRED',
      message:
        'El presupuesto venció el 01/10/2026. Actualiza los precios o acepta con los precios originales indicando el motivo.',
      quoteValidUntil: '2026-10-01',
    });
    await expectUntouched(planId, items);
  });

  it('recorrido «precios originales»: sin motivo u OTHER sin nota → 400; con motivo firma el vencido y lo deja dicho', async () => {
    const { planId, items } = await expiredPlan();
    const shown = await quote(planId);
    const noReason = await accept(planId, {
      contentHash: shown.contentHash,
      expired: { mode: 'ORIGINAL_PRICES' },
    }).expect(400);
    expect(noReason.body).toMatchObject({
      message: EXPIRED_REASON_REQUIRED_MESSAGE,
    });
    const noNote = await accept(planId, {
      contentHash: shown.contentHash,
      expired: { mode: 'ORIGINAL_PRICES', reason: 'OTHER' },
    }).expect(400);
    expect(noNote.body).toMatchObject({
      message: EXPIRED_NOTE_REQUIRED_MESSAGE,
    });
    await accept(planId, {
      contentHash: shown.contentHash,
      expired: { mode: 'ORIGINAL_PRICES', reason: 'NOT_A_REASON' },
    }).expect(400);
    await expectUntouched(planId, items);

    const res = await accept(planId, {
      contentHash: shown.contentHash,
      expired: {
        mode: 'ORIGINAL_PRICES',
        reason: 'OTHER',
        note: 'Se respetó el precio de la primera consulta',
      },
    }).expect(201);
    const doc = res.body as QuoteDoc;
    expect(doc.planStatus).toBe('ACCEPTED');
    expect(doc.contentHash).toBe(shown.contentHash);
    expect(doc.validUntil).toBe('2026-10-01');
    expect(doc.items.map((i) => i.unitPrice)).toEqual([3600, 3600]);
    const expectedAcceptance = {
      integrityOk: true,
      quoteValidUntil: '2026-10-01',
      expiredMode: 'ORIGINAL_PRICES',
      expiredReason: 'OTHER',
      expiredNote: 'Se respetó el precio de la primera consulta',
      repricingId: null,
    };
    expect(doc.acceptance).toMatchObject(expectedAcceptance);
    // El documento aceptado (reimpreso) dice lo mismo.
    expect((await quote(planId)).acceptance).toMatchObject(expectedAcceptance);
    const row = await raw.treatmentPlanAcceptance.findFirstOrThrow({
      where: { planId },
    });
    expect(row.quoteValidUntil?.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(row).toMatchObject({
      expiredMode: 'ORIGINAL_PRICES',
      expiredReason: 'OTHER',
      repricingId: null,
    });
    const [event] = await signEvents(planId);
    expect(event.metadata).toEqual({
      params: { patientId, planId },
      reason: 'QUOTE_EXPIRED_ORIGINAL_PRICES',
    });
  });

  it('recorrido «actualizar los precios»: vista previa sin escribir → firma del recotizado en una transacción', async () => {
    const { planId, items } = await expiredPlan();
    await setRate(40);
    const p = await repricePreview(planId);
    expect(p.repricing.validityRenewed).toBe(true);
    expect(p.repricing.lines.map((l) => l.after.price)).toEqual([4000, 4000]);
    expect(p.quote).toMatchObject({
      planStatus: 'PRESENTED',
      issuedOn: sedeDay(0),
      validUntil: sedeDay(30),
      acceptance: null,
    });
    expect(p.quote.items.map((i) => i.unitPrice)).toEqual([4000, 4000]);
    // La vista previa no deja nada escrito.
    await expectUntouched(planId, items);

    const res = await accept(planId, {
      contentHash: p.quote.contentHash,
      expired: { mode: 'REPRICE', repricePreviewHash: p.repricing.previewHash },
    }).expect(201);
    const doc = res.body as QuoteDoc;
    expect(doc.contentHash).toBe(p.quote.contentHash);
    expect(doc.items.map((i) => i.unitPrice)).toEqual([4000, 4000]);
    expect(doc.validUntil).toBe(sedeDay(30));

    const repricing = await raw.treatmentPlanRepricing.findFirstOrThrow({
      where: { planId },
    });
    expect(repricing).toMatchObject({
      source: 'ACCEPT',
      idempotencyKey: null,
      previewHash: p.repricing.previewHash,
      validityRenewed: true,
    });
    expect(doc.acceptance).toMatchObject({
      integrityOk: true,
      quoteValidUntil: '2026-10-01',
      expiredMode: 'REPRICE',
      expiredReason: null,
      repricingId: repricing.id,
    });
    const stored = await raw.treatmentPlanItem.findMany({
      where: { id: { in: items } },
    });
    for (const item of stored) {
      expect(item.price.toNumber()).toBe(4000);
      expect(item.referencePriceInPlan?.toNumber()).toBe(4000);
      expect(item.status).toBe('ACCEPTED');
    }
    const plan = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: planId },
      select: { status: true, quoteValidUntil: true },
    });
    expect(plan.status).toBe('ACCEPTED');
    expect(plan.quoteValidUntil?.toISOString().slice(0, 10)).toBe(sedeDay(30));
    const [event] = await signEvents(planId);
    expect(event.metadata).toEqual({
      params: { patientId, planId, repricingId: repricing.id },
      reason: 'QUOTE_EXPIRED_REPRICED',
    });
  });

  it('actualizar con la vista previa obsoleta (la tasa cambió) → 409 REPRICE_PREVIEW_STALE y nada escrito', async () => {
    const { planId, items } = await expiredPlan();
    await setRate(40);
    const p = await repricePreview(planId);
    await setRate(41);
    const res = await accept(planId, {
      contentHash: p.quote.contentHash,
      expired: { mode: 'REPRICE', repricePreviewHash: p.repricing.previewHash },
    }).expect(409);
    expect(res.body).toMatchObject({ code: 'REPRICE_PREVIEW_STALE' });
    await expectUntouched(planId, items);
  });

  it('actualizar con el contentHash del presupuesto VIEJO → 409 y la recotización ya escrita se deshace', async () => {
    const { planId, items } = await expiredPlan();
    const old = await quote(planId);
    await setRate(40);
    const p = await repricePreview(planId);
    const res = await accept(planId, {
      contentHash: old.contentHash,
      expired: { mode: 'REPRICE', repricePreviewHash: p.repricing.previewHash },
    }).expect(409);
    expect(res.body).toMatchObject({ message: QUOTE_CHANGED_MESSAGE });
    await expectUntouched(planId, items);
  });

  it('elegir cómo con un presupuesto NO vencido → 400', async () => {
    const { planId, items } = await expiredPlan();
    await raw.treatmentPlan.update({
      where: { id: planId },
      data: { quoteValidUntil: new Date(`${sedeDay(5)}T00:00:00.000Z`) },
    });
    const shown = await quote(planId);
    const res = await accept(planId, {
      contentHash: shown.contentHash,
      expired: { mode: 'ORIGINAL_PRICES', reason: 'LOYALTY' },
    }).expect(400);
    expect(res.body).toMatchObject({ message: EXPIRED_NOT_EXPIRED_MESSAGE });
    // M-2: la vista previa de «actualizar los precios» tampoco.
    const preview = await as(clinicA, tokens.DENTIST)
      .post(`${planPath(planId)}/acceptance/reprice-preview`)
      .expect(400);
    expect(preview.body).toMatchObject({
      message: EXPIRED_NOT_EXPIRED_MESSAGE,
    });
    expect(
      await raw.treatmentPlanItem.count({
        where: { id: { in: items }, status: 'PROPOSED' },
      }),
    ).toBe(2);
    // Sin `expired`, se acepta como siempre (y se copia la validez).
    const ok = await accept(planId, { contentHash: shown.contentHash }).expect(
      201,
    );
    expect((ok.body as QuoteDoc).acceptance).toMatchObject({
      quoteValidUntil: sedeDay(5),
      expiredMode: null,
    });
  });

  it('dos firmas a la vez («actualizar los precios»): una acepta, la otra 409 ya firmado; una sola recotización', async () => {
    const { planId } = await expiredPlan();
    await setRate(40);
    const p = await repricePreview(planId);
    const body = {
      contentHash: p.quote.contentHash,
      expired: { mode: 'REPRICE', repricePreviewHash: p.repricing.previewHash },
    };
    const results = await Promise.all([
      accept(planId, body),
      accept(planId, body, tokens.ADMIN),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const conflict = results.find((r) => r.status === 409)!;
    expect(conflict.body).toMatchObject({
      message: PLAN_ACCEPTED_CONFLICT_MESSAGE,
    });
    expect(await raw.treatmentPlanRepricing.count({ where: { planId } })).toBe(
      1,
    );
    expect(await raw.treatmentPlanAcceptance.count({ where: { planId } })).toBe(
      1,
    );
  });

  it('PATCH «Aceptado» de un vencido → 409 QUOTE_EXPIRED; el plan sigue presentado', async () => {
    const { planId, items } = await expiredPlan();
    const res = await as(clinicA, tokens.DENTIST)
      .patch(`/treatment-plans/${planId}`, { status: 'ACCEPTED' })
      .expect(409);
    expect(res.body).toMatchObject({
      code: 'QUOTE_EXPIRED',
      message:
        'El presupuesto venció el 01/10/2026: acéptalo con firma para elegir cómo.',
    });
    await expectUntouched(planId, items);
  });

  it('enviar a firmar a distancia un vencido → 409 QUOTE_EXPIRED; no se crea la solicitud', async () => {
    const { planId } = await expiredPlan();
    const res = await as(clinicA)
      .post(`/patients/${patientId}/signature-requests`, {
        type: 'BUDGET',
        channel: 'EMAIL',
        treatmentPlanId: planId,
      })
      .expect(409);
    expect(res.body).toMatchObject({
      code: 'QUOTE_EXPIRED',
      quoteValidUntil: '2026-10-01',
    });
    expect(
      await raw.signatureRequest.count({ where: { treatmentPlanId: planId } }),
    ).toBe(0);
  });

  it('la vista previa: solo quien acepta (asistente y recepción 403); la otra clínica no ve el plan (404)', async () => {
    const { planId, items } = await expiredPlan();
    for (const role of [ClinicRole.ASSISTANT, ClinicRole.RECEPTION]) {
      await as(clinicA, tokens[role])
        .post(`${planPath(planId)}/acceptance/reprice-preview`)
        .expect(403);
    }
    await as(clinicB)
      .post(`${planPath(planId)}/acceptance/reprice-preview`)
      .expect(404);
    const shown = await quote(planId);
    await as(clinicB)
      .post(`${planPath(planId)}/acceptance`, {
        signerName: 'Ajena',
        signature: `data:image/png;base64,${PNG}`,
        contentHash: shown.contentHash,
        expired: { mode: 'ORIGINAL_PRICES', reason: 'LOYALTY' },
      })
      .expect(404);
    await expectUntouched(planId, items);
  });
});
