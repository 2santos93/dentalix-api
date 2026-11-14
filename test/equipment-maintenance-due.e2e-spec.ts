import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import { addCivilMonths } from '../src/modules/recall/domain/recall-rules';
import { TokenService } from '../src/shared/crypto/token.service';
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

// DX-543 en HTTP real: `GET /equipment/maintenance-due`, los avisos de
// mantenimiento de «Mi día». Solo ADMIN (403 en español al resto), vencidos y
// por vencer (≤30 días) en el día de la sede, lo más urgente primero, la sede
// activa de la cabecera o las permitidas del token, y nunca otra clínica.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SEDE = sedeTodayFixture();
/** El día civil de la sede ahora (la zona se eligió lejos de su medianoche). */
const sedeDay = civilDateIn(new Date(), SEDE.timeZone);

interface DueItem {
  id: string;
  name: string;
  category: string;
  locationId: string;
  locationName: string;
  chairId: string | null;
  chairName: string | null;
  nextMaintenanceOn: string;
  maintenanceStatus: 'OVERDUE' | 'DUE_SOON';
  daysUntilDue: number;
}

interface DueBody {
  generatedAt: string;
  items: DueItem[];
  total: number;
}

const DUE = '/api/v1/equipment/maintenance-due';

describe('Avisos de mantenimiento de equipos en «Mi día» (e2e, DX-543)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let norte: string;
  let sur: string;
  let chairNorte: string;
  let otherLocation: string;
  const tokens: Partial<Record<ClinicRole, string>> = {};

  const api = () => request(app.getHttpServer());
  const as = (
    req: request.Test,
    token: string,
    host = clinic.host,
  ): request.Test =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const admin = (req: request.Test) => as(req, clinic.adminToken);

  async function createLocation(c: Clinic, name: string): Promise<string> {
    const res = await as(api().post('/api/v1/locations'), c.adminToken, c.host)
      .send(locationBody(SEDE, { name }))
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function createEquipment(
    c: Clinic,
    body: Record<string, unknown>,
  ): Promise<string> {
    const res = await as(api().post('/api/v1/equipment'), c.adminToken, c.host)
      .send({ category: 'OTHER', ...body })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx543-e2e');
    other = await registerClinic(app, 'dx543-e2e-otra');
    norte = await createLocation(clinic, 'Sede Norte');
    sur = await createLocation(clinic, 'Sede Sur');
    otherLocation = await createLocation(other, 'Sede de B');
    chairNorte = (
      (
        await admin(api().post('/api/v1/chairs'))
          .send({ locationId: norte, name: 'Sillón 1' })
          .expect(201)
      ).body as { id: string }
    ).id;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }

    // Norte: VENCIDO (adquirido hace 8 meses, cada 6), en el Sillón 1.
    await createEquipment(clinic, {
      locationId: norte,
      chairId: chairNorte,
      name: 'Unidad dental',
      category: 'DENTAL_UNIT',
      acquiredOn: addCivilMonths(sedeDay, -8),
      maintenanceIntervalMonths: 6,
    });
    // Sur: vence pronto, por el próximo que fijó su preventivo (+10 días).
    const rx = await createEquipment(clinic, {
      locationId: sur,
      name: 'Rayos X',
      category: 'XRAY',
      acquiredOn: addCivilMonths(sedeDay, -24),
      maintenanceIntervalMonths: 12,
    });
    await admin(api().post(`/api/v1/equipment/${rx}/maintenances`))
      .send({
        kind: 'PREVENTIVE',
        performedOn: addCivilMonths(sedeDay, -1),
        description: 'Revisión del tubo',
        nextDueOn: addCivilDays(sedeDay, 10),
      })
      .expect(201);
    // Norte: vence HOY (sigue siendo «vence pronto», no vencido).
    const compresor = await createEquipment(clinic, {
      locationId: norte,
      name: 'Compresor',
      category: 'COMPRESSOR',
      acquiredOn: addCivilMonths(sedeDay, -12),
      maintenanceIntervalMonths: 6,
    });
    await admin(api().post(`/api/v1/equipment/${compresor}/maintenances`))
      .send({
        kind: 'PREVENTIVE',
        performedOn: addCivilMonths(sedeDay, -1),
        description: 'Purga y cambio de filtro',
        nextDueOn: sedeDay,
      })
      .expect(201);
    // Fuera: al día, sin programar y dado de baja (aunque estuviera vencido).
    await createEquipment(clinic, {
      locationId: norte,
      name: 'Autoclave al día',
      acquiredOn: addCivilMonths(sedeDay, -1),
      maintenanceIntervalMonths: 6,
    });
    await createEquipment(clinic, { locationId: sur, name: 'Lámpara' });
    const retired = await createEquipment(clinic, {
      locationId: sur,
      name: 'Esterilizador viejo',
      acquiredOn: addCivilMonths(sedeDay, -30),
      maintenanceIntervalMonths: 6,
    });
    await admin(api().post(`/api/v1/equipment/${retired}/retire`))
      .send({ reason: 'Reemplazado' })
      .expect(200);

    // B: un vencido suyo.
    await createEquipment(other, {
      locationId: otherLocation,
      name: 'Unidad de B',
      acquiredOn: addCivilMonths(sedeDay, -12),
      maintenanceIntervalMonths: 6,
    });
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('ADMIN, todas las sedes: vencidos y por vencer, lo más urgente primero', async () => {
    const res = await admin(api().get(DUE)).expect(200);
    const body = res.body as DueBody;
    expect(body.total).toBe(3);
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
    expect(body.items).toEqual([
      expect.objectContaining({
        name: 'Unidad dental',
        category: 'DENTAL_UNIT',
        locationId: norte,
        locationName: 'Sede Norte',
        chairId: chairNorte,
        chairName: 'Sillón 1',
        nextMaintenanceOn: addCivilMonths(addCivilMonths(sedeDay, -8), 6),
        maintenanceStatus: 'OVERDUE',
      }),
      expect.objectContaining({
        name: 'Compresor',
        nextMaintenanceOn: sedeDay,
        maintenanceStatus: 'DUE_SOON',
        daysUntilDue: 0,
      }),
      expect.objectContaining({
        name: 'Rayos X',
        locationName: 'Sede Sur',
        chairId: null,
        nextMaintenanceOn: addCivilDays(sedeDay, 10),
        maintenanceStatus: 'DUE_SOON',
        daysUntilDue: 10,
      }),
    ]);
    expect(body.items[0].daysUntilDue).toBeLessThan(0);
  });

  it('coincide con el estado de la lista de DX-542 para cada equipo', async () => {
    const list = (
      await admin(api().get('/api/v1/equipment?pageSize=100')).expect(200)
    ).body as {
      items: {
        id: string;
        maintenanceStatus: string | null;
        nextMaintenanceOn: string | null;
      }[];
    };
    const due = (await admin(api().get(DUE)).expect(200)).body as DueBody;
    const expected = list.items
      .filter(
        (i) =>
          i.maintenanceStatus === 'OVERDUE' ||
          i.maintenanceStatus === 'DUE_SOON',
      )
      .map((i) => i.id)
      .sort();
    expect(due.items.map((i) => i.id).sort()).toEqual(expected);
    for (const item of due.items) {
      const row = list.items.find((i) => i.id === item.id)!;
      expect(item.nextMaintenanceOn).toBe(row.nextMaintenanceOn);
      expect(item.maintenanceStatus).toBe(row.maintenanceStatus);
    }
  });

  it('sigue la sede activa de X-Location-Id', async () => {
    const res = await admin(api().get(DUE).set('X-Location-Id', sur)).expect(
      200,
    );
    expect((res.body as DueBody).items.map((i) => i.name)).toEqual(['Rayos X']);
    const resNorte = await admin(
      api().get(DUE).set('X-Location-Id', norte),
    ).expect(200);
    expect((resNorte.body as DueBody).items.map((i) => i.name)).toEqual([
      'Unidad dental',
      'Compresor',
    ]);
  });

  it('`limit` acota los items (el total no) y se valida en español', async () => {
    const res = await admin(api().get(`${DUE}?limit=1`)).expect(200);
    expect(res.body).toMatchObject({ total: 3 });
    expect((res.body as DueBody).items).toHaveLength(1);
    for (const bad of ['0', '51', 'x']) {
      const r = await admin(api().get(`${DUE}?limit=${bad}`)).expect(400);
      expect(JSON.stringify(r.body)).toContain('El límite no es válido.');
    }
  });

  it('un ADMIN con el token acotado a una sede solo ve esa sede, y 403 si pide otra', async () => {
    const token = (
      await app.get(TokenService).issue({
        sub: clinic.adminUserId,
        tenantId: clinic.tenantId,
        role: ClinicRole.ADMIN,
        loc: [sur],
        tv: 0,
      })
    ).accessToken;
    const res = await as(api().get(DUE), token).expect(200);
    expect((res.body as DueBody).items.map((i) => i.name)).toEqual(['Rayos X']);
    const denied = await as(
      api().get(DUE).set('X-Location-Id', norte),
      token,
    ).expect(403);
    expect(denied.body).toMatchObject({ code: 'LOCATION_NOT_ALLOWED' });
  });

  it.each([ClinicRole.DENTIST, ClinicRole.RECEPTION, ClinicRole.ASSISTANT])(
    '%s recibe 403 en español (equipos: solo ADMIN)',
    async (role) => {
      const res = await as(api().get(DUE), tokens[role]!).expect(403);
      expect((res.body as { message: string }).message).toBe(
        'Solo administración gestiona los equipos biomédicos.',
      );
    },
  );

  it('sin token, 401', async () => {
    await api().get(DUE).set('X-Tenant-Host', clinic.host).expect(401);
  });

  describe('aislamiento entre clínicas', () => {
    it('B solo ve lo suyo, y A nada de B', async () => {
      const resB = await as(
        api().get(DUE),
        other.adminToken,
        other.host,
      ).expect(200);
      expect((resB.body as DueBody).items.map((i) => i.name)).toEqual([
        'Unidad de B',
      ]);
      const resA = (await admin(api().get(DUE)).expect(200)).body as DueBody;
      expect(resA.items.map((i) => i.name)).not.toContain('Unidad de B');
    });

    it('B con una sede de A en la cabecera no recibe nada de A', async () => {
      const res = await as(
        api().get(DUE).set('X-Location-Id', norte),
        other.adminToken,
        other.host,
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).not.toContain('Unidad dental');
    });

    it('el token de A contra el host de B no pasa', async () => {
      const res = await as(api().get(DUE), clinic.adminToken, other.host);
      expect(res.status).toBe(401);
    });
  });
});
