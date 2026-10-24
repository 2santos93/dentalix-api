import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { RECEIPT_TYPE_MESSAGE } from '../src/modules/expenses/domain/expense-receipt';
import {
  CASH_SESSION_REQUIRED_MESSAGE,
  CATEGORY_DUPLICATE_MESSAGE,
  CATEGORY_INVALID_MESSAGE,
  HAS_PAYMENTS_MESSAGE,
  IDEMPOTENCY_KEY_REUSED_MESSAGE,
} from '../src/modules/expenses/domain/expense-rules';
import { FILE_STORAGE } from '../src/shared/storage/file-storage.port';
import type { FileStoragePort } from '../src/shared/storage/file-storage.port';
import { createE2eApp } from './support/create-e2e-app';
import {
  htmlFake,
  jpegFixture,
  pdfFixture,
  pngFixture,
} from './support/document-fixtures';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';

// DX-274 (Task 2) en HTTP real: gastos de la sede con sus pagos, categorías,
// proveedores y soporte. El aislamiento entre clínicas por id lo cubre
// tenant-isolation-matrix; los roles, role-matrix. Aquí van las reglas.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const STORAGE_ROOT = process.env.STORAGE_DIR ?? './storage-test';

interface PaymentBody {
  id: string;
  amount: number;
  method: string;
  paidOn: string;
  cashSessionId: string | null;
  createdById: string;
  voidedAt: string | null;
  voidedById: string | null;
  voidReason: string | null;
}

interface ExpenseBody {
  id: string;
  locationId: string;
  category: string;
  supplier: string | null;
  description: string | null;
  amount: number;
  currency: string;
  invoiceDate: string;
  dueDate: string | null;
  paidAmount: number;
  pendingAmount: number;
  status: 'PENDING' | 'PARTIAL' | 'PAID' | 'VOIDED';
  overdue: boolean;
  attachment: {
    name: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  } | null;
  createdById: string;
  voidedAt: string | null;
  voidReason: string | null;
  payments: PaymentBody[];
}

interface PageBody {
  items: ExpenseBody[];
  total: number;
  page: number;
  pageSize: number;
}

interface TicketBody {
  uploadId: string;
  target: { method: 'POST'; url: string; fields: Record<string, string> };
  maxBytes: number;
}

interface CategoryBody {
  id: string | null;
  name: string;
  predefined: boolean;
}

const hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const KEY_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const KEY_B = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const KEY_C = '6ba7b811-9dad-41d1-80b4-00c04fd430c8';
const KEY_D = '6ba7b812-9dad-41d1-80b4-00c04fd430c8';

