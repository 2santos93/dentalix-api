import { INestApplication } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  Prisma,
  PrismaClient,
  Sex,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { fixedSedeDay } from './support/sede-clock';
import { pinCatalogCurrency } from './support/catalog-currency';

// DX-571 por HTTP: conciliación de transferencias y pagos móviles contra el
// extracto del banco. Los seis criterios del ticket, solo ADMIN, los ids del
// cuerpo de otra clínica (DX-207), la idempotencia de la importación, que el
// archivo no se guarda y la auditoría. El rendimiento con 5 000 movimientos y
// la RLS en la BD van en bank-reconciliation.int-spec.ts.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SEDE_DAY = fixedSedeDay(2);
const DAY = SEDE_DAY.day;
const [Y, M, D] = DAY.split('-');
const BANK_DAY = `${D}/${M}/${Y}`;
const RATE = 36.5;

const MAPPING = {
  date: 'Fecha',
  reference: 'Referencia',
  amount: 'Monto',
  description: 'Concepto',
  dateOrder: 'DMY',
  decimalSeparator: ',',
};

/** Extracto de ejemplo (Venezuela, bolívares): saldo y titular no se guardan. */
function statement(rows: [string, string, string, string][]): Buffer {
  const lines = [
    'Fecha;Referencia;Concepto;Monto;Saldo',
    ...rows.map(([ref, concept, amount, balance]) =>
      [BANK_DAY, ref, concept, amount, balance].join(';'),
    ),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

const STATEMENT = statement([
  ['004512', 'PAGO MOVIL 0414-1234567 MARIA PEREZ', '4.500,00', '10.000,00'],
  ['7777', 'TRANSFERENCIA RECIBIDA', '120,00', '10.120,00'],
  ['555001', 'PAGO MOVIL SIN ABONO ' + 'X'.repeat(300), '250,00', '10.370,00'],
  ['900', 'COMISION', '-15,00', '10.355,00'],
]);

interface Item {
  status: string;
  movement: { id: string; reference: string | null; amount: number } | null;
  payment: { id: string; reference: string | null; hasProof: boolean } | null;
  match: { id: string; kind: string } | null;
}

describe('Conciliación con el extracto del banco (e2e, DX-571)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let reception: string;
  let mobileA: string;
  let transferA: string;
  let cashA: string;
  let mobileB: string;
  let planA: string;
  let planB: string;
  let accountA: string;
  let accountB: string;
  let paid004512: string;
  let paid7777: string;
  let paid999: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic, token = clinic.adminToken) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const upload = (
    path: string,
    clinic: Clinic,
    file: Buffer,
    fields: Record<string, string> = {},
    token = clinic.adminToken,
  ) => {
    let req = as(api().post(`/api/v1${path}`), clinic, token);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('file', file, {
      filename: 'extracto.csv',
      contentType: 'text/csv',
    });
  };
  const importStatement = async (
    clinic: Clinic,
    account: string,
    file: Buffer,
  ) => {
    const preview = (
      await upload(
        `/bank-reconciliation/accounts/${account}/statements/preview`,
        clinic,
        file,
        { mapping: JSON.stringify(MAPPING) },
      ).expect(200)
    ).body as { fileSha256: string };
    return (
      await upload(
        `/bank-reconciliation/accounts/${account}/statements`,
        clinic,
        file,
        {
          mapping: JSON.stringify(MAPPING),
          fileSha256: preview.fileSha256,
        },
      ).expect(201)
    ).body as {
      id: string;
      created: number;
      duplicates: number;
      matched: number;
      ignored: number;
    };
  };
  const items = async (clinic: Clinic, account: string, status: string) =>
    (
      (
        await as(
          api()
            .get(`/api/v1/bank-reconciliation/accounts/${account}/items`)
            .query({ from: DAY, to: DAY, status }),
          clinic,
        ).expect(200)
      ).body as { items: Item[] }
    ).items;

  async function methodOf(
    clinic: Clinic,
    name: string,
    kind: string,
  ): Promise<string> {
    return (
      (
        await as(api().post('/api/v1/payment-methods'), clinic)
          .send({ name, kind, requiresReference: true })
          .expect(201)
      ).body as { id: string }
    ).id;
  }

  async function planOf(clinic: Clinic, doc: string): Promise<string> {
    const patient = (
      await as(api().post('/api/v1/patients'), clinic)
        .send({
          firstName: 'María',
          lastName: 'Pérez',
          docType: 'NATIONAL_ID',
          docNumber: doc,
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    await pinCatalogCurrency(raw, clinic.tenantId, 'USD');
    const item = (
      await as(api().post('/api/v1/catalog/items'), clinic)
        .send({
          code: doc,
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 900,
        })
        .expect(201)
    ).body as { id: string };
    const plan = (
      await as(
        api().post(`/api/v1/patients/${patient.id}/treatment-plans`),
        clinic,
      )
        .send({ notes: 'Plan DX-571 e2e', currency: 'USD' })
        .expect(201)
    ).body as { id: string };
    const planItem = (
      await as(api().post(`/api/v1/treatment-plans/${plan.id}/items`), clinic)
        .send({ toothNumber: '11', catalogItemId: item.id })
        .expect(201)
    ).body as { id: string };
    await as(
      api().patch(`/api/v1/treatment-plans/${plan.id}/items/${planItem.id}`),
      clinic,
    )
      .send({ status: 'DONE' })
      .expect(200);
    return plan.id;
  }

  const pay = async (
    clinic: Clinic,
    plan: string,
    methodId: string,
    reference: string,
    amount: number,
  ): Promise<string> =>
    (
      (
        await as(api().post(`/api/v1/treatment-plans/${plan}/payments`), clinic)
          .send({
            amount,
            currency: 'VES',
            paidAt: DAY,
            paymentMethodId: methodId,
            reference,
          })
          .expect(201)
      ).body as { id: string }
    ).id;

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: DAY, currency: 'VES' },
    });
    await raw.exchangeRateSnapshot.create({
      data: { date: DAY, currency: 'VES', rate: RATE },
    });
    a = await registerClinic(app, 'dx571-e2e-a');
    b = await registerClinic(app, 'dx571-e2e-b');
    reception = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );
    const methods = (
      await as(api().get('/api/v1/payment-methods'), a).expect(200)
    ).body as {
      id: string;
      legacyMethod: string | null;
    }[];
    cashA = methods.find((m) => m.legacyMethod === 'CASH')!.id;
    mobileA = await methodOf(a, 'Pago móvil', 'DIGITAL');
    transferA = await methodOf(a, 'Transferencia en bolívares', 'TRANSFER');
    mobileB = await methodOf(b, 'Pago móvil', 'DIGITAL');
    planA = await planOf(a, 'DX571-A');
    planB = await planOf(b, 'DX571-B');
    paid004512 = await pay(a, planA, mobileA, '004512', 4500);
    paid7777 = await pay(a, planA, transferA, '77-77', 100);
    paid999 = await pay(a, planA, mobileA, '999', 80);
    // La clínica B tiene un abono con la MISMA referencia e importe.
    await pay(b, planB, mobileB, '004512', 4500);
  }, 180_000);

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: DAY, currency: 'VES' },
    });
    await app.close();
    await raw.$disconnect();
  }, 120_000);

  it('solo ADMIN: recepción 403 en cuentas e importación', async () => {
    await as(
      api().get('/api/v1/bank-reconciliation/accounts'),
      a,
      reception,
    ).expect(403);
    await as(api().post('/api/v1/bank-reconciliation/accounts'), a, reception)
      .send({ name: 'X', currency: 'VES', paymentMethodIds: [] })
      .expect(403);
  });

  it('cuenta: medios de otra clínica o efectivo → 409 sin crearla; un medio, una cuenta', async () => {
    const bad = await as(api().post('/api/v1/bank-reconciliation/accounts'), a)
      .send({ name: 'Mala', currency: 'VES', paymentMethodIds: [mobileB] })
      .expect(409);
    expect(bad.body).toMatchObject({ code: 'BANK_PAYMENT_METHOD_INVALID' });
    await as(api().post('/api/v1/bank-reconciliation/accounts'), a)
      .send({ name: 'Caja', currency: 'VES', paymentMethodIds: [cashA] })
      .expect(409);
    expect(
      await raw.bankAccount.count({ where: { tenantId: a.tenantId } }),
    ).toBe(0);

    const created = await as(
      api().post('/api/v1/bank-reconciliation/accounts'),
      a,
    )
      .send({
        name: 'Cuenta corriente en bolívares',
        currency: 'ves',
        paymentMethodIds: [mobileA, transferA],
      })
      .expect(201);
    accountA = (created.body as { id: string }).id;
    expect(created.body).toMatchObject({
      currency: 'VES',
      amountTolerance: 0,
      active: true,
      lastImport: null,
    });

    const taken = await as(
      api().post('/api/v1/bank-reconciliation/accounts'),
      a,
    )
      .send({ name: 'Otra', currency: 'VES', paymentMethodIds: [mobileA] })
      .expect(409);
    expect(taken.body).toMatchObject({ code: 'BANK_PAYMENT_METHOD_TAKEN' });

    accountB = (
      (
        await as(api().post('/api/v1/bank-reconciliation/accounts'), b)
          .send({
            name: 'Cuenta B',
            currency: 'VES',
            paymentMethodIds: [mobileB],
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    // B no puede poner un medio de A editando su cuenta (DX-207).
    await as(api().patch(`/api/v1/bank-reconciliation/accounts/${accountB}`), b)
      .send({ paymentMethodIds: [mobileA] })
      .expect(409);
    expect(
      await raw.bankAccountPaymentMethod.count({
        where: { bankAccountId: accountB, paymentMethodId: mobileA },
      }),
    ).toBe(0);
  });

  it('inspección: cabeceras y mapeo sugerido, sin escribir nada', async () => {
    const res = await upload(
      `/bank-reconciliation/accounts/${accountA}/statements/inspect`,
      a,
      STATEMENT,
    ).expect(200);
    expect(res.body).toMatchObject({
      fileFormat: 'CSV',
      headers: ['Fecha', 'Referencia', 'Concepto', 'Monto', 'Saldo'],
      suggestedMapping: {
        date: 'Fecha',
        reference: 'Referencia',
        amount: 'Monto',
        description: 'Concepto',
      },
      usesSavedMapping: false,
      totalRows: 4,
    });
    expect(await raw.bankMovement.count()).toBe(0);
  });

  it('vista previa: entradas, salidas ignoradas y errores; mapeo inválido → 400; no escribe', async () => {
    const res = await upload(
      `/bank-reconciliation/accounts/${accountA}/statements/preview`,
      a,
      STATEMENT,
      {
        mapping: JSON.stringify(MAPPING),
      },
    ).expect(200);
    expect(res.body).toMatchObject({
      totalRows: 4,
      creditRows: 3,
      newRows: 3,
      duplicateRows: 0,
      ignoredRows: 1,
      errorRows: 0,
      periodFrom: DAY,
      periodTo: DAY,
    });
    await upload(
      `/bank-reconciliation/accounts/${accountA}/statements/preview`,
      a,
      STATEMENT,
      {
        mapping: JSON.stringify({ ...MAPPING, date: 'Nada' }),
      },
    ).expect(400);
    await upload(
      `/bank-reconciliation/accounts/${accountA}/statements/preview`,
      a,
      STATEMENT,
      {
        mapping: '{no es json',
      },
    ).expect(400);
    expect(await raw.bankMovement.count()).toBe(0);
    expect(await raw.bankStatementImport.count()).toBe(0);
  });

  it('confirmar con otro archivo que el de la vista previa → 409 BANK_STATEMENT_CHANGED', async () => {
    const res = await upload(
      `/bank-reconciliation/accounts/${accountA}/statements`,
      a,
      STATEMENT,
      {
        mapping: JSON.stringify(MAPPING),
        fileSha256: '0'.repeat(64),
      },
    ).expect(409);
    expect(res.body).toMatchObject({ code: 'BANK_STATEMENT_CHANGED' });
  });

  it('criterio 1: referencia 004512 e importe iguales → conciliado solo; guarda solo fecha, referencia, importe y descripción truncada', async () => {
    const result = await importStatement(a, accountA, STATEMENT);
    expect(result).toMatchObject({
      created: 3,
      duplicates: 0,
      ignored: 1,
      matched: 1,
    });
    const conciliated = await items(a, accountA, 'CONCILIADO');
    expect(conciliated).toHaveLength(1);
    expect(conciliated[0]).toMatchObject({
      movement: { reference: '004512', amount: 4500 },
      payment: { id: paid004512 },
      match: { kind: 'AUTO' },
    });
    const stored = await raw.bankMovement.findMany({
      where: { tenantId: a.tenantId },
    });
    expect(stored).toHaveLength(3);
    for (const m of stored) {
      expect(m.description === null || m.description.length <= 140).toBe(true);
      // Ni el saldo ni la salida (comisión) se guardan.
      expect(JSON.stringify(m)).not.toContain('10.370');
    }
    expect(stored.some((m) => m.reference === '900')).toBe(false);
    // Auditoría de la importación: el hash y los contadores, nunca el contenido.
    const event = await raw.auditEvent.findFirstOrThrow({
      where: { tenantId: a.tenantId, resourceType: 'BANK_STATEMENT_IMPORT' },
    });
    expect(event).toMatchObject({ action: 'CREATE', resourceId: result.id });
    expect(event.metadata).toMatchObject({
      reason: 'IMPORT_CONFIRMED',
      importBatch: { created: 3, matched: 1 },
    });
    expect(JSON.stringify(event.metadata)).not.toContain('004512');
    // Distintivo «Conciliado» en la caja.
    const cash = (
      await as(
        api().get('/api/v1/payments').query({ from: DAY, to: DAY }),
        a,
      ).expect(200)
    ).body as { items: { id: string; reconciled: boolean }[] };
    const byId = new Map(cash.items.map((p) => [p.id, p.reconciled]));
    expect(byId.get(paid004512)).toBe(true);
    expect(byId.get(paid999)).toBe(false);
  });

  it('criterio 2: un abono sin movimiento aparece en «Sin movimiento» con su comprobante (hasProof)', async () => {
    const list = await items(a, accountA, 'SIN_MOVIMIENTO');
    expect(list.map((i) => i.payment?.id)).toEqual([paid999]);
    expect(list[0].payment).toHaveProperty('hasProof', false);
  });

  it('importe distinto: misma referencia normalizada (77-77 = 7777), 100 frente a 120', async () => {
    const list = await items(a, accountA, 'IMPORTE_DISTINTO');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      movement: { reference: '7777', amount: 120 },
      payment: { id: paid7777 },
    });
  });

  it('criterio 3: un movimiento sin abono aparece en «Sin abono» y se registra desde ahí (abono + emparejado a mano)', async () => {
    const list = await items(a, accountA, 'MOVIMIENTO_SIN_ABONO');
    expect(list.map((i) => i.movement?.reference)).toEqual(['555001']);
    const movementId = list[0].movement!.id;
    const newPayment = await pay(a, planA, mobileA, '555001', 250);
    const candidates = (
      await as(
        api().get(
          `/api/v1/bank-reconciliation/movements/${movementId}/candidates`,
        ),
        a,
      ).expect(200)
    ).body as { payments: { id: string; referenceMatches: boolean }[] };
    expect(candidates.payments[0]).toMatchObject({
      id: newPayment,
      referenceMatches: true,
    });
    const match = await as(api().post('/api/v1/bank-reconciliation/matches'), a)
      .send({ movementId, paymentId: newPayment })
      .expect(201);
    expect(match.body).toMatchObject({ kind: 'MANUAL' });
    expect(await items(a, accountA, 'MOVIMIENTO_SIN_ABONO')).toEqual([]);
    const audit = await raw.auditEvent.findFirstOrThrow({
      where: {
        tenantId: a.tenantId,
        resourceType: 'BANK_RECONCILIATION_MATCH',
        action: 'CREATE',
      },
    });
    expect(audit.metadata).toMatchObject({ reason: 'MANUAL_MATCH' });
    // Emparejar otra vez el mismo movimiento → 409.
    const again = await as(api().post('/api/v1/bank-reconciliation/matches'), a)
      .send({ movementId, paymentId: paid999 })
      .expect(409);
    expect(again.body).toMatchObject({ code: 'BANK_MOVEMENT_ALREADY_MATCHED' });
    // Deshacer: vuelve a «Sin abono»; deshacer dos veces → 409.
    const matchId = (match.body as { id: string }).id;
    await as(
      api().delete(`/api/v1/bank-reconciliation/matches/${matchId}`),
      a,
    ).expect(200);
    expect(
      (await items(a, accountA, 'MOVIMIENTO_SIN_ABONO')).map(
        (i) => i.movement?.id,
      ),
    ).toEqual([movementId]);
    await as(
      api().delete(`/api/v1/bank-reconciliation/matches/${matchId}`),
      a,
    ).expect(409);
    // «Volver a emparejar» lo concilia solo (misma referencia e importe).
    const auto = await as(
      api().post(`/api/v1/bank-reconciliation/accounts/${accountA}/auto-match`),
      a,
    )
      .send({ from: DAY, to: DAY })
      .expect(200);
    expect(auto.body).toMatchObject({ matched: 1 });
  });

  it('criterio 4: subir dos veces el mismo extracto no duplica movimientos', async () => {
    const before = await raw.bankMovement.count({
      where: { tenantId: a.tenantId },
    });
    const second = await importStatement(a, accountA, STATEMENT);
    expect(second).toMatchObject({ created: 0, duplicates: 3 });
    expect(
      await raw.bankMovement.count({ where: { tenantId: a.tenantId } }),
    ).toBe(before);
    const inspect = await upload(
      `/bank-reconciliation/accounts/${accountA}/statements/inspect`,
      a,
      STATEMENT,
    ).expect(200);
    // El mapeo quedó guardado en la cuenta.
    expect(inspect.body).toMatchObject({ usesSavedMapping: true });
  });

  it('criterio 5: anular un abono conciliado lo desconcilia y su movimiento vuelve a «Sin abono»', async () => {
    await as(api().delete(`/api/v1/payments/${paid004512}`), a)
      .send({ reason: 'Se registró dos veces' })
      .expect(200);
    const back = await items(a, accountA, 'MOVIMIENTO_SIN_ABONO');
    expect(back.map((i) => i.movement?.reference)).toEqual(['004512']);
    const match = await raw.bankReconciliationMatch.findFirstOrThrow({
      where: { paymentId: paid004512 },
    });
    expect(match).toMatchObject({
      endReason: 'PAYMENT_VOIDED',
      endedById: a.adminUserId,
    });
    expect(match.endedAt).not.toBeNull();
  });

  // ISOLATION_COVERS: GET /bank-reconciliation/accounts/:id/statements
  // ISOLATION_COVERS: PATCH /bank-reconciliation/accounts/:id
  // ISOLATION_COVERS: POST /bank-reconciliation/accounts/:id/statements/inspect
  // ISOLATION_COVERS: POST /bank-reconciliation/accounts/:id/statements/preview
  // ISOLATION_COVERS: POST /bank-reconciliation/accounts/:id/statements
  // ISOLATION_COVERS: GET /bank-reconciliation/accounts/:id/summary
  // ISOLATION_COVERS: GET /bank-reconciliation/accounts/:id/items
  // ISOLATION_COVERS: POST /bank-reconciliation/accounts/:id/auto-match
  // ISOLATION_COVERS: GET /bank-reconciliation/movements/:id/candidates
  // ISOLATION_COVERS: DELETE /bank-reconciliation/matches/:id
  it('criterio 6: el extracto de una clínica no se cruza con los abonos de otra', async () => {
    // B importa un extracto con la misma referencia: empareja SU abono, no el de A.
    const result = await importStatement(
      b,
      accountB,
      statement([['004512', 'PAGO MOVIL', '4.500,00', '1']]),
    );
    expect(result.matched).toBe(1);
    const bItems = await items(b, accountB, 'CONCILIADO');
    expect(bItems).toHaveLength(1);
    expect(bItems[0].payment?.id).not.toBe(paid004512);
    // Las rutas con ids de A desde B: 404 y nada cambia.
    await as(
      api()
        .get(`/api/v1/bank-reconciliation/accounts/${accountA}/summary`)
        .query({ from: DAY, to: DAY }),
      b,
    ).expect(404);
    await as(
      api()
        .get(`/api/v1/bank-reconciliation/accounts/${accountA}/items`)
        .query({ from: DAY, to: DAY, status: 'CONCILIADO' }),
      b,
    ).expect(404);
    await as(
      api().get(`/api/v1/bank-reconciliation/accounts/${accountA}/statements`),
      b,
    ).expect(404);
    await as(api().patch(`/api/v1/bank-reconciliation/accounts/${accountA}`), b)
      .send({ name: 'Robada' })
      .expect(404);
    await as(
      api().post(`/api/v1/bank-reconciliation/accounts/${accountA}/auto-match`),
      b,
    )
      .send({ from: DAY, to: DAY })
      .expect(404);
    await upload(
      `/bank-reconciliation/accounts/${accountA}/statements/inspect`,
      b,
      STATEMENT,
    ).expect(404);
    await upload(
      `/bank-reconciliation/accounts/${accountA}/statements/preview`,
      b,
      STATEMENT,
      { mapping: JSON.stringify(MAPPING) },
    ).expect(404);
    await upload(
      `/bank-reconciliation/accounts/${accountA}/statements`,
      b,
      STATEMENT,
      {
        mapping: JSON.stringify(MAPPING),
        fileSha256: (
          await raw.bankStatementImport.findFirstOrThrow({
            where: { tenantId: a.tenantId },
          })
        ).fileSha256,
      },
    ).expect(404);
    const movementA = await raw.bankMovement.findFirstOrThrow({
      where: { tenantId: a.tenantId, reference: '7777' },
    });
    await as(
      api().get(
        `/api/v1/bank-reconciliation/movements/${movementA.id}/candidates`,
      ),
      b,
    ).expect(404);
    const movementB = await raw.bankMovement.findFirstOrThrow({
      where: { tenantId: b.tenantId },
    });
    // B empareja con un movimiento de A, o su movimiento con un abono de A: 404.
    await as(api().post('/api/v1/bank-reconciliation/matches'), b)
      .send({ movementId: movementA.id, paymentId: paid999 })
      .expect(404);
    await as(api().post('/api/v1/bank-reconciliation/matches'), b)
      .send({ movementId: movementB.id, paymentId: paid999 })
      .expect(404);
    const matchA = await raw.bankReconciliationMatch.findFirstOrThrow({
      where: { tenantId: a.tenantId, endedAt: null },
    });
    await as(
      api().delete(`/api/v1/bank-reconciliation/matches/${matchA.id}`),
      b,
    ).expect(404);
    expect(
      await raw.bankReconciliationMatch.count({
        where: { tenantId: b.tenantId, paymentId: paid999 },
      }),
    ).toBe(0);
    expect(
      (
        await raw.bankReconciliationMatch.findUniqueOrThrow({
          where: { id: matchA.id },
        })
      ).endedAt,
    ).toBeNull();
    expect(
      (await raw.bankAccount.findUniqueOrThrow({ where: { id: accountA } }))
        .name,
    ).toBe('Cuenta corriente en bolívares');
  });

  it('período inválido o demasiado largo → 400', async () => {
    await as(
      api()
        .get(`/api/v1/bank-reconciliation/accounts/${accountA}/summary`)
        .query({ from: '2026-10-31', to: '2026-10-01' }),
      a,
    ).expect(400);
    await as(
      api()
        .get(`/api/v1/bank-reconciliation/accounts/${accountA}/summary`)
        .query({ from: '2026-01-01', to: '2026-12-31' }),
      a,
    ).expect(400);
    await as(
      api()
        .get(`/api/v1/bank-reconciliation/accounts/${accountA}/items`)
        .query({ from: DAY, to: DAY, status: 'OTRO' }),
      a,
    ).expect(400);
  });
});
