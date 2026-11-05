import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
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
import {
  htmlFake,
  pdfFixture,
  pngFixture,
  webpFixture,
} from './support/document-fixtures';
import { fixedSedeDay } from './support/sede-clock';

// DX-389 en HTTP real: el comprobante del cobro (captura del pago móvil o de
// la transferencia) se sube con un POST prefirmado al almacén privado, se
// entrega al registrar el abono (`proofUploadId`) y se ve con una URL firmada
// de vida corta solo por ADMIN y RECEPTION. La validación por contenido, el
// tope de 10 MB y la regla «Pide comprobante» son 400 en español.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const STORAGE_ROOT = process.env.STORAGE_DIR ?? './storage-test';
// Un día fijo y pasado en la sede: no cruza la medianoche de la sede (DX-209).
const TODAY = fixedSedeDay().day;
const hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

interface TicketBody {
  uploadId: string;
  target: { method: 'POST'; url: string; fields: Record<string, string> };
  maxBytes: number;
}
interface PaymentBody {
  id: string;
  hasProof: boolean;
  splitId: string | null;
}
interface MethodBody {
  id: string;
  legacyMethod: string | null;
  proofPolicy: string;
}

describe('Comprobante del cobro (e2e, DX-389)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let planA: string;
  const tokens = {} as Record<ClinicRole, string>;
  let tokenB: string;
  let optional: string;
  let required: string;
  let none: string;
  let cashB: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic, token: string) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const callA = (
    verb: 'get' | 'post' | 'patch',
    url: string,
    role: ClinicRole = ClinicRole.RECEPTION,
  ) => as(api()[verb](`/api/v1${url}`), a, tokens[role]);

  /** Pide la autorización y envía el fichero como lo haría el navegador. */
  async function uploadFile(
    bytes: Buffer,
    declared: { name: string; mimeType: string },
    clinic: Clinic = a,
    token: string = tokens[ClinicRole.RECEPTION],
  ): Promise<TicketBody> {
    const res = await as(
      api().post('/api/v1/payments/proofs/upload-url'),
      clinic,
      token,
    )
      .send({ ...declared, size: bytes.length, sha256: hex(bytes) })
      .expect(200);
    const ticket = res.body as TicketBody;
    let req = api().post(new URL(ticket.target.url).pathname);
    for (const [name, value] of Object.entries(ticket.target.fields)) {
      req = req.field(name, value);
    }
    await req.attach('file', bytes, { filename: 'blob' }).expect(204);
    return ticket;
  }

  const pay = (body: Record<string, unknown>, role = ClinicRole.RECEPTION) =>
    callA('post', `/treatment-plans/${planA}/payments`, role).send({
      amount: 1000,
      currency: 'VES',
      paidAt: TODAY,
      ...body,
    });
  const messageOf = (res: request.Response) =>
    (res.body as { message: string | string[] }).message;

  const fetchSigned = (signedUrl: string) => {
    const u = new URL(signedUrl);
    return api()
      .get(`${u.pathname}${u.search}`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
  };

  async function seedPlan(clinic: Clinic, tag: string): Promise<string> {
    const token = clinic.adminToken;
    const patient = (
      await as(api().post('/api/v1/patients'), clinic, token)
        .send({
          firstName: 'María',
          lastName: 'Comprobante',
          docType: 'NATIONAL_ID',
          docNumber: `DX389-${tag}`,
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    const item = (
      await as(api().post('/api/v1/catalog/items'), clinic, token)
        .send({
          code: `DX389-${tag}`,
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 1_000_000,
        })
        .expect(201)
    ).body as { id: string };
    const planId = (
      (
        await as(
          api().post(`/api/v1/patients/${patient.id}/treatment-plans`),
          clinic,
          token,
        )
          .send({ notes: 'Plan DX-389', currency: 'VES' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const planItem = (
      await as(
        api().post(`/api/v1/treatment-plans/${planId}/items`),
        clinic,
        token,
      )
        .send({ toothNumber: '11', catalogItemId: item.id })
        .expect(201)
    ).body as { id: string };
    await as(
      api().patch(`/api/v1/treatment-plans/${planId}/items/${planItem.id}`),
      clinic,
      token,
    )
      .send({ status: 'DONE' })
      .expect(200);
    return planId;
  }

  const methodsOf = async (clinic: Clinic): Promise<MethodBody[]> =>
    (
      await as(
        api().get('/api/v1/payment-methods'),
        clinic,
        clinic.adminToken,
      ).expect(200)
    ).body as MethodBody[];

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx389-a');
    b = await registerClinic(app, 'dx389-b');
    tokens[ClinicRole.ADMIN] = a.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, a, role);
      tokens[role] = await loginAs(app, a.host, member.email);
    }
    tokenB = b.adminToken;
    planA = await seedPlan(a, 'A');
    const methods = await methodsOf(a);
    none = methods.find((m) => m.legacyMethod === 'CASH')!.id;
    const transfer = methods.find((m) => m.legacyMethod === 'TRANSFER')!;
    optional = transfer.id;
    required = (
      (
        await callA('post', '/payment-methods', ClinicRole.ADMIN)
          .send({
            name: 'Pago móvil',
            kind: 'DIGITAL',
            requiresReference: false,
            proofPolicy: 'REQUIRED',
          })
          .expect(201)
      ).body as MethodBody
    ).id;
    // La clínica B también admite comprobante (si no, el medio lo rechaza antes).
    cashB = (await methodsOf(b)).find((m) => m.legacyMethod === 'CASH')!.id;
    await as(api().patch(`/api/v1/payment-methods/${cashB}`), b, tokenB)
      .send({ proofPolicy: 'OPTIONAL' })
      .expect(200);
  });

  afterAll(async () => {
    await fs.rm(path.join(STORAGE_ROOT, 'payment-proofs'), {
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

  describe('«Pide comprobante» en el medio (A1, A5)', () => {
    it('todos los medios nacen en NONE; solo ADMIN lo cambia, y queda auditado', async () => {
      const before = await methodsOf(a);
      expect(before.find((m) => m.id === optional)?.proofPolicy).toBe('NONE');

      for (const role of [ClinicRole.RECEPTION, ClinicRole.DENTIST]) {
        await callA('patch', `/payment-methods/${optional}`, role)
          .send({ proofPolicy: 'OPTIONAL' })
          .expect(403);
      }
      await callA('patch', `/payment-methods/${optional}`, ClinicRole.ADMIN)
        .send({ proofPolicy: 'OPTIONAL' })
        .expect(200);
      expect(
        (await methodsOf(a)).find((m) => m.id === optional)?.proofPolicy,
      ).toBe('OPTIONAL');
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          resourceType: 'PAYMENT_METHOD',
          resourceId: optional,
          action: 'UPDATE',
        },
      });
      expect(events.length).toBeGreaterThan(0);
      await callA('patch', `/payment-methods/${optional}`, ClinicRole.ADMIN)
        .send({ proofPolicy: 'MUCHO' })
        .expect(400);
    });
  });

  describe('subir y registrar (A2)', () => {
    it('PNG, WebP y PDF: el abono nace con comprobante, sin datos del paciente en el nombre del objeto', async () => {
      for (const [bytes, declared, ext] of [
        [
          pngFixture(),
          { name: 'Pérez María.png', mimeType: 'image/png' },
          'png',
        ],
        [
          webpFixture(),
          { name: 'captura.webp', mimeType: 'image/webp' },
          'webp',
        ],
        [
          pdfFixture(),
          { name: 'pago.pdf', mimeType: 'application/pdf' },
          'pdf',
        ],
      ] as const) {
        const ticket = await uploadFile(bytes, declared);
        const res = await pay({
          paymentMethodId: optional,
          proofUploadId: ticket.uploadId,
        }).expect(201);
        const payment = res.body as PaymentBody;
        expect(payment.hasProof).toBe(true);
        const row = await raw.paymentProof.findFirstOrThrow({
          where: { paymentId: payment.id },
        });
        expect(row).toMatchObject({
          tenantId: a.tenantId,
          mime: declared.mimeType,
          size: bytes.length,
          sha256: hex(bytes),
          name: declared.name,
        });
        expect(row.key).toMatch(
          new RegExp(
            `^payment-proofs/${a.tenantId}/[0-9a-f-]{36}-[0-9a-f]{16}\\.${ext}$`,
          ),
        );
        expect(row.key).not.toMatch(/rez|aria|Comprobante/i);
        // El pendiente se descarta cuando el abono existe.
        const pending = path.join(
          STORAGE_ROOT,
          'payment-proofs',
          'pending',
          a.tenantId,
          ticket.uploadId,
        );
        await expect(fs.stat(pending)).rejects.toThrow();
      }
    });

    it('un abono sin comprobante con un medio OPTIONAL es válido (hasProof false)', async () => {
      const res = await pay({ paymentMethodId: optional }).expect(201);
      expect((res.body as PaymentBody).hasProof).toBe(false);
    });

    it('REQUIRED sin comprobante: 400 en español y no se registra el abono', async () => {
      const before = await raw.payment.count({
        where: { tenantId: a.tenantId },
      });
      const res = await pay({ paymentMethodId: required }).expect(400);
      expect(messageOf(res)).toBe(
        'Este medio de pago exige el comprobante del cobro. Adjúntalo para registrar el abono.',
      );
      expect(await raw.payment.count({ where: { tenantId: a.tenantId } })).toBe(
        before,
      );
    });

    it('REQUIRED con comprobante lo registra', async () => {
      const ticket = await uploadFile(pngFixture(), {
        name: 'a.png',
        mimeType: 'image/png',
      });
      await pay({
        paymentMethodId: required,
        proofUploadId: ticket.uploadId,
      }).expect(201);
    });

    it('un medio NONE no admite comprobante (400)', async () => {
      const ticket = await uploadFile(pngFixture(), {
        name: 'a.png',
        mimeType: 'image/png',
      });
      const res = await pay({
        paymentMethodId: none,
        proofUploadId: ticket.uploadId,
      }).expect(400);
      expect(messageOf(res)).toBe('Este medio de pago no admite comprobante.');
    });

    it('el cobro dividido pide el comprobante de cada línea REQUIRED', async () => {
      const lines = (proofUploadId?: string) => ({
        paidAt: TODAY,
        lines: [
          { amount: 500, currency: 'VES', paymentMethodId: none },
          {
            amount: 700,
            currency: 'VES',
            paymentMethodId: required,
            ...(proofUploadId ? { proofUploadId } : {}),
          },
        ],
      });
      const url = `/treatment-plans/${planA}/split-payments`;
      const res = await callA('post', url).send(lines()).expect(400);
      expect(messageOf(res)).toContain('exige el comprobante');
      const ticket = await uploadFile(pngFixture(), {
        name: 'l2.png',
        mimeType: 'image/png',
      });
      const ok = await callA('post', url)
        .send(lines(ticket.uploadId))
        .expect(201);
      const payments = (ok.body as { payments: PaymentBody[] }).payments;
      expect(payments.map((p) => p.hasProof)).toEqual([false, true]);
    });
  });

  describe('tipo y tamaño (A2)', () => {
    it.each([
      ['HEIC declarado', { name: 'f.heic', mimeType: 'image/heic' }],
      ['SVG declarado', { name: 'f.svg', mimeType: 'image/svg+xml' }],
    ])('%s: 400 al pedir la subida', async (_n, declared) => {
      const bytes = pngFixture();
      const res = await callA('post', '/payments/proofs/upload-url')
        .send({ ...declared, size: bytes.length, sha256: hex(bytes) })
        .expect(400);
      expect(messageOf(res)).toBe(
        'El comprobante debe ser una imagen JPG, PNG o WebP, o un PDF.',
      );
    });

    it('más de 10 MB: 400 en español', async () => {
      const res = await callA('post', '/payments/proofs/upload-url')
        .send({
          name: 'grande.png',
          mimeType: 'image/png',
          size: 10 * 1024 * 1024 + 1,
          sha256: 'a'.repeat(64),
        })
        .expect(400);
      expect(messageOf(res)).toBe('El comprobante supera el máximo de 10 MB.');
    });

    it('un HTML disfrazado de PNG se rechaza por su contenido: 400, sin abono y sin objeto', async () => {
      const before = await raw.payment.count({
        where: { tenantId: a.tenantId },
      });
      const ticket = await uploadFile(htmlFake(), {
        name: 'captura.png',
        mimeType: 'image/png',
      });
      const res = await pay({
        paymentMethodId: optional,
        proofUploadId: ticket.uploadId,
      }).expect(400);
      expect(res.body).toMatchObject({
        code: 'PAYMENT_PROOF_REJECTED',
        message:
          'El comprobante debe ser una imagen JPG, PNG o WebP, o un PDF.',
      });
      expect(await raw.payment.count({ where: { tenantId: a.tenantId } })).toBe(
        before,
      );
      const pending = path.join(
        STORAGE_ROOT,
        'payment-proofs',
        'pending',
        a.tenantId,
        ticket.uploadId,
      );
      await expect(fs.stat(pending)).rejects.toThrow();
    });
  });

  describe('ver y descargar (A3)', () => {
    let paymentId: string;
    const bytes = pngFixture();

    beforeAll(async () => {
      const ticket = await uploadFile(bytes, {
        name: 'Zelle Pérez.png',
        mimeType: 'image/png',
      });
      paymentId = (
        (
          await pay({
            paymentMethodId: optional,
            proofUploadId: ticket.uploadId,
          }).expect(201)
        ).body as PaymentBody
      ).id;
    });

    it('ADMIN y RECEPTION reciben una URL firmada de 5 minutos; el contenido es el subido', async () => {
      for (const role of [ClinicRole.RECEPTION, ClinicRole.ADMIN]) {
        const res = await callA(
          'get',
          `/payments/${paymentId}/proof/url`,
          role,
        ).expect(200);
        expect(res.headers['cache-control']).toBe('no-store');
        const body = res.body as {
          url: string;
          expiresAt: string;
          disposition: string;
          mime: string;
        };
        expect(body).toMatchObject({
          disposition: 'inline',
          mime: 'image/png',
        });
        expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(
          300_000,
        );
        const file = await fetchSigned(body.url).expect(200);
        expect(file.headers['content-type']).toContain('image/png');
        expect((file.body as Buffer).equals(bytes)).toBe(true);
      }
    });

    it('DENTIST y ASSISTANT: 403 al ver y al pedir la subida', async () => {
      for (const role of [ClinicRole.DENTIST, ClinicRole.ASSISTANT]) {
        await callA('get', `/payments/${paymentId}/proof/url`, role).expect(
          403,
        );
        await callA('post', '/payments/proofs/upload-url', role)
          .send({
            name: 'a.png',
            mimeType: 'image/png',
            size: bytes.length,
            sha256: hex(bytes),
          })
          .expect(403);
      }
    });

    it('la descarga queda auditada (VIEW inline, EXPORT attachment) sin el nombre del paciente', async () => {
      await callA('get', `/payments/${paymentId}/proof/url`).expect(200);
      await callA(
        'get',
        `/payments/${paymentId}/proof/url?disposition=attachment`,
      ).expect(200);
      await callA(
        'get',
        `/payments/${paymentId}/proof/url?disposition=otro`,
      ).expect(400);
      const events = (
        await raw.auditEvent.findMany({
          where: { resourceType: 'PAYMENT', resourceId: paymentId },
          orderBy: { occurredAt: 'asc' },
        })
      ).filter((e) => JSON.stringify(e.metadata).includes('PAYMENT_PROOF_'));
      expect(events.slice(-2).map((e) => [e.action, e.metadata])).toEqual([
        ['VIEW', { reason: 'PAYMENT_PROOF_VIEW' }],
        ['EXPORT', { reason: 'PAYMENT_PROOF_DOWNLOAD' }],
      ]);
      for (const e of events) {
        expect(JSON.stringify(e.metadata)).not.toMatch(
          /María|Comprobante|Pérez/,
        );
      }
    });

    it('un abono sin comprobante: 404', async () => {
      const bare = (
        (await pay({ paymentMethodId: optional }).expect(201))
          .body as PaymentBody
      ).id;
      await callA('get', `/payments/${bare}/proof/url`).expect(404);
    });

    it('otra clínica: 404 al ver el comprobante, y su subida no sirve en la nuestra', async () => {
      await as(
        api().get(`/api/v1/payments/${paymentId}/proof/url`),
        b,
        tokenB,
      ).expect(404);
      // La subida de la clínica B (otro tenant) no existe para A.
      const foreign = await uploadFile(
        pngFixture(),
        { name: 'b.png', mimeType: 'image/png' },
        b,
        tokenB,
      );
      await pay({
        paymentMethodId: optional,
        proofUploadId: foreign.uploadId,
      }).expect(404);
      // Y la de A no sirve en B.
      const mine = await uploadFile(pngFixture(), {
        name: 'a.png',
        mimeType: 'image/png',
      });
      const planB = await seedPlan(b, 'B');
      await as(
        api().post(`/api/v1/treatment-plans/${planB}/payments`),
        b,
        tokenB,
      )
        .send({
          amount: 1000,
          currency: 'VES',
          paidAt: TODAY,
          paymentMethodId: cashB,
          proofUploadId: mine.uploadId,
        })
        .expect(404);
    });

    it('la fila es append-only para la app (no se cambia ni se borra)', async () => {
      const row = await raw.paymentProof.findFirstOrThrow({
        where: { paymentId },
      });
      const app_ = new PrismaClient<Prisma.PrismaClientOptions>({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });
      try {
        await expect(
          app_.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
            await tx.paymentProof.update({
              where: { id: row.id },
              data: { key: 'payment-proofs/x/y.png' },
            });
          }),
        ).rejects.toThrow();
        await expect(
          app_.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
            await tx.paymentProof.delete({ where: { id: row.id } });
          }),
        ).rejects.toThrow();
      } finally {
        await app_.$disconnect();
      }
    });
  });
});
