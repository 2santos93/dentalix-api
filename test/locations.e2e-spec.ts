import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const PASSWORD = 'S3cret!!';

interface RegisterBody {
  tenantId: string;
}
interface LoginBody {
  accessToken: string;
}
interface LocationBody {
  id: string;
  name: string;
  isActive: boolean;
}
interface AppointmentBody {
  id: string;
}

async function registerAndLogin(
  app: INestApplication<App>,
  opts: { clinicName: string; subdomain: string; email: string },
) {
  const register = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ ...opts, password: PASSWORD, fullName: 'Dr. Owner' })
    .expect(201);
  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor(opts.subdomain))
    .send({ email: opts.email, password: PASSWORD })
    .expect(201);
  return {
    tenantId: (register.body as RegisterBody).tenantId,
    accessToken: (login.body as LoginBody).accessToken,
    subdomain: opts.subdomain,
  };
}

async function cleanup(): Promise<void> {
  await raw.toothRecord.deleteMany();
  await raw.appointment.deleteMany();
  await raw.payment.deleteMany();
  await raw.inventoryMovement.deleteMany();
  await raw.inventoryItem.deleteMany();
  await raw.treatmentPlanItem.deleteMany();
  await raw.treatmentPlan.deleteMany();
  await raw.patient.deleteMany();
  await raw.location.deleteMany();
  await raw.clinicMembership.deleteMany();
  await raw.user.deleteMany();
  await raw.tenant.deleteMany();
}

describe('Locations / multi-sede (e2e)', () => {
  let app: INestApplication<App>;

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
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  it(
    'crea sedes, filtra la agenda por X-Location-Id, deja la vista consolidada ' +
      'sin cabecera, rechaza una sede ajena y protege la última sede activa',
    async () => {
      const clinic = await registerAndLogin(app, {
        clinicName: 'Clinica Multi',
        subdomain: 'multi',
        email: 'owner@multi.com',
      });
      const host = hostFor(clinic.subdomain);
      const auth = (r: request.Test) =>
        r
          .set('X-Tenant-Host', host)
          .set('Authorization', `Bearer ${clinic.accessToken}`);

      // --- 1. Al registrarse, la clínica ya nace con su "Sede principal".
      const initial = await auth(
        request(app.getHttpServer()).get('/api/v1/locations'),
      ).expect(200);
      const sedes = initial.body as LocationBody[];
      expect(sedes).toHaveLength(1);
      expect(sedes[0].name).toBe('Sede principal');
      const sedeA = sedes[0].id;

      // --- 2. Crear una segunda sede.
      const created = await auth(
        request(app.getHttpServer())
          .post('/api/v1/locations')
          .send({ name: 'Sede Norte', address: 'Cra 15' }),
      ).expect(201);
      const sedeB = (created.body as LocationBody).id;
      expect(sedeB).not.toBe(sedeA);

      // --- 3. Una cita creada CON la cabecera queda en esa sede.
      const patient = await auth(
        request(app.getHttpServer()).post('/api/v1/patients').send({
          firstName: 'Ana',
          lastName: 'Ruiz',
          docType: 'CC',
          docNumber: '999',
          sex: 'F',
        }),
      ).expect(201);
      const patientId = (patient.body as { id: string }).id;

      const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      const staff = await auth(
        request(app.getHttpServer()).get('/api/v1/staff'),
      ).expect(200);
      const providerId = (staff.body as { userId: string }[])[0].userId;

      const appt = await auth(
        request(app.getHttpServer())
          .post('/api/v1/appointments')
          .set('X-Location-Id', sedeB)
          .send({
            patientId,
            providerId,
            start: start.toISOString(),
            end: end.toISOString(),
          }),
      ).expect(201);
      const apptId = (appt.body as AppointmentBody).id;

      const range = {
        from: new Date(start.getTime() - 60 * 60 * 1000).toISOString(),
        to: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
      };

      // --- 4. Filtrando por la sede B aparece...
      const inB = await auth(
        request(app.getHttpServer())
          .get('/api/v1/appointments')
          .set('X-Location-Id', sedeB)
          .query(range),
      ).expect(200);
      expect((inB.body as AppointmentBody[]).map((a) => a.id)).toContain(
        apptId,
      );

      // --- 5. ...y filtrando por la sede A NO. Esto es lo que prueba que el
      // filtro por sede realmente aplica y no es decorativo.
      const inA = await auth(
        request(app.getHttpServer())
          .get('/api/v1/appointments')
          .set('X-Location-Id', sedeA)
          .query(range),
      ).expect(200);
      expect((inA.body as AppointmentBody[]).map((a) => a.id)).not.toContain(
        apptId,
      );

      // --- 6. SIN cabecera se ve todo: la vista consolidada de la clínica es
      // el comportamiento por defecto (y el que tenían los clientes de antes).
      const consolidated = await auth(
        request(app.getHttpServer()).get('/api/v1/appointments').query(range),
      ).expect(200);
      expect(
        (consolidated.body as AppointmentBody[]).map((a) => a.id),
      ).toContain(apptId);

      // --- 7. Una sede que no es de esta clínica se rechaza, no se ignora.
      const otherClinic = await registerAndLogin(app, {
        clinicName: 'Otra Clinica',
        subdomain: 'otra-multi',
        email: 'owner@otra-multi.com',
      });
      const otherSedes = await request(app.getHttpServer())
        .get('/api/v1/locations')
        .set('X-Tenant-Host', hostFor(otherClinic.subdomain))
        .set('Authorization', `Bearer ${otherClinic.accessToken}`)
        .expect(200);
      const foreignSede = (otherSedes.body as LocationBody[])[0].id;

      await auth(
        request(app.getHttpServer())
          .get('/api/v1/appointments')
          .set('X-Location-Id', foreignSede)
          .query(range),
      ).expect(400);

      // --- 8. No se puede desactivar la última sede activa: primero se
      // desactiva la B (quedan 1), y entonces la A ya no se puede desactivar.
      await auth(
        request(app.getHttpServer())
          .patch(`/api/v1/locations/${sedeB}`)
          .send({ isActive: false }),
      ).expect(200);

      await auth(
        request(app.getHttpServer())
          .patch(`/api/v1/locations/${sedeA}`)
          .send({ isActive: false }),
      ).expect(409);
    },
    30000,
  );
});
