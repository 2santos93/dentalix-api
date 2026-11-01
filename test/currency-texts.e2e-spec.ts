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
import { sedeTodayFixture } from './support/sede-clock';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { regionalFormat } from '../src/shared/format/regional-format';
import { CURRENCY_TEXTS_FORBIDDEN_MESSAGE } from '../src/modules/exchange/presentation/clinic-currency-texts.controller';

// DX-517 en HTTP real: el texto propio de cada moneda de la clínica. Solo
// ADMIN lo cambia; queda en la auditoría de configuración con el antes y el
// después; llega a la web con la marca pública; se CONGELA en la foto del
// recibo y el email del recibo lo usa. Sin configurar, nada cambia. Y
// DX-515-bis: el email del recibo lleva su título y su leyenda congelados.
// Sede con locale es-VE y moneda VES: datos de la prueba, no del producto.
const SEDE = {
  ...sedeTodayFixture(),
  country: 'VE',
  currency: 'VES',
  locale: 'es-VE',
  hourCycle: 'h12' as const,
  defaultPhoneRegion: 'VE',
};
const PATIENT_EMAIL = 'paciente.dx517@example.com';
const FMT = regionalFormat({ locale: 'es-VE', hourCycle: 'h12' });
/** El texto plano del email junta los espacios (`escape.ts`): también el duro. */
const plain = (text: string) => text.replace(/\s+/g, ' ');

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface TextsBody {
  entries: { currency: string; text: string }[];
}

