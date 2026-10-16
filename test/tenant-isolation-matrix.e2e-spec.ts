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
import {
  Clinic,
  createE2eApp,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';

/**
 * DX-068 (TST-002): matriz de aislamiento entre clínicas en las rutas por id.
 *
 * Se siembra la clínica A con un objeto de cada tipo y la clínica B (ADMIN,
 * el rol con más permisos) ataca cada ruta de lectura y escritura por id con
 * los ids de A. Para cada caso se exige:
 *  - la respuesta esperada (404: el recurso de otra clínica "no existe"; la
 *    sede ajena en `X-Location-Id` se rechaza con 400), y
 *  - que NADA de A cambió: se fotografían por `raw` (DIRECT_URL, sin RLS) todas
 *    las filas de A de todas las tablas con `tenantId` (más los usuarios de sus
 *    miembros) antes y después de la petición, y deben ser idénticas.
 *
 * Lo que B manda en el cuerpo es suyo (su catálogo, su paciente...), para que
 * un 404 solo pueda venir de que el recurso de la RUTA es de A.
 */

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

type Verb = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface IdBody {
  id: string;
}

function api(
  app: INestApplication<App>,
  clinic: Clinic,
  verb: Verb,
  path: string,
  body?: object,
  token: string = clinic.adminToken,
): request.Test {
  const req = request(app.getHttpServer())
    [verb](`/api/v1${path}`)
    .set('X-Tenant-Host', clinic.host)
    .set('Authorization', `Bearer ${token}`);
  return body === undefined ? req : req.send(body);
}

async function create(
  app: INestApplication<App>,
  clinic: Clinic,
  path: string,
  body: object,
): Promise<IdBody> {
  const res = await api(app, clinic, 'post', path, body).expect(201);
  return res.body as IdBody;
}

/** Tablas con columna "tenantId" (las de clínica), leídas del catálogo. */
async function tenantTables(): Promise<string[]> {
  const rows = await raw.$queryRaw<{ table: string }[]>`
    SELECT c.relname AS table
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND a.attname = 'tenantId' AND NOT a.attisdropped
    ORDER BY c.relname`;
  return rows.map((r) => r.table);
}

/** Todas las filas de la clínica, tabla a tabla, como JSON comparable. */
async function snapshotTenant(
  tables: string[],
  tenantId: string,
): Promise<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {};
  for (const table of tables) {
    const [{ rows }] = await raw.$queryRawUnsafe<{ rows: unknown }[]>(
      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows
       FROM "public"."${table}" t WHERE t."tenantId" = $1::uuid`,
      tenantId,
    );
    snapshot[table] = rows;
  }
  snapshot.users = await raw.user.findMany({
    where: { memberships: { some: { tenantId } } },
    orderBy: { id: 'asc' },
  });
  return snapshot;
}

interface IsolationCase {
  name: string;
  verb: Verb;
  path: () => string;
  body?: () => object;
  /** Cabecera X-Location-Id que manda B (una sede de A). */
  locationId?: () => string;
  status: number;
}

interface SeedA {
  patientId: string;
  appointmentId: string;
  catalogItemId: string;
  inventoryItemId: string;
  planId: string;
  planItemId: string;
  bareplanId: string;
  paymentId: string;
  consentTemplateId: string;
  locationId: string;
  dentistUserId: string;
  inactiveUserId: string;
  invitationId: string;
  domainId: string;
  prescriptionTemplateId: string;
}

interface SeedB {
  patientId: string;
  catalogItemId: string;
}

function futureAt(daysAhead: number, hourUtc: number): string {
  const date = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date.toISOString();
}

async function seedClinicData(
  app: INestApplication<App>,
  clinic: Clinic,
  docNumber: string,
): Promise<{ patientId: string; catalogItemId: string }> {
  const patient = await create(app, clinic, '/patients', {
    firstName: 'Paciente',
    lastName: clinic.subdomain,
    docType: DocType.CC,
    docNumber,
    sex: Sex.F,
  });
  const catalogItem = await create(app, clinic, '/catalog/items', {
    code: `RESINA-${docNumber}`,
    kind: CatalogKind.PROCEDURE,
    labelEs: 'Resina',
    color: '#2A2B3C',
    defaultPrice: 100,
  });
  return { patientId: patient.id, catalogItemId: catalogItem.id };
}

async function seedA(app: INestApplication<App>, a: Clinic): Promise<SeedA> {
  // Sin horario de atención: el spec no prueba el horario y así la cita se
  // puede agendar a cualquier hora (ver appointments.e2e-spec.ts).
  await api(app, a, 'put', '/locations/schedule', {
    timezone: 'America/Bogota',
    ranges: [],
  }).expect(200);

  const { patientId, catalogItemId } = await seedClinicData(app, a, '9001');
  const appointment = await create(app, a, '/appointments', {
    patientId,
    providerId: a.adminUserId,
    start: futureAt(7, 15),
    end: futureAt(7, 16),
    reason: 'Control de A',
  });
  const inventoryItem = await create(app, a, '/inventory/items', {
    name: 'Guantes de A',
    unit: 'caja',
    minStock: 5,
  });
  await create(app, a, `/inventory/items/${inventoryItem.id}/movements`, {
    type: 'IN',
    quantity: 10,
  });

  const plan = await create(app, a, `/patients/${patientId}/treatment-plans`, {
    currency: 'USD',
    notes: 'Plan de A',
  });
  const planItem = await create(app, a, `/treatment-plans/${plan.id}/items`, {
    toothNumber: '11',
    catalogItemId,
    price: 1200,
  });
  await api(
    app,
    a,
    'patch',
    `/treatment-plans/${plan.id}/items/${planItem.id}`,
    {
      status: 'ACCEPTED',
    },
  ).expect(200);
  await create(app, a, `/treatment-plans/${plan.id}/payment-plan`, {
    installmentsCount: 4,
    periodicity: 'MONTHLY',
    startDate: futureAt(30, 12).slice(0, 10),
  });
  const payment = await create(app, a, `/treatment-plans/${plan.id}/payments`, {
    amount: 100,
    currency: 'USD',
    paidAt: new Date().toISOString(),
    method: 'CASH',
  });
  const bareplan = await create(
    app,
    a,
    `/patients/${patientId}/treatment-plans`,
    { currency: 'USD', notes: 'Plan de A sin plan de pagos' },
  );

  const consentTemplate = await create(app, a, '/consent-templates', {
    title: 'Consentimiento de A',
    body: 'Yo, {{paciente}}, autorizo el procedimiento.',
  });
  const location = await create(app, a, '/locations', { name: 'Sede Norte A' });
  const dentist = await seedMember(raw, a, ClinicRole.DENTIST);
  const assistant = await seedMember(raw, a, ClinicRole.ASSISTANT);
  await api(app, a, 'delete', `/staff/${assistant.userId}`).expect((res) =>
    expect(res.status).toBeLessThan(300),
  );
  const invitation = await create(app, a, '/staff/invitations', {
    fullName: 'Invitada de A',
    email: 'invitada@a.test',
    role: ClinicRole.RECEPTION,
  });
  const domainRes = await api(app, a, 'post', '/domains', {
    host: 'consultorio-a.example.com',
  }).expect(201);
  const prescriptionTemplate = await create(app, a, '/prescription-templates', {
    name: 'Analgésico de A',
    items: [
      {
        activeIngredient: 'Ibuprofeno',
        concentration: '400 mg',
        pharmaceuticalForm: 'Tableta',
        route: 'Oral',
        dose: '1 tableta',
        frequency: 'Cada 8 horas',
        durationDays: 3,
        totalQuantity: 9,
        quantityUnit: 'tabletas',
      },
    ],
  });

  return {
    patientId,
    appointmentId: appointment.id,
    catalogItemId,
    inventoryItemId: inventoryItem.id,
    planId: plan.id,
    planItemId: planItem.id,
    bareplanId: bareplan.id,
    paymentId: payment.id,
    consentTemplateId: consentTemplate.id,
    locationId: location.id,
    dentistUserId: dentist.userId,
    inactiveUserId: assistant.userId,
    invitationId: invitation.id,
    domainId: (domainRes.body as { domain: IdBody }).domain.id,
    prescriptionTemplateId: prescriptionTemplate.id,
  };
}

describe('Tenant isolation matrix (e2e, DX-068)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let a: SeedA;
  let b: SeedB;
  let tables: string[];

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinicA = await registerClinic(app, 'clinica-aislada-a');
    clinicB = await registerClinic(app, 'clinica-aislada-b');
    a = await seedA(app, clinicA);
    b = await seedClinicData(app, clinicB, '9101');
    tables = await tenantTables();
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('la fotografía de A cubre las tablas de clínica y no está vacía', async () => {
    expect(tables.length).toBeGreaterThanOrEqual(28);
    const snapshot = await snapshotTenant(tables, clinicA.tenantId);
    for (const table of [
      'patients',
      'appointments',
      'dental_catalog_items',
      'inventory_items',
      'inventory_movements',
      'treatment_plans',
      'treatment_plan_items',
      'payment_plans',
      'installments',
      'payments',
      'consent_templates',
      'locations',
      'clinic_memberships',
      'clinic_invitations',
      'tenant_domains',
      'prescription_templates',
    ]) {
      expect({
        table,
        rows: (snapshot[table] as unknown[]).length > 0,
      }).toEqual({ table, rows: true });
    }
  });

  const cases: IsolationCase[] = [
    // --- patients ---
    {
      name: 'GET /patients/:id',
      verb: 'get',
      path: () => `/patients/${a.patientId}`,
      status: 404,
    },
    {
      name: 'PATCH /patients/:id',
      verb: 'patch',
      path: () => `/patients/${a.patientId}`,
      body: () => ({ firstName: 'Hackeado' }),
      status: 404,
    },
    // --- appointments ---
    {
      name: 'GET /appointments/:id',
      verb: 'get',
      path: () => `/appointments/${a.appointmentId}`,
      status: 404,
    },
    {
      name: 'PATCH /appointments/:id',
      verb: 'patch',
      path: () => `/appointments/${a.appointmentId}`,
      body: () => ({ status: 'CANCELLED', reason: 'Hackeado' }),
      status: 404,
    },
    {
      name: 'POST /appointments/:id/confirmation-link',
      verb: 'post',
      path: () => `/appointments/${a.appointmentId}/confirmation-link`,
      body: () => ({}),
      status: 404,
    },
    // --- dental-catalog ---
    {
      name: 'PATCH /catalog/items/:id',
      verb: 'patch',
      path: () => `/catalog/items/${a.catalogItemId}`,
      body: () => ({ labelEs: 'Hackeado', defaultPrice: 1 }),
      status: 404,
    },
    // --- inventory ---
    {
      name: 'GET /inventory/items/:id',
      verb: 'get',
      path: () => `/inventory/items/${a.inventoryItemId}`,
      status: 404,
    },
    {
      name: 'PATCH /inventory/items/:id',
      verb: 'patch',
      path: () => `/inventory/items/${a.inventoryItemId}`,
      body: () => ({ name: 'Hackeado', minStock: 0 }),
      status: 404,
    },
    {
      name: 'DELETE /inventory/items/:id',
      verb: 'delete',
      path: () => `/inventory/items/${a.inventoryItemId}`,
      status: 404,
    },
    {
      name: 'POST /inventory/items/:id/movements',
      verb: 'post',
      path: () => `/inventory/items/${a.inventoryItemId}/movements`,
      body: () => ({ type: 'OUT', quantity: 3 }),
      status: 404,
    },
    {
      name: 'GET /inventory/items/:id/movements',
      verb: 'get',
      path: () => `/inventory/items/${a.inventoryItemId}/movements`,
      status: 404,
    },
    // --- treatment-plans ---
    {
      name: 'GET /treatment-plans/:id',
      verb: 'get',
      path: () => `/treatment-plans/${a.planId}`,
      status: 404,
    },
    {
      name: 'PATCH /treatment-plans/:id',
      verb: 'patch',
      path: () => `/treatment-plans/${a.planId}`,
      body: () => ({ notes: 'Hackeado', status: 'CANCELLED' }),
      status: 404,
    },
    {
      name: 'POST /treatment-plans/:id/items',
      verb: 'post',
      path: () => `/treatment-plans/${a.planId}/items`,
      body: () => ({ toothNumber: '21', catalogItemId: b.catalogItemId }),
      status: 404,
    },
    {
      name: 'PATCH /treatment-plans/:id/items/:itemId',
      verb: 'patch',
      path: () => `/treatment-plans/${a.planId}/items/${a.planItemId}`,
      body: () => ({ price: 1, notes: 'Hackeado' }),
      status: 404,
    },
    {
      name: 'DELETE /treatment-plans/:id/items/:itemId',
      verb: 'delete',
      path: () => `/treatment-plans/${a.planId}/items/${a.planItemId}`,
      status: 404,
    },
    // --- payment-plans ---
    {
      name: 'POST /treatment-plans/:id/payment-plan',
      verb: 'post',
      path: () => `/treatment-plans/${a.bareplanId}/payment-plan`,
      body: () => ({
        installmentsCount: 2,
        periodicity: 'MONTHLY',
        startDate: futureAt(30, 12).slice(0, 10),
      }),
      status: 404,
    },
    {
      name: 'GET /treatment-plans/:id/payment-plan',
      verb: 'get',
      path: () => `/treatment-plans/${a.planId}/payment-plan`,
      status: 404,
    },
    {
      name: 'DELETE /treatment-plans/:id/payment-plan',
      verb: 'delete',
      path: () => `/treatment-plans/${a.planId}/payment-plan`,
      status: 404,
    },
    // --- payments ---
    {
      name: 'POST /treatment-plans/:id/payments',
      verb: 'post',
      path: () => `/treatment-plans/${a.planId}/payments`,
      body: () => ({
        amount: 50,
        currency: 'USD',
        paidAt: new Date().toISOString(),
        method: 'CASH',
      }),
      status: 404,
    },
    {
      name: 'GET /treatment-plans/:id/payments',
      verb: 'get',
      path: () => `/treatment-plans/${a.planId}/payments`,
      status: 404,
    },
    {
      name: 'GET /treatment-plans/:id/balance',
      verb: 'get',
      path: () => `/treatment-plans/${a.planId}/balance`,
      status: 404,
    },
    {
      name: 'DELETE /payments/:id',
      verb: 'delete',
      path: () => `/payments/${a.paymentId}`,
      body: () => ({ reason: 'Hackeado' }),
      status: 404,
    },
    // --- consents (plantillas) ---
    {
      name: 'PATCH /consent-templates/:id',
      verb: 'patch',
      path: () => `/consent-templates/${a.consentTemplateId}`,
      body: () => ({ title: 'Hackeado', active: false }),
      status: 404,
    },
    // --- prescriptions (plantillas) ---
    {
      name: 'PATCH /prescription-templates/:id',
      verb: 'patch',
      path: () => `/prescription-templates/${a.prescriptionTemplateId}`,
      body: () => ({ name: 'Hackeado' }),
      status: 404,
    },
    {
      name: 'DELETE /prescription-templates/:id',
      verb: 'delete',
      path: () => `/prescription-templates/${a.prescriptionTemplateId}`,
      status: 404,
    },
    // --- data-consents (sobre un paciente de A) ---
    {
      name: 'GET /patients/:patientId/data-consents',
      verb: 'get',
      path: () => `/patients/${a.patientId}/data-consents`,
      status: 404,
    },
    // --- locations / location-schedule ---
    {
      name: 'PATCH /locations/:id',
      verb: 'patch',
      path: () => `/locations/${a.locationId}`,
      body: () => ({ name: 'Hackeada', isActive: false }),
      status: 404,
    },
    {
      // La sede ajena se rechaza en TenantContextInterceptor, antes del handler.
      name: 'PUT /locations/schedule con X-Location-Id de A',
      verb: 'put',
      path: () => '/locations/schedule',
      body: () => ({
        timezone: 'America/Bogota',
        ranges: [{ weekday: 1, startMinute: 0, endMinute: 60 }],
      }),
      locationId: () => a.locationId,
      status: 400,
    },
    {
      name: 'GET /locations/schedule con X-Location-Id de A',
      verb: 'get',
      path: () => '/locations/schedule',
      locationId: () => a.locationId,
      status: 400,
    },
    {
      name: 'POST /patients con X-Location-Id de A',
      verb: 'post',
      path: () => '/patients',
      body: () => ({
        firstName: 'Con sede',
        lastName: 'Ajena',
        docType: DocType.CC,
        docNumber: '9199',
        sex: Sex.M,
      }),
      locationId: () => a.locationId,
      status: 400,
    },
    // --- staff ---
    {
      name: 'GET /staff/:userId',
      verb: 'get',
      path: () => `/staff/${a.dentistUserId}`,
      status: 404,
    },
    {
      name: 'PATCH /staff/:userId',
      verb: 'patch',
      path: () => `/staff/${a.dentistUserId}`,
      body: () => ({ role: ClinicRole.ADMIN, fullName: 'Hackeado' }),
      status: 404,
    },
    {
      name: 'DELETE /staff/:userId',
      verb: 'delete',
      path: () => `/staff/${a.dentistUserId}`,
      status: 404,
    },
    {
      name: 'POST /staff/:userId/reactivate',
      verb: 'post',
      path: () => `/staff/${a.inactiveUserId}/reactivate`,
      body: () => ({}),
      status: 404,
    },
    // --- invitations ---
    {
      name: 'DELETE /staff/invitations/:id',
      verb: 'delete',
      path: () => `/staff/invitations/${a.invitationId}`,
      status: 404,
    },
    // --- domains ---
    {
      name: 'POST /domains/:id/verify',
      verb: 'post',
      path: () => `/domains/${a.domainId}/verify`,
      body: () => ({}),
      status: 404,
    },
  ];

  it.each(cases.map((c) => [c.name, c] as const))(
    'B → %s: responde lo esperado y no toca nada de A',
    async (_name, c) => {
      const before = await snapshotTenant(tables, clinicA.tenantId);
      const req = api(app, clinicB, c.verb, c.path(), c.body?.());
      if (c.locationId) req.set('X-Location-Id', c.locationId());
      const res = await req;
      expect({ status: res.status }).toEqual({ status: c.status });
      expect(await snapshotTenant(tables, clinicA.tenantId)).toEqual(before);
    },
  );

  it('B sigue operando lo suyo (los 404 no son un "todo prohibido")', async () => {
    await api(app, clinicB, 'get', `/patients/${b.patientId}`).expect(200);
    await api(app, clinicB, 'patch', `/catalog/items/${b.catalogItemId}`, {
      labelEs: 'Resina de B',
    }).expect(200);
  });

  it('A sigue viendo todo lo suyo tras la batería', async () => {
    await api(app, clinicA, 'get', `/patients/${a.patientId}`).expect(200);
    await api(app, clinicA, 'get', `/appointments/${a.appointmentId}`).expect(
      200,
    );
    await api(app, clinicA, 'get', `/treatment-plans/${a.planId}`).expect(200);
    await api(
      app,
      clinicA,
      'get',
      `/inventory/items/${a.inventoryItemId}`,
    ).expect(200);
    await api(app, clinicA, 'get', `/staff/${a.dentistUserId}`).expect(200);
  });

  it('control: la fotografía SÍ detecta un cambio real en A', async () => {
    const before = await snapshotTenant(tables, clinicA.tenantId);
    await api(app, clinicA, 'patch', `/patients/${a.patientId}`, {
      firstName: 'Cambiado por A',
    }).expect(200);
    expect(await snapshotTenant(tables, clinicA.tenantId)).not.toEqual(before);
  });

  // BE-007 (abierto, T-BE-2): las rutas de ítems ignoran `:id` del plan. No es
  // una fuga entre clínicas (la RLS lo impide, ver los casos de arriba), pero
  // dentro de A un id de plan cualquiera modifica o borra el ítem de OTRO
  // plan. Quedan como `it.failing` hasta que se corrija: cuando BE-007 se
  // arregle, Jest avisará de que estos tests ya pasan y hay que quitar el
  // `.failing`.
  describe('id de plan ajeno al ítem, dentro de la misma clínica (BE-007)', () => {
    async function itemOfAnotherPlan(): Promise<{
      otherPlanId: string;
      itemId: string;
    }> {
      const owner = await create(
        app,
        clinicA,
        `/patients/${a.patientId}/treatment-plans`,
        { currency: 'USD' },
      );
      const item = await create(
        app,
        clinicA,
        `/treatment-plans/${owner.id}/items`,
        { toothNumber: '36', catalogItemId: a.catalogItemId, price: 80 },
      );
      return { otherPlanId: a.bareplanId, itemId: item.id };
    }

    it.failing(
      'PATCH con el plan equivocado → 404 y el ítem intacto',
      async () => {
        const { otherPlanId, itemId } = await itemOfAnotherPlan();
        const before = await raw.treatmentPlanItem.findUniqueOrThrow({
          where: { id: itemId },
        });
        const res = await api(
          app,
          clinicA,
          'patch',
          `/treatment-plans/${otherPlanId}/items/${itemId}`,
          { notes: 'Editado desde otro plan' },
        );
        expect(res.status).toBe(404);
        expect(
          await raw.treatmentPlanItem.findUniqueOrThrow({
            where: { id: itemId },
          }),
        ).toEqual(before);
      },
    );

    it.failing(
      'DELETE con el plan equivocado → 404 y el ítem intacto',
      async () => {
        const { otherPlanId, itemId } = await itemOfAnotherPlan();
        const res = await api(
          app,
          clinicA,
          'delete',
          `/treatment-plans/${otherPlanId}/items/${itemId}`,
        );
        expect(res.status).toBe(404);
        expect(
          await raw.treatmentPlanItem.findUnique({ where: { id: itemId } }),
        ).toMatchObject({ id: itemId, deletedAt: null });
      },
    );
  });
});
