import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { hashPublicLinkToken } from '../src/shared/public-links/public-link-token';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { locationBody } from './support/location-fixtures';
import { sedeTodayFixture } from './support/sede-clock';

// DX-588 en HTTP real: la pantalla de sala de espera. ADMIN la crea (el token
// sale UNA vez; en la BD, su hash), la ajusta y la revoca (auditado). El
// tablero público por token: lista blanca campo a campo (falla con cualquier
// clave de más), nombre «Ana R.» o «Turno N» (sin nombres), llega → en espera,
// sillón → pasando a consulta con sillón y profesional, completada → fuera.
// Aislamiento: solo la sede de la pantalla; otro host o un token inventado o
// revocado dan el MISMO 404. La clínica B ataca con los ids de A
// (`tenant-id-inputs.ts` cita este spec).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const MIN = 60_000;
const DAY_MS = 24 * 60 * MIN;
const INACTIVE = {
  statusCode: 404,
  error: 'Not Found',
  code: 'WAITING_ROOM_SCREEN_INACTIVE',
  message: 'Esta pantalla ya no está activa.',
};

/** Las ÚNICAS claves que puede llevar el tablero (lista blanca). */
const BOARD_KEYS = [
  'called',
  'calledTotal',
  'hourCycle',
  'locale',
  'locationName',
  'messages',
  'nameMode',
  'now',
  'refreshSeconds',
  'screenName',
  'soundEnabled',
  'timeZone',
  'waiting',
  'waitingTotal',
];
const WAITING_KEYS = ['key', 'label', 'minutesWaiting'];
const CALLED_KEYS = [
  'chairName',
  'key',
  'label',
  'minutesSinceCalled',
  'providerName',
];

interface Member {
  userId: string;
  token: string;
}
interface ScreenBody {
  id: string;
  locationId: string;
  name: string;
  nameMode: string;
  messages: string[];
  soundEnabled: boolean;
  revokedAt: string | null;
  token?: string;
}
interface BoardBody {
  screenName: string;
  locationName: string;
  nameMode: string;
  messages: string[];
  waiting: { key: string; label: string; minutesWaiting: number }[];
  called: {
    key: string;
    label: string;
    chairName: string | null;
    providerName: string | null;
  }[];
  waitingTotal: number;
  calledTotal: number;
}

/**
 * Comprueba la lista blanca de forma recursiva: el tablero y cada fila con
 * EXACTAMENTE sus claves (ni una más).
 */
function expectWhitelisted(body: unknown): void {
  const board = body as Record<string, unknown>;
  expect(Object.keys(board).sort()).toEqual(BOARD_KEYS);
  for (const item of board.waiting as Record<string, unknown>[]) {
    expect(Object.keys(item).sort()).toEqual(WAITING_KEYS);
  }
  for (const item of board.called as Record<string, unknown>[]) {
    expect(Object.keys(item).sort()).toEqual(CALLED_KEYS);
  }
}

