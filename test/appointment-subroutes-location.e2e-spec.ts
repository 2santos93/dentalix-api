import { INestApplication } from '@nestjs/common';
import { ClinicRole, DocType, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { CapturingMailer } from './support/capture-mailer';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  SEEDED_PASSWORD,
} from './support/e2e-fixtures';
import { PasswordService } from '../src/shared/crypto/password.service';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  LOCATION_NOT_ALLOWED_CODE,
  LOCATION_NOT_ALLOWED_MESSAGE,
} from '../src/shared/tenancy/location-access';

// SEC-045: las subrutas de una cita aplican la restricción por sedes de
// DX-089 igual que `GET /appointments/:id`. Una recepción acotada a la Sede
// Norte recibe 403 `LOCATION_NOT_ALLOWED` sobre una cita de la Sede Sur en
// las cuatro rutas, sin efectos: no se crea la entrega, no se encola el
// email y no se revoca el enlace de confirmación vigente. Sobre su sede, y
// para ADMIN y miembros sin restricción, nada cambia.
//
// Del barrido: una evolución ligada a una cita (POST
// /patients/:id/clinical-entries con `appointmentId`) toma la sede de la
// cita; un profesional acotado a Norte no puede escribirla en Sur.
//
// DIRECT_URL (superusuario, sin RLS) solo siembra miembros y citas y lee
// filas para comprobar que no hubo efectos.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const passwords = new PasswordService();

const PATIENT_EMAIL = 'lucia.restrepo@example.com';

interface Member {
  userId: string;
  token: string;
}

type Who = 'restricted' | 'unrestricted' | 'admin';
type Site = 'norte' | 'sur';

