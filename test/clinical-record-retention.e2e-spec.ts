import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
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

// DX-039 · retención legal de la HC de punta a punta: 409
// CLINICAL_RECORD_RETENTION al archivar, solo ADMIN para retención y
// supresión parcial (403 al resto), aislamiento entre clínicas y rastro de
// auditoría (quién y cuándo, sin el motivo libre).
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const REASON = 'Reclamo del titular por Ley 1581';

interface PatientBody {
  id: string;
  lastAttentionAt: string | null;
  retentionExtended: string;
  retentionUntil: string | null;
  underRetention: boolean;
  phone: string | null;
  email: string | null;
  notes: string | null;
  partiallySuppressedAt: string | null;
}

describe('Retención legal de la historia clínica (DX-039, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let tokens: Record<'DENTIST' | 'ASSISTANT' | 'RECEPTION', string>;

  const http = () => request(app.getHttpServer());
  function call(
    clinic: Clinic,
    verb: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    token: string,
  ) {
    return http()
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  }

  async function createPatient(clinic: Clinic, name: string): Promise<string> {
    return (
      await raw.patient.create({
        data: {
          tenantId: clinic.tenantId,
          firstName: name,
          lastName: 'Prueba',
          phone: '3001112233',
          email: `${name.toLowerCase()}@example.com`,
          notes: 'Paga en efectivo',
        },
      })
    ).id;
  }

  async function attend(clinic: Clinic, patientId: string): Promise<void> {
    await call(
      clinic,
      'post',
      `/patients/${patientId}/clinical-entries`,
      clinic.adminToken,
    )
      .send({ notes: 'Control' })
      .expect(201);
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx039-a');
    b = await registerClinic(app, 'dx039-b');
    tokens = {
      DENTIST: await loginAs(
        app,
        a.host,
        (await seedMember(raw, a, 'DENTIST')).email,
      ),
      ASSISTANT: await loginAs(
        app,
        a.host,
        (await seedMember(raw, a, 'ASSISTANT')).email,
      ),
      RECEPTION: await loginAs(
        app,
        a.host,
        (await seedMember(raw, a, 'RECEPTION')).email,
      ),
    };
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await app.close();
  });

  it('un paciente sin atenciones clínicas se archiva (204) y deja de verse', async () => {
    const p = await createPatient(a, 'Duplicado');
    await call(a, 'delete', `/patients/${p}`, a.adminToken).expect(204);
    await call(a, 'get', `/patients/${p}`, a.adminToken).expect(404);
    const events = await raw.auditEvent.findMany({
      where: { tenantId: a.tenantId, action: 'DELETE', resourceId: p },
    });
    expect(events).toHaveLength(1);
  });

  it('un paciente con citas pendientes no se archiva (409) hasta cerrarlas', async () => {
    const p = await createPatient(a, 'ConCita');
    const location = await raw.location.findFirstOrThrow({
      where: { tenantId: a.tenantId },
    });
    const appt = await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: location.id,
        patientId: p,
        providerId: a.adminUserId,
        start: new Date('2099-03-10T15:00:00Z'),
        end: new Date('2099-03-10T15:30:00Z'),
        status: 'CONFIRMED',
      },
    });
    const res = await call(a, 'delete', `/patients/${p}`, a.adminToken).expect(
      409,
    );
    expect(res.body).toMatchObject({
      code: 'PATIENT_HAS_PENDING_APPOINTMENTS',
      pendingAppointments: 1,
    });
    expect((res.body as { message: string }).message).toMatch(/cita/);
    await raw.appointment.update({
      where: { id: appt.id },
      data: { status: 'CANCELLED' },
    });
    await call(a, 'delete', `/patients/${p}`, a.adminToken).expect(204);
  });

  it('un id que no es UUID da 400, no 500', async () => {
    await call(a, 'delete', '/patients/no-es-uuid', a.adminToken).expect(400);
    await call(a, 'patch', '/patients/no-es-uuid/retention', a.adminToken)
      .send({ retentionExtended: 'DOUBLE', reason: REASON })
      .expect(400);
    await call(
      a,
      'post',
      '/patients/no-es-uuid/partial-suppression',
      a.adminToken,
    )
      .send({ reason: REASON })
      .expect(400);
  });

  it('con una evolución: el detalle expone la retención y archivar da 409 en español', async () => {
    const p = await createPatient(a, 'Retenida');
    await attend(a, p);
    const detail = (
      await call(a, 'get', `/patients/${p}`, a.adminToken).expect(200)
    ).body as PatientBody;
    expect(detail.lastAttentionAt).not.toBeNull();
    expect(detail.retentionExtended).toBe('NONE');
    expect(detail.underRetention).toBe(true);
    const year = new Date(detail.lastAttentionAt as string).getUTCFullYear();
    expect(detail.retentionUntil?.slice(0, 4)).toBe(String(year + 15));

    const res = await call(a, 'delete', `/patients/${p}`, a.adminToken).expect(
      409,
    );
    expect(res.body).toMatchObject({
      code: 'CLINICAL_RECORD_RETENTION',
      retentionUntil: detail.retentionUntil,
    });
    expect((res.body as { message: string }).message).toMatch(
      /retención legal hasta el \d{2}\/\d{2}\/\d{4}/,
    );
    await call(a, 'get', `/patients/${p}`, a.adminToken).expect(200);
  });

  it('una cita atendida también pone la HC en retención', async () => {
    const p = await createPatient(a, 'Cita');
    const location = await raw.location.findFirstOrThrow({
      where: { tenantId: a.tenantId },
    });
    await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: location.id,
        patientId: p,
        providerId: a.adminUserId,
        start: new Date('2020-01-15T15:00:00Z'),
        end: new Date('2020-01-15T15:30:00Z'),
        status: 'COMPLETED',
      },
    });
    const detail = (
      await call(a, 'get', `/patients/${p}`, a.adminToken).expect(200)
    ).body as PatientBody;
    expect(detail.retentionUntil).toBe('2035-01-15');
    await call(a, 'delete', `/patients/${p}`, a.adminToken).expect(409);
  });

  it.each(['DENTIST', 'ASSISTANT', 'RECEPTION'] as const)(
    '%s recibe 403 al archivar, cambiar la retención o suprimir',
    async (role) => {
      const p = await createPatient(a, `Rol${role}`);
      await call(a, 'delete', `/patients/${p}`, tokens[role]).expect(403);
      await call(a, 'patch', `/patients/${p}/retention`, tokens[role])
        .send({ retentionExtended: 'PERMANENT', reason: REASON })
        .expect(403);
      await call(a, 'post', `/patients/${p}/partial-suppression`, tokens[role])
        .send({ reason: REASON })
        .expect(403);
      await call(a, 'get', '/patients/retention/expiring', tokens[role]).expect(
        403,
      );
      const row = await raw.patient.findUniqueOrThrow({ where: { id: p } });
      expect(row.retentionExtended).toBe('NONE');
      expect(row.deletedAt).toBeNull();
    },
  );

  it('ADMIN cambia la retención a PERMANENT: queda quién y cuándo, y ya no se archiva', async () => {
    const p = await createPatient(a, 'Permanente');
    await call(a, 'patch', `/patients/${p}/retention`, a.adminToken)
      .send({ retentionExtended: 'PERMANENT', reason: 'corto' })
      .expect(400);
    const res = await call(a, 'patch', `/patients/${p}/retention`, a.adminToken)
      .send({ retentionExtended: 'PERMANENT', reason: REASON })
      .expect(200);
    expect(res.body).toMatchObject({
      retentionExtended: 'PERMANENT',
      retentionUntil: null,
      underRetention: true,
    });
    const del = await call(a, 'delete', `/patients/${p}`, a.adminToken).expect(
      409,
    );
    expect((del.body as { message: string }).message).toContain('permanente');

    const actions = await raw.patientRetentionAction.findMany({
      where: { patientId: p },
    });
    expect(actions).toEqual([
      expect.objectContaining({
        kind: 'EXTENSION_CHANGED',
        previousExtension: 'NONE',
        newExtension: 'PERMANENT',
        reason: REASON,
        actorId: a.adminUserId,
      }),
    ]);
    const [event] = await raw.auditEvent.findMany({
      where: { tenantId: a.tenantId, resourceId: p, action: 'UPDATE' },
    });
    expect(event).toMatchObject({ actorUserId: a.adminUserId });
    expect(event.metadata).toMatchObject({
      reason: 'RETENTION_EXTENSION_CHANGED',
    });
    expect(JSON.stringify(event.metadata)).not.toContain('Ley 1581');
  });

  it('supresión parcial: vacía lo no clínico, conserva la HC; sin retención da 409', async () => {
    const free = await createPatient(a, 'Libre');
    const conflict = await call(
      a,
      'post',
      `/patients/${free}/partial-suppression`,
      a.adminToken,
    )
      .send({ reason: REASON })
      .expect(409);
    expect(conflict.body).toMatchObject({ code: 'NOT_UNDER_RETENTION' });

    const p = await createPatient(a, 'Suprimida');
    await attend(a, p);
    const res = await call(
      a,
      'post',
      `/patients/${p}/partial-suppression`,
      a.adminToken,
    )
      .send({ reason: REASON })
      .expect(200);
    const body = res.body as PatientBody;
    expect(body).toMatchObject({ phone: null, email: null, notes: null });
    expect(body.partiallySuppressedAt).not.toBeNull();
    const entries = await call(
      a,
      'get',
      `/patients/${p}/clinical-entries`,
      a.adminToken,
    ).expect(200);
    expect(JSON.stringify(entries.body)).toContain('Control');
    const event = await raw.auditEvent.findFirstOrThrow({
      where: { tenantId: a.tenantId, resourceId: p, action: 'UPDATE' },
    });
    expect(event.metadata).toMatchObject({ reason: 'PARTIAL_SUPPRESSION' });
  });

  it('otra clínica no ve ni toca el paciente (404)', async () => {
    const p = await createPatient(a, 'Ajeno');
    await call(b, 'delete', `/patients/${p}`, b.adminToken).expect(404);
    await call(b, 'patch', `/patients/${p}/retention`, b.adminToken)
      .send({ retentionExtended: 'NONE', reason: REASON })
      .expect(404);
    await call(b, 'post', `/patients/${p}/partial-suppression`, b.adminToken)
      .send({ reason: REASON })
      .expect(404);
  });

  it('historias que salen de retención: solo las vencidas o por vencer, paginadas', async () => {
    const old = await createPatient(b, 'Vencida');
    await raw.$executeRawUnsafe(
      `UPDATE "patients" SET "last_attention_at" = '2005-01-01' WHERE id = '${old}'`,
    );
    const recent = await createPatient(b, 'Reciente');
    await attend(b, recent);
    const res = await call(
      b,
      'get',
      '/patients/retention/expiring?withinDays=30&pageSize=500',
      b.adminToken,
    ).expect(200);
    const body = res.body as { items: PatientBody[]; pageSize: number };
    expect(body.items.map((i) => i.id)).toEqual([old]);
    expect(body.pageSize).toBe(50);
  });
});
