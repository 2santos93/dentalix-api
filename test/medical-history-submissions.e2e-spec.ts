import { createHash } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { ANAMNESIS_CLOCK } from '../src/modules/medical-history-submissions/application/anamnesis-clock';
import {
  ANAMNESIS_LINK_GONE_MESSAGE,
  ANAMNESIS_CONSENT_REQUIRED_MESSAGE,
  ANAMNESIS_DECLARATION_REQUIRED_MESSAGE,
} from '../src/modules/medical-history-submissions/application/use-cases/public-anamnesis.use-cases';
import {
  ANAMNESIS_INBOX_FORBIDDEN_MESSAGE,
  ANAMNESIS_REVIEW_FORBIDDEN_MESSAGE,
} from '../src/modules/medical-history-submissions/application/use-cases/anamnesis-review.use-cases';
import {
  ANSWERS_TOO_LARGE_MESSAGE,
  MISSING_ALLERGIES_MESSAGE,
} from '../src/modules/medical-history-submissions/domain/answers-to-version';
import { allNoAnswers } from '../src/modules/medical-history-submissions/domain/__fixtures__/anamnesis-answers';
import type { AnamnesisAnswers } from '../src/modules/medical-history-submissions/domain/anamnesis-questionnaire';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-099 en HTTP real: el ciclo completo de la anamnesis por enlace —
// recepción crea el enlace, el paciente lo abre sin sesión (la clínica sale
// del host), responde una sola vez, la HC no cambia hasta que un ADMIN o
// DENTIST acepta (una versión, autor = quien revisa, origen formulario) y la
// alerta llega a la agenda. Caducado, anulado o ya usado → 410. El reloj del
// módulo se sobrescribe para adelantarlo. DIRECT_URL (superusuario, sin RLS)
// solo lee filas para comprobar.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const POLICY = {
  policyText: 'Política de tratamiento de datos de la clínica.',
  generalText: 'Autorizo el tratamiento de mis datos personales.',
  sensitiveHealthText:
    'Autorizo el tratamiento de mis datos sensibles de salud (historia clínica). No está obligado a autorizarlo. Finalidad: la atención odontológica.',
  marketingText: 'Autorizo recibir comunicaciones comerciales.',
};
const LAST_NAME = 'Zuluagarrestrepo';
const DOC_NUMBER = '1098765432';
const PRIOR_ALLERGEN = 'Ibuprofenazol';
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_IN_URL = /\/anamnesis\/([A-Za-z0-9_-]{43})$/;

interface Created {
  id: string;
  url: string;
  expiresAt: string;
  appointmentId: string | null;
  whatsapp: { phone: string; text: string } | null;
  whatsappUnavailableReason: string | null;
  consentRequired: boolean;
}
interface Summary {
  id: string;
  status: string;
  patient: { id: string; fullName: string };
  location: { id: string; name: string };
  resultingVersionId: string | null;
  reviewedByName: string | null;
  rejectReason: string | null;
}
interface PublicView {
  clinic: { name: string };
  patientFirstName: string | null;
  questionnaire: { version: string; sections: { key: string }[] };
  consent: {
    required: boolean;
    policy: { id: string; sensitiveHealthText: string } | null;
  };
}
interface Review {
  submission: Summary;
  affirmativeCount: number;
  currentVersion: { version: number } | null;
  proposedFlags: {
    hasCriticalAlert: boolean;
    safetyFlags: Record<string, boolean>;
  };
  diff: {
    hasPreviousVersion: boolean;
    entries: { label: string; change: string; affirmative: boolean }[];
  };
}

function withAllergyAndAnticoagulant(): AnamnesisAnswers {
  const answers = allNoAnswers();
  answers.allergies = {
    answer: 'SI',
    items: [
      { alergeno: 'Penicilina', tipo: 'MEDICAMENTO', severidad: 'ANAFILAXIA' },
    ],
  };
  answers.anticoagulants = { answer: 'SI', detail: 'Warfarina' };
  return answers;
}

