import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  CANCELLATION_FEE_MESSAGES,
  FEE_ITEM_LOCKED_MESSAGE,
  FEE_PLAN_LOCKED_MESSAGE,
} from '../src/modules/cancellation-fees/domain/cancellation-fee';

// SEC-050: el cargo por inasistencia o cancelación tardía (DX-291) ya no se
// rebaja ni se anula desde el plan. Matriz rol × acción sobre el ítem del
// cargo (PATCH precio/descuento/estado, DELETE, cancelar el plan): 409 a los
// roles clínicos (también ADMIN) y 403 a recepción (el plan es clínico); nada
// cambia. La anulación va por `POST …/cancellation-fee/void` con motivo, con el
// permiso de generar el cargo (ADMIN, o RECEPTION si la política lo permite) y
// la sede permitida (DX-089), auditada con el estado antes y después. Desde
// otra clínica, 404. Los ítems normales siguen como hoy.

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const HOUR = 3_600_000;

interface FeeView {
  status: 'NONE' | 'CHARGED' | 'WAIVED' | 'VOIDED';
  canManage: boolean;
  fee: {
    amount: number | null;
    planId: string | null;
    planItemId: string | null;
    planItemRemoved: boolean;
    itemAmount: number | null;
    itemMismatch: boolean;
    voidedAt: string | null;
    voidedByName: string | null;
    voidReason: string | null;
  } | null;
}

