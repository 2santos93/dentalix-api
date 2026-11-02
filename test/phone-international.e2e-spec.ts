import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { Clinic, registerClinic, resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_NEW_YORK_FIXTURE,
  locationBody,
  locationData,
} from './support/location-fixtures';
import { DefaultPhoneRegionReader } from '../src/modules/patients/domain/ports/default-phone-region-reader.port';

// DX-387 en HTTP real: pacientes (ficha, listas, alta y edición),
// responsables y sedes devuelven `phoneInternational`, leído con el adaptador
// de DX-329 y la región de la sede que corresponda: la de la sede activa (o
// la principal) para pacientes y responsables, la propia para cada sede. Un
// número que no se lee da null, y el guardado no cambia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface PhoneBody {
  id: string;
  phone: string | null;
  phoneInternational: string | null;
}

describe('Teléfono con formato internacional (e2e, DX-387)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let mainLocation: string;
  let veLocation: string;
  let doc = 387000;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, location?: string) => {
    const r = req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);
    return location ? r.set('X-Location-Id', location) : r;
  };

  async function newPatient(phone: string | null): Promise<PhoneBody> {
    const res = await as(api().post('/api/v1/patients'))
      .send({
        firstName: 'Paula',
        lastName: `Formato ${doc}`,
        docType: 'NATIONAL_ID',
        docNumber: String(doc++),
        sex: 'F',
        ...(phone === null ? {} : { phone }),
      })
      .expect(201);
    return res.body as PhoneBody;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    // La sede principal nace con la región CO (DX-329).
    clinic = await registerClinic(app, 'dx387-telefonos');
    const main = await raw.location.findFirstOrThrow({
      where: { tenantId: clinic.tenantId },
      select: { id: true, defaultPhoneRegion: true },
    });
    expect(main.defaultPhoneRegion).toBe('CO');
    mainLocation = main.id;
    const second = await raw.location.create({
      data: locationData(REGIONAL_BOGOTA_FIXTURE, {
        tenantId: clinic.tenantId,
        name: 'Sede 387 VE',
        defaultPhoneRegion: 'VE',
      }),
    });
    veLocation = second.id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('pacientes', () => {
    it('the create and edit responses carry the international format', async () => {
      const created = await newPatient('310 5550101');
      expect(created.phoneInternational).toBe('+57 310 5550101');
      const edited = await as(api().patch(`/api/v1/patients/${created.id}`))
        .send({ phone: '+58 412 1234567' })
        .expect(200);
      expect(edited.body).toMatchObject({
        phone: '+58 412 1234567',
        phoneInternational: '+58 412 1234567',
      });
      const none = await newPatient(null);
      expect(none).toMatchObject({ phone: null, phoneInternational: null });
    });

    it('the record reads a number without + with the region of the active location, or the main one', async () => {
      const patient = await newPatient('0412-1234567');
      const read = async (location?: string) =>
        (
          await as(
            api().get(`/api/v1/patients/${patient.id}`),
            location,
          ).expect(200)
        ).body as PhoneBody;
      // En CO no es un número válido: null, y el guardado tal cual.
      expect(await read()).toMatchObject({
        phone: '0412-1234567',
        phoneInternational: null,
      });
      expect(await read(mainLocation)).toMatchObject({
        phoneInternational: null,
      });
      expect(await read(veLocation)).toMatchObject({
        phone: '0412-1234567',
        phoneInternational: '+58 412 1234567',
      });
    });

    it('an unreadable or ambiguous number gives null and keeps the stored text', async () => {
      const text = await newPatient('llamar por la tarde');
      expect(text).toMatchObject({
        phone: 'llamar por la tarde',
        phoneInternational: null,
      });
      const ambiguous = await newPatient('0058 412 1234567');
      expect(ambiguous.phoneInternational).toBeNull();
      const long = await newPatient('+57 310 555 0101 ext. 123456');
      expect(long.phoneInternational).toBe('+57 310 5550101 ext. 123456');
    });

    it('the list reads the region once per request, not once per patient', async () => {
      await newPatient('311 5550102');
      await newPatient('312 5550103');
      const reader = app.get(DefaultPhoneRegionReader);
      const spy = jest.spyOn(reader, 'defaultPhoneRegion');
      try {
        const res = await as(
          api().get('/api/v1/patients').query({ pageSize: 50 }),
        ).expect(200);
        const items = (res.body as { items: PhoneBody[] }).items;
        expect(items.length).toBeGreaterThanOrEqual(5);
        expect(spy).toHaveBeenCalledTimes(1);
        const byPhone = new Map(
          items.map((p) => [p.phone, p.phoneInternational]),
        );
        expect(byPhone.get('311 5550102')).toBe('+57 311 5550102');
        expect(byPhone.get('0412-1234567')).toBeNull();
        expect(byPhone.get('llamar por la tarde')).toBeNull();
        for (const item of items) {
          expect(item).toHaveProperty('phoneInternational');
        }
      } finally {
        spy.mockRestore();
      }
    });

    it('the list in the VE location reads the same digits with its region', async () => {
      const res = await as(
        api().get('/api/v1/patients').query({ pageSize: 50 }),
        veLocation,
      ).expect(200);
      const items = (res.body as { items: PhoneBody[] }).items;
      const match = items.find((p) => p.phone === '0412-1234567');
      expect(match?.phoneInternational).toBe('+58 412 1234567');
    });
  });

  describe('aislamiento por clínica', () => {
    it('another clinic reads with its own main location, never with an older one of this clinic nor with a foreign X-Location-Id', async () => {
      // La sede principal de ESTA clínica (CO) es más antigua: si la lectura
      // de la región no se filtrase por clínica, la otra la tomaría.
      const other = await registerClinic(
        app,
        'dx387-telefonos-otra',
        REGIONAL_NEW_YORK_FIXTURE,
      );
      const asOther = (req: request.Test) =>
        req
          .set('X-Tenant-Host', other.host)
          .set('Authorization', `Bearer ${other.adminToken}`);
      const created = await asOther(api().post('/api/v1/patients'))
        .send({
          firstName: 'Ana',
          lastName: 'Aislada',
          docType: 'NATIONAL_ID',
          docNumber: String(doc++),
          sex: 'F',
          phone: '212 555 0123',
        })
        .expect(201);
      expect(created.body).toMatchObject({
        phone: '212 555 0123',
        phoneInternational: '+1 212 555 0123',
      });
      const list = await asOther(api().get('/api/v1/patients')).expect(200);
      const items = (list.body as { items: PhoneBody[] }).items;
      expect(items.map((p) => p.phoneInternational)).toEqual([
        '+1 212 555 0123',
      ]);
      // Una sede de otra clínica no es la sede activa de nadie aquí.
      const foreign = await asOther(
        api().get(`/api/v1/patients/${(created.body as PhoneBody).id}`),
      ).set('X-Location-Id', veLocation);
      expect(foreign.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(foreign.body)).not.toContain('+58');
    });
  });

  describe('responsables', () => {
    it('a contact and a responsible patient carry the international format', async () => {
      const child = await newPatient(null);
      const mother = await newPatient('313 5550104');
      const parties = `/api/v1/patients/${child.id}/responsible-parties`;
      const created = await as(api().post(parties))
        .send({
          fullName: 'Luis Ortiz',
          phone: '0412-7654321',
          relationship: 'FATHER',
        })
        .expect(201);
      expect(created.body).toMatchObject({
        phone: '0412-7654321',
        phoneInternational: null,
      });
      await as(api().post(parties))
        .send({ responsiblePatientId: mother.id, relationship: 'MOTHER' })
        .expect(201);

      const list = async (location?: string) =>
        (
          (await as(api().get(parties), location).expect(200)).body as {
            parties: Array<
              PhoneBody & {
                kind: string;
                responsiblePatient:
                  (PhoneBody & Record<string, unknown>) | null;
              }
            >;
          }
        ).parties;

      const inMain = await list();
      const contact = inMain.find((p) => p.kind === 'CONTACT');
      const patient = inMain.find((p) => p.kind === 'PATIENT');
      expect(contact).toMatchObject({
        phone: '0412-7654321',
        phoneInternational: null,
      });
      expect(patient).toMatchObject({
        phone: '313 5550104',
        phoneInternational: '+57 313 5550104',
        responsiblePatient: {
          phone: '313 5550104',
          phoneInternational: '+57 313 5550104',
        },
      });

      const inVe = await list(veLocation);
      expect(inVe.find((p) => p.kind === 'CONTACT')).toMatchObject({
        phoneInternational: '+58 412 7654321',
      });
    });
  });

  describe('sedes', () => {
    it('each location reads its own phone with its own region', async () => {
      await as(api().patch(`/api/v1/locations/${mainLocation}`))
        .send({ phone: '601 555 0101' })
        .expect(200)
        .expect((res) =>
          expect(res.body).toMatchObject({
            phone: '601 555 0101',
            phoneInternational: '+57 601 5550101',
          }),
        );
      await raw.location.update({
        where: { id: veLocation },
        data: { phone: '0212-5551234' },
      });
      const res = await as(api().get('/api/v1/locations')).expect(200);
      const byId = new Map(
        (res.body as PhoneBody[]).map((l) => [l.id, l.phoneInternational]),
      );
      expect(byId.get(mainLocation)).toBe('+57 601 5550101');
      expect(byId.get(veLocation)).toBe('+58 212 5551234');
    });

    it('a location without a default prefix or with an unreadable phone answers null and keeps the stored one', async () => {
      const cleared = await as(api().patch(`/api/v1/locations/${mainLocation}`))
        .send({ defaultPhoneRegion: null })
        .expect(200);
      expect(cleared.body).toMatchObject({
        phone: '601 555 0101',
        defaultPhoneRegion: null,
        phoneInternational: null,
      });
      const text = await as(api().patch(`/api/v1/locations/${mainLocation}`))
        .send({ phone: 'Recepción, ext. 2', defaultPhoneRegion: 'CO' })
        .expect(200);
      expect(text.body).toMatchObject({
        phone: 'Recepción, ext. 2',
        phoneInternational: null,
      });
    });

    it('a new location answers with the international format too', async () => {
      const created = await as(api().post('/api/v1/locations'))
        .send(
          locationBody(REGIONAL_BOGOTA_FIXTURE, {
            name: 'Sede 387 nueva',
            phone: '+57 601 5550199',
          }),
        )
        .expect(201);
      expect((created.body as PhoneBody).phoneInternational).toBe(
        '+57 601 5550199',
      );
    });
  });
});