describe('Gastos de la sede (e2e, DX-274)', () => {
  let app: INestApplication<App>;
  let storage: FileStoragePort;
  let clinic: Clinic;
  let other: Clinic;
  let loc1: string;
  let loc2: string;
  const tokens = {} as Record<ClinicRole, string>;
  let otherToken: string;

  const admin = () => tokens[ClinicRole.ADMIN];
  const call = (
    verb: 'get' | 'post' | 'patch' | 'delete',
    url: string,
    token: string = admin(),
    host: string = clinic.host,
  ) =>
    request(app.getHttpServer())
      [verb](`/api/v1${url}`)
      .set('X-Tenant-Host', host)
      .set('Authorization', `Bearer ${token}`);

  let seq = 0;
  /** Un gasto válido; `patch` sobreescribe campos. */
  const body = (patch: Record<string, unknown> = {}) => ({
    category: 'Papelería',
    supplier: `Proveedor ${++seq}`,
    amount: 100000,
    currency: 'COP',
    invoiceDate: '2026-10-01',
    ...patch,
  });
  async function createExpense(
    patch: Record<string, unknown> = {},
    token = admin(),
  ): Promise<ExpenseBody> {
    const res = await call('post', '/expenses', token)
      .send(body(patch))
      .expect(201);
    return res.body as ExpenseBody;
  }
  const pay = (
    id: string,
    payload: Record<string, unknown>,
    key?: string,
    token = admin(),
  ) => {
    const req = call('post', `/expenses/${id}/payments`, token).send(payload);
    return key ? req.set('Idempotency-Key', key) : req;
  };
  const detail = async (id: string): Promise<ExpenseBody> =>
    (await call('get', `/expenses/${id}`).expect(200)).body as ExpenseBody;
  const messageOf = (res: request.Response) =>
    (res.body as { message: string | string[] }).message;

  /** Pide la autorización de subida y envía el fichero como lo haría el navegador. */
  async function uploadFile(
    bytes: Buffer,
    declared: { name: string; mimeType: string },
    token = admin(),
  ): Promise<TicketBody> {
    const res = await call('post', '/expenses/attachments/upload-url', token)
      .send({ ...declared, size: bytes.length, sha256: hex(bytes) })
      .expect(200);
    const ticket = res.body as TicketBody;
    let req = request(app.getHttpServer()).post(
      new URL(ticket.target.url).pathname,
    );
    for (const [name, value] of Object.entries(ticket.target.fields)) {
      req = req.field(name, value);
    }
    await req.attach('file', bytes, { filename: 'blob' }).expect(204);
    return ticket;
  }
  const pendingKey = (uploadId: string) =>
    `expense-receipts/pending/${clinic.tenantId}/${uploadId}`;

  const auditEvents = (resourceId: string) =>
    raw.auditEvent.findMany({
      where: { resourceType: 'EXPENSE', resourceId },
      orderBy: { occurredAt: 'asc' },
    });

  /** Repite `check` hasta que pase (trabajo que no espera a la respuesta). */
  async function eventually(check: () => Promise<void>): Promise<void> {
    let last: unknown;
    for (let i = 0; i < 30; i++) {
      try {
        await check();
        return;
      } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw last;
  }

  const fetchSigned = (signedUrl: string) => {
    const u = new URL(signedUrl);
    return request(app.getHttpServer())
      .get(`${u.pathname}${u.search}`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
  };

  beforeAll(async () => {
    app = await createE2eApp();
    storage = app.get<FileStoragePort>(FILE_STORAGE);
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx274-gastos');
    other = await registerClinic(app, 'dx274-gastos-otra');
    otherToken = other.adminToken;
    tokens[ClinicRole.ADMIN] = clinic.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
    const sedes = await call('get', '/locations').expect(200);
    loc1 = (sedes.body as { id: string }[])[0].id;
    const second = await call('post', '/locations')
      .send({ name: 'Sede Norte' })
      .expect(201);
    loc2 = (second.body as { id: string }).id;
  });

  afterAll(async () => {
    await fs.rm(path.join(STORAGE_ROOT, 'expense-receipts'), {
      recursive: true,
      force: true,
    });
    await fs.rm(path.join(STORAGE_ROOT, '.meta'), {
      recursive: true,
      force: true,
    });
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('alta y detalle', () => {
    it('crea un gasto PENDING en la sede por defecto y lo devuelve igual en el detalle', async () => {
      const created = await createExpense({
        supplier: '  Papelería   Luna  ',
        description: ' Resmas y carpetas ',
        category: 'papeleria',
        currency: 'cop',
        dueDate: '2099-12-31',
        amount: 120000.5,
      });
      expect(created).toMatchObject({
        locationId: loc1,
        category: 'Papelería',
        supplier: 'Papelería Luna',
        description: 'Resmas y carpetas',
        amount: 120000.5,
        currency: 'COP',
        invoiceDate: '2026-10-01',
        dueDate: '2099-12-31',
        paidAmount: 0,
        pendingAmount: 120000.5,
        status: 'PENDING',
        overdue: false,
        attachment: null,
        payments: [],
        createdById: clinic.adminUserId,
      });
      expect(await detail(created.id)).toEqual(created);
      const row = await raw.expense.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row).toMatchObject({
        tenantId: clinic.tenantId,
        supplier: 'Papelería Luna',
      });
      expect(row.createdAt.getTime()).toBeGreaterThan(0);
    });

    it('crea en la sede pedida y rechaza una sede de otra clínica o inexistente', async () => {
      const norte = await createExpense({ locationId: loc2 });
      expect(norte.locationId).toBe(loc2);
      const foreign = await call('get', '/locations', otherToken, other.host);
      const foreignLoc = (foreign.body as { id: string }[])[0].id;
      for (const locationId of [
        foreignLoc,
        '9b2f9a6e-3f1c-4d2e-8a55-0d3f6a1b7c10',
      ]) {
        const res = await call('post', '/expenses')
          .send(body({ locationId }))
          .expect(400);
        expect(messageOf(res)).toBe('La sede no es válida.');
      }
      // PATCH: tampoco se puede mover un gasto sin pagos a una sede ajena.
      const mine = await createExpense();
      const moved = await call('patch', `/expenses/${mine.id}`)
        .send({ locationId: foreignLoc })
        .expect(400);
      expect(messageOf(moved)).toBe('La sede no es válida.');
    });

    it('valida categoría, importe, moneda, proveedor y fechas', async () => {
      const cases: [Record<string, unknown>, string | RegExp][] = [
        [{ category: 'Inventada' }, CATEGORY_INVALID_MESSAGE],
        [{ category: undefined }, CATEGORY_INVALID_MESSAGE],
        [{ amount: 0 }, /importe/],
        [{ amount: 10.005 }, /importe/],
        [{ currency: 'ZZZ' }, 'La moneda no es válida.'],
        [{ supplier: 'x'.repeat(201) }, /proveedor/],
        [{ invoiceDate: '2099-01-01' }, /no puede ser futura/],
        [{ invoiceDate: '2026-02-30' }, /fecha de la factura no es válida/],
        [{ dueDate: '2026-09-30' }, /no puede ser anterior/],
      ];
      for (const [patch, expected] of cases) {
        const res = await call('post', '/expenses')
          .send(body(patch))
          .expect(400);
        const message = [messageOf(res)].flat().join(' ');
        if (typeof expected === 'string') expect(message).toContain(expected);
        else expect(message).toMatch(expected);
      }
    });

    it('audita CREATE, UPDATE y VIEW del gasto con solo los nombres de campo', async () => {
      const created = await createExpense({
        supplier: 'Proveedor Secreto SAS',
        description: 'Descripción secreta',
      });
      await call('patch', `/expenses/${created.id}`)
        .send({ supplier: 'Otro Secreto SA', description: 'Más secreta' })
        .expect(200);
      await call('get', `/expenses/${created.id}`).expect(200);
      const events = await auditEvents(created.id);
      expect(events.map((e) => e.action)).toEqual(['CREATE', 'UPDATE', 'VIEW']);
      for (const event of events) {
        expect(event.actorUserId).toBe(clinic.adminUserId);
        expect(event.actorRole).toBe('ADMIN');
        const text = JSON.stringify(event);
        expect(text).not.toMatch(/ecret/);
      }
      const meta = events[1].metadata as { changedFields: string[] };
      expect(meta.changedFields).toEqual(
        expect.arrayContaining(['supplier', 'description']),
      );
    });
  });

  describe('lista', () => {
    let listClinic: Clinic;
    let token: string;
    const get = (query: object = {}) =>
      request(app.getHttpServer())
        .get('/api/v1/expenses')
        .set('X-Tenant-Host', listClinic.host)
        .set('Authorization', `Bearer ${token}`)
        .query(query);
    const names = async (query: object = {}) =>
      ((await get(query).expect(200)).body as PageBody).items.map(
        (e) => e.supplier,
      );

    beforeAll(async () => {
      // Una clínica propia: la lista cuenta TODOS los gastos de la clínica.
      listClinic = await registerClinic(app, 'dx274-lista');
      token = listClinic.adminToken;
      const make = async (payload: Record<string, unknown>) =>
        (
          await request(app.getHttpServer())
            .post('/api/v1/expenses')
            .set('X-Tenant-Host', listClinic.host)
            .set('Authorization', `Bearer ${token}`)
            .send({ currency: 'COP', amount: 100000, ...payload })
            .expect(201)
        ).body as ExpenseBody;
      const payOn = (id: string, amount: number) =>
        request(app.getHttpServer())
          .post(`/api/v1/expenses/${id}/payments`)
          .set('X-Tenant-Host', listClinic.host)
          .set('Authorization', `Bearer ${token}`)
          .send({ amount, method: 'TRANSFER' })
          .expect(201);

      const paid = await make({
        supplier: 'Pagado SA',
        category: 'Arriendo',
        invoiceDate: '2026-09-01',
      });
      await payOn(paid.id, 100000);
      const partial = await make({
        supplier: 'Parcial SA',
        category: 'Laboratorio',
        invoiceDate: '2026-09-10',
        dueDate: '2026-09-20',
      });
      await payOn(partial.id, 40000);
      await make({
        supplier: 'Pendiente SA',
        category: 'Mensajería',
        invoiceDate: '2026-09-20',
        description: 'Café y papelería de la mañana',
        dueDate: '2099-01-01',
      });
      const voided = await make({
        supplier: 'Anulado SA',
        category: 'Otros',
        invoiceDate: '2026-09-25',
      });
      await request(app.getHttpServer())
        .post(`/api/v1/expenses/${voided.id}/void`)
        .set('X-Tenant-Host', listClinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Gasto duplicado' })
        .expect(200);
    });

    it('más reciente primero, con estado, pagado, pendiente y vencido', async () => {
      const page = (await get().expect(200)).body as PageBody;
      expect(page.total).toBe(4);
      expect(page.items.map((e) => [e.supplier, e.status, e.overdue])).toEqual([
        ['Anulado SA', 'VOIDED', false],
        ['Pendiente SA', 'PENDING', false],
        ['Parcial SA', 'PARTIAL', true],
        ['Pagado SA', 'PAID', false],
      ]);
      const partial = page.items.find((e) => e.supplier === 'Parcial SA')!;
      expect(partial).toMatchObject({
        paidAmount: 40000,
        pendingAmount: 60000,
      });
    });

    it('filtra por estado, OPEN, vencidos, rango, categoría y texto', async () => {
      expect(await names({ status: 'PAID' })).toEqual(['Pagado SA']);
      expect(await names({ status: 'PARTIAL' })).toEqual(['Parcial SA']);
      expect(await names({ status: 'OPEN' })).toEqual([
        'Pendiente SA',
        'Parcial SA',
      ]);
      expect(await names({ overdue: 'true' })).toEqual(['Parcial SA']);
      expect(await names({ overdue: 'false' })).toEqual([
        'Anulado SA',
        'Pendiente SA',
        'Pagado SA',
      ]);
      expect(await names({ status: 'VOIDED' })).toEqual(['Anulado SA']);
      expect(await names({ from: '2026-09-10', to: '2026-09-20' })).toEqual([
        'Pendiente SA',
        'Parcial SA',
      ]);
      expect(await names({ category: 'ARRIENDO' })).toEqual(['Pagado SA']);
      expect(await names({ query: 'CAFÉ' })).toEqual(['Pendiente SA']);
      expect(await names({ query: 'parcial' })).toEqual(['Parcial SA']);
    });

    it('pagina y rechaza filtros inválidos', async () => {
      const first = (await get({ pageSize: 2 }).expect(200)).body as PageBody;
      const second = (await get({ pageSize: 2, page: 2 }).expect(200))
        .body as PageBody;
      expect(first.items.map((e) => e.supplier)).toEqual([
        'Anulado SA',
        'Pendiente SA',
      ]);
      expect(second.items.map((e) => e.supplier)).toEqual([
        'Parcial SA',
        'Pagado SA',
      ]);
      expect(second.total).toBe(4);
      await get({ pageSize: 101 }).expect(400);
      await get({ page: 0 }).expect(400);
      await get({ status: 'OTRO' }).expect(400);
      await get({ from: '2026-13-01' }).expect(400);
      await get({ from: '2026-10-10', to: '2026-10-01' }).expect(400);
    });

    it('la lista de otra clínica no trae estos gastos', async () => {
      const res = await call('get', '/expenses', otherToken, other.host)
        .query({ query: 'Pagado SA' })
        .expect(200);
      expect((res.body as PageBody).total).toBe(0);
    });
  });

  describe('pagos y tope (R2)', () => {
    it('parcial → PARTIAL, completo → PAID, con quién y qué día', async () => {
      const e = await createExpense({ amount: 100000 });
      const first = (
        await pay(e.id, { amount: 30000, method: 'CARD' }).expect(201)
      ).body as ExpenseBody;
      expect(first).toMatchObject({
        status: 'PARTIAL',
        paidAmount: 30000,
        pendingAmount: 70000,
      });
      const done = (
        await pay(e.id, {
          amount: 70000,
          method: 'TRANSFER',
          paidOn: '2026-10-02',
        }).expect(201)
      ).body as ExpenseBody;
      expect(done).toMatchObject({ status: 'PAID', pendingAmount: 0 });
      expect(done.payments.map((p) => [p.amount, p.method, p.paidOn])).toEqual([
        [30000, 'CARD', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as string],
        [70000, 'TRANSFER', '2026-10-02'],
      ]);
      expect(done.payments[0]).toMatchObject({
        createdById: clinic.adminUserId,
        cashSessionId: null,
      });
    });

    it('un céntimo de más es 400 con lo pendiente, y no queda nada', async () => {
      const e = await createExpense({ amount: 100000 });
      await pay(e.id, { amount: 99999.5, method: 'CARD' }).expect(201);
      const res = await pay(e.id, { amount: 0.51, method: 'CARD' }).expect(400);
      expect(messageOf(res)).toBe(
        'El pago supera lo pendiente del gasto (0,50 COP).',
      );
      expect(
        await raw.expensePayment.count({ where: { expenseId: e.id } }),
      ).toBe(1);
    });

    it('dos pagos simultáneos que juntos pasan lo pendiente: uno entra y otro es 400', async () => {
      const e = await createExpense({ amount: 100000 });
      const results = await Promise.all([
        pay(e.id, { amount: 70000, method: 'CARD' }),
        pay(e.id, { amount: 70000, method: 'TRANSFER' }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
      const rejected = results.find((r) => r.status === 400)!;
      expect(messageOf(rejected)).toContain('El pago supera lo pendiente');
      const live = await raw.expensePayment.aggregate({
        _sum: { amount: true },
        where: { expenseId: e.id, voidedAt: null },
      });
      expect(Number(live._sum.amount)).toBe(70000);
    });

    it('cinco pagos simultáneos de 30000 sobre 100000: entran 3 y la suma nunca pasa el importe', async () => {
      const e = await createExpense({ amount: 100000 });
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          pay(e.id, { amount: 30000, method: 'CARD' }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(3);
      expect(results.filter((r) => r.status === 400)).toHaveLength(2);
      const live = await raw.expensePayment.aggregate({
        _sum: { amount: true },
        where: { expenseId: e.id, voidedAt: null },
      });
      expect(Number(live._sum.amount)).toBe(90000);
    });

    it('valida importe, día futuro y medio; 404 si el gasto no existe', async () => {
      const e = await createExpense();
      await pay(e.id, { amount: 0, method: 'CARD' }).expect(400);
      await pay(e.id, { amount: 1, method: 'BITCOIN' }).expect(400);
      const future = await pay(e.id, {
        amount: 1,
        method: 'CARD',
        paidOn: '2099-01-01',
      }).expect(400);
      expect(messageOf(future)).toBe('La fecha del pago no puede ser futura.');
      await pay('9b2f9a6e-3f1c-4d2e-8a55-0d3f6a1b7c10', {
        amount: 1,
        method: 'CARD',
      }).expect(404);
    });

    it('en efectivo, con la clínica que exige caja abierta: 409 y sin pago', async () => {
      const e = await createExpense();
      await raw.tenant.update({
        where: { id: clinic.tenantId },
        data: { cashRequireOpenSession: true },
      });
      try {
        const res = await pay(e.id, { amount: 1000, method: 'CASH' }).expect(
          409,
        );
        expect(messageOf(res)).toBe(CASH_SESSION_REQUIRED_MESSAGE);
        await call('post', '/expenses')
          .send(body({ payment: { amount: 1000, method: 'CASH' } }))
          .expect(409);
        await pay(e.id, { amount: 1000, method: 'TRANSFER' }).expect(201);
      } finally {
        await raw.tenant.update({
          where: { id: clinic.tenantId },
          data: { cashRequireOpenSession: false },
        });
      }
      expect(
        await raw.expensePayment.count({
          where: { expenseId: e.id, method: 'CASH' },
        }),
      ).toBe(0);
      // Sin esa exigencia, el efectivo entra (fuera de caja).
      const ok = (await pay(e.id, { amount: 1000, method: 'CASH' }).expect(201))
        .body as ExpenseBody;
      expect(ok.payments.at(-1)).toMatchObject({
        method: 'CASH',
        cashSessionId: null,
      });
    });

    it('el pago inicial del alta entra en la misma operación', async () => {
      const partial = await createExpense({
        amount: 50000,
        payment: { amount: 20000, method: 'TRANSFER' },
      });
      expect(partial).toMatchObject({ status: 'PARTIAL', paidAmount: 20000 });
      expect(partial.payments).toHaveLength(1);
      const paid = await createExpense({
        amount: 50000,
        payment: { amount: 50000, method: 'CARD', paidOn: '2026-10-01' },
      });
      expect(paid.status).toBe('PAID');
      // Un pago inicial mayor que el gasto rechaza el alta entera.
      const before = await raw.expense.count();
      await call('post', '/expenses')
        .send(body({ amount: 100, payment: { amount: 101, method: 'CARD' } }))
        .expect(400);
      expect(await raw.expense.count()).toBe(before);
    });

    it('audita el pago como CREATE/PAYMENT_ADDED sobre el gasto', async () => {
      const e = await createExpense();
      await pay(e.id, { amount: 1000, method: 'CARD' }).expect(201);
      const events = await auditEvents(e.id);
      expect(events.map((x) => [x.action, x.metadata])).toContainEqual([
        'CREATE',
        expect.objectContaining({ reason: 'PAYMENT_ADDED' }) as unknown,
      ]);
    });
  });

  describe('idempotencia', () => {
    it('POST /expenses: la misma clave y cuerpo devuelve el original; otro cuerpo es 422', async () => {
      const payload = body({ supplier: 'Idem SA' });
      const first = (
        await call('post', '/expenses')
          .set('Idempotency-Key', KEY_A)
          .send(payload)
          .expect(201)
      ).body as ExpenseBody;
      const again = (
        await call('post', '/expenses')
          .set('Idempotency-Key', KEY_A)
          .send(payload)
          .expect(201)
      ).body as ExpenseBody;
      expect(again.id).toBe(first.id);
      expect(await raw.expense.count({ where: { supplier: 'Idem SA' } })).toBe(
        1,
      );
      const reused = await call('post', '/expenses')
        .set('Idempotency-Key', KEY_A)
        .send({ ...payload, amount: 1 })
        .expect(422);
      expect(messageOf(reused)).toBe(IDEMPOTENCY_KEY_REUSED_MESSAGE);
      await call('post', '/expenses')
        .set('Idempotency-Key', 'no-es-uuid')
        .send(payload)
        .expect(400);
    });

    it('POST /expenses: dos altas simultáneas con la misma clave dejan un gasto', async () => {
      const payload = body({ supplier: 'Carrera SA' });
      const results = await Promise.all(
        [0, 1, 2].map(() =>
          call('post', '/expenses').set('Idempotency-Key', KEY_B).send(payload),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(new Set(results.map((r) => (r.body as ExpenseBody).id)).size).toBe(
        1,
      );
      expect(
        await raw.expense.count({ where: { supplier: 'Carrera SA' } }),
      ).toBe(1);
    });

    it('POST …/payments: repetir no duplica; otro importe, medio o gasto es 422', async () => {
      const e = await createExpense({ amount: 100000 });
      const other2 = await createExpense({ amount: 100000 });
      const payload = { amount: 10000, method: 'CARD' };
      await pay(e.id, payload, KEY_C).expect(201);
      const again = (await pay(e.id, payload, KEY_C).expect(201))
        .body as ExpenseBody;
      expect(again.payments).toHaveLength(1);
      await pay(e.id, { ...payload, amount: 10001 }, KEY_C).expect(422);
      await pay(e.id, { ...payload, method: 'TRANSFER' }, KEY_C).expect(422);
      await pay(other2.id, payload, KEY_C).expect(422);
      expect(
        await raw.expensePayment.count({ where: { expenseId: e.id } }),
      ).toBe(1);
    });

    it('POST …/payments: tres pagos simultáneos con la misma clave dejan uno', async () => {
      const e = await createExpense({ amount: 100000 });
      const results = await Promise.all(
        [0, 1, 2].map(() =>
          pay(e.id, { amount: 10000, method: 'CARD' }, KEY_D),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(
        await raw.expensePayment.count({ where: { expenseId: e.id } }),
      ).toBe(1);
    });
  });

  describe('idempotencia: carreras y repeticiones (ronda de revisión 1)', () => {
    it('tres pagos simultáneos del TOTAL con la misma clave: 201 los tres y una sola fila', async () => {
      const e = await createExpense({ amount: 100000 });
      const key = '6ba7b814-9dad-41d1-80b4-00c04fd430c8';
      const results = await Promise.all(
        [0, 1, 2].map(() => pay(e.id, { amount: 100000, method: 'CARD' }, key)),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      for (const r of results) {
        expect((r.body as ExpenseBody).payments).toHaveLength(1);
      }
      expect(
        await raw.expensePayment.count({ where: { expenseId: e.id } }),
      ).toBe(1);
      expect((await detail(e.id)).status).toBe('PAID');
    });

    it('una repetición no escribe una segunda fila de auditoría (alta y pago)', async () => {
      const key = '6ba7b815-9dad-41d1-80b4-00c04fd430c8';
      const payload = body({ supplier: 'Auditoría única SA' });
      const first = (
        await call('post', '/expenses')
          .set('Idempotency-Key', key)
          .send(payload)
          .expect(201)
      ).body as ExpenseBody;
      await call('post', '/expenses')
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(201);
      const payKey = '6ba7b816-9dad-41d1-80b4-00c04fd430c8';
      await pay(first.id, { amount: 1000, method: 'CARD' }, payKey).expect(201);
      await pay(first.id, { amount: 1000, method: 'CARD' }, payKey).expect(201);
      const events = await auditEvents(first.id);
      expect(events.map((x) => x.action)).toEqual(['CREATE', 'CREATE']);
      expect(
        events.filter((x) =>
          JSON.stringify(x.metadata).includes('PAYMENT_ADDED'),
        ),
      ).toHaveLength(1);
    });

    it('la misma clave bajo otra X-Location-Id es un 4xx en español, no un 500', async () => {
      const key = '6ba7b817-9dad-41d1-80b4-00c04fd430c8';
      const payload = body({ supplier: 'Sede de la clave' });
      const first = (
        await call('post', '/expenses')
          .set('Idempotency-Key', key)
          .set('X-Location-Id', loc1)
          .send(payload)
          .expect(201)
      ).body as ExpenseBody;
      const other2 = await call('post', '/expenses')
        .set('Idempotency-Key', key)
        .set('X-Location-Id', loc2)
        .send(payload);
      expect(other2.status).toBe(409);
      expect(messageOf(other2)).toBe(IDEMPOTENCY_KEY_REUSED_MESSAGE);
      // Lo mismo con un pago.
      const payKey = '6ba7b818-9dad-41d1-80b4-00c04fd430c8';
      await call('post', `/expenses/${first.id}/payments`)
        .set('Idempotency-Key', payKey)
        .set('X-Location-Id', loc1)
        .send({ amount: 1000, method: 'CARD' })
        .expect(201);
      const again = await call('post', `/expenses/${first.id}/payments`)
        .set('Idempotency-Key', payKey)
        .set('X-Location-Id', loc2)
        .send({ amount: 1000, method: 'CARD' });
      expect(again.status).toBe(409);
      expect(messageOf(again)).toBe(IDEMPOTENCY_KEY_REUSED_MESSAGE);
    });
  });

  describe('edición', () => {
    it('cambia los datos de un gasto sin pagos y null vacía los opcionales', async () => {
      const e = await createExpense({
        supplier: 'Viejo SA',
        description: 'Viejo',
        dueDate: '2099-01-01',
      });
      const out = (
        await call('patch', `/expenses/${e.id}`)
          .send({
            category: 'laboratorio',
            supplier: '  Lab   Uno ',
            description: 'Coronas',
            invoiceDate: '2026-10-02',
            dueDate: '2099-02-01',
            amount: 250000,
          })
          .expect(200)
      ).body as ExpenseBody;
      expect(out).toMatchObject({
        category: 'Laboratorio',
        supplier: 'Lab Uno',
        description: 'Coronas',
        invoiceDate: '2026-10-02',
        dueDate: '2099-02-01',
        amount: 250000,
      });
      const cleared = (
        await call('patch', `/expenses/${e.id}`)
          .send({ supplier: null, description: null, dueDate: null })
          .expect(200)
      ).body as ExpenseBody;
      expect(cleared).toMatchObject({
        supplier: null,
        description: null,
        dueDate: null,
      });
      const events = await auditEvents(e.id);
      expect(events.filter((x) => x.action === 'UPDATE')).toHaveLength(2);
    });

    it('cambia la sede y la moneda mientras no haya pagos', async () => {
      const e = await createExpense();
      const out = (
        await call('patch', `/expenses/${e.id}`)
          .send({ locationId: loc2, currency: 'usd' })
          .expect(200)
      ).body as ExpenseBody;
      expect(out).toMatchObject({ locationId: loc2, currency: 'USD' });
    });

    it('con pagos: sede y moneda no cambian (409), el importe sí pero no bajo lo pagado', async () => {
      const e = await createExpense({ amount: 100000 });
      await pay(e.id, { amount: 40000, method: 'CARD' }).expect(201);
      const moved = await call('patch', `/expenses/${e.id}`)
        .send({ locationId: loc2 })
        .expect(409);
      expect(messageOf(moved)).toBe(HAS_PAYMENTS_MESSAGE);
      await call('patch', `/expenses/${e.id}`)
        .send({ currency: 'USD' })
        .expect(409);
      const below = await call('patch', `/expenses/${e.id}`)
        .send({ amount: 39999.99 })
        .expect(409);
      expect(messageOf(below)).toBe(
        'El importe no puede ser menor a lo ya pagado (40.000 COP).',
      );
      expect(
        (
          (
            await call('patch', `/expenses/${e.id}`)
              .send({ amount: 40000 })
              .expect(200)
          ).body as ExpenseBody
        ).status,
      ).toBe('PAID');
      await call('patch', `/expenses/${e.id}`)
        .send({ amount: 60000, description: 'Otra' })
        .expect(200);
      // Lo que no depende de los pagos se edita siempre.
      await call('patch', `/expenses/${e.id}`)
        .send({ category: 'Otros', dueDate: '2099-01-01' })
        .expect(200);
    });

    it('un pago ANULADO tampoco deja cambiar la sede ni la moneda, pero libera el importe', async () => {
      const e = await createExpense({ amount: 100000 });
      const paid = (
        await pay(e.id, { amount: 40000, method: 'CARD' }).expect(201)
      ).body as ExpenseBody;
      await call(
        'post',
        `/expenses/${e.id}/payments/${paid.payments[0].id}/void`,
      )
        .send({ reason: 'Pago mal digitado' })
        .expect(200);
      await call('patch', `/expenses/${e.id}`)
        .send({ locationId: loc2 })
        .expect(409);
      await call('patch', `/expenses/${e.id}`).send({ amount: 10 }).expect(200);
    });

    it('valida fechas, categoría y nulos en columnas obligatorias', async () => {
      const e = await createExpense({
        invoiceDate: '2026-10-01',
        dueDate: '2099-01-01',
      });
      const patch = (payload: object) =>
        call('patch', `/expenses/${e.id}`).send(payload);
      await patch({ invoiceDate: '2099-01-01', dueDate: '2099-06-01' }).expect(
        400,
      );
      await patch({ dueDate: '2026-09-30' }).expect(400);
      await patch({ invoiceDate: '2099-02-01' }).expect(400);
      await patch({ category: 'Inventada' }).expect(400);
      await patch({ amount: null }).expect(400);
      await patch({ category: null }).expect(400);
      await patch({ currency: 'ZZZ' }).expect(400);
      await call('patch', '/expenses/9b2f9a6e-3f1c-4d2e-8a55-0d3f6a1b7c10')
        .send({ description: 'x' })
        .expect(404);
    });
  });

  describe('anulación', () => {
    it('anular un pago exige motivo, es una vez, y el gasto vuelve a deber', async () => {
      const e = await createExpense({ amount: 100000 });
      const paid = (
        await pay(e.id, { amount: 100000, method: 'CARD' }).expect(201)
      ).body as ExpenseBody;
      const paymentId = paid.payments[0].id;
      const url = `/expenses/${e.id}/payments/${paymentId}/void`;
      await call('post', url).send({ reason: 'ab' }).expect(400);
      await call('post', url).send({}).expect(400);
      const voided = (
        await call('post', url)
          .send({ reason: '  Pago duplicado ' })
          .expect(200)
      ).body as ExpenseBody;
      expect(voided).toMatchObject({
        status: 'PENDING',
        paidAmount: 0,
        pendingAmount: 100000,
      });
      expect(voided.payments[0]).toMatchObject({
        voidedById: clinic.adminUserId,
        voidReason: 'Pago duplicado',
      });
      expect(voided.payments[0].voidedAt).not.toBeNull();
      await call('post', url).send({ reason: 'Pago duplicado' }).expect(409);
      // Ese importe se puede volver a pagar.
      await pay(e.id, { amount: 100000, method: 'TRANSFER' }).expect(201);
      // Un pago de otro gasto es 404.
      const stranger = await createExpense();
      await call('post', `/expenses/${stranger.id}/payments/${paymentId}/void`)
        .send({ reason: 'Pago duplicado' })
        .expect(404);
      const events = await auditEvents(e.id);
      expect(
        events.some(
          (x) =>
            x.action === 'VOID' &&
            JSON.stringify(x.metadata).includes('PAYMENT_VOIDED'),
        ),
      ).toBe(true);
    });

    it('anular el gasto anula TODOS sus pagos vivos y lo deja inmutable', async () => {
      const e = await createExpense({ amount: 100000 });
      const first = (
        await pay(e.id, { amount: 30000, method: 'CARD' }).expect(201)
      ).body as ExpenseBody;
      await pay(e.id, { amount: 20000, method: 'TRANSFER' }).expect(201);
      await call(
        'post',
        `/expenses/${e.id}/payments/${first.payments[0].id}/void`,
      )
        .send({ reason: 'Error anterior' })
        .expect(200);
      await call('post', `/expenses/${e.id}/void`)
        .send({ reason: 'abc' })
        .expect(400);
      const out = (
        await call('post', `/expenses/${e.id}/void`)
          .send({ reason: ' Factura duplicada ' })
          .expect(200)
      ).body as ExpenseBody;
      expect(out).toMatchObject({
        status: 'VOIDED',
        pendingAmount: 0,
        voidReason: 'Factura duplicada',
        overdue: false,
      });
      expect(out.voidedAt).not.toBeNull();
      const byId = new Map(out.payments.map((p) => [p.id, p]));
      // El ya anulado conserva su motivo; el vivo toma el de la anulación.
      expect(byId.get(first.payments[0].id)?.voidReason).toBe('Error anterior');
      expect(out.payments.filter((p) => p.voidedAt === null)).toHaveLength(0);
      expect(
        out.payments.find((p) => p.voidReason === 'Factura duplicada'),
      ).toMatchObject({ voidedById: clinic.adminUserId, amount: 20000 });

      await call('post', `/expenses/${e.id}/void`)
        .send({ reason: 'Otra vez' })
        .expect(409);
      await call('patch', `/expenses/${e.id}`)
        .send({ description: 'x' })
        .expect(409);
      await pay(e.id, { amount: 1, method: 'CARD' }).expect(409);
      expect(await raw.expense.count({ where: { id: e.id } })).toBe(1);
      // Sigue en la lista, tachado.
      const page = (
        await call('get', '/expenses').query({ status: 'VOIDED' }).expect(200)
      ).body as PageBody;
      expect(page.items.some((x) => x.id === e.id)).toBe(true);
      const events = await auditEvents(e.id);
      expect(
        events.some((x) =>
          JSON.stringify(x.metadata).includes('EXPENSE_VOIDED'),
        ),
      ).toBe(true);
    });
  });

  describe('proveedores', () => {
    it('sugiere distintos sin mayúsculas ni tildes, el más reciente primero, hasta 20', async () => {
      const supplierClinic = await registerClinic(app, 'dx274-proveedores');
      const make = (supplier: string) =>
        request(app.getHttpServer())
          .post('/api/v1/expenses')
          .set('X-Tenant-Host', supplierClinic.host)
          .set('Authorization', `Bearer ${supplierClinic.adminToken}`)
          .send({
            category: 'Otros',
            supplier,
            amount: 1000,
            currency: 'COP',
            invoiceDate: '2026-10-01',
          })
          .expect(201);
      const suggest = async (query?: string) =>
        (
          await request(app.getHttpServer())
            .get('/api/v1/expenses/suppliers')
            .set('X-Tenant-Host', supplierClinic.host)
            .set('Authorization', `Bearer ${supplierClinic.adminToken}`)
            .query(query === undefined ? {} : { query })
            .expect(200)
        ).body as string[];
      await make('Papelería Luna');
      await make('Aseo Total');
      await make('PAPELERIA LUNA');
      expect(await suggest()).toEqual(['PAPELERIA LUNA', 'Aseo Total']);
      expect(await suggest('lun')).toEqual(['PAPELERIA LUNA']);
      expect(await suggest('papelería')).toEqual(['PAPELERIA LUNA']);
      expect(await suggest('zzz')).toEqual([]);
      for (let i = 0; i < 22; i++) await make(`Proveedor ${i}`);
      expect(await suggest('proveedor')).toHaveLength(20);
      // Una clínica ajena no ve nada de esto.
      const foreign = await call(
        'get',
        '/expenses/suppliers',
        otherToken,
        other.host,
      )
        .query({ query: 'luna' })
        .expect(200);
      expect(foreign.body).toEqual([]);
    });
  });

  describe('categorías', () => {
    it('lista predefinidas (id null) y propias activas para ADMIN y recepción', async () => {
      const mine = (
        await call('post', '/expense-categories')
          .send({ name: '  Seguros   médicos ' })
          .expect(201)
      ).body as CategoryBody;
      expect(mine).toMatchObject({
        name: 'Seguros médicos',
        predefined: false,
      });
      for (const token of [admin(), tokens[ClinicRole.RECEPTION]]) {
        const list = (
          await call('get', '/expense-categories', token).expect(200)
        ).body as CategoryBody[];
        expect(list.filter((c) => c.predefined)).toHaveLength(11);
        expect(list.slice(0, 3).map((c) => [c.id, c.name])).toEqual([
          [null, 'Insumos clínicos'],
          [null, 'Laboratorio'],
          [null, 'Mensajería'],
        ]);
        expect(list.at(-1)).toEqual(mine);
      }
      // Otra clínica solo ve las predefinidas.
      const foreign = (
        await call('get', '/expense-categories', otherToken, other.host).expect(
          200,
        )
      ).body as CategoryBody[];
      expect(foreign.every((c) => c.predefined)).toBe(true);
    });

    it('duplicadas (predefinida o propia, sin tildes) son 409; nombres fuera de 2–60, 400', async () => {
      await call('post', '/expense-categories')
        .send({ name: 'papeleria' })
        .expect(409)
        .expect((res) =>
          expect(messageOf(res)).toBe(CATEGORY_DUPLICATE_MESSAGE),
        );
      await call('post', '/expense-categories')
        .send({ name: 'SEGUROS MEDICOS' })
        .expect(409);
      await call('post', '/expense-categories').send({ name: 'A' }).expect(400);
      await call('post', '/expense-categories')
        .send({ name: 'x'.repeat(61) })
        .expect(400);
    });

    it('una propia sirve en un gasto; retirada, ya no, pero los gastos viejos la conservan', async () => {
      const cat = (
        await call('post', '/expense-categories')
          .send({ name: 'Vigilancia' })
          .expect(201)
      ).body as CategoryBody;
      const used = await createExpense({ category: 'vigilancia' });
      expect(used.category).toBe('Vigilancia');
      await call('delete', `/expense-categories/${cat.id}`).expect(204);
      await call('delete', `/expense-categories/${cat.id}`).expect(404);
      const res = await call('post', '/expenses')
        .send(body({ category: 'Vigilancia' }))
        .expect(400);
      expect(messageOf(res)).toBe(CATEGORY_INVALID_MESSAGE);
      expect((await detail(used.id)).category).toBe('Vigilancia');
      // Editar otro campo conserva la categoría retirada.
      await call('patch', `/expenses/${used.id}`)
        .send({ category: 'Vigilancia', description: 'x' })
        .expect(200);
      const list = (await call('get', '/expense-categories').expect(200))
        .body as CategoryBody[];
      expect(list.some((c) => c.name === 'Vigilancia')).toBe(false);
      // El nombre queda libre para una nueva.
      await call('post', '/expense-categories')
        .send({ name: 'Vigilancia' })
        .expect(201);
    });

    it('una categoría propia de otra clínica no vale', async () => {
      await call('post', '/expense-categories', otherToken, other.host)
        .send({ name: 'Solo de B' })
        .expect(201);
      await call('post', '/expenses')
        .send(body({ category: 'Solo de B' }))
        .expect(400);
    });
  });

  describe('soporte', () => {
    it('subida directa válida → alta con attachmentUploadId; el pendiente desaparece y la URL sirve el PDF', async () => {
      const bytes = pdfFixture();
      const ticket = await uploadFile(bytes, {
        name: 'Factura luz ñ.pdf',
        mimeType: 'application/pdf',
      });
      expect(ticket.maxBytes).toBe(20 * 1024 * 1024);
      expect(await storage.stat(pendingKey(ticket.uploadId))).not.toBeNull();

      const created = (
        await call('post', '/expenses')
          .send(body({ attachmentUploadId: ticket.uploadId }))
          .expect(201)
      ).body as ExpenseBody;
      expect(created.attachment).toEqual({
        name: 'Factura luz ñ.pdf',
        mimeType: 'application/pdf',
        sizeBytes: bytes.length,
        sha256: hex(bytes),
      });
      expect(JSON.stringify(created)).not.toContain('expense-receipts');

      // El objeto está en su clave definitiva y el pendiente ya no.
      const row = await raw.expense.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.attachmentKey).toBe(
        `expense-receipts/${clinic.tenantId}/${ticket.uploadId}-${hex(bytes).slice(0, 16)}.pdf`,
      );
      expect(await storage.stat(row.attachmentKey!)).not.toBeNull();
      // El borrado del pendiente no espera a la respuesta.
      await eventually(async () =>
        expect(await storage.stat(pendingKey(ticket.uploadId))).toBeNull(),
      );

      // Inline: VIEW; descarga: EXPORT. Cabecera no-store y 300 s.
      const inline = await call(
        'get',
        `/expenses/${created.id}/attachment/url`,
      ).expect(200);
      expect(inline.headers['cache-control']).toBe('no-store');
      const inlineBody = inline.body as {
        url: string;
        disposition: string;
        expiresAt: string;
      };
      expect(inlineBody.disposition).toBe('inline');
      expect(Date.parse(inlineBody.expiresAt) - Date.now()).toBeLessThanOrEqual(
        300_000,
      );
      const file = await fetchSigned(inlineBody.url).expect(200);
      expect(file.headers['content-type']).toContain('application/pdf');
      expect(file.headers['content-disposition']).toMatch(/^inline;/);
      expect((file.body as Buffer).equals(bytes)).toBe(true);

      const download = (
        await call(
          'get',
          `/expenses/${created.id}/attachment/url?disposition=attachment`,
        ).expect(200)
      ).body as { url: string; disposition: string };
      expect(download.disposition).toBe('attachment');
      const downloaded = await fetchSigned(download.url).expect(200);
      expect(downloaded.headers['content-disposition']).toMatch(/^attachment;/);

      const events = await auditEvents(created.id);
      const urlEvents = events.filter((e) =>
        JSON.stringify(e.metadata).includes('EXPENSE_RECEIPT_'),
      );
      expect(urlEvents.map((e) => [e.action, e.metadata])).toEqual([
        ['VIEW', { reason: 'EXPENSE_RECEIPT_VIEW' }],
        ['EXPORT', { reason: 'EXPENSE_RECEIPT_DOWNLOAD' }],
      ]);
      for (const e of urlEvents) {
        expect(e.actorUserId).toBe(clinic.adminUserId);
        expect(JSON.stringify(e)).not.toContain('luz');
      }
      await call(
        'get',
        `/expenses/${created.id}/attachment/url?disposition=otro`,
      ).expect(400);
    });

    it('acepta JPG y PNG', async () => {
      for (const [bytes, declared] of [
        [jpegFixture(), { name: 'foto.jpg', mimeType: 'image/jpeg' }],
        [pngFixture(), { name: 'foto.png', mimeType: 'image/png' }],
      ] as const) {
        const ticket = await uploadFile(bytes, declared);
        const created = (
          await call('post', '/expenses')
            .send(body({ attachmentUploadId: ticket.uploadId }))
            .expect(201)
        ).body as ExpenseBody;
        expect(created.attachment?.mimeType).toBe(declared.mimeType);
      }
    });

    it('un HTML renombrado .pdf: 400 con el mensaje de tipo, sin gasto y sin objeto pendiente', async () => {
      const ticket = await uploadFile(htmlFake(), {
        name: 'factura.pdf',
        mimeType: 'application/pdf',
      });
      expect(await storage.stat(pendingKey(ticket.uploadId))).not.toBeNull();
      const before = await raw.expense.count();
      const res = await call('post', '/expenses')
        .send(body({ attachmentUploadId: ticket.uploadId }))
        .expect(400);
      expect(res.body as { message: string; code: string }).toMatchObject({
        message: RECEIPT_TYPE_MESSAGE,
        code: 'EXPENSE_RECEIPT_REJECTED',
      });
      expect(await raw.expense.count()).toBe(before);
      expect(await storage.stat(pendingKey(ticket.uploadId))).toBeNull();
    });

    it('lo declarado que ya no puede ser un soporte se rechaza al pedir la subida', async () => {
      const bytes = pdfFixture();
      const ask = (payload: object) =>
        call('post', '/expenses/attachments/upload-url').send(payload);
      const base = { size: bytes.length, sha256: hex(bytes) };
      const heic = await ask({
        ...base,
        name: 'foto.heic',
        mimeType: 'image/heic',
      }).expect(400);
      expect(messageOf(heic)).toBe(RECEIPT_TYPE_MESSAGE);
      await ask({ ...base, size: 0 }).expect(400);
      await ask({ ...base, sha256: 'abc' }).expect(400);
      await ask({ ...base, size: 20 * 1024 * 1024 + 1 }).expect(413);
    });

    it('un objeto con otro contenido que el declarado en la huella se rechaza y se borra', async () => {
      const declared = pdfFixture();
      const res = await call('post', '/expenses/attachments/upload-url')
        .send({
          name: 'f.pdf',
          mimeType: 'application/pdf',
          size: declared.length,
          sha256: hex(declared),
        })
        .expect(200);
      const ticket = res.body as TicketBody;
      // El almacén en disco rechaza el contenido con otra huella (403/400).
      let req = request(app.getHttpServer()).post(
        new URL(ticket.target.url).pathname,
      );
      for (const [name, value] of Object.entries(ticket.target.fields)) {
        req = req.field(name, value);
      }
      const upload = await req.attach('file', jpegFixture(), {
        filename: 'blob',
      });
      expect(upload.status).toBeGreaterThanOrEqual(400);
      const create = await call('post', '/expenses')
        .send(body({ attachmentUploadId: ticket.uploadId }))
        .expect(404);
      expect(messageOf(create)).toMatch(/No encontramos el archivo subido/);
    });

    it('la subida de otro usuario o de otra clínica es 404 y no se toca', async () => {
      const ticket = await uploadFile(
        pdfFixture(),
        { name: 'f.pdf', mimeType: 'application/pdf' },
        tokens[ClinicRole.RECEPTION],
      );
      await call('post', '/expenses')
        .send(body({ attachmentUploadId: ticket.uploadId }))
        .expect(404);
      expect(await storage.stat(pendingKey(ticket.uploadId))).not.toBeNull();
      await call('post', '/expenses', otherToken, other.host)
        .send(body({ attachmentUploadId: ticket.uploadId }))
        .expect(404);
      expect(await storage.stat(pendingKey(ticket.uploadId))).not.toBeNull();
      // Adjuntar después: la subida de otro usuario o de otra clínica es 404.
      const mine = await createExpense();
      await call('post', `/expenses/${mine.id}/attachment`)
        .send({ uploadId: ticket.uploadId })
        .expect(404);
      const theirs = await call('post', '/expenses', otherToken, other.host)
        .send(body())
        .expect(201);
      await call(
        'post',
        `/expenses/${(theirs.body as ExpenseBody).id}/attachment`,
        otherToken,
        other.host,
      )
        .send({ uploadId: ticket.uploadId })
        .expect(404);
      expect(await storage.stat(pendingKey(ticket.uploadId))).not.toBeNull();
    });

    it('adjuntar después: una vez, solo en gastos no anulados', async () => {
      const e = await createExpense();
      const ticket = await uploadFile(pdfFixture(), {
        name: 'soporte.pdf',
        mimeType: 'application/pdf',
      });
      const attached = (
        await call('post', `/expenses/${e.id}/attachment`)
          .send({ uploadId: ticket.uploadId })
          .expect(200)
      ).body as ExpenseBody;
      expect(attached.attachment).toMatchObject({ name: 'soporte.pdf' });
      // El cambio de soporte no existe: ya tiene uno.
      const second = await uploadFile(pngFixture(), {
        name: 'otro.png',
        mimeType: 'image/png',
      });
      await call('post', `/expenses/${e.id}/attachment`)
        .send({ uploadId: second.uploadId })
        .expect(409);
      expect(await storage.stat(pendingKey(second.uploadId))).not.toBeNull();

      const voided = await createExpense();
      await call('post', `/expenses/${voided.id}/void`)
        .send({ reason: 'Gasto de prueba' })
        .expect(200);
      await call('post', `/expenses/${voided.id}/attachment`)
        .send({ uploadId: second.uploadId })
        .expect(409);
      await call('post', `/expenses/${e.id}/attachment`)
        .send({ uploadId: 'no-uuid' })
        .expect(400);
    });

    it('un gasto sin soporte no tiene URL (404)', async () => {
      const e = await createExpense();
      await call('get', `/expenses/${e.id}/attachment/url`).expect(404);
    });

    it('la fila no se puede borrar ni cambiar el soporte en la BD', async () => {
      const ticket = await uploadFile(pdfFixture(), {
        name: 'fijo.pdf',
        mimeType: 'application/pdf',
      });
      const created = (
        await call('post', '/expenses')
          .send(body({ attachmentUploadId: ticket.uploadId }))
          .expect(201)
      ).body as ExpenseBody;
      await expect(
        raw.expense.update({
          where: { id: created.id },
          data: { attachmentKey: 'expense-receipts/x/y.pdf' },
        }),
      ).rejects.toThrow();
    });
  });

  describe('roles', () => {
    const adminOnly: [string, string][] = [
      ['get', '/expenses'],
      ['post', '/expenses'],
      ['get', '/expenses/9b2f9a6e-3f1c-4d2e-8a55-0d3f6a1b7c10'],
      ['patch', '/expenses/9b2f9a6e-3f1c-4d2e-8a55-0d3f6a1b7c10'],
      ['post', '/expenses/9b2f9a6e-3f1c-4d2e-8a55-0d3f6a1b7c10/void'],
      ['post', '/expenses/9b2f9a6e-3f1c-4d2e-8a55-0d3f6a1b7c10/payments'],
      ['post', '/expenses/9b2f9a6e-3f1c-4d2e-8a55-0d3f6a1b7c10/attachment'],
      ['get', '/expenses/9b2f9a6e-3f1c-4d2e-8a55-0d3f6a1b7c10/attachment/url'],
      ['post', '/expense-categories'],
      ['delete', '/expense-categories/9b2f9a6e-3f1c-4d2e-8a55-0d3f6a1b7c10'],
    ];

    it.each([ClinicRole.RECEPTION, ClinicRole.DENTIST, ClinicRole.ASSISTANT])(
      '%s recibe 403 en la gestión de gastos',
      async (role) => {
        for (const [verb, url] of adminOnly) {
          const res = await call(
            verb as 'get' | 'post' | 'patch' | 'delete',
            url,
            tokens[role],
          ).send({});
          expect({ verb, url, status: res.status }).toEqual({
            verb,
            url,
            status: 403,
          });
        }
      },
    );

    it('recepción sí captura: subida del soporte, proveedores y categorías', async () => {
      const bytes = pdfFixture();
      await call(
        'post',
        '/expenses/attachments/upload-url',
        tokens[ClinicRole.RECEPTION],
      )
        .send({
          name: 'f.pdf',
          mimeType: 'application/pdf',
          size: bytes.length,
          sha256: hex(bytes),
        })
        .expect(200);
      await call(
        'get',
        '/expenses/suppliers',
        tokens[ClinicRole.RECEPTION],
      ).expect(200);
      await call(
        'get',
        '/expense-categories',
        tokens[ClinicRole.RECEPTION],
      ).expect(200);
    });

    it('odontólogo y asistente no capturan nada', async () => {
      for (const role of [ClinicRole.DENTIST, ClinicRole.ASSISTANT]) {
        await call('get', '/expenses/suppliers', tokens[role]).expect(403);
        await call('get', '/expense-categories', tokens[role]).expect(403);
        await call('post', '/expenses/attachments/upload-url', tokens[role])
          .send({})
          .expect(403);
      }
    });
  });

  describe('sedes (DX-089)', () => {
    let inLoc1: ExpenseBody;
    let inLoc2: ExpenseBody;

    const inSede = (
      verb: 'get' | 'post' | 'patch',
      url: string,
      locationId: string,
    ) => call(verb, url).set('X-Location-Id', locationId);

    beforeAll(async () => {
      inLoc1 = await createExpense({ locationId: loc1, supplier: 'Sede 1 SA' });
      inLoc2 = await createExpense({ locationId: loc2, supplier: 'Sede 2 SA' });
    });

    it('con la cabecera X-Location-Id, la lista y el detalle se acotan a esa sede', async () => {
      const list = (await inSede('get', '/expenses', loc2).expect(200))
        .body as PageBody;
      expect(list.items.length).toBeGreaterThan(0);
      expect(list.items.every((e) => e.locationId === loc2)).toBe(true);
      await inSede('get', `/expenses/${inLoc2.id}`, loc2).expect(200);
      await inSede('get', `/expenses/${inLoc1.id}`, loc2).expect(404);
      await inSede('post', `/expenses/${inLoc1.id}/payments`, loc2)
        .send({ amount: 1, method: 'CARD' })
        .expect(404);
      await inSede('patch', `/expenses/${inLoc1.id}`, loc2)
        .send({ description: 'x' })
        .expect(404);
    });

    it('con la cabecera, un gasto nuevo sin sede cae en la de la cabecera', async () => {
      const created = (
        await inSede('post', '/expenses', loc2).send(body()).expect(201)
      ).body as ExpenseBody;
      expect(created.locationId).toBe(loc2);
    });

    it('pedir otra sede en el filtro con la cabecera puesta no devuelve nada', async () => {
      const filtered = (
        await inSede('get', '/expenses', loc2)
          .query({ locationId: loc1 })
          .expect(200)
      ).body as PageBody;
      expect(filtered).toMatchObject({ total: 0, items: [] });
      const same = (
        await inSede('get', '/expenses', loc2)
          .query({ locationId: loc2 })
          .expect(200)
      ).body as PageBody;
      expect(same.items.length).toBeGreaterThan(0);
    });

    it('sin restricción ni cabecera se ven todas las sedes y se puede filtrar', async () => {
      const both = (await call('get', '/expenses').expect(200))
        .body as PageBody;
      expect(both.items.some((e) => e.id === inLoc1.id)).toBe(true);
      expect(both.items.some((e) => e.id === inLoc2.id)).toBe(true);
      const only1 = (
        await call('get', '/expenses').query({ locationId: loc1 }).expect(200)
      ).body as PageBody;
      expect(only1.items.length).toBeGreaterThan(0);
      expect(only1.items.every((e) => e.locationId === loc1)).toBe(true);
    });
  });

  describe('aislamiento', () => {
    it('otra clínica no ve, paga ni anula un gasto ajeno', async () => {
      const e = await createExpense();
      await call('get', `/expenses/${e.id}`, otherToken, other.host).expect(
        404,
      );
      await call('post', `/expenses/${e.id}/payments`, otherToken, other.host)
        .send({ amount: 1, method: 'CARD' })
        .expect(404);
      await call('post', `/expenses/${e.id}/void`, otherToken, other.host)
        .send({ reason: 'Intento ajeno' })
        .expect(404);
      expect(await detail(e.id)).toMatchObject({ status: 'PENDING' });
    });

    it('la misma Idempotency-Key en dos clínicas no se mezcla', async () => {
      const key = '6ba7b813-9dad-41d1-80b4-00c04fd430c8';
      const mine = (
        await call('post', '/expenses')
          .set('Idempotency-Key', key)
          .send(body({ supplier: 'Clave compartida' }))
          .expect(201)
      ).body as ExpenseBody;
      const theirs = (
        await call('post', '/expenses', otherToken, other.host)
          .set('Idempotency-Key', key)
          .send(body({ supplier: 'Clave compartida' }))
          .expect(201)
      ).body as ExpenseBody;
      expect(theirs.id).not.toBe(mine.id);
    });
  });
});
