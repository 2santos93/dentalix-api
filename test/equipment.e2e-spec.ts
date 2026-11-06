import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import { addCivilMonths } from '../src/modules/recall/domain/recall-rules';
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
import { TokenService } from '../src/shared/crypto/token.service';

// DX-542 en HTTP real: equipos biomédicos por sede con su hoja de vida.
// Solo ADMIN (403 en español al resto), sillón de la MISMA sede (400/404),
// mantenimientos que programan el próximo por la periodicidad, vencidos y
// próximos en la lista, baja y anulación con motivo (409 la segunda vez),
// auditoría, y la clínica B atacando con los ids de A (`tenant-id-inputs.ts`
// y la matriz de aislamiento citan este spec).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SEDE = sedeTodayFixture();
/** El día civil de la sede ahora (la zona se eligió lejos de su medianoche). */
const sedeDay = civilDateIn(new Date(), SEDE.timeZone);

interface EquipmentBody {
  id: string;
  locationId: string;
  locationName: string;
  chairId: string | null;
  chairName: string | null;
  name: string;
  status: 'ACTIVE' | 'RETIRED';
  retiredOn: string | null;
  retiredReason: string | null;
  maintenanceIntervalMonths: number | null;
  lastMaintenanceOn: string | null;
  nextMaintenanceOn: string | null;
  maintenanceStatus: string | null;
}

