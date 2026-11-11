import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
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
import {
  REGIONAL_CARACAS_FIXTURE,
  locationBody,
} from './support/location-fixtures';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import { RECEIPT_SUMMARY_NOTICE } from '../src/modules/payments/domain/receipt-summary';
import { safeTodayZone, sedeTodayFixture } from './support/sede-clock';

// DX-401: resumen de los recibos de caja de un paciente en un período, de
// punta a punta por HTTP. DIRECT_URL (superusuario, sin RLS) solo siembra un
// abono «sin serie», mueve la emisión de un recibo (la foto es inmutable:
// sin triggers) y lee la auditoría y el outbox.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const PATIENT_EMAIL = 'luis.contreras@example.com';
const DOC = '12345678';
// La sede principal, en una zona lejos de su medianoche (DX-449); la de
// Altamira, en Caracas, para las pruebas con instantes fijos.
const FIXTURE = sedeTodayFixture();
const ZONE = safeTodayZone();
const FORBIDDEN =
  'Tu rol no tiene acceso al resumen de recibos de caja: lo ven, imprimen y envían administración y recepción.';

interface SummaryLine {
  paymentId: string;
  receiptNumber: string;
  issuedOn: string;
  locationName: string;
  methodLabel: string;
  amount: number;
  currency: string;
  voided: boolean;
  voidReason: string | null;
}

interface Summary {
  patient: {
    id: string;
    fullName: string;
    documentMasked: string | null;
    documentTypeName: string;
    patientCode: string;
  };
  clinic: { name: string; legalName: string | null; taxId: string | null };
  from: string;
  to: string;
  generatedAt: string;
  restrictedToLocations: boolean;
  receipts: SummaryLine[];
  totals: { currency: string; amount: number; count: number }[];
  voidedCount: number;
  notice: string;
}

