import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { Clinic, registerClinic, resetDatabase } from './support/e2e-fixtures';

// DX-521 (R3, PF3, PF8) en HTTP real: el recibo sirve la región que congeló al
// emitir aunque la sede cambie de zona y de locale; el de antes de DX-521 (foto
// sin `regional`) sirve la de hoy de la sede, sin reescribir la fila, y el
// `regional` nunca viaja dentro de `snapshot`. DIRECT_URL (superusuario, sin
// RLS) solo ajusta la sede y lee/edita la fila, como en la integración.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// Datos de test (no valores por defecto del producto).
const LONDON = {
  timeZone: 'Europe/London',
  locale: 'en-GB',
  hourCycle: 'h23',
};
const CARACAS = {
  timeZone: 'America/Caracas',
  locale: 'es-VE',
  hourCycle: 'h23',
};

interface ReceiptBody {
  regional: typeof LONDON | null;
  snapshot: Record<string, unknown>;
}

describe('Región del recibo (e2e, DX-521)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let locationId: string;
  let planId: string;

  const as = (req: request.Test) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);
  const api = () => request(app.getHttpServer());

  const setLocation = (r: typeof LONDON) =>
    raw.location.update({ where: { id: locationId }, data: r });

  async function pay(): Promise<string> {
    const res = await as(
      api().post(`/api/v1/treatment-plans/${planId}/payments`),
    )
      .send({
        amount: 100,
        currency: 'USD',
        paidAt: new Date().toISOString(),
        method: 'CASH',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function receiptOf(paymentId: string): Promise<ReceiptBody> {
    const res = await as(
      api().get(`/api/v1/payments/${paymentId}/receipt`),
    ).expect(200);
    return res.body as ReceiptBody;
  }

  const snapshotText = async (paymentId: string): Promise<string> =>
    (
      await raw.$queryRaw<{ s: string }[]>(
        Prisma.sql`SELECT "snapshot"::text AS s FROM "payment_receipts"
                    WHERE "paymentId" = ${paymentId}::uuid`,
      )
    )[0].s;

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    clinic = await registerClinic(app, 'dx521-regional');
    locationId = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        select: { id: true },
      })
    ).id;
    await setLocation(LONDON);
    const patient = await as(api().post('/api/v1/patients'))
      .send({
        firstName: 'Carolina',
        lastName: 'Duque',
        docType: 'NATIONAL_ID',
        docNumber: '1012345678',
        sex: 'F',
      })
      .expect(201);
    const patientId = (patient.body as { id: string }).id;
    const plan = await as(
      api().post(`/api/v1/patients/${patientId}/treatment-plans`),
    )
      .send({ currency: 'USD' })
      .expect(201);
    planId = (plan.body as { id: string }).id;
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('cambiar la zona y el locale de la sede no cambia el `regional` que sirve un recibo emitido', async () => {
    const id = await pay();
    const before = await snapshotText(id);
    expect((await receiptOf(id)).regional).toEqual(LONDON);

    await setLocation(CARACAS);
    try {
      const after = await receiptOf(id);
      expect(after.regional).toEqual(LONDON);
      expect('regional' in after.snapshot).toBe(false);
      expect(await snapshotText(id)).toBe(before);
    } finally {
      await setLocation(LONDON);
    }
  });

  it('un recibo cuya foto no tiene `regional` sirve el de la sede en su estado actual y no reescribe la fila', async () => {
    const id = await pay();
    // La foto de antes de DX-521: sin la clave (no hay migración de datos).
    // Solo el superusuario, saltando el trigger de inmutabilidad.
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw(
        Prisma.sql`UPDATE "payment_receipts" SET "snapshot" = "snapshot" - 'regional'
                    WHERE "paymentId" = ${id}::uuid`,
      );
    });
    const before = await snapshotText(id);
    expect(before).not.toContain('"regional"');

    await setLocation(CARACAS);
    try {
      const view = await receiptOf(id);
      expect(view.regional).toEqual(CARACAS);
      expect('regional' in view.snapshot).toBe(false);
      expect(await snapshotText(id)).toBe(before);
    } finally {
      await setLocation(LONDON);
    }
  });
});
