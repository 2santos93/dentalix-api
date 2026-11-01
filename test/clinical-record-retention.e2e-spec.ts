import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { RETENTION_CLOCK } from '../src/modules/patients/application/use-cases/retention.use-cases';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';

// DX-039 · retención de la HC de punta a punta: 409
// CLINICAL_RECORD_RETENTION al archivar, solo ADMIN para retención y
// supresión parcial (403 al resto), aislamiento entre clínicas y rastro de
// auditoría (quién y cuándo, sin el motivo libre).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const REASON = 'Solicitud del paciente sobre sus datos';

interface PatientBody {
  id: string;
  lastAttentionAt: string | null;
  retentionExtended: string;
  retentionUntil: string | null;
  clinicRetentionYears: number;
  retentionFromPreviousTerm: boolean;
  underRetention: boolean;
  phone: string | null;
  email: string | null;
  notes: string | null;
  partiallySuppressedAt: string | null;
}

afterAll(async () => {
  await raw.$disconnect();
});

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
    expect(detail.retentionUntil?.slice(0, 4)).toBe(
      String(year + detail.clinicRetentionYears),
    );

    const res = await call(a, 'delete', `/patients/${p}`, a.adminToken).expect(
      409,
    );
    expect(res.body).toMatchObject({
      code: 'CLINICAL_RECORD_RETENTION',
      retentionUntil: detail.retentionUntil,
    });
    expect((res.body as { message: string }).message).toMatch(
      /retención hasta el \d{2}\/\d{2}\/\d{4}/,
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
    expect(detail.retentionUntil).toBe(
      `${2020 + detail.clinicRetentionYears}-01-15`,
    );
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
    expect(JSON.stringify(event.metadata)).not.toContain(REASON);
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

// DX-330 · plazo de conservación de la HC por clínica, en HTTP real. Clínicas
// propias: el PUT cambia el plazo de la clínica y los `describe` de arriba
// dan por hecho el de plataforma.
describe('ajustes de conservación (DX-330)', () => {
  const SETTINGS = '/api/v1/patients/retention/settings';
  const HOUR = 60 * 60 * 1000;

  interface SettingsBody {
    clinicalRecordRetentionYears: number;
    effectiveYears: number;
    platformMinimumYears: number;
    maximumYears: number;
    correctionWindow: { previousYears: number; until: string } | null;
    protectedPatients?: number;
  }
  interface AuditItem {
    metadata: {
      reason?: string;
      configChange?: {
        before: { clinicalRecordRetentionYears: number };
        after: { clinicalRecordRetentionYears: number };
      };
      retentionTermChange?: {
        direction: string;
        protectedPatients: number;
        withinCorrectionWindow: boolean;
      };
    };
  }

  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let patientId: string;
  let clock: Date | null = null;
  const tokens = {} as Record<'DENTIST' | 'ASSISTANT' | 'RECEPTION', string>;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic, token = clinic.adminToken) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const get = (clinic: Clinic, token?: string) =>
    as(api().get(SETTINGS), clinic, token);
  const put = (clinic: Clinic, body: object, token?: string) =>
    as(api().put(SETTINGS), clinic, token).send(body);
  const read = async (clinic: Clinic): Promise<SettingsBody> =>
    (await get(clinic).expect(200)).body as SettingsBody;
  const detail = async (id: string): Promise<PatientBody> =>
    (await as(api().get(`/api/v1/patients/${id}`), a).expect(200))
      .body as PatientBody;
  const termEvents = async (clinic: Clinic): Promise<AuditItem[]> =>
    (
      (
        await as(
          api().get('/api/v1/audit-events?resourceType=CLINIC_SETTINGS'),
          clinic,
        ).expect(200)
      ).body as { items: AuditItem[] }
    ).items.filter(
      (i) => i.metadata.reason === 'CLINICAL_RECORD_RETENTION_SETTINGS',
    );

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder
          .overrideProvider(RETENTION_CLOCK)
          .useValue(() => clock ?? new Date()),
    });
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx330-a');
    b = await registerClinic(app, 'dx330-b');
    for (const role of ['DENTIST', 'ASSISTANT', 'RECEPTION'] as const) {
      tokens[role] = await loginAs(
        app,
        a.host,
        (await seedMember(raw, a, role)).email,
      );
    }
    patientId = (
      await raw.patient.create({
        data: {
          tenantId: a.tenantId,
          firstName: 'Conservada',
          lastName: 'Prueba',
        },
      })
    ).id;
    await raw.$executeRawUnsafe(
      `UPDATE "patients" SET "last_attention_at" = '2020-01-15' WHERE id = '${patientId}'`,
    );
  });

  // Cada `it` parte del mismo estado (plazo de plataforma, sin ventana ni
  // suelos, reloj real) y no depende de otro: el orden no importa.
  beforeEach(async () => {
    clock = null;
    await raw.tenant.updateMany({
      where: { id: { in: [a.tenantId, b.tenantId] } },
      data: {
        clinicalRecordRetentionYears: 15,
        clinicalRecordRetentionRaisedAt: null,
        clinicalRecordRetentionYearsBeforeRaise: null,
      },
    });
    await raw.patient.update({
      where: { id: patientId },
      data: { retentionFloorUntil: null },
    });
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
  });

  it('every role reads the term and a new clinic starts at the platform minimum', async () => {
    for (const token of [
      a.adminToken,
      tokens.DENTIST,
      tokens.ASSISTANT,
      tokens.RECEPTION,
    ]) {
      const res = await get(a, token).expect(200);
      expect(res.body).toStrictEqual({
        clinicalRecordRetentionYears: 15,
        effectiveYears: 15,
        platformMinimumYears: 15,
        maximumYears: 100,
        correctionWindow: null,
      });
    }
  });

  it('GET /patients/retention/settings is not shadowed by GET /patients/:id', async () => {
    // Con `:id` delante iría a la ficha de un paciente «retention»: 400 por el
    // UUID, o una ficha y su VIEW de PATIENT. Se mira solo lo que deja ESTA
    // petición.
    const views = () =>
      raw.auditEvent.count({
        where: {
          tenantId: a.tenantId,
          resourceType: 'PATIENT',
          action: 'VIEW',
        },
      });
    const before = await views();
    const res = await get(a, tokens.RECEPTION).expect(200);
    expect(res.body).toHaveProperty('effectiveYears', 15);
    expect(await views()).toBe(before);
  });

  it.each(['DENTIST', 'ASSISTANT', 'RECEPTION'] as const)(
    '%s gets 403 on PUT and the term stays',
    async (role) => {
      const res = await put(
        a,
        { clinicalRecordRetentionYears: 20 },
        tokens[role],
      ).expect(403);
      expect((res.body as { message: string }).message).toBe(
        'Solo un administrador puede cambiar el plazo de conservación.',
      );
      expect((await read(a)).clinicalRecordRetentionYears).toBe(15);
    },
  );

  it.each([14, 101, 15.5, 'veinte'])(
    'PUT with %p is a 400 and writes nothing',
    async (value) => {
      const eventsBefore = (await termEvents(a)).length;
      const res = await put(a, { clinicalRecordRetentionYears: value }).expect(
        400,
      );
      if (value === 14 || value === 101) {
        expect((res.body as { message: string }).message).toContain(
          'entre 15 y 100',
        );
      }
      expect((await read(a)).clinicalRecordRetentionYears).toBe(15);
      expect(await termEvents(a)).toHaveLength(eventsBefore);
    },
  );

  it('a raise is applied, opens the window and reaches the patient record', async () => {
    clock = new Date();
    const res = await put(a, { clinicalRecordRetentionYears: 20 }).expect(200);
    expect(res.body).toMatchObject({
      clinicalRecordRetentionYears: 20,
      effectiveYears: 20,
      protectedPatients: 0,
      correctionWindow: {
        previousYears: 15,
        until: new Date(clock.getTime() + 24 * HOUR).toISOString(),
      },
    });
    const record = await detail(patientId);
    expect(record.clinicRetentionYears).toBe(20);
    expect(record.retentionUntil).toBe('2040-01-15');
    await as(api().delete(`/api/v1/patients/${patientId}`), a).expect(409);
  });

  it('correcting the raise inside the window fixes no date and closes it', async () => {
    clock = new Date();
    await put(a, { clinicalRecordRetentionYears: 20 }).expect(200);
    clock = new Date(clock.getTime() + 2 * HOUR);
    const unconfirmed = await put(a, {
      clinicalRecordRetentionYears: 15,
    }).expect(409);
    expect(unconfirmed.body).toMatchObject({
      code: 'RETENTION_REDUCTION_UNCONFIRMED',
      previousYears: 20,
      newYears: 15,
      protectedPatients: 0,
      withinCorrectionWindow: true,
    });
    expect((unconfirmed.body as { message: string }).message).toMatch(
      /^Estás corrigiendo una subida de hace menos de 24 horas/,
    );
    expect((await read(a)).clinicalRecordRetentionYears).toBe(20);

    const res = await put(a, {
      clinicalRecordRetentionYears: 15,
      confirmReduction: true,
    }).expect(200);
    expect(res.body).toMatchObject({
      clinicalRecordRetentionYears: 15,
      protectedPatients: 0,
      correctionWindow: null,
    });
    expect((await read(a)).correctionWindow).toBeNull();
    const record = await detail(patientId);
    expect(record.retentionUntil).toBe('2035-01-15');
    expect(record.retentionFromPreviousTerm).toBe(false);
  });

  it('a reduction outside the window marks retentionFromPreviousTerm', async () => {
    clock = new Date();
    await put(a, { clinicalRecordRetentionYears: 20 }).expect(200);
    clock = new Date(clock.getTime() + 25 * HOUR);
    expect((await read(a)).correctionWindow).toBeNull();

    const unconfirmed = await put(a, {
      clinicalRecordRetentionYears: 15,
    }).expect(409);
    expect(unconfirmed.body).toMatchObject({
      code: 'RETENTION_REDUCTION_UNCONFIRMED',
      previousYears: 20,
      newYears: 15,
      protectedPatients: 1,
      withinCorrectionWindow: false,
    });
    expect((unconfirmed.body as { message: string }).message).toContain(
      '1 historia que hoy se conserva con 20 años mantiene su fecha de fin',
    );
    expect((await read(a)).clinicalRecordRetentionYears).toBe(20);
    expect(
      (await raw.patient.findUniqueOrThrow({ where: { id: patientId } }))
        .retentionFloorUntil,
    ).toBeNull();

    const res = await put(a, {
      clinicalRecordRetentionYears: 15,
      confirmReduction: true,
    }).expect(200);
    expect(res.body).toMatchObject({
      clinicalRecordRetentionYears: 15,
      protectedPatients: 1,
    });
    const record = await detail(patientId);
    expect(record.clinicRetentionYears).toBe(15);
    expect(record.retentionUntil).toBe('2040-01-15');
    expect(record.retentionFromPreviousTerm).toBe(true);
  });

  it('a repeated confirmed reduction is a no-op', async () => {
    clock = new Date();
    await put(a, { clinicalRecordRetentionYears: 20 }).expect(200);
    clock = new Date(clock.getTime() + 25 * HOUR);
    await put(a, {
      clinicalRecordRetentionYears: 15,
      confirmReduction: true,
    }).expect(200);
    const eventsBefore = (await termEvents(a)).length;
    const res = await put(a, {
      clinicalRecordRetentionYears: 15,
      confirmReduction: true,
    }).expect(200);
    expect(res.body).toMatchObject({
      clinicalRecordRetentionYears: 15,
      protectedPatients: 0,
    });
    expect(await termEvents(a)).toHaveLength(eventsBefore);
    expect((await detail(patientId)).retentionUntil).toBe('2040-01-15');
  });

  it('a raise ignores confirmReduction: true', async () => {
    clock = new Date();
    const res = await put(a, {
      clinicalRecordRetentionYears: 20,
      confirmReduction: true,
    }).expect(200);
    expect(res.body).toMatchObject({
      clinicalRecordRetentionYears: 20,
      protectedPatients: 0,
    });
    expect(
      (await raw.patient.findUniqueOrThrow({ where: { id: patientId } }))
        .retentionFloorUntil,
    ).toBeNull();
    expect((await read(a)).correctionWindow).not.toBeNull();
  });

  it('the audit log shows one event per real change', async () => {
    const eventsBefore = (await termEvents(a)).length;
    clock = new Date();
    await put(a, { clinicalRecordRetentionYears: 20 }).expect(200);
    clock = new Date(clock.getTime() + 2 * HOUR);
    await put(a, {
      clinicalRecordRetentionYears: 15,
      confirmReduction: true,
    }).expect(200);
    await put(a, { clinicalRecordRetentionYears: 20 }).expect(200);
    clock = new Date(clock.getTime() + 25 * HOUR);
    await put(a, {
      clinicalRecordRetentionYears: 15,
      confirmReduction: true,
    }).expect(200);
    // Sin cambio: ni evento.
    await put(a, {
      clinicalRecordRetentionYears: 15,
      confirmReduction: true,
    }).expect(200);

    const events = await termEvents(a);
    // 15→20, 20→15 (ventana), 15→20, 20→15 (fuera de la ventana).
    expect(events).toHaveLength(eventsBefore + 4);
    expect(events.map((e) => e.metadata.retentionTermChange)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'DOWN',
          protectedPatients: 1,
          withinCorrectionWindow: false,
        }),
        expect.objectContaining({
          direction: 'DOWN',
          protectedPatients: 0,
          withinCorrectionWindow: true,
        }),
        expect.objectContaining({ direction: 'UP', protectedPatients: 0 }),
      ]),
    );
    for (const event of events) {
      expect(event.metadata.configChange?.before).toBeDefined();
      expect(event.metadata.configChange?.after).toBeDefined();
    }
  });

  it('clinic B neither sees nor changes the term of clinic A', async () => {
    const eventsBefore = (await termEvents(b)).length;
    await put(b, { clinicalRecordRetentionYears: 30 }).expect(200);
    expect((await read(b)).clinicalRecordRetentionYears).toBe(30);
    expect((await read(a)).clinicalRecordRetentionYears).toBe(15);
    await put(a, { clinicalRecordRetentionYears: 25 }).expect(200);
    expect((await read(b)).clinicalRecordRetentionYears).toBe(30);
    expect(await termEvents(b)).toHaveLength(eventsBefore + 1);
  });
});
