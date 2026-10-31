import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
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
import {
  locationBody,
  REGIONAL_BOGOTA_FIXTURE,
} from './support/location-fixtures';

// DX-407 · hoja de sedación consciente en la evolución, de punta a punta con
// Postgres: valoración previa (400 con lo que falta, ASA III), checklist con
// hora y usuario, fármacos (N2O), constantes por tiempo con el aviso de
// intervalo, egreso (criterios o Aldrete, operador ≠ monitor), permisos por
// rol (la asistente registra constantes), aislamiento por clínica y por sede,
// inmutabilidad (405 y trigger en las cinco tablas) y auditoría sin datos
// clínicos. DIRECT_URL solo para sembrar y leer.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Problem {
  code: string;
  message: string;
}

interface Sheet {
  id: string;
  status: string;
  bmi: number | null;
  naloxoneMg: number | null;
  flumazenilMg: number | null;
  templateVersion: string;
  vitalsIntervalMinutes: number;
  author: { id: string; name: string | null };
  assessedAt: string;
  createdAt: string;
  checklist: {
    items: { code: string; checked: boolean }[];
    author: { id: string };
    checkedAt: string;
  } | null;
  agents: { kind: string; route: string; n2oPercent: number | null }[];
  vitals: { phase: string; author: { id: string } }[];
  discharge: {
    operator: { id: string };
    monitor: { id: string };
    aldreteScore: number | null;
    vitalsId: string;
  } | null;
  watch: {
    active: boolean;
    overdue: boolean;
    overdueMinutes: number;
    nextDueAt: string | null;
  };
}

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const ASSESSMENT = {
  grade: 'MODERATE',
  asaClass: 'II',
  asaEmergency: false,
  fastingClearLiquidsHours: 2,
  fastingSolidsHours: 6,
  mallampati: 2,
  weightKg: 15,
  heightCm: 100,
  escortName: 'Laura Ortiz',
  escortRelationship: 'Madre',
  consentConfirmed: true,
};

const VITALS = {
  spo2: 98,
  heartRate: 96,
  systolic: 98,
  diastolic: 60,
  respiratoryRate: 22,
  sedationLevel: 'MINIMAL',
};

const CHECKLIST_CODES = [
  'MONITORS_TESTED',
  'OXYGEN_SUCTION',
  'EMERGENCY_KIT',
  'REVERSAL_AGENTS',
  'NO_CONTRAINDICATION',
  'TWO_ADULTS_TRANSPORT',
];
const CRITERIA = [
  'CARDIOVASCULAR_STABLE',
  'AIRWAY_PATENT',
  'EASILY_AROUSABLE',
  'PROTECTIVE_REFLEXES',
  'BASELINE_SPEECH_SITTING',
  'HYDRATION',
];

