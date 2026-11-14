import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
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
import { LANGUAGE_NOT_OFFERED_MESSAGE } from '../src/shared/i18n/patient-language';

// DX-497 en HTTP real: el ADMIN elige los idiomas de los pacientes (Ajustes ›
// Idiomas de los pacientes, auditado); recepción los ve en la ficha y solo
// acepta los de la lista (400 si no); el cambio del paciente queda en la
// auditoría con el antes, el después y quién; quitar un idioma no toca a los
// pacientes que lo tenían; la página pública abre en el idioma del paciente;
// otra clínica no se entera de nada.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const LANGUAGES = '/api/v1/patients/languages';

interface AuditItem {
  action: string;
  resourceType: string;
  resourceId: string | null;
  actor: { id?: string; role: string } | null;
  metadata: {
    reason?: string;
    changedFields?: string[];
    configChange?: {
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    };
  };
}

describe('Idiomas de los pacientes (e2e, DX-497)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  const tokens = {} as Record<ClinicRole, string>;
  let patientId: string;
  let doc = 497000;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const createPatient = (
    body: Record<string, unknown>,
    token = tokens.RECEPTION,
    host = clinic.host,
  ) =>
    as(api().post('/api/v1/patients'), token, host).send({
      firstName: 'Carolina',
      lastName: 'Duque',
      docType: 'NATIONAL_ID',
      docNumber: String(doc++),
      sex: 'F',
      email: 'carolina@example.com',
      ...body,
    });
  const comms = (id = patientId) => `/api/v1/patients/${id}/communication`;
  const auditEvents = async (query: string): Promise<AuditItem[]> =>
    (
      (
        await as(
          api().get(`/api/v1/audit-events?${query}`),
          tokens.ADMIN,
        ).expect(200)
      ).body as { items: AuditItem[] }
    ).items;

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx497-e2e');
    other = await registerClinic(app, 'dx497-e2e-otra');
    tokens.ADMIN = clinic.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('una clínica nueva ofrece solo «es»; los 4 roles la leen y la ruta no la tapa `:id`', async () => {
    for (const role of Object.values(ClinicRole)) {
      await as(api().get(LANGUAGES), tokens[role])
        .expect(200)
        .expect({ languages: ['es'], clinicLanguage: 'es' });
    }
  });

  it('solo el ADMIN cambia la lista (403 para el resto, sin cambios)', async () => {
    for (const role of [
      ClinicRole.RECEPTION,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
    ]) {
      await as(api().put(LANGUAGES), tokens[role])
        .send({ languages: ['es', 'en'] })
        .expect(403);
    }
    await as(api().get(LANGUAGES), tokens.ADMIN).expect({
      languages: ['es'],
      clinicLanguage: 'es',
    });
  });

  it('una etiqueta no válida es 400', async () => {
    for (const body of [
      { languages: ['es', 'english'] },
      { languages: 'en' },
      { languages: [] },
      {},
    ]) {
      await as(api().put(LANGUAGES), tokens.ADMIN).send(body).expect(400);
    }
  });

  it('el ADMIN añade English (en) y Català (ca): queda auditado sin sede', async () => {
    await as(api().put(LANGUAGES), tokens.ADMIN)
      .send({ languages: ['es', 'EN', 'ca'] })
      .expect(200)
      .expect({ languages: ['es', 'en', 'ca'], clinicLanguage: 'es' });
    const [event] = await auditEvents('resourceType=CLINIC_SETTINGS');
    expect(event).toMatchObject({
      action: 'UPDATE',
      resourceType: 'CLINIC_SETTINGS',
      resourceId: null,
      actor: { role: 'ADMIN' },
      metadata: {
        reason: 'PATIENT_LANGUAGES_SETTINGS',
        configChange: {
          before: { patientLanguages: ['es'] },
          after: { patientLanguages: ['es', 'en', 'ca'] },
        },
      },
    });
    const row = await raw.auditEvent.findFirstOrThrow({
      where: {
        tenantId: clinic.tenantId,
        metadata: { path: ['reason'], equals: 'PATIENT_LANGUAGES_SETTINGS' },
      },
    });
    expect(row.locationId).toBeNull();
  });

  it('recepción da de alta con un idioma de la lista; fuera de ella, 400', async () => {
    const created = await createPatient({ preferredLanguage: 'en' }).expect(
      201,
    );
    patientId = (created.body as { id: string }).id;
    expect(created.body).toMatchObject({ preferredLanguage: 'en' });
    const fr = await createPatient({ preferredLanguage: 'fr' }).expect(400);
    expect((fr.body as { message: string }).message).toBe(
      LANGUAGE_NOT_OFFERED_MESSAGE,
    );
    await createPatient({ preferredLanguage: 'no válido' }).expect(400);
    // null = «Idioma de la clínica».
    const plain = await createPatient({ preferredLanguage: null }).expect(201);
    expect(plain.body).toMatchObject({ preferredLanguage: null });
  });

  it('la ficha enseña las opciones y recepción cambia el idioma: auditado con antes, después y quién', async () => {
    const view = await as(api().get(comms()), tokens.RECEPTION).expect(200);
    expect(view.body).toMatchObject({
      preferredLanguage: 'en',
      patientLanguages: ['es', 'en', 'ca'],
      clinicLanguage: 'es',
    });
    await as(api().patch(comms()), tokens.RECEPTION)
      .send({ preferredLanguage: 'ca' })
      .expect(200)
      .expect((res) =>
        expect(res.body).toMatchObject({ preferredLanguage: 'ca' }),
      );
    const bad = await as(api().patch(comms()), tokens.RECEPTION)
      .send({ preferredLanguage: 'fr' })
      .expect(400);
    expect((bad.body as { message: string }).message).toBe(
      LANGUAGE_NOT_OFFERED_MESSAGE,
    );
    // El profesional lo ve, pero no lo cambia.
    await as(api().patch(comms()), tokens.DENTIST)
      .send({ preferredLanguage: 'es' })
      .expect(403);
    const [event] = await auditEvents(
      `resourceType=PATIENT&patientId=${patientId}`,
    );
    expect(event).toMatchObject({
      action: 'UPDATE',
      resourceType: 'PATIENT',
      resourceId: patientId,
      actor: { role: 'RECEPTION' },
      metadata: {
        reason: 'COMMUNICATION_PREFERENCES_CHANGED',
        changedFields: ['preferredLanguage'],
        configChange: {
          before: { preferredLanguage: 'en' },
          after: { preferredLanguage: 'ca' },
        },
      },
    });
  });

  it('quitar ca de la lista no toca al paciente: conserva ca (la ficha lo enseña «(no disponible)»)', async () => {
    await as(api().put(LANGUAGES), tokens.ADMIN)
      .send({ languages: ['es', 'en'] })
      .expect(200);
    const view = await as(api().get(comms()), tokens.RECEPTION).expect(200);
    expect(view.body).toMatchObject({
      preferredLanguage: 'ca',
      patientLanguages: ['es', 'en'],
    });
    const patient = await as(
      api().get(`/api/v1/patients/${patientId}`),
      tokens.RECEPTION,
    ).expect(200);
    expect(patient.body).toMatchObject({ preferredLanguage: 'ca' });
    // Reenviar el que ya tiene no es un cambio ni un 400; uno nuevo retirado sí.
    await as(api().patch(comms()), tokens.RECEPTION)
      .send({ preferredLanguage: 'ca', contactChannel: 'EMAIL' })
      .expect(200);
    await createPatient({ preferredLanguage: 'ca' }).expect(400);
  });

  it('la página pública de confirmar abre en el idioma del paciente de la cita', async () => {
    await as(api().patch(comms()), tokens.RECEPTION)
      .send({ preferredLanguage: 'en' })
      .expect(200);
    const start = new Date(Date.now() + 3 * 24 * 3_600_000);
    start.setUTCHours(14, 0, 0, 0);
    const appt = await as(api().post('/api/v1/appointments'), tokens.ADMIN)
      .send({
        patientId,
        providerId: clinic.adminUserId,
        start: start.toISOString(),
        end: new Date(start.getTime() + 30 * 60_000).toISOString(),
      })
      .expect(201);
    const link = await as(
      api().post(
        `/api/v1/appointments/${(appt.body as { id: string }).id}/confirmation-link`,
      ),
      tokens.ADMIN,
    ).expect(201);
    const token = (link.body as { url: string }).url.split('/confirmar/')[1];
    const view = await api()
      .get(`/api/v1/public/appointment-confirmations/${token}`)
      .set('X-Tenant-Host', clinic.host)
      .expect(200);
    expect(view.body).toMatchObject({ language: 'en', status: 'PENDING' });
    // Abrirla no cambia la ficha.
    const after = await as(api().get(comms()), tokens.RECEPTION).expect(200);
    expect(after.body).toMatchObject({ preferredLanguage: 'en' });
  });

  it('otra clínica no se entera: sigue con «es» y no acepta «en»', async () => {
    await as(api().get(LANGUAGES), other.adminToken, other.host).expect({
      languages: ['es'],
      clinicLanguage: 'es',
    });
    await createPatient(
      { preferredLanguage: 'en' },
      other.adminToken,
      other.host,
    ).expect(400);
    const foreign = await as(
      api().get('/api/v1/audit-events?resourceType=CLINIC_SETTINGS'),
      other.adminToken,
      other.host,
    ).expect(200);
    expect((foreign.body as { items: unknown[] }).items).toHaveLength(0);
  });
});
