import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { CHAIR_ID_INVALID_MESSAGE } from '../src/modules/chairs/domain/chair-rules';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  locationBody,
  type RegionalFixture,
} from './support/location-fixtures';
import {
  addCivilDays,
  civilDateIn,
  civilWeekday,
  zonedWallTime,
} from '../src/shared/time/civil-day';

// DX-492 y DX-509-ter en HTTP real, contra Postgres (la EXCLUDE del sillón):
// «Buscar hueco» con sillón, el sillón de «Atender sin cita», el de «En
// clínica» y «Agendar aquí» desde pendientes. Lo que la clínica B intenta con
// los sillones de A está en `chairs.e2e-spec.ts`.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const CARACAS: RegionalFixture = {
  country: 'VE',
  currency: 'USD',
  timeZone: 'America/Caracas',
  locale: 'es-VE',
  hourCycle: 'h23',
  defaultPhoneRegion: 'VE',
};

function nextTuesday(): string {
  let day = addCivilDays(civilDateIn(new Date(), CARACAS.timeZone), 7);
  while (civilWeekday(day) !== 2) day = addCivilDays(day, 1);
  return day;
}
const DAY = nextTuesday();
const local = (hhmm: string): string => {
  const [h, m] = hhmm.split(':').map(Number);
  return zonedWallTime(DAY, h * 60 + m, CARACAS.timeZone).toISOString();
};

interface ChairBody {
  id: string;
  name: string;
}
interface OpeningBody {
  start: string;
  end: string;
  chair?: ChairBody;
}
interface AppointmentBody {
  id: string;
  start: string;
  end: string;
  chairId: string | null;
  chair: ChairBody | null;
}
interface Member {
  userId: string;
  token: string;
}

