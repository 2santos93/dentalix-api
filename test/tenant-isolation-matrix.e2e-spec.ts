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
import { ROUTE_ACCESS } from './support/route-access-matrix';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { clinicTables, TenantTable } from './support/tenant-tables';

/**
 * DX-068 (TST-002): matriz de aislamiento entre clínicas en las rutas por id.
 *
 * Se siembra la clínica A con un objeto de cada tipo y la clínica B (ADMIN,
 * el rol con más permisos) ataca cada ruta de lectura y escritura por id con
 * los ids de A. Para cada caso se exige:
 *  - la respuesta esperada (404: el recurso de otra clínica "no existe"; la
 *    sede ajena en `X-Location-Id` se rechaza con 400; las lecturas clínicas
 *    colgadas del paciente responden 200 VACÍO por contrato), y
 *  - que NADA de A cambió: se fotografían por `raw` (DIRECT_URL, sin RLS) todas
 *    las filas de A de todas las tablas de clínica (support/tenant-tables.ts),
 *    la fila de A en `tenants` y los usuarios de sus miembros, más el número
 *    de filas de B por tabla (un POST no puede colgar nada de A en B), antes y
 *    después de la petición, y deben ser idénticas.
 *
 * Lo que B manda en el cuerpo es suyo (su catálogo, su paciente...), para que
 * un 404 solo pueda venir de que el recurso de la RUTA es de A.
 */

// PNG real de 1x1 con un píxel visible (la API rechaza una firma en blanco).
const SIGNATURE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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

/**
 * Fotografía comparable: filas de A en cada tabla de clínica, su fila de
 * `tenants`, los usuarios de sus miembros y el recuento de filas de B.
 */