describe('Pantalla de sala de espera (e2e, DX-588)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let dentist: Member;
  let reception: Member;
  let chacao: string;
  let altamira: string;
  let otherLocation: string;
  let chairId: string;
  let patientN = 0;

  const api = () => request(app.getHttpServer());
  const as = (
    req: request.Test,
    token: string,
    locationId?: string,
    host = clinic.host,
  ) => {
    const r = req
      .set('X-Tenant-Host', host)
      .set('Authorization', `Bearer ${token}`);
    return locationId ? r.set('X-Location-Id', locationId) : r;
  };
  const board = (token: string, host = clinic.host) =>
    api()
      .get(`/api/v1/public/waiting-room/${token}`)
      .set('X-Tenant-Host', host);

  async function createScreen(
    body: Record<string, unknown>,
    c: Clinic = clinic,
  ): Promise<ScreenBody> {
    const res = await as(
      api().post('/api/v1/waiting-room-screens'),
      c.adminToken,
      undefined,
      c.host,
    )
      .send(body)
      .expect(201);
    return res.body as ScreenBody;
  }

  async function patient(firstName: string, lastName: string) {
    const res = await as(api().post('/api/v1/patients'), clinic.adminToken)
      .send({
        firstName,
        lastName,
        docType: 'NATIONAL_ID',
        docNumber: `588${String(++patientN).padStart(4, '0')}`,
        sex: 'F',
        phone: '+584121234567',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /**
   * Una cita de HOY en la sede, ya empezada: se agenda por la API lejos (en
   * 3 días) y se trae a «hace 30 min» con `raw` (DX-449: la zona de la sede
   * es una a ≥ 3 h de su medianoche, así que es hoy allí corra a la hora que
   * corra; la llegada solo vale el día de la cita).
   */
  async function bookToday(
    firstName: string,
    lastName: string,
    locationId: string,
    withChair = false,
  ): Promise<string> {
    const patientId = await patient(firstName, lastName);
    const offset = patientN * 15 * MIN;
    const later = new Date(Date.now() + 3 * DAY_MS + offset);
    const res = await as(
      api().post('/api/v1/appointments'),
      reception.token,
      locationId,
    )
      .send({
        patientId,
        providerId: dentist.userId,
        start: later.toISOString(),
        end: new Date(later.getTime() + 10 * MIN).toISOString(),
        reason: 'Endodoncia molar 36',
        ...(withChair ? { chairId } : {}),
      })
      .expect(201);
    const id = (res.body as { id: string }).id;
    const start = new Date(Date.now() - 20 * MIN - patientN * 11 * MIN);
    await raw.appointment.update({
      where: { id },
      data: { start, end: new Date(start.getTime() + 10 * MIN) },
    });
    return id;
  }

  const setStatus = (id: string, status: string, token: string) =>
    as(api().patch(`/api/v1/appointments/${id}`), token)
      .send({ status })
      .expect(200);

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx588-e2e');
    other = await registerClinic(app, 'dx588-e2e-otra');
    dentist = await (async () => {
      const m = await seedMember(raw, clinic, ClinicRole.DENTIST);
      return {
        userId: m.userId,
        token: await loginAs(app, clinic.host, m.email),
      };
    })();
    reception = await (async () => {
      const m = await seedMember(raw, clinic, ClinicRole.RECEPTION);
      return {
        userId: m.userId,
        token: await loginAs(app, clinic.host, m.email),
      };
    })();
    const fixture = sedeTodayFixture();
    const createLocation = async (name: string) =>
      (
        (
          await as(api().post('/api/v1/locations'), clinic.adminToken)
            .send(locationBody(fixture, { name }))
            .expect(201)
        ).body as { id: string }
      ).id;
    chacao = await createLocation('Sede Chacao');
    altamira = await createLocation('Sede Altamira');
    for (const locationId of [chacao, altamira]) {
      await as(
        api().put('/api/v1/locations/schedule'),
        clinic.adminToken,
        locationId,
      )
        .send({
          ranges: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
            weekday,
            startMinute: 0,
            endMinute: 1440,
          })),
        })
        .expect(200);
    }
    chairId = (
      (
        await as(api().post('/api/v1/chairs'), clinic.adminToken)
          .send({ locationId: chacao, name: 'Sillón 2' })
          .expect(201)
      ).body as { id: string }
    ).id;
    otherLocation = (
      (
        await as(
          api().get('/api/v1/locations'),
          other.adminToken,
          undefined,
          other.host,
        ).expect(200)
      ).body as { id: string }[]
    )[0].id;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('ADMIN crea la pantalla: el token sale una vez, en la BD solo su hash, y queda auditada', async () => {
    const screen = await createScreen({
      locationId: chacao,
      name: '  Televisor   de la sala ',
      messages: ['Horario: lunes a viernes de 8:00 a 17:00', '   '],
    });
    expect(screen).toMatchObject({
      locationId: chacao,
      name: 'Televisor de la sala',
      nameMode: 'NAME_INITIAL',
      messages: ['Horario: lunes a viernes de 8:00 a 17:00'],
      soundEnabled: false,
      revokedAt: null,
    });
    expect(screen.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await raw.waitingRoomScreen.findUniqueOrThrow({
      where: { id: screen.id },
    });
    expect(row.tokenHash).toBe(hashPublicLinkToken(screen.token!));
    expect(JSON.stringify(row)).not.toContain(screen.token);

    // El listado no vuelve a dar el token.
    const list = await as(
      api().get('/api/v1/waiting-room-screens'),
      clinic.adminToken,
    ).expect(200);
    const listed = (list.body as ScreenBody[]).find((s) => s.id === screen.id);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty('token');
    expect(listed).not.toHaveProperty('tokenHash');

    const events = await raw.auditEvent.findMany({
      where: { resourceType: 'WAITING_ROOM_SCREEN', resourceId: screen.id },
    });
    expect(events.map((e) => e.action)).toEqual(['CREATE']);
    expect(JSON.stringify(events)).not.toContain(screen.token);
  });

  it('solo ADMIN: recepción y el odontólogo reciben 403 en español', async () => {
    for (const member of [reception, dentist]) {
      const res = await as(
        api().post('/api/v1/waiting-room-screens'),
        member.token,
      )
        .send({ locationId: chacao, name: 'TV' })
        .expect(403);
      expect((res.body as { message: string }).message).toBe(
        'Solo administración gestiona las pantallas de sala de espera.',
      );
      await as(api().get('/api/v1/waiting-room-screens'), member.token).expect(
        403,
      );
    }
  });

  it('valida nombre y mensajes con 400 en español', async () => {
    const empty = await as(
      api().post('/api/v1/waiting-room-screens'),
      clinic.adminToken,
    )
      .send({ locationId: chacao, name: '   ' })
      .expect(400);
    expect((empty.body as { message: string }).message).toBe(
      'Escribe un nombre para la pantalla.',
    );
    await as(api().post('/api/v1/waiting-room-screens'), clinic.adminToken)
      .send({
        locationId: chacao,
        name: 'TV',
        messages: ['1', '2', '3', '4', '5', '6'],
      })
      .expect(400);
    await as(api().post('/api/v1/waiting-room-screens'), clinic.adminToken)
      .send({ locationId: chacao, name: 'TV', messages: ['x'.repeat(141)] })
      .expect(400);
  });

  it('llega → en espera; sillón → pasando a consulta con sillón y profesional; completada → fuera; lista blanca exacta', async () => {
    const screen = await createScreen({ locationId: chacao, name: 'Sala' });
    const ana = await bookToday('Ana María', 'Rodríguez Pérez', chacao, true);
    const jose = await bookToday('José', 'Pérez', chacao);
    // Otra sede de la misma clínica: no sale en esta pantalla.
    const lejos = await bookToday('Luisa', 'Altamira', altamira);

    let res = await board(screen.token!).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expectWhitelisted(res.body);
    expect((res.body as BoardBody).waiting).toEqual([]);

    await setStatus(ana, 'ARRIVED', reception.token);
    await setStatus(jose, 'ARRIVED', reception.token);
    await setStatus(lejos, 'ARRIVED', reception.token);
    res = await board(screen.token!).expect(200);
    expectWhitelisted(res.body);
    let body = res.body as BoardBody;
    expect(body.locationName).toBe('Sede Chacao');
    // Por orden de llegada; «Ana R.»: primer nombre e inicial del apellido.
    expect(body.waiting.map((w) => w.label)).toEqual(['Ana R.', 'José P.']);
    expect(body.waitingTotal).toBe(2);
    expect(body.called).toEqual([]);
    const text = JSON.stringify(res.body);
    for (const leak of [
      'Endodoncia',
      '584121234567',
      '5880001',
      'Rodríguez',
      'Luisa',
      ana,
      jose,
    ]) {
      expect(text).not.toContain(leak);
    }

    const anaKey = body.waiting[0].key;
    await setStatus(ana, 'IN_CHAIR', dentist.token);
    res = await board(screen.token!).expect(200);
    expectWhitelisted(res.body);
    body = res.body as BoardBody;
    expect(body.waiting.map((w) => w.label)).toEqual(['José P.']);
    expect(body.called).toHaveLength(1);
    expect(body.called[0]).toMatchObject({
      key: anaKey,
      label: 'Ana R.',
      chairName: 'Sillón 2',
    });
    expect(typeof body.called[0].providerName).toBe('string');

    await setStatus(ana, 'READY_FOR_CHECKOUT', dentist.token);
    await setStatus(ana, 'COMPLETED', reception.token);
    res = await board(screen.token!).expect(200);
    body = res.body as BoardBody;
    expect(body.called).toEqual([]);
    expect(body.waiting.map((w) => w.label)).toEqual(['José P.']);
  });

  it('«Número de turno»: ningún nombre; el turno es el del panel «En clínica» y no cambia al deshacer otra llegada', async () => {
    const screen = await createScreen({
      locationId: altamira,
      name: 'Sala Altamira',
      nameMode: 'TURN_NUMBER',
    });
    const first = await bookToday('Carmen', 'Blanco', altamira);
    const second = await bookToday('Pedro', 'Silva', altamira);
    await setStatus(first, 'ARRIVED', reception.token);
    await setStatus(second, 'ARRIVED', reception.token);

    const turns = async () => {
      const panel = await as(
        api().get('/api/v1/appointments/in-clinic'),
        reception.token,
        altamira,
      ).expect(200);
      return new Map(
        (
          panel.body as {
            waiting: { appointmentId: string; turnNumber: number | null }[];
          }
        ).waiting.map((w) => [w.appointmentId, w.turnNumber]),
      );
    };
    const before = await turns();
    const secondTurn = before.get(second)!;
    expect(secondTurn).toBe(before.get(first)! + 1);

    let res = await board(screen.token!).expect(200);
    expectWhitelisted(res.body);
    let text = JSON.stringify(res.body);
    for (const name of ['Carmen', 'Pedro', 'Blanco', 'Silva', 'Luisa']) {
      expect(text).not.toContain(name);
    }
    expect((res.body as BoardBody).waiting.map((w) => w.label)).toContain(
      `Turno ${secondTurn}`,
    );

    // Deshacer la llegada del primero no renumera al segundo.
    await as(
      api().post(`/api/v1/appointments/${first}/undo-arrival`),
      reception.token,
    ).expect((r) => expect([200, 201]).toContain(r.status));
    const after = await turns();
    expect(after.get(second)).toBe(secondTurn);
    expect(after.has(first)).toBe(false);
    const undone = await raw.appointment.findUniqueOrThrow({
      where: { id: first },
    });
    expect(undone.turnNumber).toBeNull();
    // Vuelve a llegar: número nuevo (no reutiliza).
    await setStatus(first, 'ARRIVED', reception.token);
    expect((await turns()).get(first)).toBeGreaterThan(secondTurn);

    res = await board(screen.token!).expect(200);
    text = JSON.stringify(res.body);
    expect(text).not.toContain('Carmen');
  });

  it('aislamiento: otro host, un token inventado o mal formado dan el MISMO 404; otra clínica no ve nada', async () => {
    const screen = await createScreen({ locationId: chacao, name: 'Aislada' });
    // El token de A con el host de B (RLS): como uno inventado.
    const foreign = await board(screen.token!, other.host).expect(404);
    expect(foreign.body).toEqual(INACTIVE);
    expect((await board('A'.repeat(43)).expect(404)).body as unknown).toEqual(
      INACTIVE,
    );
    expect((await board('corto').expect(404)).body as unknown).toEqual(
      INACTIVE,
    );
    expect(
      (await board(screen.token!, 'desconocida.dentalix.test').expect(404))
        .body as unknown,
    ).toEqual(INACTIVE);

    // B con los ids de A: la sede de A no existe para B; la pantalla tampoco.
    await as(
      api().post('/api/v1/waiting-room-screens'),
      other.adminToken,
      undefined,
      other.host,
    )
      .send({ locationId: chacao, name: 'Robada' })
      .expect((r) => expect([403, 404]).toContain(r.status));
    await as(
      api().get(`/api/v1/waiting-room-screens?locationId=${chacao}`),
      other.adminToken,
      undefined,
      other.host,
    ).expect((r) => {
      expect([200, 403, 404]).toContain(r.status);
      if (r.status === 200) expect(r.body).toEqual([]);
    });
    // ISOLATION_COVERS: PATCH /waiting-room-screens/:id
    await as(
      api().patch(`/api/v1/waiting-room-screens/${screen.id}`),
      other.adminToken,
      undefined,
      other.host,
    )
      .send({ name: 'Hackeada' })
      .expect(404);
    // ISOLATION_COVERS: POST /waiting-room-screens/:id/revoke
    await as(
      api().post(`/api/v1/waiting-room-screens/${screen.id}/revoke`),
      other.adminToken,
      undefined,
      other.host,
    ).expect(404);
    const row = await raw.waitingRoomScreen.findUniqueOrThrow({
      where: { id: screen.id },
    });
    expect(row).toMatchObject({ name: 'Aislada', revokedAt: null });
    // La pantalla de B en su sede sigue sin ver nada de A.
    const mine = await createScreen(
      { locationId: otherLocation, name: 'De B' },
      other,
    );
    const bBoard = await board(mine.token!, other.host).expect(200);
    expect((bBoard.body as BoardBody).waiting).toEqual([]);
    expect((bBoard.body as BoardBody).called).toEqual([]);
  });

  it('ajustar y revocar: el televisor ve «Esta pantalla ya no está activa» en la petición siguiente; auditado', async () => {
    const screen = await createScreen({
      locationId: chacao,
      name: 'Recepción',
    });
    const patched = await as(
      api().patch(`/api/v1/waiting-room-screens/${screen.id}`),
      clinic.adminToken,
    )
      .send({
        name: 'Sala principal',
        nameMode: 'TURN_NUMBER',
        messages: ['Recuerde llegar 10 minutos antes'],
        soundEnabled: true,
      })
      .expect(200);
    expect(patched.body).toMatchObject({
      name: 'Sala principal',
      nameMode: 'TURN_NUMBER',
      messages: ['Recuerde llegar 10 minutos antes'],
      soundEnabled: true,
    });
    const live = await board(screen.token!).expect(200);
    expect(live.body).toMatchObject({
      screenName: 'Sala principal',
      nameMode: 'TURN_NUMBER',
      messages: ['Recuerde llegar 10 minutos antes'],
      soundEnabled: true,
    });

    const revoked = await as(
      api().post(`/api/v1/waiting-room-screens/${screen.id}/revoke`),
      clinic.adminToken,
    ).expect(200);
    expect((revoked.body as ScreenBody).revokedAt).not.toBeNull();
    expect((await board(screen.token!).expect(404)).body as unknown).toEqual(
      INACTIVE,
    );
    // Idempotente; una revocada no se edita.
    await as(
      api().post(`/api/v1/waiting-room-screens/${screen.id}/revoke`),
      clinic.adminToken,
    ).expect(200);
    await as(
      api().patch(`/api/v1/waiting-room-screens/${screen.id}`),
      clinic.adminToken,
    )
      .send({ name: 'Otra vez' })
      .expect(409);

    const events = await raw.auditEvent.findMany({
      where: { resourceType: 'WAITING_ROOM_SCREEN', resourceId: screen.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual([
      'CREATE',
      'UPDATE',
      'UPDATE',
      'UPDATE',
    ]);
    expect(
      events.some(
        (e) =>
          (e.metadata as { reason?: string } | null)?.reason ===
          'WAITING_ROOM_SCREEN_REVOKED',
      ),
    ).toBe(true);
  });
});
