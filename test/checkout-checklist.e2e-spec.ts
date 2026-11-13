import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  type Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  SEEDED_PASSWORD,
} from './support/e2e-fixtures';
import { PasswordService } from '../src/shared/crypto/password.service';
import { LOCATION_NOT_ALLOWED_CODE } from '../src/shared/tenancy/location-access';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationBody,
} from './support/location-fixtures';

// SEC-069: `GET /appointments/:id/checkout-checklist` (DX-202).
//  - Un id que no es UUID da 400 (ParseUUIDPipe), no un 500 de Prisma; igual
//    `GET /appointments/:id` y `PATCH /appointments/:id`, del mismo barrido.
//  - La «próxima cita» solo mira las sedes permitidas al usuario (DX-089),
//    sin la sede activa de la cabecera: una recepción acotada a Norte no se
//    entera de que el paciente tiene cita en Sur. Quien ve todas las sedes
//    sigue viendo la más cercana de cualquiera, también con `X-Location-Id`.
//  - Otra clínica: 404, sin filtrar nada de la cita ni del paciente.
//  - DX-015-bis (D16): sin próxima cita ni recall, los tipos de recall activos
//    para «Programar recall» (D15); si no, vacío.
//
// DIRECT_URL (superusuario, sin RLS) solo siembra miembros y citas.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const passwords = new PasswordService();

const NOT_A_UUID = 'no-es-un-uuid';
const DAY = 24 * 3600 * 1000;

interface Checklist {
  appointmentId: string;
  nextAppointmentStart: string | null;
}

