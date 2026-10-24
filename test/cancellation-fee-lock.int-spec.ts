import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  registerClinic,
  resetDatabase,
  type Clinic,
} from './support/e2e-fixtures';

// SEC-050 contra Postgres: la red de la BD bajo el cargo por inasistencia
// (DX-291). Mientras el cargo esté vigente, su ítem no cambia de precio,
// descuento ni estado ni se retira, y su plan no se cancela ni cambia de
// moneda, aunque se escriba SQL directo con el rol de la app. La anulación
// legítima pasa porque deja antes la anulación (autor y motivo) en la fila
// del cargo, en la misma transacción; esa fila solo admite anularse, una vez.
// DB-052: aunque la app tenga UPDATE/DELETE de más (un `GRANT … ON ALL
// TABLES` repetido), el trigger impide reescribir o borrar el cargo.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const HOUR = 3_600_000;
const LOCKED = /cargo por inasistencia o cancelación tardía vigente/;

/** SQL como dentalix_app con `app.current_tenant` fijado (como la app). */
function asApp<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return appRole.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}

describe('cargo por inasistencia protegido en la BD (SEC-050, int)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let location: string;
  let policy: string;
  let seq = 0;

  async function charged(): Promise<{
    appointmentId: string;
    feeId: string;
    itemId: string;
    planId: string;
  }> {
    const patientId = (
      await raw.patient.create({
        data: { tenantId: a.tenantId, firstName: 'Ana', lastName: `S${++seq}` },
      })
    ).id;
    const start = new Date(Date.now() - (seq * 2 + 24) * HOUR);
    const appointmentId = (
      await raw.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: location,
          patientId,
          providerId: randomUUID(),
          start,
          end: new Date(start.getTime() + 30 * 60_000),
          status: 'NO_SHOW',
          noShowMarkedAt: new Date(),
          policyVersionId: policy,
        },
      })
    ).id;
    await request(app.getHttpServer())
      .post(`/api/v1/appointments/${appointmentId}/cancellation-fee`)
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({})
      .expect(201);
    const fee = await raw.cancellationFee.findUniqueOrThrow({
      where: {
        tenantId_appointmentId: { tenantId: a.tenantId, appointmentId },
      },
      include: { planItem: { select: { planId: true } } },
    });
    return {
      appointmentId,
      feeId: fee.id,
      itemId: fee.planItemId!,
      planId: fee.planItem!.planId,
    };
  }

  /** La anulación como la hace la app: primero el cargo, luego el ítem. */
  const voidFee = (feeId: string, itemId: string) =>
    asApp(a.tenantId, async (tx) => {
      await tx.$executeRaw`UPDATE "cancellation_fees"
        SET "voidedAt" = now(), "voidedById" = ${a.adminUserId}::uuid,
            "voidReason" = 'Cargo generado por error'
        WHERE "id" = ${feeId}::uuid`;
      return tx.$executeRaw`UPDATE "treatment_plan_items"
        SET "deletedAt" = now() WHERE "id" = ${itemId}::uuid`;
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'sec050-int-a');
    location = (
      await raw.location.findFirstOrThrow({ where: { tenantId: a.tenantId } })
    ).id;
    policy = (
      (
        await request(app.getHttpServer())
          .post(`/api/v1/locations/${location}/cancellation-policy`)
          .set('X-Tenant-Host', a.host)
          .set('Authorization', `Bearer ${a.adminToken}`)
          .send({ noticeHours: 24, suggestedFee: 50000, currency: 'COP' })
          .expect(201)
      ).body as { id: string }
    ).id;
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
    await appRole.$disconnect();
  });

  it('rechaza un UPDATE directo del precio, del descuento o del estado del ítem de un cargo vigente', async () => {
    const { itemId } = await charged();
    const update = (set: string) =>
      asApp(a.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "treatment_plan_items" SET ${set} WHERE "id" = $1::uuid`,
          itemId,
        ),
      );
    await expect(update(`"price" = 1`)).rejects.toThrow(LOCKED);
    await expect(update(`"discount" = 100`)).rejects.toThrow(LOCKED);
    await expect(update(`"status" = 'ACCEPTED'`)).rejects.toThrow(LOCKED);
    await expect(update(`"deletedAt" = now()`)).rejects.toThrow(LOCKED);
    await expect(
      asApp(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`DELETE FROM "treatment_plan_items" WHERE "id" = ${itemId}::uuid`,
      ),
    ).rejects.toThrow(LOCKED);
    const item = await raw.treatmentPlanItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    expect(item.price.toNumber()).toBe(50000);
    expect(item.discount.toNumber()).toBe(0);
    expect(item.status).toBe('DONE');
    expect(item.deletedAt).toBeNull();
  });

  it('lo que no es dinero ni estado (las notas) sigue editándose', async () => {
    const { itemId } = await charged();
    await expect(
      asApp(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "treatment_plan_items" SET "notes" = 'Avisó tarde' WHERE "id" = ${itemId}::uuid`,
      ),
    ).resolves.toBe(1);
  });

  it('el plan del cargo vigente no se cancela ni cambia de moneda; completarlo sí', async () => {
    const { planId } = await charged();
    const update = (set: string) =>
      asApp(a.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "treatment_plans" SET ${set} WHERE "id" = $1::uuid`,
          planId,
        ),
      );
    await expect(update(`"status" = 'CANCELLED'`)).rejects.toThrow(LOCKED);
    await expect(update(`"currency" = 'USD'`)).rejects.toThrow(LOCKED);
    await expect(update(`"deletedAt" = now()`)).rejects.toThrow(LOCKED);
    await expect(update(`"notes" = 'Cargos'`)).resolves.toBe(1);
    await expect(update(`"status" = 'COMPLETED'`)).resolves.toBe(1);
  });

  it('la anulación legítima (primero el cargo, después el ítem, en una transacción) pasa', async () => {
    const { feeId, itemId, planId } = await charged();
    // El ítem sin anular antes el cargo: rechazado, y nada cambia.
    await expect(
      asApp(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "treatment_plan_items" SET "deletedAt" = now() WHERE "id" = ${itemId}::uuid`,
      ),
    ).rejects.toThrow(LOCKED);
    await expect(voidFee(feeId, itemId)).resolves.toBe(1);
    const fee = await raw.cancellationFee.findUniqueOrThrow({
      where: { id: feeId },
    });
    expect(fee).toMatchObject({
      status: 'CHARGED',
      voidedById: a.adminUserId,
      voidReason: 'Cargo generado por error',
    });
    expect(fee.amount?.toNumber()).toBe(50000);
    expect(
      (await raw.treatmentPlanItem.findUniqueOrThrow({ where: { id: itemId } }))
        .deletedAt,
    ).not.toBeNull();
    // Sin cargo vigente, el plan vuelve a lo de siempre (DX-040/DX-109).
    await expect(
      asApp(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "treatment_plans" SET "status" = 'CANCELLED' WHERE "id" = ${planId}::uuid`,
      ),
    ).resolves.toBe(1);
  });

  it('el cargo de un plan ya completado también se anula (el ítem sale aunque el plan esté cerrado, DX-109)', async () => {
    const { appointmentId, feeId, itemId, planId } = await charged();
    await request(app.getHttpServer())
      .patch(`/api/v1/treatment-plans/${planId}`)
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ status: 'COMPLETED' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/appointments/${appointmentId}/cancellation-fee/void`)
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ reason: 'Cargo generado por error' })
      .expect(201);
    expect(
      (await raw.cancellationFee.findUniqueOrThrow({ where: { id: feeId } }))
        .voidedAt,
    ).not.toBeNull();
    expect(
      (await raw.treatmentPlanItem.findUniqueOrThrow({ where: { id: itemId } }))
        .deletedAt,
    ).not.toBeNull();
    // El plan cerrado sigue cerrado para todo lo demás (DX-109).
    const other = await raw.treatmentPlanItem.findFirst({
      where: { planId, id: { not: itemId } },
    });
    expect(other).toBeNull();
    await expect(
      asApp(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "treatment_plan_items" SET "notes" = 'x' WHERE "id" = ${itemId}::uuid`,
      ),
    ).rejects.toThrow(/el plan está cerrado/);
  });

  it('en un plan cerrado, retirar el ítem de un cargo sin anular sigue rechazado', async () => {
    const { itemId, planId } = await charged();
    await asApp(
      a.tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE "treatment_plans" SET "status" = 'COMPLETED' WHERE "id" = ${planId}::uuid`,
    );
    await expect(
      asApp(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "treatment_plan_items" SET "deletedAt" = now() WHERE "id" = ${itemId}::uuid`,
      ),
    ).rejects.toThrow(/cargo por inasistencia|el plan está cerrado/);
  });

  it('la fila del cargo solo admite anularse, una vez y sin tocar lo demás', async () => {
    const { feeId, itemId } = await charged();
    // Columnas sin GRANT de UPDATE para la app.
    await expect(
      asApp(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "cancellation_fees" SET "amount" = 1 WHERE "id" = ${feeId}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    // Anular sin motivo, o a medias: CHECK.
    await expect(
      asApp(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "cancellation_fees" SET "voidedAt" = now(), "voidedById" = ${a.adminUserId}::uuid, "voidReason" = '  ' WHERE "id" = ${feeId}::uuid`,
      ),
    ).rejects.toThrow(/cancellation_fees_void_check/);
    await expect(
      asApp(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "cancellation_fees" SET "voidReason" = 'Sin fecha' WHERE "id" = ${feeId}::uuid`,
      ),
    ).rejects.toThrow(/solo se actualiza para anularlo/);
    await voidFee(feeId, itemId);
    // Una anulación no se deshace ni cambia de motivo.
    await expect(
      asApp(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "cancellation_fees" SET "voidReason" = 'Otro motivo' WHERE "id" = ${feeId}::uuid`,
      ),
    ).rejects.toThrow(/ya está anulado/);
    await expect(
      asApp(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "cancellation_fees" SET "voidedAt" = NULL, "voidedById" = NULL, "voidReason" = NULL WHERE "id" = ${feeId}::uuid`,
      ),
    ).rejects.toThrow(/ya está anulado/);
  });

  it('un ítem normal del plan se sigue editando y retirando', async () => {
    const { planId } = await charged();
    const catalog = await raw.dentalCatalogItem.create({
      data: {
        tenantId: a.tenantId,
        code: `sec050-${++seq}`,
        kind: 'PROCEDURE',
        labelEs: 'Limpieza',
        color: '#123456',
      },
    });
    const plan = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: planId },
    });
    const other = await raw.treatmentPlan.create({
      data: {
        tenantId: a.tenantId,
        patientId: plan.patientId,
        currency: 'COP',
        createdById: a.adminUserId,
      },
    });
    const item = await raw.treatmentPlanItem.create({
      data: {
        tenantId: a.tenantId,
        planId: other.id,
        toothNumber: '11',
        catalogItemId: catalog.id,
        price: 80000,
      },
    });
    await expect(
      asApp(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "treatment_plan_items" SET "price" = 70000 WHERE "id" = ${item.id}::uuid`,
      ),
    ).resolves.toBe(1);
    await expect(
      asApp(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "treatment_plan_items" SET "deletedAt" = now() WHERE "id" = ${item.id}::uuid`,
      ),
    ).resolves.toBe(1);
    await expect(
      asApp(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE "treatment_plans" SET "status" = 'CANCELLED' WHERE "id" = ${other.id}::uuid`,
      ),
    ).resolves.toBe(1);
  });

  it('DB-052: con UPDATE y DELETE concedidos de más, el cargo sigue sin reescribirse ni borrarse', async () => {
    const { feeId, itemId } = await charged();
    const feeAppointment = await raw.appointment.findFirstOrThrow({
      where: { cancellationFee: { id: feeId } },
      select: { id: true },
    });
    await raw.$executeRawUnsafe(
      'GRANT UPDATE, DELETE ON "cancellation_fees" TO dentalix_app',
    );
    try {
      const run = (sql: string) =>
        asApp(a.tenantId, (tx) => tx.$executeRawUnsafe(sql, feeId));
      for (const set of [
        `"amount" = 1`,
        `"status" = 'WAIVED', "amount" = NULL, "currency" = NULL, "planItemId" = NULL, "policyVersionId" = NULL, "waiveReason" = 'Cambiado'`,
        `"createdById" = "createdById"`,
      ]) {
        await expect(
          run(`UPDATE "cancellation_fees" SET ${set} WHERE "id" = $1::uuid`),
        ).rejects.toThrow(/solo se actualiza para anularlo/);
      }
      await expect(
        run(`DELETE FROM "cancellation_fees" WHERE "id" = $1::uuid`),
      ).rejects.toThrow(/no se borra/);
      // La anulación legítima sigue pasando; después, nada más.
      await voidFee(feeId, itemId);
      await expect(
        run(
          `UPDATE "cancellation_fees" SET "amount" = 1 WHERE "id" = $1::uuid`,
        ),
      ).rejects.toThrow(/ya está anulado/);
      await expect(
        run(`DELETE FROM "cancellation_fees" WHERE "id" = $1::uuid`),
      ).rejects.toThrow(/no se borra/);
    } finally {
      // Vuelve a los privilegios de la migración (el REVOKE de la tabla
      // también quita los de columna).
      await raw.$executeRawUnsafe(
        'REVOKE UPDATE, DELETE ON "cancellation_fees" FROM dentalix_app',
      );
      await raw.$executeRawUnsafe(
        'GRANT UPDATE ("voidedAt", "voidedById", "voidReason") ON "cancellation_fees" TO dentalix_app',
      );
    }
    const fee = await raw.cancellationFee.findUniqueOrThrow({
      where: { id: feeId },
    });
    expect(fee.status).toBe('CHARGED');
    expect(fee.amount?.toNumber()).toBe(50000);
    expect(fee.appointmentId).toBe(feeAppointment.id);
  });

  it('DB-052: con TRUNCATE concedido de más, la tabla del cargo no se vacía', async () => {
    const { feeId } = await charged();
    await raw.$executeRawUnsafe(
      'GRANT TRUNCATE ON "cancellation_fees" TO dentalix_app',
    );
    try {
      await expect(
        asApp(a.tenantId, (tx) =>
          tx.$executeRawUnsafe('TRUNCATE "cancellation_fees"'),
        ),
      ).rejects.toThrow(/no se borra/);
    } finally {
      await raw.$executeRawUnsafe(
        'REVOKE TRUNCATE ON "cancellation_fees" FROM dentalix_app',
      );
    }
    await expect(
      raw.cancellationFee.findUnique({ where: { id: feeId } }),
    ).resolves.not.toBeNull();
  });
});
