import { INestApplication } from '@nestjs/common';
import { CatalogKind, ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { civilDateIn } from '../src/shared/time/civil-day';
import { sedeTodayFixture } from './support/sede-clock';

// «Hoy» de la sede lejos de su medianoche (DX-449): la caja y el CSV del día
// ven los abonos recién registrados.
const SEDE = sedeTodayFixture();

// DX-515 en HTTP real: el recibo de caja no es una factura. Título y leyenda
// configurables (clínica y sede) que se CONGELAN en la foto al emitir; sin
// configurar, la foto es la de antes. El nº de la factura fiscal emitida fuera
// se anota en el abono (también después del recibo), queda auditado con antes
// y después, sale en la caja, el CSV y el estado de cuenta, y el recibo no
// cambia. DIRECT_URL (superusuario, sin RLS) solo lee la BD y la auditoría.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface ReceiptBody {
  paymentId: string;
  snapshot: Record<string, unknown> & {
    title?: string;
    legend?: string;
    legalNotice: string;
  };
}

interface SettingsBody {
  title: string | null;
  legend: string | null;
  locations: {
    locationId: string;
    name: string;
    isActive: boolean;
    override: boolean;
    legend: string | null;
  }[];
}

interface CashBody {
  items: { id: string; externalInvoiceNumber: string | null }[];
  total: number;
}