async function snapshot(
  tables: TenantTable[],
  tenantA: string,
  tenantB: string,
): Promise<Record<string, unknown>> {
  const shot: Record<string, unknown> = {};
  for (const { table, column } of tables) {
    const [{ rows, countB }] = await raw.$queryRawUnsafe<
      { rows: unknown; countB: number }[]
    >(
      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)
                FILTER (WHERE t."${column}" = $1::uuid), '[]'::jsonb) AS rows,
              count(*) FILTER (WHERE t."${column}" = $2::uuid)::int AS "countB"
       FROM "public"."${table}" t`,
      tenantA,
      tenantB,
    );
    // `audit_events` (DX-009): cada petición correcta de B deja SU evento en
    // B (también la lectura que devuelve 200 vacío), así que su recuento de B
    // cambia a propósito. Lo que no puede cambiar son las filas de A. Igual en
    // sus particiones mensuales (DX-102: audit_events_pYYYYMM y _default).
    const isAudit = /^audit_events(_p\d{6}|_default)?$/.test(table);
    shot[`${table}.${column}`] = isAudit ? { rows } : { rows, countB };
  }
  shot.tenant = await raw.tenant.findUnique({ where: { id: tenantA } });
  shot.users = await raw.user.findMany({
    where: { memberships: { some: { tenantId: tenantA } } },
    orderBy: { id: 'asc' },
  });
  return shot;
}

interface IsolationCase {
  name: string;
  verb: Verb;
  path: () => string;
  body?: () => object;
  /** Cabecera X-Location-Id que manda B (una sede de A). */
  locationId?: () => string;
  status: number;
  /** Cuerpo exacto esperado (`null` = vacío) cuando no es un error. */
  responseBody?: unknown;
}

interface SeedA {
  patientId: string;
  appointmentId: string;
  catalogItemId: string;
  inventoryItemId: string;
  planId: string;
  planItemId: string;
  bareplanId: string;
  /** Plan aceptado con firma (DX-012). */
  signedPlanId: string;
  paymentId: string;
  consentTemplateId: string;
  locationId: string;
  dentistUserId: string;
  inactiveUserId: string;
  invitationId: string;
  domainId: string;
  prescriptionTemplateId: string;
  appointmentTypeId: string;
  scheduleBlockId: string;
  waitlistEntryId: string;
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
  // DX-012: un plan de A aceptado con firma, para que la fotografía incluya
  // treatment_plan_acceptances.
  const signedPlan = await create(
    app,
    a,
    `/patients/${patientId}/treatment-plans`,
    { currency: 'USD', notes: 'Plan de A firmado' },
  );
  await create(app, a, `/treatment-plans/${signedPlan.id}/items`, {
    toothNumber: '21',
    catalogItemId,
  });
  const quote = await api(
    app,
    a,
    'get',
    `/patients/${patientId}/treatment-plans/${signedPlan.id}/quote`,
  ).expect(200);
  await create(
    app,
    a,
    `/patients/${patientId}/treatment-plans/${signedPlan.id}/acceptance`,
    {
      signerName: 'Paciente de A',
      signature: SIGNATURE_PNG,
      contentHash: (quote.body as { contentHash: string }).contentHash,
    },
  );

  const consentTemplate = await create(app, a, '/consent-templates', {
    title: 'Consentimiento de A',
    body: 'Yo, {{paciente}}, autorizo el procedimiento.',
  });
  const location = await create(app, a, '/locations', { name: 'Sede Norte A' });
  // Recordatorios por sede (DX-026): A los activa en su sede nueva.
  await api(app, a, 'put', `/reminder-settings/${location.id}`, {
    enabled: true,
    leadHours: [48, 2],
  }).expect(200);
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

  const appointmentType = await create(app, a, '/appointment-types', {
    name: 'Endodoncia de A',
    durationMinutes: 90,
    color: '#7C3AED',
  });

  // DX-122: un bloqueo de la sede y un pendiente (alta manual) de A.
  const scheduleBlock = await create(app, a, '/schedule-blocks', {
    locationId: location.id,
    start: futureAt(60, 13),
    end: futureAt(60, 14),
    kind: 'MEETING',
  });
  const waitlistEntry = await create(app, a, '/waitlist', {
    patientId,
    priority: 'URGENT',
    note: 'Llamar por la mañana',
  });

  return {
    patientId,
    appointmentId: appointment.id,
    catalogItemId,
    inventoryItemId: inventoryItem.id,
    planId: plan.id,
    planItemId: planItem.id,
    bareplanId: bareplan.id,
    signedPlanId: signedPlan.id,
    paymentId: payment.id,
    consentTemplateId: consentTemplate.id,
    locationId: location.id,
    dentistUserId: dentist.userId,
    inactiveUserId: assistant.userId,
    invitationId: invitation.id,
    domainId: (domainRes.body as { domain: IdBody }).domain.id,
    prescriptionTemplateId: prescriptionTemplate.id,
    appointmentTypeId: appointmentType.id,
    scheduleBlockId: scheduleBlock.id,
    waitlistEntryId: waitlistEntry.id,
  };
}

describe('Tenant isolation matrix (e2e, DX-068)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let a: SeedA;
  let b: SeedB;
  let tables: TenantTable[];
  const shotOfA = (): Promise<Record<string, unknown>> =>
    snapshot(tables, clinicA.tenantId, clinicB.tenantId);

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinicA = await registerClinic(app, 'clinica-aislada-a');
    clinicB = await registerClinic(app, 'clinica-aislada-b');
    a = await seedA(app, clinicA);
    b = await seedClinicData(app, clinicB, '9101');
    tables = await clinicTables(raw);
    // La invitación de A encola su email (DX-088): se espera a que el
    // despachador lo deje SENT para que la fotografía no cambie por él.
    await app.get(EmailDispatcher).whenIdle();
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('la fotografía de A cubre las tablas de clínica y no está vacía', async () => {
    expect(tables.length).toBeGreaterThanOrEqual(30);
    const shot = await shotOfA();
    expect(shot.tenant).toMatchObject({ id: clinicA.tenantId });
    for (const table of [
      'patients',
      'appointments',
      'dental_catalog_items',
      'inventory_items',
      'inventory_movements',
      'treatment_plans',
      'treatment_plan_items',
      'treatment_plan_acceptances',
      'payment_plans',
      'installments',
      'payments',
      'consent_templates',
      'locations',
      'clinic_memberships',
      'clinic_invitations',
      'email_outbox',
      'tenant_domains',
      'prescription_templates',
      'location_reminder_settings',
      // La siembra de A por la API ya deja eventos de auditoría (DX-009).
      'audit_events',
    ]) {
      expect({
        table,
        rows:
          (shot[`${table}.tenantId`] as { rows: unknown[] }).rows.length > 0,
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
    // DX-039: archivar, retención extendida y supresión parcial (ADMIN de B).
    {
      name: 'DELETE /patients/:id',
      verb: 'delete',
      path: () => `/patients/${a.patientId}`,
      status: 404,
    },
    {
      name: 'PATCH /patients/:id/retention',
      verb: 'patch',
      path: () => `/patients/${a.patientId}/retention`,
      body: () => ({
        retentionExtended: 'PERMANENT',
        reason: 'Intento desde otra clínica',
      }),
      status: 404,
    },
    {
      name: 'POST /patients/:id/partial-suppression',
      verb: 'post',
      path: () => `/patients/${a.patientId}/partial-suppression`,
      body: () => ({ reason: 'Intento desde otra clínica' }),
      status: 404,
    },
    // --- rutas clínicas colgadas del paciente de A (lecturas) ---
    // Contrato previo y deliberado (clinical-history, odontogram y
    // treatment-plans e2e): la RLS deja ver 0 filas y se responde 200 vacío,
    // como para un paciente sin datos. Se fija aquí que el cuerpo va VACÍO:
    // ni una fila de A.
    ...(
      [
        ['medical-history', null],
        ['clinical-entries', []],
        ['odontogram', []],
        ['teeth/11/history', []],
        ['treatment-plans', []],
      ] as const
    ).map(([sub, empty]): IsolationCase => ({
      name: `GET /patients/:patientId/${sub.replace('11', ':fdi')}`,
      verb: 'get',
      path: () => `/patients/${a.patientId}/${sub}`,
      status: 200,
      responseBody: empty,
    })),
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
    {
      name: 'GET /appointments/:id/reminders',
      verb: 'get',
      path: () => `/appointments/${a.appointmentId}/reminders`,
      status: 404,
    },
    // --- reminders (DX-026) ---
    {
      name: 'PUT /reminder-settings/:locationId',
      verb: 'put',
      path: () => `/reminder-settings/${a.locationId}`,
      body: () => ({ enabled: false, leadHours: [] }),
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
    // DX-012: presupuesto y aceptación firmada de un plan de A.
    {
      name: 'GET /patients/:patientId/treatment-plans/:planId/quote',
      verb: 'get',
      path: () =>
        `/patients/${a.patientId}/treatment-plans/${a.signedPlanId}/quote`,
      status: 404,
    },
    {
      name: 'POST /patients/:patientId/treatment-plans/:planId/acceptance',
      verb: 'post',
      path: () =>
        `/patients/${a.patientId}/treatment-plans/${a.planId}/acceptance`,
      body: () => ({
        signerName: 'Hackeado',
        signature: SIGNATURE_PNG,
        contentHash: 'a'.repeat(64),
      }),
      status: 404,
    },
    {
      name: 'DELETE /treatment-plans/:id/items/:itemId',
      verb: 'delete',
      path: () => `/treatment-plans/${a.planId}/items/${a.planItemId}`,
      status: 404,
    },
    // DX-040: presentar, rechazar y crear una alternativa de un plan de A.
    {
      name: 'POST /treatment-plans/:id/present',
      verb: 'post',
      path: () => `/treatment-plans/${a.bareplanId}/present`,
      status: 404,
    },
    {
      name: 'POST /treatment-plans/:id/reject',
      verb: 'post',
      path: () => `/treatment-plans/${a.planId}/reject`,
      body: () => ({ reason: 'PRICE', note: 'Hackeado' }),
      status: 404,
    },
    {
      name: 'POST /treatment-plans/:id/alternatives',
      verb: 'post',
      path: () => `/treatment-plans/${a.planId}/alternatives`,
      body: () => ({ optionLabel: 'Hackeado' }),
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
    // DX-136: el recibo de caja del abono de A.
    {
      name: 'GET /payments/:id/receipt',
      verb: 'get',
      path: () => `/payments/${a.paymentId}/receipt`,
      status: 404,
    },
    {
      name: 'POST /payments/:id/receipt/print',
      verb: 'post',
      path: () => `/payments/${a.paymentId}/receipt/print`,
      status: 404,
    },
    {
      name: 'POST /payments/:id/receipt/email',
      verb: 'post',
      path: () => `/payments/${a.paymentId}/receipt/email`,
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
    // --- appointment-types (DX-121) ---
    {
      name: 'PATCH /appointment-types/:id',
      verb: 'patch',
      path: () => `/appointment-types/${a.appointmentTypeId}`,
      body: () => ({ name: 'Hackeado', active: false }),
      status: 404,
    },
    {
      name: 'DELETE /appointment-types/:id',
      verb: 'delete',
      path: () => `/appointment-types/${a.appointmentTypeId}`,
      status: 404,
    },
    // --- schedule-blocks y waitlist (DX-122) ---
    {
      name: 'PATCH /schedule-blocks/:id',
      verb: 'patch',
      path: () => `/schedule-blocks/${a.scheduleBlockId}`,
      body: () => ({ allowsBooking: true }),
      status: 404,
    },
    {
      name: 'DELETE /schedule-blocks/:id',
      verb: 'delete',
      path: () => `/schedule-blocks/${a.scheduleBlockId}`,
      status: 404,
    },
    {
      name: 'POST /waitlist/:id/dismiss',
      verb: 'post',
      path: () => `/waitlist/${a.waitlistEntryId}/dismiss`,
      body: () => ({ reason: 'Hackeado' }),
      status: 404,
    },
    {
      name: 'POST /waitlist/:id/schedule',
      verb: 'post',
      path: () => `/waitlist/${a.waitlistEntryId}/schedule`,
      body: () => ({
        providerId: clinicB.adminUserId,
        start: futureAt(61, 15),
      }),
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
    {
      // DX-048: desbloquear el login de un miembro de A desde B.
      name: 'POST /staff/:userId/login-unlock',
      verb: 'post',
      path: () => `/staff/${a.dentistUserId}/login-unlock`,
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
    {
      // DX-088: reenviar (regenera token y encola email) la de A desde B.
      name: 'POST /staff/invitations/:id/resend',
      verb: 'post',
      path: () => `/staff/invitations/${a.invitationId}/resend`,
      body: () => ({}),
      status: 404,
    },
    // --- auditoría (DX-009) ---
    // Sin `:param`, pero con ids de A en los filtros: B recibe su propia
    // lista vacía, nunca un evento de A.
    ...(
      [
        ['patientId', () => a.patientId],
        ['actorUserId', () => clinicA.adminUserId],
      ] as const
    ).map(([filter, id]): IsolationCase => ({
      name: `GET /audit-events?${filter} de A`,
      verb: 'get',
      path: () => `/audit-events?${filter}=${id()}`,
      status: 200,
      responseBody: {
        items: [],
        nextCursor: null,
        timeZone: 'America/Bogota',
      },
    })),
    // --- domains ---
    {
      name: 'POST /domains/:id/verify',
      verb: 'post',
      path: () => `/domains/${a.domainId}/verify`,
      body: () => ({}),
      status: 404,
    },
  ];

  /**
   * Rutas con roles y `:param` cuyo aislamiento entre clínicas ya prueba otro
   * spec (B → 404 sobre el recurso de A). Cada una cita dónde.
   */
  const COVERED_ELSEWHERE: Record<string, string> = {
    'POST /patients/:patientId/treatment-plans':
      'patient-tenant-fk.e2e-spec.ts',
    'PUT /patients/:patientId/medical-history': 'patient-tenant-fk.e2e-spec.ts',
    'POST /patients/:patientId/clinical-entries':
      'patient-tenant-fk.e2e-spec.ts',
    'POST /patients/:patientId/tooth-records': 'patient-tenant-fk.e2e-spec.ts',
    // DX-120: B → 404 sobre el paciente y el registro de A.
    'POST /patients/:patientId/tooth-records/:recordId/void':
      'odontogram-dentition.e2e-spec.ts',
    'GET /patients/:patientId/dentition': 'odontogram-dentition.e2e-spec.ts',
    'POST /patients/:patientId/dentition-events':
      'odontogram-dentition.e2e-spec.ts',
    'POST /patients/:patientId/clinical-entries/:entryId/addenda':
      'clinical-entry-addenda.e2e-spec.ts',
    'GET /patients/:patientId/clinical-entries/:entryId/addenda':
      'clinical-entry-addenda.e2e-spec.ts',
    // Responden 405 a cualquiera sin leer ni tocar datos (HC inalterable).
    'PATCH /patients/:patientId/clinical-entries/:entryId':
      'clinical-entry-addenda.e2e-spec.ts',
    'PUT /patients/:patientId/clinical-entries/:entryId':
      'clinical-entry-addenda.e2e-spec.ts',
    'DELETE /patients/:patientId/clinical-entries/:entryId':
      'clinical-entry-addenda.e2e-spec.ts',
    'GET /patients/:patientId/perio-exams': 'perio-exams.e2e-spec.ts',
    'POST /patients/:patientId/perio-exams': 'perio-exams.e2e-spec.ts',
    'GET /patients/:patientId/perio-exams/:id': 'perio-exams.e2e-spec.ts',
    'PUT /patients/:patientId/perio-exams/:id/measures':
      'perio-exams.e2e-spec.ts',
    'POST /patients/:patientId/perio-exams/:id/finalize':
      'perio-exams.e2e-spec.ts',
    'DELETE /patients/:patientId/perio-exams/:id': 'perio-exams.e2e-spec.ts',
    'GET /patients/:patientId/consents': 'patient-consents.e2e-spec.ts',
    'GET /patients/:patientId/consents/preview': 'patient-consents.e2e-spec.ts',
    'POST /patients/:patientId/consents': 'patient-consents.e2e-spec.ts',
    'GET /patients/:patientId/consents/:id': 'patient-consents.e2e-spec.ts',
    'POST /patients/:patientId/data-consents': 'data-consents.e2e-spec.ts',
    'GET /patients/:patientId/prescriptions': 'prescriptions.e2e-spec.ts',
    'POST /patients/:patientId/prescriptions': 'prescriptions.e2e-spec.ts',
    'GET /prescriptions/:id': 'prescriptions.e2e-spec.ts',
    'POST /prescriptions/:id/void': 'prescriptions.e2e-spec.ts',
    'GET /patients/:patientId/account-statement':
      'account-statement.e2e-spec.ts',
    'GET /patients/:patientId/billable-plans': 'billable-plans.e2e-spec.ts',
  };

  it('cubre toda ruta de clínica con :param (aquí o en el spec citado)', () => {
    const covered = new Set(
      cases.map((c) => c.name.split(' ').slice(0, 2).join(' ')),
    );
    const byId = Object.entries(ROUTE_ACCESS)
      .filter(([key, access]) => access.kind === 'roles' && key.includes('/:'))
      .map(([key]) => key);
    expect({
      sinCubrir: byId.filter(
        (k) => !covered.has(k) && !(k in COVERED_ELSEWHERE),
      ),
      exencionSobrante: Object.keys(COVERED_ELSEWHERE).filter(
        (k) => covered.has(k) || !byId.includes(k),
      ),
    }).toEqual({ sinCubrir: [], exencionSobrante: [] });
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    'B → %s: responde lo esperado y no toca nada de A',
    async (_name, c) => {
      const before = await shotOfA();
      const req = api(app, clinicB, c.verb, c.path(), c.body?.());
      if (c.locationId) req.set('X-Location-Id', c.locationId());
      const res = await req;
      expect({ status: res.status }).toEqual({ status: c.status });
      if ('responseBody' in c) {
        expect(res.text === '' ? null : res.body).toEqual(c.responseBody);
      }
      expect(await shotOfA()).toEqual(before);
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
    const before = await shotOfA();
    await api(app, clinicA, 'patch', `/patients/${a.patientId}`, {
      firstName: 'Cambiado por A',
    }).expect(200);
    expect(await shotOfA()).not.toEqual(before);
  });

  it('control: la fotografía SÍ detecta una fila nueva de B', async () => {
    const before = await shotOfA();
    await api(app, clinicB, 'post', '/inventory/items', {
      name: 'Guantes de B',
      unit: 'caja',
    }).expect(201);
    expect(await shotOfA()).not.toEqual(before);
  });

  // BE-007 (abierto, T-BE-2): las rutas de ítems ignoran `:id` del plan. No es
  // una fuga entre clínicas (la RLS lo impide, ver los casos de arriba), pero
  // dentro de A un id de plan cualquiera modifica o borra el ítem de OTRO
  // plan. Quedan como `it.failing` hasta que se corrija: cuando BE-007 se
  // arregle, Jest avisará de que estos tests ya pasan y hay que quitar el
  // `.failing`.
  describe('id de plan ajeno al ítem, dentro de la misma clínica (BE-007)', () => {
    // La siembra va aquí y no dentro de cada `it.failing`: así un fallo de
    // la siembra rompe la suite en vez de contar como "falla esperada".
    // Un ítem por test (el DELETE retira el suyo).
    let itemForPatch: string;
    let itemForDelete: string;

    beforeAll(async () => {
      const owner = await create(
        app,
        clinicA,
        `/patients/${a.patientId}/treatment-plans`,
        { currency: 'USD' },
      );
      const addItem = (toothNumber: string) =>
        create(app, clinicA, `/treatment-plans/${owner.id}/items`, {
          toothNumber,
          catalogItemId: a.catalogItemId,
          price: 80,
        });
      itemForPatch = (await addItem('36')).id;
      itemForDelete = (await addItem('46')).id;
    });

    it.failing(
      'PATCH con el plan equivocado → 404 y el ítem intacto',
      async () => {
        const itemId = itemForPatch;
        const before = await raw.treatmentPlanItem.findUniqueOrThrow({
          where: { id: itemId },
        });
        const res = await api(
          app,
          clinicA,
          'patch',
          `/treatment-plans/${a.bareplanId}/items/${itemId}`,
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
        const itemId = itemForDelete;
        const res = await api(
          app,
          clinicA,
          'delete',
          `/treatment-plans/${a.bareplanId}/items/${itemId}`,
        );
        expect(res.status).toBe(404);
        expect(
          await raw.treatmentPlanItem.findUnique({ where: { id: itemId } }),
        ).toMatchObject({ id: itemId, deletedAt: null });
      },
    );
  });
});