describe('Anamnesis previa a la cita por enlace (e2e, DX-099)', () => {
  let app: INestApplication<App>;
  let offsetMs = 0;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let receptionToken: string;
  let dentistToken: string;
  let dentistId: string;
  let assistantToken: string;
  let policyId: string;
  let patientId: string;
  let appointmentId: string;
  let appointmentStart: Date;
  let locationId: string;

  const server = () => request(app.getHttpServer());
  const as = (clinic: Clinic, token = clinic.adminToken) => {
    const set = (req: request.Test) =>
      req
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`);
    return {
      get: (path: string) => set(server().get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        set(server().post(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        set(server().put(`/api/v1${path}`)).send(body),
    };
  };
  const publicGet = (host: string, token: string) =>
    server()
      .get(`/api/v1/public/medical-history/${token}`)
      .set('X-Tenant-Host', host);
  const publicPost = (host: string, token: string, body: object) =>
    server()
      .post(`/api/v1/public/medical-history/${token}`)
      .set('X-Tenant-Host', host)
      .set('User-Agent', 'Mozilla/5.0 (iPhone) e2e')
      .send(body);

  const createLink = async (
    token = receptionToken,
    body: object = { appointmentId },
  ): Promise<{ created: Created; token: string }> => {
    const res = await as(clinicA, token)
      .post(`/patients/${patientId}/medical-history/requests`, body)
      .expect(201);
    const created = res.body as Created;
    const match = TOKEN_IN_URL.exec(created.url);
    if (!match) throw new Error(`URL sin token: ${created.url}`);
    return { created, token: match[1] };
  };
  const validBody = (
    answers: AnamnesisAnswers = withAllergyAndAnticoagulant(),
  ) => ({
    answers,
    declarationAccepted: true,
    consent: { policyVersionId: policyId, granted: true },
  });
  const versions = () =>
    raw.medicalHistoryVersion.findMany({
      where: { tenantId: clinicA.tenantId, patientId },
      orderBy: { version: 'asc' },
    });

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp({
      override: (builder) => {
        builder
          .overrideProvider(ANAMNESIS_CLOCK)
          .useValue(() => new Date(Date.now() + offsetMs));
      },
    });
    clinicA = await registerClinic(app, 'dx099-anamnesis-a');
    clinicB = await registerClinic(app, 'dx099-anamnesis-b');

    const reception = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    const dentist = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    const assistant = await seedMember(raw, clinicA, ClinicRole.ASSISTANT);
    dentistId = dentist.userId;
    receptionToken = await loginAs(app, clinicA.host, reception.email);
    dentistToken = await loginAs(app, clinicA.host, dentist.email);
    assistantToken = await loginAs(app, clinicA.host, assistant.email);

    // Sin horario: la cita se puede agendar a cualquier hora.
    await as(clinicA).put('/locations/schedule', { ranges: [] }).expect(200);
    locationId = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId },
      })
    ).id;
    policyId = (
      (await as(clinicA).post('/privacy-policies', POLICY).expect(201))
        .body as {
        id: string;
      }
    ).id;

    const patient = await as(clinicA)
      .post('/patients', {
        docType: 'NATIONAL_ID',
        docNumber: DOC_NUMBER,
        sex: 'F',
        firstName: 'Mariana Isabel',
        lastName: LAST_NAME,
        phone: '+57 300 123 4567',
        birthDate: '1988-03-14',
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
    // Una versión previa con un dato de salud que la página pública NO debe
    // mostrar nunca.
    await as(clinicA, dentistToken)
      .put(`/patients/${patientId}/medical-history`, {
        allergies: [
          {
            alergeno: PRIOR_ALLERGEN,
            tipo: 'MEDICAMENTO',
            severidad: 'LEVE',
            esAlerta: false,
          },
        ],
      })
      .expect(200);

    appointmentStart = new Date(Date.now() + 2 * DAY_MS);
    const appointment = await as(clinicA)
      .post('/appointments', {
        patientId,
        providerId: dentist.userId,
        start: appointmentStart.toISOString(),
        end: new Date(
          appointmentStart.getTime() + 30 * 60 * 1000,
        ).toISOString(),
      })
      .expect(201);
    appointmentId = (appointment.body as { id: string }).id;
  });

  afterEach(() => {
    offsetMs = 0;
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  describe('ciclo completo', () => {
    let link: { created: Created; token: string };

    it('recepción crea el enlace: URL una vez, caduca al inicio de la cita, WhatsApp sin datos clínicos', async () => {
      link = await createLink();
      const { created, token } = link;
      expect(created.appointmentId).toBe(appointmentId);
      expect(new Date(created.expiresAt).getTime()).toBe(
        appointmentStart.getTime(),
      );
      expect(created.consentRequired).toBe(true);
      expect(created.whatsapp?.phone).toBe('573001234567');
      expect(created.whatsapp?.text).toContain(created.url);
      expect(created.whatsapp?.text).toContain('Hola Mariana,');
      expect(created.whatsapp?.text).not.toContain(LAST_NAME);
      // Solo el hash del token queda en la BD.
      const row = await raw.medicalHistorySubmission.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.tokenHash).toBe(
        createHash('sha256').update(token).digest('hex'),
      );
      expect(JSON.stringify(row)).not.toContain(token);
      expect(row.status).toBe('PENDING_PATIENT');
      expect(row.locationId).toBe(locationId);
      expect(row.createdById).not.toBeNull();
    });

    it('la ficha lo muestra pendiente del paciente (recepción, sin respuestas)', async () => {
      const res = await as(clinicA, receptionToken)
        .get(`/patients/${patientId}/medical-history/requests`)
        .expect(200);
      const rows = res.body as Summary[];
      expect(rows[0]).toMatchObject({
        id: link.created.id,
        status: 'PENDING_PATIENT',
      });
      expect(res.text).not.toContain('answers');
    });

    it('la página pública: cuestionario y nombre de pila; ni apellidos, ni documento, ni datos previos', async () => {
      const res = await publicGet(clinicA.host, link.token).expect(200);
      const view = res.body as PublicView;
      expect(view.patientFirstName).toBe('Mariana');
      expect(view.clinic.name).toBe('Clinica dx099-anamnesis-a');
      expect(view.questionnaire.sections.map((s) => s.key)).toEqual([
        'allergies',
        'conditions',
        'medications',
        'habits',
        'pregnancy',
        'surgeries',
      ]);
      expect(view.consent.required).toBe(true);
      expect(view.consent.policy?.id).toBe(policyId);
      expect(view.consent.policy?.sensitiveHealthText).toBe(
        POLICY.sensitiveHealthText,
      );
      for (const secret of [
        LAST_NAME,
        DOC_NUMBER,
        patientId,
        PRIOR_ALLERGEN,
        'Isabel',
      ]) {
        expect(res.text).not.toContain(secret);
      }
    });

    it('las respuestas públicas no se guardan en cachés (no-store), también las de error', async () => {
      const ok = await publicGet(clinicA.host, link.token).expect(200);
      expect(ok.headers['cache-control']).toBe('no-store');
      expect(ok.headers['referrer-policy']).toBe('no-referrer');
      const unknown = await publicGet(clinicA.host, 'A'.repeat(43)).expect(404);
      expect(unknown.headers['cache-control']).toBe('no-store');
      const invalid = await publicPost(clinicA.host, link.token, {
        answers: allNoAnswers(),
        declarationAccepted: false,
      }).expect(400);
      expect(invalid.headers['cache-control']).toBe('no-store');
    });

    // ISOLATION_COVERS: GET /public/medical-history/:token
    // ISOLATION_COVERS: POST /public/medical-history/:token
    it('el token de A en el host de B → 404', async () => {
      await publicGet(clinicB.host, link.token).expect(404);
      await publicPost(clinicB.host, link.token, validBody()).expect(404);
    });

    it('sin autorización de salud → 422; sin declaración → 400; incompleto → 400, todo en español y sin guardar nada', async () => {
      const noConsent = await publicPost(clinicA.host, link.token, {
        answers: withAllergyAndAnticoagulant(),
        declarationAccepted: true,
      }).expect(422);
      expect((noConsent.body as { message: string }).message).toBe(
        ANAMNESIS_CONSENT_REQUIRED_MESSAGE,
      );
      const noDeclaration = await publicPost(clinicA.host, link.token, {
        ...validBody(),
        declarationAccepted: false,
      }).expect(400);
      expect((noDeclaration.body as { message: string }).message).toBe(
        ANAMNESIS_DECLARATION_REQUIRED_MESSAGE,
      );
      const incomplete = allNoAnswers();
      incomplete.allergies = { answer: 'SI', items: [] };
      const bad = await publicPost(
        clinicA.host,
        link.token,
        validBody(incomplete),
      ).expect(400);
      expect((bad.body as { message: string[] }).message).toEqual([
        MISSING_ALLERGIES_MESSAGE,
      ]);
      // Cada texto en su límite pero todo multibyte: 400 en español, no el
      // 500 del CHECK de tamaño de la BD.
      const long = '€'.repeat(200);
      const huge = allNoAnswers();
      huge.allergies = {
        answer: 'SI',
        items: Array.from({ length: 20 }, () => ({
          alergeno: long,
          reaccion: long,
          tipo: 'MEDICAMENTO' as const,
          severidad: 'LEVE' as const,
        })),
      };
      huge.medications = {
        answer: 'SI',
        items: Array.from({ length: 20 }, () => ({
          nombre: long,
          dosis: long,
          frecuencia: long,
        })),
      };
      const tooLarge = await publicPost(
        clinicA.host,
        link.token,
        validBody(huge),
      ).expect(400);
      expect((tooLarge.body as { message: string[] }).message).toEqual([
        ANSWERS_TOO_LARGE_MESSAGE,
      ]);
      const row = await raw.medicalHistorySubmission.findUniqueOrThrow({
        where: { id: link.created.id },
      });
      expect(row.status).toBe('PENDING_PATIENT');
    });

    it('el paciente envía: queda por revisar, la autorización queda registrada y la HC NO cambia', async () => {
      const before = await versions();
      await publicPost(clinicA.host, link.token, validBody()).expect(200);
      const row = await raw.medicalHistorySubmission.findUniqueOrThrow({
        where: { id: link.created.id },
      });
      expect(row.status).toBe('SUBMITTED');
      expect(row.submittedAt).not.toBeNull();
      expect(await versions()).toEqual(before);

      const consent = await raw.dataProcessingConsent.findFirstOrThrow({
        where: { patientId, scope: 'SENSITIVE_HEALTH' },
      });
      expect(consent).toMatchObject({
        granted: true,
        channel: 'PATIENT_LINK',
        recordedById: null,
        policyVersionId: policyId,
      });

      // Auditoría sin actor (el paciente) y sin las respuestas.
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: clinicA.tenantId,
          actorUserId: null,
          resourceType: { in: ['MEDICAL_HISTORY_SUBMISSION', 'DATA_CONSENT'] },
        },
      });
      expect(
        events.map((e) => [
          e.resourceType,
          e.action,
          (e.metadata as { reason?: string }).reason,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['MEDICAL_HISTORY_SUBMISSION', 'UPDATE', 'ANAMNESIS_SUBMITTED'],
          ['DATA_CONSENT', 'CREATE', 'ANAMNESIS_LINK'],
        ]),
      );
      expect(JSON.stringify(events)).not.toMatch(/Penicilina|Warfarina/);
      expect(events.every((e) => e.patientId === patientId)).toBe(true);
    });

    it('un segundo envío con el mismo token → 410 en español y no crea otro envío', async () => {
      const again = await publicPost(
        clinicA.host,
        link.token,
        validBody(),
      ).expect(410);
      expect((again.body as { message: string }).message).toBe(
        ANAMNESIS_LINK_GONE_MESSAGE,
      );
      await publicGet(clinicA.host, link.token).expect(410);
      expect(
        await raw.medicalHistorySubmission.count({
          where: { patientId, status: 'SUBMITTED' },
        }),
      ).toBe(1);
    });

    it('bandeja y contador: el profesional la ve; recepción no (403)', async () => {
      const inbox = await as(clinicA, dentistToken)
        .get('/medical-history/submissions')
        .expect(200);
      expect((inbox.body as Summary[]).map((s) => s.id)).toEqual([
        link.created.id,
      ]);
      const summary = await as(clinicA, dentistToken)
        .get('/medical-history/submissions/summary')
        .expect(200);
      expect(summary.body).toEqual({ submitted: 1 });
      const forbidden = await as(clinicA, receptionToken)
        .get('/medical-history/submissions')
        .expect(403);
      expect((forbidden.body as { message: string }).message).toBe(
        ANAMNESIS_INBOX_FORBIDDEN_MESSAGE,
      );
      const ficha = await as(clinicA, receptionToken)
        .get(`/patients/${patientId}/medical-history/requests`)
        .expect(200);
      expect((ficha.body as Summary[])[0].status).toBe('SUBMITTED');
    });

    it('la revisión marca lo añadido frente a la vigente, los «Sí» primero', async () => {
      const res = await as(clinicA, dentistToken)
        .get(`/medical-history/submissions/${link.created.id}`)
        .expect(200);
      const review = res.body as Review;
      expect(review.currentVersion?.version).toBe(1);
      expect(review.diff.hasPreviousVersion).toBe(true);
      expect(review.affirmativeCount).toBe(2);
      const labels = review.diff.entries.map((e) => [e.change, e.label]);
      expect(labels).toEqual(
        expect.arrayContaining([
          ['ADDED', 'Penicilina'],
          ['REMOVED', PRIOR_ALLERGEN],
          ['ADDED', 'Warfarina'],
        ]),
      );
      const firstNo = review.diff.entries.findIndex((e) => !e.affirmative);
      expect(
        review.diff.entries
          .slice(0, firstNo === -1 ? undefined : firstNo)
          .every((e) => e.affirmative),
      ).toBe(true);
      expect(review.proposedFlags.hasCriticalAlert).toBe(true);
      expect(review.proposedFlags.safetyFlags.anticoagulantes).toBe(true);
    });

    it('recepción y asistente no aceptan: 403 en español', async () => {
      for (const token of [receptionToken, assistantToken]) {
        const res = await as(clinicA, token)
          .post(`/medical-history/submissions/${link.created.id}/accept`)
          .expect(403);
        expect((res.body as { message: string }).message).toBe(
          ANAMNESIS_REVIEW_FORBIDDEN_MESSAGE,
        );
      }
      expect(await versions()).toHaveLength(1);
    });

    it('el odontólogo acepta: exactamente una versión, autor = quien revisa, origen formulario; la alerta llega a la agenda', async () => {
      const res = await as(clinicA, dentistToken)
        .post(`/medical-history/submissions/${link.created.id}/accept`)
        .expect(200);
      const accepted = res.body as Summary;
      expect(accepted.status).toBe('ACCEPTED');
      expect(accepted.reviewedByName).toBe('Miembro DENTIST');

      const all = await versions();
      expect(all).toHaveLength(2);
      const created = all[1];
      expect(created).toMatchObject({
        version: 2,
        source: 'PATIENT_FORM',
        createdById: dentistId,
        hasCriticalAlert: true,
      });
      expect(accepted.resultingVersionId).toBe(created.id);

      const alerts = await as(clinicA, receptionToken)
        .get(`/patients/${patientId}/medical-alerts`)
        .expect(200);
      expect(alerts.body).toMatchObject({ hasCriticalAlert: true });
      const from = new Date(appointmentStart.getTime() - DAY_MS).toISOString();
      const to = new Date(appointmentStart.getTime() + DAY_MS).toISOString();
      const agenda = await as(clinicA, receptionToken)
        .get(`/appointments?from=${from}&to=${to}`)
        .expect(200);
      const item = (
        agenda.body as {
          id: string;
          medicalAlerts: { hasCriticalAlert: boolean; alerts: string[] };
        }[]
      ).find((a) => a.id === appointmentId);
      expect(item?.medicalAlerts.hasCriticalAlert).toBe(true);
      expect(item?.medicalAlerts.alerts).toEqual(
        expect.arrayContaining(['alergiaPenicilina', 'anticoagulantes']),
      );

      // Auditoría de la aceptación: el revisor, sin respuestas.
      const event = await raw.auditEvent.findFirstOrThrow({
        where: {
          tenantId: clinicA.tenantId,
          resourceType: 'MEDICAL_HISTORY_SUBMISSION',
          resourceId: link.created.id,
          actorUserId: dentistId,
          action: 'UPDATE',
        },
      });
      expect(event.patientId).toBe(patientId);
      expect((event.metadata as { reason?: string }).reason).toBe(
        'ANAMNESIS_ACCEPTED',
      );
    });

    it('aceptar dos veces → 409 y sigue habiendo una sola versión nueva', async () => {
      await as(clinicA, dentistToken)
        .post(`/medical-history/submissions/${link.created.id}/accept`)
        .expect(409);
      expect(await versions()).toHaveLength(2);
    });
  });

  it('caducado → 410 al abrirlo y al enviarlo', async () => {
    const { token } = await createLink(receptionToken, {});
    offsetMs = 8 * DAY_MS;
    const res = await publicGet(clinicA.host, token).expect(410);
    expect((res.body as { message: string }).message).toBe(
      ANAMNESIS_LINK_GONE_MESSAGE,
    );
    await publicPost(clinicA.host, token, validBody()).expect(410);
    // La ficha lo ve caducado sin que nadie lo haya marcado.
    const ficha = await as(clinicA, receptionToken)
      .get(`/patients/${patientId}/medical-history/requests`)
      .expect(200);
    expect((ficha.body as Summary[])[0].status).toBe('EXPIRED');
  });

  it('un enlace nuevo anula el anterior; anular desde la ficha → 410; anular dos veces → 409', async () => {
    const first = await createLink(receptionToken, {});
    const second = await createLink(receptionToken, {});
    await publicGet(clinicA.host, first.token).expect(410);
    await publicGet(clinicA.host, second.token).expect(200);
    const revoked = await as(clinicA, receptionToken)
      .post(`/medical-history/submissions/${second.created.id}/revoke`)
      .expect(200);
    expect((revoked.body as Summary).status).toBe('EXPIRED');
    await publicGet(clinicA.host, second.token).expect(410);
    await as(clinicA, receptionToken)
      .post(`/medical-history/submissions/${second.created.id}/revoke`)
      .expect(409);
  });

  it('rechazar exige motivo; rechazada, la HC no cambia', async () => {
    const { created, token } = await createLink(receptionToken, {});
    await publicPost(clinicA.host, token, {
      answers: allNoAnswers(),
      declarationAccepted: true,
    }).expect(200);
    const before = await versions();
    await as(clinicA, dentistToken)
      .post(`/medical-history/submissions/${created.id}/reject`, {
        reason: '  ',
      })
      .expect(400);
    const res = await as(clinicA, dentistToken)
      .post(`/medical-history/submissions/${created.id}/reject`, {
        reason: 'Respuestas de otra persona',
      })
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'REJECTED',
      rejectReason: 'Respuestas de otra persona',
    });
    expect(await versions()).toEqual(before);
    await as(clinicA, dentistToken)
      .post(`/medical-history/submissions/${created.id}/accept`)
      .expect(409);

    // El motivo es texto libre del profesional sobre las respuestas (dato
    // clínico): la ficha se lo muestra al equipo clínico, no a recepción.
    const rowOf = (body: unknown) =>
      (body as Summary[]).find((r) => r.id === created.id);
    const forReception = await as(clinicA, receptionToken)
      .get(`/patients/${patientId}/medical-history/requests`)
      .expect(200);
    expect(rowOf(forReception.body)).toMatchObject({
      status: 'REJECTED',
      rejectReason: null,
    });
    expect(forReception.text).not.toContain('Respuestas de otra persona');
    const forDentist = await as(clinicA, dentistToken)
      .get(`/patients/${patientId}/medical-history/requests`)
      .expect(200);
    expect(rowOf(forDentist.body)?.rejectReason).toBe(
      'Respuestas de otra persona',
    );
  });

  it('aceptar con los ajustes del profesional guarda los ajustes (banderas recalculadas)', async () => {
    const { created, token } = await createLink(receptionToken, {});
    await publicPost(clinicA.host, token, {
      answers: withAllergyAndAnticoagulant(),
      declarationAccepted: true,
    }).expect(200);
    await as(clinicA, dentistToken)
      .post(`/medical-history/submissions/${created.id}/accept`, {
        medicalHistory: {
          allergies: [],
          medications: [{ nombre: 'Losartán', esAlerta: false }],
          notes: 'Revisado con el paciente',
          // Nunca se toman del cliente.
          hasCriticalAlert: true,
        },
      })
      .expect(200);
    const last = (await versions()).at(-1);
    expect(last).toMatchObject({
      source: 'PATIENT_FORM',
      notes: 'Revisado con el paciente',
      hasCriticalAlert: false,
    });
  });

  it('sin política publicada ni autorización vigente no se puede crear el enlace (409)', async () => {
    const patientB = await as(clinicB)
      .post('/patients', {
        docType: 'NATIONAL_ID',
        docNumber: '555',
        sex: 'M',
        firstName: 'Pedro',
        lastName: 'Sin Politica',
      })
      .expect(201);
    await as(clinicB)
      .post(
        `/patients/${(patientB.body as { id: string }).id}/medical-history/requests`,
      )
      .expect(409);
  });

  describe('aislamiento por clínica y por sede', () => {
    // ISOLATION_COVERS: POST /patients/:patientId/medical-history/requests
    // ISOLATION_COVERS: GET /patients/:patientId/medical-history/requests
    // ISOLATION_COVERS: GET /medical-history/submissions/:id
    // ISOLATION_COVERS: POST /medical-history/submissions/:id/accept
    // ISOLATION_COVERS: POST /medical-history/submissions/:id/reject
    // ISOLATION_COVERS: POST /medical-history/submissions/:id/revoke
    it('B no ve, no crea, no revisa ni anula nada de A (404) y no toca el envío de A', async () => {
      const { created } = await createLink(receptionToken, {});
      const before = await raw.medicalHistorySubmission.findUniqueOrThrow({
        where: { id: created.id },
      });
      await as(clinicB)
        .get(`/patients/${patientId}/medical-history/requests`)
        .expect(404);
      await as(clinicB)
        .post(`/patients/${patientId}/medical-history/requests`)
        .expect(404);
      await as(clinicB)
        .get(`/medical-history/submissions/${created.id}`)
        .expect(404);
      await as(clinicB)
        .post(`/medical-history/submissions/${created.id}/accept`)
        .expect(404);
      await as(clinicB)
        .post(`/medical-history/submissions/${created.id}/reject`, {
          reason: 'Hackeo',
        })
        .expect(404);
      await as(clinicB)
        .post(`/medical-history/submissions/${created.id}/revoke`)
        .expect(404);
      const inboxB = await as(clinicB)
        .get('/medical-history/submissions?status=PENDING_PATIENT')
        .expect(200);
      expect(inboxB.body).toEqual([]);
      expect(
        await raw.medicalHistorySubmission.findUniqueOrThrow({
          where: { id: created.id },
        }),
      ).toEqual(before);
    });

    it('un odontólogo restringido a otra sede no ve el envío en su bandeja y recibe 403 al abrirlo', async () => {
      const { created, token } = await createLink(receptionToken, {
        appointmentId,
      });
      await publicPost(clinicA.host, token, {
        answers: allNoAnswers(),
        declarationAccepted: true,
      }).expect(200);
      const north = await raw.location.create({
        data: locationData(REGIONAL_BOGOTA_FIXTURE, {
          tenantId: clinicA.tenantId,
          name: 'Sede Norte DX-099',
        }),
      });
      // seedMember usa un correo por rol: el segundo odontólogo va aparte,
      // con el mismo hash de contraseña que el primero.
      const { passwordHash } = await raw.user.findUniqueOrThrow({
        where: { id: dentistId },
      });
      const user = await raw.user.create({
        data: {
          email: `dentista.norte@${clinicA.subdomain}.test`,
          passwordHash,
          fullName: 'Dentista Norte',
          emailVerifiedAt: new Date(),
        },
      });
      await raw.clinicMembership.create({
        data: {
          tenantId: clinicA.tenantId,
          userId: user.id,
          role: ClinicRole.DENTIST,
        },
      });
      const restricted = { userId: user.id, email: user.email };
      const membership = await raw.clinicMembership.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId, userId: restricted.userId },
      });
      await raw.membershipLocation.create({
        data: {
          tenantId: clinicA.tenantId,
          membershipId: membership.id,
          locationId: north.id,
        },
      });
      const northToken = await loginAs(app, clinicA.host, restricted.email);
      const inbox = await as(clinicA, northToken)
        .get('/medical-history/submissions')
        .expect(200);
      expect((inbox.body as Summary[]).map((s) => s.id)).not.toContain(
        created.id,
      );
      await as(clinicA, northToken)
        .get(`/medical-history/submissions/${created.id}`)
        .expect(403);
      await as(clinicA, northToken)
        .post(`/medical-history/submissions/${created.id}/accept`)
        .expect(403);
      // La sede principal sí la ve.
      const main = await as(clinicA, dentistToken)
        .get('/medical-history/submissions')
        .expect(200);
      expect((main.body as Summary[]).map((s) => s.id)).toContain(created.id);
    });
  });
});