describe('Hoja de sedación en la evolución (DX-407, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let dentist: { token: string; userId: string };
  let assistant: { token: string; userId: string };
  let reception: string;
  let restricted: string;
  let child: string;
  let childEntry: string;
  let other: string;
  let otherEntry: string;
  let consent: string;
  let otherConsent: string;
  let consentB: string;
  let patientB: string;
  let entryB: string;

  const http = () => request(app.getHttpServer());
  function call(
    clinic: Clinic,
    verb: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    token: string,
  ) {
    return http()
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  }
  const sheet = (patientId: string, entryId: string) =>
    `/patients/${patientId}/clinical-entries/${entryId}/sedation`;
  const problems = (body: unknown) =>
    (body as { problems: Problem[] }).problems.map((p) => p.code);

  async function createPatient(clinic: Clinic, name: string) {
    const patient = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: name,
        lastName: 'Prueba',
        birthDate: new Date('2020-04-02'),
      },
    });
    return patient.id;
  }

  async function createEntry(clinic: Clinic, patientId: string, token: string) {
    const res = await call(
      clinic,
      'post',
      `/patients/${patientId}/clinical-entries`,
      token,
    )
      .send({ notes: 'Restauraciones bajo sedación con N2O' })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function createConsent(clinic: Clinic, patientId: string) {
    const template = await raw.consentTemplate.upsert({
      where: {
        tenantId_title: { tenantId: clinic.tenantId, title: 'Sedación' },
      },
      update: {},
      create: {
        tenantId: clinic.tenantId,
        title: 'Sedación',
        body: 'Autorizo la sedación consciente.',
      },
    });
    const row = await raw.patientConsent.create({
      data: {
        tenantId: clinic.tenantId,
        patientId,
        templateId: template.id,
        templateVersion: template.version,
        title: 'Sedación',
        body: 'Autorizo la sedación consciente.',
        signerType: 'GUARDIAN',
        signerName: 'Laura Ortiz',
        signerDocument: 'CC 123',
        professionalName: 'Dra. Prueba',
        patientSignature: 'iVBORw0KGgo=',
        professionalSignature: 'iVBORw0KGgo=',
        contentHash: 'a'.repeat(64),
        signedAt: new Date(),
        recordedById: clinic.adminUserId,
      },
    });
    return row.id;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx407-a');
    b = await registerClinic(app, 'dx407-b');
    const d = await seedMember(raw, a, 'DENTIST');
    dentist = { token: await loginAs(app, a.host, d.email), userId: d.userId };
    const s = await seedMember(raw, a, 'ASSISTANT');
    assistant = {
      token: await loginAs(app, a.host, s.email),
      userId: s.userId,
    };
    reception = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, 'RECEPTION')).email,
    );

    // Un odontólogo restringido a otra sede (DX-089).
    const north = (
      await call(a, 'post', '/locations', a.adminToken)
        .send(locationBody(REGIONAL_BOGOTA_FIXTURE, { name: 'Sede Norte' }))
        .expect(201)
    ).body as { id: string };
    const restrictedUser = await raw.user.create({
      data: {
        email: 'norte@dx407-a.test',
        passwordHash: (
          await raw.user.findUniqueOrThrow({ where: { id: d.userId } })
        ).passwordHash,
        fullName: 'Dentista Norte',
        emailVerifiedAt: new Date(),
      },
    });
    const membership = await raw.clinicMembership.create({
      data: {
        tenantId: a.tenantId,
        userId: restrictedUser.id,
        role: 'DENTIST',
      },
    });
    await raw.membershipLocation.create({
      data: {
        tenantId: a.tenantId,
        membershipId: membership.id,
        locationId: north.id,
      },
    });
    restricted = await loginAs(app, a.host, 'norte@dx407-a.test');

    child = await createPatient(a, 'Martina');
    childEntry = await createEntry(a, child, dentist.token);
    other = await createPatient(a, 'Otro');
    otherEntry = await createEntry(a, other, dentist.token);
    consent = await createConsent(a, child);
    otherConsent = await createConsent(a, other);
    patientB = await createPatient(b, 'Bea');
    entryB = await createEntry(b, patientB, b.adminToken);
    consentB = await createConsent(b, patientB);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await app.close();
  });

  describe('valoración previa', () => {
    it('sin hoja: plantilla de plataforma (intervalo 5 min) y ninguna hoja', async () => {
      const res = await call(
        a,
        'get',
        sheet(child, childEntry),
        assistant.token,
      ).expect(200);
      expect(res.body).toMatchObject({
        sheet: null,
        template: {
          version: 'SEDATION_PLATFORM_V1',
          source: 'PLATFORM',
          vitalsIntervalMinutes: 5,
          aldreteMinimum: 9,
        },
      });
    });

    it('incompleta: 400 con la lista de lo que falta', async () => {
      const res = await call(a, 'post', sheet(child, childEntry), dentist.token)
        .send({
          ...ASSESSMENT,
          mallampati: undefined,
          heightCm: undefined,
          consentConfirmed: false,
        })
        .expect(400);
      expect(problems(res.body)).toEqual(['MALLAMPATI', 'HEIGHT', 'CONSENT']);
      expect((res.body as { message: string }).message).toContain('Mallampati');
    });

    it('ASA III sin interconsulta ni justificación: 400', async () => {
      const res = await call(a, 'post', sheet(child, childEntry), dentist.token)
        .send({ ...ASSESSMENT, asaClass: 'III' })
        .expect(400);
      expect(problems(res.body)).toEqual(['HIGH_ASA_REASON']);
    });

    it('un consentimiento de otro paciente o de otra clínica: 404', async () => {
      for (const id of [otherConsent, consentB]) {
        await call(a, 'post', sheet(child, childEntry), dentist.token)
          .send({ ...ASSESSMENT, consentId: id })
          .expect(404);
      }
      expect(
        await raw.sedationRecord.count({ where: { tenantId: a.tenantId } }),
      ).toBe(0);
    });

    it('la asistente no la abre; recepción ni la lee', async () => {
      await call(a, 'post', sheet(child, childEntry), assistant.token)
        .send(ASSESSMENT)
        .expect(403);
      await call(a, 'get', sheet(child, childEntry), reception).expect(403);
    });

    it('completa: 201 con IMC y reversores por peso, y auditada sin datos clínicos', async () => {
      const assessedAt = ago(40);
      const before = Date.now();
      const res = await call(a, 'post', sheet(child, childEntry), dentist.token)
        .send({ ...ASSESSMENT, consentId: consent, assessedAt })
        .expect(201);
      const body = res.body as Sheet;
      // La hora clínica es la anotada; el registro, la del servidor.
      expect(body.assessedAt).toBe(assessedAt);
      expect(new Date(body.createdAt).getTime()).toBeGreaterThanOrEqual(
        before - 1000,
      );
      expect(body).toMatchObject({
        status: 'ASSESSED',
        bmi: 15,
        naloxoneMg: 1.5,
        flumazenilMg: 0.15,
        templateVersion: 'SEDATION_PLATFORM_V1',
        vitalsIntervalMinutes: 5,
        author: { id: dentist.userId, name: 'Miembro DENTIST' },
      });
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          resourceType: 'SEDATION_RECORD',
          action: 'CREATE',
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        resourceId: body.id,
        actorUserId: dentist.userId,
      });
      expect(events[0].metadata).toMatchObject({
        reason: 'SEDATION_ASSESSMENT',
      });
      expect(JSON.stringify(events[0].metadata)).not.toMatch(
        /Laura|Madre|weight/,
      );
    });

    it('la anestesia de la evolución usa el peso de hoy de la valoración, no el de la anamnesis', async () => {
      const products = (
        await call(a, 'post', '/anesthetics/samples', a.adminToken).expect(201)
      ).body as { id: string; activeIngredient: string }[];
      const lido = products.find((p) => /lidoca/i.test(p.activeIngredient));
      if (!lido) throw new Error('sin lidocaína de ejemplo');
      const res = await call(
        a,
        'post',
        `/patients/${child}/clinical-entries/${childEntry}/anesthesia/check`,
        dentist.token,
      )
        .send({ anestheticId: lido.id, carpules: 1 })
        .expect(200);
      expect(res.body).toMatchObject({
        summary: { weightKg: 15 },
        weightSource: 'ENTERED',
      });
    });

    it('una segunda hoja en la misma evolución: 409', async () => {
      await call(a, 'post', sheet(child, childEntry), dentist.token)
        .send(ASSESSMENT)
        .expect(409);
    });
  });

  describe('checklist, fármacos y constantes', () => {
    it('antes del checklist: la toma basal sí (asistente); el fármaco y la intraoperatoria, 409', async () => {
      await call(
        a,
        'post',
        `${sheet(child, childEntry)}/vitals`,
        assistant.token,
      )
        .send({
          phase: 'BASELINE',
          takenAt: ago(30),
          ...VITALS,
          sedationLevel: 'AWAKE',
        })
        .expect(201);
      await call(
        a,
        'post',
        `${sheet(child, childEntry)}/vitals`,
        assistant.token,
      )
        .send({ phase: 'INTRA', ...VITALS })
        .expect(409);
      await call(a, 'post', `${sheet(child, childEntry)}/agents`, dentist.token)
        .send({ kind: 'NITROUS_OXIDE', n2oPercent: 30, flowLpm: 6 })
        .expect(409);
    });

    it('checklist sin un obligatorio: 400; la asistente no lo marca', async () => {
      const res = await call(
        a,
        'post',
        `${sheet(child, childEntry)}/checklist`,
        dentist.token,
      )
        .send({
          items: CHECKLIST_CODES.map((code) => ({
            code,
            checked: code !== 'REVERSAL_AGENTS',
          })),
        })
        .expect(400);
      expect(problems(res.body)).toEqual(['REVERSAL_AGENTS']);
      await call(
        a,
        'post',
        `${sheet(child, childEntry)}/checklist`,
        assistant.token,
      )
        .send({
          items: CHECKLIST_CODES.map((code) => ({ code, checked: true })),
        })
        .expect(403);
    });

    it('checklist con hora anterior a la valoración: 400', async () => {
      const res = await call(
        a,
        'post',
        `${sheet(child, childEntry)}/checklist`,
        dentist.token,
      )
        .send({
          items: CHECKLIST_CODES.map((code) => ({ code, checked: true })),
          checkedAt: ago(45),
        })
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        'La hora del checklist no puede ser anterior a la de la valoración previa.',
      );
    });

    it('checklist completo: hora (por defecto, ahora) y quien lo marca; un segundo, 409', async () => {
      const before = Date.now();
      const res = await call(
        a,
        'post',
        `${sheet(child, childEntry)}/checklist`,
        dentist.token,
      )
        .send({
          items: CHECKLIST_CODES.map((code) => ({ code, checked: true })),
        })
        .expect(201);
      const body = res.body as Sheet;
      expect(body.status).toBe('CHECKED');
      expect(body.checklist?.author.id).toBe(dentist.userId);
      expect(
        new Date(body.checklist?.checkedAt ?? 0).getTime(),
      ).toBeGreaterThanOrEqual(before - 1000);
      await call(
        a,
        'post',
        `${sheet(child, childEntry)}/checklist`,
        dentist.token,
      )
        .send({
          items: CHECKLIST_CODES.map((code) => ({ code, checked: true })),
        })
        .expect(409);
    });

    it('N2O al 30 % con 6 l/min (odontólogo); la asistente no administra', async () => {
      const res = await call(
        a,
        'post',
        `${sheet(child, childEntry)}/agents`,
        dentist.token,
      )
        .send({
          kind: 'NITROUS_OXIDE',
          n2oPercent: 30,
          flowLpm: 6,
          administeredAt: ago(20),
        })
        .expect(201);
      expect((res.body as Sheet).agents).toEqual([
        expect.objectContaining({
          kind: 'NITROUS_OXIDE',
          route: 'INHALED',
          n2oPercent: 30,
        }),
      ]);
      await call(
        a,
        'post',
        `${sheet(child, childEntry)}/agents`,
        assistant.token,
      )
        .send({ kind: 'NITROUS_OXIDE', n2oPercent: 30, flowLpm: 6 })
        .expect(403);
    });

    it('un valor fuera de rango dice el rango permitido (N₂O al 80 %, SpO₂ 140)', async () => {
      const n2o = await call(
        a,
        'post',
        `${sheet(child, childEntry)}/agents`,
        dentist.token,
      )
        .send({ kind: 'NITROUS_OXIDE', n2oPercent: 80, flowLpm: 6 })
        .expect(400);
      expect(JSON.stringify(n2o.body)).toContain(
        'El N₂O tiene que estar entre 10 y 70 %.',
      );
      const spo2 = await call(
        a,
        'post',
        `${sheet(child, childEntry)}/vitals`,
        assistant.token,
      )
        .send({ phase: 'INTRA', ...VITALS, spo2: 140 })
        .expect(400);
      expect(JSON.stringify(spo2.body)).toContain(
        'La SpO₂ tiene que estar entre 50 y 100 %.',
      );
    });

    it('la asistente registra la toma intraoperatoria; pasado el intervalo, la hoja avisa', async () => {
      const res = await call(
        a,
        'post',
        `${sheet(child, childEntry)}/vitals`,
        assistant.token,
      )
        .send({ phase: 'INTRA', takenAt: ago(16), ...VITALS })
        .expect(201);
      const body = res.body as Sheet;
      expect(body.status).toBe('IN_PROGRESS');
      expect(body.vitals.at(-1)?.author.id).toBe(assistant.userId);
      // Última toma hace 16 min con intervalo de 5: vencía hace ~11.
      expect(body.watch).toMatchObject({ active: true, overdue: true });
      expect(body.watch.overdueMinutes).toBeGreaterThanOrEqual(10);

      const now = await call(
        a,
        'post',
        `${sheet(child, childEntry)}/vitals`,
        assistant.token,
      )
        .send({ phase: 'INTRA', ...VITALS })
        .expect(201);
      expect((now.body as Sheet).watch).toMatchObject({ overdue: false });
    });

    it('toma incompleta o con la TA al revés: 400', async () => {
      const res = await call(
        a,
        'post',
        `${sheet(child, childEntry)}/vitals`,
        assistant.token,
      )
        .send({ phase: 'INTRA', ...VITALS, systolic: 60, diastolic: 90 })
        .expect(400);
      expect(problems(res.body)).toEqual(['BLOOD_PRESSURE_ORDER']);
      await call(
        a,
        'post',
        `${sheet(child, childEntry)}/vitals`,
        assistant.token,
      )
        .send({ phase: 'INTRA', spo2: 140 })
        .expect(400);
    });
  });

  describe('egreso', () => {
    const body = (overrides: Record<string, unknown> = {}) => ({
      criteria: CRITERIA.map((code) => ({ code, met: true })),
      vitals: { ...VITALS, sedationLevel: 'AWAKE' },
      handedOverToName: 'Laura Ortiz',
      handedOverToRelationship: 'Madre',
      instructionsDelivered: true,
      monitorId: assistant.userId,
      ...overrides,
    });

    it('un monitor de otra clínica: 400', async () => {
      await call(
        a,
        'post',
        `${sheet(child, childEntry)}/discharge`,
        dentist.token,
      )
        .send(body({ monitorId: b.adminUserId }))
        .expect(400);
    });

    it('sin los criterios ni Aldrete ≥ 9, o sin indicaciones: 400 y no cierra', async () => {
      const res = await call(
        a,
        'post',
        `${sheet(child, childEntry)}/discharge`,
        dentist.token,
      )
        .send(
          body({
            criteria: CRITERIA.slice(1).map((code) => ({ code, met: true })),
            instructionsDelivered: false,
          }),
        )
        .expect(400);
      expect(problems(res.body)).toEqual([
        'DISCHARGE_CRITERIA',
        'INSTRUCTIONS',
      ]);
      // Revisión: un Aldrete anotado < 9 no cierra aunque se marquen los 6
      // criterios, ni con el paciente aún en sedación moderada.
      const low = await call(
        a,
        'post',
        `${sheet(child, childEntry)}/discharge`,
        dentist.token,
      )
        .send(
          body({
            aldreteScore: 7,
            vitals: { ...VITALS, sedationLevel: 'MODERATE' },
          }),
        )
        .expect(400);
      expect(problems(low.body)).toEqual([
        'ALDRETE_BELOW_MINIMUM',
        'DISCHARGE_SEDATION_LEVEL',
      ]);
      expect(
        await raw.sedationDischarge.count({ where: { tenantId: a.tenantId } }),
      ).toBe(0);
    });

    it('sedación moderada con el operador como monitor: 400 sin justificación', async () => {
      const res = await call(
        a,
        'post',
        `${sheet(child, childEntry)}/discharge`,
        dentist.token,
      )
        .send(body({ monitorId: dentist.userId }))
        .expect(400);
      expect(problems(res.body)).toEqual(['SAME_MONITOR']);
    });

    it('la asistente no firma el egreso', async () => {
      await call(
        a,
        'post',
        `${sheet(child, childEntry)}/discharge`,
        assistant.token,
      )
        .send(body())
        .expect(403);
    });

    it('con Aldrete 9: cierra con constantes al alta, operador y monitor; después todo es 409', async () => {
      const res = await call(
        a,
        'post',
        `${sheet(child, childEntry)}/discharge`,
        dentist.token,
      )
        .send(body({ criteria: [], aldreteScore: 9 }))
        .expect(201);
      const closed = res.body as Sheet;
      expect(closed.status).toBe('DISCHARGED');
      expect(closed.watch.active).toBe(false);
      expect(closed.discharge).toMatchObject({
        aldreteScore: 9,
        operator: { id: dentist.userId },
        monitor: { id: assistant.userId },
      });
      const alta = closed.vitals.find((v) => v.phase === 'DISCHARGE');
      expect(alta).toBeDefined();

      await call(
        a,
        'post',
        `${sheet(child, childEntry)}/vitals`,
        assistant.token,
      )
        .send({ phase: 'INTRA', ...VITALS })
        .expect(409);
      await call(a, 'post', `${sheet(child, childEntry)}/agents`, dentist.token)
        .send({ kind: 'ORAL', drugName: 'Midazolam', dose: 5, doseUnit: 'MG' })
        .expect(409);
      await call(
        a,
        'post',
        `${sheet(child, childEntry)}/discharge`,
        dentist.token,
      )
        .send(body())
        .expect(409);

      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          resourceType: 'SEDATION_RECORD',
          action: 'CREATE',
        },
      });
      expect(
        events.map((e) => (e.metadata as { reason?: string }).reason).sort(),
      ).toEqual(
        [
          'SEDATION_AGENT',
          'SEDATION_ASSESSMENT',
          'SEDATION_CHECKLIST',
          'SEDATION_DISCHARGE',
          'SEDATION_VITALS',
          'SEDATION_VITALS',
          'SEDATION_VITALS',
        ].sort(),
      );
      expect(JSON.stringify(events.map((e) => e.metadata))).not.toMatch(
        /Laura|Midazolam|spo2|aldrete/i,
      );
    });

    it('dos egresos a la vez: uno cierra (201), el otro 409, y queda un solo egreso', async () => {
      const entry = await createEntry(a, other, dentist.token);
      await call(a, 'post', sheet(other, entry), dentist.token)
        .send({ ...ASSESSMENT, grade: 'MINIMAL' })
        .expect(201);
      await call(a, 'post', `${sheet(other, entry)}/checklist`, dentist.token)
        .send({
          items: CHECKLIST_CODES.map((code) => ({ code, checked: true })),
        })
        .expect(201);
      const results = await Promise.all(
        [0, 1].map(() =>
          call(a, 'post', `${sheet(other, entry)}/discharge`, dentist.token)
            .send(body())
            .then((r) => r.status),
        ),
      );
      expect(results.sort()).toEqual([201, 409]);
      const record = await raw.sedationRecord.findFirstOrThrow({
        where: { tenantId: a.tenantId, clinicalEntryId: entry },
        include: { discharge: true, vitals: true },
      });
      expect(record.discharge).not.toBeNull();
      expect(record.vitals.filter((v) => v.phase === 'DISCHARGE')).toHaveLength(
        1,
      );
    });

    it('la ficha lista la hoja de la evolución', async () => {
      const res = await call(
        a,
        'get',
        `/patients/${child}/sedation`,
        assistant.token,
      ).expect(200);
      expect((res.body as Sheet[]).map((s) => s.status)).toEqual([
        'DISCHARGED',
      ]);
    });
  });

  describe('permisos y aislamiento', () => {
    it('paciente o evolución de otra clínica, o evolución de otro paciente: 404', async () => {
      await call(b, 'get', sheet(child, childEntry), b.adminToken).expect(404);
      await call(b, 'post', sheet(child, childEntry), b.adminToken)
        .send(ASSESSMENT)
        .expect(404);
      await call(b, 'post', `${sheet(child, childEntry)}/vitals`, b.adminToken)
        .send({ phase: 'INTRA', ...VITALS })
        .expect(404);
      await call(b, 'get', `/patients/${child}/sedation`, b.adminToken).expect(
        404,
      );
      await call(a, 'get', sheet(child, otherEntry), dentist.token).expect(404);
      await call(a, 'get', sheet(patientB, entryB), a.adminToken).expect(404);
    });

    it('una evolución sin hoja: 404 al añadir checklist, fármaco, toma o egreso', async () => {
      await call(
        a,
        'post',
        `${sheet(other, otherEntry)}/checklist`,
        dentist.token,
      )
        .send({ items: [] })
        .expect(404);
      await call(
        a,
        'post',
        `${sheet(other, otherEntry)}/vitals`,
        assistant.token,
      )
        .send({ phase: 'BASELINE', ...VITALS })
        .expect(404);
    });

    it('un odontólogo restringido a otra sede: 403 en la evolución y no la ve en la ficha', async () => {
      await call(a, 'get', sheet(child, childEntry), restricted).expect(403);
      await call(a, 'post', `${sheet(child, childEntry)}/vitals`, restricted)
        .send({ phase: 'INTRA', ...VITALS })
        .expect(403);
      const all = await call(
        a,
        'get',
        `/patients/${child}/sedation`,
        restricted,
      ).expect(200);
      expect(all.body).toEqual([]);
    });

    it('la RLS: con el tenant de B, la app no ve ninguna fila de A', async () => {
      const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });
      try {
        const seen = await appRole.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${b.tenantId}, true)`;
          return Promise.all([
            tx.sedationRecord.count(),
            tx.sedationChecklist.count(),
            tx.sedationAgentAdministration.count(),
            tx.sedationVitals.count(),
            tx.sedationDischarge.count(),
          ]);
        });
        expect(seen).toEqual([0, 0, 0, 0, 0]);
      } finally {
        await appRole.$disconnect();
      }
    });
  });

  describe('inmutabilidad', () => {
    it('PATCH/PUT/DELETE responden 405 remitiendo a la adenda', async () => {
      for (const verb of ['patch', 'put', 'delete'] as const) {
        const res = await call(
          a,
          verb,
          sheet(child, childEntry),
          dentist.token,
        ).expect(405);
        expect((res.body as { message: string }).message).toContain('adenda');
      }
    });

    it('la BD rechaza UPDATE y DELETE del rol de la app en las cinco tablas', async () => {
      const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });
      const asApp = (sql: Prisma.Sql) =>
        appRole.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
          return tx.$executeRaw(sql);
        });
      try {
        for (const table of [
          'sedation_records',
          'sedation_checklists',
          'sedation_agent_administrations',
          'sedation_vitals',
          'sedation_discharges',
        ]) {
          const t = Prisma.raw(`"${table}"`);
          await expect(
            asApp(
              Prisma.sql`UPDATE ${t} SET "tenantId" = "tenantId" WHERE "tenantId" = ${a.tenantId}::uuid`,
            ),
          ).rejects.toThrow(/inalterable/);
          await expect(
            asApp(
              Prisma.sql`DELETE FROM ${t} WHERE "tenantId" = ${a.tenantId}::uuid`,
            ),
          ).rejects.toThrow(/inalterable|permission denied/);
        }
      } finally {
        await appRole.$disconnect();
      }
      expect(
        await raw.sedationVitals.count({ where: { tenantId: a.tenantId } }),
        // 4 de la hoja de Martina + la toma al alta del egreso concurrente.
      ).toBe(5);
    });
  });
});
