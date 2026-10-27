import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';

// DX-262 · Saldo inicial «Saldo migrado» con la hoja de saldos del
// importador, en HTTP real: plantilla, dry-run con totales por moneda y
// errores por fila en español SIN escribir, confirmación (en segundo plano,
// después de los pacientes), estado de cuenta con «Saldo migrado» y su fecha
// de corte, cartera en el tramo de su fecha, la suma importada = la del
// archivo por moneda, deshacer, solo ADMIN, auditoría y aislamiento.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface CurrencyTotal {
  currency: string;
  rows: number;
  amount: number;
}

interface BalancesView {
  fileName: string;
  fileSha256: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  mergedRows: number;
  preparedCount: number;
  fileTotals: CurrencyTotal[];
  validTotals: CurrencyTotal[];
  imported: { currency: string; count: number; amount: number }[];
  progress: {
    processed: number;
    created: number;
    skipped: number;
    ambiguous: number;
  };
  undoneCount: number | null;
  undoneTotals: CurrencyTotal[];
}

interface Batch {
  id: string;
  status: string;
  canConfirm: boolean;
  canUndo: boolean;
  balances: BalancesView | null;
  balanceIssues: {
    row: number;
    column: string | null;
    kind: string;
    message: string;
  }[];
  balanceIssuesTotal: number;
}

const PATIENTS_HEADER = 'tipo_documento;numero_documento;nombres;apellidos';
const BALANCES_HEADER =
  'numero_documento;importe;moneda;fecha_antiguedad;concepto';

const csv = (header: string, lines: string[]) =>
  Buffer.from(`${header}\n${lines.join('\n')}\n`, 'utf8');

/** Día civil en Bogotá (la sede de la demo): el «hoy» de la clínica. */
function bogotaDay(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
  }).format(d);
}
const ddmmyyyy = (iso: string) => iso.split('-').reverse().join('/');

