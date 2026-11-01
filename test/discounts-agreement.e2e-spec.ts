import { INestApplication } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  Prisma,
  PrismaClient,
  Sex,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationBody,
} from './support/location-fixtures';

// SEC-047 en HTTP real: la rebaja de convenio queda en el informe de
// descuentos (DX-204). Un ítem resuelto por convenio sale con su rebaja (precio
// de catálogo − precio del convenio), quién asignó el convenio y quién creó el
// ítem, aparte del descuento discrecional; con los filtros, en el CSV y sin
// cruzar de clínica.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY = 24 * 60 * 60 * 1000;
/** Día civil de la sede (UTC−5 fijo) `offset` días desde hoy. */
const bogotaDay = (offset = 0) =>
  new Date(Date.now() - 5 * 60 * 60 * 1000 + offset * DAY)
    .toISOString()
    .slice(0, 10);

interface ReportItem {
  itemId: string;
  patientName: string;
  catalogPrice: number | null;
  price: number;
  priceReduction: number;
  itemDiscount: number;
  discount: number;
  percent: number;
  priceSource: string | null;
  agreementName: string | null;
  basePrice: number | null;
  agreementReduction: number;
  agreementPercent: number;
  agreementAssignedById: string | null;
  agreementAssignedByName: string | null;
  createdById: string | null;
  createdByName: string | null;
  discountById: string | null;
  locationId: string | null;
}

interface Report {
  totals: {
    currency: string;
    items: number;
    gross: number;
    discount: number;
    percentOfGross: number;
  }[];
  agreementTotals: { currency: string; items: number; reduction: number }[];
  items: ReportItem[];
  total: number;
}

