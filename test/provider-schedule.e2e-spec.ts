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
  seedMember,
} from './support/e2e-fixtures';

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
});
