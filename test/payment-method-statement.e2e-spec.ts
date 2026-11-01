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
import { civilDateIn, zonedStartOfDay } from '../src/shared/time/civil-day';
import { sedeTodayFixture } from './support/sede-clock';

// DX-395 en HTTP real: el estado de cuenta nombra el medio de la clínica y la
// referencia de cada abono (también el de una réplica anterior sin medio); la
// caja y su CSV filtran por cualquier medio de la clínica (un medio ajeno es
// 400); «123-456», «123.456» y «123 456» son la misma referencia; referencia y
// motivo demasiado largos dan 400 en español.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// DX-495 (TST-062): la clínica usa la zona segura de DX-449 (Bogotá lejos de
// su medianoche; si no, una zona en la que ahora es cerca del mediodía): el
// «hoy» de los abonos y el de la API no se separan si la corrida cruza la
// medianoche de Bogotá.
const SEDE = sedeTodayFixture();
const TODAY = civilDateIn(new Date(), SEDE.timeZone);

interface MethodBody {
  id: string;
  name: string;
  legacyMethod: string | null;
}

interface MovementBody {
  id: string;
  method: string | null;
  paymentMethod: { id: string; name: string } | null;
  reference: string | null;
}

interface CashBody {
  items: {
    id: string;
    paymentMethod: { id: string; name: string } | null;
    reference: string | null;
  }[];
  total: number;
  summary: { count: number };
}

interface Seeded {
  patientId: string;
  planId: string;
}

