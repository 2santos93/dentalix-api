import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  SEEDED_PASSWORD,
  seedMember,
} from './support/e2e-fixtures';
import { PasswordService } from '../src/shared/crypto/password.service';

// DX-233 en HTTP real: horario de cada profesional por sede (PUT/GET), sus
// excepciones por fecha, el cuadrante, permisos, auditoría y aislamiento; y su
// efecto en la agenda: aviso PROVIDER_OFF_SCHEDULE (o 409 en modo estricto),
// «Buscar hueco» y «Ocupar este hueco» filtrados.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const BOGOTA_MS = 5 * 60 * 60 * 1000;
const H = (h: number) => h * 60;

/** YYYY-MM-DD (Bogotá) del primer lunes a 7 días o más: siempre futuro. */
function nextMonday(): string {
  let t = Date.now() - BOGOTA_MS + 7 * DAY_MS;
  while (new Date(t).getUTCDay() !== 1) t += DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
/** Hora de pared de Bogotá (UTC−5 fijo) como instante ISO. */
function local(day: string, hhmm: string): string {
  return new Date(`${day}T${hhmm}:00-05:00`).toISOString();
}

const MON = nextMonday();
const WED = addDays(MON, 2);
const THU = addDays(MON, 3);
const NEXT_THU = addDays(THU, 7);

interface Member {
  userId: string;
  token: string;
}
interface Body {
  id: string;
  [key: string]: unknown;
}
interface RosterDay {
  date: string;
  unrestricted: boolean;
  worksAtLocation: boolean | null;
  locationRanges: { startMinute: number; endMinute: number }[] | null;
  assignments: {
    locationId: string;
    source: string;
    ranges: { startMinute: number; endMinute: number }[];
  }[];
}
interface Roster {
  providers: { providerId: string; configured: boolean; days: RosterDay[] }[];
}

describe('Horario de los profesionales por sede (e2e, DX-233)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let draX: Member;
  let reception: Member;
  let assistant: Member;
  let sedeA: string;
  let sedeB: string;
  let otherLocationId: string;
  const patients: string[] = [];

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  async function member(role: ClinicRole, c = clinic): Promise<Member> {
    const m = await seedMember(raw, c, role);
    return { userId: m.userId, token: await loginAs(app, c.host, m.email) };
  }

  async function firstLocation(c: Clinic): Promise<string> {
    const res = await as(
      api().get('/api/v1/locations'),
      c.adminToken,
      c.host,
    ).expect(200);
    return (res.body as Body[])[0].id;
  }

  const ROTATION = () => ({
    locations: [
      {
        locationId: sedeA,
        ranges: [
          { weekday: 1, startMinute: H(8), endMinute: H(13) },
          { weekday: 3, startMinute: H(8), endMinute: H(13) },
        ],
      },
      {
        locationId: sedeB,
        ranges: [{ weekday: 4, startMinute: H(14), endMinute: H(19) }],
      },
    ],
  });

  const putSchedule = (body: unknown, token = clinic.adminToken) =>
    as(api().put(`/api/v1/providers/${draX.userId}/schedule`), token).send(
      body as object,
    );

  const auditEvents = (reason: string) =>
    raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        resourceType: 'PROVIDER_SCHEDULE',
        metadata: { path: ['reason'], equals: reason },
      },
      orderBy: { occurredAt: 'asc' },
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx233-e2e');
    other = await registerClinic(app, 'dx233-e2e-otra');
    draX = await member(ClinicRole.DENTIST);
    reception = await member(ClinicRole.RECEPTION);
    assistant = await member(ClinicRole.ASSISTANT);
    sedeA = await firstLocation(clinic);
    const created = await as(api().post('/api/v1/locations'), clinic.adminToken)
      .send({ name: 'Sede B', country: 'CO' })
      .expect(201);
    sedeB = (created.body as Body).id;
    otherLocationId = await firstLocation(other);
    for (const [doc, firstName] of [
      ['233001', 'Ana'],
      ['233002', 'Berta'],
    ]) {
      const p = await as(api().post('/api/v1/patients'), clinic.adminToken)
        .send({
          firstName,
          lastName: 'Horario',
          docType: 'CC',
          docNumber: doc,
          sex: 'F',
        })
        .expect(201);
      patients.push((p.body as Body).id);
    }
    // Las dos sedes abiertas de lunes a viernes de 7:00 a 20:00 (Bogotá).
    for (const loc of [sedeA, sedeB]) {
      await as(api().put('/api/v1/locations/schedule'), clinic.adminToken)
        .set('X-Location-Id', loc)
        .send({
          timezone: 'America/Bogota',
          ranges: [1, 2, 3, 4, 5].map((weekday) => ({
            weekday,
            startMinute: H(7),
            endMinute: H(20),
          })),
        })
        .expect(200);
    }
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('horario semanal', () => {
    it('sin horario: configured false y sin sedes', async () => {
      const res = await as(
        api().get(`/api/v1/providers/${draX.userId}/schedule`),
        reception.token,
      ).expect(200);
      expect(res.body).toEqual({
        providerId: draX.userId,
        configured: false,
        locations: [],
      });
    });

    it('solo ADMIN escribe (403 en español); el resto lee', async () => {
      for (const token of [reception.token, assistant.token, draX.token]) {
        const res = await putSchedule(ROTATION(), token).expect(403);
        expect((res.body as { message: string }).message).toBe(
          'Solo un administrador puede cambiar los horarios de los profesionales.',
        );
      }
    });

    it('rechaza (400, español) un tramo que solapa el mismo día en dos sedes', async () => {
      const body = ROTATION();
      body.locations[1].ranges.push({
        weekday: 1,
        startMinute: H(12),
        endMinute: H(15),
      });
      const res = await putSchedule(body).expect(400);
      expect((res.body as { message: string }).message).toBe(
        'El tramo 08:00–13:00 en Sede principal se solapa el lunes con 12:00–15:00 en Sede B: un profesional no puede estar en dos sedes a la vez.',
      );
    });

    it('validación estricta: múltiplos de 5, ≤ 7 tramos, sede de otra clínica', async () => {
      await putSchedule({
        locations: [
          {
            locationId: sedeA,
            ranges: [{ weekday: 1, startMinute: 482, endMinute: 600 }],
          },
        ],
      }).expect(400);
      await putSchedule({
        locations: [
          {
            locationId: sedeA,
            ranges: Array.from({ length: 8 }, (_, i) => ({
              weekday: 2,
              startMinute: H(8 + i),
              endMinute: H(8 + i) + 30,
            })),
          },
        ],
      }).expect(400);
      const foreign = await putSchedule({
        locations: [
          {
            locationId: otherLocationId,
            ranges: [{ weekday: 1, startMinute: H(8), endMinute: H(9) }],
          },
        ],
      }).expect(400);
      expect((foreign.body as { message: string }).message).toBe(
        'Sede no encontrada',
      );
      await as(
        api().put(`/api/v1/providers/${reception.userId}/schedule`),
        clinic.adminToken,
      )
        .send(ROTATION())
        .expect(400);
    });

    it('un ADMIN define la rotación de la Dra. X y queda auditada', async () => {
      const res = await putSchedule(ROTATION()).expect(200);
      expect(res.body).toMatchObject({
        providerId: draX.userId,
        configured: true,
      });
      const got = await as(
        api().get(`/api/v1/providers/${draX.userId}/schedule`),
        assistant.token,
      ).expect(200);
      expect(got.body).toEqual(res.body);
      const [event] = await auditEvents('PROVIDER_SCHEDULE_REPLACED');
      expect(event).toMatchObject({
        action: 'UPDATE',
        resourceId: draX.userId,
        actorUserId: clinic.adminUserId,
      });
      expect(event.metadata).toMatchObject({
        scheduleChange: { before: [] },
      });
      expect(
        (event.metadata as { scheduleChange: { after: unknown[] } })
          .scheduleChange.after,
      ).toHaveLength(3);
    });

    it('otra clínica no ve ni toca a la Dra. X (404)', async () => {
      await as(
        api().get(`/api/v1/providers/${draX.userId}/schedule`),
        other.adminToken,
        other.host,
      ).expect(404);
      await as(
        api().put(`/api/v1/providers/${draX.userId}/schedule`),
        other.adminToken,
        other.host,
      )
        .send({ locations: [] })
        .expect(404);
    });
  });

  describe('cuadrante y excepciones', () => {
    it('el cuadrante semanal muestra lunes y miércoles en A y jueves en B', async () => {
      const res = await as(
        api().get(`/api/v1/schedule/roster?weekStart=${MON}`),
        reception.token,
      ).expect(200);
      const x = (res.body as Roster).providers.find(
        (p) => p.providerId === draX.userId,
      )!;
      expect(x.configured).toBe(true);
      const byDate = Object.fromEntries(x.days.map((d) => [d.date, d]));
      expect(byDate[MON].assignments).toEqual([
        {
          locationId: sedeA,
          source: 'WEEKLY',
          overrideId: null,
          ranges: [{ startMinute: H(8), endMinute: H(13) }],
        },
      ]);
      expect(byDate[WED].assignments[0].locationId).toBe(sedeA);
      expect(byDate[THU].assignments).toEqual([
        {
          locationId: sedeB,
          source: 'WEEKLY',
          overrideId: null,
          ranges: [{ startMinute: H(14), endMinute: H(19) }],
        },
      ]);
      expect(byDate[addDays(MON, 1)].assignments).toEqual([]);
    });

    it('con locationId dice si trabaja allí y sus tramos (para sombrear la agenda)', async () => {
      const res = await as(
        api().get(
          `/api/v1/schedule/roster?weekStart=${THU}&days=1&locationId=${sedeB}`,
        ),
        draX.token,
      ).expect(200);
      const roster = res.body as Roster;
      const x = roster.providers.find((p) => p.providerId === draX.userId)!;
      expect(x.days).toHaveLength(1);
      expect(x.days[0]).toMatchObject({
        worksAtLocation: true,
        locationRanges: [{ startMinute: H(14), endMinute: H(19) }],
      });
      // El dueño (ADMIN, atiende) no tiene horario: sin restricción.
      const owner = roster.providers.find(
        (p) => p.providerId === clinic.adminUserId,
      )!;
      expect(owner.days[0]).toMatchObject({
        unrestricted: true,
        worksAtLocation: true,
        locationRanges: null,
      });
    });

    it('excepción «no trabaja», luego otro horario, y quitarla; todo auditado', async () => {
      const off = await as(
        api().post(`/api/v1/providers/${draX.userId}/schedule-overrides`),
        clinic.adminToken,
      )
        .send({ locationId: sedeB, date: THU, ranges: [] })
        .expect(201);
      expect(off.body).toMatchObject({
        date: THU,
        off: true,
        replaced: false,
        locationName: 'Sede B',
      });
      const changed = await as(
        api().post(`/api/v1/providers/${draX.userId}/schedule-overrides`),
        clinic.adminToken,
      )
        .send({
          locationId: sedeB,
          date: THU,
          ranges: [{ startMinute: H(9), endMinute: H(12) }],
          note: 'Cambio de turno',
        })
        .expect(201);
      expect(changed.body).toMatchObject({ off: false, replaced: true });

      const list = await as(
        api().get(`/api/v1/providers/${draX.userId}/schedule-overrides`),
        reception.token,
      ).expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({
          id: (changed.body as Body).id,
          date: THU,
          ranges: [{ startMinute: H(9), endMinute: H(12) }],
          note: 'Cambio de turno',
        }),
      ]);

      await as(
        api().delete(
          `/api/v1/providers/${draX.userId}/schedule-overrides/${(changed.body as Body).id}`,
        ),
        clinic.adminToken,
      ).expect(204);
      await as(
        api().delete(
          `/api/v1/providers/${draX.userId}/schedule-overrides/${(changed.body as Body).id}`,
        ),
        clinic.adminToken,
      ).expect(404);

      const set = await auditEvents('PROVIDER_SCHEDULE_OVERRIDE_SET');
      expect(set.map((e) => e.action)).toEqual(['CREATE', 'UPDATE']);
      expect(set[1].metadata).toMatchObject({
        scheduleChange: {
          before: [{ locationId: sedeB, date: THU, off: true }],
          after: [
            {
              locationId: sedeB,
              date: THU,
              startMinute: H(9),
              endMinute: H(12),
            },
          ],
        },
      });
      const deleted = await auditEvents('PROVIDER_SCHEDULE_OVERRIDE_DELETED');
      expect(deleted).toHaveLength(1);
      expect(deleted[0].action).toBe('DELETE');
    });

    it('excepción: 400 si pisa otra sede ese día, si es pasada; 403 a recepción', async () => {
      const clash = await as(
        api().post(`/api/v1/providers/${draX.userId}/schedule-overrides`),
        clinic.adminToken,
      )
        .send({
          locationId: sedeB,
          date: MON,
          ranges: [{ startMinute: H(12), endMinute: H(14) }],
        })
        .expect(400);
      expect((clash.body as { message: string }).message).toMatch(
        /dos sedes a la vez/,
      );
      await as(
        api().post(`/api/v1/providers/${draX.userId}/schedule-overrides`),
        clinic.adminToken,
      )
        .send({ locationId: sedeB, date: '2020-01-02', ranges: [] })
        .expect(400);
      await as(
        api().post(`/api/v1/providers/${draX.userId}/schedule-overrides`),
        reception.token,
      )
        .send({ locationId: sedeB, date: NEXT_THU, ranges: [] })
        .expect(403);
    });
  });

  describe('modo estricto de la clínica', () => {
    it('por defecto apagado; solo ADMIN lo cambia y queda auditado', async () => {
      const res = await as(
        api().get('/api/v1/schedule/settings'),
        reception.token,
      ).expect(200);
      expect(res.body).toEqual({ strictProviderSchedule: false });
      await as(api().put('/api/v1/schedule/settings'), reception.token)
        .send({ strictProviderSchedule: true })
        .expect(403);
      await as(api().put('/api/v1/schedule/settings'), clinic.adminToken)
        .send({ strictProviderSchedule: true })
        .expect(200, { strictProviderSchedule: true });
      await as(api().put('/api/v1/schedule/settings'), clinic.adminToken)
        .send({ strictProviderSchedule: false })
        .expect(200, { strictProviderSchedule: false });
      const events = await auditEvents('PROVIDER_SCHEDULE_SETTINGS');
      expect(events.map((e) => e.metadata)).toEqual([
        expect.objectContaining({
          statusChange: { from: 'WARN', to: 'STRICT' },
        }),
        expect.objectContaining({
          statusChange: { from: 'STRICT', to: 'WARN' },
        }),
      ]);
    });
  });

  describe('efecto en la agenda', () => {
    type Opening = { start: string; end: string };
    const openings = async (
      providerId: string,
      locationId: string,
      from: string,
      to: string,
    ) => {
      const res = await as(
        api().get(
          `/api/v1/appointments/openings?providerId=${providerId}&locationId=${locationId}&from=${from}&to=${to}&durationMinutes=30`,
        ),
        reception.token,
      ).expect(200);
      return (res.body as { openings: Opening[] }).openings;
    };
    const book = (
      locationId: string,
      day: string,
      hhmm: string,
      minutes = 30,
      patient = 0,
    ) => {
      const start = local(day, hhmm);
      return as(api().post('/api/v1/appointments'), reception.token)
        .set('X-Location-Id', locationId)
        .send({
          patientId: patients[patient],
          providerId: draX.userId,
          start,
          end: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
        });
    };
    let thursdayAppointment: string;

    it('«Buscar hueco» en la sede B: solo los jueves 14:00–19:00, menos sus citas', async () => {
      const created = await book(sedeB, THU, '15:00').expect(201);
      thursdayAppointment = (created.body as Body).id;
      expect(created.body).toMatchObject({ warnings: [], warningCodes: [] });
      expect(await openings(draX.userId, sedeB, MON, addDays(MON, 6))).toEqual([
        { start: local(THU, '14:00'), end: local(THU, '15:00') },
        { start: local(THU, '15:30'), end: local(THU, '19:00') },
      ]);
      // En la sede A, lunes y miércoles de 8 a 13.
      expect(await openings(draX.userId, sedeA, MON, addDays(MON, 6))).toEqual([
        { start: local(MON, '08:00'), end: local(MON, '13:00') },
        { start: local(WED, '08:00'), end: local(WED, '13:00') },
      ]);
    });

    it('con «no trabaja» el jueves no devuelve nada; con otro horario, el de la excepción', async () => {
      const off = await as(
        api().post(`/api/v1/providers/${draX.userId}/schedule-overrides`),
        clinic.adminToken,
      )
        .send({ locationId: sedeB, date: NEXT_THU, ranges: [] })
        .expect(201);
      expect(await openings(draX.userId, sedeB, NEXT_THU, NEXT_THU)).toEqual(
        [],
      );
      await as(
        api().post(`/api/v1/providers/${draX.userId}/schedule-overrides`),
        clinic.adminToken,
      )
        .send({
          locationId: sedeB,
          date: NEXT_THU,
          ranges: [{ startMinute: H(9), endMinute: H(12) }],
        })
        .expect(201);
      expect(await openings(draX.userId, sedeB, NEXT_THU, NEXT_THU)).toEqual([
        { start: local(NEXT_THU, '09:00'), end: local(NEXT_THU, '12:00') },
      ]);
      expect((off.body as Body).id).toBeDefined();
    });

    it('un profesional sin horario se comporta como hoy (horario de la sede)', async () => {
      expect(await openings(clinic.adminUserId, sedeA, MON, MON)).toEqual([
        { start: local(MON, '07:00'), end: local(MON, '20:00') },
      ]);
    });

    it('crear fuera de horario: aviso PROVIDER_OFF_SCHEDULE; modo estricto: 409 en español', async () => {
      const res = await book(sedeA, THU, '09:00', 30, 1).expect(201);
      expect(res.body).toMatchObject({
        warningCodes: ['PROVIDER_OFF_SCHEDULE'],
        warnings: [
          expect.stringMatching(
            /^Fuera del horario del profesional: no trabaja en Sede principal el jueves \d{2}\/\d{2}\.$/,
          ),
        ],
      });

      await as(api().put('/api/v1/schedule/settings'), clinic.adminToken)
        .send({ strictProviderSchedule: true })
        .expect(200);
      const strict = await book(sedeA, THU, '11:00', 30, 1).expect(409);
      expect((strict.body as { message: string }).message).toMatch(
        /no trabaja en Sede principal.*La clínica no permite citar fuera del horario del profesional\./,
      );
      // Dentro de su horario se sigue pudiendo, también en modo estricto.
      await book(sedeA, MON, '09:00', 30, 1).expect(201);
      await as(api().put('/api/v1/schedule/settings'), clinic.adminToken)
        .send({ strictProviderSchedule: false })
        .expect(200);
    });

    it('mover una cita fuera de horario también avisa', async () => {
      const res = await as(
        api().patch(`/api/v1/appointments/${thursdayAppointment}`),
        reception.token,
      )
        .send({ start: local(THU, '19:00'), end: local(THU, '19:30') })
        .expect(200);
      expect(res.body).toMatchObject({
        warningCodes: ['PROVIDER_OFF_SCHEDULE'],
        warnings: [
          expect.stringMatching(
            /^Fuera del horario del profesional en Sede B \(jueves \d{2}\/\d{2}: 14:00–19:00\)\.$/,
          ),
        ],
      });
    });

    it('«Ocupar este hueco»: fuera del horario de su profesional no hay candidatos', async () => {
      const res = await as(
        api()
          .get(`/api/v1/appointments/openings/${sedeA}/candidates`)
          .query({
            start: local(THU, '09:00'),
            end: local(THU, '09:30'),
            providerId: draX.userId,
          }),
        reception.token,
      ).expect(200);
      expect(res.body).toMatchObject({ providerOffSchedule: true, items: [] });
      const inside = await as(
        api()
          .get(`/api/v1/appointments/openings/${sedeB}/candidates`)
          .query({
            start: local(THU, '16:00'),
            end: local(THU, '16:30'),
            providerId: draX.userId,
          }),
        reception.token,
      ).expect(200);
      expect(inside.body).toMatchObject({ providerOffSchedule: false });
    });
  });

  // DX-089: miembros acotados a una o varias sedes.
  describe('sedes permitidas (DX-089)', () => {
    let draY: Member;
    let receptionB: Member;
    const NOT_ALLOWED =
      /^.+ no atiende en Sede B: solo se le puede poner horario en las sedes que tiene permitidas en Personal\.$/;

    /**
     * Miembro acotado a `locationIds` (email propio: `seedMember` da uno por
     * rol); el login ya lleva el claim `loc`.
     */
    async function restricted(
      email: string,
      role: ClinicRole,
      locationIds: string[],
    ): Promise<Member> {
      const user = await raw.user.create({
        data: {
          email,
          passwordHash: await new PasswordService().hash(SEEDED_PASSWORD),
          fullName: `Miembro ${email}`,
          emailVerifiedAt: new Date(),
        },
        select: { id: true },
      });
      await raw.clinicMembership.create({
        data: { tenantId: clinic.tenantId, userId: user.id, role },
      });
      await as(
        api().put(`/api/v1/staff/${user.id}/locations`),
        clinic.adminToken,
      )
        .send({ locationIds })
        .expect(200);
      return {
        userId: user.id,
        token: await loginAs(app, clinic.host, email),
      };
    }

    beforeAll(async () => {
      draY = await restricted('dra-y@dx233-e2e.test', ClinicRole.DENTIST, [
        sedeA,
      ]);
      receptionB = await restricted(
        'recepcion-b@dx233-e2e.test',
        ClinicRole.RECEPTION,
        [sedeB],
      );
    });

    it('a una profesional acotada a A no se le pone horario ni excepciones en B (400, español)', async () => {
      const put = await as(
        api().put(`/api/v1/providers/${draY.userId}/schedule`),
        clinic.adminToken,
      )
        .send({
          locations: [
            {
              locationId: sedeB,
              ranges: [{ weekday: 2, startMinute: H(8), endMinute: H(12) }],
            },
          ],
        })
        .expect(400);
      expect((put.body as { message: string }).message).toMatch(NOT_ALLOWED);

      for (const ranges of [
        [{ startMinute: H(8), endMinute: H(12) }],
        [] as unknown[],
      ]) {
        const post = await as(
          api().post(`/api/v1/providers/${draY.userId}/schedule-overrides`),
          clinic.adminToken,
        )
          .send({ locationId: sedeB, date: NEXT_THU, ranges })
          .expect(400);
        expect((post.body as { message: string }).message).toMatch(NOT_ALLOWED);
      }

      // En su sede, sí.
      await as(
        api().put(`/api/v1/providers/${draY.userId}/schedule`),
        clinic.adminToken,
      )
        .send({
          locations: [
            {
              locationId: sedeA,
              ranges: [{ weekday: 2, startMinute: H(8), endMinute: H(12) }],
            },
          ],
        })
        .expect(200);
    });

    it('el cuadrante de recepción acotada a B: solo B, sin quien no atiende en B y 403 para A', async () => {
      await as(
        api()
          .get('/api/v1/schedule/roster')
          .query({ weekStart: MON, locationId: sedeA }),
        receptionB.token,
      ).expect(403);

      const res = await as(
        api().get('/api/v1/schedule/roster').query({ weekStart: MON }),
        receptionB.token,
      ).expect(200);
      const roster = res.body as Roster & { locations: { id: string }[] };
      expect(roster.locations.map((l) => l.id)).toEqual([sedeB]);
      const ids = roster.providers.map((p) => p.providerId);
      expect(ids).not.toContain(draY.userId);
      expect(ids).toContain(draX.userId);
      // Ninguna asignación de otra sede.
      for (const p of roster.providers) {
        for (const d of p.days) {
          for (const a of d.assignments) expect(a.locationId).toBe(sedeB);
        }
      }

      // Para quien ve todas, la Dra. Y no trabaja en B ningún día.
      const admin = await as(
        api()
          .get('/api/v1/schedule/roster')
          .query({ weekStart: MON, locationId: sedeB }),
        clinic.adminToken,
      ).expect(200);
      const y = (admin.body as Roster).providers.find(
        (p) => p.providerId === draY.userId,
      )!;
      expect(y.days.every((d) => d.worksAtLocation === false)).toBe(true);
    });

    it('el horario que lee recepción acotada a B es solo el de B', async () => {
      const res = await as(
        api().get(`/api/v1/providers/${draX.userId}/schedule`),
        receptionB.token,
      ).expect(200);
      const view = res.body as { locations: { locationId: string }[] };
      expect(view.locations.map((l) => l.locationId)).toEqual([sedeB]);
      const overrides = await as(
        api().get(`/api/v1/providers/${draX.userId}/schedule-overrides`),
        receptionB.token,
      ).expect(200);
      for (const o of overrides.body as { locationId: string }[]) {
        expect(o.locationId).toBe(sedeB);
      }
    });
  });
});
