import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import { createE2eApp } from './support/create-e2e-app';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';

// DX-263 · Citas futuras con la hoja de citas del importador, en HTTP real:
// plantilla, dry-run con las MISMAS reglas que agendar a mano (solape del
// profesional y del paciente contra la agenda y dentro del archivo, horario
// de la sede, bloqueos, festivos, profesional desconocido o que no atiende en
// la sede, citas pasadas) y errores por fila en español SIN escribir;
// confirmación con una cita creada a mano mientras importa; las citas en la
// agenda de su sede como «Programada»; recordatorios retenidos hasta
// activarlos; deshacer que retira solo las que siguen programadas; solo
// ADMIN; auditoría sin datos de la cita y aislamiento entre clínicas.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Issue {
  row: number;
  column: string | null;
  kind: string;
  message: string;
  value: string | null;
}

interface AppointmentsView {
  fileName: string;
  fileSha256: string;
  totalRows: number;
  preparedCount: number;
  errorRows: number;
  progress: { processed: number; created: number; failed: number };
  live: number;
  undoneCount: number | null;
  remindersEnabledAt: string | null;
  canUndo: boolean;
}

interface Batch {
  id: string;
  status: string;
  canConfirm: boolean;
  appointments: AppointmentsView | null;
  appointmentIssues: Issue[];
  appointmentIssuesTotal: number;
  progress: { percent: number };
}

const PATIENTS_HEADER = 'tipo_documento;numero_documento;nombres;apellidos';
const APPOINTMENTS_HEADER =
  'numero_documento;fecha;hora;duracion_min;email_profesional;sede;tipo_cita;motivo';

const csv = (header: string, lines: string[]) =>
  Buffer.from(`${header}\n${lines.join('\n')}\n`, 'utf8');

/** Día civil en la zona de la sede (America/Caracas, UTC−4 todo el año). */
function caracasDay(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
  }).format(d);
}
const ddmmyyyy = (iso: string) => iso.split('-').reverse().join('/');
const caracas = (day: string, hhmm: string) =>
  new Date(`${day}T${hhmm}:00-04:00`);

