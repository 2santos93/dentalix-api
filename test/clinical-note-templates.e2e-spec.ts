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

// DX-170 en HTTP real: CRUD de plantillas de evolución por rol (solo ADMIN
// escribe, recepción ni las lee), validación en español, plantillas de
// ejemplo, evolución con plantilla y ligada a la cita (que sigue inalterable y
// se corrige con adenda), y aislamiento entre clínicas.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = new Date(Date.now() + 2 * DAY_MS).toISOString().slice(0, 10);
const at = (time: string): string => `${DAY}T${time}:00.000Z`;

interface PromptBody {
  id: string;
  label: string;
  type: 'ONE' | 'MULTI' | 'TEXT';
  options: string[];
  defaultValue: string | null;
  position: number;
}

interface TemplateBody {
  id: string;
  name: string;
  category: string | null;
  body: string;
  active: boolean;
  prompts: PromptBody[];
}

interface EntryBody {
  id: string;
  notes: string;
  entryDate: string;
  templateId: string | null;
  appointmentId: string | null;
  appointment: {
    id: string;
    start: string;
    providerId: string;
    providerName: string | null;
  } | null;
  addenda: { text: string }[];
}

const RESIN = {
  name: 'Resina',
  category: 'Operatoria',
  body: 'Resina en superficie {{Superficie}} con {{Material}}. Observaciones: {{Observaciones}}.',
  prompts: [
    { label: 'Superficie', type: 'ONE', options: ['O', 'M', 'D', 'V', 'L'] },
    {
      label: 'Material',
      type: 'MULTI',
      options: ['Resina A2', 'Ionómero', 'Adhesivo universal'],
      defaultValue: 'Resina A2',
    },
    { label: 'Observaciones', type: 'TEXT' },
  ],
};