describe('cargo por cancelación protegido en el plan (SEC-050)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let patient: string;
  let seq = 0;
  const tokens: Partial<Record<ClinicRole, string>> = {};
  const userIds: Partial<Record<ClinicRole, string>> = {};

  function api(clinic: Clinic, token: string) {
    const server = app.getHttpServer();
    const auth = (t: request.Test) =>
      t
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`);
    return {
      get: (path: string) => auth(request(server).get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        auth(request(server).post(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        auth(request(server).put(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) =>
        auth(request(server).patch(`/api/v1${path}`)).send(body),
      delete: (path: string) => auth(request(server).delete(`/api/v1${path}`)),
    };
  }
  const admin = () => api(a, a.adminToken);
  const as = (role: ClinicRole) =>
    role === ClinicRole.ADMIN ? admin() : api(a, tokens[role]!);

  async function setPolicy(receptionCanCharge: boolean): Promise<void> {
    await admin()
      .post(`/locations/${principal}/cancellation-policy`, {
        noticeHours: 24,
        suggestedFee: 50000,
        currency: 'COP',
        patientText: 'Avísanos con 24 h.',
        receptionCanCharge,
      })
      .expect(201);
  }

  /** Una inasistencia de A con la política comunicada y su cargo generado. */
  async function chargedFee(): Promise<{
    appointmentId: string;
    planId: string;
    itemId: string;
  }> {
    const policy = await raw.cancellationPolicyVersion.findFirstOrThrow({
      where: { locationId: principal },
      orderBy: { version: 'desc' },
    });
    const start = new Date(Date.now() - (++seq * 2 + 24) * HOUR);
    const appointmentId = (
      await raw.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: principal,
          patientId: patient,
          providerId: randomUUID(),
          start,
          end: new Date(start.getTime() + 30 * 60_000),
          status: 'NO_SHOW',
          noShowMarkedAt: new Date(),
          policyVersionId: policy.id,
        },
      })
    ).id;
    const view = (
      await admin()
        .post(`/appointments/${appointmentId}/cancellation-fee`)
        .expect(201)
    ).body as FeeView;
    return {
      appointmentId,
      planId: view.fee!.planId!,
      itemId: view.fee!.planItemId!,
    };
  }

  async function itemRow(id: string) {
    const item = await raw.treatmentPlanItem.findUniqueOrThrow({
      where: { id },
    });
    return {
      price: item.price.toNumber(),
      discount: item.discount.toNumber(),
      status: item.status,
      deletedAt: item.deletedAt,
    };
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'sec050-a');
    b = await registerClinic(app, 'sec050-b');
    principal = (
      (await admin().get('/locations').expect(200)).body as { id: string }[]
    )[0].id;
    for (const role of [
      ClinicRole.RECEPTION,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
    ]) {
      const m = await seedMember(raw, a, role);
      userIds[role] = m.userId;
      tokens[role] = await loginAs(app, a.host, m.email);
    }
    await setPolicy(false);
    patient = (
      await raw.patient.create({
        data: { tenantId: a.tenantId, firstName: 'Ana', lastName: 'Cargo' },
      })
    ).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('matriz rol × acción sobre el ítem del cargo (recepción sin permiso)', () => {
    let fee: { appointmentId: string; planId: string; itemId: string };
    beforeAll(async () => {
      fee = await chargedFee();
    });

    const clinical = [
      ClinicRole.ADMIN,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
    ] as const;
    const edits: [string, object][] = [
      ['precio', { price: 1 }],
      [
        'descuento',
        {
          discount: 10000,
          discountReason: 'OTHER',
          discountReasonNote: 'Favor',
        },
      ],
      ['estado', { status: 'ACCEPTED' }],
    ];

    for (const role of clinical) {
      for (const [label, body] of edits) {
        it(`${role} · PATCH ${label}: 409 en español y nada cambia`, async () => {
          const res = await as(role)
            .patch(`/treatment-plans/${fee.planId}/items/${fee.itemId}`, body)
            .expect(409);
          expect((res.body as { message: string }).message).toBe(
            FEE_ITEM_LOCKED_MESSAGE,
          );
          expect(await itemRow(fee.itemId)).toEqual({
            price: 50000,
            discount: 0,
            status: 'DONE',
            deletedAt: null,
          });
        });
      }

      it(`${role} · DELETE (Quitar): 409 en español y el ítem sigue`, async () => {
        const res = await as(role)
          .delete(`/treatment-plans/${fee.planId}/items/${fee.itemId}`)
          .expect(409);
        expect((res.body as { message: string }).message).toBe(
          FEE_ITEM_LOCKED_MESSAGE,
        );
        expect((await itemRow(fee.itemId)).deletedAt).toBeNull();
      });

      it(`${role} · cancelar el plan del cargo: 409 y sigue aceptado`, async () => {
        const res = await as(role)
          .patch(`/treatment-plans/${fee.planId}`, { status: 'CANCELLED' })
          .expect(409);
        expect((res.body as { message: string }).message).toBe(
          FEE_PLAN_LOCKED_MESSAGE,
        );
        expect(
          (
            await raw.treatmentPlan.findUniqueOrThrow({
              where: { id: fee.planId },
            })
          ).status,
        ).toBe('ACCEPTED');
      });
    }

    it.each([ClinicRole.DENTIST, ClinicRole.ASSISTANT, ClinicRole.RECEPTION])(
      '%s · POST void: 403 en español y el cargo sigue',
      async (role) => {
        const res = await as(role)
          .post(`/appointments/${fee.appointmentId}/cancellation-fee/void`, {
            reason: 'Me lo pidió el paciente',
          })
          .expect(403);
        expect((res.body as { message: string }).message).toBe(
          CANCELLATION_FEE_MESSAGES.forbidden,
        );
        const row = await raw.cancellationFee.findFirstOrThrow({
          where: { appointmentId: fee.appointmentId },
        });
        expect(row.voidedAt).toBeNull();
      },
    );

    it('RECEPTION · PATCH precio y DELETE: 403 (el plan es clínico) y nada cambia', async () => {
      await as(ClinicRole.RECEPTION)
        .patch(`/treatment-plans/${fee.planId}/items/${fee.itemId}`, {
          price: 1,
        })
        .expect(403);
      await as(ClinicRole.RECEPTION)
        .delete(`/treatment-plans/${fee.planId}/items/${fee.itemId}`)
        .expect(403);
      expect(await itemRow(fee.itemId)).toMatchObject({
        price: 50000,
        deletedAt: null,
      });
    });

    it('el plan dice qué ítem es el cargo vigente', async () => {
      const plan = (
        await admin().get(`/treatment-plans/${fee.planId}`).expect(200)
      ).body as {
        items: { id: string; cancellationFeeAppointmentId: string | null }[];
      };
      expect(
        plan.items.find((i) => i.id === fee.itemId)
          ?.cancellationFeeAppointmentId,
      ).toBe(fee.appointmentId);
    });

    it('otra clínica: 404 al anular el cargo y al tocar el ítem', async () => {
      const other = api(b, b.adminToken);
      await other
        .post(`/appointments/${fee.appointmentId}/cancellation-fee/void`, {
          reason: 'Intento ajeno',
        })
        .expect(404);
      await other
        .patch(`/treatment-plans/${fee.planId}/items/${fee.itemId}`, {
          price: 1,
        })
        .expect(404);
      await other
        .delete(`/treatment-plans/${fee.planId}/items/${fee.itemId}`)
        .expect(404);
      expect(await itemRow(fee.itemId)).toMatchObject({
        price: 50000,
        deletedAt: null,
      });
    });
  });

  describe('POST /appointments/:id/cancellation-fee/void', () => {
    it('ADMIN: sin motivo 400; con motivo queda anulado, el ítem fuera del plan y auditado sin el texto', async () => {
      const fee = await chargedFee();
      await admin()
        .post(`/appointments/${fee.appointmentId}/cancellation-fee/void`, {
          reason: '  ',
        })
        .expect(400);
      const voided = (
        await admin()
          .post(`/appointments/${fee.appointmentId}/cancellation-fee/void`, {
            reason: 'Cargo generado por error: avisó a tiempo',
          })
          .expect(201)
      ).body as FeeView;
      expect(voided).toMatchObject({
        status: 'VOIDED',
        fee: {
          amount: 50000,
          planItemRemoved: true,
          itemAmount: null,
          itemMismatch: false,
          voidReason: 'Cargo generado por error: avisó a tiempo',
        },
      });
      expect(voided.fee!.voidedAt).not.toBeNull();
      expect(voided.fee!.voidedByName).toBeTruthy();
      expect((await itemRow(fee.itemId)).deletedAt).not.toBeNull();

      // La vista lo sigue diciendo y la decisión de la cita sigue siendo única.
      const view = (
        await admin()
          .get(`/appointments/${fee.appointmentId}/cancellation-fee`)
          .expect(200)
      ).body as FeeView;
      expect(view.status).toBe('VOIDED');
      const again = await admin()
        .post(`/appointments/${fee.appointmentId}/cancellation-fee/void`, {
          reason: 'Otra vez',
        })
        .expect(409);
      expect((again.body as { message: string }).message).toBe(
        CANCELLATION_FEE_MESSAGES.alreadyVoided,
      );
      await admin()
        .post(`/appointments/${fee.appointmentId}/cancellation-fee`)
        .expect(409);

      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          resourceId: fee.appointmentId,
          action: 'VOID',
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        resourceType: 'APPOINTMENT',
        patientId: patient,
        actorUserId: a.adminUserId,
      });
      expect(events[0].metadata).toMatchObject({
        reason: 'CANCELLATION_FEE_VOIDED',
        statusChange: { from: 'CHARGED', to: 'VOIDED' },
      });
      expect(JSON.stringify(events[0].metadata)).not.toContain('por error');
    });

    it('sin cargo generado (o condonado): 409', async () => {
      const start = new Date(Date.now() - (++seq * 2 + 24) * HOUR);
      const id = (
        await raw.appointment.create({
          data: {
            tenantId: a.tenantId,
            locationId: principal,
            patientId: patient,
            providerId: randomUUID(),
            start,
            end: new Date(start.getTime() + 30 * 60_000),
            status: 'NO_SHOW',
            noShowMarkedAt: new Date(),
          },
        })
      ).id;
      const res = await admin()
        .post(`/appointments/${id}/cancellation-fee/void`, { reason: 'Error' })
        .expect(409);
      expect((res.body as { message: string }).message).toBe(
        CANCELLATION_FEE_MESSAGES.notCharged,
      );
    });

    it('ya cobrado con un abono: 409 «anula antes el abono» y nada cambia', async () => {
      const other = (
        await raw.patient.create({
          data: { tenantId: a.tenantId, firstName: 'Pagó', lastName: 'Ya' },
        })
      ).id;
      const previous = patient;
      patient = other;
      const fee = await chargedFee();
      patient = previous;
      await admin()
        .post(`/treatment-plans/${fee.planId}/payments`, {
          amount: 50000,
          currency: 'COP',
          paidAt: new Date().toISOString(),
          method: 'CASH',
        })
        .expect(201);
      const res = await admin()
        .post(`/appointments/${fee.appointmentId}/cancellation-fee/void`, {
          reason: 'Error',
        })
        .expect(409);
      expect((res.body as { message: string }).message).toBe(
        CANCELLATION_FEE_MESSAGES.voidPaid,
      );
      expect((await itemRow(fee.itemId)).deletedAt).toBeNull();
    });

    it('RECEPTION con permiso de la política anula; restringida a otra sede (DX-089): 403', async () => {
      const fee = await chargedFee();
      const second = await chargedFee();
      await setPolicy(true);
      try {
        const norte = (
          (await admin().post('/locations', { name: 'Sede norte' }).expect(201))
            .body as { id: string }
        ).id;
        // Una recepcionista solo de la sede norte: la cita es de la principal.
        const m = await seedMember(
          raw,
          { ...a, subdomain: 'sec050-a-norte' },
          ClinicRole.RECEPTION,
        );
        await admin()
          .put(`/staff/${m.userId}/locations`, { locationIds: [norte] })
          .expect(200);
        const restricted = api(a, await loginAs(app, a.host, m.email));
        await restricted
          .post(`/appointments/${second.appointmentId}/cancellation-fee/void`, {
            reason: 'Error',
          })
          .expect(403);
        expect((await itemRow(second.itemId)).deletedAt).toBeNull();

        const voided = (
          await as(ClinicRole.RECEPTION)
            .post(`/appointments/${fee.appointmentId}/cancellation-fee/void`, {
              reason: 'Cargo duplicado',
            })
            .expect(201)
        ).body as FeeView;
        expect(voided.status).toBe('VOIDED');
      } finally {
        await setPolicy(false);
      }
    });
  });

  it('la vista avisa si el ítem no cobra lo que dice el cargo', async () => {
    const fee = await chargedFee();
    // Un cambio por fuera de la app (el propietario, sin contexto de clínica,
    // no pasa por el trigger): lo que dejaba hacer el plan antes de SEC-050.
    await raw.treatmentPlanItem.update({
      where: { id: fee.itemId },
      data: { price: 1 },
    });
    const view = (
      await admin()
        .get(`/appointments/${fee.appointmentId}/cancellation-fee`)
        .expect(200)
    ).body as FeeView;
    expect(view).toMatchObject({
      status: 'CHARGED',
      fee: { amount: 50000, itemAmount: 1, itemMismatch: true },
    });
  });

  describe('los ítems normales del plan, como hoy', () => {
    it('DENTIST cambia el precio y ASSISTANT quita un ítem normal', async () => {
      const plan = (
        await admin()
          .post(`/patients/${patient}/treatment-plans`, { currency: 'COP' })
          .expect(201)
      ).body as { id: string };
      const catalog = (
        await admin()
          .post('/catalog/items', {
            code: `SEC050-${++seq}`,
            kind: 'PROCEDURE',
            labelEs: 'Limpieza',
            color: '#123456',
          })
          .expect(201)
      ).body as { id: string };
      const add = () =>
        admin()
          .post(`/treatment-plans/${plan.id}/items`, {
            toothNumber: '11',
            catalogItemId: catalog.id,
            price: 80000,
          })
          .expect(201)
          .then((res) => (res.body as { id: string }).id);
      const first = await add();
      const second = await add();
      const patched = await as(ClinicRole.DENTIST)
        .patch(`/treatment-plans/${plan.id}/items/${first}`, { price: 90000 })
        .expect(200);
      expect(patched.body).toMatchObject({
        price: 90000,
        cancellationFeeAppointmentId: null,
      });
      await as(ClinicRole.ASSISTANT)
        .delete(`/treatment-plans/${plan.id}/items/${second}`)
        .expect(200);
      await as(ClinicRole.DENTIST)
        .patch(`/treatment-plans/${plan.id}`, { status: 'CANCELLED' })
        .expect(200);
    });
  });
});
