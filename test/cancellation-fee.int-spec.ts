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

// DX-291 contra Postgres: el cargo por inasistencia es idempotente bajo
// concurrencia (varias peticiones a la vez dejan UNA respuesta 201, un ítem y
// una fila), dos cargos simultáneos del mismo paciente comparten el plan
// «Cargos administrativos», y `cancellation_fees` tiene RLS FORCE, es
// append-only para la app, su CHECK de coherencia y su único por cita.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const HOUR = 3_600_000;

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

describe('cargo por inasistencia (DX-291, int)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let location: string;
  let policy: string;
  let seq = 0;

  const post = (path: string) =>
    request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({});

  async function patient(): Promise<string> {
    return (
      await raw.patient.create({
        data: { tenantId: a.tenantId, firstName: 'Ana', lastName: `P${++seq}` },
      })
    ).id;
  }

  async function noShow(patientId: string): Promise<string> {
    const start = new Date(Date.now() - (++seq * 2 + 24) * HOUR);
    return (
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
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx291-int-a');
    b = await registerClinic(app, 'dx291-int-b');
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

  it('dos «Generar cargo» simultáneos: una sola 201, un ítem y una fila', async () => {
    const patientId = await patient();
    const id = await noShow(patientId);
    const responses = await Promise.all([
      post(`/appointments/${id}/cancellation-fee`),
      post(`/appointments/${id}/cancellation-fee`),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await raw.cancellationFee.count({ where: { appointmentId: id } }),
    ).toBe(1);
    expect(
      await raw.treatmentPlanItem.count({
        where: { patientId, plan: { optionLabel: 'Cargos administrativos' } },
      }),
    ).toBe(1);
  });

  it('cinco peticiones a la vez siguen dejando un solo cargo', async () => {
    const patientId = await patient();
    const id = await noShow(patientId);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        post(`/appointments/${id}/cancellation-fee`),
      ),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(4);
    expect(
      await raw.cancellationFee.count({ where: { appointmentId: id } }),
    ).toBe(1);
  });

  it('cargo y condonación simultáneos de la misma cita: solo uno gana', async () => {
    const id = await noShow(await patient());
    const [charge, waive] = await Promise.all([
      post(`/appointments/${id}/cancellation-fee`),
      request(app.getHttpServer())
        .post(`/api/v1/appointments/${id}/cancellation-fee/waive`)
        .set('X-Tenant-Host', a.host)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({ reason: 'Hospitalización' }),
    ]);
    expect([charge.status, waive.status].sort()).toEqual([201, 409]);
    expect(
      await raw.cancellationFee.count({ where: { appointmentId: id } }),
    ).toBe(1);
  });

  it('dos cargos simultáneos del mismo paciente (citas distintas) comparten el plan de su moneda', async () => {
    const patientId = await patient();
    const [first, second] = [await noShow(patientId), await noShow(patientId)];
    const responses = await Promise.all([
      post(`/appointments/${first}/cancellation-fee`),
      post(`/appointments/${second}/cancellation-fee`),
    ]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    const plans = await raw.treatmentPlan.findMany({
      where: { patientId, optionLabel: 'Cargos administrativos' },
      include: { items: true },
    });
    expect(plans).toHaveLength(1);
    expect(plans[0].items).toHaveLength(2);
  });

  describe('cancellation_fees en la BD', () => {
    let feeId: string;
    let appointmentId: string;

    beforeAll(async () => {
      appointmentId = await noShow(await patient());
      await post(`/appointments/${appointmentId}/cancellation-fee`).expect(201);
      feeId = (
        await raw.cancellationFee.findFirstOrThrow({ where: { appointmentId } })
      ).id;
    });

    it('RLS FORCE: otra clínica no la ve ni la escribe', async () => {
      const seen = await asApp(b.tenantId, (tx) =>
        tx.cancellationFee.findMany({ where: { id: feeId } }),
      );
      expect(seen).toEqual([]);
      const [{ relforcerowsecurity }] = await raw.$queryRaw<
        { relforcerowsecurity: boolean }[]
      >`SELECT relforcerowsecurity FROM pg_class WHERE relname = 'cancellation_fees'`;
      expect(relforcerowsecurity).toBe(true);
      await expect(
        asApp(
          b.tenantId,
          (tx) =>
            tx.$executeRaw`INSERT INTO "cancellation_fees"
            ("id", "tenantId", "appointmentId", "patientId", "locationId",
             "status", "waiveReason", "createdById")
            SELECT gen_random_uuid(), "tenantId", "id", "patientId",
                   "locationId", 'WAIVED', 'Intento ajeno', ${a.adminUserId}::uuid
              FROM "appointments" WHERE "id" = ${appointmentId}::uuid`,
        ),
      ).resolves.toBe(0);
    });

    it('append-only para la app: sin UPDATE ni DELETE', async () => {
      await expect(
        asApp(
          a.tenantId,
          (tx) =>
            tx.$executeRaw`UPDATE "cancellation_fees" SET "amount" = 1 WHERE "id" = ${feeId}::uuid`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asApp(
          a.tenantId,
          (tx) =>
            tx.$executeRaw`DELETE FROM "cancellation_fees" WHERE "id" = ${feeId}::uuid`,
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('único por cita y CHECK de coherencia', async () => {
      const insert = (
        status: string,
        amount: number | null,
        reason: string | null,
      ) =>
        asApp(a.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO "cancellation_fees"
              ("id", "tenantId", "appointmentId", "patientId", "locationId",
               "status", "amount", "waiveReason", "createdById")
             SELECT gen_random_uuid(), "tenantId", "id", "patientId", "locationId",
                    $2::"CancellationFeeStatus", $3::numeric, $4, $5::uuid
               FROM "appointments" WHERE "id" = $1::uuid`,
            appointmentId,
            status,
            amount,
            reason,
            a.adminUserId,
          ),
        );
      // Segunda decisión para la misma cita.
      await expect(insert('WAIVED', null, 'Otro motivo')).rejects.toThrow(
        /23505|Unique constraint/,
      );
      const other = await noShow(await patient());
      const insertOther = (
        status: string,
        amount: number | null,
        reason: string | null,
      ) =>
        asApp(a.tenantId, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO "cancellation_fees"
              ("id", "tenantId", "appointmentId", "patientId", "locationId",
               "status", "amount", "waiveReason", "createdById")
             SELECT gen_random_uuid(), "tenantId", "id", "patientId", "locationId",
                    $2::"CancellationFeeStatus", $3::numeric, $4, $5::uuid
               FROM "appointments" WHERE "id" = $1::uuid`,
            other,
            status,
            amount,
            reason,
            a.adminUserId,
          ),
        );
      // CHARGED sin ítem ni moneda; WAIVED sin motivo o con importe.
      await expect(insertOther('CHARGED', 100, null)).rejects.toThrow(
        /cancellation_fees_status_check/,
      );
      await expect(insertOther('WAIVED', null, '  ')).rejects.toThrow(
        /cancellation_fees_status_check/,
      );
      await expect(insertOther('WAIVED', 100, 'Motivo válido')).rejects.toThrow(
        /cancellation_fees_status_check/,
      );
      await expect(insertOther('WAIVED', null, 'Motivo válido')).resolves.toBe(
        1,
      );
    });
  });

  it('el recordatorio guarda la versión enviada (FK compuesta a la política de la misma clínica)', async () => {
    const appointmentId = await noShow(await patient());
    const reminder = await raw.appointmentReminder.create({
      data: {
        tenantId: a.tenantId,
        appointmentId,
        leadHours: 24,
        appointmentStart: new Date(),
      },
    });
    await asApp(a.tenantId, (tx) =>
      tx.appointmentReminder.update({
        where: { id: reminder.id },
        data: { policyVersionId: policy },
      }),
    );
    // Una versión de otra clínica no cabe en la FK compuesta.
    const foreign = await raw.cancellationPolicyVersion.create({
      data: {
        tenantId: b.tenantId,
        locationId: (
          await raw.location.findFirstOrThrow({
            where: { tenantId: b.tenantId },
          })
        ).id,
        version: 1,
        noticeHours: 24,
        createdById: b.adminUserId,
      },
    });
    await expect(
      raw.appointmentReminder.update({
        where: { id: reminder.id },
        data: { policyVersionId: foreign.id },
      }),
    ).rejects.toThrow(/appointment_reminders_policy_version_fkey|Foreign key/);
  });
});
