import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
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
import { setLocationZone } from './support/location-fixtures';

// DX-121 en HTTP real: tipos de cita (CRUD solo ADMIN, borrado lógico), agendar
// con tipo, la agenda por columnas (`providerIds[]`) y mover una cita de hora y
// de profesional con sus reglas (409 / 422), la anulación del enlace de
// confirmación y el `audit_event` con el antes y el después.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = new Date(Date.now() + 3 * DAY_MS).toISOString().slice(0, 10);
function at(time: string): string {
  return `${DAY}T${time}:00.000Z`;
}
const FROM = `${DAY}T00:00:00.000Z`;
const TO = new Date(new Date(FROM).getTime() + DAY_MS).toISOString();

interface TypeBody {
  id: string;
  name: string;
  durationMinutes: number;
  color: string;
  active: boolean;
}

interface AppointmentBody {
  id: string;
  providerId: string;
  start: string;
  end: string;
  locationId: string;
  appointmentTypeId: string | null;
  appointmentType: {
    id: string;
    name: string;
    durationMinutes: number;
    color: string;
  } | null;
  confirmationSentAt: string | null;
}

describe('Tipos de cita y agenda en columnas (e2e, DX-121)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let dentist: { userId: string; token: string };
  let reception: { userId: string; token: string };
  let patientId: string;
  let secondPatientId: string;

  const api = () => request(app.getHttpServer());
  const as = (
    req: request.Test,
    token: string,
    host = clinic.host,
  ): request.Test =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  async function createPatient(c: Clinic, doc: string): Promise<string> {
    const res = await as(api().post('/api/v1/patients'), c.adminToken, c.host)
      .send({
        firstName: 'Ana',
        lastName: 'Paciente',
        docType: 'NATIONAL_ID',
        docNumber: doc,
        sex: 'F',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function createType(
    body: Partial<TypeBody> & { name: string },
  ): Promise<TypeBody> {
    const res = await as(
      api().post('/api/v1/appointment-types'),
      clinic.adminToken,
    )
      .send({ durationMinutes: 30, color: '#0E7490', ...body })
      .expect(201);
    return res.body as TypeBody;
  }

  async function book(
    payload: Record<string, unknown>,
  ): Promise<AppointmentBody> {
    const res = await as(api().post('/api/v1/appointments'), reception.token)
      .send({ patientId, providerId: clinic.adminUserId, ...payload })
      .expect(201);
    return res.body as AppointmentBody;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx121-e2e');
    other = await registerClinic(app, 'dx121-e2e-otra');
    // El horario de abajo se fija en UTC: la zona es dato de la sede.
    const main = await raw.location.findFirstOrThrow({
      where: { tenantId: clinic.tenantId },
    });
    await setLocationZone(raw, clinic.tenantId, main.id, 'UTC');
    const d = await seedMember(raw, clinic, ClinicRole.DENTIST);
    dentist = {
      userId: d.userId,
      token: await loginAs(app, clinic.host, d.email),
    };
    const r = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    reception = {
      userId: r.userId,
      token: await loginAs(app, clinic.host, r.email),
    };
    // Sede sin restricción de horario: los casos de abajo no dependen del día
    // de la corrida (el de 422 fija su propio horario).
    await as(api().put('/api/v1/locations/schedule'), clinic.adminToken)
      .send({ ranges: [] })
      .expect(200);
    patientId = await createPatient(clinic, '121001');
    secondPatientId = await createPatient(clinic, '121002');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('CRUD de tipos', () => {
    it('ADMIN crea, edita y lista; el color se normaliza a mayúsculas', async () => {
      const created = await createType({
        name: 'Limpieza',
        durationMinutes: 45,
        color: '#16a34a',
      });
      expect(created).toMatchObject({ color: '#16A34A', active: true });

      const patched = await as(
        api().patch(`/api/v1/appointment-types/${created.id}`),
        clinic.adminToken,
      )
        .send({ durationMinutes: 40 })
        .expect(200);
      expect((patched.body as TypeBody).durationMinutes).toBe(40);

      const list = await as(
        api().get('/api/v1/appointment-types'),
        reception.token,
      ).expect(200);
      expect((list.body as TypeBody[]).map((t) => t.name)).toContain(
        'Limpieza',
      );
    });

    it('los demás roles leen pero no escriben (403)', async () => {
      await as(api().post('/api/v1/appointment-types'), dentist.token)
        .send({ name: 'X', durationMinutes: 30, color: '#0E7490' })
        .expect(403);
      await as(api().post('/api/v1/appointment-types'), reception.token)
        .send({ name: 'X', durationMinutes: 30, color: '#0E7490' })
        .expect(403);
    });

    it.each([
      [{ color: 'red' }, /#RRGGBB/],
      [{ color: '#0E7490; background:url(x)' }, /#RRGGBB/],
      [{ durationMinutes: 32 }, /múltiplo de 5/],
      [{ durationMinutes: 500 }, /múltiplo de 5/],
    ])('valida %j con 400 en español', async (override, message) => {
      const res = await as(
        api().post('/api/v1/appointment-types'),
        clinic.adminToken,
      )
        .send({
          name: 'Inválido',
          durationMinutes: 30,
          color: '#0E7490',
          ...override,
        })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(message);
    });

    it('nombre repetido: 409', async () => {
      await createType({ name: 'Urgencia' });
      await as(api().post('/api/v1/appointment-types'), clinic.adminToken)
        .send({ name: 'Urgencia', durationMinutes: 30, color: '#0E7490' })
        .expect(409);
    });

    // DX-133-bis: el único es sobre lower(btrim(name)) entre los vivos.
    it('nombre repetido con otras mayúsculas o espacios: 409 en español, al crear y al renombrar', async () => {
      await createType({ name: 'Blanqueamiento' });
      const res = await as(
        api().post('/api/v1/appointment-types'),
        clinic.adminToken,
      )
        .send({
          name: '  BLANQUEAMIENTO ',
          durationMinutes: 30,
          color: '#0E7490',
        })
        .expect(409);
      expect(JSON.stringify(res.body)).toContain(
        'Ya existe un tipo de cita con ese nombre.',
      );

      const other = await createType({ name: 'Profilaxis' });
      await as(
        api().patch(`/api/v1/appointment-types/${other.id}`),
        clinic.adminToken,
      )
        .send({ name: 'blanqueamiento' })
        .expect(409);
    });

    it('un nombre retirado (DELETE) se puede volver a usar con otras mayúsculas', async () => {
      const retired = await createType({ name: 'Sellantes' });
      await as(
        api().delete(`/api/v1/appointment-types/${retired.id}`),
        clinic.adminToken,
      ).expect(204);
      await createType({ name: 'SELLANTES' });
    });

    it('un tipo de otra clínica no existe aquí (404)', async () => {
      const foreign = await as(
        api().post('/api/v1/appointment-types'),
        other.adminToken,
        other.host,
      )
        .send({ name: 'Ajeno', durationMinutes: 30, color: '#0E7490' })
        .expect(201);
      await as(
        api().patch(
          `/api/v1/appointment-types/${(foreign.body as TypeBody).id}`,
        ),
        clinic.adminToken,
      )
        .send({ name: 'Robado' })
        .expect(404);
    });
  });

  describe('agendar con tipo', () => {
    it('«Endodoncia 90 min» fija la hora de fin; desactivarlo no cambia la cita y lo quita del selector', async () => {
      const endo = await createType({
        name: 'Endodoncia',
        durationMinutes: 90,
        color: '#7C3AED',
      });
      const appt = await book({
        start: at('08:00'),
        appointmentTypeId: endo.id,
      });
      expect(appt.end).toBe(at('09:30'));
      expect(appt.appointmentType).toEqual({
        id: endo.id,
        name: 'Endodoncia',
        durationMinutes: 90,
        color: '#7C3AED',
        // DX-564: solo el indicador, nunca el texto.
        hasPreVisitInstructions: false,
      });

      await as(
        api().patch(`/api/v1/appointment-types/${endo.id}`),
        clinic.adminToken,
      )
        .send({ active: false })
        .expect(200);

      const actives = await as(
        api().get('/api/v1/appointment-types'),
        reception.token,
      ).expect(200);
      expect((actives.body as TypeBody[]).map((t) => t.id)).not.toContain(
        endo.id,
      );
      const all = await as(
        api().get('/api/v1/appointment-types?includeInactive=true'),
        clinic.adminToken,
      ).expect(200);
      expect((all.body as TypeBody[]).map((t) => t.id)).toContain(endo.id);

      const again = await as(
        api().get(`/api/v1/appointments/${appt.id}`),
        reception.token,
      ).expect(200);
      expect(again.body).toMatchObject({
        end: at('09:30'),
        appointmentType: { id: endo.id, color: '#7C3AED' },
      });

      await as(api().post('/api/v1/appointments'), reception.token)
        .send({
          patientId: secondPatientId,
          providerId: clinic.adminUserId,
          start: at('18:00'),
          appointmentTypeId: endo.id,
        })
        .expect(400);
    });

    it('retirar un tipo (DELETE) es lógico: la cita lo conserva', async () => {
      const type = await createType({ name: 'Retirable', durationMinutes: 20 });
      const appt = await book({
        start: at('19:00'),
        appointmentTypeId: type.id,
      });
      await as(
        api().delete(`/api/v1/appointment-types/${type.id}`),
        clinic.adminToken,
      ).expect(204);
      const after = await as(
        api().get(`/api/v1/appointments/${appt.id}`),
        reception.token,
      ).expect(200);
      expect((after.body as AppointmentBody).appointmentType?.name).toBe(
        'Retirable',
      );
    });
  });

  describe('GET /appointments con providerIds[]', () => {
    it('devuelve solo las columnas pedidas', async () => {
      await book({
        patientId: secondPatientId,
        providerId: dentist.userId,
        start: at('11:00'),
        end: at('11:30'),
      });
      const res = await as(
        api()
          .get('/api/v1/appointments')
          .query({ from: FROM, to: TO, providerIds: [dentist.userId] }),
        reception.token,
      ).expect(200);
      const body = res.body as AppointmentBody[];
      expect(body.length).toBeGreaterThan(0);
      expect(body.every((a) => a.providerId === dentist.userId)).toBe(true);
    });

    it('un profesional de otra clínica: 400', async () => {
      await as(
        api()
          .get('/api/v1/appointments')
          .query({ from: FROM, to: TO, providerIds: [other.adminUserId] }),
        reception.token,
      ).expect(400);
    });

    it('más de 12 profesionales: 400', async () => {
      const ids = Array.from({ length: 13 }, () => dentist.userId);
      await as(
        api()
          .get('/api/v1/appointments')
          .query({ from: FROM, to: TO, providerIds: ids }),
        reception.token,
      ).expect(400);
    });
  });

  describe('PATCH: mover a otra hora y otro profesional', () => {
    it('mueve, anula el enlace de confirmación y audita el antes y el después', async () => {
      const appt = await book({ start: at('13:00'), end: at('13:30') });
      const link = await as(
        api().post(`/api/v1/appointments/${appt.id}/confirmation-link`),
        reception.token,
      ).expect(201);
      const token = (link.body as { url: string }).url.split('/confirmar/')[1];

      // Desde aquí, en TODA la clínica, solo puede auditarse el movimiento.
      // Por id y no por hora: el evento del enlace se escribe 1-2 ms antes y un
      // corte con `new Date()` puede dejarlo dentro (`occurredAt` redondea a ms).
      const before = await raw.auditEvent.findMany({
        where: { tenantId: clinic.tenantId, resourceType: 'APPOINTMENT' },
        select: { id: true },
      });
      const moved = await as(
        api().patch(`/api/v1/appointments/${appt.id}`),
        reception.token,
      )
        .send({
          providerId: dentist.userId,
          start: at('14:00'),
          end: at('14:30'),
        })
        .expect(200);
      expect(moved.body).toMatchObject({
        providerId: dentist.userId,
        start: at('14:00'),
        confirmationSentAt: null,
      });

      await api()
        .get(`/api/v1/public/appointment-confirmations/${token}`)
        .set('X-Tenant-Host', clinic.host)
        .expect((res) => {
          expect(JSON.stringify(res.body)).toMatch(/EXPIRED/);
        });

      // Desde DX-256 cada POST/PATCH deja además su traza HTTP genérica
      // (UPDATE con changedFields) junto al APPOINTMENT_MOVED con el antes y el
      // después. Desde entonces, en toda la clínica, solo esos dos y de esta cita:
      // nada atribuido a otra cita ni duplicado.
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'APPOINTMENT',
          id: { notIn: before.map((e) => e.id) },
        },
        orderBy: { occurredAt: 'asc' },
      });
      expect(events.map((e) => [e.action, e.resourceId]).sort()).toEqual([
        ['UPDATE', appt.id],
        ['UPDATE', appt.id],
      ]);
      // Y el alta de la cita, una sola vez.
      expect(
        await raw.auditEvent.count({
          where: {
            tenantId: clinic.tenantId,
            resourceType: 'APPOINTMENT',
            resourceId: appt.id,
            action: 'CREATE',
          },
        }),
      ).toBe(1);
      const trace = events.filter(
        (e) =>
          e.action === 'UPDATE' &&
          (e.metadata as { reason?: string }).reason === undefined,
      );
      expect(trace).toHaveLength(1);
      expect(trace[0]).toMatchObject({
        actorUserId: reception.userId,
        actorRole: 'RECEPTION',
      });
      expect(trace[0].metadata).toMatchObject({
        changedFields: ['end', 'providerId', 'start'],
      });
      const moves = events.filter(
        (e) =>
          (e.metadata as { reason?: string }).reason === 'APPOINTMENT_MOVED',
      );
      expect(moves).toHaveLength(1);
      expect(moves[0]).toMatchObject({
        action: 'UPDATE',
        resourceId: appt.id,
        actorUserId: reception.userId,
        actorRole: 'RECEPTION',
        patientId,
        metadata: {
          reason: 'APPOINTMENT_MOVED',
          move: {
            from: {
              start: at('13:00'),
              end: at('13:30'),
              providerId: clinic.adminUserId,
            },
            to: {
              start: at('14:00'),
              end: at('14:30'),
              providerId: dentist.userId,
            },
          },
        },
      });
    });

    it('cambiar SOLO de profesional (misma hora) también revoca el enlace', async () => {
      const appt = await book({ start: at('15:00'), end: at('15:30') });
      const link = await as(
        api().post(`/api/v1/appointments/${appt.id}/confirmation-link`),
        reception.token,
      ).expect(201);
      const token = (link.body as { url: string }).url.split('/confirmar/')[1];

      await as(api().patch(`/api/v1/appointments/${appt.id}`), reception.token)
        .send({ providerId: dentist.userId })
        .expect(200);

      const res = await api()
        .get(`/api/v1/public/appointment-confirmations/${token}`)
        .set('X-Tenant-Host', clinic.host);
      expect(JSON.stringify(res.body)).toMatch(/EXPIRED/);
    });

    it('sobre otra cita del profesional: 409 en español y la cita no cambia', async () => {
      const busy = await book({
        patientId: secondPatientId,
        providerId: dentist.userId,
        start: at('16:00'),
        end: at('16:30'),
      });
      const appt = await book({ start: at('16:00'), end: at('16:30') });

      const res = await as(
        api().patch(`/api/v1/appointments/${appt.id}`),
        reception.token,
      )
        .send({ providerId: busy.providerId })
        .expect(409);
      expect((res.body as { message: string }).message).toBe(
        'El profesional ya tiene una cita en ese horario',
      );
      const unchanged = await as(
        api().get(`/api/v1/appointments/${appt.id}`),
        reception.token,
      ).expect(200);
      expect((unchanged.body as AppointmentBody).providerId).toBe(
        clinic.adminUserId,
      );
    });

    it('a un profesional de otra clínica: 404', async () => {
      const appt = await book({ start: at('17:00'), end: at('17:30') });
      await as(api().patch(`/api/v1/appointments/${appt.id}`), reception.token)
        .send({ providerId: other.adminUserId })
        .expect(404);
    });

    it('fuera del horario de la sede: 422 con el horario del día', async () => {
      const appt = await book({ start: at('10:00'), end: at('10:30') });
      await as(api().put('/api/v1/locations/schedule'), clinic.adminToken)
        .send({
          ranges: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
            weekday,
            startMinute: 9 * 60,
            endMinute: 12 * 60,
          })),
        })
        .expect(200);
      try {
        const res = await as(
          api().patch(`/api/v1/appointments/${appt.id}`),
          reception.token,
        )
          .send({ start: at('20:00'), end: at('20:30') })
          .expect(422);
        expect((res.body as { message: string }).message).toMatch(
          /Fuera del horario de atención/,
        );
      } finally {
        await as(api().put('/api/v1/locations/schedule'), clinic.adminToken)
          .send({ ranges: [] })
          .expect(200);
      }
    });
  });
  describe('DX-564: indicaciones previas a la cita', () => {
    interface InstructionsBody {
      id: string;
      preVisitInstructions: { language: string; text: string }[];
    }
    const types = '/api/v1/appointment-types';

    beforeAll(async () => {
      await as(api().put('/api/v1/patients/languages'), clinic.adminToken)
        .send({ languages: ['es', 'en'] })
        .expect(200);
    });

    it('ADMIN las escribe en es y en; salen ordenadas en la lista y el resumen de la cita solo lleva el indicador', async () => {
      const created = (
        await as(api().post(types), clinic.adminToken)
          .send({
            name: 'Cirugía de cordales',
            durationMinutes: 60,
            color: '#0E7490',
            preVisitInstructions: [
              { language: 'en', text: 'Come fasting for 6 hours.' },
              {
                language: 'ES',
                text: '  Ven en ayunas de 6 horas.\r\nTrae tus radiografías. ',
              },
              { language: 'en-GB', text: '   ' },
            ],
          })
          .expect(201)
      ).body as InstructionsBody;
      expect(created.preVisitInstructions).toEqual([
        {
          language: 'es',
          text: 'Ven en ayunas de 6 horas.\nTrae tus radiografías.',
        },
        { language: 'en', text: 'Come fasting for 6 hours.' },
      ]);

      // Los 4 roles leen la lista con el texto.
      for (const token of [dentist.token, reception.token]) {
        const list = (await as(api().get(types), token).expect(200))
          .body as InstructionsBody[];
        expect(
          list.find((t) => t.id === created.id)?.preVisitInstructions,
        ).toEqual(created.preVisitInstructions);
      }
      // Un tipo sin indicaciones: lista vacía.
      const plain = await createType({ name: 'Control DX-564' });
      expect(
        (plain as unknown as InstructionsBody).preVisitInstructions,
      ).toEqual([]);

      const appt = await book({
        start: at('22:00'),
        appointmentTypeId: created.id,
      });
      expect(appt.appointmentType).toEqual({
        id: created.id,
        name: 'Cirugía de cordales',
        durationMinutes: 60,
        color: '#0E7490',
        hasPreVisitInstructions: true,
      });
      const rows = (
        await as(
          api().get('/api/v1/appointments').query({ from: FROM, to: TO }),
          reception.token,
        ).expect(200)
      ).body as AppointmentBody[];
      const row = rows.find((a) => a.id === appt.id);
      expect(row?.appointmentType).toEqual(appt.appointmentType);
      expect(JSON.stringify(rows)).not.toContain('ayunas');
    });

    it('los demás roles no las escriben (403)', async () => {
      const type = await createType({ name: 'Profilaxis DX-564' });
      for (const token of [dentist.token, reception.token]) {
        await as(api().patch(`${types}/${type.id}`), token)
          .send({ preVisitInstructions: [{ language: 'es', text: 'Hola' }] })
          .expect(403);
      }
    });

    it.each([
      [
        [{ language: 'pt', text: 'Venha em jejum.' }],
        'Ese idioma no está entre los idiomas de los pacientes de la clínica.',
      ],
      [
        [{ language: 'es', text: 'Lee https://example.com antes' }],
        'Las indicaciones no admiten enlaces ni HTML: escríbelas como texto.',
      ],
      [
        [{ language: 'es', text: 'Ven en <b>ayunas</b>' }],
        'Las indicaciones no admiten enlaces ni HTML: escríbelas como texto.',
      ],
      [
        [
          { language: 'es', text: 'A' },
          { language: 'es', text: 'B' },
        ],
        'Ese idioma está repetido en las indicaciones.',
      ],
      [
        [{ language: 'es', text: 'a'.repeat(601) }],
        'Las indicaciones no pueden tener más de 600 caracteres.',
      ],
      [
        Array.from({ length: 11 }, () => ({ language: 'es', text: 'a' })),
        'Las indicaciones admiten como mucho 10 idiomas.',
      ],
      [
        [{ language: 'inglés', text: 'a' }],
        'El idioma debe ser una etiqueta BCP 47',
      ],
      [[{ language: 'es', text: 3 }], 'Las indicaciones deben ser un texto.'],
      [{ es: 'Hola' }, 'Las indicaciones deben ir en una lista.'],
    ])(
      'valida %j con 400 en español',
      async (preVisitInstructions, message) => {
        const type = await createType({
          name: `Validación ${message.length}-${JSON.stringify(preVisitInstructions).length}`,
        });
        const res = await as(
          api().patch(`${types}/${type.id}`),
          clinic.adminToken,
        )
          .send({ preVisitInstructions })
          .expect(400);
        expect(JSON.stringify(res.body)).toContain(message);
      },
    );

    it('auditoría: el cambio dice qué idiomas cambiaron, nunca el texto', async () => {
      const type = (
        await as(api().post(types), clinic.adminToken)
          .send({
            name: 'Implante DX-564',
            durationMinutes: 60,
            color: '#0E7490',
            preVisitInstructions: [
              { language: 'es', text: 'Texto secreto uno' },
            ],
          })
          .expect(201)
      ).body as InstructionsBody;
      await as(api().patch(`${types}/${type.id}`), clinic.adminToken)
        .send({
          preVisitInstructions: [
            { language: 'es', text: 'Texto secreto dos' },
            { language: 'en', text: 'Secret text' },
          ],
        })
        .expect(200);
      // Sin el campo, nada cambia: ningún evento nuevo.
      await as(api().patch(`${types}/${type.id}`), clinic.adminToken)
        .send({ durationMinutes: 60 })
        .expect(200);

      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'APPOINTMENT_TYPE',
          resourceId: type.id,
        },
        orderBy: { occurredAt: 'asc' },
      });
      const reasons = events.map(
        (e) => (e.metadata as { reason?: string }).reason,
      );
      expect(reasons).toContain('APPOINTMENT_TYPE_CREATED');
      const updates = events.filter(
        (e) =>
          (e.metadata as { reason?: string }).reason ===
          'APPOINTMENT_TYPE_UPDATED',
      );
      expect(updates).toHaveLength(1);
      expect(updates[0].metadata).toMatchObject({
        changedFields: ['preVisitInstructionLanguages', 'preVisitInstructions'],
        configChange: {
          before: { preVisitInstructionLanguages: ['es'] },
          after: { preVisitInstructionLanguages: ['es', 'en'] },
        },
      });
      expect(JSON.stringify(events)).not.toMatch(/secreto|Secret text/);
    });
  });
});
