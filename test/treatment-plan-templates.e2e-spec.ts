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
  REGIONAL_CARACAS_FIXTURE,
  locationBody,
} from './support/location-fixtures';

// DX-559 en HTTP real: plantillas de plan de tratamiento. El CRUD es solo de
// ADMIN (y recepción ni la lee); aplicarla crea ítems normales con el precio
// VIGENTE del paciente (lista de la sede, convenio), en sus visitas y con sus
// intervalos, detrás de lo que el plan ya tenga; un procedimiento desactivado
// se omite; un plan aceptado o cancelado no la admite; y editar la plantilla
// no toca un plan ya creado. Clínica de Venezuela con el catálogo en USD: no
// hace falta sembrar tasas de cambio.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Line {
  id: string;
  catalogItemId: string;
  catalogItemActive: boolean;
}

interface Template {
  id: string;
  version: number;
  active: boolean;
  lines: Line[];
}

interface Item {
  id: string;
  catalogItemId: string;
  toothNumber: string;
  surfaces: string[];
  visit: number;
  visitLabel: string | null;
  price: number;
  discount: number;
  catalogPrice: number | null;
  priceSource: string | null;
  agreementName: string | null;
  pricingLocationId: string | null;
}

interface PreviewLine {
  lineId: string;
  targetVisit: number | null;
  unitPrice: number | null;
  priceSource: string | null;
  lineTotal: number | null;
  skipped: string | null;
  priceMissing: boolean;
}

interface Preview {
  lines: PreviewLine[];
  total: number;
  itemCount: number;
  visitOffset: number;
  visitIntervals: Record<string, number>;
  currency: string;
}

interface Application {
  createdItems: Item[];
  skipped: { lineId: string; reason: string }[];
  plan: {
    id: string;
    items: Item[];
    total: number;
    visitIntervals: Record<string, number>;
  };
}

