import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
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

// DX-247 en HTTP real: la agenda y el panel «En clínica» traen SOLO las
// banderas médicas del paciente (alerta, premedicación, anamnesis al día /
// caducada / ausente), nunca la historia; respetan clínica y sede; la ficha
// las lee por paciente; «Sin cambios hoy» y la vigencia, con sus roles.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface AlertsBody {
  hasCriticalAlert: boolean;
  requiresPremedication: boolean;
  anamnesisStatus: 'CURRENT' | 'EXPIRED' | 'MISSING';
  alerts: string[];
  anamnesisReviewedAt: string | null;
}

interface ListItem {
  id: string;
  patientId: string;
  medicalAlerts: AlertsBody;
}

const FLAG_KEYS = [
  'alerts',
  'anamnesisReviewedAt',
  'anamnesisStatus',
  'hasCriticalAlert',
  'requiresPremedication',
];

// Contenido clínico que NUNCA puede viajar con la agenda.
const CLINICAL_TEXT = [
  'Clorhexidina',
  'Warfarina',
  'Prótesis valvular',
  'PROTESIS_VALVULAR',
  'Nota clínica secreta',
];
const CLINICAL_KEYS = [
  'allergies',
  'conditions',
  'medications',
  'safetyFlags',
  'vitalSigns',
  'familyHistory',
  'surgeries',
  'semanasEmbarazo',
];

function dayFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function nextTuesday(): string {
  for (let days = 3; ; days++) {
    const day = dayFromNow(days);
    if (new Date(`${day}T00:00:00.000Z`).getUTCDay() === 2) return day;
  }
}