describe('Recibo no fiscal: título, leyenda y nº de factura externa (e2e, DX-515)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let receptionA: string;
  let dentistA: string;
  let assistantA: string;
  let locationA: string;
  let locationB: string;
  let patientA: string;
  let planA: string;
  let today: string;

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
    delete: (path: string, body: object) =>
      request(server())
        .delete(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });

  async function pay(amount = 10, token = receptionA): Promise<string> {
    const res = await as(a, token)
      .post(`/treatment-plans/${planA}/payments`, {
        amount,
        currency: 'USD',
        paidAt: new Date().toISOString(),
        method: 'CASH',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function receiptOf(paymentId: string): Promise<ReceiptBody> {
    return (await as(a).get(`/payments/${paymentId}/receipt`).expect(200))
      .body as ReceiptBody;
  }

  /** La foto tal como está guardada en la BD (jsonb). */
  async function storedSnapshot(paymentId: string): Promise<unknown> {
    const receipt = await raw.paymentReceipt.findUniqueOrThrow({
      where: { paymentId },
      select: { snapshot: true },
    });
    return receipt.snapshot;
  }

  const putSettings = (body: object, token = a.adminToken) =>
    as(a, token).put('/payment-receipts/settings', body);
  const putLocation = (
    locationId: string,
    body: object,
    token = a.adminToken,
  ) =>
    as(a, token).put(
      `/payment-receipts/settings/locations/${locationId}`,
      body,
    );
  const putInvoice = (paymentId: string, body: object, token = receptionA) =>
    as(a, token).put(`/payments/${paymentId}/external-invoice-number`, body);

  const auditOf = (reason: string) =>
    raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        metadata: { path: ['reason'], equals: reason },
      },
      orderBy: { occurredAt: 'asc' },
    });

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    a = await registerClinic(app, 'dx515-recibo-a', SEDE);
    b = await registerClinic(app, 'dx515-recibo-b');
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
    const locA = await raw.location.findFirstOrThrow({
      where: { tenantId: a.tenantId },
      select: { id: true },
    });
    locationA = locA.id;
    today = civilDateIn(new Date(), SEDE.timeZone);
    locationB = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: b.tenantId },
        select: { id: true },
      })
    ).id;

    patientA = (
      (
        await as(a)
          .post('/patients', {
            firstName: 'Lucía',
            lastName: 'Recibo',
            docType: 'NATIONAL_ID',
            docNumber: 'DX515-A',
            sex: 'F',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    const item = (
      await as(a)
        .post('/catalog/items', {
          code: 'DX515-A',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 1_000,
        })
        .expect(201)
    ).body as { id: string };
    planA = (
      (
        await as(a)
          .post(`/patients/${patientA}/treatment-plans`, { currency: 'USD' })
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

  let legacyPaymentId: string;
  let legacySnapshot: unknown;

  it('sin configurar: ajustes vacíos y la foto del recibo no lleva título ni leyenda', async () => {
    const settings = (await as(a).get('/payment-receipts/settings').expect(200))
      .body as SettingsBody;
    expect(settings).toMatchObject({ title: null, legend: null });
    expect(settings.locations).toEqual([
      expect.objectContaining({
        locationId: locationA,
        override: false,
        legend: null,
      }),
    ]);

    legacyPaymentId = await pay(10);
    legacySnapshot = await storedSnapshot(legacyPaymentId);
    const receipt = await receiptOf(legacyPaymentId);
    expect(Object.keys(receipt.snapshot)).not.toContain('title');
    expect(Object.keys(receipt.snapshot)).not.toContain('legend');
    expect(Object.keys(legacySnapshot as object)).not.toContain('legend');
    // El pie fijo de DX-136 sigue igual.
    expect(receipt.snapshot.legalNotice).toBe('Este documento no es factura');
  });

  it('solo ADMIN lee y cambia el título y la leyenda (403 en español al resto)', async () => {
    for (const token of [receptionA, dentistA, assistantA]) {
      const read = await as(a, token)
        .get('/payment-receipts/settings')
        .expect(403);
      expect((read.body as { message: string }).message).toBe(
        'Solo administración configura el título y la leyenda del recibo.',
      );
      await putSettings({ title: 'X', legend: 'Y' }, token).expect(403);
      await putLocation(
        locationA,
        { override: true, legend: 'Y' },
        token,
      ).expect(403);
    }
    expect(await auditOf('RECEIPT_SETTINGS')).toHaveLength(0);
  });

  it('valida los textos: una línea, con tope; vacío = sin configurar; recorta los extremos', async () => {
    await putSettings({ title: 'Recibo\nde pago', legend: null }).expect(400);
    await putSettings({ title: 'a'.repeat(61), legend: null }).expect(400);
    await putSettings({ title: null, legend: 'b'.repeat(251) }).expect(400);
    await putSettings({ title: 7, legend: null }).expect(400);
    const saved = await putSettings({ title: '   ', legend: '' }).expect(200);
    expect(saved.body).toEqual({ title: null, legend: null });
    // Nada cambió: no hay evento.
    expect(await auditOf('RECEIPT_SETTINGS')).toHaveLength(0);
  });

  let withLegendId: string;

  it('con título y leyenda: el recibo nuevo los congela; el antiguo, al reimprimirlo, sigue sin ellos', async () => {
    const saved = await putSettings({
      title: '  Recibo de pago ',
      legend: 'Este recibo no es una factura',
    }).expect(200);
    expect(saved.body).toEqual({
      title: 'Recibo de pago',
      legend: 'Este recibo no es una factura',
    });

    withLegendId = await pay(20);
    const fresh = await receiptOf(withLegendId);
    expect(fresh.snapshot.title).toBe('Recibo de pago');
    expect(fresh.snapshot.legend).toBe('Este recibo no es una factura');

    // Reimpresión (POST print) y lectura del recibo emitido antes: igual.
    const reprint = (
      await as(a).post(`/payments/${legacyPaymentId}/receipt/print`).expect(200)
    ).body as ReceiptBody;
    expect(Object.keys(reprint.snapshot)).not.toContain('legend');
    expect(Object.keys(reprint.snapshot)).not.toContain('title');
    expect(await storedSnapshot(legacyPaymentId)).toEqual(legacySnapshot);

    // Cambiar la leyenda después no toca el recibo ya emitido con la anterior.
    await putSettings({
      title: 'Recibo de pago',
      legend: 'Otra leyenda',
    }).expect(200);
    expect((await receiptOf(withLegendId)).snapshot.legend).toBe(
      'Este recibo no es una factura',
    );

    const events = await auditOf('RECEIPT_SETTINGS');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      action: 'UPDATE',
      resourceType: 'CLINIC_SETTINGS',
      actorUserId: a.adminUserId,
      metadata: {
        reason: 'RECEIPT_SETTINGS',
        changedFields: ['receiptLegend', 'receiptTitle'],
        configChange: {
          before: { receiptLegend: null, receiptTitle: null },
          after: {
            receiptLegend: 'Este recibo no es una factura',
            receiptTitle: 'Recibo de pago',
          },
        },
      },
    });
    expect(events[1].metadata).toMatchObject({
      changedFields: ['receiptLegend'],
      configChange: {
        before: { receiptLegend: 'Este recibo no es una factura' },
        after: { receiptLegend: 'Otra leyenda' },
      },
    });
  });

  it('la sede con leyenda propia imprime la suya, o ninguna; sin ella vuelve a la de la clínica', async () => {
    const own = await putLocation(locationA, {
      override: true,
      legend: ' Leyenda de la sede ',
    }).expect(200);
    expect(own.body).toMatchObject({
      locationId: locationA,
      override: true,
      legend: 'Leyenda de la sede',
    });
    const p1 = await pay(5);
    expect((await receiptOf(p1)).snapshot.legend).toBe('Leyenda de la sede');

    await putLocation(locationA, { override: true, legend: '' }).expect(200);
    const p2 = await pay(5);
    const r2 = await receiptOf(p2);
    expect(Object.keys(r2.snapshot)).not.toContain('legend');
    // El título es de la clínica: sigue.
    expect(r2.snapshot.title).toBe('Recibo de pago');

    // Sin leyenda propia, la que traiga se descarta y vuelve a la de la clínica.
    const back = await putLocation(locationA, {
      override: false,
      legend: 'ignorada',
    }).expect(200);
    expect(back.body).toMatchObject({ override: false, legend: null });
    const p3 = await pay(5);
    expect((await receiptOf(p3)).snapshot.legend).toBe('Otra leyenda');

    await putLocation(locationA, { override: true, legend: 'a\tb' }).expect(
      400,
    );
    await putLocation(locationA, { legend: 'x' }).expect(400);

    const events = await auditOf('RECEIPT_LEGEND');
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      action: 'UPDATE',
      resourceType: 'LOCATION',
      resourceId: locationA,
      locationId: locationA,
      metadata: {
        configChange: {
          before: { receiptLegendOverride: false, receiptLegend: null },
          after: {
            receiptLegendOverride: true,
            receiptLegend: 'Leyenda de la sede',
          },
        },
      },
    });
  });

  // ISOLATION_COVERS: PUT /payment-receipts/settings/locations/:locationId
  it('aislamiento: la clínica A no cambia la leyenda de una sede de B (404) y B no ve los ajustes de A', async () => {
    await putLocation(locationB, { override: true, legend: 'intrusa' }).expect(
      404,
    );
    const bLocation = await raw.location.findUniqueOrThrow({
      where: { id: locationB },
      select: { receiptLegendOverride: true, receiptLegend: true },
    });
    expect(bLocation).toEqual({
      receiptLegendOverride: false,
      receiptLegend: null,
    });
    const bSettings = (
      await as(b).get('/payment-receipts/settings').expect(200)
    ).body as SettingsBody;
    expect(bSettings).toMatchObject({ title: null, legend: null });
    expect(bSettings.locations.map((l) => l.locationId)).toEqual([locationB]);
    await putLocation('not-a-uuid', { override: false }).expect(400);
  });

  it('nº de factura externa: RECEPTION lo anota sin formato, queda auditado y el recibo no cambia', async () => {
    const before = await storedSnapshot(withLegendId);
    const res = await putInvoice(withLegendId, {
      externalInvoiceNumber: '  A/2026 #00-77ß ',
    }).expect(200);
    expect(res.body).toEqual({
      paymentId: withLegendId,
      externalInvoiceNumber: 'A/2026 #00-77ß',
      paymentIds: [withLegendId],
    });
    // Editable después: ADMIN lo corrige.
    await putInvoice(
      withLegendId,
      { externalInvoiceNumber: 'F-0001' },
      a.adminToken,
    ).expect(200);
    // Mismo valor: sin evento.
    await putInvoice(withLegendId, { externalInvoiceNumber: 'F-0001' }).expect(
      200,
    );
    expect(await storedSnapshot(withLegendId)).toEqual(before);

    const events = await auditOf('EXTERNAL_INVOICE_NUMBER');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      action: 'UPDATE',
      resourceType: 'PAYMENT',
      resourceId: withLegendId,
      patientId: patientA,
      actorRole: 'RECEPTION',
      locationId: locationA,
      metadata: {
        changedFields: ['externalInvoiceNumber'],
        configChange: {
          before: { externalInvoiceNumber: null },
          after: { externalInvoiceNumber: 'A/2026 #00-77ß' },
        },
      },
    });
    expect(events[1]).toMatchObject({
      actorRole: 'ADMIN',
      metadata: {
        configChange: {
          before: { externalInvoiceNumber: 'A/2026 #00-77ß' },
          after: { externalInvoiceNumber: 'F-0001' },
        },
      },
    });
  });

  it('nº de factura externa: 400 con saltos o más de 64; 403 a clínicos; 404 ajeno; 409 anulado; vacío lo quita', async () => {
    await putInvoice(withLegendId, { externalInvoiceNumber: 'a\nb' }).expect(
      400,
    );
    await putInvoice(withLegendId, {
      externalInvoiceNumber: 'x'.repeat(65),
    }).expect(400);
    await putInvoice(withLegendId, { externalInvoiceNumber: 12 }).expect(400);
    await putInvoice(
      withLegendId,
      { externalInvoiceNumber: 'Z' },
      dentistA,
    ).expect(403);
    await putInvoice(
      withLegendId,
      { externalInvoiceNumber: 'Z' },
      assistantA,
    ).expect(403);
    await putInvoice('00000000-0000-4000-8000-000000000000', {
      externalInvoiceNumber: 'Z',
    }).expect(404);

    const voided = await pay(3, a.adminToken);
    await as(a)
      .delete(`/payments/${voided}`, { reason: 'Cobro duplicado' })
      .expect(200);
    const conflict = await putInvoice(voided, {
      externalInvoiceNumber: 'Z',
    }).expect(409);
    expect((conflict.body as { message: string }).message).toBe(
      'Ese abono está anulado: ya no se le anota el nº de factura externa.',
    );

    const cleared = await pay(4);
    await putInvoice(cleared, { externalInvoiceNumber: 'TMP-1' }).expect(200);
    const res = await putInvoice(cleared, { externalInvoiceNumber: '' }).expect(
      200,
    );
    expect(
      (res.body as { externalInvoiceNumber: null }).externalInvoiceNumber,
    ).toBeNull();
    const row = await raw.payment.findUniqueOrThrow({
      where: { id: cleared },
      select: { externalInvoiceNumber: true },
    });
    expect(row.externalInvoiceNumber).toBeNull();
  });

  // ISOLATION_COVERS: PUT /payments/:id/external-invoice-number
  it('aislamiento: la clínica B no anota la factura externa de un abono de A (404) y nada cambia', async () => {
    const res = await as(b)
      .put(`/payments/${withLegendId}/external-invoice-number`, {
        externalInvoiceNumber: 'INTRUSA',
      })
      .expect(404);
    expect((res.body as { message: string }).message).toBe(
      'No encontramos ese abono.',
    );
    const row = await raw.payment.findUniqueOrThrow({
      where: { id: withLegendId },
      select: { externalInvoiceNumber: true },
    });
    expect(row.externalInvoiceNumber).toBe('F-0001');
  });

  it('cobro dividido: el nº va en todas sus líneas (un recibo, una factura)', async () => {
    const methods = (await as(a).get('/payment-methods').expect(200)).body as {
      id: string;
      legacyMethod: string | null;
    }[];
    const cash = methods.find((m) => m.legacyMethod === 'CASH')!.id;
    const transfer = methods.find((m) => m.legacyMethod === 'TRANSFER')!.id;
    const split = (
      await as(a)
        .post(`/treatment-plans/${planA}/split-payments`, {
          paidAt: today,
          lines: [
            { amount: 6, currency: 'USD', paymentMethodId: cash },
            {
              amount: 4,
              currency: 'USD',
              paymentMethodId: transfer,
              reference: 'TR-515',
            },
          ],
        })
        .expect(201)
    ).body as { payments: { id: string }[] };
    const [line1, line2] = split.payments.map((p) => p.id);
    const res = await putInvoice(line2, {
      externalInvoiceNumber: 'SPLIT-1',
    }).expect(200);
    expect(res.body).toEqual({
      paymentId: line2,
      externalInvoiceNumber: 'SPLIT-1',
      paymentIds: [line1, line2],
    });
    const rows = await raw.payment.findMany({
      where: { id: { in: [line1, line2] } },
      select: { externalInvoiceNumber: true },
    });
    expect(rows.map((r) => r.externalInvoiceNumber)).toEqual([
      'SPLIT-1',
      'SPLIT-1',
    ]);
  });

  it('el nº sale en los abonos del plan, la caja (con filtro), el CSV y el estado de cuenta', async () => {
    const listed = (
      await as(a).get(`/treatment-plans/${planA}/payments`).expect(200)
    ).body as { id: string; externalInvoiceNumber: string | null }[];
    expect(
      listed.find((p) => p.id === withLegendId)?.externalInvoiceNumber,
    ).toBe('F-0001');
    expect(
      listed.find((p) => p.id === legacyPaymentId)?.externalInvoiceNumber,
    ).toBeNull();

    const period = `from=${today}&to=${today}&pageSize=100`;
    const all = (await as(a).get(`/payments?${period}`).expect(200))
      .body as CashBody;
    const withNo = (
      await as(a, receptionA)
        .get(`/payments?${period}&externalInvoice=WITH`)
        .expect(200)
    ).body as CashBody;
    const without = (
      await as(a).get(`/payments?${period}&externalInvoice=WITHOUT`).expect(200)
    ).body as CashBody;
    expect(
      all.items.find((p) => p.id === withLegendId)?.externalInvoiceNumber,
    ).toBe('F-0001');
    expect(withNo.items.every((p) => p.externalInvoiceNumber !== null)).toBe(
      true,
    );
    expect(withNo.items.map((p) => p.id)).toContain(withLegendId);
    expect(without.items.every((p) => p.externalInvoiceNumber === null)).toBe(
      true,
    );
    expect(withNo.total + without.total).toBe(all.total);
    await as(a).get(`/payments?${period}&externalInvoice=MAYBE`).expect(400);

    const csv = await as(a)
      .get(`/payments.csv?from=${today}&to=${today}&externalInvoice=WITH`)
      .expect(200);
    const lines = csv.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      'Fecha,Sede,Paciente,Destino,Medio,Referencia,Factura externa,Moneda,Importe',
    );
    expect(lines).toHaveLength(1 + withNo.total);
    expect(csv.text).toContain('"F-0001"');
    expect(csv.text).toContain('"SPLIT-1"');

    const statement = (
      await as(a).get(`/patients/${patientA}/account-statement`).expect(200)
    ).body as {
      movements: { id: string; externalInvoiceNumber: string | null }[];
    };
    expect(
      statement.movements.find((m) => m.id === withLegendId)
        ?.externalInvoiceNumber,
    ).toBe('F-0001');
  });
});
