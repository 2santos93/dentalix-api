import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Prisma, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import {
  REGIONAL_BOGOTA_FIXTURE,
  registerBody,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';

// Hábitos y embarazo tri-estado (Sí / No / No sabe; ausente = sin responder)
// sobre una anamnesis APPEND-ONLY: las versiones guardadas antes (booleanos;
// embarazo solo como bandera) se leen como se registraron y no se tocan.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUB = 'anam-tri-e2e';
const EMAIL = `owner@${SUB}.com`;
const PASSWORD = 'TriPass1!';

interface HistoryBody {
  version: number;
  pregnancy: string | null;
  habits: Record<string, unknown> | null;
  safetyFlags: { embarazo: boolean; semanasEmbarazo?: number };
  hasCriticalAlert: boolean;
}

describe('Anamnesis: hábitos y embarazo tri-estado (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let tenantId: string;

  const http = () => request(app.getHttpServer());
  const auth = (req: request.Test) =>
    req
      .set('X-Tenant-Host', hostFor(SUB))
      .set('Authorization', `Bearer ${token}`);

  async function newPatient(doc: string): Promise<string> {
    const res = await auth(http().post('/api/v1/patients'))
      .send({
        firstName: 'Tri',
        lastName: 'Estado',
        docType: 'NATIONAL_ID',
        docNumber: doc,
        sex: Sex.F,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }
  const put = (patientId: string, body: object) =>
    auth(http().put(`/api/v1/patients/${patientId}/medical-history`)).send(
      body,
    );
  const get = async (patientId: string): Promise<HistoryBody> =>
    (
      await auth(
        http().get(`/api/v1/patients/${patientId}/medical-history`),
      ).expect(200)
    ).body as HistoryBody;

  /** Una versión como las de ANTES de este cambio, escrita directamente. */
  async function insertLegacyVersion(
    patientId: string,
    data: { habits: object; embarazo: boolean; semanas?: number },
  ): Promise<string> {
    const row = await raw.medicalHistoryVersion.create({
      data: {
        tenantId,
        patientId,
        version: 1,
        allergies: [],
        conditions: [],
        medications: [],
        habits: data.habits,
        surgeries: [],
        safetyFlags: {
          embarazo: data.embarazo,
          ...(data.semanas !== undefined
            ? { semanasEmbarazo: data.semanas }
            : {}),
          anticoagulantes: false,
          bifosfonatos: false,
          diabetes: false,
          profilaxisAntibiotica: false,
          alergiaAnestesico: false,
          alergiaPenicilina: false,
          alergiaLatex: false,
        },
        hasCriticalAlert: data.embarazo,
      },
    });
    return row.id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await purgeTenantsBySubdomain(raw, [SUB]);
    await raw.user.deleteMany({ where: { email: EMAIL } });
    const reg = await registerVerified(
      app,
      registerBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: 'Clínica Tri',
        subdomain: SUB,
        email: EMAIL,
        password: PASSWORD,
        fullName: 'Dra. Tri',
      }),
    );
    tenantId = (reg.body as { tenantId: string }).tenantId;
    const login = await http()
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(SUB))
      .send({ email: EMAIL, password: PASSWORD })
      .expect(201);
    token = (login.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, [SUB]);
    await raw.user.deleteMany({ where: { email: EMAIL } });
    await app.close();
    await raw.$disconnect();
  });

  it('un «No» elegido al embarazo vuelve como «No» (antes, «Sin responder») y no enciende alerta', async () => {
    const patientId = await newPatient('TRI-1');
    await put(patientId, { pregnancy: 'NO', semanasEmbarazo: 9 }).expect(200);

    const history = await get(patientId);
    expect(history.pregnancy).toBe('NO');
    expect(history.safetyFlags.embarazo).toBe(false);
    expect(history.safetyFlags.semanasEmbarazo).toBeUndefined();
    expect(history.hasCriticalAlert).toBe(false);
  });

  it('«Sí» enciende la alerta con sus semanas; «No sabe» y sin responder, no', async () => {
    const patientId = await newPatient('TRI-2');
    await put(patientId, { pregnancy: 'SI', semanasEmbarazo: 12 }).expect(200);
    let history = await get(patientId);
    expect(history.pregnancy).toBe('SI');
    expect(history.safetyFlags).toMatchObject({
      embarazo: true,
      semanasEmbarazo: 12,
    });
    expect(history.hasCriticalAlert).toBe(true);

    await put(patientId, { pregnancy: 'DESCONOCE' }).expect(200);
    history = await get(patientId);
    expect(history.pregnancy).toBe('DESCONOCE');
    expect(history.safetyFlags.embarazo).toBe(false);

    await put(patientId, { notes: 'Sin preguntar el embarazo' }).expect(200);
    history = await get(patientId);
    expect(history.pregnancy).toBeNull();
    expect(history.safetyFlags.embarazo).toBe(false);
  });

  it('hábitos con «No sabe», validados', async () => {
    const patientId = await newPatient('TRI-3');
    const habits = {
      tabaquismo: { estado: 'DESCONOCE' },
      alcohol: { estado: 'SI', frecuencia: 'Fines de semana' },
      bruxismo: 'NO',
      sustancias: 'DESCONOCE',
      higieneOral: { cepilladoPorDia: 2, hilo: 'DESCONOCE' },
    };
    await put(patientId, { habits }).expect(200);
    expect((await get(patientId)).habits).toEqual(habits);

    await put(patientId, { habits: { bruxismo: 'tal vez' } }).expect(400);
    await put(patientId, { pregnancy: 'QUIZÁ' }).expect(400);
  });

  it('una versión ANTERIOR se lee como se registró y su fila no cambia', async () => {
    const patientId = await newPatient('TRI-4');
    const legacyHabits = {
      tabaquismo: { activo: true, porDia: 5 },
      alcohol: { activo: false },
      bruxismo: true,
      higieneOral: { hilo: false },
    };
    const id = await insertLegacyVersion(patientId, {
      habits: legacyHabits,
      embarazo: true,
      semanas: 20,
    });

    const history = await get(patientId);
    expect(history.version).toBe(1);
    expect(history.pregnancy).toBe('SI');
    expect(history.safetyFlags).toMatchObject({
      embarazo: true,
      semanasEmbarazo: 20,
    });
    expect(history.habits).toEqual({
      tabaquismo: { estado: 'SI', porDia: 5 },
      alcohol: { estado: 'NO' },
      bruxismo: 'SI',
      higieneOral: { hilo: 'NO' },
    });

    // La fila sigue con su forma original (append-only: nada se reescribe).
    const stored = await raw.medicalHistoryVersion.findUniqueOrThrow({
      where: { id },
    });
    expect(stored.habits).toEqual(legacyHabits);
    expect(stored.pregnancy).toBeNull();
  });

  it('una versión ANTERIOR sin embarazo marcado es «sin responder», nunca un «No» inventado', async () => {
    const patientId = await newPatient('TRI-5');
    await insertLegacyVersion(patientId, { habits: {}, embarazo: false });
    expect((await get(patientId)).pregnancy).toBeNull();
  });

  it('un cliente anterior (embarazo: true, hábitos booleanos) guarda ya la forma tri-estado', async () => {
    const patientId = await newPatient('TRI-6');
    await put(patientId, {
      embarazo: true,
      habits: { bruxismo: true, tabaquismo: { activo: false } },
    }).expect(200);

    const stored = await raw.medicalHistoryVersion.findFirstOrThrow({
      where: { patientId },
      orderBy: { version: 'desc' },
    });
    expect(stored.pregnancy).toBe('SI');
    expect(stored.habits).toEqual({
      bruxismo: 'SI',
      tabaquismo: { estado: 'NO' },
    });
  });

  it('la BD no deja que la respuesta y la bandera se contradigan', async () => {
    const patientId = await newPatient('TRI-7');
    await expect(
      raw.medicalHistoryVersion.create({
        data: {
          tenantId,
          patientId,
          version: 1,
          pregnancy: 'SI',
          safetyFlags: { embarazo: false },
        },
      }),
    ).rejects.toThrow(/mhv_pregnancy_flag_check/);
  });
});