interface MaintenanceBody {
  id: string;
  kind: string;
  performedOn: string;
  nextDueOn: string | null;
  cost: number | null;
  currency: string | null;
  createdById: string;
  createdByName: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

interface DetailBody extends EquipmentBody {
  maintenances: MaintenanceBody[];
}

interface ListBody {
  items: EquipmentBody[];
  total: number;
  page: number;
  pageSize: number;
}

describe('Equipos biomédicos por sede y hoja de vida (e2e, DX-542)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let norte: string;
  let sur: string;
  let chairNorte: string;
  let chairSur: string;
  let otherChair: string;
  let otherLocation: string;
  let dentistToken: string;
  let receptionToken: string;
  let autoclave: EquipmentBody;
  let compresor: EquipmentBody;
  let preventive: MaintenanceBody;

  const api = () => request(app.getHttpServer());
  const as = (
    req: request.Test,
    token: string,
    host = clinic.host,
  ): request.Test =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const admin = (req: request.Test) => as(req, clinic.adminToken);
  const intruder = (req: request.Test) => as(req, other.adminToken, other.host);

  async function createLocation(c: Clinic, name: string): Promise<string> {
    const res = await as(api().post('/api/v1/locations'), c.adminToken, c.host)
      .send(locationBody(SEDE, { name }))
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function createChair(
    c: Clinic,
    locationId: string,
    name: string,
  ): Promise<string> {
    const res = await as(api().post('/api/v1/chairs'), c.adminToken, c.host)
      .send({ locationId, name })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /** Lo que B no puede cambiar: la fila de A y su hoja de vida. */
  async function snapshotOfA() {
    return {
      equipment: await raw.equipment.findMany({
        where: { tenantId: clinic.tenantId },
        orderBy: { id: 'asc' },
      }),
      maintenances: await raw.equipmentMaintenance.findMany({
        where: { tenantId: clinic.tenantId },
        orderBy: { id: 'asc' },
      }),
    };
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx542-e2e');
    other = await registerClinic(app, 'dx542-e2e-otra');
    norte = await createLocation(clinic, 'Sede Norte');
    sur = await createLocation(clinic, 'Sede Sur');
    otherLocation = await createLocation(other, 'Sede de B');
    chairNorte = await createChair(clinic, norte, 'Sillón 1');
    chairSur = await createChair(clinic, sur, 'Sillón Sur');
    otherChair = await createChair(other, otherLocation, 'Sillón de B');
    const dentist = await seedMember(raw, clinic, ClinicRole.DENTIST);
    dentistToken = await loginAs(app, clinic.host, dentist.email);
    const reception = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    receptionToken = await loginAs(app, clinic.host, reception.email);
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  describe('alta, edición y baja (solo ADMIN)', () => {
    it('ADMIN crea un equipo en su sede con un sillón de esa sede', async () => {
      const acquiredOn = addCivilMonths(sedeDay, -14);
      const res = await admin(api().post('/api/v1/equipment'))
        .send({
          locationId: norte,
          chairId: chairNorte,
          name: 'Autoclave clase B',
          category: 'AUTOCLAVE',
          brand: 'Tuttnauer',
          model: '2540EKA',
          serialNumber: 'SN-0001',
          sanitaryRegistration: 'REG-123',
          riskClass: 'IIB',
          acquiredOn,
          maintenanceIntervalMonths: 6,
          notes: 'Sala de esterilización',
        })
        .expect(201);
      autoclave = res.body as EquipmentBody;
      expect(autoclave).toMatchObject({
        locationId: norte,
        locationName: 'Sede Norte',
        chairName: 'Sillón 1',
        status: 'ACTIVE',
        // Sin preventivos: la adquisición + 6 meses, hace ya 8 meses.
        nextMaintenanceOn: addCivilMonths(acquiredOn, 6),
        maintenanceStatus: 'OVERDUE',
      });
      compresor = (
        await admin(api().post('/api/v1/equipment'))
          .send({ locationId: sur, name: 'Compresor', category: 'COMPRESSOR' })
          .expect(201)
      ).body as EquipmentBody;
      expect(compresor.maintenanceStatus).toBe('UNSCHEDULED');
    });

    it('el sillón de otra sede da 400 y uno de otra clínica 404, sin crear nada', async () => {
      const before = await raw.equipment.count();
      const otherSede = await admin(api().post('/api/v1/equipment'))
        .send({
          locationId: norte,
          chairId: chairSur,
          name: 'X',
          category: 'OTHER',
        })
        .expect(400);
      expect((otherSede.body as { message: string }).message).toBe(
        'El sillón no es de la sede del equipo.',
      );
      const foreign = await admin(api().post('/api/v1/equipment'))
        .send({
          locationId: norte,
          chairId: otherChair,
          name: 'X',
          category: 'OTHER',
        })
        .expect(404);
      expect((foreign.body as { message: string }).message).toBe(
        'Sillón no encontrado',
      );
      const invalid = await admin(api().post('/api/v1/equipment'))
        .send({
          locationId: norte,
          name: ' ',
          category: 'OTHER',
          maintenanceIntervalMonths: 200,
        })
        .expect(400);
      expect(
        JSON.stringify((invalid.body as { message: string }).message),
      ).toContain('La periodicidad del mantenimiento va de 1 a 120 meses.');
      expect(await raw.equipment.count()).toBe(before);
    });

    it('edita y traslada a otra sede: el sillón se quita salvo que venga uno de la nueva', async () => {
      const moved = await admin(
        api().patch(`/api/v1/equipment/${compresor.id}`),
      )
        .send({
          locationId: norte,
          chairId: chairNorte,
          brand: 'Schulz',
          maintenanceIntervalMonths: 3,
        })
        .expect(200);
      expect(moved.body).toMatchObject({
        locationId: norte,
        chairName: 'Sillón 1',
        maintenanceIntervalMonths: 3,
      });
      const back = await admin(api().patch(`/api/v1/equipment/${compresor.id}`))
        .send({ locationId: sur })
        .expect(200);
      expect(back.body).toMatchObject({ locationId: sur, chairId: null });
      await admin(api().patch(`/api/v1/equipment/${compresor.id}`))
        .send({ chairId: chairNorte })
        .expect(400);
    });

    it('PATCH con null en un campo obligatorio (sede, nombre, tipo) da 400 en español, no 500, y no cambia nada', async () => {
      const before = await raw.equipment.findUniqueOrThrow({
        where: { id: autoclave.id },
      });
      for (const body of [
        { locationId: null },
        { name: null },
        { category: null },
      ]) {
        const res = await admin(
          api().patch(`/api/v1/equipment/${autoclave.id}`),
        )
          .send(body)
          .expect(400);
        expect(
          JSON.stringify((res.body as { message: unknown }).message),
        ).toMatch(/sede|nombre|tipo/i);
      }
      await expect(
        raw.equipment.findUniqueOrThrow({ where: { id: autoclave.id } }),
      ).resolves.toEqual(before);
    });

    it('un ADMIN con el token acotado a otra sede recibe 403 LOCATION_NOT_ALLOWED en el equipo de la Sede Norte', async () => {
      const token = (
        await app.get(TokenService).issue({
          sub: clinic.adminUserId,
          tenantId: clinic.tenantId,
          role: ClinicRole.ADMIN,
          loc: [sur],
          tv: 0,
        })
      ).accessToken;
      const before = await snapshotOfA();
      const attacks = [
        as(api().get(`/api/v1/equipment/${autoclave.id}`), token),
        as(api().patch(`/api/v1/equipment/${autoclave.id}`), token).send({
          name: 'Otro',
        }),
        as(api().post(`/api/v1/equipment/${autoclave.id}/retire`), token).send({
          reason: 'No es su sede',
        }),
        as(
          api().post(`/api/v1/equipment/${autoclave.id}/maintenances`),
          token,
        ).send({
          kind: 'CORRECTIVE',
          performedOn: sedeDay,
          description: 'No es su sede',
        }),
      ];
      for (const attack of attacks) {
        const res = await attack.expect(403);
        expect(res.body).toMatchObject({ code: 'LOCATION_NOT_ALLOWED' });
      }
      // Su lista es la de su sede, sin la Norte.
      const list = (await as(api().get('/api/v1/equipment'), token).expect(200))
        .body as ListBody;
      expect(list.items.every((i) => i.locationId === sur)).toBe(true);
      expect(await snapshotOfA()).toEqual(before);
    });

    it('un rol no ADMIN recibe 403 en español al leer y al escribir', async () => {
      for (const token of [dentistToken, receptionToken]) {
        const write = await as(api().post('/api/v1/equipment'), token)
          .send({ locationId: norte, name: 'X', category: 'OTHER' })
          .expect(403);
        expect((write.body as { message: string }).message).toBe(
          'Solo administración gestiona los equipos biomédicos.',
        );
        await as(api().get('/api/v1/equipment'), token).expect(403);
        await as(api().get(`/api/v1/equipment/${autoclave.id}`), token).expect(
          403,
        );
        await as(api().post(`/api/v1/equipment/${autoclave.id}/retire`), token)
          .send({ reason: 'No autorizado' })
          .expect(403);
        await as(
          api().post(`/api/v1/equipment/${autoclave.id}/maintenances`),
          token,
        )
          .send({ kind: 'CORRECTIVE', performedOn: sedeDay, description: 'x' })
          .expect(403);
      }
    });
  });

  describe('mantenimientos y hoja de vida', () => {
    it('un preventivo programa el próximo por la periodicidad y pasa a «al día»', async () => {
      const performedOn = addCivilDays(sedeDay, -2);
      const res = await admin(
        api().post(`/api/v1/equipment/${autoclave.id}/maintenances`),
      )
        .send({
          kind: 'PREVENTIVE',
          performedOn,
          technician: 'Luis Pérez',
          company: 'Servitec',
          description: 'Limpieza de cámara, prueba de vacío y Bowie-Dick',
          cost: 85.5,
          currency: 'usd',
        })
        .expect(201);
      preventive = res.body as MaintenanceBody;
      expect(preventive).toMatchObject({
        kind: 'PREVENTIVE',
        performedOn,
        nextDueOn: addCivilMonths(performedOn, 6),
        cost: 85.5,
        currency: 'USD',
        createdById: clinic.adminUserId,
        createdByName: 'Dr. Owner',
      });
      await admin(api().post(`/api/v1/equipment/${autoclave.id}/maintenances`))
        .send({
          kind: 'CORRECTIVE',
          performedOn: addCivilMonths(sedeDay, -3),
          description: 'Cambio del empaque de la puerta',
        })
        .expect(201);
      const detail = (
        await admin(api().get(`/api/v1/equipment/${autoclave.id}`)).expect(200)
      ).body as DetailBody;
      expect(detail).toMatchObject({
        nextMaintenanceOn: addCivilMonths(performedOn, 6),
        maintenanceStatus: 'UP_TO_DATE',
        lastMaintenanceOn: performedOn,
      });
      // Orden cronológico: el correctivo de hace 3 meses va primero.
      expect(detail.maintenances.map((m) => m.kind)).toEqual([
        'CORRECTIVE',
        'PREVENTIVE',
      ]);
    });

    it('valida la fecha, el costo con su moneda y la moneda conocida', async () => {
      const beforeAcquired = await admin(
        api().post(`/api/v1/equipment/${autoclave.id}/maintenances`),
      )
        .send({
          kind: 'CORRECTIVE',
          performedOn: addCivilMonths(sedeDay, -15),
          description: 'x',
        })
        .expect(400);
      expect((beforeAcquired.body as { message: string }).message).toBe(
        'La fecha del mantenimiento no puede ser anterior a la adquisición del equipo.',
      );
      const tooFar = await admin(
        api().post(`/api/v1/equipment/${autoclave.id}/maintenances`),
      )
        .send({
          kind: 'PREVENTIVE',
          performedOn: sedeDay,
          description: 'x',
          nextDueOn: addCivilDays(addCivilMonths(sedeDay, 120), 1),
        })
        .expect(400);
      expect((tooFar.body as { message: string }).message).toBe(
        'El próximo mantenimiento no puede ser a más de 10 años de este.',
      );
      const future = await admin(
        api().post(`/api/v1/equipment/${autoclave.id}/maintenances`),
      )
        .send({
          kind: 'CORRECTIVE',
          performedOn: addCivilDays(sedeDay, 1),
          description: 'x',
        })
        .expect(400);
      expect((future.body as { message: string }).message).toBe(
        'La fecha del mantenimiento no puede ser futura.',
      );
      const noCurrency = await admin(
        api().post(`/api/v1/equipment/${autoclave.id}/maintenances`),
      )
        .send({
          kind: 'CORRECTIVE',
          performedOn: sedeDay,
          description: 'x',
          cost: 10,
        })
        .expect(400);
      expect((noCurrency.body as { message: string }).message).toBe(
        'Indica la moneda del costo.',
      );
      const unknown = await admin(
        api().post(`/api/v1/equipment/${autoclave.id}/maintenances`),
      )
        .send({
          kind: 'CORRECTIVE',
          performedOn: sedeDay,
          description: 'x',
          cost: 10,
          currency: 'ZZZ',
        })
        .expect(400);
      expect((unknown.body as { message: string }).message).toBe(
        'Moneda no soportada.',
      );
    });

    it('la lista marca vencidos y próximos (≤30 días) en el día de la sede, filtra y pagina', async () => {
      // Adquirido hace 20 días, cada mes: vence en 8 a 11 días, «próximo».
      await admin(api().patch(`/api/v1/equipment/${compresor.id}`))
        .send({
          acquiredOn: addCivilDays(sedeDay, -20),
          maintenanceIntervalMonths: 1,
        })
        .expect(200);
      const lampara = (
        await admin(api().post('/api/v1/equipment'))
          .send({
            locationId: norte,
            name: 'Lámpara de fotocurado',
            category: 'CURING_LIGHT',
            acquiredOn: addCivilMonths(sedeDay, -13),
            maintenanceIntervalMonths: 12,
          })
          .expect(201)
      ).body as EquipmentBody;
      const all = (await admin(api().get('/api/v1/equipment')).expect(200))
        .body as ListBody;
      expect(all).toMatchObject({ total: 3, page: 1, pageSize: 50 });
      const byName = Object.fromEntries(
        all.items.map((i) => [i.name, i.maintenanceStatus]),
      );
      expect(byName).toEqual({
        'Autoclave clase B': 'UP_TO_DATE',
        Compresor: 'DUE_SOON',
        'Lámpara de fotocurado': 'OVERDUE',
      });
      const norteOnly = (
        await admin(api().get(`/api/v1/equipment?locationId=${norte}`)).expect(
          200,
        )
      ).body as ListBody;
      expect(norteOnly.items.map((i) => i.id).sort()).toEqual(
        [autoclave.id, lampara.id].sort(),
      );
      const header = (
        await admin(api().get('/api/v1/equipment'))
          .set('X-Location-Id', sur)
          .expect(200)
      ).body as ListBody;
      expect(header.items.map((i) => i.id)).toEqual([compresor.id]);
      const search = (
        await admin(api().get('/api/v1/equipment?query=sn-0001')).expect(200)
      ).body as ListBody;
      expect(search.items.map((i) => i.id)).toEqual([autoclave.id]);
      const page = (
        await admin(api().get('/api/v1/equipment?page=2&pageSize=2')).expect(
          200,
        )
      ).body as ListBody;
      expect(page.items.map((i) => i.name)).toEqual(['Lámpara de fotocurado']);
    });

    it('anular con motivo deja el registro marcado, devuelve el próximo anterior y la segunda vez da 409', async () => {
      const voided = await admin(
        api().post(
          `/api/v1/equipment/${autoclave.id}/maintenances/${preventive.id}/void`,
        ),
      )
        .send({ reason: 'Se registró en el equipo equivocado' })
        .expect(200);
      expect(voided.body).toMatchObject({
        voidReason: 'Se registró en el equipo equivocado',
      });
      const detail = (
        await admin(api().get(`/api/v1/equipment/${autoclave.id}`)).expect(200)
      ).body as DetailBody;
      expect(detail.maintenances).toHaveLength(2);
      expect(detail.maintenanceStatus).toBe('OVERDUE');
      await admin(
        api().post(
          `/api/v1/equipment/${autoclave.id}/maintenances/${preventive.id}/void`,
        ),
      )
        .send({ reason: 'Otra vez' })
        .expect(409);
      // El mantenimiento no se borra: no hay DELETE.
      await admin(
        api().delete(
          `/api/v1/equipment/${autoclave.id}/maintenances/${preventive.id}`,
        ),
      ).expect(404);
    });

    it('dar de baja con motivo una vez; después no se edita ni se le registran mantenimientos', async () => {
      const retired = await admin(
        api().post(`/api/v1/equipment/${compresor.id}/retire`),
      )
        .send({ reason: 'Reemplazado por uno libre de aceite' })
        .expect(200);
      expect(retired.body).toMatchObject({
        status: 'RETIRED',
        retiredOn: sedeDay,
        retiredReason: 'Reemplazado por uno libre de aceite',
        maintenanceStatus: null,
      });
      await admin(api().post(`/api/v1/equipment/${compresor.id}/retire`))
        .send({ reason: 'Otra vez' })
        .expect(409);
      await admin(api().patch(`/api/v1/equipment/${compresor.id}`))
        .send({ name: 'Nuevo' })
        .expect(409);
      await admin(api().post(`/api/v1/equipment/${compresor.id}/maintenances`))
        .send({ kind: 'CORRECTIVE', performedOn: sedeDay, description: 'x' })
        .expect(409);
      const active = (await admin(api().get('/api/v1/equipment')).expect(200))
        .body as ListBody;
      expect(active.items.map((i) => i.id)).not.toContain(compresor.id);
      const retiredList = (
        await admin(api().get('/api/v1/equipment?status=RETIRED')).expect(200)
      ).body as ListBody;
      expect(retiredList.items.map((i) => i.id)).toEqual([compresor.id]);
    });

    it('cada escritura queda en la auditoría como EQUIPMENT o EQUIPMENT_MAINTENANCE', async () => {
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          resourceType: { in: ['EQUIPMENT', 'EQUIPMENT_MAINTENANCE'] },
        },
        select: { action: true, resourceType: true, resourceId: true },
      });
      expect(events).toEqual(
        expect.arrayContaining([
          {
            action: 'CREATE',
            resourceType: 'EQUIPMENT',
            resourceId: autoclave.id,
          },
          {
            action: 'UPDATE',
            resourceType: 'EQUIPMENT',
            resourceId: compresor.id,
          },
          {
            action: 'CREATE',
            resourceType: 'EQUIPMENT_MAINTENANCE',
            resourceId: preventive.id,
          },
          {
            action: 'VOID',
            resourceType: 'EQUIPMENT_MAINTENANCE',
            resourceId: preventive.id,
          },
        ]),
      );
    });
  });

  describe('aislamiento entre clínicas (B ataca con los ids de A)', () => {
    it('B no ve los equipos de A en su lista ni filtra por la sede de A', async () => {
      const list = (await intruder(api().get('/api/v1/equipment')).expect(200))
        .body as ListBody;
      expect(list.items).toEqual([]);
      const bySede = await intruder(
        api().get(`/api/v1/equipment?locationId=${norte}`),
      ).expect(404);
      expect((bySede.body as { message: string }).message).toBe(
        'Sede no encontrada',
      );
    });

    it('B no crea ni mueve equipos a la sede o al sillón de A', async () => {
      const before = await snapshotOfA();
      await intruder(api().post('/api/v1/equipment'))
        .send({ locationId: norte, name: 'Intruso', category: 'OTHER' })
        .expect(404);
      await intruder(api().post('/api/v1/equipment'))
        .send({
          locationId: otherLocation,
          chairId: chairNorte,
          name: 'Intruso',
          category: 'OTHER',
        })
        .expect(404);
      const own = (
        await intruder(api().post('/api/v1/equipment'))
          .send({ locationId: otherLocation, name: 'De B', category: 'OTHER' })
          .expect(201)
      ).body as EquipmentBody;
      await intruder(api().patch(`/api/v1/equipment/${own.id}`))
        .send({ locationId: norte })
        .expect(404);
      await intruder(api().patch(`/api/v1/equipment/${own.id}`))
        .send({ chairId: chairNorte })
        .expect(404);
      expect(await snapshotOfA()).toEqual(before);
    });

    // ISOLATION_COVERS: GET /equipment/:id
    // ISOLATION_COVERS: PATCH /equipment/:id
    // ISOLATION_COVERS: POST /equipment/:id/retire
    // ISOLATION_COVERS: POST /equipment/:id/maintenances
    // ISOLATION_COVERS: POST /equipment/:id/maintenances/:maintenanceId/void
    it('B → 404 al leer, editar, dar de baja (retire) y registrar o anular (void) maintenances del equipo de A, sin cambios en A', async () => {
      const live = (
        await admin(
          api().post(`/api/v1/equipment/${autoclave.id}/maintenances`),
        )
          .send({
            kind: 'CALIBRATION',
            performedOn: sedeDay,
            description: 'Calibración',
          })
          .expect(201)
      ).body as MaintenanceBody;
      const before = await snapshotOfA();
      const attacks = [
        intruder(api().get(`/api/v1/equipment/${autoclave.id}`)),
        intruder(api().patch(`/api/v1/equipment/${autoclave.id}`)).send({
          name: 'Robado',
        }),
        intruder(api().post(`/api/v1/equipment/${autoclave.id}/retire`)).send({
          reason: 'Intruso',
        }),
        intruder(
          api().post(`/api/v1/equipment/${autoclave.id}/maintenances`),
        ).send({
          kind: 'CORRECTIVE',
          performedOn: sedeDay,
          description: 'Intruso',
        }),
        intruder(
          api().post(
            `/api/v1/equipment/${autoclave.id}/maintenances/${live.id}/void`,
          ),
        ).send({ reason: 'Intruso' }),
      ];
      for (const attack of attacks) {
        const res = await attack.expect(404);
        expect((res.body as { message: string }).message).toBe(
          'Equipo no encontrado',
        );
      }
      expect(await snapshotOfA()).toEqual(before);
    });

    it('la RLS de la app no deja ver ni insertar filas de A desde B', async () => {
      const appDb = new PrismaClient<Prisma.PrismaClientOptions>({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });
      try {
        const seen = await appDb.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${other.tenantId}, true)`;
          return tx.equipment.findMany({ where: { id: autoclave.id } });
        });
        expect(seen).toEqual([]);
        await expect(
          appDb.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_tenant', ${other.tenantId}, true)`;
            await tx.equipmentMaintenance.create({
              data: {
                tenantId: clinic.tenantId,
                equipmentId: autoclave.id,
                kind: 'CORRECTIVE',
                performedOn: new Date(`${sedeDay}T00:00:00.000Z`),
                description: 'Intruso',
                createdById: other.adminUserId,
              },
            });
          }),
        ).rejects.toThrow(/row-level security/);
      } finally {
        await appDb.$disconnect();
      }
    });
  });
});