describe('Saldo migrado — hoja de saldos del importador (DX-262, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let reception: string;
  let existingId: string;
  let mainLocationId: string;
  let batch: Batch;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, clinic: Clinic = a) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const attach = (
    path: string,
    bytes: Buffer,
    filename: string,
    token = a.adminToken,
    clinic = a,
  ) =>
    as(api().post(`/api/v1/patient-imports${path}`), token, clinic).attach(
      'file',
      bytes,
      { filename, contentType: 'text/csv' },
    );
  const getBatch = async (id: string): Promise<Batch> =>
    (
      await as(api().get(`/api/v1/patient-imports/${id}`), a.adminToken).expect(
        200,
      )
    ).body as Batch;
  const drain = () => app.get(JobWorker).drain();
  const patientByDoc = (docNumber: string) =>
    raw.patient.findFirstOrThrow({
      where: { tenantId: a.tenantId, docNumber, deletedAt: null },
    });
  const statementOf = async (patientId: string) =>
    (
      await as(
        api().get(`/api/v1/patients/${patientId}/account-statement`),
        a.adminToken,
      ).expect(200)
    ).body as {
      summary: {
        currency: string;
        budgeted: number;
        openingBalance: number;
        openingPending: number;
        paid: number;
        balance: number;
      }[];
      openingBalances: {
        id: string;
        currency: string;
        amount: number;
        asOfDate: string;
        asOfDateApproximate: boolean;
        concept: string;
        importBatchId: string;
        paid: number;
        pending: number;
      }[];
    };
  const aging = async () =>
    (
      await as(api().get('/api/v1/receivables/aging'), a.adminToken)
        .set('X-Location-Id', mainLocationId)
        .expect(200)
    ).body as {
      items: {
        patient: { id: string };
        ageApproximate: boolean;
        currencies: {
          currency: string;
          balance: number;
          ageApproximate: boolean;
          buckets: Record<string, number>;
        }[];
      }[];
    };

  const OLD_DAY = bogotaDay(-75);
  const RECENT_DAY = bogotaDay(-10);

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx262-e2e');
    b = await registerClinic(app, 'dx262-e2e-otra');
    reception = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );
    const locations = await as(
      api().get('/api/v1/locations'),
      a.adminToken,
    ).expect(200);
    mainLocationId = (locations.body as { id: string }[])[0].id;
    await as(api().put('/api/v1/locations/schedule'), a.adminToken)
      .set('X-Location-Id', mainLocationId)
      .send({
        ranges: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          startMinute: 0,
          endMinute: 1440,
        })),
      })
      .expect(200);
    const existing = await as(api().post('/api/v1/patients'), a.adminToken)
      .send({
        docType: 'CC',
        docNumber: '900900',
        firstName: 'Ya',
        lastName: 'Existía',
        sex: 'UNSPECIFIED',
      })
      .expect(201);
    existingId = (existing.body as { id: string }).id;

    // Lote de pacientes (dry-run): dos nuevos y el que ya existe.
    const res = await attach(
      '',
      csv(PATIENTS_HEADER, [
        'CC;111111;Ana;Migrada',
        'CC;222222;Luis;Migrado',
        'CC;900900;Ya;Existía',
      ]),
      'pacientes.csv',
    )
      .set('X-Location-Id', mainLocationId)
      .expect(201);
    batch = res.body as Batch;
    expect(batch.balances).toBeNull();
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('plantilla de la hoja de saldos: CSV con BOM y las columnas', async () => {
    const res = await as(
      api().get('/api/v1/patient-imports/balances-template'),
      a.adminToken,
    ).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.startsWith('﻿"numero_documento","importe","moneda"')).toBe(
      true,
    );
  });

  it('solo ADMIN: recepción recibe 403 en español al subir la hoja de saldos', async () => {
    const res = await attach(
      `/${batch.id}/balances`,
      csv(BALANCES_HEADER, ['111111;100;COP;;']),
      'saldos.csv',
      reception,
    ).expect(403);
    expect((res.body as { message: string }).message).toBe(
      'Solo un administrador de la clínica puede importar pacientes.',
    );
  });

  it('otra clínica no ve el lote: 404 al subirle saldos', async () => {
    await attach(
      `/${batch.id}/balances`,
      csv(BALANCES_HEADER, ['111111;100;COP;;']),
      'saldos.csv',
      b.adminToken,
      b,
    ).expect(404);
  });

  it('dry-run: total por moneda y errores por fila en español, sin escribir nada', async () => {
    const res = await attach(
      `/${batch.id}/balances`,
      csv(BALANCES_HEADER, [
        `111111;150.000;COP;${ddmmyyyy(OLD_DAY)};Ortodoncia 2025`,
        '111111;50.000,50;COP;;',
        '900900;40;USD;;',
        '999999;100;COP;;',
        '222222;-5;COP;;',
        '222222;100;XYZ;;',
        `222222;1.000;cop;${RECENT_DAY};`,
      ]),
      'saldos.csv',
    ).expect(201);
    const view = res.body as Batch;
    expect(view.balances).toMatchObject({
      fileName: 'saldos.csv',
      totalRows: 7,
      validRows: 4,
      errorRows: 3,
      mergedRows: 1,
      preparedCount: 3,
      fileTotals: [
        { currency: 'COP', rows: 4, amount: 201100.5 },
        { currency: 'USD', rows: 1, amount: 40 },
      ],
      validTotals: [
        { currency: 'COP', rows: 3, amount: 201000.5 },
        { currency: 'USD', rows: 1, amount: 40 },
      ],
      imported: [],
    });
    expect(
      view.balanceIssues.map((i) => [i.row, i.column, i.kind, i.message]),
    ).toEqual([
      [
        3,
        'numero_documento',
        'MERGED',
        'Mismo paciente y moneda que la fila 2: se suman en un solo saldo migrado.',
      ],
      [
        5,
        'numero_documento',
        'ERROR',
        'No hay ningún paciente con el documento «999999» en la clínica ni en el archivo de pacientes.',
      ],
      [6, 'importe', 'ERROR', 'El importe debe ser mayor que 0.'],
      [
        7,
        'moneda',
        'ERROR',
        expect.stringMatching(
          /^La moneda «XYZ» no está admitida en la clínica\. Admitidas: .*COP.*USD/,
        ),
      ],
    ]);
    expect(view.balanceIssuesTotal).toBe(4);
    expect(view.canConfirm).toBe(true);
    // Sin escribir: ni saldos migrados ni pacientes nuevos.
    expect(
      await raw.openingBalance.count({ where: { tenantId: a.tenantId } }),
    ).toBe(0);
    expect(
      await raw.patient.count({
        where: { tenantId: a.tenantId, deletedAt: null },
      }),
    ).toBe(1);

    const report = await as(
      api().get(`/api/v1/patient-imports/${batch.id}/balances/errors.csv`),
      a.adminToken,
    ).expect(200);
    expect(report.text).toContain('Sumada a otra fila');
    expect(report.text).toContain('El importe debe ser mayor que 0.');
  });

  it('una hoja sin la columna de moneda: 400 en español', async () => {
    const res = await attach(
      `/${batch.id}/balances`,
      csv('documento;saldo', ['111111;100']),
      'malo.csv',
    ).expect(400);
    expect((res.body as { message: string }).message).toMatch(
      /^A la hoja de saldos le falta la columna «Moneda»/,
    );
    // La hoja anterior sigue en el lote.
    expect((await getBatch(batch.id)).balances?.preparedCount).toBe(3);
  });

  it('confirmar importa pacientes y saldos; la suma importada cuadra con el archivo por moneda', async () => {
    await as(
      api().post(`/api/v1/patient-imports/${batch.id}/confirm`),
      a.adminToken,
    )
      .send({ duplicateMode: 'SKIP' })
      .expect(200);
    await drain();
    const done = await getBatch(batch.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.balances?.progress).toEqual({
      processed: 3,
      created: 3,
      skipped: 0,
      ambiguous: 0,
      existing: 0,
    });
    expect(done.balances?.imported).toEqual([
      { currency: 'COP', count: 2, amount: 201000.5 },
      { currency: 'USD', count: 1, amount: 40 },
    ]);
    expect(done.balances?.imported.map((t) => [t.currency, t.amount])).toEqual(
      done.balances?.validTotals.map((t) => [t.currency, t.amount]),
    );
  });

  it('estado de cuenta: «Saldo migrado» con su fecha de corte (aprox. si es la de importación) y en el saldo', async () => {
    const ana = await patientByDoc('111111');
    const st = await statementOf(ana.id);
    expect(st.openingBalances).toEqual([
      {
        id: expect.any(String) as string,
        currency: 'COP',
        amount: 200000.5,
        asOfDate: OLD_DAY,
        asOfDateApproximate: false,
        concept: 'Ortodoncia 2025',
        importBatchId: batch.id,
        paid: 0,
        pending: 200000.5,
      },
    ]);
    expect(st.summary).toEqual([
      expect.objectContaining({
        currency: 'COP',
        budgeted: 0,
        openingBalance: 200000.5,
        paid: 0,
        balance: 200000.5,
      }),
    ]);
    const old = await statementOf(existingId);
    expect(old.openingBalances).toEqual([
      expect.objectContaining({
        currency: 'USD',
        amount: 40,
        asOfDate: bogotaDay(),
        asOfDateApproximate: true,
        concept: 'Saldo migrado',
      }),
    ]);
  });

  it('cartera: cada saldo en el tramo de su fecha, por moneda y en la sede del lote', async () => {
    const ana = await patientByDoc('111111');
    const luis = await patientByDoc('222222');
    const rows = (await aging()).items;
    const row = (id: string) => rows.find((r) => r.patient.id === id);
    expect(row(ana.id)?.currencies).toEqual([
      expect.objectContaining({
        currency: 'COP',
        balance: 200000.5,
        ageApproximate: false,
        buckets: expect.objectContaining({
          days61to90: 200000.5,
        }) as Record<string, number>,
      }),
    ]);
    expect(row(luis.id)?.currencies[0].buckets.days0to30).toBe(1000);
    expect(row(existingId)?.currencies).toEqual([
      expect.objectContaining({
        currency: 'USD',
        balance: 40,
        ageApproximate: true,
        buckets: expect.objectContaining({ days0to30: 40 }) as Record<
          string,
          number
        >,
      }),
    ]);
  });

  it('auditoría del lote con el total por moneda de los saldos', async () => {
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceType: 'PATIENT_IMPORT_BATCH',
        resourceId: batch.id,
      },
      orderBy: { occurredAt: 'asc' },
    });
    const validated = events.find(
      (e) =>
        (e.metadata as { reason?: string }).reason ===
        'IMPORT_BALANCES_VALIDATED',
    );
    expect(validated?.action).toBe('UPDATE');
    expect(validated?.metadata).toMatchObject({
      importBatch: {
        balanceRows: 7,
        balanceErrors: 3,
        balanceTotals: [
          { currency: 'COP', rows: 3, amount: 201000.5 },
          { currency: 'USD', rows: 1, amount: 40 },
        ],
      },
    });
    const confirmed = events.find(
      (e) => (e.metadata as { reason?: string }).reason === 'IMPORT_CONFIRMED',
    );
    expect(confirmed?.metadata).toMatchObject({
      importBatch: { balanceTotals: expect.any(Array) as unknown[] },
    });
    expect(JSON.stringify(events.map((e) => e.metadata))).not.toContain(
      '111111',
    );
  });

  it('abono contra el saldo migrado (revisión C1): recibo de caja, estado de cuenta y cartera con lo pendiente', async () => {
    const ana = await patientByDoc('111111');
    const ob = (await statementOf(ana.id)).openingBalances[0];
    // Recepción cobra (roles de abono), con Idempotency-Key.
    const key = '0f5e7a52-8a1c-4a9e-9d61-3b1f0e6c2a10';
    const body = {
      amount: 50000.5,
      currency: 'COP',
      paidAt: bogotaDay(),
      method: 'TRANSFER',
    };
    const res = await as(
      api().post(`/api/v1/opening-balances/${ob.id}/payments`),
      reception,
    )
      .set('Idempotency-Key', key)
      .set('X-Location-Id', mainLocationId)
      .send(body)
      .expect(201);
    const paid = res.body as {
      id: string;
      treatmentPlanId: string | null;
      openingBalanceId: string;
      receiptNumber: string;
    };
    expect(paid).toMatchObject({
      treatmentPlanId: null,
      openingBalanceId: ob.id,
      receiptNumber: expect.stringMatching(/-\d{6}$/) as string,
    });
    // La misma petición: el mismo abono.
    const replay = await as(
      api().post(`/api/v1/opening-balances/${ob.id}/payments`),
      reception,
    )
      .set('Idempotency-Key', key)
      .set('X-Location-Id', mainLocationId)
      .send(body)
      .expect(201);
    expect((replay.body as { id: string }).id).toBe(paid.id);

    const receipt = await as(
      api().get(`/api/v1/payments/${paid.id}/receipt`),
      a.adminToken,
    ).expect(200);
    expect(receipt.body).toMatchObject({
      snapshot: {
        plan: null,
        openingBalance: { id: ob.id, concept: 'Ortodoncia 2025' },
        planBalance: { balance: 150000 },
      },
    });

    const st = await statementOf(ana.id);
    expect(st.openingBalances[0]).toMatchObject({
      amount: 200000.5,
      paid: 50000.5,
      pending: 150000,
    });
    expect(st.summary[0]).toMatchObject({
      paid: 50000.5,
      balance: 150000,
      // «Incluye saldo migrado» dice lo que queda, no el original (QA D5).
      openingPending: 150000,
    });
    const row = (await aging()).items.find((r) => r.patient.id === ana.id);
    expect(row?.currencies[0]).toMatchObject({
      balance: 150000,
      buckets: expect.objectContaining({ days61to90: 150000 }) as Record<
        string,
        number
      >,
    });

    // Sin pasarse de lo pendiente, en su moneda y solo de esta clínica.
    const over = await as(
      api().post(`/api/v1/opening-balances/${ob.id}/payments`),
      a.adminToken,
    )
      .send({ ...body, amount: 150000.01 })
      .expect(400);
    expect((over.body as { message: string }).message).toMatch(
      /^El abono supera lo pendiente del saldo migrado: quedan 150\.000,00\sCOP\.$/,
    );
    await as(
      api().post(`/api/v1/opening-balances/${ob.id}/payments`),
      a.adminToken,
    )
      .send({ ...body, currency: 'USD' })
      .expect(400);
    await as(
      api().post(`/api/v1/opening-balances/${ob.id}/payments`),
      b.adminToken,
      b,
    )
      .send(body)
      .expect(404);
  });

  it('deshacer el lote se niega con abonos vivos al saldo migrado; anulado el abono, retira los saldos', async () => {
    const res409 = await as(
      api().post(`/api/v1/patient-imports/${batch.id}/undo`),
      a.adminToken,
    ).expect(409);
    expect((res409.body as { message: string }).message).toBe(
      'No se puede deshacer: 1 saldo migrado de este lote ya tiene abonos. Anula esos abonos antes de deshacer.',
    );
    const ana = await patientByDoc('111111');
    const live = await raw.payment.findFirstOrThrow({
      where: { patientId: ana.id, deletedAt: null },
    });
    await as(api().delete(`/api/v1/payments/${live.id}`), a.adminToken)
      .send({ reason: 'Prueba del deshacer' })
      .expect(200);

    const res = await as(
      api().post(`/api/v1/patient-imports/${batch.id}/undo`),
      a.adminToken,
    ).expect(200);
    const undone = res.body as Batch;
    expect(undone.status).toBe('UNDONE');
    expect(undone.balances).toMatchObject({
      undoneCount: 3,
      imported: [],
      undoneTotals: [
        { currency: 'COP', rows: 2, amount: 201000.5 },
        { currency: 'USD', rows: 1, amount: 40 },
      ],
    });
    const st = await statementOf(existingId);
    expect(st.openingBalances).toEqual([]);
    expect(st.summary).toEqual([]);
    expect((await aging()).items).toEqual([]);
    // Auditoría: lo retirado de verdad.
    const event = await raw.auditEvent.findFirst({
      where: {
        tenantId: a.tenantId,
        resourceId: batch.id,
        action: 'DELETE',
      },
    });
    expect(event?.metadata).toMatchObject({
      importBatch: {
        balancesUndone: 3,
        balanceUndoneTotals: [
          { currency: 'COP', rows: 2, amount: 201000.5 },
          { currency: 'USD', rows: 1, amount: 40 },
        ],
      },
    });
  });

  it('retirar SOLO los saldos del lote aunque sus pacientes ya tengan citas', async () => {
    const res = await attach(
      '',
      csv(PATIENTS_HEADER, ['CC;444444;Iris;Citada']),
      'p3.csv',
    ).expect(201);
    const third = res.body as Batch;
    await attach(
      `/${third.id}/balances`,
      csv(BALANCES_HEADER, ['444444;70.000;COP;;']),
      'saldos3.csv',
    ).expect(201);
    await as(
      api().post(`/api/v1/patient-imports/${third.id}/confirm`),
      a.adminToken,
    )
      .send({ duplicateMode: 'SKIP' })
      .expect(200);
    await drain();
    const iris = await patientByDoc('444444');
    const start = new Date(Date.now() + 2 * 86_400_000);
    await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        patientId: iris.id,
        providerId: (
          await raw.user.findFirstOrThrow({
            where: { memberships: { some: { tenantId: a.tenantId } } },
          })
        ).id,
        locationId: mainLocationId,
        start,
        end: new Date(start.getTime() + 1_800_000),
      },
    });
    await as(
      api().post(`/api/v1/patient-imports/${third.id}/undo`),
      a.adminToken,
    ).expect(409);
    // Recepción no puede.
    await as(
      api().post(`/api/v1/patient-imports/${third.id}/balances/undo`),
      reception,
    ).expect(403);
    const out = await as(
      api().post(`/api/v1/patient-imports/${third.id}/balances/undo`),
      a.adminToken,
    ).expect(200);
    expect((out.body as Batch).status).toBe('COMPLETED');
    expect((out.body as Batch).balances).toMatchObject({
      undoneCount: 1,
      imported: [],
    });
    expect((await statementOf(iris.id)).openingBalances).toEqual([]);
    // Otra clínica no lo ve.
    await as(
      api().post(`/api/v1/patient-imports/${third.id}/balances/undo`),
      b.adminToken,
      b,
    ).expect(404);
  });

  it('la misma hoja otra vez no duplica la deuda: error por fila con el saldo existente; con «Añadir aunque ya tenga saldo migrado», sí (QA D1)', async () => {
    const upload = async (file: string, addToExisting?: string) => {
      const res = await attach(
        '',
        csv(PATIENTS_HEADER, ['CC;555555;Dora;Repetida']),
        file,
      ).expect(201);
      const batch = res.body as Batch;
      let req = attach(
        `/${batch.id}/balances`,
        csv(BALANCES_HEADER, ['555555;80.000;COP;01/09/2026;Cartera']),
        'saldos-dora.csv',
      );
      if (addToExisting !== undefined) {
        req = req.field('addToExisting', addToExisting);
      }
      return { batch, res: await req };
    };
    const { batch: first } = await upload('dora-1.csv');
    await as(
      api().post(`/api/v1/patient-imports/${first.id}/confirm`),
      a.adminToken,
    )
      .send({ duplicateMode: 'SKIP' })
      .expect(200);
    await drain();

    // Otra vez la misma hoja: por defecto no se crea, y dice cuál tiene.
    const again = await upload('dora-2.csv');
    expect(again.res.status).toBe(201);
    const body = again.res.body as Batch & {
      balanceIssues: { row: number; kind: string; message: string }[];
    };
    expect(body.balances).toMatchObject({
      preparedCount: 0,
      errorRows: 1,
      addToExisting: false,
      validTotals: [],
    });
    expect(body.balanceIssues).toEqual([
      expect.objectContaining({
        row: 2,
        kind: 'ERROR',
        message: expect.stringMatching(
          /^Este paciente ya tiene un saldo migrado vivo de 80\.000,00\sCOP \(lote «dora-1\.csv» del \d{2}\/\d{2}\/\d{4}, corte 01\/09\/2026\): no se crea otro\. Si es otra deuda, marca «Añadir aunque ya tenga saldo migrado» y vuelve a subir la hoja\.$/,
        ) as string,
      }),
    ]);

    // Un valor que no es booleano: 400 en español.
    const bad = await upload('dora-3.csv', 'quizá');
    expect(bad.res.status).toBe(400);
    expect(JSON.stringify(bad.res.body)).toContain(
      '«Añadir aunque ya tenga saldo migrado» debe ser true o false.',
    );

    // Marcado: se crea otro y se avisa.
    const added = await upload('dora-4.csv', 'true');
    expect(added.res.status).toBe(201);
    const addedBody = added.res.body as Batch & {
      balanceIssues: { kind: string }[];
    };
    expect(addedBody.balances).toMatchObject({
      preparedCount: 1,
      addToExisting: true,
    });
    expect(addedBody.balanceIssues.map((i) => i.kind)).toEqual([
      'EXISTING_BALANCE',
    ]);
    await as(
      api().post(`/api/v1/patient-imports/${added.batch.id}/confirm`),
      a.adminToken,
    )
      .send({ duplicateMode: 'SKIP' })
      .expect(200);
    await drain();
    const dora = await patientByDoc('555555');
    expect((await statementOf(dora.id)).openingBalances).toHaveLength(2);
    // La auditoría del dry-run dice que se marcó la casilla.
    const audited = await raw.auditEvent.findFirstOrThrow({
      where: {
        tenantId: a.tenantId,
        resourceType: 'PATIENT_IMPORT_BATCH',
        resourceId: added.batch.id,
        metadata: { path: ['reason'], equals: 'IMPORT_BALANCES_VALIDATED' },
      },
    });
    expect(audited.metadata).toMatchObject({
      importBatch: { balanceAddToExisting: true },
    });
  });

  it('quitar la hoja de saldos de un dry-run; en un lote ya importado, 409', async () => {
    const res = await attach(
      '',
      csv(PATIENTS_HEADER, ['CC;333333;Eva;Nueva']),
      'p2.csv',
    ).expect(201);
    const second = res.body as Batch;
    await attach(
      `/${second.id}/balances`,
      csv(BALANCES_HEADER, ['333333;10;COP;;']),
      'saldos.csv',
    ).expect(201);
    const cleared = await as(
      api().delete(`/api/v1/patient-imports/${second.id}/balances`),
      a.adminToken,
    ).expect(200);
    expect((cleared.body as Batch).balances).toBeNull();
    await as(
      api().delete(`/api/v1/patient-imports/${batch.id}/balances`),
      a.adminToken,
    ).expect(409);
  });
});
