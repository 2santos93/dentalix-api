import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  CatalogKind,
  ClinicRole,
  DocType,
  PrismaClient,
  Sex,
} from '@prisma/client';
import { PasswordService } from '../src/shared/crypto/password.service';
import { createE2eApp } from './support/create-e2e-app';
import { hostFor } from './support/tenant-host';

// DX-042, por HTTP: topes de importes y cantidades en las DTO (400, nunca 500
// ni redondeo), insumo único por sede y sin mayúsculas, y las tres carreras
// cerradas en una transacción (espejo DONE → odontograma, último ADMIN,
// idempotencia del abono). La app se monta como en main.ts (prefijo, pipe y
// PrismaExceptionFilter global).
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const passwordService = new PasswordService();
const PASSWORD = 'S3cret!!';
const SUBDOMAIN = 'dx042-e2e';
const HOST = hostFor(SUBDOMAIN);
const ADMIN_EMAIL = 'admin@dx042-e2e.test';

interface IdBody {
  id: string;
}

describe('Reglas de dominio por HTTP (DX-042, e2e)', () => {
  let app: INestApplication<App>;
  let tenantId: string;
  let token: string;
  let patientId: string;
  let planId: string;
  let catalogItemId: string;

  const api = () => request(app.getHttpServer());
  const authed = (req: request.Test, accessToken = token): request.Test =>
    req
      .set('X-Tenant-Host', HOST)
      .set('Authorization', `Bearer ${accessToken}`);

  async function login(email: string): Promise<string> {
    const res = await api()
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', HOST)
      .send({ email, password: PASSWORD })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function seedAdmin(email: string): Promise<string> {
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await passwordService.hash(PASSWORD),
        fullName: email,
        emailVerifiedAt: new Date(),
      },
    });
    await raw.clinicMembership.create({
      data: { tenantId, userId: user.id, role: ClinicRole.ADMIN },
    });
    return user.id;
  }

  async function cleanup(): Promise<void> {
    const tenant = await raw.tenant.findFirst({
      where: { subdomain: SUBDOMAIN },
    });
    if (!tenant) return;
    const where = { tenantId: tenant.id };
    const members = await raw.clinicMembership.findMany({
      where,
      select: { userId: true },
    });
    await raw.inventoryMovement.deleteMany({ where });
    await raw.inventoryItem.deleteMany({ where });
    await raw.installment.deleteMany({ where });
    await raw.paymentPlan.deleteMany({ where });
    await raw.payment.deleteMany({ where });
    await raw.toothRecord.deleteMany({ where });
    await raw.treatmentPlanItem.deleteMany({ where });
    await raw.treatmentPlan.deleteMany({ where });
    await raw.dentalCatalogItem.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.locationScheduleRange.deleteMany({ where });
    await raw.locationSchedule.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.clinicMembership.deleteMany({ where });
    await raw.user.deleteMany({
      where: { id: { in: members.map((m) => m.userId) } },
    });
    await raw.tenant.delete({ where: { id: tenant.id } });
  }

  beforeAll(async () => {
    // Montada como main.ts: el filtro global (con el de Prisma) da los 409.
    app = await createE2eApp();
    await cleanup();

    const register = await api()
      .post('/api/v1/auth/register')
      .send({
        clinicName: 'DX-042',
        subdomain: SUBDOMAIN,
        email: ADMIN_EMAIL,
        password: PASSWORD,
        fullName: 'Dra. Admin',
      })
      .expect(201);
    tenantId = (register.body as { tenantId: string }).tenantId;
    token = await login(ADMIN_EMAIL);

    const patient = await authed(api().post('/api/v1/patients'))
      .send({
        firstName: 'Ana',
        lastName: 'Dominio',
        docType: DocType.CC,
        docNumber: '42042',
        sex: Sex.F,
      })
      .expect(201);
    patientId = (patient.body as IdBody).id;
    const plan = await authed(
      api().post(`/api/v1/patients/${patientId}/treatment-plans`),
    )
      .send({ currency: 'USD' })
      .expect(201);
    planId = (plan.body as IdBody).id;
    const catalog = await authed(api().post('/api/v1/catalog/items'))
      .send({
        code: 'DX042-RES',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Resina DX-042',
        color: '#2A2B3C',
        defaultPrice: 100,
      })
      .expect(201);
    catalogItemId = (catalog.body as IdBody).id;
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await app.close();
  });

  async function addItem(): Promise<string> {
    const res = await authed(
      api().post(`/api/v1/treatment-plans/${planId}/items`),
    )
      .send({ toothNumber: '16', catalogItemId, price: 120 })
      .expect(201);
    return (res.body as IdBody).id;
  }

  describe('topes de importes y cantidades (DB-010)', () => {
    const paidAt = '2026-10-01T00:00:00.000Z';

    it.each([
      ['13 dígitos enteros', 1_234_567_890_123],
      ['3 decimales', 10.005],
    ])(
      'POST de un abono con %s → 400 y nada escrito',
      async (_label, amount) => {
        const res = await authed(
          api().post(`/api/v1/treatment-plans/${planId}/payments`),
        )
          .send({ amount, currency: 'USD', paidAt })
          .expect(400);
        expect(JSON.stringify(res.body)).toContain('amount');
        expect(await raw.payment.count({ where: { tenantId } })).toBe(0);
      },
    );

    it('un abono con 2 decimales se guarda tal cual (sin redondeo)', async () => {
      const res = await authed(
        api().post(`/api/v1/treatment-plans/${planId}/payments`),
      )
        .send({ amount: 10.25, currency: 'USD', paidAt })
        .expect(201);
      expect((res.body as { amount: number }).amount).toBe(10.25);
    });

    it('precio de ítem de plan con 13 dígitos o 3 decimales → 400', async () => {
      await authed(api().post(`/api/v1/treatment-plans/${planId}/items`))
        .send({ toothNumber: '11', catalogItemId, price: 1_234_567_890_123 })
        .expect(400);
      const itemId = await addItem();
      await authed(
        api().patch(`/api/v1/treatment-plans/${planId}/items/${itemId}`),
      )
        .send({ price: 99.999 })
        .expect(400);
    });

    it('plan de pagos con 3 decimales → 400', async () => {
      await authed(api().post(`/api/v1/treatment-plans/${planId}/payment-plan`))
        .send({
          installmentsCount: 3,
          periodicity: 'MONTHLY',
          startDate: '2026-11-01T00:00:00.000Z',
          totalToFinance: 300.005,
        })
        .expect(400);
    });

    it('tarifa de catálogo con 13 dígitos → 400', async () => {
      await authed(api().post('/api/v1/catalog/items'))
        .send({
          code: 'DX042-BIG',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Enorme',
          color: '#000000',
          defaultPrice: 1_234_567_890_123,
        })
        .expect(400);
    });

    it('movimiento de inventario con 4 decimales → 400', async () => {
      const item = await authed(api().post('/api/v1/inventory/items'))
        .send({ name: 'Anestesia', unit: 'carpule' })
        .expect(201);
      await authed(
        api().post(
          `/api/v1/inventory/items/${(item.body as IdBody).id}/movements`,
        ),
      )
        .send({ type: 'IN', quantity: 1.0005 })
        .expect(400);
    });
  });

  describe('insumo único por sede (DB-011)', () => {
    let sedeNorte: string;

    beforeAll(async () => {
      const res = await authed(api().post('/api/v1/locations'))
        .send({ name: 'Sede Norte' })
        .expect(201);
      sedeNorte = (res.body as IdBody).id;
    });

    it('dos sedes pueden tener un insumo con el mismo nombre', async () => {
      await authed(api().post('/api/v1/inventory/items'))
        .send({ name: 'Guantes', unit: 'caja' })
        .expect(201);
      await authed(api().post('/api/v1/inventory/items'))
        .set('X-Location-Id', sedeNorte)
        .send({ name: 'Guantes', unit: 'caja' })
        .expect(201);
    });

    it('en la misma sede «Guantes» y «guantes» → 409 con mensaje propio', async () => {
      const res = await authed(api().post('/api/v1/inventory/items'))
        .set('X-Location-Id', sedeNorte)
        .send({ name: 'guantes', unit: 'caja' })
        .expect(409);
      expect(res.body).toEqual({
        statusCode: 409,
        error: 'Conflict',
        message: 'Ya existe un insumo con ese nombre en esta sede.',
      });
    });
  });

  it('dos PATCH status=DONE concurrentes dejan exactamente 1 tooth_record (DB-013)', async () => {
    const itemId = await addItem();
    const done = () =>
      authed(
        api().patch(`/api/v1/treatment-plans/${planId}/items/${itemId}`),
      ).send({ status: 'DONE' });

    const [a, b] = await Promise.all([done(), done()]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(
      await raw.toothRecord.count({ where: { sourcePlanItemId: itemId } }),
    ).toBe(1);
  });

  it('dos reintentos simultáneos con la misma Idempotency-Key devuelven el mismo abono (DB-014)', async () => {
    const key = randomUUID();
    const post = () =>
      authed(api().post(`/api/v1/treatment-plans/${planId}/payments`))
        .set('Idempotency-Key', key)
        .send({
          amount: 30,
          currency: 'USD',
          paidAt: '2026-10-02T00:00:00.000Z',
        });

    const [a, b] = await Promise.all([post(), post()]);

    expect([a.status, b.status]).toEqual([201, 201]);
    expect((a.body as IdBody).id).toBe((b.body as IdBody).id);
    expect(await raw.payment.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it('dos ADMIN que se degradan a la vez el uno al otro dejan al menos 1 ADMIN (DB-012)', async () => {
    // Solo dos ADMIN activos: el del registro se degrada antes a DENTIST.
    const a = await seedAdmin('admin-a@dx042-e2e.test');
    const b = await seedAdmin('admin-b@dx042-e2e.test');
    await raw.clinicMembership.updateMany({
      where: { tenantId, userId: { notIn: [a, b] } },
      data: { role: ClinicRole.DENTIST },
    });
    const [tokenA, tokenB] = await Promise.all([
      login('admin-a@dx042-e2e.test'),
      login('admin-b@dx042-e2e.test'),
    ]);

    const [ra, rb] = await Promise.all([
      authed(api().patch(`/api/v1/staff/${b}`), tokenA).send({
        role: ClinicRole.DENTIST,
      }),
      authed(api().patch(`/api/v1/staff/${a}`), tokenB).send({
        role: ClinicRole.DENTIST,
      }),
    ]);

    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect(
      await raw.clinicMembership.count({
        where: { tenantId, role: ClinicRole.ADMIN, deletedAt: null },
      }),
    ).toBe(1);
  });
});
