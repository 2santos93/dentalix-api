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
import { CANCELLATION_FEE_MESSAGES } from '../src/modules/cancellation-fees/domain/cancellation-fee';

// DX-291 (porción 2 de DX-279): la política en el enlace público con
// aceptación al cancelar tarde, el cargo por inasistencia o cancelación
// tardía (ítem DONE en «Cargos administrativos», cobrado con abono y recibo),
// su condonación, los 409 (sin política comunicada, EPS_CO en Colombia), los
// 403 por rol, los 404 desde otra clínica y la vista previa del email.

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const HOUR = 3_600_000;
const POLICY_TEXT =
  'Si no puedes venir, avísanos con 24 h o se cobrará la cita.';

interface FeeView {
  appointmentId: string;
  patientId: string;
  eligible: boolean;
  status: 'NONE' | 'CHARGED' | 'WAIVED' | 'VOIDED';
  chargeBlock: string | null;
  chargeBlockMessage: string | null;
  canManage: boolean;
  communicated: { policyVersionId: string; suggestedFee: number } | null;
  fee: {
    amount: number | null;
    currency: string | null;
    planId: string | null;
    planItemId: string | null;
    waiveReason: string | null;
    planItemRemoved: boolean;
  } | null;
}

describe('Cargo por inasistencia y política en el enlace (DX-291)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let policyV1: string;
  let patient: string;
  const tokens: Partial<Record<ClinicRole, string>> = {};
  let pastSeq = 0;

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
      patch: (path: string, body: object) =>
        auth(request(server).patch(`/api/v1${path}`)).send(body),
      delete: (path: string) => auth(request(server).delete(`/api/v1${path}`)),
    };
  }
  const admin = () => api(a, a.adminToken);
  const publicLink = (token: string) => ({
    get: () =>
      request(app.getHttpServer())
        .get(`/api/v1/public/appointment-confirmations/${token}`)
        .set('X-Tenant-Host', a.host),
    post: (body: object) =>
      request(app.getHttpServer())
        .post(`/api/v1/public/appointment-confirmations/${token}`)
        .set('X-Tenant-Host', a.host)
        .send(body),
  });

  /** Una cita de A sembrada directamente (el horario no importa aquí). */
  async function appointment(
    hoursFromNow: number,
    over: {
      patientId?: string;
      status?: 'SCHEDULED' | 'NO_SHOW';
      policyVersionId?: string | null;
    } = {},
  ): Promise<string> {
    // Las inasistencias van a horas pasadas distintas (sin solapes del paciente).
    const shift = over.status === 'NO_SHOW' ? (pastSeq += 2) * HOUR : 0;
    const start = new Date(Date.now() + hoursFromNow * HOUR - shift);
    const created = await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: principal,
        patientId: over.patientId ?? patient,
        providerId: randomUUID(),
        start,
        end: new Date(start.getTime() + 30 * 60_000),
        status: over.status ?? 'SCHEDULED',
        noShowMarkedAt: over.status === 'NO_SHOW' ? new Date() : null,
        policyVersionId:
          over.policyVersionId === undefined ? policyV1 : over.policyVersionId,
      },
    });
    return created.id;
  }

  async function linkToken(appointmentId: string): Promise<string> {
    const link = await admin()
      .post(`/appointments/${appointmentId}/confirmation-link`)
      .expect(201);
    return (link.body as { url: string }).url.split('/confirmar/')[1];
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx291-a');
    b = await registerClinic(app, 'dx291-b');
    principal = (
      (await admin().get('/locations').expect(200)).body as { id: string }[]
    )[0].id;
    for (const role of [
      ClinicRole.RECEPTION,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
    ]) {
      const m = await seedMember(raw, a, role);
      tokens[role] = await loginAs(app, a.host, m.email);
    }
    policyV1 = (
      (
        await admin()
          .post(`/locations/${principal}/cancellation-policy`, {
            noticeHours: 24,
            suggestedFee: 50000,
            currency: 'COP',
            patientText: POLICY_TEXT,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    patient = (
      await raw.patient.create({
        data: {
          tenantId: a.tenantId,
          firstName: 'Ana María',
          lastName: 'Tarde',
        },
      })
    ).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('enlace público con la política (cancelar 5 h antes, política de 24 h)', () => {
    let id: string;
    let token: string;

    beforeAll(async () => {
      // La cita aún no tiene versión comunicada: la deja el enlace.
      id = await appointment(5, { policyVersionId: null });
      token = await linkToken(id);
    });

    it('la vista muestra el texto, isLate y nada clínico', async () => {
      const res = await publicLink(token).get().expect(200);
      const body = res.body as {
        isLate: boolean;
        cancellationPolicy: Record<string, unknown>;
        appointment: Record<string, unknown>;
      };
      expect(body.isLate).toBe(true);
      expect(body.cancellationPolicy).toEqual({
        policyVersionId: policyV1,
        noticeHours: 24,
        text: POLICY_TEXT,
        suggestedFee: 50000,
        currency: 'COP',
      });
      expect(Object.keys(body.appointment).sort()).toEqual([
        'end',
        'locationAddress',
        'locationName',
        'patientFirstName',
        'providerName',
        'start',
      ]);
      expect(body.appointment.patientFirstName).toBe('Ana');
    });

    it('cancelar sin acknowledgePolicy: 400 en español y la cita sigue agendada', async () => {
      const res = await publicLink(token)
        .post({ action: 'cancel', policyVersionId: policyV1 })
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        'Cancelación con menos de 24 h de aviso: para cancelar, acepta la política de cancelación de la clínica.',
      );
      const row = await raw.appointment.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('SCHEDULED');
      expect(row.policyVersionId).toBeNull();
    });

    it('con una versión que ya no es la vigente: 409', async () => {
      await publicLink(token)
        .post({
          action: 'cancel',
          acknowledgePolicy: true,
          policyVersionId: randomUUID(),
        })
        .expect(409);
    });

    it('con acknowledgePolicy: CANCELLED, PATIENT_LINK, aviso ~300 min, tardía y la versión comunicada', async () => {
      await publicLink(token)
        .post({
          action: 'cancel',
          acknowledgePolicy: true,
          policyVersionId: policyV1,
        })
        .expect(200);
      const row = await raw.appointment.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        status: 'CANCELLED',
        cancelledByKind: 'PATIENT_LINK',
        lateCancellation: true,
        policyVersionId: policyV1,
      });
      expect(Math.abs(row.noticeMinutes! - 300)).toBeLessThanOrEqual(1);
    });

    it('«Quiero que me llamen» sigue disponible sin aceptar la política', async () => {
      const other = await appointment(4, { policyVersionId: null });
      await publicLink(await linkToken(other))
        .post({ action: 'call_me' })
        .expect(200);
      const row = await raw.appointment.findUniqueOrThrow({
        where: { id: other },
      });
      expect(row.callbackRequestedAt).not.toBeNull();
      expect(row.policyVersionId).toBe(policyV1);
    });

    it('generar el cargo de la cancelación tardía y cobrarlo con recibo consecutivo', async () => {
      const view = (
        await admin().get(`/appointments/${id}/cancellation-fee`).expect(200)
      ).body as FeeView;
      expect(view).toMatchObject({
        eligible: true,
        status: 'NONE',
        chargeBlock: null,
        canManage: true,
        communicated: { policyVersionId: policyV1, suggestedFee: 50000 },
      });

      // Nunca por encima del sugerido.
      await admin()
        .post(`/appointments/${id}/cancellation-fee`, { amount: 50000.01 })
        .expect(400);

      const charged = (
        await admin()
          .post(`/appointments/${id}/cancellation-fee`, { amount: 40000 })
          .expect(201)
      ).body as FeeView;
      expect(charged.status).toBe('CHARGED');
      expect(charged.fee).toMatchObject({ amount: 40000, currency: 'COP' });
      const planId = charged.fee!.planId!;

      const plan = await raw.treatmentPlan.findUniqueOrThrow({
        where: { id: planId },
        include: { items: true },
      });
      expect(plan).toMatchObject({
        status: 'ACCEPTED',
        currency: 'COP',
        optionLabel: 'Cargos administrativos',
      });
      expect(plan.items).toHaveLength(1);
      expect(plan.items[0].status).toBe('DONE');
      expect(plan.items[0].price.toNumber()).toBe(40000);

      // Un segundo cargo: 409.
      const again = await admin()
        .post(`/appointments/${id}/cancellation-fee`)
        .expect(409);
      expect((again.body as { message: string }).message).toBe(
        CANCELLATION_FEE_MESSAGES.alreadyCharged,
      );

      // En el estado de cuenta.
      const statement = (
        await admin().get(`/patients/${patient}/account-statement`).expect(200)
      ).body as { plans: { id: string; budgeted: number; balance: number }[] };
      expect(statement.plans).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: planId,
            budgeted: 40000,
            balance: 40000,
          }),
        ]),
      );

      // Se cobra con el abono y el recibo de siempre (DX-136).
      const pay = await api(a, tokens.RECEPTION!)
        .post(`/treatment-plans/${planId}/payments`, {
          amount: 40000,
          currency: 'COP',
          paidAt: new Date().toISOString(),
          method: 'CASH',
        })
        .expect(201);
      expect((pay.body as { receiptNumber: string }).receiptNumber).toMatch(
        /^[A-Z0-9]+-\d{6}$/,
      );
      const after = (
        await admin().get(`/patients/${patient}/account-statement`).expect(200)
      ).body as { plans: { id: string; balance: number }[] };
      expect(after.plans.find((p) => p.id === planId)?.balance).toBe(0);

      // Un segundo cargo (otra cita) va al MISMO plan de su moneda.
      const noShow = await appointment(-30, { status: 'NO_SHOW' });
      const second = (
        await admin()
          .post(`/appointments/${noShow}/cancellation-fee`)
          .expect(201)
      ).body as FeeView;
      expect(second.fee).toMatchObject({
        planId,
        amount: 50000,
        planItemRemoved: false,
      });

      // SEC-050: desde el plan el ítem del cargo no se quita (409); un cargo
      // generado por error se anula desde la cita, con motivo. La vista lo
      // dice (ya no hay nada que cobrar) y la decisión sigue siendo única:
      // ni otro cargo ni condonar.
      await admin()
        .delete(`/treatment-plans/${planId}/items/${second.fee!.planItemId}`)
        .expect(409);
      await admin()
        .post(`/appointments/${noShow}/cancellation-fee/void`, {
          reason: 'Cargo generado por error',
        })
        .expect(201);
      const removed = (
        await admin()
          .get(`/appointments/${noShow}/cancellation-fee`)
          .expect(200)
      ).body as FeeView;
      expect(removed.status).toBe('VOIDED');
      expect(removed.fee).toMatchObject({ planItemRemoved: true });
      await admin()
        .post(`/appointments/${noShow}/cancellation-fee`)
        .expect(409);

      const events = await raw.auditEvent.findMany({
        where: { tenantId: a.tenantId, resourceId: id },
      });
      expect(events.map((e) => e.metadata)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: 'CANCELLATION_FEE_CHARGED' }),
        ]),
      );
      expect(
        events.find(
          (e) =>
            (e.metadata as { reason?: string }).reason ===
            'CANCELLATION_FEE_CHARGED',
        )?.patientId,
      ).toBe(patient);
    });
  });

  describe('POST /appointments/:id/cancellation-fee', () => {
    it.each([ClinicRole.DENTIST, ClinicRole.ASSISTANT])(
      '%s: 403 en español (guard)',
      async (role) => {
        const id = await appointment(-50, { status: 'NO_SHOW' });
        const res = await api(a, tokens[role]!)
          .post(`/appointments/${id}/cancellation-fee`)
          .expect(403);
        expect((res.body as { message: string }).message).toBe(
          CANCELLATION_FEE_MESSAGES.forbidden,
        );
      },
    );

    it('RECEPTION: 403 si la política no lo permite; con una versión que lo permite, cobra', async () => {
      const id = await appointment(-60, { status: 'NO_SHOW' });
      await api(a, tokens.RECEPTION!)
        .post(`/appointments/${id}/cancellation-fee`)
        .expect(403);
      const view = (
        await api(a, tokens.RECEPTION!)
          .get(`/appointments/${id}/cancellation-fee`)
          .expect(200)
      ).body as FeeView;
      expect(view.canManage).toBe(false);

      await admin()
        .post(`/locations/${principal}/cancellation-policy`, {
          noticeHours: 24,
          suggestedFee: 50000,
          currency: 'COP',
          patientText: POLICY_TEXT,
          receptionCanCharge: true,
        })
        .expect(201);
      const charged = (
        await api(a, tokens.RECEPTION!)
          .post(`/appointments/${id}/cancellation-fee`)
          .expect(201)
      ).body as FeeView;
      // Importe de la versión COMUNICADA (v1), no de la vigente.
      expect(charged.fee).toMatchObject({ amount: 50000 });
    });

    it('sin política comunicada: 409 «No consta que el paciente fuera informado de la política»', async () => {
      const id = await appointment(-70, {
        status: 'NO_SHOW',
        policyVersionId: null,
      });
      const res = await admin()
        .post(`/appointments/${id}/cancellation-fee`)
        .expect(409);
      expect((res.body as { message: string }).message).toBe(
        'No consta que el paciente fuera informado de la política.',
      );
    });

    it('EPS_CO activa en una sede de Colombia: 409 (Ley 1438 art. 55)', async () => {
      const epsPatient = (
        await raw.patient.create({
          data: { tenantId: a.tenantId, firstName: 'Eps', lastName: 'Activa' },
        })
      ).id;
      const payer = await raw.payer.create({
        data: {
          tenantId: a.tenantId,
          name: 'EPS Sura',
          type: 'EPS_CO',
          country: 'CO',
        },
      });
      await raw.patientCoverage.create({
        data: {
          tenantId: a.tenantId,
          patientId: epsPatient,
          payerId: payer.id,
          isPrimary: true,
        },
      });
      const id = await appointment(-80, {
        status: 'NO_SHOW',
        patientId: epsPatient,
      });
      const res = await admin()
        .post(`/appointments/${id}/cancellation-fee`)
        .expect(409);
      expect((res.body as { message: string }).message).toBe(
        CANCELLATION_FEE_MESSAGES.epsCo,
      );
    });

    it('una cita que no es inasistencia ni tardía: 409', async () => {
      const id = await appointment(48);
      await admin().post(`/appointments/${id}/cancellation-fee`).expect(409);
    });

    it('desde otra clínica: 404 al leer, cobrar y condonar', async () => {
      const id = await appointment(-90, { status: 'NO_SHOW' });
      await api(b, b.adminToken)
        .get(`/appointments/${id}/cancellation-fee`)
        .expect(404);
      await api(b, b.adminToken)
        .post(`/appointments/${id}/cancellation-fee`)
        .expect(404);
      await api(b, b.adminToken)
        .post(`/appointments/${id}/cancellation-fee/waive`, {
          reason: 'Intento ajeno',
        })
        .expect(404);
      expect(
        await raw.cancellationFee.count({ where: { appointmentId: id } }),
      ).toBe(0);
    });
  });

  describe('POST /appointments/:id/cancellation-fee/waive', () => {
    it('sin motivo: 400; con motivo queda WAIVED, auditado sin el texto, y luego cobrar da 409', async () => {
      const id = await appointment(-100, { status: 'NO_SHOW' });
      await admin()
        .post(`/appointments/${id}/cancellation-fee/waive`, { reason: ' ' })
        .expect(400);
      const waived = (
        await admin()
          .post(`/appointments/${id}/cancellation-fee/waive`, {
            reason: 'Hospitalización documentada',
          })
          .expect(201)
      ).body as FeeView;
      expect(waived).toMatchObject({
        status: 'WAIVED',
        fee: { waiveReason: 'Hospitalización documentada', amount: null },
      });
      const res = await admin()
        .post(`/appointments/${id}/cancellation-fee`)
        .expect(409);
      expect((res.body as { message: string }).message).toBe(
        CANCELLATION_FEE_MESSAGES.alreadyWaived,
      );
      const events = await raw.auditEvent.findMany({
        where: { tenantId: a.tenantId, resourceId: id },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'UPDATE',
        resourceType: 'APPOINTMENT',
        patientId: patient,
      });
      expect(events[0].metadata).toMatchObject({
        reason: 'CANCELLATION_FEE_WAIVED',
      });
      expect(JSON.stringify(events[0].metadata)).not.toContain(
        'Hospitalización',
      );
    });
  });

  describe('GET /locations/:id/cancellation-policy/email-preview', () => {
    it('ADMIN ve el recordatorio con la política vigente; el resto, 403', async () => {
      const res = await admin()
        .get(`/locations/${principal}/cancellation-policy/email-preview`)
        .expect(200);
      const body = res.body as { subject: string; html: string; text: string };
      expect(body.subject).toContain('Recordatorio');
      expect(body.text).toContain('avísanos con al menos 24 h de antelación');
      expect(body.text).toContain(POLICY_TEXT);
      expect(body.html).toContain('Política de cancelación');
      await api(a, tokens.RECEPTION!)
        .get(`/locations/${principal}/cancellation-policy/email-preview`)
        .expect(403);
      await api(b, b.adminToken)
        .get(`/locations/${principal}/cancellation-policy/email-preview`)
        .expect(404);
    });
  });
});