describe('Rebaja de convenio en el informe de descuentos (e2e, SEC-047)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let dentist: { userId: string; token: string };
  let reception: { userId: string; token: string };
  let crown: string;
  let suraItem: string;
  let cortesiaItem: string;
  let plainItem: string;

  const as = (clinic: Clinic, token = clinic.adminToken) => {
    const call =
      (verb: 'get' | 'post' | 'put') => (path: string, body?: object) => {
        const req = request(app.getHttpServer())
          [verb](`/api/v1${path}`)
          .set('X-Tenant-Host', clinic.host)
          .set('Authorization', `Bearer ${token}`);
        return body === undefined ? req : req.send(body);
      };
    return { get: call('get'), post: call('post'), put: call('put') };
  };

  async function create(
    path: string,
    body: object,
    token = clinicA.adminToken,
  ): Promise<string> {
    const res = await as(clinicA, token).post(path, body).expect(201);
    return (res.body as { id: string }).id;
  }

  const createPatient = (firstName: string) =>
    create('/patients', {
      firstName,
      lastName: 'Convenio',
      docType: 'NATIONAL_ID',
      docNumber: String(Math.floor(Math.random() * 1e9)),
      sex: Sex.F,
    });

  /** Plan del DENTIST con un ítem de la corona sin precio (el resuelto). */
  async function itemFor(patientId: string): Promise<string> {
    const plan = await create(
      `/patients/${patientId}/treatment-plans`,
      { currency: 'COP' },
      dentist.token,
    );
    return create(
      `/treatment-plans/${plan}/items`,
      { toothNumber: '36', catalogItemId: crown },
      dentist.token,
    );
  }

  async function report(
    clinic: Clinic,
    extra: Record<string, string> = {},
  ): Promise<Report> {
    const res = await as(clinic)
      .get('/reports/discounts')
      .query({ from: bogotaDay(-1), to: bogotaDay(1), ...extra })
      .expect(200);
    return res.body as Report;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinicA = await registerClinic(app, 'sec047-informe-a');
    clinicB = await registerClinic(app, 'sec047-informe-b');
    const d = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    dentist = {
      userId: d.userId,
      token: await loginAs(app, clinicA.host, d.email),
    };
    const r = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    reception = {
      userId: r.userId,
      token: await loginAs(app, clinicA.host, r.email),
    };

    crown = await create('/catalog/items', {
      code: 'SEC047-INF',
      kind: CatalogKind.PROCEDURE,
      labelEs: 'Corona de zirconio',
      color: '#2A2B3C',
      defaultPrice: 2000000,
    });
    const surco = await create('/payers', {
      name: 'Surco Salud',
      type: 'PUBLIC_SYSTEM',
    });
    const cortesia = await create('/payers', {
      name: 'Cortesía de la clínica',
      type: 'OTHER',
    });
    const suraAgreement = await create('/agreements', {
      name: 'Surco Salud −25 %',
      payerId: surco,
      kind: 'PERCENT_DISCOUNT',
      percent: 25,
    });
    const cortesiaAgreement = await create('/agreements', {
      name: 'Cortesía socios 100 %',
      payerId: cortesia,
      kind: 'PERCENT_DISCOUNT',
      percent: 100,
    });

    // Recepción registra la cobertura de Surco, el ADMIN la verifica (SEC-049)
    // y recepción asigna el convenio con ella.
    const suraPatient = await createPatient('Surco');
    const coverageId = await create(
      `/patients/${suraPatient}/coverages`,
      { payerId: surco, memberNumber: '1020304050' },
      reception.token,
    );
    await as(clinicA)
      .post(`/patients/${suraPatient}/coverages/${coverageId}/verification`, {
        checkedMemberNumber: '1020304050',
      })
      .expect(200);
    await as(clinicA, reception.token)
      .put(`/patients/${suraPatient}/agreement`, {
        agreementId: suraAgreement,
        coverageId,
      })
      .expect(200);
    suraItem = await itemFor(suraPatient);

    // El ADMIN asigna el de cortesía (solo él puede).
    const cortesiaPatient = await createPatient('Cortesía');
    await as(clinicA)
      .put(`/patients/${cortesiaPatient}/agreement`, {
        agreementId: cortesiaAgreement,
      })
      .expect(200);
    cortesiaItem = await itemFor(cortesiaPatient);

    // Un ítem sin convenio ni descuento: no es una línea del informe.
    plainItem = await itemFor(await createPatient('Sin convenio'));
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('el ítem resuelto por convenio aparece con su rebaja, quién asignó el convenio y quién creó el ítem', async () => {
    const out = await report(clinicA);
    const surco = out.items.find((i) => i.itemId === suraItem);
    expect(surco).toMatchObject({
      patientName: 'Surco Convenio',
      priceSource: 'AGREEMENT_PERCENT',
      agreementName: 'Surco Salud −25 %',
      basePrice: 2000000,
      catalogPrice: 1500000,
      price: 1500000,
      agreementReduction: 500000,
      agreementPercent: 25,
      // La rebaja de convenio no es descuento discrecional: va aparte.
      priceReduction: 0,
      itemDiscount: 0,
      discount: 0,
      percent: 0,
      discountById: null,
      agreementAssignedById: reception.userId,
      agreementAssignedByName: 'Miembro RECEPTION',
      createdById: dentist.userId,
      createdByName: 'Miembro DENTIST',
    });
    const cortesia = out.items.find((i) => i.itemId === cortesiaItem);
    expect(cortesia).toMatchObject({
      agreementName: 'Cortesía socios 100 %',
      basePrice: 2000000,
      price: 0,
      agreementReduction: 2000000,
      agreementPercent: 100,
      agreementAssignedById: clinicA.adminUserId,
      createdById: dentist.userId,
    });
    expect(out.items.map((i) => i.itemId)).not.toContain(plainItem);
    // M1: las líneas solo de convenio no tocan los totales de DX-204; van en
    // los suyos y cuentan para la paginación.
    expect(out.total).toBe(2);
    expect(out.totals).toEqual([]);
    expect(out.agreementTotals).toEqual([
      { currency: 'COP', items: 2, reduction: 2500000 },
    ]);
  });

  it('el ítem guarda quién lo creó', async () => {
    const row = await raw.treatmentPlanItem.findUniqueOrThrow({
      where: { id: suraItem },
      select: { createdById: true },
    });
    expect(row.createdById).toBe(dentist.userId);
  });

  it('el filtro por persona encuentra la rebaja por quien asignó el convenio o creó el ítem', async () => {
    const byReception = await report(clinicA, {
      professionalId: reception.userId,
    });
    expect(byReception.items.map((i) => i.itemId)).toEqual([suraItem]);
    const byDentist = await report(clinicA, {
      professionalId: dentist.userId,
    });
    expect(byDentist.items.map((i) => i.itemId).sort()).toEqual(
      [suraItem, cortesiaItem].sort(),
    );
    const byAdmin = await report(clinicA, {
      professionalId: clinicA.adminUserId,
    });
    expect(byAdmin.items.map((i) => i.itemId)).toEqual([cortesiaItem]);
  });

  it('el CSV lleva el convenio, la rebaja y los dos autores', async () => {
    const res = await as(clinicA)
      .get('/reports/discounts.csv')
      .query({ from: bogotaDay(-1), to: bogotaDay(1) })
      .expect(200);
    const lines = res.text.slice(1).split('\r\n');
    expect(lines[0]).toContain(
      'Convenio,Precio sin convenio,Rebaja por convenio,Convenio asignado por,Ítem creado por',
    );
    const surco = lines.find((l) => l.includes('Surco Salud −25 %'));
    expect(surco).toContain(
      '"Surco Salud −25 %",2000000,500000,"Miembro RECEPTION","Miembro DENTIST"',
    );
    // B5: motivo «Convenio …» y el autor real en «Dado por».
    expect(surco).toContain(
      '"Convenio Surco Salud −25 %","","Miembro RECEPTION"',
    );
  });

  it('otra clínica no ve esas rebajas', async () => {
    const out = await report(clinicB);
    expect(out.items).toEqual([]);
    expect(out.totals).toEqual([]);
  });

  it('B2: una línea solo de convenio de un plan sin presentar toma la sede con la que se resolvió el precio', async () => {
    const locations = await as(clinicA).get('/locations').expect(200);
    const main = (locations.body as { id: string }[])[0].id;
    const north = (
      await as(clinicA)
        .post(
          '/locations',
          locationBody(REGIONAL_BOGOTA_FIXTURE, { name: 'Sede Norte' }),
        )
        .expect(201)
    ).body as { id: string };
    const all = await report(clinicA);
    expect(all.items.find((i) => i.itemId === suraItem)?.locationId).toBe(main);
    const inMain = await report(clinicA, { locationId: main });
    expect(inMain.items.map((i) => i.itemId)).toContain(suraItem);
    const inNorth = await report(clinicA, { locationId: north.id });
    expect(inNorth.items.map((i) => i.itemId)).not.toContain(suraItem);
  });

  it('M1: los totales de descuentos de un periodo no cambian al añadir un ítem solo de convenio', async () => {
    // Un descuento discrecional del ADMIN en un paciente sin convenio.
    const patient = await createPatient('Descuento');
    const plan = await create(`/patients/${patient}/treatment-plans`, {
      currency: 'COP',
    });
    await create(`/treatment-plans/${plan}/items`, {
      toothNumber: '11',
      catalogItemId: crown,
      price: 2000000,
      discount: 200000,
      discountReason: 'PROMOTION',
    });
    const before = await report(clinicA);
    expect(before.totals).toEqual([
      {
        currency: 'COP',
        items: 1,
        gross: 2000000,
        discount: 200000,
        percentOfGross: 10,
      },
    ]);

    // Otro ítem solo de convenio para el paciente de Surco.
    const suraPatient = await raw.treatmentPlanItem.findUniqueOrThrow({
      where: { id: suraItem },
      select: { patientId: true },
    });
    await itemFor(suraPatient.patientId);
    const after = await report(clinicA);
    expect(after.totals).toEqual(before.totals);
    expect(after.total).toBe(before.total + 1);
    expect(after.agreementTotals).toEqual([
      {
        currency: 'COP',
        items: before.agreementTotals[0].items + 1,
        reduction: before.agreementTotals[0].reduction + 500000,
      },
    ]);
    // Con el filtro por persona, los totales de DX-204 son los de quien dio
    // el descuento: el DENTIST solo creó ítems de convenio.
    const byDentist = await report(clinicA, {
      professionalId: dentist.userId,
    });
    expect(byDentist.totals).toEqual([]);
    const byAdmin = await report(clinicA, {
      professionalId: clinicA.adminUserId,
    });
    expect(byAdmin.totals).toEqual(before.totals);
  });
});