describe('Subrutas de la cita y sede permitida (SEC-045)', () => {
  let app: INestApplication<App>;
  const mailer = new CapturingMailer();
  let clinic: Clinic;
  let norte: string;
  let sur: string;
  const members = {} as Record<Who, Member>;
  let restrictedDentist: Member;
  let unrestrictedDentist: Member;
  let patientId: string;
  let templateId: string;
  const appt = {} as Record<Site, string>;
  const pastAppt = {} as Record<Site, string>;

  const api = (token: string) => {
    const server = () => request(app.getHttpServer());
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
  const admin = () => api(clinic.adminToken);

  async function seedUser(email: string, role: ClinicRole): Promise<string> {
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
    return user.id;
  }

  /** Miembro con su token; `onlyAt` lo acota a esas sedes (DX-089). */
  async function member(
    email: string,
    role: ClinicRole,
    onlyAt?: string[],
  ): Promise<Member> {
    const userId = await seedUser(email, role);
    if (onlyAt) {
      await admin()
        .put(`/staff/${userId}/locations`, { locationIds: onlyAt })
        .expect(200);
    }
    // El login lee las sedes vigentes: el token ya lleva `loc`.
    return { userId, token: await loginAs(app, clinic.host, email) };
  }

  async function seedAppointment(
    locationId: string,
    start: Date,
    status: 'SCHEDULED' | 'COMPLETED' = 'SCHEDULED',
  ): Promise<string> {
    const row = await raw.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        patientId,
        providerId: unrestrictedDentist.userId,
        start,
        end: new Date(start.getTime() + 30 * 60 * 1000),
        status,
      },
    });
    return row.id;
  }

  function expectNotAllowed(res: request.Response) {
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: LOCATION_NOT_ALLOWED_CODE,
      message: LOCATION_NOT_ALLOWED_MESSAGE,
    });
  }

  /** Lo que una llamada podría haber dejado escrito en la cita. */
  async function effectsOn(appointmentId: string) {
    const [deliveries, outbox, links] = await Promise.all([
      raw.postOpInstructionDelivery.count({ where: { appointmentId } }),
      raw.emailOutbox.count({ where: { tenantId: clinic.tenantId } }),
      raw.appointmentConfirmation.findMany({
        where: { appointmentId },
        select: { id: true, revokedAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const appointment = await raw.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      select: { confirmationSentAt: true, updatedAt: true },
    });
    return { deliveries, outbox, links, appointment };
  }

  const ROUTES = {
    'GET post-op-instructions': (token: string, id: string) =>
      api(token).get(`/appointments/${id}/post-op-instructions`),
    'POST post-op-instructions/deliveries': (token: string, id: string) =>
      api(token).post(`/appointments/${id}/post-op-instructions/deliveries`, {
        templateId,
        channel: 'PRINT',
      }),
    'POST confirmation-link': (token: string, id: string) =>
      api(token).post(`/appointments/${id}/confirmation-link`),
    'GET reminders': (token: string, id: string) =>
      api(token).get(`/appointments/${id}/reminders`),
  } as const;
  type Route = keyof typeof ROUTES;
  const OK_STATUS: Record<Route, number> = {
    'GET post-op-instructions': 200,
    'POST post-op-instructions/deliveries': 201,
    'POST confirmation-link': 201,
    'GET reminders': 200,
  };

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp({
      override: (builder) => {
        builder.overrideProvider(MAILER).useValue(mailer);
      },
    });
    clinic = await registerClinic(app, 'sec045-sedes');
    const newLocation = async (name: string) =>
      (
        (await admin().post('/locations', { name }).expect(201)).body as {
          id: string;
        }
      ).id;
    norte = await newLocation('Sede Norte');
    sur = await newLocation('Sede Sur');

    members.admin = { userId: clinic.adminUserId, token: clinic.adminToken };
    members.restricted = await member(
      'recepcion.norte@sec045.test',
      ClinicRole.RECEPTION,
      [norte],
    );
    members.unrestricted = await member(
      'recepcion@sec045.test',
      ClinicRole.RECEPTION,
    );
    restrictedDentist = await member(
      'odontologo.norte@sec045.test',
      ClinicRole.DENTIST,
      [norte],
    );
    unrestrictedDentist = await member(
      'odontologa@sec045.test',
      ClinicRole.DENTIST,
    );

    patientId = (
      (
        await admin()
          .post('/patients', {
            firstName: 'Lucía',
            lastName: 'Restrepo',
            docType: DocType.CC,
            docNumber: 'SEC045-1',
            sex: Sex.F,
            email: PATIENT_EMAIL,
            phone: '+57 310 555 0145',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    templateId = (
      (
        await admin()
          .post('/post-op-templates', {
            code: 'POI-EXO',
            title: 'Exodoncia',
            body: 'Hola {{paciente}}: muerde la gasa 30 minutos.',
          })
          .expect(201)
      ).body as { id: string }
    ).id;

    // Citas futuras (se puede pedir confirmación) en cada sede.
    appt.norte = await seedAppointment(
      norte,
      new Date('2027-03-03T15:00:00.000Z'),
    );
    appt.sur = await seedAppointment(sur, new Date('2027-03-03T16:00:00.000Z'));
    // Citas ya atendidas para ligar una evolución.
    const past = (days: number) =>
      new Date(Date.now() - days * 24 * 3600 * 1000);
    pastAppt.norte = await seedAppointment(norte, past(3), 'COMPLETED');
    pastAppt.sur = await seedAppointment(sur, past(2), 'COMPLETED');

    // Enlaces de confirmación vigentes, que una llamada denegada no revoca.
    for (const site of ['norte', 'sur'] as const) {
      await ROUTES['POST confirmation-link'](
        clinic.adminToken,
        appt[site],
      ).expect(201);
    }
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  describe('miembro acotado a Norte sobre una cita de Sur: 403 sin efectos', () => {
    it('GET post-op-instructions: 403 y no devuelve el móvil del paciente', async () => {
      const res = await ROUTES['GET post-op-instructions'](
        members.restricted.token,
        appt.sur,
      );
      expectNotAllowed(res);
      expect(JSON.stringify(res.body)).not.toContain('5550145');
      const viewed = await raw.auditEvent.count({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'POSTOP_DELIVERY',
          action: 'VIEW',
        },
      });
      expect(viewed).toBe(0);
    });

    it('POST post-op-instructions/deliveries por EMAIL: 403, sin entrega, sin email y sin auditoría', async () => {
      const before = await effectsOn(appt.sur);
      const res = await api(members.restricted.token).post(
        `/appointments/${appt.sur}/post-op-instructions/deliveries`,
        { templateId, channel: 'EMAIL' },
      );
      expectNotAllowed(res);
      expect(await effectsOn(appt.sur)).toEqual(before);
      expect(before.deliveries).toBe(0);
      const created = await raw.auditEvent.count({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'POSTOP_DELIVERY',
          action: 'CREATE',
        },
      });
      expect(created).toBe(0);
    });

    it('POST confirmation-link: 403 y el enlace vigente sigue sin revocar', async () => {
      const before = await effectsOn(appt.sur);
      expect(before.links).toHaveLength(1);
      expect(before.links[0].revokedAt).toBeNull();
      const res = await ROUTES['POST confirmation-link'](
        members.restricted.token,
        appt.sur,
      );
      expectNotAllowed(res);
      expect(await effectsOn(appt.sur)).toEqual(before);
    });

    it('GET reminders: 403', async () => {
      expectNotAllowed(
        await ROUTES['GET reminders'](members.restricted.token, appt.sur),
      );
    });
  });

  // Matriz: 4 rutas × (acotado, sin restricción, ADMIN) × (Norte, Sur).
  const MATRIX: Array<[Route, Who, Site, 'ok' | 'forbidden']> = [];
  for (const route of Object.keys(ROUTES) as Route[]) {
    MATRIX.push(
      [route, 'restricted', 'norte', 'ok'],
      [route, 'restricted', 'sur', 'forbidden'],
      [route, 'unrestricted', 'norte', 'ok'],
      [route, 'unrestricted', 'sur', 'ok'],
      [route, 'admin', 'norte', 'ok'],
      [route, 'admin', 'sur', 'ok'],
    );
  }

  describe('matriz', () => {
    it.each(MATRIX)(
      '%s · %s · cita de %s → %s',
      async (route, who, site, outcome) => {
        const res = await ROUTES[route](members[who].token, appt[site]);
        if (outcome === 'forbidden') {
          expectNotAllowed(res);
        } else {
          expect(res.status).toBe(OK_STATUS[route]);
        }
      },
    );

    it('acotado sobre su sede: la entrega por EMAIL se registra y encola el email', async () => {
      const before = await effectsOn(appt.norte);
      const res = await api(members.restricted.token)
        .post(`/appointments/${appt.norte}/post-op-instructions/deliveries`, {
          templateId,
          channel: 'EMAIL',
        })
        .expect(201);
      expect(res.body).toMatchObject({ emailQueued: true });
      const after = await effectsOn(appt.norte);
      expect(after.deliveries).toBe(before.deliveries + 1);
      expect(after.outbox).toBe(before.outbox + 1);
    });

    it('sin restricción sobre Sur: el enlace nuevo revoca el anterior', async () => {
      const before = await effectsOn(appt.sur);
      await ROUTES['POST confirmation-link'](
        members.unrestricted.token,
        appt.sur,
      ).expect(201);
      const after = await effectsOn(appt.sur);
      expect(after.links).toHaveLength(before.links.length + 1);
      expect(after.links.filter((l) => l.revokedAt === null)).toHaveLength(1);
    });
  });

  describe('barrido: evolución ligada a una cita', () => {
    const entry = (token: string, appointmentId: string) =>
      api(token).post(`/patients/${patientId}/clinical-entries`, {
        appointmentId,
        reason: 'Control',
        notes: 'Evolución ligada a la cita',
      });
    const entriesOf = (appointmentId: string) =>
      raw.clinicalEntry.count({ where: { appointmentId } });

    it('odontólogo acotado a Norte con una cita de Sur: 403 y no se escribe', async () => {
      expectNotAllowed(await entry(restrictedDentist.token, pastAppt.sur));
      expect(await entriesOf(pastAppt.sur)).toBe(0);
    });

    it('con una cita de su sede: 201 en Norte', async () => {
      const res = await entry(restrictedDentist.token, pastAppt.norte).expect(
        201,
      );
      const row = await raw.clinicalEntry.findUniqueOrThrow({
        where: { id: (res.body as { id: string }).id },
      });
      expect(row.locationId).toBe(norte);
    });

    it('sin restricción con una cita de Sur: 201 en Sur', async () => {
      const res = await entry(unrestrictedDentist.token, pastAppt.sur).expect(
        201,
      );
      const row = await raw.clinicalEntry.findUniqueOrThrow({
        where: { id: (res.body as { id: string }).id },
      });
      expect(row.locationId).toBe(sur);
    });
  });
});
