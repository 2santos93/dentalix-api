import { createHash, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
  type Clinic,
} from './support/e2e-fixtures';
import { pngFixture } from './support/document-fixtures';
import {
  RATE_LIMIT_CONFIG,
  loadRateLimitConfig,
} from '../src/shared/security/rate-limit.config';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import {
  PAYMENT_LINK_BALANCE_NOT_FOUND_MESSAGE,
  PAYMENT_LINK_NOT_FOUND_MESSAGE,
  PAYMENT_LINK_PLAN_NOT_FOUND_MESSAGE,
  PAYMENT_LINK_TARGET_REQUIRED_MESSAGE,
  PAYMENT_REPORT_NOT_FOUND_MESSAGE,
} from '../src/modules/payment-links/domain/payment-link';
import {
  PAYMENT_INSTRUCTIONS_EMPTY_MESSAGE,
  PAYMENT_INSTRUCTIONS_LOCATION_NOT_FOUND_MESSAGE,
} from '../src/modules/payment-methods/domain/payment-method-instructions';
import {
  PAYMENT_METHODS_ADMIN_MESSAGE,
  PAYMENT_METHOD_NOT_FOUND_MESSAGE,
} from '../src/modules/payment-methods/domain/payment-method-rules';

// DX-569 en HTTP real: datos para pagar (Ajustes › Medios de pago), «Enviar
// enlace de pago» (email, WhatsApp o copiar la URL), la página pública del
// enlace (404/410, no-store, límites, subida del comprobante y reporte) y la
// bandeja «Pagos por confirmar» (roles, sede, confirmar y rechazar). La
// clínica B ataca cada ruta con los recursos de A: 404 y nada de A cambia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const ZONE = 'America/Caracas';
const today = () => civilDateIn(new Date(), ZONE);
const hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const FAKE_TOKEN = 'x'.repeat(43);

interface Ctx {
  clinic: Clinic;
  locationId: string;
  tokens: Record<ClinicRole, string>;
  /** «Transferencia»: permitida en el enlace, pide referencia, comprobante opcional. */
  methodId: string;
  /** «Efectivo»: nunca se ofrece en el enlace. */
  cashId: string;
}

interface CreatedLink {
  id: string;
  url: string;
  revokedPrevious: number;
  whatsapp: { phone: string; text: string } | null;
  emailSentTo: string | null;
}