describe('Salida del paciente: id y sedes de la próxima cita (SEC-069)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let norte: string;
  let sur: string;
  let dentistId: string;
  let restrictedToken: string;
  let unrestrictedToken: string;
  let patientId: string;
  /** La cita que se despide, en Norte. El checklist no mira el día civil. */
  let leaving: string;
  const inSur = new Date(Date.now() + 5 * DAY);
  const inNorte = new Date(Date.now() + 15 * DAY);

  const api = (token: string, host = clinic.host, locationId?: string) => {
    const set = (req: request.Test) => {
      const withAuth = req
        .set('X-Tenant-Host', host)
        .set('Authorization', `Bearer ${token}`);
      return locationId ? withAuth.set('X-Location-Id', locationId) : withAuth;
    };
    const server = () => request(app.getHttpServer());
    return {
      get: (path: string) => set(server().get(`/api/v1${path}`)),
      patch: (path: string, body: object) =>
        set(server().patch(`/api/v1${path}`)).send(body),
      post: (path: string, body: object) =>
        set(server().post(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        set(server().put(`/api/v1${path}`)).send(body),
    };
  };
  const admin = () => api(clinic.adminToken);
  const checklist = (token: string, id: string, locationId?: string) =>
    api(token, clinic.host, locationId).get(
      `/appointments/${id}/checkout-checklist`,
    );

  async function member(
    email: string,
    role: ClinicRole,
    onlyAt?: string[],
  ): Promise<{ userId: string; token: string }> {
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await passwords.hash(SEEDED_PASSWORD),
        fullName: `Miembro ${email}`,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: { tenantId: clinic.tenantId, userId: user.id, role },
    });
    if (onlyAt) {
      await admin()
        .put(`/staff/${user.id}/locations`, { locationIds: onlyAt })
        .expect(200);
    }
    return { userId: user.id, token: await loginAs(app, clinic.host, email) };
  }

  async function seedAppointment(
    locationId: string,
    start: Date,
  ): Promise<string> {
    const row = await raw.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        patientId,
        providerId: dentistId,
        start,
        end: new Date(start.getTime() + 30 * 60 * 1000),
        status: 'SCHEDULED',
      },
      select: { id: true },
    });
    return row.id;
  }

  const nextOf = (res: request.Response) =>
    (res.body as Checklist).nextAppointmentStart;

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    clinic = await registerClinic(app, 'sec069-salida');
    other = await registerClinic(app, 'sec069-otra');
    const newLocation = async (name: string) =>
      (
        (
          await admin()
            .post(
              '/locations',
              locationBody(REGIONAL_CARACAS_FIXTURE, { name }),
            )
            .expect(201)
        ).body as { id: string }
      ).id;
    norte = await newLocation('Sede Norte');
    sur = await newLocation('Sede Sur');

    dentistId = (await member('odontologa@sec069.test', ClinicRole.DENTIST))
      .userId;
    restrictedToken = (
      await member('recepcion.norte@sec069.test', ClinicRole.RECEPTION, [norte])
    ).token;
    unrestrictedToken = (
      await member('recepcion@sec069.test', ClinicRole.RECEPTION)
    ).token;

    patientId = (
      (
        await admin()
          .post('/patients', {
            firstName: 'Lucía',
            lastName: 'Urdaneta',
            docType: 'NATIONAL_ID',
            docNumber: 'SEC069-1',
            sex: Sex.F,
            phone: '+58 414 555 0169',
          })
          .expect(201)
      ).body as { id: string }
    ).id;

    // La cita que se despide (Norte) y dos posteriores: la más cercana en Sur.
    leaving = await seedAppointment(norte, new Date(Date.now() + 3600 * 1000));
    await seedAppointment(sur, inSur);
    await seedAppointment(norte, inNorte);
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  describe('id que no es UUID: 400 antes de llegar a la BD', () => {
    it('GET checkout-checklist', async () => {
      const res = await checklist(clinic.adminToken, NOT_A_UUID);
      expect(res.status).toBe(400);
    });

    it('GET /appointments/:id', async () => {
      const res = await admin().get(`/appointments/${NOT_A_UUID}`);
      expect(res.status).toBe(400);
    });

    it('PATCH /appointments/:id', async () => {
      const res = await admin().patch(`/appointments/${NOT_A_UUID}`, {
        notes: 'x',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('próxima cita y sedes permitidas', () => {
    it('acotada a Norte: sale la cita de Norte, nunca la de Sur', async () => {
      const res = await checklist(restrictedToken, leaving).expect(200);
      expect(nextOf(res)).toBe(inNorte.toISOString());
    });

    it('acotada a Norte con la cabecera de Norte: igual', async () => {
      const res = await checklist(restrictedToken, leaving, norte).expect(200);
      expect(nextOf(res)).toBe(inNorte.toISOString());
    });

    it('sin restricción: la más cercana de cualquier sede (Sur), como antes', async () => {
      const res = await checklist(unrestrictedToken, leaving).expect(200);
      expect(nextOf(res)).toBe(inSur.toISOString());
    });

    it('ADMIN con la sede activa en Norte: sigue viendo la de Sur', async () => {
      const res = await checklist(clinic.adminToken, leaving, norte).expect(
        200,
      );
      expect(nextOf(res)).toBe(inSur.toISOString());
    });

    it('acotada a Norte sobre una cita de Sur: 403 LOCATION_NOT_ALLOWED', async () => {
      const surLeaving = await seedAppointment(
        sur,
        new Date(Date.now() + 2 * 3600 * 1000),
      );
      const res = await checklist(restrictedToken, surLeaving);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: LOCATION_NOT_ALLOWED_CODE });
      await raw.appointment.delete({ where: { id: surLeaving } });
    });
  });

  describe('tipos de recall para programar (DX-015-bis, D16)', () => {
    interface WithRecallTypes {
      recallDueOn: string | null;
      nextAppointmentStart: string | null;
      recallTypes: {
        id: string;
        name: string;
        defaultIntervalMonths: number;
      }[];
    }

    it('con próxima cita: vacío', async () => {
      const res = await checklist(unrestrictedToken, leaving).expect(200);
      expect((res.body as WithRecallTypes).recallTypes).toEqual([]);
    });

    it('sin próxima cita ni recall: los activos y vivos en su orden; tras programar uno (D15), vacío y con el recall', async () => {
      const lone = (
        (
          await admin()
            .post('/patients', {
              firstName: 'Mariela',
              lastName: 'Guédez',
              docType: 'NATIONAL_ID',
              docNumber: 'DX015BIS-D16',
              sex: Sex.F,
              phone: '+58 414 555 0170',
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      const start = new Date(Date.now() - 2 * 3600 * 1000);
      const appointment = await raw.appointment.create({
        data: {
          tenantId: clinic.tenantId,
          locationId: norte,
          patientId: lone,
          providerId: dentistId,
          start,
          end: new Date(start.getTime() + 30 * 60 * 1000),
          status: 'COMPLETED',
        },
        select: { id: true },
      });
      // Un tipo desactivado y uno retirado no se ofrecen.
      await raw.recallType.createMany({
        data: [
          {
            tenantId: clinic.tenantId,
            name: 'Ortodoncia',
            defaultIntervalMonths: 2,
            active: false,
            sortOrder: 5,
          },
          {
            tenantId: clinic.tenantId,
            name: 'Blanqueamiento',
            defaultIntervalMonths: 12,
            active: false,
            sortOrder: 6,
            deletedAt: new Date(),
          },
        ],
      });
      const types = await raw.recallType.findMany({
        where: { tenantId: clinic.tenantId, active: true, deletedAt: null },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true, defaultIntervalMonths: true },
      });
      expect(types.map((t) => [t.name, t.defaultIntervalMonths])).toEqual([
        ['Higiene', 6],
        ['Control', 12],
        ['Mantenimiento periodontal', 3],
      ]);

      const before = (
        await checklist(unrestrictedToken, appointment.id).expect(200)
      ).body as WithRecallTypes;
      expect(before).toMatchObject({
        nextAppointmentStart: null,
        recallDueOn: null,
        recallTypes: types,
      });

      // «Programar recall de Control (12 meses)» desde la salida: recepción.
      await api(unrestrictedToken)
        .post(`/patients/${lone}/recalls/default`, {
          recallTypeId: types[1].id,
        })
        .expect(201);
      const after = (
        await checklist(unrestrictedToken, appointment.id).expect(200)
      ).body as WithRecallTypes;
      expect(after.recallTypes).toEqual([]);
      expect(after.recallDueOn).not.toBeNull();
    });
  });

  describe('aislamiento por clínica', () => {
    it('el ADMIN de otra clínica recibe 404 y nada de la cita', async () => {
      const res = await api(other.adminToken, other.host).get(
        `/appointments/${leaving}/checkout-checklist`,
      );
      expect(res.status).toBe(404);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(patientId);
      expect(body).not.toContain(inSur.toISOString());
    });
  });
});