describe('Texto propio de cada moneda (e2e, DX-517) y email del recibo no fiscal (DX-515-bis)', () => {
  let app: INestApplication<App>;
  let dispatcher: EmailDispatcher;
  const mailer = new CapturingMailer();
  let a: Clinic;
  let b: Clinic;
  let receptionA: string;
  let dentistA: string;
  let assistantA: string;
  let planA: string;

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
    put: (path: string, body: object) =>
      request(server())
        .put(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });
  const putTexts = (body: object, token = a.adminToken) =>
    as(a, token).put('/exchange/currency-texts', body);
  const branding = (clinic: Clinic) =>
    request(server())
      .get('/api/v1/public/tenant/branding')
      .set('X-Tenant-Host', clinic.host);

  async function pay(amount: number): Promise<string> {
    const res = await as(a, receptionA)
      .post(`/treatment-plans/${planA}/payments`, {
        amount,
        currency: 'VES',
        paidAt: new Date().toISOString(),
        method: 'CASH',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  const storedSnapshot = async (paymentId: string) =>
    (
      await raw.paymentReceipt.findUniqueOrThrow({
        where: { paymentId },
        select: { snapshot: true },
      })
    ).snapshot as Record<string, unknown>;

  /** Manda el recibo por email y devuelve el que llegó (asunto y texto). */
  async function emailOf(paymentId: string) {
    mailer.clear();
    await as(a, receptionA)
      .post(`/payments/${paymentId}/receipt/email`)
      .expect(202);
    await dispatcher.whenIdle();
    await mailer.waitFor(PATIENT_EMAIL, /N\.º/);
    const email = mailer.sent.find((m) => m.to === PATIENT_EMAIL);
    if (!email) throw new Error('No llegó el email del recibo');
    return email;
  }

  const auditOf = () =>
    raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        metadata: { path: ['reason'], equals: 'CURRENCY_TEXTS' },
      },
      orderBy: { occurredAt: 'asc' },
    });

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp({
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(mailer);
      },
    });
    dispatcher = app.get(EmailDispatcher);
    a = await registerClinic(app, 'dx517-moneda-a', SEDE);
    b = await registerClinic(app, 'dx517-moneda-b', SEDE);
    receptionA = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );
    dentistA = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.DENTIST)).email,
    );
    assistantA = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.ASSISTANT)).email,
    );
    const patient = (
      await as(a)
        .post('/patients', {
          firstName: 'Ana',
          lastName: 'Moneda',
          docType: 'NATIONAL_ID',
          docNumber: 'DX517-A',
          sex: 'F',
          email: PATIENT_EMAIL,
        })
        .expect(201)
    ).body as { id: string };
    const item = (
      await as(a)
        .post('/catalog/items', {
          code: 'DX517-A',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 100_000,
        })
        .expect(201)
    ).body as { id: string };
    planA = (
      (
        await as(a)
          .post(`/patients/${patient.id}/treatment-plans`, { currency: 'VES' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const planItem = (
      await as(a)
        .post(`/treatment-plans/${planA}/items`, {
          toothNumber: '11',
          catalogItemId: item.id,
        })
        .expect(201)
    ).body as { id: string };
    await request(server())
      .patch(`/api/v1/treatment-plans/${planA}/items/${planItem.id}`)
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ status: 'DONE' })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  let before: string;
  let beforeSnapshot: Record<string, unknown>;
  const BEFORE_AMOUNT = 1234.5;

  it('sin configurar: lista vacía, marca sin textos y el recibo y su email como siempre', async () => {
    expect(
      (await as(a).get('/exchange/currency-texts').expect(200)).body,
    ).toEqual({ entries: [] });
    expect((await branding(a).expect(200)).body).toMatchObject({
      currencyTexts: {},
    });

    before = await pay(BEFORE_AMOUNT);
    beforeSnapshot = await storedSnapshot(before);
    expect(Object.keys(beforeSnapshot)).not.toContain('currencyTexts');
    const email = await emailOf(before);
    // El importe con el formato de la sede, exactamente el de antes de DX-517.
    expect(email.text).toContain(
      plain(`Valor: ${FMT.money(BEFORE_AMOUNT, 'VES')} ·`),
    );
    // DX-515-bis: sin título ni leyenda, el email de siempre.
    expect(email.subject).toMatch(/^Recibo de caja /);
  });

  it('solo ADMIN lo lee y lo cambia (403 en español al resto, sin cambios)', async () => {
    for (const token of [receptionA, dentistA, assistantA]) {
      const read = await as(a, token)
        .get('/exchange/currency-texts')
        .expect(403);
      expect((read.body as { message: string }).message).toBe(
        CURRENCY_TEXTS_FORBIDDEN_MESSAGE,
      );
      await putTexts(
        { entries: [{ currency: 'VES', text: 'Bs.' }] },
        token,
      ).expect(403);
    }
    expect((await branding(a).expect(200)).body).toMatchObject({
      currencyTexts: {},
    });
    expect(await auditOf()).toHaveLength(0);
  });

  it.each([
    [
      { entries: [{ currency: 'XYZ', text: 'X' }] },
      '«XYZ» no es una moneda del catálogo',
    ],
    [
      { entries: [{ currency: 'VES', text: 'Bolívares' }] },
      'El texto de VES admite de 1 a 8',
    ],
    [
      { entries: [{ currency: 'VES', text: '  ' }] },
      'El texto de VES admite de 1 a 8',
    ],
    [
      { entries: [{ currency: 'VES', text: 'Bs\n.' }] },
      'El texto de VES admite de 1 a 8',
    ],
    [
      {
        entries: [
          { currency: 'VES', text: 'Bs.' },
          { currency: 'ves', text: 'Bs' },
        ],
      },
      'VES aparece más de una vez',
    ],
    [{ entries: 'VES' }, 'lista'],
  ])('400 en español con %j y nada cambia', async (body, message) => {
    const res = await putTexts(body).expect(400);
    expect(JSON.stringify(res.body)).toContain(message);
    expect(
      (await as(a).get('/exchange/currency-texts').expect(200)).body,
    ).toEqual({ entries: [] });
    expect(await auditOf()).toHaveLength(0);
  });

  it('ADMIN lo guarda: recortado, en mayúsculas, auditado con antes y después; repetirlo no audita', async () => {
    const res = await putTexts({
      entries: [{ currency: 'ves', text: ' Bs. ' }],
    }).expect(200);
    expect(res.body as TextsBody).toEqual({
      entries: [{ currency: 'VES', text: 'Bs.' }],
    });
    const events = await auditOf();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'UPDATE',
      resourceType: 'CLINIC_SETTINGS',
      resourceId: a.tenantId,
    });
    expect(events[0].metadata).toMatchObject({
      changedFields: ['currencyTexts'],
      configChange: {
        before: { currencyTexts: [] },
        after: { currencyTexts: ['VES=Bs.'] },
      },
    });

    await putTexts({ entries: [{ currency: 'VES', text: 'Bs.' }] }).expect(200);
    expect(await auditOf()).toHaveLength(1);

    // La web lo recibe con la marca; la otra clínica no.
    expect((await branding(a).expect(200)).body).toMatchObject({
      currencyTexts: { VES: 'Bs.' },
    });
    expect((await branding(b).expect(200)).body).toMatchObject({
      currencyTexts: {},
    });
  });

  it('un recibo nuevo lo congela y su email dice «Bs. 1.234,50»; el anterior no cambia', async () => {
    const after = await pay(1234.5);
    const snapshot = await storedSnapshot(after);
    expect(snapshot.currencyTexts).toEqual({ VES: 'Bs.' });
    const email = await emailOf(after);
    expect(FMT.money(1234.5, 'VES', { VES: 'Bs.' })).toBe('Bs.\u00a01.234,50');
    expect(email.text).toContain('Valor: Bs. 1.234,50 ·');

    // El recibo anterior: foto intacta y su email con el importe de antes.
    expect(await storedSnapshot(before)).toEqual(beforeSnapshot);
    const old = await emailOf(before);
    expect(old.text).toContain(
      plain(`Valor: ${FMT.money(BEFORE_AMOUNT, 'VES')} ·`),
    );
    expect(old.text).not.toContain('Bs. 1.234,50');
  });

  it('DX-515-bis: el email del recibo lleva el título y la leyenda congelados; el anterior no', async () => {
    await as(a)
      .put('/payment-receipts/settings', {
        title: 'Recibo de pago',
        legend: 'Este recibo no es una factura',
      })
      .expect(200);
    const id = await pay(10);
    const email = await emailOf(id);
    expect(email.subject).toMatch(/^Recibo de pago [A-Z]+-\d+ · /);
    expect(email.text).toMatch(/Recibo de pago N\.º [A-Z]+-\d+/);
    expect(email.text).toContain('Este recibo no es una factura');
    expect(email.text).not.toContain('Recibo de caja');

    const old = await emailOf(before);
    expect(old.subject).toMatch(/^Recibo de caja /);
    expect(old.text).not.toContain('Este recibo no es una factura');
  });

  it('vaciarlo vuelve al código ISO para los recibos nuevos y queda auditado', async () => {
    await putTexts({ entries: [] }).expect(200);
    const events = await auditOf();
    expect(events).toHaveLength(2);
    expect(events[1].metadata).toMatchObject({
      configChange: {
        before: { currencyTexts: ['VES=Bs.'] },
        after: { currencyTexts: [] },
      },
    });
    const id = await pay(5);
    expect(Object.keys(await storedSnapshot(id))).not.toContain(
      'currencyTexts',
    );
  });
});