describe('Resumen de recibos de un período por paciente (e2e, DX-401)', () => {
  let app: INestApplication<App>;
  let dispatcher: EmailDispatcher;
  const mailer = new CapturingMailer();
  let clinicA: Clinic;
  let clinicB: Clinic;
  let receptionToken: string;
  let restrictedToken: string;
  let dentistToken: string;
  let assistantToken: string;
  let patientId: string;
  let usdPlanId: string;
  let vesPlanId: string;
  let altamiraId: string;
  let today: string;
  let from: string;
  let to: string;

  const server = () => app.getHttpServer();
  const as = (clinic: Clinic, token = clinic.adminToken) => ({
    get: (path: string) =>
      request(server())
        .get(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}, locationId?: string) => {
      const req = request(server())
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`);
      return (locationId ? req.set('X-Location-Id', locationId) : req).send(
        body,
      );
    },
    put: (path: string, body: object) =>
      request(server())
        .put(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    delete: (path: string, body: object) =>
      request(server())
        .delete(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });
  const summaryPath = (id: string, f = from, t = to, suffix = '') =>
    `/patients/${id}/payment-receipts/summary${suffix}?from=${f}&to=${t}`;

  async function pay(
    planId: string,
    amount: number,
    currency: string,
    locationId?: string,
  ): Promise<{ id: string; receiptNumber: string }> {
    const res = await as(clinicA, receptionToken)
      .post(
        `/treatment-plans/${planId}/payments`,
        {
          amount,
          currency,
          paidAt: new Date().toISOString(),
          method: 'CASH',
        },
        locationId,
      )
      .expect(201);
    return res.body as { id: string; receiptNumber: string };
  }

  async function summary(
    token = clinicA.adminToken,
    f = from,
    t = to,
  ): Promise<Summary> {
    const res = await as(clinicA, token)
      .get(summaryPath(patientId, f, t))
      .expect(200);
    return res.body as Summary;
  }

  /** Mueve la emisión de un recibo (la foto es inmutable: sin triggers). */
  async function moveIssuedAt(paymentId: string, issuedAt: Date) {
    await raw.$transaction([
      raw.$executeRaw`SET LOCAL session_replication_role = replica`,
      raw.$executeRaw`
        UPDATE "payment_receipts" SET "issuedAt" = ${issuedAt}
         WHERE "paymentId" = ${paymentId}::uuid`,
    ]);
  }

  let first: { id: string; receiptNumber: string };
  let voided: { id: string; receiptNumber: string };
  let ves: { id: string; receiptNumber: string };
  let atAltamira: { id: string; receiptNumber: string };
  let legacyId: string;

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp({
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(mailer);
      },
    });
    dispatcher = app.get(EmailDispatcher);
    clinicA = await registerClinic(app, 'dx401-resumen-a', FIXTURE);
    clinicB = await registerClinic(app, 'dx401-resumen-b', FIXTURE);
    today = civilDateIn(new Date(), ZONE);
    from = addCivilDays(today, -1);
    to = addCivilDays(today, 1);

    const reception = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    receptionToken = await loginAs(app, clinicA.host, reception.email);
    const dentist = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    dentistToken = await loginAs(app, clinicA.host, dentist.email);
    const assistant = await seedMember(raw, clinicA, ClinicRole.ASSISTANT);
    assistantToken = await loginAs(app, clinicA.host, assistant.email);

    altamiraId = (
      (
        await as(clinicA)
          .post(
            '/locations',
            locationBody(REGIONAL_CARACAS_FIXTURE, { name: 'Sede Altamira' }),
          )
          .expect(201)
      ).body as { id: string }
    ).id;
    const principal = await raw.location.findFirstOrThrow({
      where: { tenantId: clinicA.tenantId, id: { not: altamiraId } },
    });

    const patient = await as(clinicA)
      .post('/patients', {
        firstName: 'Luis',
        lastName: 'Contreras',
        docType: 'NATIONAL_ID',
        docNumber: DOC,
        sex: 'M',
        email: PATIENT_EMAIL,
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
    usdPlanId = (
      (
        await as(clinicA)
          .post(`/patients/${patientId}/treatment-plans`, { currency: 'USD' })
          .expect(201)
      ).body as { id: string }
    ).id;
    vesPlanId = (
      (
        await as(clinicA)
          .post(`/patients/${patientId}/treatment-plans`, { currency: 'VES' })
          .expect(201)
      ).body as { id: string }
    ).id;

    first = await pay(usdPlanId, 100, 'USD', principal.id);
    voided = await pay(usdPlanId, 30, 'USD', principal.id);
    await as(clinicA)
      .delete(`/payments/${voided.id}`, { reason: 'Cobro duplicado en caja' })
      .expect(200);
    ves = await pay(vesPlanId, 1800, 'VES', principal.id);
    atAltamira = await pay(usdPlanId, 50, 'USD', altamiraId);

    // Un abono anterior a la numeración: sin recibo, «sin serie».
    legacyId = (
      await raw.payment.create({
        data: {
          tenantId: clinicA.tenantId,
          locationId: principal.id,
          treatmentPlanId: usdPlanId,
          patientId,
          amount: 20,
          currency: 'USD',
          paidAt: new Date(),
          method: 'CARD',
        },
      })
    ).id;

    // Un miembro de recepción restringido a la sede principal (DX-525).
    const restricted = await raw.user.create({
      data: {
        email: `restringido@${clinicA.subdomain}.test`,
        passwordHash: (
          await raw.user.findUniqueOrThrow({
            where: { email: reception.email },
            select: { passwordHash: true },
          })
        ).passwordHash,
        fullName: 'Recepción Chacao',
        emailVerifiedAt: new Date(),
      },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: clinicA.tenantId,
        userId: restricted.id,
        role: ClinicRole.RECEPTION,
      },
    });
    await as(clinicA)
      .put(`/staff/${restricted.id}/locations`, { locationIds: [principal.id] })
      .expect(200);
    restrictedToken = await loginAs(app, clinicA.host, restricted.email);
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('lista los recibos del período en orden de emisión, con totales por moneda sin los anulados', async () => {
    const view = await summary(receptionToken);
    expect(view).toMatchObject({
      patient: {
        id: patientId,
        fullName: 'Luis Contreras',
        documentMasked: '****5678',
        patientCode: expect.stringMatching(/^\d+$/) as string,
      },
      clinic: { name: 'Clinica dx401-resumen-a', legalName: null, taxId: null },
      from,
      to,
      restrictedToLocations: false,
      voidedCount: 1,
      notice: RECEIPT_SUMMARY_NOTICE,
    });
    expect(
      view.receipts.map((r) => [r.receiptNumber, r.amount, r.currency]),
    ).toEqual([
      [first.receiptNumber, 100, 'USD'],
      [voided.receiptNumber, 30, 'USD'],
      [ves.receiptNumber, 1800, 'VES'],
      [atAltamira.receiptNumber, 50, 'USD'],
      [`REC-${legacyId.slice(0, 8)}`, 20, 'USD'],
    ]);
    expect(view.receipts[1]).toMatchObject({
      paymentId: voided.id,
      voided: true,
      voidReason: 'Cobro duplicado en caja',
    });
    expect(view.receipts[0]).toMatchObject({
      issuedOn: today,
      locationName: 'Sede principal',
      methodLabel: 'Efectivo',
      voided: false,
    });
    expect(view.receipts[3].locationName).toBe('Sede Altamira');
    expect(view.receipts[4].methodLabel).toBe('Tarjeta');
    // USD y VES nunca se suman entre sí.
    expect(view.totals).toEqual([
      { currency: 'USD', amount: 170, count: 3 },
      { currency: 'VES', amount: 1800, count: 1 },
    ]);
    expect(JSON.stringify(view)).not.toContain(DOC);
  });

  it('imprimir devuelve el MISMO resumen', async () => {
    const view = await summary();
    const printed = await as(clinicA)
      .post(summaryPath(patientId, from, to, '/print'))
      .expect(200);
    expect({ ...(printed.body as Summary), generatedAt: null }).toEqual({
      ...view,
      generatedAt: null,
    });
  });

  it('los días son civiles de la zona de la sede del recibo (DX-097)', async () => {
    // Sede Altamira (Caracas): 02:00 UTC del 1 de marzo = 22:00 del 28 de febrero en Caracas (UTC−4).
    const target = await pay(usdPlanId, 7, 'USD', altamiraId);
    await moveIssuedAt(target.id, new Date('2026-03-01T02:00:00.000Z'));
    const march = await summary(clinicA.adminToken, '2026-03-01', '2026-03-31');
    expect(march.receipts).toEqual([]);
    const feb = await summary(clinicA.adminToken, '2026-02-28', '2026-02-28');
    expect(feb.receipts).toEqual([
      expect.objectContaining({
        paymentId: target.id,
        issuedOn: '2026-02-28',
        amount: 7,
      }),
    ]);
  });

  it('un cobro dividido sale una fila por forma de pago, cada una en su moneda', async () => {
    const target = await pay(usdPlanId, 40, 'USD', altamiraId);
    await moveIssuedAt(target.id, new Date('2026-04-10T15:00:00.000Z'));
    const split = {
      lines: [
        {
          paymentId: target.id,
          line: 1,
          amount: 40,
          currency: 'USD',
          method: 'TRANSFER',
          paymentMethodName: 'Zelle',
          reference: null,
          equivalentAmount: 40,
        },
        {
          paymentId: target.id,
          line: 2,
          amount: 3650.5,
          currency: 'VES',
          method: 'TRANSFER',
          paymentMethodName: 'Pago móvil',
          reference: null,
          equivalentAmount: 10,
        },
      ],
      total: { currency: 'USD', amount: 50 },
    };
    await raw.$transaction([
      raw.$executeRaw`SET LOCAL session_replication_role = replica`,
      raw.$executeRaw`
        UPDATE "payment_receipts"
           SET "snapshot" = jsonb_set("snapshot", '{split}', ${JSON.stringify(split)}::jsonb)
         WHERE "paymentId" = ${target.id}::uuid`,
    ]);
    const view = await summary(clinicA.adminToken, '2026-04-10', '2026-04-10');
    expect(
      view.receipts.map((r) => [
        r.receiptNumber,
        r.methodLabel,
        r.amount,
        r.currency,
      ]),
    ).toEqual([
      [target.receiptNumber, 'Zelle', 40, 'USD'],
      [target.receiptNumber, 'Pago móvil', 3650.5, 'VES'],
    ]);
    expect(view.totals).toEqual([
      { currency: 'USD', amount: 40, count: 1 },
      { currency: 'VES', amount: 3650.5, count: 1 },
    ]);
  });

  it('un período sin recibos: 200 con la lista vacía y sin totales', async () => {
    const view = await summary(clinicA.adminToken, '2025-01-01', '2025-01-31');
    expect(view).toMatchObject({
      receipts: [],
      totals: [],
      voidedCount: 0,
    });
  });

  it('DX-525: un miembro restringido solo ve los recibos de sus sedes, sin 403', async () => {
    const view = await summary(restrictedToken);
    expect(view.restrictedToLocations).toBe(true);
    const numbers = view.receipts.map((r) => r.receiptNumber);
    expect(numbers).toContain(first.receiptNumber);
    expect(numbers).not.toContain(atAltamira.receiptNumber);
    expect(
      view.receipts.every((r) => r.locationName === 'Sede principal'),
    ).toBe(true);
    expect(view.totals).toEqual([
      { currency: 'USD', amount: 120, count: 2 },
      { currency: 'VES', amount: 1800, count: 1 },
    ]);
  });

  it('valida el período: 400 en español', async () => {
    const bad = async (query: string) =>
      (
        await as(clinicA)
          .get(`/patients/${patientId}/payment-receipts/summary${query}`)
          .expect(400)
      ).body as { message: string | string[] };
    expect(JSON.stringify((await bad(`?from=${from}`)).message)).toContain(
      'to debe ser una fecha AAAA-MM-DD.',
    );
    expect((await bad('?from=2026-10-31&to=2026-10-01')).message).toBe(
      'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».',
    );
    expect((await bad('?from=2025-01-01&to=2026-01-02')).message).toBe(
      'El período del resumen admite como mucho 366 días.',
    );
    await as(clinicA)
      .get(
        '/patients/no-es-un-uuid/payment-receipts/summary?from=2026-01-01&to=2026-01-02',
      )
      .expect(400);
  });

  it('roles sin permiso de cobro: 403 en español en ver, imprimir y enviar', async () => {
    for (const token of [dentistToken, assistantToken]) {
      for (const send of [
        () => as(clinicA, token).get(summaryPath(patientId)),
        () =>
          as(clinicA, token).post(summaryPath(patientId, from, to, '/print')),
        () =>
          as(clinicA, token).post(summaryPath(patientId, from, to, '/email')),
      ]) {
        const res = await send().expect(403);
        expect((res.body as { message: string }).message).toBe(FORBIDDEN);
      }
    }
  });

  it('otra clínica no ve el resumen del paciente (404)', async () => {
    const res = await as(clinicB).get(summaryPath(patientId)).expect(404);
    expect((res.body as { message: string }).message).toBe(
      'Paciente no encontrado.',
    );
    await as(clinicB)
      .post(summaryPath(patientId, from, to, '/email'))
      .expect(404);
  });

  it('enviar: encola el MISMO resumen al email del paciente, con el documento enmascarado', async () => {
    mailer.clear();
    const res = await as(clinicA, receptionToken)
      .post(summaryPath(patientId, from, to, '/email'))
      .expect(202);
    expect(res.body).toEqual({
      sentTo: 'lu***@example.com',
      sentToResponsible: false,
    });
    const outbox = await raw.emailOutbox.findFirstOrThrow({
      where: {
        tenantId: clinicA.tenantId,
        referenceId: patientId,
        template: 'PAYMENT_RECEIPT_SUMMARY',
      },
    });
    expect(outbox.toMasked).toBe('lu***@example.com');

    await dispatcher.whenIdle();
    await mailer.waitFor(
      PATIENT_EMAIL,
      /Resumen de abonos: no es un documento fiscal/,
    );
    const email = mailer.sent.find((m) => m.to === PATIENT_EMAIL);
    expect(email?.subject).toContain('Resumen de abonos del');
    expect(email?.text).toContain(`Recibo N.º ${first.receiptNumber}`);
    expect(email?.text).toMatch(
      new RegExp(`Recibo N\\.º ${voided.receiptNumber} .*\\(ANULADO\\)`),
    );
    expect(email?.text).toContain('Documento: Documento nacional ****5678');
    expect(email?.text).not.toContain(DOC);
  });

  it('enviar un período sin abonos: 422 «No hay abonos en ese periodo»', async () => {
    const res = await as(clinicA)
      .post(summaryPath(patientId, '2025-01-01', '2025-01-31', '/email'))
      .expect(422);
    expect((res.body as { message: string }).message).toBe(
      'No hay abonos en ese periodo',
    );
  });

  it('sin email del paciente ni responsable: 422 en español', async () => {
    const patient = await as(clinicA)
      .post('/patients', {
        firstName: 'Sin',
        lastName: 'Correo',
        docType: 'NATIONAL_ID',
        sex: 'M',
      })
      .expect(201);
    const id = (patient.body as { id: string }).id;
    const plan = await as(clinicA)
      .post(`/patients/${id}/treatment-plans`, { currency: 'USD' })
      .expect(201);
    await as(clinicA)
      .post(`/treatment-plans/${(plan.body as { id: string }).id}/payments`, {
        amount: 1,
        currency: 'USD',
        paidAt: new Date().toISOString(),
      })
      .expect(201);
    const res = await as(clinicA)
      .post(summaryPath(id, from, to, '/email'))
      .expect(422);
    expect((res.body as { message: string }).message).toBe(
      'El paciente no tiene un email registrado. Añádelo en su ficha para enviarle el recibo.',
    );
  });

  it('cada vista, impresión y envío queda en la auditoría con el paciente y el período', async () => {
    const where = {
      tenantId: clinicA.tenantId,
      resourceType: 'PAYMENT_RECEIPT_SUMMARY' as const,
    };
    const before = new Set(
      (await raw.auditEvent.findMany({ where, select: { id: true } })).map(
        (e) => e.id,
      ),
    );
    await as(clinicA).get(summaryPath(patientId)).expect(200);
    await as(clinicA)
      .post(summaryPath(patientId, from, to, '/print'))
      .expect(200);
    await as(clinicA)
      .post(summaryPath(patientId, from, to, '/email'))
      .expect(202);
    // Un 400 no deja evento.
    await as(clinicA)
      .get(summaryPath(patientId, '2026-10-31', '2026-10-01'))
      .expect(400);
    const events = (
      await raw.auditEvent.findMany({
        where,
        orderBy: { occurredAt: 'asc' },
        select: {
          id: true,
          action: true,
          resourceId: true,
          patientId: true,
          metadata: true,
        },
      })
    ).filter((e) => !before.has(e.id));
    const period = { from, to };
    expect(events).toMatchObject([
      {
        action: 'VIEW',
        resourceId: patientId,
        patientId,
        metadata: { period },
      },
      {
        action: 'PRINT',
        resourceId: patientId,
        patientId,
        metadata: { period },
      },
      {
        action: 'SEND',
        resourceId: patientId,
        patientId,
        metadata: { period },
      },
    ]);
    expect(events).toHaveLength(3);
  });
});
