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
import { civilDateIn } from '../src/shared/time/civil-day';

// DX-377 en HTTP real: cada clínica nace con sus 4 medios iniciales; solo el
// ADMIN gestiona el catálogo (403 en español para recepción); un medio que
// pide referencia la exige (400); la misma referencia y medio en la clínica
// dentro de ±90 días da 409 `PAYMENT_REFERENCE_DUPLICATE` y se confirma con
// motivo (auditado); otra clínica con la misma referencia no avisa; un medio
// de otra clínica no se acepta; la caja y el recibo muestran medio y
// referencia y el resumen totaliza por medio y moneda.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const ZONE = 'America/Bogota';
const TODAY = civilDateIn(new Date(), ZONE);

interface MethodBody {
  id: string;
  name: string;
  kind: string;
  active: boolean;
  requiresReference: boolean;
  legacyMethod: string | null;
}

interface PaymentBody {
  id: string;
  method: string | null;
  paymentMethodId: string | null;
  paymentMethodName: string | null;
  reference: string | null;
  duplicateReferenceReason: string | null;
}

describe('Medios de pago y referencia repetida (e2e, DX-377)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let receptionA: string;
  const plans = new Map<string, string>();
  const mobile = new Map<string, string>();

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic, token = clinic.adminToken) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const pay = (clinic: Clinic, body: Record<string, unknown>) =>
    as(
      api().post(
        `/api/v1/treatment-plans/${plans.get(clinic.tenantId)}/payments`,
      ),
      clinic,
    ).send({ amount: 10, currency: 'USD', paidAt: TODAY, ...body });

  async function seedPlan(clinic: Clinic, tag: string): Promise<void> {
    const patient = (
      await as(api().post('/api/v1/patients'), clinic)
        .send({
          firstName: 'Ana',
          lastName: 'Referencia',
          docType: 'NATIONAL_ID',
          docNumber: `DX377-${tag}`,
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    const item = (
      await as(api().post('/api/v1/catalog/items'), clinic)
        .send({
          code: `DX377-${tag}`,
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 1000,
        })
        .expect(201)
    ).body as { id: string };
    const planId = (
      (
        await as(
          api().post(`/api/v1/patients/${patient.id}/treatment-plans`),
          clinic,
        )
          .send({ notes: 'Plan DX-377', currency: 'USD' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const planItem = (
      await as(api().post(`/api/v1/treatment-plans/${planId}/items`), clinic)
        .send({ toothNumber: '11', catalogItemId: item.id })
        .expect(201)
    ).body as { id: string };
    await as(
      api().patch(`/api/v1/treatment-plans/${planId}/items/${planItem.id}`),
      clinic,
    )
      .send({ status: 'DONE' })
      .expect(200);
    plans.set(clinic.tenantId, planId);
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx377-a');
    b = await registerClinic(app, 'dx377-b');
    const member = await seedMember(raw, a, ClinicRole.RECEPTION);
    receptionA = await loginAs(app, a.host, member.email);
    await seedPlan(a, 'A');
    await seedPlan(b, 'B');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('la clínica nace con los 4 medios iniciales, uno por método antiguo', async () => {
    const res = await as(api().get('/api/v1/payment-methods'), a).expect(200);
    const body = res.body as MethodBody[];
    expect(body.map((m) => [m.name, m.kind, m.legacyMethod])).toEqual([
      ['Efectivo', 'CASH', 'CASH'],
      ['Otro', 'OTHER', 'OTHER'],
      ['Tarjeta', 'CARD', 'CARD'],
      ['Transferencia', 'TRANSFER', 'TRANSFER'],
    ]);
  });

  it('recepción lee el catálogo pero no lo escribe (403 en español)', async () => {
    await as(api().get('/api/v1/payment-methods'), a, receptionA).expect(200);
    const res = await as(api().post('/api/v1/payment-methods'), a, receptionA)
      .send({ name: 'Pago móvil', kind: 'DIGITAL' })
      .expect(403);
    expect((res.body as { message: string }).message).toBe(
      'Solo un administrador puede gestionar los medios de pago.',
    );
  });

  it('el ADMIN crea un medio digital que pide referencia; nombre repetido es 409', async () => {
    for (const clinic of [a, b]) {
      const res = await as(api().post('/api/v1/payment-methods'), clinic)
        .send({ name: 'Pago móvil', kind: 'DIGITAL', requiresReference: true })
        .expect(201);
      mobile.set(clinic.tenantId, (res.body as MethodBody).id);
    }
    await as(api().post('/api/v1/payment-methods'), a)
      .send({ name: 'pago MÓVIL', kind: 'OTHER' })
      .expect(409);
  });

  it('otra clínica no edita el medio de A (404)', async () => {
    await as(
      api().patch(`/api/v1/payment-methods/${mobile.get(a.tenantId)}`),
      b,
    )
      .send({ active: false })
      .expect(404);
  });

  it('sin referencia, un medio que la pide responde 400 en español', async () => {
    const res = await pay(a, {
      paymentMethodId: mobile.get(a.tenantId),
    }).expect(400);
    expect((res.body as { message: string }).message).toBe(
      'Este medio de pago pide la referencia del pago.',
    );
  });

  it('un medio de otra clínica no se acepta', async () => {
    await pay(a, {
      paymentMethodId: mobile.get(b.tenantId),
      reference: '123',
    }).expect(400);
  });

  let first: PaymentBody;

  it('con referencia, guarda medio y referencia y deriva el método (DIGITAL → TRANSFER)', async () => {
    first = (
      await pay(a, {
        paymentMethodId: mobile.get(a.tenantId),
        reference: ' 0412 5551234 ',
      }).expect(201)
    ).body as PaymentBody;
    expect(first).toMatchObject({
      method: 'TRANSFER',
      paymentMethodId: mobile.get(a.tenantId),
      paymentMethodName: 'Pago móvil',
      reference: '0412 5551234',
      duplicateReferenceReason: null,
    });
  });

  it('la misma referencia (normalizada) en otra clínica no avisa', async () => {
    await pay(b, {
      paymentMethodId: mobile.get(b.tenantId),
      reference: '04125551234',
    }).expect(201);
  });

  it('repetida en la clínica: 409 con código estable; con motivo se registra y se audita', async () => {
    const conflict = await pay(a, {
      paymentMethodId: mobile.get(a.tenantId),
      reference: '04125551234',
    }).expect(409);
    expect(conflict.body).toMatchObject({
      code: 'PAYMENT_REFERENCE_DUPLICATE',
      matches: [expect.objectContaining({ id: first.id, currency: 'USD' })],
    });

    const confirmed = (
      await pay(a, {
        paymentMethodId: mobile.get(a.tenantId),
        reference: '04125551234',
        duplicateReferenceReason:
          'El paciente pagó dos cuotas con la misma operación',
      }).expect(201)
    ).body as PaymentBody;
    expect(confirmed.duplicateReferenceReason).toBe(
      'El paciente pagó dos cuotas con la misma operación',
    );

    const audit = await raw.auditEvent.findFirst({
      where: {
        tenantId: a.tenantId,
        resourceType: 'PAYMENT',
        resourceId: confirmed.id,
        action: 'CREATE',
      },
    });
    expect(audit?.metadata).toMatchObject({
      paymentReference: { duplicateConfirmed: true, duplicateOf: [first.id] },
    });
    // Ni la referencia ni el motivo en la auditoría.
    expect(JSON.stringify(audit?.metadata)).not.toContain('0412');
    expect(JSON.stringify(audit?.metadata)).not.toContain('cuotas');
  });

  it('un abono anulado ya no cuenta como repetido', async () => {
    await pay(a, {
      paymentMethodId: mobile.get(a.tenantId),
      reference: 'ANUL-1',
    }).expect(201);
    const [voidable] = await raw.payment.findMany({
      where: { tenantId: a.tenantId, referenceNormalized: 'ANUL-1' },
    });
    await as(api().delete(`/api/v1/payments/${voidable.id}`), a)
      .send({ reason: 'Registrado por error' })
      .expect(200);
    await pay(a, {
      paymentMethodId: mobile.get(a.tenantId),
      reference: 'anul-1',
    }).expect(201);
  });

  it('solo `method` (cliente anterior): se enlaza al medio inicial', async () => {
    const body = (await pay(a, { method: 'CASH' }).expect(201))
      .body as PaymentBody;
    expect(body).toMatchObject({
      method: 'CASH',
      paymentMethodName: 'Efectivo',
    });
  });

  it('la caja muestra medio y referencia y totaliza por medio y moneda', async () => {
    const res = await as(
      api().get(`/api/v1/payments?from=${TODAY}&to=${TODAY}`),
      a,
    ).expect(200);
    const body = res.body as {
      items: {
        id: string;
        paymentMethod: { name: string } | null;
        reference: string | null;
      }[];
      summary: {
        byPaymentMethod: {
          name: string | null;
          currency: string;
          total: number;
          count: number;
        }[];
      };
    };
    expect(body.items.find((i) => i.id === first.id)).toMatchObject({
      paymentMethod: { name: 'Pago móvil' },
      reference: '0412 5551234',
    });
    expect(body.summary.byPaymentMethod).toEqual([
      {
        paymentMethodId: expect.any(String) as string,
        name: 'Efectivo',
        currency: 'USD',
        total: 10,
        count: 1,
      },
      {
        paymentMethodId: mobile.get(a.tenantId),
        name: 'Pago móvil',
        currency: 'USD',
        total: 30,
        count: 3,
      },
    ]);
  });

  it('el recibo lleva el medio y la referencia', async () => {
    const res = await as(
      api().get(`/api/v1/payments/${first.id}/receipt`),
      a,
    ).expect(200);
    expect(JSON.stringify(res.body)).toContain(
      '"paymentMethodName":"Pago móvil"',
    );
    expect(JSON.stringify(res.body)).toContain('"reference":"0412 5551234"');
  });
});