describe('Citas futuras — hoja de citas del importador (DX-263, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let reception: string;
  let dentist: { userId: string; email: string };
  let receptionEmail: string;
  let restrictedDentistEmail: string;
  let mainLocationId: string;
  let mainLocationName: string;
  let existingPatientId: string;
  let batch: Batch;

  const DAY = caracasDay(3);
  const HOLIDAY = caracasDay(4);
  const YESTERDAY = caracasDay(-1);

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, clinic: Clinic = a) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const attach = (
    path: string,
    bytes: Buffer,
    filename: string,
    token = a.adminToken,
    clinic = a,
  ) =>
    as(api().post(`/api/v1/patient-imports${path}`), token, clinic).attach(
      'file',
      bytes,
      { filename, contentType: 'text/csv' },
    );
  const getBatch = async (id: string): Promise<Batch> =>
    (
      await as(api().get(`/api/v1/patient-imports/${id}`), a.adminToken).expect(
        200,
      )
    ).body as Batch;
  const drain = () => app.get(JobWorker).drain();
  const agenda = async () =>
    (
      await as(
        api()
          .get('/api/v1/appointments')
          .query({
            from: caracas(DAY, '00:00').toISOString(),
            to: caracas(caracasDay(4), '00:00').toISOString(),
          }),
        a.adminToken,
      )
        .set('X-Location-Id', mainLocationId)
        .expect(200)
    ).body as {
      id: string;
      patientId: string;
      providerId: string;
      locationId: string;
      start: string;
      status: string;
      reason: string | null;
    }[];

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx263-e2e');
    b = await registerClinic(app, 'dx263-e2e-otra');
    const receptionMember = await seedMember(raw, a, ClinicRole.RECEPTION);
    receptionEmail = receptionMember.email;
    reception = await loginAs(app, a.host, receptionEmail);
    dentist = await seedMember(raw, a, ClinicRole.DENTIST);

    const locations = await as(
      api().get('/api/v1/locations'),
      a.adminToken,
    ).expect(200);
    const main = (locations.body as { id: string; name: string }[])[0];
    mainLocationId = main.id;
    mainLocationName = main.name;
    // Horario de la sede: 08:00–18:00 todos los días.
    await as(api().put('/api/v1/locations/schedule'), a.adminToken)
      .set('X-Location-Id', mainLocationId)
      .send({
        ranges: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          startMinute: 8 * 60,
          endMinute: 18 * 60,
        })),
      })
      .expect(200);

    // DX-089: otra sede y una odontóloga que solo atiende en ella.
    const altamira = await raw.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId: a.tenantId,
        name: 'Sede Altamira',
      }),
    });
    restrictedDentistEmail = 'dentista.altamira@dx263-e2e.test';
    const restricted = await raw.user.create({
      data: {
        email: restrictedDentistEmail,
        passwordHash: 'x',
        fullName: 'Dra. Altamira',
        emailVerifiedAt: new Date(),
      },
    });
    const membership = await raw.clinicMembership.create({
      data: {
        tenantId: a.tenantId,
        userId: restricted.id,
        role: ClinicRole.DENTIST,
      },
    });
    await raw.membershipLocation.create({
      data: {
        tenantId: a.tenantId,
        membershipId: membership.id,
        locationId: altamira.id,
      },
    });

    // Tipo de cita, bloqueo del profesional y festivo de la sede.
    await raw.appointmentType.create({
      data: {
        tenantId: a.tenantId,
        name: 'Limpieza',
        durationMinutes: 45,
        color: '#22AA66',
      },
    });
    await raw.scheduleBlock.create({
      data: {
        tenantId: a.tenantId,
        providerId: dentist.userId,
        start: caracas(DAY, '13:00'),
        end: caracas(DAY, '14:00'),
        kind: 'MEETING',
        allowsBooking: false,
      },
    });
    await raw.locationHoliday.create({
      data: {
        tenantId: a.tenantId,
        locationId: mainLocationId,
        date: new Date(`${HOLIDAY}T00:00:00.000Z`),
        name: 'Festivo de prueba',
      },
    });

    // Un paciente que ya existía, con una cita a mano a las 10:00.
    const existing = await as(api().post('/api/v1/patients'), a.adminToken)
      .send({
        docType: 'NATIONAL_ID',
        docNumber: '900900',
        firstName: 'Ya',
        lastName: 'Existía',
        sex: 'UNSPECIFIED',
      })
      .expect(201);
    existingPatientId = (existing.body as { id: string }).id;
    await as(api().post('/api/v1/appointments'), a.adminToken)
      .set('X-Location-Id', mainLocationId)
      .send({
        patientId: existingPatientId,
        providerId: dentist.userId,
        start: caracas(DAY, '10:00').toISOString(),
        end: caracas(DAY, '10:30').toISOString(),
      })
      .expect(201);

    // Lote de pacientes (dry-run): dos nuevos y el que ya existe.
    const res = await attach(
      '',
      csv(PATIENTS_HEADER, [
        'NATIONAL_ID;111111;Ana;Migrada',
        'NATIONAL_ID;222222;Luis;Migrado',
        'NATIONAL_ID;900900;Ya;Existía',
      ]),
      'pacientes.csv',
    )
      .set('X-Location-Id', mainLocationId)
      .expect(201);
    batch = res.body as Batch;
    expect(batch.appointments).toBeNull();
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('plantilla de la hoja de citas: CSV con BOM, las columnas y una cita de ejemplo futura', async () => {
    const res = await as(
      api().get('/api/v1/patient-imports/appointments-template'),
      a.adminToken,
    )
      .set('X-Location-Id', mainLocationId)
      .expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const [header, example] = res.text.replace(/^﻿/, '').split('\r\n');
    expect(header).toBe(
      '"numero_documento","fecha","hora","duracion_min","email_profesional","sede","tipo_cita","motivo"',
    );
    expect(example).toContain(`"${ddmmyyyy(caracasDay(7))}","09:30","30"`);
  });

  it('solo ADMIN: recepción y odontología reciben 403 en español', async () => {
    const lines = csv(APPOINTMENTS_HEADER, [
      `111111;${ddmmyyyy(DAY)};09:00;30;${dentist.email};;;`,
    ]);
    const res = await attach(
      `/${batch.id}/appointments`,
      lines,
      'citas.csv',
      reception,
    ).expect(403);
    expect((res.body as { message: string }).message).toBe(
      'Solo un administrador de la clínica puede importar pacientes.',
    );
    const dentistToken = await loginAs(app, a.host, dentist.email);
    await attach(
      `/${batch.id}/appointments`,
      lines,
      'citas.csv',
      dentistToken,
    ).expect(403);
    await as(
      api().get('/api/v1/patient-imports/appointments-template'),
      reception,
    ).expect(403);
  });

  // ISOLATION_COVERS: POST /patient-imports/:id/appointments
  it('otra clínica no ve el lote: 404 al subirle citas', async () => {
    await attach(
      `/${batch.id}/appointments`,
      csv(APPOINTMENTS_HEADER, [
        `111111;${ddmmyyyy(DAY)};09:00;30;${dentist.email};;;`,
      ]),
      'citas.csv',
      b.adminToken,
      b,
    ).expect(404);
  });

  it('una hoja sin la columna de la hora: 400 en español', async () => {
    const res = await attach(
      `/${batch.id}/appointments`,
      csv('numero_documento;fecha;email_profesional', [
        `111111;${ddmmyyyy(DAY)};${dentist.email}`,
      ]),
      'citas.csv',
    ).expect(400);
    expect((res.body as { message: string }).message).toMatch(
      /^A la hoja de citas le falta la columna «Hora»/,
    );
  });

  it('dry-run: las reglas de agendar a mano, fila a fila y en español, sin crear ninguna cita', async () => {
    const d = ddmmyyyy(DAY);
    const res = await attach(
      `/${batch.id}/appointments`,
      csv(APPOINTMENTS_HEADER, [
        /* 2 */ `111111;${d};09:00;30;${dentist.email};;;Control`,
        /* 3 */ `222222;${d};09:15;30;${dentist.email};;;`,
        /* 4 */ `900900;${d};10:00;30;owner@${a.subdomain}.test;;;`,
        /* 5 */ `111111;${d};10:15;30;${dentist.email};;;`,
        /* 6 */ `222222;${d};07:00;30;${dentist.email};;;`,
        /* 7 */ `222222;${d};12:00;30;desconocido@otra.test;;;`,
        /* 8 */ `222222;${ddmmyyyy(HOLIDAY)};09:00;30;${dentist.email};;;`,
        /* 9 */ `222222;${d};13:00;30;${dentist.email};;;`,
        /* 10 */ `999999;${d};15:00;30;${dentist.email};;;`,
        /* 11 */ `222222;${d};16:00;;${dentist.email};;Limpieza;Limpieza semestral`,
        /* 12 */ `900900;${ddmmyyyy(YESTERDAY)};09:00;30;${dentist.email};;;`,
        /* 13 */ `222222;${d};17:00;30;${receptionEmail};;;`,
        /* 14 */ `900900;${d};11:00;30;${dentist.email};${mainLocationName};;`,
        /* 15 */ `222222;${d};11:00;30;${restrictedDentistEmail};${mainLocationName};;`,
        /* 16 */ `222222;${d};11:30;30;${dentist.email};Sede Inexistente;;`,
      ]),
      'citas.csv',
    ).expect(201);
    const view = res.body as Batch;
    expect(view.appointments).toMatchObject({
      fileName: 'citas.csv',
      totalRows: 15,
      preparedCount: 3,
      errorRows: 12,
      progress: { processed: 0, created: 0, failed: 0 },
      live: 0,
      remindersEnabledAt: null,
    });
    const errors = view.appointmentIssues
      .filter((i) => i.kind === 'ERROR')
      .map((i) => [i.row, i.message]);
    expect(errors).toEqual([
      [
        3,
        'Se solapa con la cita de la fila 2 del archivo: el profesional ya tiene una cita a esa hora.',
      ],
      [4, expect.stringMatching(/paciente/i)],
      [5, expect.stringMatching(/profesional/i)],
      [6, expect.stringMatching(/horario/i)],
      [
        7,
        'Nadie del equipo de la clínica tiene el email «desconocido@otra.test»: la cita no se asigna a otro profesional.',
      ],
      [8, 'Ese día la sede está cerrada por festivo: elige otro día.'],
      [9, expect.stringMatching(/bloque/i)],
      [
        10,
        'No hay ningún paciente con este documento en la clínica ni en el archivo de pacientes del lote.',
      ],
      [12, 'La cita ya pasó: solo se importan citas futuras.'],
      [
        13,
        'Ese miembro del equipo no atiende pacientes: no tiene agenda propia.',
      ],
      [15, 'Algún profesional no atiende en esta sede.'],
      [
        16,
        'No hay ninguna sede activa llamada «Sede Inexistente» en la clínica.',
      ],
    ]);
    // Todos los mensajes en español (ninguno del framework en inglés).
    for (const issue of view.appointmentIssues) {
      expect(issue.message).not.toMatch(/\b(the|not found|overlap)\b/i);
    }
    expect(view.appointmentIssues).toContainEqual(
      expect.objectContaining({
        row: 11,
        kind: 'WARNING',
        message:
          'Sin duración en el archivo: se usan los 45 minutos del tipo «Limpieza».',
      }),
    );
    // Nada escrito: ni citas importadas ni pacientes.
    expect(
      await raw.appointment.count({
        where: { tenantId: a.tenantId, importBatchId: { not: null } },
      }),
    ).toBe(0);
    expect(
      await raw.patientImportAppointmentRow.count({
        where: { batchId: batch.id },
      }),
    ).toBe(3);
  });

  // ISOLATION_COVERS: GET /patient-imports/:id/appointments/errors.csv
  it('informe de la hoja de citas: CSV con los motivos; otra clínica 404', async () => {
    const res = await as(
      api().get(`/api/v1/patient-imports/${batch.id}/appointments/errors.csv`),
      a.adminToken,
    ).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain(
      '"Ese día la sede está cerrada por festivo: elige otro día."',
    );
    expect(res.text).toContain('"Aviso"');
    await as(
      api().get(`/api/v1/patient-imports/${batch.id}/appointments/errors.csv`),
      b.adminToken,
      b,
    ).expect(404);
  });

  // ISOLATION_COVERS: DELETE /patient-imports/:id/appointments
  it('otra clínica no puede quitar la hoja de citas (sigue ahí)', async () => {
    await as(
      api().delete(`/api/v1/patient-imports/${batch.id}/appointments`),
      b.adminToken,
      b,
    ).expect(404);
    expect((await getBatch(batch.id)).appointments?.preparedCount).toBe(3);
  });

  it('las citas no se pueden retirar ni activar antes de importar el lote (409)', async () => {
    await as(
      api().post(`/api/v1/patient-imports/${batch.id}/appointments/undo`),
      a.adminToken,
    ).expect(409);
    await as(
      api().post(`/api/v1/patient-imports/${batch.id}/appointments/reminders`),
      a.adminToken,
    ).expect(409);
  });

  it('confirmar con una cita creada a mano mientras importa: solo esa fila se rechaza y el resto queda en la agenda como «Programada»', async () => {
    await as(
      api().post(`/api/v1/patient-imports/${batch.id}/confirm`),
      a.adminToken,
    )
      .send({ duplicateMode: 'SKIP' })
      .expect(200);
    // Recepción agenda a mano a las 16:15 mientras el lote está en cola: la
    // fila 11 (16:00–16:45) ya no cabe.
    const manual = await as(api().post('/api/v1/appointments'), a.adminToken)
      .set('X-Location-Id', mainLocationId)
      .send({
        patientId: existingPatientId,
        providerId: dentist.userId,
        start: caracas(DAY, '16:15').toISOString(),
        end: caracas(DAY, '16:45').toISOString(),
      })
      .expect(201);
    expect((manual.body as { id: string }).id).toBeDefined();
    await drain();

    const done = await getBatch(batch.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.progress.percent).toBe(100);
    expect(done.appointments).toMatchObject({
      progress: { processed: 3, created: 2, failed: 1 },
      live: 2,
      canUndo: true,
      remindersEnabledAt: null,
    });
    expect(done.appointmentIssues).toContainEqual(
      expect.objectContaining({
        row: 11,
        kind: 'ERROR',
        message: expect.stringMatching(/^Al importar: .*profesional/),
      }),
    );

    const ana = await raw.patient.findFirstOrThrow({
      where: { tenantId: a.tenantId, docNumber: '111111', deletedAt: null },
    });
    const list = await agenda();
    const imported = list.filter((x) =>
      [ana.id, existingPatientId].includes(x.patientId),
    );
    expect(
      imported
        .filter((x) => x.start !== caracas(DAY, '10:00').toISOString())
        .filter((x) => x.start !== caracas(DAY, '16:15').toISOString())
        .map((x) => [x.patientId, x.start, x.status, x.locationId, x.reason])
        .sort(),
    ).toEqual(
      [
        [
          ana.id,
          caracas(DAY, '09:00').toISOString(),
          'SCHEDULED',
          mainLocationId,
          'Control',
        ],
        [
          existingPatientId,
          caracas(DAY, '11:00').toISOString(),
          'SCHEDULED',
          mainLocationId,
          null,
        ],
      ].sort(),
    );
    const rows = await raw.appointment.findMany({
      where: { tenantId: a.tenantId, importBatchId: batch.id },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.providerId === dentist.userId)).toBe(true);
  });

  it('auditoría del lote: hash y contadores de la hoja de citas, sin datos de las citas', async () => {
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceType: 'PATIENT_IMPORT_BATCH',
        resourceId: batch.id,
      },
      orderBy: { occurredAt: 'asc' },
    });
    const validated = events.find(
      (e) =>
        (e.metadata as { reason?: string }).reason ===
        'IMPORT_APPOINTMENTS_VALIDATED',
    );
    expect(validated).toBeDefined();
    const meta = validated!.metadata as {
      importBatch: Record<string, unknown>;
    };
    expect(meta.importBatch).toMatchObject({
      appointmentRows: 15,
      appointmentErrors: 12,
      appointmentsPrepared: 3,
    });
    expect(meta.importBatch.appointmentFileSha256).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify(events.map((e) => e.metadata));
    expect(dump).not.toContain('111111');
    expect(dump).not.toContain(dentist.email);
    expect(dump).not.toContain('Limpieza semestral');
  });

  // ISOLATION_COVERS: POST /patient-imports/:id/appointments/reminders
  it('recordatorios retenidos hasta que el ADMIN los activa en el lote; otra clínica 404; recepción 403', async () => {
    await as(
      api().post(`/api/v1/patient-imports/${batch.id}/appointments/reminders`),
      b.adminToken,
      b,
    ).expect(404);
    await as(
      api().post(`/api/v1/patient-imports/${batch.id}/appointments/reminders`),
      reception,
    ).expect(403);
    const res = await as(
      api().post(`/api/v1/patient-imports/${batch.id}/appointments/reminders`),
      a.adminToken,
    ).expect(200);
    const enabledAt = (res.body as Batch).appointments?.remindersEnabledAt;
    expect(enabledAt).toEqual(expect.any(String));
    // Idempotente: la primera activación se conserva.
    const again = await as(
      api().post(`/api/v1/patient-imports/${batch.id}/appointments/reminders`),
      a.adminToken,
    ).expect(200);
    expect((again.body as Batch).appointments?.remindersEnabledAt).toBe(
      enabledAt,
    );
  });

  // ISOLATION_COVERS: POST /patient-imports/:id/appointments/undo
  it('deshacer el lote retira solo las citas del lote que siguen programadas', async () => {
    const existingImported = await raw.appointment.findFirstOrThrow({
      where: {
        tenantId: a.tenantId,
        importBatchId: batch.id,
        patientId: existingPatientId,
      },
    });
    // Recepción la confirma: cambió de estado, se queda.
    await as(
      api().patch(`/api/v1/appointments/${existingImported.id}`),
      a.adminToken,
    )
      .send({ status: 'CONFIRMED' })
      .expect(200);
    await as(
      api().post(`/api/v1/patient-imports/${batch.id}/appointments/undo`),
      b.adminToken,
      b,
    ).expect(404);

    // La cita importada (programada) de un paciente que creó el lote no
    // bloquea el deshacer: se retira con él.
    const res = await as(
      api().post(`/api/v1/patient-imports/${batch.id}/undo`),
      a.adminToken,
    ).expect(200);
    const undone = res.body as Batch;
    expect(undone.status).toBe('UNDONE');
    expect(undone.appointments).toMatchObject({ undoneCount: 1, live: 0 });

    const rows = await raw.appointment.findMany({
      where: { tenantId: a.tenantId, importBatchId: batch.id },
      orderBy: { start: 'asc' },
    });
    const ana = await raw.patient.findFirstOrThrow({
      where: { tenantId: a.tenantId, docNumber: '111111' },
    });
    expect(ana.deletedAt).not.toBeNull();
    expect(
      rows.map((r) => [r.patientId, r.status, r.deletedAt === null]),
    ).toEqual([
      [ana.id, 'SCHEDULED', false],
      [existingPatientId, 'CONFIRMED', true],
    ]);
    // La cita a mano y la importada confirmada siguen en la agenda.
    const list = await agenda();
    expect(list.map((x) => x.id)).toContain(existingImported.id);
    expect(
      list.filter((x) => x.start === caracas(DAY, '09:00').toISOString()),
    ).toEqual([]);
  });
});
