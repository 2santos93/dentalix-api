import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, DocType, Prisma, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationBody,
  registerBody,
} from './support/location-fixtures';

// DX-036 / DB-003: las EXCLUDE anti-solape de citas se evalúan SALTANDO la RLS.
// Antes no incluían `tenantId`, así que un profesional que trabaja en dos
// clínicas recibía en la clínica B un 409 por una cita que solo existe en la
// clínica A: B deducía la ocupación de A y podía bloquearle la agenda. Ahora
// el solape solo se impide DENTRO de la misma clínica (en cualquiera de sus
// sedes), que es lo que cada clínica puede ver y gestionar.

const DAY_MS = 24 * 60 * 60 * 1000;
// Día siempre futuro: CreateAppointmentUseCase rechaza un `start` pasado.
const ANCHOR_DAY = new Date(Date.now() + 2 * DAY_MS).toISOString().slice(0, 10);
function at(time: string): string {
  return `${ANCHOR_DAY}T${time}:00.000Z`;
}

// Conexión de ADMINISTRACIÓN (DIRECT_URL, owner) solo para sembrar y limpiar:
// con RLS, el rol de runtime sin tenant en contexto no ve filas.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const PASSWORD = 'S3cret!!';

interface Clinic {
  tenantId: string;
  ownerId: string;
  subdomain: string;
  token: string;
}

async function login(
  app: INestApplication<App>,
  subdomain: string,
  email: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor(subdomain))
    .send({ email, password: PASSWORD })
    .expect(201);
  return (res.body as { accessToken: string }).accessToken;
}

async function registerClinic(
  app: INestApplication<App>,
  subdomain: string,
): Promise<Clinic> {
  const email = `owner@${subdomain}.com`;
  const res = await registerVerified(
    app,
    registerBody(REGIONAL_BOGOTA_FIXTURE, {
      clinicName: `Clinica ${subdomain}`,
      subdomain,
      email,
      password: PASSWORD,
      fullName: 'Dr. Owner',
    }),
  );
  const body = res.body as { tenantId: string; userId: string };
  const token = await login(app, subdomain, email);
  // La sede principal nace con horario por defecto; sin franjas, los casos no
  // dependen del día/hora de la corrida (este spec no prueba el horario).
  await request(app.getHttpServer())
    .put('/api/v1/locations/schedule')
    .set('X-Tenant-Host', hostFor(subdomain))
    .set('Authorization', `Bearer ${token}`)
    .send({ timezone: 'America/Bogota', ranges: [] })
    .expect(200);
  return { tenantId: body.tenantId, ownerId: body.userId, subdomain, token };
}

async function createPatient(
  app: INestApplication<App>,
  clinic: Clinic,
  docNumber: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/patients')
    .set('X-Tenant-Host', hostFor(clinic.subdomain))
    .set('Authorization', `Bearer ${clinic.token}`)
    .send({
      firstName: 'Solape',
      lastName: docNumber,
      docType: DocType.CC,
      docNumber,
      sex: Sex.F,
    })
    .expect(201);
  return (res.body as { id: string }).id;
}

function book(
  app: INestApplication<App>,
  clinic: Clinic,
  body: { patientId: string; providerId: string; start: string; end: string },
  locationId?: string,
): request.Test {
  const req = request(app.getHttpServer())
    .post('/api/v1/appointments')
    .set('X-Tenant-Host', hostFor(clinic.subdomain))
    .set('Authorization', `Bearer ${clinic.token}`);
  if (locationId) {
    req.set('X-Location-Id', locationId);
  }
  return req.send(body);
}

async function cleanup(): Promise<void> {
  await resetDatabase(raw);
}

describe('Appointments: anti-solape aislado por clínica (e2e, DX-036)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let sharedDentistId: string;
  let patientA1: string;
  let patientA2: string;
  let patientB1: string;

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
    await cleanup();

    clinicA = await registerClinic(app, 'solape-a');
    clinicB = await registerClinic(app, 'solape-b');

    // Una dentista "compartida": un único `users.id` con membresía en ambas.
    const dentist = await raw.user.create({
      data: {
        email: 'dentista@compartida.com',
        passwordHash: await passwordService.hash(PASSWORD),
        fullName: 'Dra. Compartida',
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    sharedDentistId = dentist.id;
    await raw.clinicMembership.createMany({
      data: [
        {
          tenantId: clinicA.tenantId,
          userId: dentist.id,
          role: ClinicRole.DENTIST,
        },
        {
          tenantId: clinicB.tenantId,
          userId: dentist.id,
          role: ClinicRole.DENTIST,
        },
      ],
    });

    patientA1 = await createPatient(app, clinicA, '36001');
    patientA2 = await createPatient(app, clinicA, '36002');
    patientB1 = await createPatient(app, clinicB, '36003');
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  it('permite al mismo profesional la misma franja en clínicas distintas (sin 409)', async () => {
    await book(app, clinicA, {
      patientId: patientA1,
      providerId: sharedDentistId,
      start: at('10:00'),
      end: at('10:30'),
    }).expect(201);

    // Antes de DX-036: 409 «El profesional ya tiene una cita en ese horario»
    // por una cita de la clínica A que B no puede ver.
    const res = await book(app, clinicB, {
      patientId: patientB1,
      providerId: sharedDentistId,
      start: at('10:15'),
      end: at('10:45'),
    }).expect(201);
    expect((res.body as { tenantId: string }).tenantId).toBe(clinicB.tenantId);
  });

  it('sigue devolviendo 409 al mismo profesional en la misma clínica', async () => {
    const res = await book(app, clinicA, {
      patientId: patientA2,
      providerId: sharedDentistId,
      start: at('10:10'),
      end: at('10:20'),
    }).expect(409);
    expect((res.body as { message: string }).message).toBe(
      'El profesional ya tiene una cita en ese horario',
    );
  });

  it('sigue devolviendo 409 al mismo profesional entre sedes de la misma clínica', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/locations')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.token}`)
      .send(
        locationBody(REGIONAL_BOGOTA_FIXTURE, {
          name: 'Sede Norte',
          address: 'Cra 15',
        }),
      )
      .expect(201);
    const sedeNorte = (created.body as { id: string }).id;
    await request(app.getHttpServer())
      .put('/api/v1/locations/schedule')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.token}`)
      .set('X-Location-Id', sedeNorte)
      .send({ timezone: 'America/Bogota', ranges: [] })
      .expect(200);

    // La cita de 10:00 está en la sede principal; reservar a la misma
    // profesional a la misma hora en otra sede de A es físicamente imposible.
    await book(
      app,
      clinicA,
      {
        patientId: patientA2,
        providerId: sharedDentistId,
        start: at('10:05'),
        end: at('10:25'),
      },
      sedeNorte,
    ).expect(409);
  });

  it('el solape por paciente se mantiene dentro de la clínica (409 con otro profesional)', async () => {
    const res = await book(app, clinicA, {
      patientId: patientA1,
      providerId: clinicA.ownerId,
      start: at('10:00'),
      end: at('10:30'),
    }).expect(409);
    expect((res.body as { message: string }).message).toBe(
      'El paciente ya tiene otra cita en ese horario',
    );
  });
});
