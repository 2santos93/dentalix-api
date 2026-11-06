import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  addCivilDays,
  civilDateIn,
  civilDaysInclusive,
} from '../src/shared/time/civil-day';
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

// DX-544 en HTTP real: expediente de rayos X por sede (licencia y control de
// calidad). ADMIN crea, edita y anula (con motivo); DENTIST solo lee;
// RECEPTION y ASSISTANT no lo ven (403 en español). El vencimiento se calcula
// si no se indica, el equipo tiene que ser de rayos X de la MISMA sede, los
// avisos de «Mi día» (≤90 días) siguen a la sede, y la clínica B ataca con
// los ids de A (`tenant-id-inputs.ts` y la matriz de aislamiento citan este
// spec).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SEDE = sedeTodayFixture();
/** El día civil de la sede ahora (la zona se eligió lejos de su medianoche). */
const sedeDay = civilDateIn(new Date(), SEDE.timeZone);

interface RecordBody {
  id: string;
  locationId: string;
  locationName: string;
  equipmentId: string | null;
  equipmentName: string | null;
  kind: 'LICENSE' | 'QUALITY_CONTROL';
  category: 'I' | 'II' | null;
  reference: string | null;
  issuer: string;
  issuedOn: string;
  expiresOn: string;
  officerUserId: string | null;
  officerMemberName: string | null;
  officerName: string | null;
  notes: string | null;
  status: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

interface ListBody {
  items: RecordBody[];
  total: number;
}

interface DueBody {
  items: {
    id: string;
    kind: string;
    locationName: string;
    expiresOn: string;
    status: string;
    daysUntilExpiry: number;
  }[];
  total: number;
}

describe('Expediente de rayos X por sede (e2e, DX-544)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let norte: string;
  let sur: string;
  let otherLocation: string;
  let xrayNorte: string;
  let xraySur: string;
  let autoclaveNorte: string;
  let otherXray: string;
  let dentist: { userId: string; email: string };
  let dentistToken: string;
  let receptionToken: string;
  let assistantToken: string;
  let license: RecordBody;
  let quality: RecordBody;

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

  async function createEquipment(
    c: Clinic,
    locationId: string,
    name: string,
    category = 'XRAY',
  ): Promise<string> {
    const res = await as(api().post('/api/v1/equipment'), c.adminToken, c.host)
      .send({ locationId, name, category })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  /** Lo que B no puede cambiar: las filas de A. */
  function snapshotOfA() {
    return raw.radiologyRecord.findMany({
      where: { tenantId: clinic.tenantId },
      orderBy: { id: 'asc' },
    });
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx544-e2e');
    other = await registerClinic(app, 'dx544-e2e-otra');
    norte = await createLocation(clinic, 'Sede Norte');
    sur = await createLocation(clinic, 'Sede Sur');
    otherLocation = await createLocation(other, 'Sede de B');
    xrayNorte = await createEquipment(clinic, norte, 'Periapical Norte');
    xraySur = await createEquipment(clinic, sur, 'Panorámico Sur');
    autoclaveNorte = await createEquipment(
      clinic,
      norte,
      'Autoclave',
      'AUTOCLAVE',
    );
    otherXray = await createEquipment(other, otherLocation, 'Rayos X de B');
    dentist = await seedMember(raw, clinic, ClinicRole.DENTIST);
    dentistToken = await loginAs(app, clinic.host, dentist.email);
    const reception = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    receptionToken = await loginAs(app, clinic.host, reception.email);
    const assistant = await seedMember(raw, clinic, ClinicRole.ASSISTANT);
    assistantToken = await loginAs(app, clinic.host, assistant.email);
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  describe('alta, edición y anulación (solo ADMIN)', () => {
    it('ADMIN crea una licencia Cat. I sin vencimiento: se calcula a 5 años', async () => {
      const issuedOn = addCivilMonths(sedeDay, -2);
      const res = await admin(api().post('/api/v1/radiology-records'))
        .send({
          kind: 'LICENSE',
          locationId: norte,
          equipmentId: xrayNorte,
          category: 'I',
          reference: ' Res. 2026-0101 ',
          issuer: 'Secretaría Seccional de Salud',
          issuedOn,
          officerUserId: dentist.userId,
          notes: 'Original en recepción',
        })
        .expect(201);
      license = res.body as RecordBody;
      expect(license).toMatchObject({
        kind: 'LICENSE',
        locationId: norte,
        locationName: 'Sede Norte',
        equipmentId: xrayNorte,
        equipmentName: 'Periapical Norte',
        category: 'I',
        reference: 'Res. 2026-0101',
        issuedOn,
        expiresOn: addCivilMonths(issuedOn, 60),
        officerUserId: dentist.userId,
        officerMemberName: 'Miembro DENTIST',
        officerName: null,
        status: 'UP_TO_DATE',
        voidedAt: null,
      });
    });

    it('ADMIN crea un control de calidad sin vencimiento: 2 años; con fecha vieja sale vencido', async () => {
      const issuedOn = addCivilDays(addCivilMonths(sedeDay, -24), -3);
      quality = (
        await admin(api().post('/api/v1/radiology-records'))
          .send({
            kind: 'QUALITY_CONTROL',
            locationId: norte,
            issuer: 'Física Médica SAS',
            issuedOn,
            officerName: 'Ing. Pérez',
          })
          .expect(201)
      ).body as RecordBody;
      expect(quality).toMatchObject({
        category: null,
        reference: null,
        expiresOn: addCivilMonths(issuedOn, 24),
        officerName: 'Ing. Pérez',
        status: 'OVERDUE',
      });
    });

    it('valida en español: categoría solo en licencia, expedición futura, encargado doble', async () => {
      const before = await raw.radiologyRecord.count();
      const qcWithCategory = await admin(
        api().post('/api/v1/radiology-records'),
      )
        .send({
          kind: 'QUALITY_CONTROL',
          locationId: norte,
          category: 'II',
          issuer: 'X',
          issuedOn: sedeDay,
        })
        .expect(400);
      expect((qcWithCategory.body as { message: string }).message).toBe(
        'La categoría solo va en una licencia.',
      );
      const future = await admin(api().post('/api/v1/radiology-records'))
        .send({
          kind: 'LICENSE',
          locationId: norte,
          category: 'I',
          reference: 'R',
          issuer: 'X',
          issuedOn: addCivilDays(sedeDay, 1),
        })
        .expect(400);
      expect((future.body as { message: string }).message).toBe(
        'La fecha de expedición no puede ser futura.',
      );
      await admin(api().post('/api/v1/radiology-records'))
        .send({
          kind: 'LICENSE',
          locationId: norte,
          category: 'I',
          reference: 'R',
          issuer: 'X',
          issuedOn: sedeDay,
          officerUserId: dentist.userId,
          officerName: 'Otro',
        })
        .expect(400);
      await admin(api().post('/api/v1/radiology-records'))
        .send({
          kind: 'OTRO',
          locationId: norte,
          issuer: 'X',
          issuedOn: sedeDay,
        })
        .expect(400);
      expect(await raw.radiologyRecord.count()).toBe(before);
    });

    it('el equipo de otra sede o que no es de rayos X da 400, y uno de otra clínica 404', async () => {
      const before = await raw.radiologyRecord.count();
      const body = {
        kind: 'LICENSE',
        locationId: norte,
        category: 'II',
        reference: 'R',
        issuer: 'X',
        issuedOn: sedeDay,
      };
      const otherSede = await admin(api().post('/api/v1/radiology-records'))
        .send({ ...body, equipmentId: xraySur })
        .expect(400);
      expect((otherSede.body as { message: string }).message).toBe(
        'El equipo no es de la sede del documento.',
      );
      await admin(api().post('/api/v1/radiology-records'))
        .send({ ...body, equipmentId: autoclaveNorte })
        .expect(400);
      const otherClinic = await admin(api().post('/api/v1/radiology-records'))
        .send({ ...body, equipmentId: otherXray })
        .expect(404);
      expect((otherClinic.body as { message: string }).message).toBe(
        'Equipo no encontrado',
      );
      const otherOfficer = await admin(api().post('/api/v1/radiology-records'))
        .send({ ...body, officerUserId: other.adminUserId })
        .expect(404);
      expect((otherOfficer.body as { message: string }).message).toBe(
        'Miembro del personal no encontrado',
      );
      expect(await raw.radiologyRecord.count()).toBe(before);
    });

    it('ADMIN edita: la categoría recalcula el vencimiento; el escrito manda; null en un obligatorio da 400', async () => {
      const edited = (
        await admin(api().patch(`/api/v1/radiology-records/${license.id}`))
          .send({ category: 'II' })
          .expect(200)
      ).body as RecordBody;
      expect(edited.expiresOn).toBe(addCivilMonths(license.issuedOn, 48));
      const soon = addCivilDays(sedeDay, 40);
      license = (
        await admin(api().patch(`/api/v1/radiology-records/${license.id}`))
          .send({ expiresOn: soon, officerName: 'Dra. Externa' })
          .expect(200)
      ).body as RecordBody;
      expect(license).toMatchObject({
        expiresOn: soon,
        status: 'DUE_SOON',
        officerUserId: null,
        officerName: 'Dra. Externa',
      });
      for (const patch of [
        { issuer: null },
        { issuedOn: null },
        { locationId: null },
      ]) {
        await admin(api().patch(`/api/v1/radiology-records/${license.id}`))
          .send(patch)
          .expect(400);
      }
      await expect(
        raw.radiologyRecord.findUniqueOrThrow({ where: { id: license.id } }),
      ).resolves.toMatchObject({ issuer: 'Secretaría Seccional de Salud' });
    });

    it('un equipo con documentos no se traslada de sede: 409 en español', async () => {
      const res = await admin(api().patch(`/api/v1/equipment/${xrayNorte}`))
        .send({ locationId: sur })
        .expect(409);
      expect((res.body as { message: string }).message).toContain(
        'no se traslada',
      );
    });

    it('anular exige motivo, una vez; anulado no se edita (409)', async () => {
      const extra = (
        await admin(api().post('/api/v1/radiology-records'))
          .send({
            kind: 'LICENSE',
            locationId: sur,
            category: 'II',
            reference: 'Duplicada',
            issuer: 'X',
            issuedOn: sedeDay,
          })
          .expect(201)
      ).body as RecordBody;
      await admin(api().post(`/api/v1/radiology-records/${extra.id}/void`))
        .send({ reason: 'x' })
        .expect(400);
      const voided = (
        await admin(api().post(`/api/v1/radiology-records/${extra.id}/void`))
          .send({ reason: 'Registrada dos veces' })
          .expect(200)
      ).body as RecordBody;
      expect(voided).toMatchObject({
        voidReason: 'Registrada dos veces',
        status: null,
      });
      expect(voided.voidedAt).not.toBeNull();
      await admin(api().post(`/api/v1/radiology-records/${extra.id}/void`))
        .send({ reason: 'Otra vez' })
        .expect(409);
      await admin(api().patch(`/api/v1/radiology-records/${extra.id}`))
        .send({ notes: 'x' })
        .expect(409);
      // Ni la lista por defecto ni los avisos lo traen; con status=VOIDED sí.
      const live = (
        await admin(
          api().get(`/api/v1/radiology-records?locationId=${sur}`),
        ).expect(200)
      ).body as ListBody;
      expect(live.items.map((i) => i.id)).not.toContain(extra.id);
      const voidedList = (
        await admin(
          api().get(
            `/api/v1/radiology-records?locationId=${sur}&status=VOIDED`,
          ),
        ).expect(200)
      ).body as ListBody;
      expect(voidedList.items.map((i) => i.id)).toEqual([extra.id]);
    });

    it('ParseUUIDPipe: un id que no es UUID da 400', async () => {
      await admin(api().get('/api/v1/radiology-records/no-es-uuid')).expect(
        400,
      );
    });

    it('cada escritura queda en la auditoría como RADIOLOGY_RECORD', async () => {
      const events = await raw.auditEvent.findMany({
        where: { tenantId: clinic.tenantId, resourceType: 'RADIOLOGY_RECORD' },
        select: { action: true, resourceId: true },
      });
      expect(events).toEqual(
        expect.arrayContaining([
          { action: 'CREATE', resourceId: license.id },
          { action: 'CREATE', resourceId: quality.id },
          { action: 'UPDATE', resourceId: license.id },
          expect.objectContaining({ action: 'VOID' }),
        ]),
      );
    });
  });

  describe('roles', () => {
    it('DENTIST lee la lista, el detalle y los avisos, pero no escribe (403 en español)', async () => {
      const list = (
        await as(api().get('/api/v1/radiology-records'), dentistToken).expect(
          200,
        )
      ).body as ListBody;
      expect(list.items.map((i) => i.id)).toEqual(
        expect.arrayContaining([license.id, quality.id]),
      );
      await as(
        api().get(`/api/v1/radiology-records/${license.id}`),
        dentistToken,
      ).expect(200);
      await as(api().get('/api/v1/radiology-records/due'), dentistToken).expect(
        200,
      );
      const before = await snapshotOfA();
      const writes = [
        as(api().post('/api/v1/radiology-records'), dentistToken).send({
          kind: 'QUALITY_CONTROL',
          locationId: norte,
          issuer: 'X',
          issuedOn: sedeDay,
        }),
        as(
          api().patch(`/api/v1/radiology-records/${license.id}`),
          dentistToken,
        ).send({ notes: 'x' }),
        as(
          api().post(`/api/v1/radiology-records/${license.id}/void`),
          dentistToken,
        ).send({ reason: 'No autorizado' }),
      ];
      for (const write of writes) {
        const res = await write.expect(403);
        expect((res.body as { message: string }).message).toBe(
          'Solo administración registra o cambia el expediente de rayos X.',
        );
      }
      expect(await snapshotOfA()).toEqual(before);
    });

    it('RECEPTION y ASSISTANT no lo ven (403 en español)', async () => {
      for (const token of [receptionToken, assistantToken]) {
        for (const path of [
          '/api/v1/radiology-records',
          '/api/v1/radiology-records/due',
          `/api/v1/radiology-records/${license.id}`,
        ]) {
          const res = await as(api().get(path), token).expect(403);
          expect((res.body as { message: string }).message).toBe(
            'Solo odontología y administración ven el expediente de rayos X.',
          );
        }
      }
    });
  });

  describe('avisos de «Mi día» y sedes', () => {
    it('trae los vencidos y los ≤90 días, el más urgente primero, y sigue a X-Location-Id', async () => {
      const due = (
        await admin(api().get('/api/v1/radiology-records/due')).expect(200)
      ).body as DueBody;
      expect(due.items.map((i) => [i.id, i.status])).toEqual([
        [quality.id, 'OVERDUE'],
        [license.id, 'DUE_SOON'],
      ]);
      expect(due.items[0].daysUntilExpiry).toBe(
        civilDaysInclusive(sedeDay, quality.expiresOn) - 1,
      );
      expect(due.items[0].daysUntilExpiry).toBeLessThan(0);
      expect(due.items[1]).toMatchObject({
        daysUntilExpiry: 40,
        locationName: 'Sede Norte',
        kind: 'LICENSE',
      });
      const inSur = (
        await admin(api().get('/api/v1/radiology-records/due'))
          .set('X-Location-Id', sur)
          .expect(200)
      ).body as DueBody;
      expect(inSur).toMatchObject({ items: [], total: 0 });
    });

    it('al renovar (otro vivo del grupo vence después) el viejo sale «Renovado» y deja de avisar', async () => {
      const renewal = (
        await admin(api().post('/api/v1/radiology-records'))
          .send({
            kind: 'QUALITY_CONTROL',
            locationId: norte,
            issuer: 'Física Médica SAS',
            issuedOn: sedeDay,
          })
          .expect(201)
      ).body as RecordBody;
      const list = (
        await admin(
          api().get(`/api/v1/radiology-records?locationId=${norte}`),
        ).expect(200)
      ).body as ListBody;
      expect(list.items.find((i) => i.id === quality.id)?.status).toBe(
        'RENEWED',
      );
      expect(list.items.find((i) => i.id === renewal.id)?.status).toBe(
        'UP_TO_DATE',
      );
      const due = (
        await admin(api().get('/api/v1/radiology-records/due')).expect(200)
      ).body as DueBody;
      expect(due.items.map((i) => i.id)).toEqual([license.id]);
      // Se deshace para los tests siguientes.
      await admin(api().post(`/api/v1/radiology-records/${renewal.id}/void`))
        .send({ reason: 'Prueba de renovación' })
        .expect(200);
    });

    it('un ADMIN con el token acotado a la Sur no ve la Norte: 403 LOCATION_NOT_ALLOWED y listas sin ella', async () => {
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
        as(api().get(`/api/v1/radiology-records/${license.id}`), token),
        as(api().get(`/api/v1/radiology-records?locationId=${norte}`), token),
        as(api().patch(`/api/v1/radiology-records/${license.id}`), token).send({
          notes: 'No es su sede',
        }),
        as(
          api().post(`/api/v1/radiology-records/${license.id}/void`),
          token,
        ).send({ reason: 'No es su sede' }),
        as(api().post('/api/v1/radiology-records'), token).send({
          kind: 'QUALITY_CONTROL',
          locationId: norte,
          issuer: 'X',
          issuedOn: sedeDay,
        }),
      ];
      for (const attack of attacks) {
        const res = await attack.expect(403);
        expect(res.body).toMatchObject({ code: 'LOCATION_NOT_ALLOWED' });
      }
      const list = (
        await as(api().get('/api/v1/radiology-records'), token).expect(200)
      ).body as ListBody;
      expect(list.items.every((i) => i.locationId === sur)).toBe(true);
      const due = (
        await as(api().get('/api/v1/radiology-records/due'), token).expect(200)
      ).body as DueBody;
      expect(due.items).toEqual([]);
      expect(await snapshotOfA()).toEqual(before);
    });
  });

  describe('aislamiento entre clínicas (B ataca con los ids de A)', () => {
    it('B no ve los documentos de A en su lista ni en sus avisos, ni filtra por la sede de A', async () => {
      const list = (
        await intruder(api().get('/api/v1/radiology-records')).expect(200)
      ).body as ListBody;
      expect(list.items).toEqual([]);
      const due = (
        await intruder(api().get('/api/v1/radiology-records/due')).expect(200)
      ).body as DueBody;
      expect(due.items).toEqual([]);
      const bySede = await intruder(
        api().get(`/api/v1/radiology-records?locationId=${norte}`),
      ).expect(404);
      expect((bySede.body as { message: string }).message).toBe(
        'Sede no encontrada',
      );
    });

    it('B no crea ni mueve documentos a la sede, al equipo o al personal de A', async () => {
      const before = await snapshotOfA();
      const base = {
        kind: 'LICENSE',
        category: 'I',
        reference: 'Intrusa',
        issuer: 'X',
        issuedOn: sedeDay,
      };
      await intruder(api().post('/api/v1/radiology-records'))
        .send({ ...base, locationId: norte })
        .expect(404);
      await intruder(api().post('/api/v1/radiology-records'))
        .send({ ...base, locationId: otherLocation, equipmentId: xrayNorte })
        .expect(404);
      await intruder(api().post('/api/v1/radiology-records'))
        .send({
          ...base,
          locationId: otherLocation,
          officerUserId: dentist.userId,
        })
        .expect(404);
      const own = (
        await intruder(api().post('/api/v1/radiology-records'))
          .send({ ...base, locationId: otherLocation, equipmentId: otherXray })
          .expect(201)
      ).body as RecordBody;
      await intruder(api().patch(`/api/v1/radiology-records/${own.id}`))
        .send({ locationId: norte })
        .expect(404);
      await intruder(api().patch(`/api/v1/radiology-records/${own.id}`))
        .send({ equipmentId: xrayNorte })
        .expect(404);
      await intruder(api().patch(`/api/v1/radiology-records/${own.id}`))
        .send({ officerUserId: dentist.userId })
        .expect(404);
      expect(await snapshotOfA()).toEqual(before);
    });

    // ISOLATION_COVERS: GET /radiology-records/:id
    // ISOLATION_COVERS: PATCH /radiology-records/:id
    // ISOLATION_COVERS: POST /radiology-records/:id/void
    it('B → 404 al leer, editar y anular (void) el documento de A, sin cambios en A', async () => {
      const before = await snapshotOfA();
      const attacks = [
        intruder(api().get(`/api/v1/radiology-records/${license.id}`)),
        intruder(api().patch(`/api/v1/radiology-records/${license.id}`)).send({
          issuer: 'Robado',
        }),
        intruder(
          api().post(`/api/v1/radiology-records/${license.id}/void`),
        ).send({ reason: 'Intruso' }),
      ];
      for (const attack of attacks) {
        const res = await attack.expect(404);
        expect((res.body as { message: string }).message).toBe(
          'Documento de rayos X no encontrado',
        );
      }
      expect(await snapshotOfA()).toEqual(before);
    });

    it('el token de A en el host de B da 401', async () => {
      await as(
        api().get('/api/v1/radiology-records'),
        clinic.adminToken,
        other.host,
      ).expect(401);
    });
  });
});