describe('Medio y referencia en estado de cuenta y caja (e2e, DX-395)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let receptionA: string;
  let dentistA: string;
  const seeded = new Map<string, Seeded>();
  const mobile = new Map<string, string>();
  const cash = new Map<string, string>();
  const ids: Record<string, string> = {};

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic, token = clinic.adminToken) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const pay = (
    clinic: Clinic,
    body: Record<string, unknown>,
    token = clinic.adminToken,
  ) =>
    as(
      api().post(
        `/api/v1/treatment-plans/${seeded.get(clinic.tenantId)!.planId}/payments`,
      ),
      clinic,
      token,
    ).send({ amount: 10, currency: 'USD', paidAt: TODAY, ...body });
  const statementOf = async (clinic: Clinic, token = clinic.adminToken) =>
    (
      await as(
        api().get(
          `/api/v1/patients/${seeded.get(clinic.tenantId)!.patientId}/account-statement`,
        ),
        clinic,
        token,
      ).expect(200)
    ).body as { movements: MovementBody[] };
  const cashOf = (clinic: Clinic, query = '') =>
    as(api().get(`/api/v1/payments?from=${TODAY}&to=${TODAY}${query}`), clinic);

  async function seedPlan(clinic: Clinic, tag: string): Promise<void> {
    const patient = (
      await as(api().post('/api/v1/patients'), clinic)
        .send({
          firstName: 'Ana',
          lastName: 'Estado',
          docType: 'NATIONAL_ID',
          docNumber: `DX395-${tag}`,
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    const item = (
      await as(api().post('/api/v1/catalog/items'), clinic)
        .send({
          code: `DX395-${tag}`,
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
          .send({ notes: 'Plan DX-395', currency: 'USD' })
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
    seeded.set(clinic.tenantId, { patientId: patient.id, planId });
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx395-a', SEDE);
    b = await registerClinic(app, 'dx395-b', SEDE);
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
    for (const [clinic, tag] of [
      [a, 'A'],
      [b, 'B'],
    ] as const) {
      await seedPlan(clinic, tag);
      const created = await as(api().post('/api/v1/payment-methods'), clinic)
        .send({ name: 'Pago móvil', kind: 'DIGITAL', requiresReference: true })
        .expect(201);
      mobile.set(clinic.tenantId, (created.body as MethodBody).id);
      const list = await as(
        api().get('/api/v1/payment-methods'),
        clinic,
      ).expect(200);
      cash.set(
        clinic.tenantId,
        (list.body as MethodBody[]).find((m) => m.legacyMethod === 'CASH')!.id,
      );
    }
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('el estado de cuenta muestra «Pago móvil» y la referencia del abono (no «Transferencia»)', async () => {
    const created = await pay(
      a,
      { paymentMethodId: mobile.get(a.tenantId), reference: 'ABC 123' },
      receptionA,
    ).expect(201);
    ids.mobile = (created.body as { id: string }).id;

    const { movements } = await statementOf(a, receptionA);
    expect(movements.find((m) => m.id === ids.mobile)).toEqual(
      expect.objectContaining({
        method: 'TRANSFER',
        paymentMethod: { id: mobile.get(a.tenantId), name: 'Pago móvil' },
        reference: 'ABC 123',
      }),
    );
  });

  it('un abono de una réplica anterior (sin medio) sale con el medio inicial de su método', async () => {
    const plan = seeded.get(a.tenantId)!;
    const location = await raw.location.findFirstOrThrow({
      where: { tenantId: a.tenantId, deletedAt: null },
      select: { id: true },
    });
    const legacy = await raw.payment.create({
      data: {
        tenantId: a.tenantId,
        locationId: location.id,
        treatmentPlanId: plan.planId,
        patientId: plan.patientId,
        amount: 5,
        currency: 'USD',
        // Mediodía de hoy en la sede.
        paidAt: new Date(
          zonedStartOfDay(TODAY, SEDE.timeZone).getTime() + 12 * 60 * 60_000,
        ),
        method: 'CASH',
      },
    });
    ids.legacy = legacy.id;

    const { movements } = await statementOf(a);
    expect(movements.find((m) => m.id === legacy.id)).toEqual(
      expect.objectContaining({
        method: 'CASH',
        paymentMethod: { id: cash.get(a.tenantId), name: 'Efectivo' },
        reference: null,
      }),
    );
  });

  it('solo los roles de cobro ven el estado de cuenta (y su referencia): el odontólogo recibe 403', async () => {
    await as(
      api().get(
        `/api/v1/patients/${seeded.get(a.tenantId)!.patientId}/account-statement`,
      ),
      a,
      dentistA,
    ).expect(403);
  });

  it.each(['123.456', '123 456', '123–456'])(
    '«123-456» y «%s» son la misma referencia: 409 de repetida',
    async (again) => {
      if (!ids.dashed) {
        ids.dashed = (
          (
            await pay(a, {
              paymentMethodId: mobile.get(a.tenantId),
              reference: '123-456',
            }).expect(201)
          ).body as { id: string }
        ).id;
      }
      const conflict = await pay(a, {
        paymentMethodId: mobile.get(a.tenantId),
        reference: again,
      }).expect(409);
      expect(conflict.body).toMatchObject({
        code: 'PAYMENT_REFERENCE_DUPLICATE',
        matches: [expect.objectContaining({ id: ids.dashed })],
      });
    },
  );

  it('una referencia de más de 60 caracteres: 400 en español', async () => {
    const res = await pay(a, {
      paymentMethodId: mobile.get(a.tenantId),
      reference: '9'.repeat(61),
    }).expect(400);
    expect((res.body as { message: string[] }).message).toEqual([
      'La referencia admite como mucho 60 caracteres.',
    ]);
  });

  it('un motivo de más de 300 caracteres: 400 en español', async () => {
    const res = await pay(a, {
      paymentMethodId: mobile.get(a.tenantId),
      reference: '123456',
      duplicateReferenceReason: 'm'.repeat(301),
    }).expect(400);
    expect((res.body as { message: string[] }).message).toEqual([
      'El motivo admite como mucho 300 caracteres.',
    ]);
  });

  it('la caja filtra por un medio propio de la clínica', async () => {
    const res = await cashOf(
      a,
      `&paymentMethodId=${mobile.get(a.tenantId)}`,
    ).expect(200);
    const body = res.body as CashBody;
    expect(body.items.map((i) => i.id).sort()).toEqual(
      [ids.mobile, ids.dashed].sort(),
    );
    expect(body.summary.count).toBe(2);
    expect(
      body.items.every((i) => i.paymentMethod?.name === 'Pago móvil'),
    ).toBe(true);
  });

  it('un medio inicial incluye los abonos sin medio de su método (réplicas anteriores)', async () => {
    const res = await cashOf(
      a,
      `&paymentMethodId=${cash.get(a.tenantId)}`,
    ).expect(200);
    const body = res.body as CashBody;
    expect(body.items.map((i) => i.id)).toEqual([ids.legacy]);
    expect(body.items[0].paymentMethod?.name).toBe('Efectivo');
  });

  it('un medio de otra clínica no filtra: 400 en español, también en el CSV', async () => {
    const res = await cashOf(
      a,
      `&paymentMethodId=${mobile.get(b.tenantId)}`,
    ).expect(400);
    expect((res.body as { message: string }).message).toBe(
      'Medio de pago no encontrado en esta clínica.',
    );
    await as(
      api().get(
        `/api/v1/payments.csv?from=${TODAY}&to=${TODAY}&paymentMethodId=${mobile.get(b.tenantId)}`,
      ),
      a,
    ).expect(400);
    await cashOf(a, '&paymentMethodId=no-es-uuid').expect(400);
  });

  it('el CSV de la caja lleva medio y referencia, con el filtro por medio', async () => {
    const res = await as(
      api().get(
        `/api/v1/payments.csv?from=${TODAY}&to=${TODAY}&paymentMethodId=${mobile.get(a.tenantId)}`,
      ),
      a,
      receptionA,
    ).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="caja-${TODAY}-${TODAY}.csv"`,
    );
    const lines = res.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      'Fecha,Sede,Paciente,Destino,Medio,Referencia,Moneda,Importe',
    );
    expect(lines).toHaveLength(3);
    expect(res.text).toContain('"Pago móvil","ABC 123",USD,10.00');
    expect(res.text).toContain('"Pago móvil","123-456",USD,10.00');

    const audit = await raw.auditEvent.findFirst({
      where: {
        tenantId: a.tenantId,
        action: 'EXPORT',
        resourceType: 'PAYMENT',
      },
    });
    expect(audit).not.toBeNull();
  });

  it('el CSV de la caja solo es para roles de cobro', async () => {
    await as(
      api().get(`/api/v1/payments.csv?from=${TODAY}&to=${TODAY}`),
      a,
      dentistA,
    ).expect(403);
  });

  it('la otra clínica no ve los abonos de A en su caja ni en su CSV', async () => {
    const res = await cashOf(b).expect(200);
    expect((res.body as CashBody).total).toBe(0);
    const csv = await as(
      api().get(`/api/v1/payments.csv?from=${TODAY}&to=${TODAY}`),
      b,
    ).expect(200);
    expect(csv.text).not.toContain('ABC 123');
  });
});
