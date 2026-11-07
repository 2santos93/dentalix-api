import { INestApplication } from '@nestjs/common';
import { CatalogKind, ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_BERLIN_FIXTURE,
  REGIONAL_CARACAS_FIXTURE,
  locationBody,
} from './support/location-fixtures';

// DX-502 en HTTP real, aislamiento de la moneda del catálogo: es la común de
// las sedes activas de SU clínica (la de otra clínica no cuenta) y de TODAS
// sus sedes, no solo las del usuario (un miembro restringido a una sede no ve
// otra moneda del catálogo). Con una sede activa en otra moneda deja de haber
// una común: null para todos.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface PriceQuoteBody {
  basePrice: number | null;
  catalogCurrency: string | null;
}

interface ItemBody {
  id: string;
  basePrice: number | null;
  catalogCurrency: string | null;
}

describe('Moneda del catálogo: aislamiento por clínica y por sede (e2e, DX-502)', () => {
  let app: INestApplication<App>;
  let vesClinic: Clinic;
  let eurClinic: Clinic;

  const server = () => request(app.getHttpServer());
  const as = (
    clinic: Clinic,
    token = clinic.adminToken,
    locationId?: string,
  ) => {
    const set = (req: request.Test) => {
      const withAuth = req
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`);
      return locationId ? withAuth.set('X-Location-Id', locationId) : withAuth;
    };
    return {
      get: (path: string) => set(server().get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        set(server().post(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        set(server().put(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) =>
        set(server().patch(`/api/v1${path}`)).send(body),
    };
  };

  /** Un procedimiento a 80 000 y un paciente de la clínica. */
  async function catalogAndPatient(
    clinic: Clinic,
    code: string,
  ): Promise<{ catalogItemId: string; patientId: string }> {
    const catalog = await as(clinic)
      .post('/catalog/items', {
        code,
        kind: CatalogKind.PROCEDURE,
        labelEs: `Corona ${code}`,
        color: '#2A2B3C',
        defaultPrice: 80000,
      })
      .expect(201);
    const patient = await as(clinic)
      .post('/patients', {
        docType: 'NATIONAL_ID',
        sex: 'F',
        firstName: 'Lucía',
        lastName: code,
        docNumber: code,
        birthDate: '1990-01-01',
      })
      .expect(201);
    return {
      catalogItemId: (catalog.body as { id: string }).id,
      patientId: (patient.body as { id: string }).id,
    };
  }

  async function quoteCurrency(
    clinic: Clinic,
    patientId: string,
    catalogItemId: string,
    token = clinic.adminToken,
    locationId?: string,
  ): Promise<string | null> {
    const res = await as(clinic, token, locationId)
      .get(
        `/patients/${patientId}/price-quote?catalogItemId=${catalogItemId}&currency=EUR`,
      )
      .expect(200);
    const body = res.body as PriceQuoteBody;
    expect(body.basePrice).toBe(80000);
    return body.catalogCurrency;
  }

  async function addedItem(
    clinic: Clinic,
    patientId: string,
    catalogItemId: string,
    token = clinic.adminToken,
    locationId?: string,
  ): Promise<ItemBody> {
    const plan = await as(clinic, token, locationId)
      .post(`/patients/${patientId}/treatment-plans`, { currency: 'EUR' })
      .expect(201);
    const item = await as(clinic, token, locationId)
      .post(`/treatment-plans/${(plan.body as { id: string }).id}/items`, {
        toothNumber: '11',
        catalogItemId,
      })
      .expect(201);
    return item.body as ItemBody;
  }

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    vesClinic = await registerClinic(
      app,
      'dx502-ves',
      REGIONAL_CARACAS_FIXTURE,
    );
    eurClinic = await registerClinic(app, 'dx502-eur', REGIONAL_BERLIN_FIXTURE);
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('cada clínica con la moneda de SUS sedes: VES en una, EUR en la otra', async () => {
    const ves = await catalogAndPatient(vesClinic, 'DX502-A');
    const eur = await catalogAndPatient(eurClinic, 'DX502-B');

    expect(
      await quoteCurrency(vesClinic, ves.patientId, ves.catalogItemId),
    ).toBe('VES');
    expect(
      await addedItem(vesClinic, ves.patientId, ves.catalogItemId),
    ).toMatchObject({ basePrice: 80000, catalogCurrency: 'VES' });

    expect(
      await quoteCurrency(eurClinic, eur.patientId, eur.catalogItemId),
    ).toBe('EUR');
    expect(
      await addedItem(eurClinic, eur.patientId, eur.catalogItemId),
    ).toMatchObject({ basePrice: 80000, catalogCurrency: 'EUR' });
  });

  it('un miembro restringido a una de dos sedes en VES ve VES; con una tercera sede activa en EUR, nadie tiene moneda del catálogo', async () => {
    const { catalogItemId, patientId } = await catalogAndPatient(
      vesClinic,
      'DX502-C',
    );
    const second = await as(vesClinic)
      .post(
        '/locations',
        locationBody(REGIONAL_CARACAS_FIXTURE, { name: 'Sede Norte DX502' }),
      )
      .expect(201);
    const secondId = (second.body as { id: string }).id;
    const member = await seedMember(raw, vesClinic, ClinicRole.DENTIST);
    await as(vesClinic)
      .put(`/staff/${member.userId}/locations`, { locationIds: [secondId] })
      .expect(200);
    // El login lee las sedes vigentes: el token ya lleva la restricción.
    const restricted = await loginAs(app, vesClinic.host, member.email);

    expect(
      await quoteCurrency(
        vesClinic,
        patientId,
        catalogItemId,
        restricted,
        secondId,
      ),
    ).toBe('VES');
    expect(
      await addedItem(
        vesClinic,
        patientId,
        catalogItemId,
        restricted,
        secondId,
      ),
    ).toMatchObject({ catalogCurrency: 'VES' });

    // Una tercera sede activa en EUR: ya no hay una moneda común. Tampoco
    // para quien solo ve la sede Norte (en VES).
    await as(vesClinic)
      .post(
        '/locations',
        locationBody(REGIONAL_BERLIN_FIXTURE, { name: 'Sede Berlín DX502' }),
      )
      .expect(201);
    expect(
      await quoteCurrency(
        vesClinic,
        patientId,
        catalogItemId,
        restricted,
        secondId,
      ),
    ).toBeNull();
    expect(await quoteCurrency(vesClinic, patientId, catalogItemId)).toBeNull();
    expect(
      await addedItem(
        vesClinic,
        patientId,
        catalogItemId,
        restricted,
        secondId,
      ),
    ).toMatchObject({ basePrice: 80000, catalogCurrency: null });
  });

  it('DX-502-bis: con la moneda del catálogo fijada en Ajustes, los ítems nuevos la llevan para todos; lo ya congelado no cambia y la otra clínica sigue con la suya', async () => {
    const { catalogItemId, patientId } = await catalogAndPatient(
      vesClinic,
      'DX502B-A',
    );
    // vesClinic tiene ya sedes en VES y EUR (test anterior): sin moneda común.
    const frozenNull = await addedItem(vesClinic, patientId, catalogItemId);
    expect(frozenNull).toMatchObject({ catalogCurrency: null });

    await as(vesClinic)
      .patch('/clinic/settings', { catalogCurrency: 'USD' })
      .expect(200);
    expect(await quoteCurrency(vesClinic, patientId, catalogItemId)).toBe(
      'USD',
    );
    const frozenUsd = await addedItem(vesClinic, patientId, catalogItemId);
    expect(frozenUsd).toMatchObject({
      basePrice: 80000,
      catalogCurrency: 'USD',
    });
    // El miembro restringido a la sede Norte (en VES, test anterior) también
    // recibe la de la clínica.
    const vesOnly = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: vesClinic.tenantId, name: 'Sede Norte DX502' },
        select: { id: true },
      })
    ).id;
    const restricted = await loginAs(
      app,
      vesClinic.host,
      `${ClinicRole.DENTIST.toLowerCase()}@${vesClinic.subdomain}.test`,
    );
    expect(
      await quoteCurrency(
        vesClinic,
        patientId,
        catalogItemId,
        restricted,
        vesOnly,
      ),
    ).toBe('USD');

    // La otra clínica no se entera.
    const eur = await catalogAndPatient(eurClinic, 'DX502B-B');
    expect(
      await quoteCurrency(eurClinic, eur.patientId, eur.catalogItemId),
    ).toBe('EUR');

    // Quitarla vuelve a la regla de las sedes; lo congelado sigue igual.
    await as(vesClinic)
      .patch('/clinic/settings', { catalogCurrency: null })
      .expect(200);
    expect(await quoteCurrency(vesClinic, patientId, catalogItemId)).toBeNull();
    const stored = await raw.treatmentPlanItem.findMany({
      where: { id: { in: [frozenNull.id, frozenUsd.id] } },
      select: { id: true, catalogCurrency: true },
    });
    expect(
      Object.fromEntries(stored.map((i) => [i.id, i.catalogCurrency])),
    ).toEqual({ [frozenNull.id]: null, [frozenUsd.id]: 'USD' });
  });
});