describe('Plantillas de evolución ligadas a la cita (e2e, DX-170)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let dentist: { userId: string; token: string };
  let reception: string;
  let assistant: string;
  let patientId: string;
  let secondPatientId: string;
  let otherClinicPatientId: string;
  let resin: TemplateBody;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  async function createPatient(c: Clinic, doc: string): Promise<string> {
    const res = await as(api().post('/api/v1/patients'), c.adminToken, c.host)
      .send({
        firstName: 'Ana',
        lastName: 'Paciente',
        docType: 'CC',
        docNumber: doc,
        sex: 'F',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function book(
    c: Clinic,
    patient: string,
    providerId: string,
    start: string,
    end: string,
  ): Promise<string> {
    const res = await as(
      api().post('/api/v1/appointments'),
      c.adminToken,
      c.host,
    )
      .send({ patientId: patient, providerId, start, end })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function setStatus(
    c: Clinic,
    id: string,
    status: string,
  ): Promise<void> {
    await as(api().patch(`/api/v1/appointments/${id}`), c.adminToken, c.host)
      .send({ status })
      .expect(200);
  }

  async function auditCount(action: string): Promise<number> {
    return raw.auditEvent.count({
      where: {
        tenantId: clinic.tenantId,
        resourceType: 'CLINICAL_NOTE_TEMPLATE',
        action: action as 'CREATE' | 'UPDATE',
      },
    });
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx170-e2e');
    other = await registerClinic(app, 'dx170-e2e-otra');
    const d = await seedMember(raw, clinic, ClinicRole.DENTIST);
    await raw.user.update({
      where: { id: d.userId },
      data: { fullName: 'Dra. Ríos' },
    });
    dentist = {
      userId: d.userId,
      token: await loginAs(app, clinic.host, d.email),
    };
    const r = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    reception = await loginAs(app, clinic.host, r.email);
    const s = await seedMember(raw, clinic, ClinicRole.ASSISTANT);
    assistant = await loginAs(app, clinic.host, s.email);
    for (const c of [clinic, other]) {
      await as(api().put('/api/v1/locations/schedule'), c.adminToken, c.host)
        .send({ timezone: 'UTC', ranges: [] })
        .expect(200);
    }
    patientId = await createPatient(clinic, '170001');
    secondPatientId = await createPatient(clinic, '170002');
    otherClinicPatientId = await createPatient(other, '170003');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('CRUD por rol', () => {
    it('ADMIN crea «Resina» con preguntas ONE, MULTI y TEXT (auditado)', async () => {
      const res = await as(
        api().post('/api/v1/clinical-note-templates'),
        clinic.adminToken,
      )
        .send(RESIN)
        .expect(201);
      resin = res.body as TemplateBody;
      expect(resin).toMatchObject({
        name: 'Resina',
        category: 'Operatoria',
        active: true,
        prompts: [
          {
            label: 'Superficie',
            type: 'ONE',
            options: ['O', 'M', 'D', 'V', 'L'],
            position: 0,
          },
          {
            label: 'Material',
            type: 'MULTI',
            defaultValue: 'Resina A2',
            position: 1,
          },
          { label: 'Observaciones', type: 'TEXT', options: [], position: 2 },
        ],
      });
      expect(await auditCount('CREATE')).toBe(1);
      const event = await raw.auditEvent.findFirstOrThrow({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'CLINICAL_NOTE_TEMPLATE',
        },
      });
      // Sin contenido: ni el cuerpo ni las opciones van a la auditoría.
      expect(JSON.stringify(event.metadata)).not.toContain(
        'Resina en superficie',
      );
      expect(event.resourceId).toBe(resin.id);
    });

    it('DENTIST y ASSISTANT las leen; RECEPTION, 403', async () => {
      for (const token of [dentist.token, assistant]) {
        const res = await as(
          api().get('/api/v1/clinical-note-templates'),
          token,
        ).expect(200);
        expect((res.body as TemplateBody[]).map((t) => t.name)).toEqual([
          'Resina',
        ]);
      }
      await as(api().get('/api/v1/clinical-note-templates'), reception).expect(
        403,
      );
    });

    it.each([
      ['RECEPTION', () => reception],
      ['DENTIST', () => dentist.token],
      ['ASSISTANT', () => assistant],
    ])(
      '%s no crea, ni edita, ni carga ejemplos (403)',
      async (_role, token) => {
        await as(api().post('/api/v1/clinical-note-templates'), token())
          .send({ ...RESIN, name: 'Otra' })
          .expect(403);
        await as(
          api().patch(`/api/v1/clinical-note-templates/${resin.id}`),
          token(),
        )
          .send({ active: false })
          .expect(403);
        await as(
          api().post('/api/v1/clinical-note-templates/samples'),
          token(),
        ).expect(403);
      },
    );

    it('400 en español: marcador sin pregunta y pregunta ONE/MULTI sin opciones', async () => {
      const marker = await as(
        api().post('/api/v1/clinical-note-templates'),
        clinic.adminToken,
      )
        .send({ ...RESIN, name: 'Mala', body: `${RESIN.body} {{Diente}}` })
        .expect(400);
      expect((marker.body as { message: string }).message).toMatch(
        /El marcador \{\{Diente\}\} no corresponde a ninguna pregunta/,
      );
      const options = await as(
        api().post('/api/v1/clinical-note-templates'),
        clinic.adminToken,
      )
        .send({
          ...RESIN,
          name: 'Mala',
          prompts: [
            { label: 'Superficie', type: 'ONE', options: [] },
            ...RESIN.prompts.slice(1),
          ],
        })
        .expect(400);
      expect((options.body as { message: string }).message).toMatch(
        /«Superficie» es de opción única y necesita al menos una opción/,
      );
    });

    it('409 con un nombre repetido', async () => {
      await as(api().post('/api/v1/clinical-note-templates'), clinic.adminToken)
        .send(RESIN)
        .expect(409);
    });

    it('«Cargar plantillas de ejemplo» crea las que faltan y no duplica', async () => {
      const first = await as(
        api().post('/api/v1/clinical-note-templates/samples'),
        clinic.adminToken,
      ).expect(201);
      // «Resina» ya existía (la propia): se respeta y no se duplica.
      expect((first.body as TemplateBody[]).map((t) => t.name)).toEqual([
        'Exploración / control',
        'Profilaxis',
        'Exodoncia simple',
        'Endodoncia por sesión',
        'Control postoperatorio',
      ]);
      const again = await as(
        api().post('/api/v1/clinical-note-templates/samples'),
        clinic.adminToken,
      ).expect(201);
      expect(again.body).toEqual([]);
      const list = await as(
        api().get('/api/v1/clinical-note-templates'),
        clinic.adminToken,
      );
      expect(list.body).toHaveLength(6);
    });
  });

  describe('evolución con plantilla y cita', () => {
    let appointmentId: string;
    let entry: EntryBody;

    beforeAll(async () => {
      appointmentId = await book(
        clinic,
        patientId,
        dentist.userId,
        at('14:00'),
        at('14:30'),
      );
      await setStatus(clinic, appointmentId, 'COMPLETED');
    });

    it('DENTIST usa «Resina» desde la cita: el texto lleva las respuestas y queda ligada', async () => {
      const [surface, material, remarks] = resin.prompts;
      const res = await as(
        api().post(`/api/v1/patients/${patientId}/clinical-entries`),
        dentist.token,
      )
        .send({
          appointmentId,
          templateId: resin.id,
          answers: [
            { promptId: surface.id, values: ['O'] },
            {
              promptId: material.id,
              values: ['Adhesivo universal', 'Resina A2'],
            },
            {
              promptId: remarks.id,
              values: ['Sin sensibilidad postoperatoria'],
            },
          ],
        })
        .expect(201);
      entry = res.body as EntryBody;
      expect(entry).toMatchObject({
        notes:
          'Resina en superficie O con Resina A2 y Adhesivo universal. Observaciones: Sin sensibilidad postoperatoria.',
        templateId: resin.id,
        appointmentId,
        entryDate: at('14:00'),
        appointment: {
          id: appointmentId,
          providerId: dentist.userId,
          providerName: 'Dra. Ríos',
        },
      });
    });

    it('el texto revisado y editado en la web se guarda tal cual', async () => {
      const res = await as(
        api().post(`/api/v1/patients/${patientId}/clinical-entries`),
        dentist.token,
      )
        .send({
          templateId: resin.id,
          notes:
            'Resina en superficie M con Resina A2. Observaciones: [sin respuesta]. Editada.',
        })
        .expect(201);
      expect((res.body as EntryBody).notes).toMatch(/Editada\.$/);
    });

    it('editar y desactivar la plantilla no cambia la evolución; sigue inalterable y se corrige con adenda', async () => {
      const before = await raw.clinicalEntry.findUniqueOrThrow({
        where: { id: entry.id },
      });
      await as(
        api().patch(`/api/v1/clinical-note-templates/${resin.id}`),
        clinic.adminToken,
      )
        .send({
          name: 'Resina compuesta',
          body: 'Nuevo {{Superficie}} {{Material}} {{Observaciones}}',
        })
        .expect(200);
      const off = await as(
        api().patch(`/api/v1/clinical-note-templates/${resin.id}`),
        clinic.adminToken,
      )
        .send({ active: false })
        .expect(200);
      expect((off.body as TemplateBody).active).toBe(false);
      expect(await auditCount('UPDATE')).toBe(2);

      const after = await raw.clinicalEntry.findUniqueOrThrow({
        where: { id: entry.id },
      });
      expect(after).toEqual(before);

      await as(
        api().patch(
          `/api/v1/patients/${patientId}/clinical-entries/${entry.id}`,
        ),
        dentist.token,
      )
        .send({ notes: 'cambiada' })
        .expect(405);
      await as(
        api().post(
          `/api/v1/patients/${patientId}/clinical-entries/${entry.id}/addenda`,
        ),
        dentist.token,
      )
        .send({
          reason: 'Superficie mal registrada',
          text: 'Era la superficie M.',
        })
        .expect(201);

      const list = await as(
        api().get(`/api/v1/patients/${patientId}/clinical-entries`),
        dentist.token,
      ).expect(200);
      const listed = (list.body as EntryBody[]).find((e) => e.id === entry.id);
      expect(listed).toMatchObject({
        notes: entry.notes,
        appointment: { providerName: 'Dra. Ríos' },
        addenda: [{ text: 'Era la superficie M.' }],
      });
    });

    it('una plantilla desactivada ya no sirve para evoluciones nuevas (400)', async () => {
      const res = await as(
        api().post(`/api/v1/patients/${patientId}/clinical-entries`),
        dentist.token,
      )
        .send({ templateId: resin.id, answers: [] })
        .expect(400);
      expect((res.body as { message: string }).message).toMatch(/desactivada/);
    });

    it('la cita de otro paciente da 400 en español', async () => {
      const res = await as(
        api().post(`/api/v1/patients/${secondPatientId}/clinical-entries`),
        dentist.token,
      )
        .send({ appointmentId, notes: 'Control' })
        .expect(400);
      expect((res.body as { message: string }).message).toMatch(
        /La cita no es de este paciente/,
      );
    });

    it('una cita cancelada no admite evolución (400)', async () => {
      const cancelled = await book(
        clinic,
        patientId,
        dentist.userId,
        at('16:00'),
        at('16:30'),
      );
      await setStatus(clinic, cancelled, 'CANCELLED');
      await as(
        api().post(`/api/v1/patients/${patientId}/clinical-entries`),
        dentist.token,
      )
        .send({ appointmentId: cancelled, notes: 'Control' })
        .expect(400);
    });

    it('RECEPTION no registra evoluciones (403)', async () => {
      await as(
        api().post(`/api/v1/patients/${patientId}/clinical-entries`),
        reception,
      )
        .send({ appointmentId, notes: 'Control' })
        .expect(403);
    });
  });

  describe('aislamiento entre clínicas', () => {
    let otherAppointmentId: string;
    let otherTemplate: TemplateBody;

    beforeAll(async () => {
      otherAppointmentId = await book(
        other,
        otherClinicPatientId,
        other.adminUserId,
        at('10:00'),
        at('10:30'),
      );
      const res = await as(
        api().post('/api/v1/clinical-note-templates'),
        other.adminToken,
        other.host,
      )
        .send({ ...RESIN, name: 'Resina de B' })
        .expect(201);
      otherTemplate = res.body as TemplateBody;
    });

    it('la cita de otra clínica da 404 en español y no crea nada', async () => {
      const before = await raw.clinicalEntry.count();
      const res = await as(
        api().post(`/api/v1/patients/${patientId}/clinical-entries`),
        dentist.token,
      )
        .send({ appointmentId: otherAppointmentId, notes: 'Control' })
        .expect(404);
      expect((res.body as { message: string }).message).toBe(
        'Cita no encontrada en esta clínica',
      );
      expect(await raw.clinicalEntry.count()).toBe(before);
    });

    it('la plantilla de otra clínica no se ve, no se edita (404) ni se usa (404)', async () => {
      const list = await as(
        api().get('/api/v1/clinical-note-templates?includeInactive=true'),
        clinic.adminToken,
      );
      expect((list.body as TemplateBody[]).map((t) => t.id)).not.toContain(
        otherTemplate.id,
      );
      await as(
        api().patch(`/api/v1/clinical-note-templates/${otherTemplate.id}`),
        clinic.adminToken,
      )
        .send({ active: false })
        .expect(404);
      await as(
        api().post(`/api/v1/patients/${patientId}/clinical-entries`),
        dentist.token,
      )
        .send({ templateId: otherTemplate.id, answers: [] })
        .expect(404);
      const untouched = await raw.clinicalNoteTemplate.findUniqueOrThrow({
        where: { id: otherTemplate.id },
      });
      expect(untouched.active).toBe(true);
    });
  });
});