describe('Enlace de pago y «Pagos por confirmar» (e2e, DX-569)', () => {
  let app: INestApplication<App>;
  let a: Ctx;
  let b: Ctx;
  let seq = 0;
  let rateToday: number;

  const http = () => request(app.getHttpServer());
  const as = (ctx: Ctx, role: ClinicRole = ClinicRole.RECEPTION) => {
    const auth = (req: request.Test) =>
      req
        .set('X-Tenant-Host', ctx.clinic.host)
        .set('Authorization', `Bearer ${ctx.tokens[role]}`);
    return {
      get: (path: string) => auth(http().get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        auth(http().post(`/api/v1${path}`)).send(body),
      put: (path: string, body: object = {}) =>
        auth(http().put(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object = {}) =>
        auth(http().patch(`/api/v1${path}`)).send(body),
      delete: (path: string) => auth(http().delete(`/api/v1${path}`)),
    };
  };
  const pub = (ctx: Ctx) => ({
    get: (path: string) =>
      http()
        .get(`/api/v1/public/payment-links/${path}`)
        .set('X-Tenant-Host', ctx.clinic.host),
    post: (path: string, body: object = {}) =>
      http()
        .post(`/api/v1/public/payment-links/${path}`)
        .set('X-Tenant-Host', ctx.clinic.host)
        .send(body),
  });
  const messageOf = (res: request.Response) =>
    (res.body as { message: string }).message;

  async function setup(subdomain: string): Promise<Ctx> {
    const clinic = await registerClinic(app, subdomain);
    const tokens = { [ClinicRole.ADMIN]: clinic.adminToken } as Record<
      ClinicRole,
      string
    >;
    for (const role of [
      ClinicRole.RECEPTION,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
    ]) {
      const { email } = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, email);
    }
    const location = await raw.location.findFirstOrThrow({
      where: { tenantId: clinic.tenantId },
    });
    const methods = await raw.clinicPaymentMethod.findMany({
      where: { tenantId: clinic.tenantId },
    });
    const transfer = methods.find((m) => m.legacyMethod === 'TRANSFER')!;
    const cash = methods.find((m) => m.legacyMethod === 'CASH')!;
    const ctx: Ctx = {
      clinic,
      locationId: location.id,
      tokens,
      methodId: transfer.id,
      cashId: cash.id,
    };
    await as(ctx, ClinicRole.ADMIN)
      .patch(`/payment-methods/${transfer.id}`, {
        allowInPaymentLink: true,
        requiresReference: true,
        proofPolicy: 'OPTIONAL',
      })
      .expect(200);
    await as(ctx, ClinicRole.ADMIN)
      .put(`/payment-methods/${transfer.id}/instructions`, {
        holderName: 'Clínica Ejemplo',
        accountNumber: '0000-1111-22',
        note: 'Indica tu nombre en el concepto.',
      })
      .expect(200);
    // Efectivo con datos pero sin permitir en el enlace: no se ofrece.
    await as(ctx, ClinicRole.ADMIN)
      .put(`/payment-methods/${cash.id}/instructions`, { note: 'En caja' })
      .expect(200);
    return ctx;
  }

  async function patient(
    ctx: Ctx,
    extra: Partial<Prisma.PatientUncheckedCreateInput> = {},
  ): Promise<string> {
    return (
      await raw.patient.create({
        data: {
          tenantId: ctx.clinic.tenantId,
          firstName: 'Lucía Elena',
          lastName: `Pagos${++seq}`,
          ...extra,
        },
      })
    ).id;
  }

  async function plan(ctx: Ctx, patientId: string): Promise<string> {
    return (
      await raw.treatmentPlan.create({
        data: {
          tenantId: ctx.clinic.tenantId,
          patientId,
          currency: 'USD',
          status: 'ACCEPTED',
          acceptedAt: new Date(),
          acceptedLocationId: ctx.locationId,
        },
      })
    ).id;
  }

  async function openingBalance(ctx: Ctx, patientId: string): Promise<string> {
    const batch = await raw.patientImportBatch.create({
      data: {
        tenantId: ctx.clinic.tenantId,
        createdById: ctx.clinic.adminUserId,
        locationId: ctx.locationId,
        fileName: 'saldos.csv',
        fileSha256: hex(Buffer.from(randomUUID())),
        fileFormat: 'CSV',
        fileSizeBytes: 10,
        columnMapping: {},
        totalRows: 1,
        validRows: 1,
        duplicateRows: 0,
        errorRows: 0,
        preparedRows: 1,
      },
    });
    return (
      await raw.openingBalance.create({
        data: {
          tenantId: ctx.clinic.tenantId,
          locationId: ctx.locationId,
          patientId,
          importBatchId: batch.id,
          currency: 'USD',
          amount: new Prisma.Decimal('120.00'),
          asOfDate: new Date('2026-03-15T00:00:00.000Z'),
          concept: 'Saldo migrado',
          createdById: ctx.clinic.adminUserId,
        },
      })
    ).id;
  }

  async function createLink(
    ctx: Ctx,
    patientId: string,
    target: object,
    extra: object = {},
  ): Promise<CreatedLink & { token: string }> {
    const res = await as(ctx)
      .post(`/patients/${patientId}/payment-links`, {
        target,
        amount: 40,
        ...extra,
      })
      .expect(201);
    const body = res.body as CreatedLink;
    return { ...body, token: body.url.split('/').pop() as string };
  }

  async function linkFor(ctx: Ctx) {
    const patientId = await patient(ctx, { email: `p${++seq}@example.com` });
    const planId = await plan(ctx, patientId);
    const link = await createLink(ctx, patientId, { treatmentPlanId: planId });
    return { patientId, planId, ...link };
  }

  const reportBody = (ctx: Ctx, over: object = {}) => ({
    paymentMethodId: ctx.methodId,
    currency: 'VES',
    amount: 10000,
    reference: `REF-${++seq}`,
    paidOn: today(),
    ...over,
  });

  async function reported(ctx: Ctx, over: object = {}) {
    const link = await linkFor(ctx);
    await pub(ctx)
      .post(`${link.token}/report`, reportBody(ctx, over))
      .expect(201);
    const report = await raw.paymentReport.findFirstOrThrow({
      where: { linkId: link.id },
    });
    return { ...link, reportId: report.id };
  }

  /** Autoriza y sube el comprobante como el navegador; devuelve el uploadId. */
  async function uploadProof(ctx: Ctx, token: string): Promise<string> {
    const bytes = pngFixture();
    const res = await pub(ctx)
      .post(`${token}/proof-upload`, {
        name: 'captura.png',
        mimeType: 'image/png',
        size: bytes.length,
        sha256: hex(bytes),
      })
      .expect(200);
    const ticket = res.body as {
      uploadId: string;
      target: { url: string; fields: Record<string, string> };
    };
    let req = http().post(new URL(ticket.target.url).pathname);
    for (const [name, value] of Object.entries(ticket.target.fields)) {
      req = req.field(name, value);
    }
    await req.attach('file', bytes, { filename: 'blob' }).expect(204);
    return ticket.uploadId;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.createMany({
      data: [{ date: today(), currency: 'VES', rate: 250 }],
      skipDuplicates: true,
    });
    rateToday = Number(
      (
        await raw.exchangeRateSnapshot.findUniqueOrThrow({
          where: { date_currency: { date: today(), currency: 'VES' } },
        })
      ).rate,
    );
    a = await setup('dx569-e2e-a');
    b = await setup('dx569-e2e-b');
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  describe('datos para pagar del medio', () => {
    it('ADMIN guarda los de la clínica y los de una sede; recepción los lee y no los escribe', async () => {
      const list = await as(a)
        .get(`/payment-methods/${a.methodId}/instructions`)
        .expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({
          locationId: null,
          holderName: 'Clínica Ejemplo',
          accountNumber: '0000-1111-22',
          holderId: null,
        }),
      ]);
      const denied = await as(a)
        .put(`/payment-methods/${a.methodId}/instructions`, { note: 'x' })
        .expect(403);
      expect(messageOf(denied)).toBe(PAYMENT_METHODS_ADMIN_MESSAGE);
      const site = await as(a, ClinicRole.ADMIN)
        .put(`/payment-methods/${a.methodId}/instructions`, {
          locationId: a.locationId,
          phone: ' 0414-555-0100 ',
        })
        .expect(200);
      expect(site.body).toMatchObject({
        locationId: a.locationId,
        phone: '0414-555-0100',
        holderName: null,
      });
      // Auditado como configuración: qué campos, nunca sus valores.
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: a.clinic.tenantId,
          resourceType: 'PAYMENT_METHOD',
          resourceId: a.methodId,
        },
      });
      const instructionEvents = events.filter((e) =>
        String((e.metadata as { reason?: string }).reason).startsWith(
          'PAYMENT_METHOD_INSTRUCTIONS_',
        ),
      );
      expect(instructionEvents.length).toBeGreaterThan(0);
      expect(JSON.stringify(instructionEvents)).not.toMatch(
        /0414|0000-1111|Clínica Ejemplo/,
      );
      // Quitar la de la sede: vuelve a regir la de la clínica.
      await as(a, ClinicRole.ADMIN)
        .delete(
          `/payment-methods/${a.methodId}/instructions/${(site.body as { id: string }).id}`,
        )
        .expect(204);
      const after = await as(a)
        .get(`/payment-methods/${a.methodId}/instructions`)
        .expect(200);
      expect(after.body).toHaveLength(1);
    });

    it('al menos un dato con texto, y una sede de otra clínica no vale', async () => {
      const empty = await as(a, ClinicRole.ADMIN)
        .put(`/payment-methods/${a.methodId}/instructions`, {
          holderName: '   ',
        })
        .expect(400);
      expect(messageOf(empty)).toBe(PAYMENT_INSTRUCTIONS_EMPTY_MESSAGE);
      const foreign = await as(a, ClinicRole.ADMIN)
        .put(`/payment-methods/${a.methodId}/instructions`, {
          locationId: b.locationId,
          note: 'Intrusa',
        })
        .expect(400);
      expect(messageOf(foreign)).toBe(
        PAYMENT_INSTRUCTIONS_LOCATION_NOT_FOUND_MESSAGE,
      );
      expect(
        await raw.paymentMethodInstruction.count({
          where: { locationId: b.locationId },
        }),
      ).toBe(0);
    });

    // ISOLATION_COVERS: GET /payment-methods/:id/instructions
    // ISOLATION_COVERS: PUT /payment-methods/:id/instructions
    // ISOLATION_COVERS: DELETE /payment-methods/:id/instructions/:instructionId
    it('B → 404 al leer, guardar o quitar los datos para pagar del medio de A', async () => {
      const before = await raw.paymentMethodInstruction.findMany({
        where: { tenantId: a.clinic.tenantId },
        orderBy: { id: 'asc' },
      });
      await as(b, ClinicRole.ADMIN)
        .get(`/payment-methods/${a.methodId}/instructions`)
        .expect(404);
      await as(b, ClinicRole.ADMIN)
        .put(`/payment-methods/${a.methodId}/instructions`, { note: 'B' })
        .expect(404);
      await as(b, ClinicRole.ADMIN)
        .delete(`/payment-methods/${a.methodId}/instructions/${before[0].id}`)
        .expect(404);
      expect(
        await raw.paymentMethodInstruction.findMany({
          where: { tenantId: a.clinic.tenantId },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(before);
    });
  });

  describe('«Enviar enlace de pago»', () => {
    it('solo quien cobra: odontólogo y asistente 403', async () => {
      const patientId = await patient(a);
      for (const role of [ClinicRole.DENTIST, ClinicRole.ASSISTANT]) {
        await as(a, role)
          .get(`/patients/${patientId}/payment-links`)
          .expect(403);
        await as(a, role)
          .post(`/patients/${patientId}/payment-links`, {
            target: { treatmentPlanId: await plan(a, patientId) },
            amount: 40,
          })
          .expect(403);
      }
    });

    it('sin canal: la URL una sola vez; otro enlace del mismo destino anula el vivo', async () => {
      const patientId = await patient(a);
      const planId = await plan(a, patientId);
      const first = await createLink(a, patientId, { treatmentPlanId: planId });
      expect(first.url).toMatch(/^https?:\/\/[^/]+\/pago\/[A-Za-z0-9_-]{43}$/);
      expect(first).toMatchObject({ whatsapp: null, emailSentTo: null });
      const row = await raw.paymentLink.findUniqueOrThrow({
        where: { id: first.id },
      });
      // Solo el hash del token: nunca el token.
      expect(row.tokenHash).toBe(
        createHash('sha256').update(first.token).digest('hex'),
      );
      expect(row).toMatchObject({
        currency: 'USD',
        concept: 'BALANCE',
        locationId: a.locationId,
      });
      const second = await createLink(a, patientId, {
        treatmentPlanId: planId,
      });
      expect(second.revokedPrevious).toBe(1);
      await pub(a).get(first.token).expect(404);
      await pub(a).get(second.token).expect(200);
      const list = await as(a)
        .get(`/patients/${patientId}/payment-links`)
        .expect(200);
      expect(
        (list.body as { id: string; status: string }[]).map((l) => [
          l.id,
          l.status,
        ]),
      ).toEqual([
        [second.id, 'LIVE'],
        [first.id, 'REVOKED'],
      ]);
      expect(JSON.stringify(list.body)).not.toContain(second.token);
    });

    it('un plan con plan de pagos activo es «Cuota»; un saldo migrado, «Saldo pendiente»', async () => {
      const patientId = await patient(a);
      const planId = await plan(a, patientId);
      await raw.paymentPlan.create({
        data: {
          tenantId: a.clinic.tenantId,
          treatmentPlanId: planId,
          patientId,
          currency: 'USD',
          totalToFinance: 300,
          installmentsCount: 3,
          periodicity: 'MONTHLY',
          startDate: new Date(),
        },
      });
      const installment = await createLink(a, patientId, {
        treatmentPlanId: planId,
      });
      const view = await pub(a).get(installment.token).expect(200);
      expect(view.body).toMatchObject({
        concept: 'INSTALLMENT',
        conceptLabel: 'Cuota del plan de pagos',
      });
      const balanceId = await openingBalance(a, patientId);
      const balance = await createLink(a, patientId, {
        openingBalanceId: balanceId,
      });
      expect((await pub(a).get(balance.token).expect(200)).body).toMatchObject({
        concept: 'BALANCE',
        conceptLabel: 'Saldo pendiente',
      });
    });

    it('destino: exactamente uno, del paciente y de esta clínica; la moneda es la suya', async () => {
      const patientId = await patient(a);
      const planId = await plan(a, patientId);
      const both = await as(a)
        .post(`/patients/${patientId}/payment-links`, {
          target: { treatmentPlanId: planId, openingBalanceId: planId },
          amount: 40,
        })
        .expect(400);
      expect(messageOf(both)).toBe(PAYMENT_LINK_TARGET_REQUIRED_MESSAGE);
      const currency = await as(a)
        .post(`/patients/${patientId}/payment-links`, {
          target: { treatmentPlanId: planId },
          amount: 40,
          currency: 'VES',
        })
        .expect(400);
      expect(messageOf(currency)).toBe(
        'La moneda del enlace es la de lo que se cobra.',
      );
      // Un plan de otro paciente de la clínica tampoco.
      const otherPatient = await patient(a);
      const notHis = await as(a)
        .post(`/patients/${otherPatient}/payment-links`, {
          target: { treatmentPlanId: planId },
          amount: 40,
        })
        .expect(404);
      expect(messageOf(notHis)).toBe(PAYMENT_LINK_PLAN_NOT_FOUND_MESSAGE);
    });

    it('B no puede cobrar con un enlace un plan ni un saldo migrado de A (404) y nada se crea', async () => {
      const patientA = await patient(a);
      const planA = await plan(a, patientA);
      const balanceA = await openingBalance(a, patientA);
      const patientB = await patient(b);
      const before = await raw.paymentLink.count();
      const byPlan = await as(b)
        .post(`/patients/${patientB}/payment-links`, {
          target: { treatmentPlanId: planA },
          amount: 40,
        })
        .expect(404);
      expect(messageOf(byPlan)).toBe(PAYMENT_LINK_PLAN_NOT_FOUND_MESSAGE);
      const byBalance = await as(b)
        .post(`/patients/${patientB}/payment-links`, {
          target: { openingBalanceId: balanceA },
          amount: 40,
        })
        .expect(404);
      expect(messageOf(byBalance)).toBe(PAYMENT_LINK_BALANCE_NOT_FOUND_MESSAGE);
      expect(await raw.paymentLink.count()).toBe(before);
    });

    it('EMAIL: por el outbox con la plantilla payment-link (422 sin email)', async () => {
      const withoutEmail = await patient(a);
      const res = await as(a)
        .post(`/patients/${withoutEmail}/payment-links`, {
          target: { treatmentPlanId: await plan(a, withoutEmail) },
          amount: 40,
          channel: 'EMAIL',
        })
        .expect(422);
      expect(messageOf(res)).toMatch(/no tiene un email/);
      const withEmail = await patient(a, { email: 'lucia@example.com' });
      const link = await createLink(
        a,
        withEmail,
        { treatmentPlanId: await plan(a, withEmail) },
        { channel: 'EMAIL' },
      );
      expect(link.emailSentTo).toMatch(/^lu\*+@example\.com$/);
      const outbox = await raw.emailOutbox.findMany({
        where: { referenceId: link.id },
      });
      expect(outbox).toHaveLength(1);
      expect(outbox[0].template).toBe('PAYMENT_LINK');
    });

    it('WHATSAPP: número y texto para wa.me, sin importes (422 sin teléfono)', async () => {
      const noPhone = await patient(a);
      await as(a)
        .post(`/patients/${noPhone}/payment-links`, {
          target: { treatmentPlanId: await plan(a, noPhone) },
          amount: 40,
          channel: 'WHATSAPP',
        })
        .expect(422);
      const withPhone = await patient(a, { phone: '+58 414 555 0101' });
      const link = await createLink(
        a,
        withPhone,
        { treatmentPlanId: await plan(a, withPhone) },
        { channel: 'WHATSAPP' },
      );
      expect(link.whatsapp?.phone).toBe('584145550101');
      expect(link.whatsapp?.text).toContain('Hola Lucía');
      expect(link.whatsapp?.text).toContain(link.url);
      expect(link.whatsapp?.text).not.toMatch(/40|USD|Bs/);
    });

    // ISOLATION_COVERS: POST /patients/:id/payment-links
    // ISOLATION_COVERS: GET /patients/:id/payment-links
    it('B → 404 al crear o listar los enlaces de pago del paciente de A', async () => {
      const patientA = await patient(a);
      const planA = await plan(a, patientA);
      const before = await raw.paymentLink.count({
        where: { tenantId: a.clinic.tenantId },
      });
      await as(b).get(`/patients/${patientA}/payment-links`).expect(404);
      await as(b)
        .post(`/patients/${patientA}/payment-links`, {
          target: { treatmentPlanId: planA },
          amount: 40,
        })
        .expect(404);
      expect(
        await raw.paymentLink.count({ where: { tenantId: a.clinic.tenantId } }),
      ).toBe(before);
    });
  });

  describe('la página pública /pago/<token>', () => {
    it('importe, equivalencia con la tasa de hoy ya guardada y solo los medios permitidos con datos; nada clínico', async () => {
      const link = await linkFor(a);
      const res = await pub(a).get(link.token).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      const body = res.body as Record<string, unknown>;
      expect(body).toMatchObject({
        status: 'LIVE',
        patientFirstName: 'Lucía',
        amount: 40,
        currency: 'USD',
        currencies: ['USD', 'VES'],
        equivalents: [
          { currency: 'VES', amount: Math.round(40 * rateToday * 100) / 100 },
        ],
        rateDate: today(),
        equivalentsUnavailable: false,
        paidOnMax: today(),
        paidOnMin: addCivilDays(today(), -2),
        proofUploadsLeft: 3,
      });
      expect(body.methods).toEqual([
        {
          id: a.methodId,
          name: 'Transferencia',
          requiresReference: true,
          proofPolicy: 'OPTIONAL',
          instructions: {
            holderName: 'Clínica Ejemplo',
            holderId: null,
            bankName: null,
            accountNumber: '0000-1111-22',
            phone: null,
            email: null,
            note: 'Indica tu nombre en el concepto.',
          },
        },
      ]);
      // Ni apellidos, ni ids del paciente o del plan.
      const text = JSON.stringify(body);
      expect(text).not.toContain(link.patientId);
      expect(text).not.toContain(link.planId);
      expect(text).not.toMatch(/Pagos\d/);
    });

    it('sin tasa de hoy guardada no da equivalencias y lo dice', async () => {
      // Una clínica cuyas monedas incluyen una sin tasa guardada hoy.
      await raw.tenant.update({
        where: { id: b.clinic.tenantId },
        data: { currencyTexts: { XAF: 'FCFA' } },
      });
      try {
        const link = await linkFor(b);
        const res = await pub(b).get(link.token).expect(200);
        expect(res.body).toMatchObject({
          equivalents: [],
          rateDate: null,
          equivalentsUnavailable: true,
        });
      } finally {
        await raw.tenant.update({
          where: { id: b.clinic.tenantId },
          data: { currencyTexts: {} },
        });
      }
    });

    it('opened: idempotente y sin auditoría', async () => {
      const link = await linkFor(a);
      await pub(a).post(`${link.token}/opened`).expect(204);
      const first = await raw.paymentLink.findUniqueOrThrow({
        where: { id: link.id },
      });
      expect(first.openedAt).not.toBeNull();
      await pub(a).post(`${link.token}/opened`).expect(204);
      const second = await raw.paymentLink.findUniqueOrThrow({
        where: { id: link.id },
      });
      expect(second.openedAt).toEqual(first.openedAt);
      expect(
        await raw.auditEvent.count({
          where: { resourceType: 'PAYMENT_LINK', resourceId: link.id },
        }),
      ).toBe(1); // solo el alta
    });

    it('404 si no existe, caducó o se anuló; 410 «ya usado» con status REPORTED', async () => {
      await pub(a).get(FAKE_TOKEN).expect(404);
      await pub(a).get('corto').expect(404);
      const expired = await linkFor(a);
      await raw.paymentLink.update({
        where: { id: expired.id },
        data: {
          createdAt: new Date(Date.now() - 9 * 86_400_000),
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      const gone = await pub(a).get(expired.token).expect(404);
      expect(messageOf(gone)).toBe(PAYMENT_LINK_NOT_FOUND_MESSAGE);
      const used = await reported(a);
      const res = await pub(a).get(used.token).expect(410);
      expect(res.body).toMatchObject({
        code: 'PAYMENT_LINK_USED',
        status: 'REPORTED',
        message: 'Ya recibimos tu reporte de pago.',
      });
      await pub(a).post(`${used.token}/report`, reportBody(a)).expect(410);
    });

    it('el reporte valida medio, moneda, referencia, fecha y comprobante', async () => {
      const link = await linkFor(a);
      const bad = async (over: object, message: string | RegExp) => {
        const res = await pub(a)
          .post(`${link.token}/report`, reportBody(a, over))
          .expect(400);
        expect(messageOf(res)).toMatch(message);
      };
      await bad(
        { paymentMethodId: a.cashId },
        'Elige uno de los medios de pago que ofrece el enlace.',
      );
      await bad(
        { currency: 'EUR' },
        'Elige una de las monedas que cobra la clínica.',
      );
      await bad({ reference: '  ' }, /referencia del pago/);
      await bad({ paidOn: addCivilDays(today(), 1) }, /posterior a hoy/);
      await bad(
        { paidOn: addCivilDays(today(), -3) },
        /anterior a este enlace/,
      );
      await bad({ proofUploadId: randomUUID() }, /no se subió por este enlace/);
      // Nada se gastó: el enlace sigue vivo.
      await pub(a).get(link.token).expect(200);
    });

    it('comprobante: hasta 3 autorizaciones, se comprueba por contenido y pasa al reporte', async () => {
      const link = await linkFor(a);
      // Una petición que no vale no gasta autorización.
      await pub(a)
        .post(`${link.token}/proof-upload`, {
          name: 'x.png',
          mimeType: 'image/png',
          size: 11 * 1024 * 1024,
          sha256: 'a'.repeat(64),
        })
        .expect(400);
      const first = await uploadProof(a, link.token);
      const done = await pub(a)
        .post(`${link.token}/proof-upload/complete`, { uploadId: first })
        .expect(200);
      expect(done.body).toMatchObject({
        uploadId: first,
        mime: 'image/png',
        name: 'captura.png',
      });
      // Otras dos autorizaciones; la cuarta, 409.
      await uploadProof(a, link.token);
      const third = await uploadProof(a, link.token);
      const exhausted = await pub(a)
        .post(`${link.token}/proof-upload`, {
          name: 'x.png',
          mimeType: 'image/png',
          size: 10,
          sha256: 'a'.repeat(64),
        })
        .expect(409);
      expect(exhausted.body).toMatchObject({
        code: 'PAYMENT_LINK_PROOF_UPLOADS_EXHAUSTED',
      });
      await pub(a)
        .post(`${link.token}/proof-upload/complete`, { uploadId: third })
        .expect(200);
      const view = await pub(a).get(link.token).expect(200);
      expect(view.body).toMatchObject({
        stagedProof: { uploadId: third },
        proofUploadsLeft: 0,
      });
      // Solo el último completado vale para el reporte.
      await pub(a)
        .post(`${link.token}/report`, reportBody(a, { proofUploadId: first }))
        .expect(400);
      await pub(a)
        .post(`${link.token}/report`, reportBody(a, { proofUploadId: third }))
        .expect(201);
      const report = await raw.paymentReport.findFirstOrThrow({
        where: { linkId: link.id },
      });
      expect(report).toMatchObject({
        proofUploadId: third,
        proofMime: 'image/png',
        status: 'PENDING',
      });
      expect(report.proofKey).toMatch(/^payment-proofs\//);
    });

    // ISOLATION_COVERS: GET /public/payment-links/:token
    // ISOLATION_COVERS: POST /public/payment-links/:token/opened
    // ISOLATION_COVERS: POST /public/payment-links/:token/proof-upload
    // ISOLATION_COVERS: POST /public/payment-links/:token/proof-upload/complete
    // ISOLATION_COVERS: POST /public/payment-links/:token/report
    it('el token de A en el host de B: el mismo 404 que uno inventado, y el enlace de A sigue vivo', async () => {
      const link = await linkFor(a);
      const before = await raw.paymentLink.findUniqueOrThrow({
        where: { id: link.id },
      });
      for (const res of [
        await pub(b).get(link.token),
        await pub(b).post(`${link.token}/opened`),
        await pub(b).post(`${link.token}/proof-upload`, {
          name: 'x.png',
          mimeType: 'image/png',
          size: 10,
          sha256: 'a'.repeat(64),
        }),
        await pub(b).post(`${link.token}/proof-upload/complete`, {
          uploadId: randomUUID(),
        }),
        await pub(b).post(`${link.token}/report`, reportBody(b)),
      ]) {
        expect(res.status).toBe(404);
        expect(messageOf(res)).toBe(PAYMENT_LINK_NOT_FOUND_MESSAGE);
      }
      expect(
        await raw.paymentLink.findUniqueOrThrow({ where: { id: link.id } }),
      ).toEqual(before);
      await pub(a).get(link.token).expect(200);
    });

    it('límites: por token (payment-link-token) y por IP (payment-link), con no-store en el 429', async () => {
      const limited = await createE2eApp({
        override: (builder) =>
          builder.overrideProvider(RATE_LIMIT_CONFIG).useValue({
            ...loadRateLimitConfig((key) => process.env[key]),
            'payment-link': { limit: 3, ttlMs: 60_000 },
            'payment-link-token': { limit: 2, ttlMs: 60_000 },
          }),
      });
      try {
        const get = (token: string) =>
          request(limited.getHttpServer())
            .get(`/api/v1/public/payment-links/${token}`)
            .set('X-Tenant-Host', a.clinic.host);
        const token = 'y'.repeat(43);
        await get(token).expect(404);
        await get(token).expect(404);
        const blocked = await get(token);
        expect(blocked.status).toBe(429);
        expect(blocked.headers['cache-control']).toBe('no-store');
        // Otro token: el balde por IP ya lleva 3 → también 429.
        expect((await get('z'.repeat(43))).status).toBe(429);
      } finally {
        await limited.close();
      }
    });
  });

  describe('«Pagos por confirmar»', () => {
    it('solo quien cobra; la lista, el recuento y el filtro de sede', async () => {
      const { reportId } = await reported(a);
      for (const role of [ClinicRole.DENTIST, ClinicRole.ASSISTANT]) {
        await as(a, role).get('/payment-reports').expect(403);
        await as(a, role).get('/payment-reports/count').expect(403);
        await as(a, role)
          .post(`/payment-reports/${reportId}/confirm`)
          .expect(403);
        await as(a, role)
          .post(`/payment-reports/${reportId}/reject`, { reason: 'x' })
          .expect(403);
      }
      const list = await as(a)
        .get('/payment-reports?status=PENDING&pageSize=100')
        .expect(200);
      const body = list.body as {
        items: Record<string, unknown>[];
        total: number;
      };
      const item = body.items.find((i) => i.id === reportId);
      expect(item).toMatchObject({
        status: 'PENDING',
        paymentMethodName: 'Transferencia',
        currency: 'VES',
        locationId: a.locationId,
        link: { currency: 'USD', amount: 40, concept: 'BALANCE' },
      });
      expect(String(item?.patientName)).toMatch(/^Lucía Elena Pagos\d+$/);
      // El comprobante, nunca su clave del almacén.
      expect(JSON.stringify(body)).not.toMatch(/payment-proofs\//);
      const count = await as(a).get('/payment-reports/count').expect(200);
      expect((count.body as { pending: number }).pending).toBe(
        await raw.paymentReport.count({
          where: { tenantId: a.clinic.tenantId, status: 'PENDING' },
        }),
      );
      const own = await as(a)
        .get(`/payment-reports?locationId=${a.locationId}&pageSize=100`)
        .expect(200);
      expect((own.body as { total: number }).total).toBeGreaterThan(0);
    });

    it('B filtra la bandeja por una sede de A: vacía; y su recuento, 0', async () => {
      await reported(a);
      const list = await as(b)
        .get(`/payment-reports?locationId=${a.locationId}`)
        .expect(200);
      expect(list.body).toMatchObject({ items: [], total: 0 });
      const count = await as(b)
        .get(`/payment-reports/count?locationId=${a.locationId}`)
        .expect(200);
      expect(count.body).toEqual({ pending: 0 });
    });

    it('confirmar: el abono con el comprobante del reporte, la caja de quien confirma y las correcciones auditadas', async () => {
      const link = await linkFor(a);
      const uploadId = await uploadProof(a, link.token);
      await pub(a)
        .post(`${link.token}/proof-upload/complete`, { uploadId })
        .expect(200);
      await pub(a)
        .post(
          `${link.token}/report`,
          reportBody(a, { proofUploadId: uploadId }),
        )
        .expect(201);
      const report = await raw.paymentReport.findFirstOrThrow({
        where: { linkId: link.id },
      });
      const proofUrl = await as(a)
        .get(`/payment-reports/${report.id}/proof-url`)
        .expect(200);
      expect(proofUrl.body).toMatchObject({ mime: 'image/png' });
      expect(proofUrl.headers['cache-control']).toBe('no-store');
      const viewed = await raw.auditEvent.findFirst({
        where: {
          resourceType: 'PAYMENT_REPORT',
          resourceId: report.id,
          action: 'VIEW',
        },
      });
      expect(viewed?.metadata).toMatchObject({
        reason: 'PAYMENT_REPORT_PROOF_VIEWED',
      });

      const res = await as(a)
        .post(`/payment-reports/${report.id}/confirm`, {
          amount: 9500,
          reference: 'REF-CORREGIDA',
        })
        .expect(200);
      const payment = (res.body as { payment: { id: string } }).payment;
      const row = await raw.payment.findUniqueOrThrow({
        where: { id: payment.id },
        include: { proof: true },
      });
      expect(row).toMatchObject({
        idempotencyKey: report.id,
        treatmentPlanId: link.planId,
        reference: 'REF-CORREGIDA',
      });
      expect(row.createdById).not.toBeNull();
      expect(Number(row.amount)).toBe(9500);
      expect(row.proof).toMatchObject({
        uploadId,
        key: report.proofKey,
      });
      const updated = await raw.paymentReport.findUniqueOrThrow({
        where: { id: report.id },
      });
      expect(updated).toMatchObject({
        status: 'CONFIRMED',
        paymentId: payment.id,
      });
      const event = await raw.auditEvent.findFirstOrThrow({
        where: {
          resourceType: 'PAYMENT_REPORT',
          resourceId: report.id,
          action: 'UPDATE',
        },
      });
      expect(event.metadata).toMatchObject({
        reason: 'PAYMENT_REPORT_CONFIRMED',
        changedFields: ['amount', 'reference'],
        params: { paymentId: payment.id },
      });
      expect(JSON.stringify(event.metadata)).not.toMatch(/REF-|9500/);
      // Ya confirmado: rechazar es 409.
      const reject = await as(a)
        .post(`/payment-reports/${report.id}/reject`, { reason: 'Tarde' })
        .expect(409);
      expect(reject.body).toMatchObject({ code: 'PAYMENT_REPORT_NOT_PENDING' });
    });

    it('confirmar con un medio de otra clínica es 400 y no crea abono', async () => {
      const { reportId } = await reported(a);
      const res = await as(a)
        .post(`/payment-reports/${reportId}/confirm`, {
          paymentMethodId: b.methodId,
        })
        .expect(400);
      expect(messageOf(res)).toBe(PAYMENT_METHOD_NOT_FOUND_MESSAGE);
      expect(
        await raw.payment.count({ where: { idempotencyKey: reportId } }),
      ).toBe(0);
    });

    it('rechazar: con motivo, sin tocar el saldo, y el aviso al paciente sin el motivo', async () => {
      const { reportId } = await reported(a);
      await as(a)
        .post(`/payment-reports/${reportId}/reject`, { reason: '   ' })
        .expect(400);
      const res = await as(a)
        .post(`/payment-reports/${reportId}/reject`, {
          reason: 'No aparece en el banco',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        report: {
          id: reportId,
          status: 'REJECTED',
          rejectReason: 'No aparece en el banco',
        },
        patientNotified: true,
      });
      expect(
        await raw.payment.count({ where: { idempotencyKey: reportId } }),
      ).toBe(0);
      const outbox = await raw.emailOutbox.findMany({
        where: { referenceId: reportId },
      });
      expect(outbox.map((o) => o.template)).toEqual([
        'PAYMENT_REPORT_REJECTED',
      ]);
      const event = await raw.auditEvent.findFirstOrThrow({
        where: {
          resourceType: 'PAYMENT_REPORT',
          resourceId: reportId,
          action: 'UPDATE',
        },
      });
      expect(JSON.stringify(event.metadata)).not.toContain('banco');
      // Rechazado: no se confirma.
      await as(a).post(`/payment-reports/${reportId}/confirm`).expect(409);
    });

    // ISOLATION_COVERS: GET /payment-reports/:id/proof-url
    // ISOLATION_COVERS: POST /payment-reports/:id/confirm
    // ISOLATION_COVERS: POST /payment-reports/:id/reject
    it('B → 404 al ver el comprobante, confirmar o rechazar un reporte de A, y nada de A cambia', async () => {
      const { reportId } = await reported(a);
      const before = await raw.paymentReport.findUniqueOrThrow({
        where: { id: reportId },
      });
      for (const res of [
        await as(b).get(`/payment-reports/${reportId}/proof-url`),
        await as(b).post(`/payment-reports/${reportId}/confirm`),
        await as(b).post(`/payment-reports/${reportId}/reject`, {
          reason: 'Intrusa',
        }),
      ]) {
        expect(res.status).toBe(404);
        expect(messageOf(res)).toBe(PAYMENT_REPORT_NOT_FOUND_MESSAGE);
      }
      expect(
        await raw.paymentReport.findUniqueOrThrow({ where: { id: reportId } }),
      ).toEqual(before);
      expect(
        await raw.payment.count({ where: { idempotencyKey: reportId } }),
      ).toBe(0);
    });
  });
});