describe('Plantillas de plan de tratamiento (e2e, DX-559)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  const tokens: Partial<Record<ClinicRole, string>> = {};
  let mainLocation: string;
  let caracasLocation: string;
  let payer: string;
  /** Endodoncia (categoría «Endodoncia»), 120 USD. */
  let endo: string;
  /** Perno, 40 USD. */
  let post: string;
  /** Corona, 250 USD. */
  let crown: string;
  /** Amalgama, desactivada en el catálogo. */
  let amalgam: string;

  const as = (token = clinic.adminToken, location?: string) => {
    const call =
      (verb: 'get' | 'post' | 'patch' | 'put') =>
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
    };
  };

  async function create(path: string, body: object): Promise<string> {
    const res = await as().post(path, body).expect(201);
    return (res.body as { id: string }).id;
  }

  const createPatient = (firstName: string) =>
    create('/patients', {
      firstName,
      lastName: 'Plantilla',
      docType: 'NATIONAL_ID',
      docNumber: String(Math.floor(Math.random() * 1e9)),
      sex: Sex.F,
    });

  const newPlan = (patientId: string) =>
    create(`/patients/${patientId}/treatment-plans`, { currency: 'USD' });

  async function endoCrown(name = 'Endodoncia + corona'): Promise<Template> {
    const res = await as()
      .post('/treatment-plan-templates', {
        name,
        visitIntervals: { '2': 7, '3': 14 },
        lines: [
          { catalogItemId: endo, visit: 1, visitLabel: 'Conductometría' },
          { catalogItemId: post, visit: 2 },
          { catalogItemId: crown, visit: 3, asksSurfaces: true },
        ],
      })
      .expect(201);
    return res.body as Template;
  }

  const apply = (
    planId: string,
    body: object,
    token?: string,
    location?: string,
  ) =>
    as(token, location).post(`/treatment-plans/${planId}/apply-template`, body);

  const preview = (planId: string, templateId: string, location?: string) =>
    as(tokens.DENTIST, location).post(
      `/treatment-plans/${planId}/apply-template/preview`,
      { templateId },
    );

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx559-plantillas');
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
    // El catálogo en USD, como los planes: el precio no necesita tasa.
    await as()
      .patch('/clinic/settings', { catalogCurrency: 'USD' })
      .expect(200);
    const locations = await as().get('/locations').expect(200);
    mainLocation = (locations.body as { id: string }[])[0].id;
    caracasLocation = await create(
      '/locations',
      locationBody(REGIONAL_CARACAS_FIXTURE, { name: 'Sede Chacao' }),
    );

    const procedure = (code: string, labelEs: string, defaultPrice: number) =>
      create('/catalog/items', {
        code,
        kind: CatalogKind.PROCEDURE,
        labelEs,
        category: 'Endodoncia',
        color: '#2A2B3C',
        defaultPrice,
      });
    endo = await procedure('DX559-ENDO', 'Endodoncia unirradicular', 120);
    post = await procedure('DX559-PERNO', 'Perno de fibra', 40);
    crown = await procedure('DX559-CORONA', 'Corona de zirconio', 250);
    amalgam = await procedure('DX559-AMALGAMA', 'Amalgama', 30);
    await as()
      .patch(`/catalog/items/${amalgam}`, { active: false })
      .expect(200);

    // Lista de la Sede Chacao en USD: la endodoncia a 100.
    const list = await create('/price-lists', {
      name: 'Lista Chacao',
      currency: 'USD',
      locationId: caracasLocation,
    });
    await as()
      .put(`/price-lists/${list}/items`, {
        items: [{ catalogItemId: endo, price: 100 }],
      })
      .expect(200);

    payer = await create('/payers', { name: 'Seguro Ávila', type: 'INSURER' });
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('CRUD solo de ADMIN', () => {
    it('ADMIN crea, lee, edita y desactiva; sin DELETE', async () => {
      const template = await endoCrown('Gestión');
      expect(template).toMatchObject({ active: true, version: 1 });
      expect(template.lines).toHaveLength(3);

      const read = await as(tokens.DENTIST)
        .get(`/treatment-plan-templates/${template.id}`)
        .expect(200);
      expect((read.body as Template).lines.map((l) => l.catalogItemId)).toEqual(
        [endo, post, crown],
      );

      const updated = await as()
        .patch(`/treatment-plan-templates/${template.id}`, {
          active: false,
          version: 1,
        })
        .expect(200);
      expect(updated.body as Template).toMatchObject({
        active: false,
        version: 2,
      });
      const stale = await as()
        .patch(`/treatment-plan-templates/${template.id}`, {
          name: 'Otra',
          version: 1,
        })
        .expect(409);
      expect(stale.body).toMatchObject({ code: 'PLAN_TEMPLATE_STALE' });

      const actives = await as(tokens.ASSISTANT)
        .get('/treatment-plan-templates')
        .expect(200);
      expect((actives.body as Template[]).map((t) => t.id)).not.toContain(
        template.id,
      );
      const all = await as()
        .get('/treatment-plan-templates?includeInactive=true')
        .expect(200);
      expect((all.body as Template[]).map((t) => t.id)).toContain(template.id);

      await request(app.getHttpServer())
        .delete(`/api/v1/treatment-plan-templates/${template.id}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`)
        .expect(404);
    });

    it('DENTIST, ASSISTANT y RECEPTION no escriben (403); RECEPTION tampoco lee', async () => {
      const template = await endoCrown('Permisos');
      for (const role of [
        ClinicRole.DENTIST,
        ClinicRole.ASSISTANT,
        ClinicRole.RECEPTION,
      ]) {
        await as(tokens[role])
          .post('/treatment-plan-templates', {
            name: `De ${role}`,
            lines: [{ catalogItemId: endo }],
          })
          .expect(403);
        await as(tokens[role])
          .patch(`/treatment-plan-templates/${template.id}`, {
            active: false,
            version: 1,
          })
          .expect(403);
      }
      await as(tokens.RECEPTION).get('/treatment-plan-templates').expect(403);
      await as(tokens.RECEPTION)
        .get(`/treatment-plan-templates/${template.id}`)
        .expect(403);
      // Recepción tampoco aplica.
      const plan = await newPlan(await createPatient('Recepción'));
      await apply(
        plan,
        { templateId: template.id, toothNumber: '36' },
        tokens.RECEPTION,
      ).expect(403);
    });

    it('nombre repetido (sin mayúsculas): 409 en español; un diagnóstico: 422', async () => {
      await endoCrown('Repetida');
      const dup = await as()
        .post('/treatment-plan-templates', {
          name: 'REPETIDA',
          lines: [{ catalogItemId: endo }],
        })
        .expect(409);
      expect(dup.body).toMatchObject({
        code: 'PLAN_TEMPLATE_DUPLICATE_NAME',
        message: 'Ya existe una plantilla de plan con ese nombre.',
      });
      const caries = await create('/catalog/items', {
        code: 'DX559-CARIES',
        kind: CatalogKind.DIAGNOSIS,
        labelEs: 'Caries',
        color: '#2A2B3C',
      });
      const diagnosis = await as()
        .post('/treatment-plan-templates', {
          name: 'Con diagnóstico',
          lines: [{ catalogItemId: caries }],
        })
        .expect(422);
      expect(diagnosis.body).toMatchObject({
        code: 'PLAN_TEMPLATE_NOT_A_PROCEDURE',
        position: 0,
      });
    });
  });

  describe('aplicar', () => {
    it('«Endodoncia + corona» en un plan vacío: visitas 1, 2 y 3 con sus intervalos, precio de catálogo, sin descuento y auditado', async () => {
      const template = await endoCrown('Vacío');
      const plan = await newPlan(await createPatient('Vacío'));

      const shown = await preview(plan, template.id, mainLocation).expect(200);
      expect(shown.body as Preview).toMatchObject({
        currency: 'USD',
        visitOffset: 0,
        itemCount: 3,
        total: 410,
        visitIntervals: { '2': 7, '3': 14 },
      });

      const res = await apply(
        plan,
        {
          templateId: template.id,
          toothNumber: '36',
          lines: [
            {
              lineId: template.lines[2].id,
              toothNumber: '46',
              surfaces: ['OCCLUSAL'],
            },
          ],
        },
        tokens.DENTIST,
        mainLocation,
      ).expect(201);
      const body = res.body as Application;
      expect(
        body.createdItems.map((i) => [
          i.catalogItemId,
          i.visit,
          i.visitLabel,
          i.toothNumber,
          i.surfaces,
          i.price,
          i.discount,
          i.priceSource,
        ]),
      ).toEqual([
        [endo, 1, 'Conductometría', '36', [], 120, 0, 'CATALOG'],
        [post, 2, null, '36', [], 40, 0, 'CATALOG'],
        [crown, 3, null, '46', ['OCCLUSAL'], 250, 0, 'CATALOG'],
      ]);
      expect(body.skipped).toEqual([]);
      expect(body.plan).toMatchObject({
        id: plan,
        total: 410,
        visitIntervals: { '2': 7, '3': 14 },
      });
      expect(body.plan.items).toHaveLength(3);

      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'TREATMENT_PLAN',
          resourceId: plan,
          action: 'UPDATE',
        },
        select: { metadata: true, patientId: true, actorUserId: true },
      });
      expect(events.map((e) => e.metadata)).toEqual([
        {
          reason: 'PLAN_TEMPLATE_APPLIED',
          params: { templateId: template.id, itemsCreated: '3' },
        },
      ]);
      expect(events[0].patientId).not.toBeNull();
    });

    it('el precio es el de hoy para el paciente: lista de la sede y convenio, no uno guardado', async () => {
      const template = await endoCrown('Precios');
      const patient = await createPatient('Convenio');

      // Sede Chacao sin convenio: la endodoncia sale de su lista (100).
      const planList = await newPlan(patient);
      const fromList = await preview(
        planList,
        template.id,
        caracasLocation,
      ).expect(200);
      expect((fromList.body as Preview).lines[0]).toMatchObject({
        unitPrice: 100,
        priceSource: 'PRICE_LIST',
      });
      const listed = await apply(
        planList,
        { templateId: template.id, toothNumber: '36' },
        tokens.DENTIST,
        caracasLocation,
      ).expect(201);
      expect((listed.body as Application).createdItems[0]).toMatchObject({
        price: 100,
        catalogPrice: 100,
        priceSource: 'PRICE_LIST',
        pricingLocationId: caracasLocation,
        discount: 0,
      });

      // Ahora el paciente tiene un convenio del 10 %: la misma plantilla
      // aplicada después toma el precio pactado.
      const agreement = await create('/agreements', {
        name: 'Seguro Ávila Plus',
        payerId: payer,
        kind: 'PERCENT_DISCOUNT',
        percent: 10,
      });
      const coverage = await create(`/patients/${patient}/coverages`, {
        payerId: payer,
        memberNumber: 'AV-0001',
      });
      await as()
        .put(`/patients/${patient}/agreement`, {
          coverageId: coverage,
          agreementId: agreement,
        })
        .expect(200);
      const planAgreement = await newPlan(patient);
      const agreed = await apply(
        planAgreement,
        { templateId: template.id, toothNumber: '36' },
        tokens.DENTIST,
        mainLocation,
      ).expect(201);
      expect(
        (agreed.body as Application).createdItems.map((i) => [
          i.price,
          i.priceSource,
          i.agreementName,
          i.discount,
        ]),
      ).toEqual([
        [108, 'AGREEMENT_PERCENT', 'Seguro Ávila Plus', 0],
        [36, 'AGREEMENT_PERCENT', 'Seguro Ávila Plus', 0],
        [225, 'AGREEMENT_PERCENT', 'Seguro Ávila Plus', 0],
      ]);
    });

    it('con visitas ya en el plan, se desplaza detrás de la última y no pisa sus intervalos', async () => {
      const template = await endoCrown('Desplazada');
      const plan = await newPlan(await createPatient('Desplazada'));
      const first = await as()
        .post(`/treatment-plans/${plan}/items`, {
          toothNumber: '11',
          catalogItemId: post,
        })
        .expect(201);
      const second = await as()
        .post(`/treatment-plans/${plan}/items`, {
          toothNumber: '12',
          catalogItemId: post,
        })
        .expect(201);
      await as()
        .patch(`/treatment-plans/${plan}/visits`, {
          items: [
            { itemId: (first.body as Item).id, visit: 1 },
            { itemId: (second.body as Item).id, visit: 2 },
          ],
          visitIntervals: { '2': 30, '4': 3 },
        })
        .expect(200);

      const res = await apply(
        plan,
        { templateId: template.id, toothNumber: '36' },
        tokens.ASSISTANT,
      ).expect(201);
      const body = res.body as Application;
      expect(body.createdItems.map((i) => i.visit)).toEqual([3, 4, 5]);
      expect(body.plan.visitIntervals).toEqual({ '2': 30, '4': 3, '5': 14 });
    });

    it('un procedimiento desactivado se omite y se lista en `skipped`; sin ninguno aplicable, 422', async () => {
      const res = await as()
        .post('/treatment-plan-templates', {
          name: 'Con inactivo',
          lines: [
            { catalogItemId: endo, visit: 1 },
            { catalogItemId: amalgam, visit: 1 },
          ],
        })
        .expect(201);
      const template = res.body as Template;
      expect(template.lines[1].catalogItemActive).toBe(false);
      const plan = await newPlan(await createPatient('Inactivo'));
      const shown = await preview(plan, template.id).expect(200);
      expect((shown.body as Preview).lines[1]).toMatchObject({
        skipped: 'CATALOG_ITEM_INACTIVE',
        targetVisit: null,
      });
      const applied = await apply(plan, {
        templateId: template.id,
        toothNumber: '36',
      }).expect(201);
      const body = applied.body as Application;
      expect(body.createdItems.map((i) => i.catalogItemId)).toEqual([endo]);
      expect(body.skipped).toEqual([
        {
          ...body.skipped[0],
          lineId: template.lines[1].id,
          reason: 'CATALOG_ITEM_INACTIVE',
        },
      ]);

      const only = await as()
        .post('/treatment-plan-templates', {
          name: 'Solo inactivo',
          lines: [{ catalogItemId: amalgam }],
        })
        .expect(201);
      const none = await apply(plan, {
        templateId: (only.body as Template).id,
        toothNumber: '36',
      }).expect(422);
      expect(none.body).toMatchObject({
        code: 'PLAN_TEMPLATE_NOTHING_TO_APPLY',
      });
    });

    it('sin diente: 400 con la línea y no se crea nada', async () => {
      const template = await endoCrown('Sin diente');
      const plan = await newPlan(await createPatient('Sin diente'));
      const res = await apply(plan, {
        templateId: template.id,
        lines: [{ lineId: template.lines[0].id, toothNumber: '36' }],
      }).expect(400);
      expect(res.body).toMatchObject({
        code: 'PLAN_TEMPLATE_TOOTH_REQUIRED',
        lineId: template.lines[1].id,
      });
      const detail = await as().get(`/treatment-plans/${plan}`).expect(200);
      expect((detail.body as { items: Item[] }).items).toEqual([]);
    });

    it('un plan aceptado o cancelado: 409 con el estado y nada entra', async () => {
      const template = await endoCrown('Cerrados');
      const patient = await createPatient('Cerrados');
      for (const status of ['ACCEPTED', 'CANCELLED'] as const) {
        const plan = await newPlan(patient);
        await as()
          .post(`/treatment-plans/${plan}/items`, {
            toothNumber: '11',
            catalogItemId: post,
          })
          .expect(201);
        await as().patch(`/treatment-plans/${plan}`, { status }).expect(200);
        const res = await apply(
          plan,
          { templateId: template.id, toothNumber: '36' },
          tokens.DENTIST,
        ).expect(409);
        expect(res.body).toMatchObject({
          code: 'PLAN_TEMPLATE_PLAN_NOT_EDITABLE',
          status,
        });
        expect((res.body as { message: string }).message).toMatch(
          status === 'ACCEPTED' ? /aceptado/ : /cancelado/,
        );
        const detail = await as().get(`/treatment-plans/${plan}`).expect(200);
        expect((detail.body as { items: Item[] }).items).toHaveLength(1);
      }
    });

    it('una plantilla desactivada: 409', async () => {
      const template = await endoCrown('Desactivada');
      await as()
        .patch(`/treatment-plan-templates/${template.id}`, {
          active: false,
          version: 1,
        })
        .expect(200);
      const plan = await newPlan(await createPatient('Desactivada'));
      const res = await apply(plan, {
        templateId: template.id,
        toothNumber: '36',
      }).expect(409);
      expect(res.body).toMatchObject({ code: 'PLAN_TEMPLATE_INACTIVE' });
    });

    it('editar la plantilla después no cambia el plan ya creado', async () => {
      const template = await endoCrown('Inmutable');
      const plan = await newPlan(await createPatient('Inmutable'));
      await apply(plan, { templateId: template.id, toothNumber: '36' }).expect(
        201,
      );
      await as()
        .patch(`/treatment-plan-templates/${template.id}`, {
          lines: [{ catalogItemId: crown, quantity: 4 }],
          visitIntervals: {},
          version: 1,
        })
        .expect(200);
      await as()
        .patch(`/treatment-plan-templates/${template.id}`, {
          active: false,
          version: 2,
        })
        .expect(200);
      const detail = await as().get(`/treatment-plans/${plan}`).expect(200);
      const items = (detail.body as { items: Item[] }).items;
      expect(items.map((i) => [i.catalogItemId, i.visit, i.price])).toEqual([
        [endo, 1, 120],
        [post, 2, 40],
        [crown, 3, 250],
      ]);
      expect(
        (detail.body as { visitIntervals: Record<string, number> })
          .visitIntervals,
      ).toEqual({ '2': 7, '3': 14 });
    });
  });
});
