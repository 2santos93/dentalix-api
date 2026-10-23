import { INestApplication } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  DocType,
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

// DX-105 en HTTP real: el precio de un ítem nuevo se resuelve en el servidor
// (convenio vigente del paciente → lista activa de la sede del request →
// precio de catálogo), queda como referencia (`catalogPrice`, R1) con su foto
// inmutable, las alternativas la copian, las prestaciones sin descuentos no
// admiten rebajas y `price-quote` da lo mismo que el alta.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Item {
  id: string;
  catalogItemId: string;
  catalogPrice: number | null;
  price: number;
  discount: number;
  discountById: string | null;
  basePrice: number | null;
  priceSource: string | null;
  agreementId: string | null;
  agreementName: string | null;
  pricingLocationId: string | null;
}

interface Quote {
  basePrice: number | null;
  price: number | null;
  source: string;
  agreementId: string | null;
  agreementName: string | null;
  allowDiscount: boolean;
  currency: string;
}

const NO_DISCOUNT = 'Esta prestación no admite descuentos.';
const PRICE_REQUIRED = 'Este procedimiento no tiene precio; indícalo.';

/** `YYYY-MM-DD` a `days` días de hoy (UTC); ±2 evita el borde de la zona. */
function dayFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('Precio resuelto y foto en el ítem del plan (e2e, DX-105)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let dentistToken: string;
  let mainLocation: string;
  let northLocation: string;
  let payer: string;
  /** Endodoncia (categoría «Endodoncia»), 100 000. */
  let endo: string;
  /** Radiografía: 50 000, sin descuentos. */
  let xray: string;
  /** Sin precio de catálogo. */
  let free: string;
  let agreementListId: string;

  const as = (token = clinic.adminToken, location?: string) => {
    const call =
      (verb: 'get' | 'post' | 'patch' | 'put' | 'delete') =>
      (path: string, body?: object) => {
        const req = request(app.getHttpServer())
          [verb](`/api/v1${path}`)
          .set('X-Tenant-Host', clinic.host)
          .set('Authorization', `Bearer ${token}`);
        if (location) req.set('X-Location-Id', location);
        return body === undefined ? req : req.send(body);
      };
    return {
      get: call('get'),
      post: call('post'),
      patch: call('patch'),
      put: call('put'),
      delete: call('delete'),
    };
  };

  async function create(path: string, body: object): Promise<string> {
    const res = await as().post(path, body).expect(201);
    return (res.body as { id: string }).id;
  }

  const createPatient = (firstName: string) =>
    create('/patients', {
      firstName,
      lastName: 'Convenio',
      docType: DocType.CC,
      docNumber: String(Math.floor(Math.random() * 1e9)),
      sex: Sex.F,
    });

  const createAgreement = (name: string, extra: object) =>
    create('/agreements', { name, payerId: payer, ...extra });

  /**
   * SEC-047: un convenio de pagador exige una cobertura viva del paciente con
   * ese pagador; se reutiliza la que ya tenga o se le añade.
   */
  async function assign(patientId: string, body: object): Promise<void> {
    const listed = await as()
      .get(`/patients/${patientId}/coverages`)
      .expect(200);
    const coverageId =
      (listed.body as { id: string; payer: { id: string } }[]).find(
        (c) => c.payer.id === payer,
      )?.id ??
      (await create(`/patients/${patientId}/coverages`, { payerId: payer }));
    await as()
      .put(`/patients/${patientId}/agreement`, { coverageId, ...body })
      .expect(200);
  }

  async function newPlan(patientId: string, currency = 'COP'): Promise<string> {
    return create(`/patients/${patientId}/treatment-plans`, { currency });
  }

  function addItem(
    planId: string,
    catalogItemId: string,
    extra: object = {},
    location?: string,
    token?: string,
  ) {
    return as(token, location).post(`/treatment-plans/${planId}/items`, {
      toothNumber: '36',
      catalogItemId,
      ...extra,
    });
  }

  async function added(
    planId: string,
    catalogItemId: string,
    extra: object = {},
    location?: string,
  ): Promise<Item> {
    const res = await addItem(planId, catalogItemId, extra, location).expect(
      201,
    );
    return res.body as Item;
  }

  async function planItems(planId: string): Promise<Item[]> {
    const res = await as().get(`/treatment-plans/${planId}`).expect(200);
    return (res.body as { items: Item[] }).items;
  }

  async function quote(
    patientId: string,
    catalogItemId: string,
    currency = 'COP',
    location?: string,
  ): Promise<Quote> {
    const res = await as(dentistToken, location)
      .get(
        `/patients/${patientId}/price-quote?catalogItemId=${catalogItemId}&currency=${currency}`,
      )
      .expect(200);
    return res.body as Quote;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx105-pricing');
    const dentist = await seedMember(raw, clinic, ClinicRole.DENTIST);
    dentistToken = await loginAs(app, clinic.host, dentist.email);

    const locations = await as().get('/locations').expect(200);
    mainLocation = (locations.body as { id: string }[])[0].id;
    northLocation = await create('/locations', { name: 'Sede Norte' });

    endo = await create('/catalog/items', {
      code: 'PR-ENDO',
      kind: CatalogKind.PROCEDURE,
      labelEs: 'Endodoncia unirradicular',
      category: 'Endodoncia',
      color: '#2A2B3C',
      defaultPrice: 100000,
    });
    xray = await create('/catalog/items', {
      code: 'PR-RX',
      kind: CatalogKind.PROCEDURE,
      labelEs: 'Radiografía periapical',
      category: 'Diagnóstico',
      color: '#2A2B3C',
      defaultPrice: 50000,
      allowDiscount: false,
    });
    free = await create('/catalog/items', {
      code: 'PR-LIBRE',
      kind: CatalogKind.PROCEDURE,
      labelEs: 'Procedimiento libre',
      color: '#2A2B3C',
    });

    payer = await create('/payers', {
      name: 'Sura',
      type: 'EPS_CO',
      country: 'CO',
    });

    // Lista de la Sede Norte (COP): la endodoncia a 90 000.
    const northList = await create('/price-lists', {
      name: 'Lista Sede Norte',
      currency: 'COP',
      locationId: northLocation,
    });
    await as()
      .put(`/price-lists/${northList}/items`, {
        items: [{ catalogItemId: endo, price: 90000 }],
      })
      .expect(200);

    // Lista de toda la clínica (sin sede) para un convenio de lista: no se
    // usa en la resolución automática salvo vía convenio (R7).
    agreementListId = await create('/price-lists', {
      name: 'Lista Empresa X',
      currency: 'COP',
    });
    await as()
      .put(`/price-lists/${agreementListId}/items`, {
        items: [
          { catalogItemId: endo, price: 60000 },
          { catalogItemId: xray, price: 30000 },
        ],
      })
      .expect(200);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('sin convenio', () => {
    let patient: string;
    beforeAll(async () => {
      patient = await createPatient('Sin');
    });

    it('sede sin lista: precio de catálogo, foto CATALOG con la sede', async () => {
      const plan = await newPlan(patient);
      const item = await added(plan, endo, {}, mainLocation);
      expect(item).toMatchObject({
        price: 100000,
        catalogPrice: 100000,
        basePrice: 100000,
        priceSource: 'CATALOG',
        agreementId: null,
        agreementName: null,
        pricingLocationId: mainLocation,
      });
    });

    it('lista activa de la sede del request: PRICE_LIST, y no cuenta como descuento', async () => {
      const plan = await newPlan(patient);
      const item = await added(plan, endo, {}, northLocation);
      expect(item).toMatchObject({
        price: 90000,
        catalogPrice: 90000,
        basePrice: 100000,
        priceSource: 'PRICE_LIST',
        pricingLocationId: northLocation,
        discount: 0,
        discountById: null,
      });
    });

    it('lista de la sede en otra moneda que el plan: se ignora (R12)', async () => {
      const plan = await newPlan(patient, 'USD');
      const item = await added(plan, endo, {}, northLocation);
      expect(item).toMatchObject({ price: 100000, priceSource: 'CATALOG' });
    });

    it('sin precio en ningún sitio y sin `price`: 400 en español', async () => {
      const plan = await newPlan(patient);
      const res = await addItem(plan, free).expect(400);
      expect((res.body as { message: string }).message).toBe(PRICE_REQUIRED);
      // Con precio explícito se crea, sin referencia.
      const item = await added(plan, free, { price: 20000 });
      expect(item).toMatchObject({
        price: 20000,
        catalogPrice: null,
        basePrice: null,
        priceSource: 'CATALOG',
      });
    });
  });

  describe('convenio por porcentaje', () => {
    let patient: string;
    let sura: string;
    beforeAll(async () => {
      patient = await createPatient('Porcentaje');
      sura = await createAgreement('Sura EPS', {
        kind: 'PERCENT_DISCOUNT',
        percent: 15,
      });
      await assign(patient, { agreementId: sura });
    });

    it('% general: 100 000 − 15 % = 85 000, con convenio en la foto; gana a la lista de la sede', async () => {
      const plan = await newPlan(patient);
      const item = await added(plan, endo, {}, northLocation);
      expect(item).toMatchObject({
        price: 85000,
        catalogPrice: 85000,
        basePrice: 100000,
        priceSource: 'AGREEMENT_PERCENT',
        agreementId: sura,
        agreementName: 'Sura EPS',
        pricingLocationId: northLocation,
        discountById: null,
      });
    });

    it('price-quote da lo mismo que el alta', async () => {
      const plan = await newPlan(patient);
      const item = await added(plan, endo, {}, mainLocation);
      const q = await quote(patient, endo, 'COP', mainLocation);
      expect(q).toEqual({
        basePrice: item.basePrice,
        price: item.catalogPrice,
        source: item.priceSource,
        agreementId: item.agreementId,
        agreementName: item.agreementName,
        allowDiscount: true,
        currency: 'COP',
      });
    });

    it('precio explícito por debajo del pactado: la rebaja se mide contra la referencia (R1)', async () => {
      const plan = await newPlan(patient);
      // 85 000 → 80 000 = 5,9 %: dentro del 10 % del DENTIST.
      const ok = await addItem(
        plan,
        endo,
        { price: 80000 },
        undefined,
        dentistToken,
      ).expect(201);
      expect(ok.body as Item).toMatchObject({
        price: 80000,
        catalogPrice: 85000,
        priceSource: 'AGREEMENT_PERCENT',
      });
      expect((ok.body as Item).discountById).not.toBeNull();
      // 85 000 → 75 000 = 11,8 %: pasa el tope del DENTIST.
      await addItem(
        plan,
        endo,
        { price: 75000 },
        undefined,
        dentistToken,
      ).expect(403);
    });

    it('prestación sin descuentos: el % no aplica (precio de catálogo) y no admite rebaja', async () => {
      const plan = await newPlan(patient);
      const item = await added(plan, xray);
      expect(item).toMatchObject({
        price: 50000,
        catalogPrice: 50000,
        priceSource: 'CATALOG',
        agreementId: null,
      });
      const q = await quote(patient, xray);
      expect(q).toMatchObject({ source: 'CATALOG', allowDiscount: false });

      for (const extra of [{ discount: 1000 }, { price: 45000 }]) {
        const res = await addItem(plan, xray, extra).expect(400);
        expect((res.body as { message: string }).message).toBe(NO_DISCOUNT);
      }
      const patched = await as()
        .patch(`/treatment-plans/${plan}/items/${item.id}`, { discount: 500 })
        .expect(400);
      expect((patched.body as { message: string }).message).toBe(NO_DISCOUNT);
      expect(await planItems(plan)).toHaveLength(1);
      expect((await planItems(plan))[0].discount).toBe(0);
    });

    it('«Descuento %» salta la prestación sin descuentos y lo dice', async () => {
      const plan = await newPlan(patient);
      const a = await added(plan, endo);
      const b = await added(plan, xray);
      const res = await as()
        .post(`/treatment-plans/${plan}/items/bulk-discount`, {
          itemIds: [a.id, b.id],
          percent: 5,
        })
        .expect(200);
      const body = res.body as { items: Item[]; skippedNoDiscount: number };
      expect(body.skippedNoDiscount).toBe(1);
      expect(body.items.map((i) => [i.id, i.discount])).toEqual([[a.id, 4250]]);
      const after = new Map((await planItems(plan)).map((i) => [i.id, i]));
      expect(after.get(b.id)!.discount).toBe(0);
    });

    it('cambiar el convenio no re-precia los ítems existentes; los nuevos usan el nuevo (R4)', async () => {
      const plan = await newPlan(patient);
      const before = await added(plan, endo);
      expect(before.price).toBe(85000);
      await as().patch(`/agreements/${sura}`, { percent: 40 }).expect(200);
      try {
        const [kept] = await planItems(plan);
        expect(kept).toMatchObject({
          price: 85000,
          catalogPrice: 85000,
          agreementName: 'Sura EPS',
        });
        const fresh = await added(plan, endo);
        expect(fresh).toMatchObject({ price: 60000, catalogPrice: 60000 });
      } finally {
        await as().patch(`/agreements/${sura}`, { percent: 15 }).expect(200);
      }
    });

    it('la alternativa copia la foto, no la re-resuelve', async () => {
      const plan = await newPlan(patient);
      const source = await added(plan, endo, {}, northLocation);
      // El paciente se queda sin convenio: re-resolver daría otro precio.
      await as().delete(`/patients/${patient}/agreement`).expect(204);
      try {
        const alt = await create(`/treatment-plans/${plan}/alternatives`, {});
        const [copy] = await planItems(alt);
        expect(copy).toMatchObject({
          price: source.price,
          catalogPrice: source.catalogPrice,
          basePrice: source.basePrice,
          priceSource: 'AGREEMENT_PERCENT',
          agreementId: sura,
          agreementName: 'Sura EPS',
          pricingLocationId: northLocation,
        });
      } finally {
        await assign(patient, { agreementId: sura });
      }
    });
  });

  describe('convenio por categoría, de lista, de sede y vigencia', () => {
    it('% por categoría (comparada normalizada): gana al general', async () => {
      const patient = await createPatient('Categoria');
      const agreement = await createAgreement('Empresa Cat', {
        kind: 'PERCENT_DISCOUNT',
        percent: 10,
        percentByCategory: { Endodoncia: 30 },
      });
      await assign(patient, { agreementId: agreement });
      const plan = await newPlan(patient);
      expect(await added(plan, endo)).toMatchObject({
        price: 70000,
        priceSource: 'AGREEMENT_PERCENT',
      });
    });

    it('lista del convenio: precio pactado, también en una prestación sin descuentos', async () => {
      const patient = await createPatient('Lista');
      const agreement = await createAgreement('Empresa X', {
        kind: 'PRICE_LIST',
        priceListId: agreementListId,
      });
      await assign(patient, { agreementId: agreement });
      const plan = await newPlan(patient);
      expect(await added(plan, endo)).toMatchObject({
        price: 60000,
        catalogPrice: 60000,
        basePrice: 100000,
        priceSource: 'AGREEMENT_PRICE_LIST',
        agreementName: 'Empresa X',
        discountById: null,
      });
      expect(await added(plan, xray)).toMatchObject({
        price: 30000,
        priceSource: 'AGREEMENT_PRICE_LIST',
      });
      // Lista del convenio en COP y plan en USD: no aplica (R12).
      const usd = await newPlan(patient, 'USD');
      expect(await added(usd, endo)).toMatchObject({
        price: 100000,
        priceSource: 'CATALOG',
      });
      expect(await quote(patient, endo, 'USD')).toMatchObject({
        source: 'CATALOG',
        currency: 'USD',
      });
    });

    it('convenio de otra sede: no aplica; en su sede, sí', async () => {
      const patient = await createPatient('Sede');
      const agreement = await createAgreement('Convenio Norte', {
        kind: 'PERCENT_DISCOUNT',
        percent: 20,
        locationId: northLocation,
      });
      await assign(patient, { agreementId: agreement });
      const plan = await newPlan(patient);
      expect(await added(plan, endo, {}, mainLocation)).toMatchObject({
        price: 100000,
        priceSource: 'CATALOG',
      });
      expect(await added(plan, endo, {}, northLocation)).toMatchObject({
        price: 80000,
        priceSource: 'AGREEMENT_PERCENT',
        pricingLocationId: northLocation,
      });
    });

    it('asignación vencida: el convenio no aplica', async () => {
      const patient = await createPatient('Vencida');
      const agreement = await createAgreement('Convenio Viejo', {
        kind: 'PERCENT_DISCOUNT',
        percent: 25,
      });
      await assign(patient, {
        agreementId: agreement,
        validFrom: dayFromNow(-30),
        validTo: dayFromNow(-2),
      });
      const plan = await newPlan(patient);
      expect(await added(plan, endo, {}, mainLocation)).toMatchObject({
        price: 100000,
        priceSource: 'CATALOG',
      });
    });
  });

  describe('price-quote', () => {
    it('valida la consulta y responde 404 si el procedimiento no existe', async () => {
      const patient = await createPatient('Consulta');
      await as(dentistToken)
        .get(`/patients/${patient}/price-quote?catalogItemId=x&currency=COP`)
        .expect(400);
      await as(dentistToken)
        .get(
          `/patients/${patient}/price-quote?catalogItemId=${endo}&currency=PESOS`,
        )
        .expect(400);
      await as(dentistToken)
        .get(
          `/patients/${patient}/price-quote?catalogItemId=00000000-0000-4000-8000-000000000000&currency=COP`,
        )
        .expect(404);
      const res = await as(dentistToken)
        .get(
          `/patients/00000000-0000-4000-8000-000000000000/price-quote?catalogItemId=${endo}&currency=COP`,
        )
        .expect(404);
      expect((res.body as { message: string }).message).toBe(
        'Paciente no encontrado.',
      );
    });
  });
});
