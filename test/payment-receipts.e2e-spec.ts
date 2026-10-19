import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
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
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';

// DX-136: recibo de caja por abono — emitir, reimprimir, anular y enviar, de
// punta a punta por HTTP. DIRECT_URL (superusuario, sin RLS) solo siembra un
// abono anterior a la numeración, cambia datos «después» y lee la auditoría.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const PATIENT_EMAIL = 'carolina.duque@example.com';
const DOC = '1012345678';

interface Receipt {
  paymentId: string;
  reference: string;
  seriesPrefix: string | null;
  number: number | null;
  legacy: boolean;
  voided: boolean;
  voidedAt: string | null;
  voidReason: string | null;
  snapshot: {
    clinic: { name: string; taxId: string | null };
    fiscalDataPending: boolean;
    location: { name: string };
    patient: { fullName: string; docNumberMasked: string | null };
    payment: { amount: number; currency: string; method: string | null };
    planBalance: { balance: number; paid: number } | null;
    cashier: { fullName: string } | null;
    legalNotice: string;
  };
}

describe('Recibo de caja por abono (e2e, DX-136)', () => {
  let app: INestApplication<App>;
  let dispatcher: EmailDispatcher;
  const mailer = new CapturingMailer();
  let clinicA: Clinic;
  let clinicB: Clinic;
  let receptionToken: string;
  let dentistToken: string;
  let assistantToken: string;
  let patientId: string;
  let planId: string;

  const server = () => app.getHttpServer();
  const as = (clinic: Clinic, token = clinic.adminToken) => ({
    get: (path: string) =>
      request(server())
        .get(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      request(server())
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    patch: (path: string, body: object) =>
      request(server())
        .patch(`/api/v1${path}`)
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

  async function pay(
    token: string,
    amount = 100,
  ): Promise<{ id: string; receiptNumber: string | null }> {
    const res = await as(clinicA, token)
      .post(`/treatment-plans/${planId}/payments`, {
        amount,
        currency: 'USD',
        paidAt: new Date().toISOString(),
        method: 'CASH',
      })
      .expect(201);
    return res.body as { id: string; receiptNumber: string | null };
  }

  async function receiptOf(paymentId: string, token = clinicA.adminToken) {
    const res = await as(clinicA, token)
      .get(`/payments/${paymentId}/receipt`)
      .expect(200);
    return res.body as Receipt;
  }

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp({
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(mailer);
      },
    });
    dispatcher = app.get(EmailDispatcher);
    clinicA = await registerClinic(app, 'dx136-recibo-a');
    clinicB = await registerClinic(app, 'dx136-recibo-b');
    const reception = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    receptionToken = await loginAs(app, clinicA.host, reception.email);
    const dentist = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    dentistToken = await loginAs(app, clinicA.host, dentist.email);
    const assistant = await seedMember(raw, clinicA, ClinicRole.ASSISTANT);
    assistantToken = await loginAs(app, clinicA.host, assistant.email);

    const patient = await as(clinicA)
      .post('/patients', {
        firstName: 'Carolina',
        lastName: 'Duque',
        docType: 'CC',
        docNumber: DOC,
        sex: 'F',
        email: PATIENT_EMAIL,
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
    const plan = await as(clinicA)
      .post(`/patients/${patientId}/treatment-plans`, { currency: 'USD' })
      .expect(201);
    planId = (plan.body as { id: string }).id;
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('emitir: cada abono nace con el siguiente número de la serie de su sede', async () => {
    const first = await pay(receptionToken, 100);
    const second = await pay(clinicA.adminToken, 50);
    expect(first.receiptNumber).toBe('PRI-000001');
    expect(second.receiptNumber).toBe('PRI-000002');

    const listed = await as(clinicA)
      .get(`/treatment-plans/${planId}/payments`)
      .expect(200);
    expect(
      (listed.body as { receiptNumber: string }[]).map((p) => p.receiptNumber),
    ).toEqual(expect.arrayContaining(['PRI-000001', 'PRI-000002']));
  });

  it('el recibo trae clínica, sede, paciente enmascarado, saldo, quién cobró y el aviso fiscal', async () => {
    const { id } = await pay(receptionToken, 30);
    const receipt = await receiptOf(id, receptionToken);
    expect(receipt).toMatchObject({
      paymentId: id,
      reference: 'PRI-000003',
      seriesPrefix: 'PRI',
      number: 3,
      legacy: false,
      voided: false,
      snapshot: {
        clinic: { name: 'Clinica dx136-recibo-a', taxId: null },
        fiscalDataPending: true,
        location: { name: 'Sede principal' },
        patient: { fullName: 'Carolina Duque', docNumberMasked: '******5678' },
        payment: { amount: 30, currency: 'USD', method: 'CASH' },
        planBalance: { paid: 180, balance: -180 },
        cashier: { fullName: 'Miembro RECEPTION' },
        legalNotice: 'Este documento no es factura',
      },
    });
    expect(JSON.stringify(receipt)).not.toContain(DOC);
  });

  it('reimprimir muestra los mismos datos aunque después cambien la clínica, el paciente y el saldo', async () => {
    const { id } = await pay(receptionToken, 10);
    const before = await receiptOf(id);

    await raw.tenant.update({
      where: { id: clinicA.tenantId },
      data: { name: 'Clínica Renombrada' },
    });
    await as(clinicA)
      .patch(`/patients/${patientId}`, { firstName: 'Carola' })
      .expect(200);
    await pay(clinicA.adminToken, 999);

    const reprint = await as(clinicA, receptionToken)
      .post(`/payments/${id}/receipt/print`)
      .expect(200);
    expect(reprint.body).toEqual(before);
    expect((reprint.body as Receipt).snapshot.clinic.name).toBe(
      'Clinica dx136-recibo-a',
    );
  });

  it('anular: el recibo conserva su número y sale ANULADO con motivo y fecha; no se reutiliza', async () => {
    const { id, receiptNumber } = await pay(receptionToken, 20);
    await as(clinicA)
      .delete(`/payments/${id}`, { reason: 'Cobro duplicado en caja' })
      .expect(200);

    const receipt = await receiptOf(id);
    expect(receipt).toMatchObject({
      reference: receiptNumber,
      voided: true,
      voidReason: 'Cobro duplicado en caja',
    });
    expect(receipt.voidedAt).not.toBeNull();

    const next = await pay(receptionToken, 5);
    const n = (ref: string | null) => Number(ref?.split('-')[1]);
    expect(n(next.receiptNumber)).toBe(n(receiptNumber) + 1);
  });

  it('enviar: encola el MISMO recibo al email del paciente, con el documento enmascarado', async () => {
    const { id, receiptNumber } = await pay(receptionToken, 40);
    mailer.clear();
    const res = await as(clinicA, receptionToken)
      .post(`/payments/${id}/receipt/email`)
      .expect(202);
    expect(res.body).toEqual({
      sentTo: 'ca***@example.com',
      sentToResponsible: false,
    });

    await dispatcher.whenIdle();
    const match = await mailer.waitFor(
      PATIENT_EMAIL,
      new RegExp(`Recibo de caja N\\.º ${receiptNumber}`),
    );
    expect(match).toBeTruthy();
    const email = mailer.sent.find((m) => m.to === PATIENT_EMAIL);
    expect(email?.subject).toContain(`Recibo de caja ${receiptNumber}`);
    expect(email?.text).toContain('Documento: CC ******5678');
    expect(email?.text).toContain('Datos fiscales pendientes');
    expect(email?.text).toContain('Este documento no es factura');
    expect(email?.text).not.toContain(DOC);

    const outbox = await raw.emailOutbox.findFirstOrThrow({
      where: { tenantId: clinicA.tenantId, referenceId: id },
    });
    expect(outbox.template).toBe('PAYMENT_RECEIPT');
    expect(outbox.toMasked).toBe('ca***@example.com');
  });

  it('enviar el recibo de un abono anulado lo manda marcado ANULADO', async () => {
    const { id } = await pay(receptionToken, 15);
    await as(clinicA)
      .delete(`/payments/${id}`, { reason: 'Error de digitación' })
      .expect(200);
    mailer.clear();
    await as(clinicA).post(`/payments/${id}/receipt/email`).expect(202);
    await dispatcher.whenIdle();
    await mailer.waitFor(
      PATIENT_EMAIL,
      /ANULADO el .*Motivo: Error de digitación/,
    );
  });

  it('sin email del paciente: 422 en español', async () => {
    const patient = await as(clinicA)
      .post('/patients', {
        firstName: 'Sin',
        lastName: 'Correo',
        docType: 'CC',
        sex: 'M',
      })
      .expect(201);
    const plan = await as(clinicA)
      .post(
        `/patients/${(patient.body as { id: string }).id}/treatment-plans`,
        {
          currency: 'USD',
        },
      )
      .expect(201);
    const payment = await as(clinicA)
      .post(`/treatment-plans/${(plan.body as { id: string }).id}/payments`, {
        amount: 1,
        currency: 'USD',
        paidAt: new Date().toISOString(),
      })
      .expect(201);
    const res = await as(clinicA)
      .post(`/payments/${(payment.body as { id: string }).id}/receipt/email`)
      .expect(422);
    expect((res.body as { message: string }).message).toBe(
      'El paciente no tiene un email registrado. Añádelo en su ficha para enviarle el recibo.',
    );
  });

  it('DX-203: el recibo de un paciente sin email va a su responsable que recibe avisos', async () => {
    const patient = await as(clinicA)
      .post('/patients', {
        firstName: 'Tomás',
        lastName: 'Ortiz',
        docType: 'TI',
        sex: 'M',
        birthDate: '2016-04-10',
      })
      .expect(201);
    const patientId = (patient.body as { id: string }).id;
    await as(clinicA, receptionToken)
      .post(`/patients/${patientId}/responsible-parties`, {
        fullName: 'Claudia Navarro',
        email: 'claudia.navarro@example.com',
        relationship: 'MOTHER',
        isPayer: true,
      })
      .expect(201);
    const plan = await as(clinicA)
      .post(`/patients/${patientId}/treatment-plans`, { currency: 'USD' })
      .expect(201);
    const payment = await as(clinicA)
      .post(`/treatment-plans/${(plan.body as { id: string }).id}/payments`, {
        amount: 1,
        currency: 'USD',
        paidAt: new Date().toISOString(),
      })
      .expect(201);
    mailer.clear();
    const res = await as(clinicA, receptionToken)
      .post(`/payments/${(payment.body as { id: string }).id}/receipt/email`)
      .expect(202);
    expect(res.body).toEqual({
      sentTo: 'cl***@example.com',
      sentToResponsible: true,
    });
    await dispatcher.whenIdle();
    await mailer.waitFor(
      'claudia.navarro@example.com',
      /Te enviamos el recibo del abono de Tomás Ortiz/,
    );
    const email = mailer.sent.find(
      (m) => m.to === 'claudia.navarro@example.com',
    );
    expect(email?.text).toContain('Hola, Claudia');
  });

  it('un abono anterior a la numeración: referencia REC-xxxx, «sin serie», sin renumerar', async () => {
    const location = await raw.location.findFirstOrThrow({
      where: { tenantId: clinicA.tenantId },
    });
    const legacy = await raw.payment.create({
      data: {
        tenantId: clinicA.tenantId,
        locationId: location.id,
        treatmentPlanId: planId,
        patientId,
        amount: 70,
        currency: 'USD',
        paidAt: new Date('2026-01-10T17:00:00.000Z'),
        method: 'CARD',
      },
    });
    const receipt = await receiptOf(legacy.id);
    expect(receipt).toMatchObject({
      reference: `REC-${legacy.id.slice(0, 8)}`,
      seriesPrefix: null,
      number: null,
      legacy: true,
      snapshot: { payment: { amount: 70, method: 'CARD' } },
    });
    expect(
      await raw.paymentReceipt.count({ where: { paymentId: legacy.id } }),
    ).toBe(0);
  });

  it('roles sin permiso de cobro: 403 en español; recepción sí ve, imprime y envía', async () => {
    const { id } = await pay(receptionToken, 3);
    for (const token of [dentistToken, assistantToken]) {
      for (const send of [
        () => as(clinicA, token).get(`/payments/${id}/receipt`),
        () => as(clinicA, token).post(`/payments/${id}/receipt/print`),
        () => as(clinicA, token).post(`/payments/${id}/receipt/email`),
      ]) {
        const res = await send().expect(403);
        expect((res.body as { message: string }).message).toBe(
          'Tu rol no tiene acceso a los recibos de caja: los ven, imprimen y envían administración y recepción.',
        );
      }
    }
    await as(clinicA, receptionToken)
      .get(`/payments/${id}/receipt`)
      .expect(200);
    await as(clinicA, receptionToken)
      .post(`/payments/${id}/receipt/print`)
      .expect(200);
  });

  it('otra clínica no ve el recibo (404) y un id inválido es 400', async () => {
    const { id } = await pay(receptionToken, 2);
    await as(clinicB).get(`/payments/${id}/receipt`).expect(404);
    await as(clinicB).post(`/payments/${id}/receipt/email`).expect(404);
    await as(clinicA).get('/payments/no-es-un-uuid/receipt').expect(400);
  });

  it('cada emisión, vista, reimpresión y envío queda en la auditoría', async () => {
    const { id } = await pay(receptionToken, 4);
    await as(clinicA).get(`/payments/${id}/receipt`).expect(200);
    await as(clinicA).post(`/payments/${id}/receipt/print`).expect(200);
    await as(clinicA).post(`/payments/${id}/receipt/email`).expect(202);
    const events = await raw.auditEvent.findMany({
      where: { tenantId: clinicA.tenantId, resourceId: id },
      orderBy: { occurredAt: 'asc' },
      select: {
        action: true,
        resourceType: true,
        patientId: true,
        metadata: true,
      },
    });
    expect(events).toMatchObject([
      {
        action: 'CREATE',
        resourceType: 'PAYMENT',
        patientId,
        metadata: { reason: 'RECEIPT_ISSUED' },
      },
      { action: 'VIEW', resourceType: 'PAYMENT_RECEIPT', patientId },
      { action: 'PRINT', resourceType: 'PAYMENT_RECEIPT', patientId },
      { action: 'SEND', resourceType: 'PAYMENT_RECEIPT', patientId },
    ]);
    expect(events).toHaveLength(4);
  });
});