describe('Alertas médicas en la agenda (e2e, DX-247)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let reception: string;
  let dentist: string;
  let mainId: string;
  let northId: string;
  const patients: Record<string, string> = {};
  const appts: Record<string, string> = {};
  const futureDay = nextTuesday();

  const api = () => request(app.getHttpServer());
  const as = (
    req: request.Test,
    token: string,
    opts: { host?: string; locationId?: string } = {},
  ) => {
    const r = req
      .set('X-Tenant-Host', opts.host ?? clinic.host)
      .set('Authorization', `Bearer ${token}`);
    return opts.locationId ? r.set('X-Location-Id', opts.locationId) : r;
  };

  async function createPatient(target: Clinic, firstName: string) {
    const res = await as(api().post('/api/v1/patients'), target.adminToken, {
      host: target.host,
    })
      .send({
        docType: 'CC',
        sex: 'F',
        firstName,
        lastName: 'Alerta',
        docNumber: String(Math.floor(Math.random() * 1e9)),
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  const saveHistory = (patientId: string, body: object) =>
    as(
      api().put(`/api/v1/patients/${patientId}/medical-history`),
      clinic.adminToken,
    )
      .send(body)
      .expect(200);

  async function book(key: string, locationId: string, hour: number) {
    const res = await as(
      api().post('/api/v1/appointments'),
      clinic.adminToken,
      {
        locationId,
      },
    )
      .send({
        patientId: patients[key],
        providerId: clinic.adminUserId,
        start: `${futureDay}T${String(hour).padStart(2, '0')}:00:00.000Z`,
        end: `${futureDay}T${String(hour).padStart(2, '0')}:15:00.000Z`,
        reason: 'Control',
      })
      .expect(201);
    appts[key] = (res.body as { id: string }).id;
  }

  const listDay = (token: string, locationId?: string) =>
    as(
      api()
        .get('/api/v1/appointments')
        .query({
          from: `${futureDay}T00:00:00.000Z`,
          to: `${futureDay}T23:59:59.000Z`,
        }),
      token,
      { locationId },
    ).expect(200);

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx247-e2e');
    other = await registerClinic(app, 'dx247-e2e-otra');
    reception = await loginAs(
      app,
      clinic.host,
      (await seedMember(raw, clinic, ClinicRole.RECEPTION)).email,
    );
    dentist = await loginAs(
      app,
      clinic.host,
      (await seedMember(raw, clinic, ClinicRole.DENTIST)).email,
    );

    const locations = await as(
      api().get('/api/v1/locations'),
      clinic.adminToken,
    ).expect(200);
    mainId = (locations.body as { id: string }[])[0].id;
    const north = await as(api().post('/api/v1/locations'), clinic.adminToken)
      .send({ name: 'Sede Norte' })
      .expect(201);
    northId = (north.body as { id: string }).id;
    for (const locationId of [mainId, northId]) {
      await as(api().put('/api/v1/locations/schedule'), clinic.adminToken, {
        locationId,
      })
        .send({
          timezone: 'America/Bogota',
          ranges: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
            weekday,
            startMinute: 0,
            endMinute: 1440,
          })),
        })
        .expect(200);
    }

    patients.premed = await createPatient(clinic, 'Premedicada');
    patients.expired = await createPatient(clinic, 'Caducada');
    patients.none = await createPatient(clinic, 'Sinanamnesis');
    patients.clean = await createPatient(clinic, 'Limpia');
    patients.north = await createPatient(clinic, 'Norte');
    patients.foreign = await createPatient(other, 'Ajena');

    await saveHistory(patients.premed, {
      conditions: [
        {
          codigo: 'PROTESIS_VALVULAR',
          etiqueta: 'Prótesis valvular',
          estado: 'SI',
          esAlerta: true,
        },
      ],
      allergies: [
        {
          alergeno: 'Clorhexidina',
          tipo: 'MATERIAL',
          severidad: 'ANAFILAXIA',
          esAlerta: true,
        },
      ],
      medications: [{ nombre: 'Warfarina', dosis: '5 mg', esAlerta: true }],
      notes: 'Nota clínica secreta',
    });
    // La única versión de «Caducada» tiene dos años: la historia es
    // inalterable (DX-038), así que se siembra ya antigua.
    await raw.medicalHistoryVersion.create({
      data: {
        tenantId: clinic.tenantId,
        patientId: patients.expired,
        version: 1,
        notes: 'Nota clínica secreta',
        safetyFlags: {},
        hasCriticalAlert: false,
        createdById: clinic.adminUserId,
        createdAt: new Date(Date.now() - 2 * 365 * 86_400_000),
      },
    });
    await saveHistory(patients.clean, {});
    await saveHistory(patients.north, {
      allergies: [
        {
          alergeno: 'Látex',
          tipo: 'MATERIAL',
          severidad: 'MODERADA',
          esAlerta: true,
        },
      ],
    });

    await book('premed', mainId, 14);
    await book('expired', mainId, 15);
    await book('none', mainId, 16);
    await book('clean', mainId, 17);
    await book('north', northId, 18);
  }, 60_000);

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await app.close();
  });

  it('GET /appointments trae SOLO banderas: ningún campo ni texto clínico', async () => {
    const res = await listDay(reception, mainId);
    const items = res.body as ListItem[];
    expect(items).toHaveLength(4);
    for (const item of items) {
      expect(Object.keys(item.medicalAlerts).sort()).toEqual(FLAG_KEYS);
    }
    const json = JSON.stringify(res.body);
    for (const text of CLINICAL_TEXT) expect(json).not.toContain(text);
    for (const key of CLINICAL_KEYS) expect(json).not.toContain(`"${key}"`);
  });

  it('premedicación, anamnesis caducada, «Sin anamnesis» y paciente limpio', async () => {
    const res = await listDay(dentist, mainId);
    const by = new Map(
      (res.body as ListItem[]).map((a) => [a.patientId, a.medicalAlerts]),
    );
    expect(by.get(patients.premed)).toMatchObject({
      hasCriticalAlert: true,
      requiresPremedication: true,
      anamnesisStatus: 'CURRENT',
      alerts: ['anticoagulantes', 'profilaxisAntibiotica', 'alergiaMarcada'],
    });
    expect(by.get(patients.expired)).toMatchObject({
      hasCriticalAlert: false,
      requiresPremedication: false,
      anamnesisStatus: 'EXPIRED',
      alerts: [],
    });
    expect(by.get(patients.none)).toEqual({
      hasCriticalAlert: false,
      requiresPremedication: false,
      anamnesisStatus: 'MISSING',
      alerts: [],
      anamnesisReviewedAt: null,
    });
    expect(by.get(patients.clean)).toMatchObject({
      hasCriticalAlert: false,
      anamnesisStatus: 'CURRENT',
      alerts: [],
    });
  });

  it('respeta la sede: la Sede Norte solo trae su cita, con su alerta', async () => {
    const north = (await listDay(reception, northId)).body as ListItem[];
    expect(north.map((a) => a.patientId)).toEqual([patients.north]);
    expect(north[0].medicalAlerts.alerts).toEqual(['alergiaLatex']);
    const main = (await listDay(reception, mainId)).body as ListItem[];
    expect(main.map((a) => a.patientId)).not.toContain(patients.north);
  });

  it('respeta la clínica: la otra no ve las citas ni las banderas de esta', async () => {
    const res = await as(
      api()
        .get('/api/v1/appointments')
        .query({
          from: `${futureDay}T00:00:00.000Z`,
          to: `${futureDay}T23:59:59.000Z`,
        }),
      other.adminToken,
      { host: other.host },
    ).expect(200);
    expect(res.body).toEqual([]);
    await as(
      api().get(`/api/v1/patients/${patients.premed}/medical-alerts`),
      other.adminToken,
      { host: other.host },
    ).expect(404);
    await as(
      api().get(`/api/v1/patients/${patients.foreign}/medical-alerts`),
      reception,
    ).expect(404);
  });

  it('GET /appointments/:id sigue sin banderas ni historia', async () => {
    const res = await as(
      api().get(`/api/v1/appointments/${appts.premed}`),
      reception,
    ).expect(200);
    expect(res.body).not.toHaveProperty('medicalAlerts');
    const json = JSON.stringify(res.body);
    for (const text of CLINICAL_TEXT) expect(json).not.toContain(text);
  });

  it('el panel «En clínica» trae la misma alerta', async () => {
    const now = new Date();
    await raw.appointment.update({
      where: { id: appts.premed },
      data: {
        start: now,
        end: new Date(now.getTime() + 15 * 60_000),
        status: 'ARRIVED',
        preArrivalStatus: 'SCHEDULED',
        arrivedAt: now,
      },
    });
    const res = await as(
      api().get('/api/v1/appointments/in-clinic'),
      reception,
      { locationId: mainId },
    ).expect(200);
    const waiting = (
      res.body as { waiting: (ListItem & { appointmentId: string })[] }
    ).waiting;
    const item = waiting.find((w) => w.appointmentId === appts.premed);
    expect(item?.medicalAlerts).toMatchObject({
      hasCriticalAlert: true,
      requiresPremedication: true,
    });
    const json = JSON.stringify(res.body);
    for (const text of CLINICAL_TEXT) expect(json).not.toContain(text);
  });

  it('la ficha: recepción lee las banderas con la vigencia y la última revisión', async () => {
    const res = await as(
      api().get(`/api/v1/patients/${patients.expired}/medical-alerts`),
      reception,
    ).expect(200);
    expect(res.body).toMatchObject({
      anamnesisStatus: 'EXPIRED',
      validityMonths: 12,
      lastReview: { kind: 'UPDATED', byName: 'Dr. Owner' },
    });
    for (const text of CLINICAL_TEXT) {
      expect(JSON.stringify(res.body)).not.toContain(text);
    }
  });

  it('«Sin cambios hoy»: recepción no (403); el odontólogo sí y deja de estar caducada', async () => {
    const path = `/api/v1/patients/${patients.expired}/medical-history/no-changes`;
    await as(api().post(path), reception).expect(403);
    await as(api().post(path), dentist).expect(201);
    const after = (await listDay(reception, mainId)).body as ListItem[];
    const expired = after.find((a) => a.patientId === patients.expired);
    expect(expired?.medicalAlerts.anamnesisStatus).toBe('CURRENT');
    // Sin anamnesis no hay nada que confirmar.
    await as(
      api().post(
        `/api/v1/patients/${patients.none}/medical-history/no-changes`,
      ),
      dentist,
    ).expect(409);
  });

  it('vigencia: la leen todos, solo ADMIN la cambia, 1..60 y queda auditada', async () => {
    const settings = '/api/v1/medical-history/settings';
    await as(api().get(settings), reception)
      .expect(200)
      .expect({ anamnesisValidityMonths: 12 });
    await as(api().put(settings), dentist)
      .send({ anamnesisValidityMonths: 6 })
      .expect(403);
    await as(api().put(settings), clinic.adminToken)
      .send({ anamnesisValidityMonths: 0 })
      .expect(400);
    await as(api().put(settings), clinic.adminToken)
      .send({ anamnesisValidityMonths: 6 })
      .expect(200)
      .expect({ anamnesisValidityMonths: 6 });
    // La otra clínica sigue con 12.
    await as(api().get(settings), other.adminToken, { host: other.host })
      .expect(200)
      .expect({ anamnesisValidityMonths: 12 });
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        resourceType: 'MEDICAL_HISTORY',
        patientId: null,
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      reason: 'ANAMNESIS_VALIDITY_SETTINGS',
      statusChange: { from: 'MONTHS_12', to: 'MONTHS_6' },
    });
  });
});