describe('Sillones en «Buscar hueco», «Atender sin cita» y «En clínica» (e2e, DX-492, DX-509-ter)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let norte: string;
  let sur: string;
  let one: ChairBody;
  let two: ChairBody;
  let surChair: ChairBody;
  let off: ChairBody;
  let dentist: Member;
  let dentist2: Member;
  let reception: Member;
  const patients: string[] = [];

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token = reception.token): request.Test =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);

  async function member(role: ClinicRole): Promise<Member> {
    const seeded = await seedMember(raw, clinic, role);
    return {
      userId: seeded.userId,
      token: await loginAs(app, clinic.host, seeded.email),
    };
  }

  async function createChair(name: string, locationId: string) {
    const res = await as(api().post('/api/v1/chairs'), clinic.adminToken)
      .send({ name, locationId })
      .expect(201);
    return res.body as ChairBody;
  }

  function openings(query: Record<string, string | string[]>) {
    return as(
      api()
        .get('/api/v1/appointments/openings')
        .query({
          providerId: dentist.userId,
          locationId: norte,
          from: DAY,
          to: DAY,
          durationMinutes: 30,
          ...query,
        }),
    );
  }

  async function book(body: Record<string, unknown>): Promise<AppointmentBody> {
    const res = await as(api().post('/api/v1/appointments'))
      .set('X-Location-Id', norte)
      .send({
        patientId: patients[0],
        providerId: dentist.userId,
        ...body,
      })
      .expect(201);
    return res.body as AppointmentBody;
  }

  function walkIn(body: Record<string, unknown>, location = norte) {
    return as(api().post('/api/v1/appointments/walk-in'))
      .set('X-Location-Id', location)
      .send({
        providerId: dentist.userId,
        overbookReason: 'Dolor agudo sin hueco',
        ...body,
      });
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx492-e2e');
    for (const [name, assign] of [
      ['Sede Norte', (id: string) => (norte = id)],
      ['Sede Sur', (id: string) => (sur = id)],
    ] as const) {
      const res = await as(api().post('/api/v1/locations'), clinic.adminToken)
        .send(locationBody(CARACAS, { name }))
        .expect(201);
      assign((res.body as { id: string }).id);
    }
    // Martes de 09:00 a 13:00 en las dos sedes.
    for (const location of [norte, sur]) {
      await as(api().put('/api/v1/locations/schedule'), clinic.adminToken)
        .set('X-Location-Id', location)
        .send({
          ranges: [{ weekday: 2, startMinute: 540, endMinute: 780 }],
        })
        .expect(200);
    }
    dentist = await member(ClinicRole.DENTIST);
    reception = await member(ClinicRole.RECEPTION);
    dentist2 = await member(ClinicRole.ADMIN);
    one = await createChair('Sillón 1', norte);
    two = await createChair('Sillón 2', norte);
    surChair = await createChair('Sillón Sur', sur);
    off = await createChair('Sillón viejo', norte);
    await as(
      api().post(`/api/v1/chairs/${off.id}/deactivate`),
      clinic.adminToken,
    ).expect(200);
    await as(api().post('/api/v1/appointment-types'), clinic.adminToken)
      .send({
        name: 'Consulta de urgencia',
        durationMinutes: 30,
        color: '#DC2626',
        isUrgent: true,
      })
      .expect(201);
    for (const doc of ['492001', '492002', '492003', '492004', '492005']) {
      const res = await as(api().post('/api/v1/patients'), clinic.adminToken)
        .send({
          firstName: 'Ana',
          lastName: `Paciente ${doc}`,
          docType: 'NATIONAL_ID',
          docNumber: doc,
          sex: 'F',
        })
        .expect(201);
      patients.push((res.body as { id: string }).id);
    }
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('«Buscar hueco» con sillón', () => {
    let moving: AppointmentBody;

    beforeAll(async () => {
      // El profesional consultado está libre; el sillón lo ocupa otra persona.
      await book({
        patientId: patients[1],
        providerId: dentist2.userId,
        chairId: one.id,
        start: local('10:00'),
        end: local('10:30'),
      });
      moving = await book({
        chairId: one.id,
        start: local('11:00'),
        end: local('11:30'),
      });
    });

    it('sin sillón, como siempre: la cita de otro profesional no cuenta y los huecos no llevan sillón', async () => {
      const res = await openings({}).expect(200);
      const body = res.body as { openings: OpeningBody[] };
      expect(body.openings).toEqual([
        { start: local('09:00'), end: local('11:00') },
        { start: local('11:30'), end: local('13:00') },
      ]);
    });

    it('con un sillón (un solo parámetro) filtra los huecos en los que también está libre', async () => {
      const res = await openings({ chairIds: one.id }).expect(200);
      const body = res.body as { openings: OpeningBody[] };
      expect(body.openings.map((o) => [o.start, o.end])).toEqual([
        [local('09:00'), local('10:00')],
        [local('10:30'), local('11:00')],
        [local('11:30'), local('13:00')],
      ]);
      expect(body.openings.every((o) => o.chair?.id === one.id)).toBe(true);
    });

    it('con varios, cada hueco dice qué sillón está libre', async () => {
      const res = await openings({ chairIds: [one.id, two.id] }).expect(200);
      const body = res.body as { openings: OpeningBody[] };
      expect(body.openings.map((o) => [o.start, o.end, o.chair?.name])).toEqual(
        [
          [local('09:00'), local('11:00'), 'Sillón 2'],
          [local('11:30'), local('13:00'), 'Sillón 1'],
        ],
      );
    });

    it('DX-509-ter: profesional libre y sillón ocupado: ninguna sugerencia choca; la hora ocupada da 409', async () => {
      const res = await openings({
        chairIds: one.id,
        excludeAppointmentId: moving.id,
      }).expect(200);
      const suggestions = (res.body as { openings: OpeningBody[] }).openings;
      // La cita que se mueve no ocupa: el hueco de después llega hasta el cierre.
      expect(suggestions.map((o) => [o.start, o.end])).toEqual([
        [local('09:00'), local('10:00')],
        [local('10:30'), local('13:00')],
      ]);
      const patch = (start: string, end: string) =>
        as(api().patch(`/api/v1/appointments/${moving.id}`)).send({
          start,
          end,
        });
      const clash = await patch(local('10:00'), local('10:30')).expect(409);
      expect((clash.body as { message: string }).message).toContain('Sillón 1');
      for (const opening of [...suggestions].reverse()) {
        const end = new Date(
          new Date(opening.start).getTime() + 30 * 60_000,
        ).toISOString();
        await patch(opening.start, end).expect(200);
      }
    });

    it('un sillón de otra sede o desactivado da 400 en español', async () => {
      const other = await openings({ chairIds: surChair.id }).expect(400);
      expect((other.body as { message: string }).message).toContain(
        'es de otra sede',
      );
      const inactive = await openings({ chairIds: off.id }).expect(400);
      expect((inactive.body as { message: string }).message).toContain(
        'desactivado',
      );
    });

    it('un miembro acotado a Norte no busca en Sur (403)', async () => {
      const limited = await member(ClinicRole.ASSISTANT);
      await as(
        api().put(`/api/v1/staff/${limited.userId}/locations`),
        clinic.adminToken,
      )
        .send({ locationIds: [norte] })
        .expect(200);
      const token = await loginAs(
        app,
        clinic.host,
        `assistant@${clinic.subdomain}.test`,
      );
      await as(
        api().get('/api/v1/appointments/openings').query({
          providerId: dentist.userId,
          locationId: sur,
          from: DAY,
          to: DAY,
          durationMinutes: 30,
          chairIds: surChair.id,
        }),
        token,
      ).expect(403);
    });

    it('«Agendar aquí» guarda el sillón del hueco', async () => {
      const entry = (
        await as(api().post('/api/v1/waitlist'))
          .set('X-Location-Id', norte)
          .send({ patientId: patients[2], durationMinutes: 30 })
          .expect(201)
      ).body as { id: string };
      const res = await openings({
        chairIds: two.id,
        patientId: patients[2],
      }).expect(200);
      const [opening] = (res.body as { openings: OpeningBody[] }).openings;
      const created = await as(
        api().post(`/api/v1/waitlist/${entry.id}/schedule`),
      )
        .send({
          providerId: dentist.userId,
          start: opening.start,
          chairId: opening.chair?.id,
        })
        .expect(201);
      expect(created.body as AppointmentBody).toMatchObject({
        chairId: two.id,
        chair: { name: 'Sillón 2' },
      });
    });
  });

  describe('«Atender sin cita» y «En clínica»', () => {
    let attended: AppointmentBody;

    it('con sillón libre de la sede: la cita lo lleva y «En clínica» lo muestra', async () => {
      attended = (
        await walkIn({ patientId: patients[3], chairId: one.id }).expect(201)
      ).body as AppointmentBody;
      expect(attended).toMatchObject({
        chairId: one.id,
        chair: { name: 'Sillón 1' },
      });
      const view = await as(api().get('/api/v1/appointments/in-clinic'))
        .set('X-Location-Id', norte)
        .expect(200);
      const { waiting } = view.body as {
        waiting: {
          appointmentId: string;
          chairId: string | null;
          chair: ChairBody | null;
        }[];
      };
      expect(
        waiting.find((i) => i.appointmentId === attended.id),
      ).toMatchObject({ chairId: one.id, chair: { name: 'Sillón 1' } });
    });

    it('si choca (también con un sobrecupo), 409 con el nombre del sillón y sin paciente ni cita nuevos', async () => {
      const before = await raw.appointment.count({
        where: { tenantId: clinic.tenantId },
      });
      const res = await walkIn({
        newPatient: {
          firstName: 'Luis',
          lastName: 'Sin Cita',
          phone: '+58 412 555 0101',
        },
        providerId: dentist2.userId,
        chairId: one.id,
      }).expect(409);
      expect((res.body as { message: string }).message).toContain('«Sillón 1»');
      expect(
        await raw.appointment.count({ where: { tenantId: clinic.tenantId } }),
      ).toBe(before);
      expect(
        await raw.patient.count({
          where: { tenantId: clinic.tenantId, lastName: 'Sin Cita' },
        }),
      ).toBe(0);
    });

    it('un sillón de otra sede o desactivado da 400', async () => {
      await walkIn({ patientId: patients[4], chairId: surChair.id }).expect(
        400,
      );
      await walkIn({ patientId: patients[4], chairId: off.id }).expect(400);
    });

    it('`chairId: null` es un dato inválido, no un 500', async () => {
      // DX-492-bis: con el mismo mensaje en español que al agendar.
      const invalid = { message: [CHAIR_ID_INVALID_MESSAGE] };
      const keyed = await walkIn({ patientId: patients[0], chairId: null })
        .set('Idempotency-Key', randomUUID())
        .expect(400);
      expect(keyed.body).toMatchObject(invalid);
      await walkIn({ patientId: patients[0], chairId: null }).expect(400);
      const entry = (
        await as(api().post('/api/v1/waitlist'))
          .set('X-Location-Id', norte)
          .send({ patientId: patients[0], durationMinutes: 30 })
          .expect(201)
      ).body as { id: string };
      await as(api().post(`/api/v1/waitlist/${entry.id}/schedule`))
        .send({
          providerId: dentist.userId,
          start: new Date(Date.now() + 86_400_000).toISOString(),
          chairId: null,
        })
        .expect(400)
        .expect((res) => expect(res.body).toMatchObject(invalid));
    });

    it('sin sillón sigue funcionando', async () => {
      const res = await walkIn({ patientId: patients[4] }, norte).expect(201);
      expect((res.body as AppointmentBody).chairId).toBeNull();
    });

    it('«Mover a…» le cambia el sillón con el paciente ya en la clínica', async () => {
      const res = await as(api().patch(`/api/v1/appointments/${attended.id}`))
        .send({ chairId: two.id })
        .expect(200);
      expect(res.body as AppointmentBody).toMatchObject({ chairId: two.id });
    });
  });
});
