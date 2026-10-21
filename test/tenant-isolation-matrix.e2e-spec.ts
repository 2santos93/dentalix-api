import { INestApplication } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  DocType,
  PrismaClient,
  Sex,
} from '@prisma/client';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
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
import { pdfFixture } from './support/document-fixtures';

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
  payerId: string;
  scheduleBlockId: string;
  waitlistEntryId: string;
  noteTemplateId: string;
  waitlistOfferId: string;
  /** DX-203: un responsable (contacto) del paciente de A. */
  responsiblePartyId: string;
  coverageId: string;
  /** Caja por turno cerrada de A (DX-027). */
  cashSessionId: string;
  /** DX-222: plantilla de indicaciones de A (con vínculo) y una entrega. */
  postOpTemplateId: string;
  postOpDeliveryId: string;
  /** DX-233: excepción por fecha del horario de la dentista de A. */
  providerOverrideId: string;
}

interface SeedB {
  patientId: string;
  catalogItemId: string;
  /**
   * Sede propia de B (DX-089: B intenta restringir a un miembro de A a ella;
   * DX-233: cuerpo de las excepciones).
   */
  locationId: string;
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
  // DX-027: A abre su caja antes del abono (entra en ella) y la cierra con
  // arqueo, para que la fotografía incluya la caja, su fondo y su cierre.
  const cashSession = await create(app, a, '/cash-sessions/open', {
    floats: [{ currency: 'USD', amount: 20 }],
  });
  const payment = await create(app, a, `/treatment-plans/${plan.id}/payments`, {
    amount: 100,
    currency: 'USD',
    paidAt: new Date().toISOString(),
    method: 'CASH',
  });
  await create(app, a, `/cash-sessions/${cashSession.id}/close`, {
    counts: [{ currency: 'USD', method: 'CASH', counted: 120 }],
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
  // DX-089: la dentista de A queda restringida a TODAS las sedes activas de A
  // (deja filas en membership_locations sin cambiar a qué puede acceder).
  const sedesA = await api(app, a, 'get', '/locations').expect(200);
  await api(app, a, 'put', `/staff/${dentist.userId}/locations`, {
    locationIds: (sedesA.body as IdBody[]).map(({ id }) => id),
  }).expect(200);
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

  // DX-153: un pagador de A.
  const payer = await create(app, a, '/payers', {
    name: 'Pagador de A',
    type: 'EMPRESA',
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

  // DX-210: una oferta de hueco al paciente (por teléfono, sin resultado).
  const waitlistOffer = await create(
    app,
    a,
    `/appointments/openings/${location.id}/offers`,
    {
      slotStart: futureAt(60, 15),
      slotEnd: futureAt(60, 16),
      providerId: dentist.userId,
      patientId,
      channel: 'PHONE',
    },
  );

  // DX-170: una plantilla de evolución de A.
  const noteTemplate = await create(app, a, '/clinical-note-templates', {
    name: 'Resina de A',
    body: 'Superficie {{Superficie}}',
    prompts: [{ label: 'Superficie', type: 'ONE', options: ['O', 'M'] }],
  });

  // DX-150: una gestión de cobro y un compromiso de pago de A.
  await create(app, a, `/patients/${patientId}/collection-notes`, {
    channel: 'CALL',
    outcome: 'PROMISED_PAYMENT',
    text: 'Llamada de A',
  });
  await create(app, a, `/patients/${patientId}/payment-promises`, {
    amount: 1000,
    currency: 'COP',
    dueDate: futureAt(10, 15).slice(0, 10),
  });

  // DX-203: un responsable (contacto pagador) del paciente de A.
  const responsibleParty = await create(
    app,
    a,
    `/patients/${patientId}/responsible-parties`,
    {
      fullName: 'Responsable de A',
      email: 'responsable-a@example.com',
      relationship: 'MOTHER',
      isPayer: true,
    },
  );

  // DX-153: una cobertura del paciente de A con el pagador de A.
  const coverage = await create(app, a, `/patients/${patientId}/coverages`, {
    payerId: payer.id,
    memberNumber: 'AFI-A-0001',
  });

  // DX-222: una plantilla de indicaciones vinculada al tipo de cita y una
  // entrega impresa en la cita de A, ambas por la API.
  const postOpTemplate = await create(app, a, '/post-op-templates', {
    code: 'POI-A',
    title: 'Indicaciones de A',
    body: 'Hola {{paciente}}, cuídate.',
    appointmentTypeIds: [appointmentType.id],
  });
  const postOpDelivery = await api(
    app,
    a,
    'post',
    `/appointments/${appointment.id}/post-op-instructions/deliveries`,
    { templateId: postOpTemplate.id, channel: 'PRINT' },
  ).expect(201);

  // DX-151: un documento del paciente de A, subido por la API (multipart).
  await request(app.getHttpServer())
    .post(`/api/v1/patients/${patientId}/documents`)
    .set('X-Tenant-Host', a.host)
    .set('Authorization', `Bearer ${a.adminToken}`)
    .field('category', 'REPORT')
    .attach('file', pdfFixture(), {
      filename: 'informe-a.pdf',
      contentType: 'application/pdf',
    })
    .expect(201);

  // DX-233: horario de la dentista de A en su sede nueva y una excepción.
  await api(app, a, 'put', `/providers/${dentist.userId}/schedule`, {
    locations: [
      {
        locationId: location.id,
        ranges: [{ weekday: 1, startMinute: 480, endMinute: 780 }],
      },
    ],
  }).expect(200);
  const providerOverride = await create(
    app,
    a,
    `/providers/${dentist.userId}/schedule-overrides`,
    {
      locationId: location.id,
      date: futureAt(90, 15).slice(0, 10),
      ranges: [],
      note: 'Congreso',
    },
  );

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
    payerId: payer.id,
    scheduleBlockId: scheduleBlock.id,
    waitlistEntryId: waitlistEntry.id,
    noteTemplateId: noteTemplate.id,
    waitlistOfferId: waitlistOffer.id,
    responsiblePartyId: responsibleParty.id,
    coverageId: coverage.id,
    cashSessionId: cashSession.id,
    postOpTemplateId: postOpTemplate.id,
    postOpDeliveryId: (postOpDelivery.body as { delivery: IdBody }).delivery.id,
    providerOverrideId: providerOverride.id,
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
    const sedesB = await api(app, clinicB, 'get', '/locations').expect(200);
    b = {
      ...(await seedClinicData(app, clinicB, '9101')),
      locationId: (sedesB.body as IdBody[])[0].id,
    };
    tables = await clinicTables(raw);
    // La invitación de A encola su email (DX-088): se espera a que el
    // despachador lo deje SENT para que la fotografía no cambie por él.
    await app.get(EmailDispatcher).whenIdle();
  });

  afterAll(async () => {
    // El documento de A (DX-151) quedó en el almacén de disco de los e2e.
    await fs.rm(
      path.join(
        process.env.STORAGE_DIR ?? './storage-test',
        'patient-documents',
        clinicA.tenantId,
      ),
      { recursive: true, force: true },
    );
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
      // DX-233: horario de los profesionales y excepciones.
      'provider_schedules',
      'provider_schedule_ranges',
      'provider_schedule_overrides',
      'clinic_memberships',
      'clinic_invitations',
      // DX-089: sedes permitidas de la dentista de A.
      'membership_locations',
      'email_outbox',
      'tenant_domains',
      'prescription_templates',
      // DX-153: pagadores.
      'payers',
      'patient_coverages',
      // DX-170: plantillas de evolución y sus preguntas.
      'clinical_note_templates',
      'clinical_note_template_prompts',
      // DX-150: cobranza.
      'collection_notes',
      'payment_promises',
      // DX-203: responsables de pago y avisos.
      'patient_responsible_parties',
      'location_reminder_settings',
      // DX-027: caja por turno.
      'cash_sessions',
      'cash_session_floats',
      'cash_session_closings',
      'cash_session_closing_lines',
      // DX-222: indicaciones postoperatorias (plantillas, vínculos y entregas).
      'post_op_instruction_templates',
      'post_op_instruction_template_links',
      'post_op_instruction_deliveries',
      // DX-151: un documento del paciente subido por la API.
      'patient_documents',
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
    // DX-128: bloque «Comunicaciones» de la ficha.
    {
      name: 'GET /patients/:id/communication',
      verb: 'get',
      path: () => `/patients/${a.patientId}/communication`,
      status: 404,
    },
    {
      name: 'PATCH /patients/:id/communication',
      verb: 'patch',
      path: () => `/patients/${a.patientId}/communication`,
      body: () => ({ contactChannel: 'NONE', reminderOptOut: true }),
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
    // DX-247: las banderas médicas y «Sin cambios hoy» del paciente de A.
    {
      name: 'GET /patients/:patientId/medical-alerts',
      verb: 'get',
      path: () => `/patients/${a.patientId}/medical-alerts`,
      status: 404,
    },
    {
      name: 'POST /patients/:patientId/medical-history/no-changes',
      verb: 'post',
      path: () => `/patients/${a.patientId}/medical-history/no-changes`,
      body: () => ({}),
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
    // DX-204: «Descuento %» en bloque sobre un plan y un ítem de A.
    {
      name: 'POST /treatment-plans/:id/items/bulk-discount',
      verb: 'post',
      path: () => `/treatment-plans/${a.planId}/items/bulk-discount`,
      body: () => ({ itemIds: [a.planItemId], percent: 5 }),
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
    // --- payers (DX-153) ---
    {
      name: 'PATCH /payers/:id',
      verb: 'patch',
      path: () => `/payers/${a.payerId}`,
      body: () => ({ name: 'Hackeado', active: false }),
      status: 404,
    },
    {
      name: 'DELETE /payers/:id',
      verb: 'delete',
      path: () => `/payers/${a.payerId}`,
      status: 404,
    },
    // --- responsables de pago y avisos (DX-203) ---
    {
      name: 'GET /patients/:patientId/responsible-parties',
      verb: 'get',
      path: () => `/patients/${a.patientId}/responsible-parties`,
      status: 404,
    },
    {
      name: 'POST /patients/:patientId/responsible-parties',
      verb: 'post',
      path: () => `/patients/${a.patientId}/responsible-parties`,
      body: () => ({ fullName: 'Intrusa', relationship: 'OTHER' }),
      status: 404,
    },
    {
      name: 'PATCH /patients/:patientId/responsible-parties/:partyId',
      verb: 'patch',
      path: () =>
        `/patients/${a.patientId}/responsible-parties/${a.responsiblePartyId}`,
      body: () => ({ isPayer: false, receivesNotices: false }),
      status: 404,
    },
    {
      name: 'DELETE /patients/:patientId/responsible-parties/:partyId',
      verb: 'delete',
      path: () =>
        `/patients/${a.patientId}/responsible-parties/${a.responsiblePartyId}`,
      status: 404,
    },
    // --- coberturas del paciente (DX-153) ---
    {
      name: 'GET /patients/:patientId/coverages',
      verb: 'get',
      path: () => `/patients/${a.patientId}/coverages`,
      status: 404,
    },
    {
      name: 'POST /patients/:patientId/coverages',
      verb: 'post',
      path: () => `/patients/${a.patientId}/coverages`,
      body: () => ({ payerId: a.payerId }),
      status: 404,
    },
    {
      name: 'PATCH /patients/:patientId/coverages/:coverageId',
      verb: 'patch',
      path: () => `/patients/${a.patientId}/coverages/${a.coverageId}`,
      body: () => ({ planName: 'Intrusa' }),
      status: 404,
    },
    {
      name: 'DELETE /patients/:patientId/coverages/:coverageId',
      verb: 'delete',
      path: () => `/patients/${a.patientId}/coverages/${a.coverageId}`,
      status: 404,
    },
    // --- caja por turno (DX-027) ---
    {
      name: 'GET /cash-sessions/:id',
      verb: 'get',
      path: () => `/cash-sessions/${a.cashSessionId}`,
      status: 404,
    },
    {
      name: 'POST /cash-sessions/:id/close',
      verb: 'post',
      path: () => `/cash-sessions/${a.cashSessionId}/close`,
      body: () => ({ counts: [], differenceReason: 'Intrusa' }),
      status: 404,
    },
    {
      name: 'POST /cash-sessions/:id/reopen',
      verb: 'post',
      path: () => `/cash-sessions/${a.cashSessionId}/reopen`,
      body: () => ({ reason: 'Intrusa' }),
      status: 404,
    },
    {
      name: 'POST /cash-sessions/:id/adjustments',
      verb: 'post',
      path: () => `/cash-sessions/${a.cashSessionId}/adjustments`,
      body: () => ({
        currency: 'USD',
        method: 'CASH',
        amount: -10,
        reason: 'Intrusa',
      }),
      status: 404,
    },
    // --- cobranza (DX-150) ---
    {
      name: 'GET /patients/:id/collections',
      verb: 'get',
      path: () => `/patients/${a.patientId}/collections`,
      status: 404,
    },
    {
      name: 'POST /patients/:id/collection-notes',
      verb: 'post',
      path: () => `/patients/${a.patientId}/collection-notes`,
      body: () => ({ channel: 'CALL', outcome: 'NO_ANSWER', text: 'Intrusa' }),
      status: 404,
    },
    {
      name: 'POST /patients/:id/payment-promises',
      verb: 'post',
      path: () => `/patients/${a.patientId}/payment-promises`,
      body: () => ({
        amount: 1000,
        currency: 'COP',
        dueDate: futureAt(10, 15).slice(0, 10),
      }),
      status: 404,
    },
    // --- clinical-note-templates (DX-170) ---
    {
      name: 'PATCH /clinical-note-templates/:id',
      verb: 'patch',
      path: () => `/clinical-note-templates/${a.noteTemplateId}`,
      body: () => ({ name: 'Hackeada', active: false }),
      status: 404,
    },
    // La evolución de B no puede colgarse de la cita ni de la plantilla de A
    // (contra el paciente de A: patient-tenant-fk.e2e-spec.ts).
    {
      name: 'POST /patients/:patientId/clinical-entries (cita de A)',
      verb: 'post',
      path: () => `/patients/${b.patientId}/clinical-entries`,
      body: () => ({ notes: 'Intento', appointmentId: a.appointmentId }),
      status: 404,
    },
    {
      name: 'POST /patients/:patientId/clinical-entries (plantilla de A)',
      verb: 'post',
      path: () => `/patients/${b.patientId}/clinical-entries`,
      body: () => ({ templateId: a.noteTemplateId, answers: [] }),
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
    // --- «Ocupar este hueco» (DX-210) ---
    {
      name: 'GET /appointments/openings/:locationId/candidates',
      verb: 'get',
      path: () =>
        `/appointments/openings/${a.locationId}/candidates?start=${encodeURIComponent(futureAt(61, 15))}&end=${encodeURIComponent(futureAt(61, 16))}`,
      status: 404,
    },
    {
      name: 'POST /appointments/openings/:locationId/offers',
      verb: 'post',
      path: () => `/appointments/openings/${a.locationId}/offers`,
      body: () => ({
        slotStart: futureAt(61, 15),
        slotEnd: futureAt(61, 16),
        providerId: clinicB.adminUserId,
        patientId: b.patientId,
        channel: 'PHONE',
      }),
      status: 404,
    },
    {
      name: 'PATCH /appointments/openings/offers/:id',
      verb: 'patch',
      path: () => `/appointments/openings/offers/${a.waitlistOfferId}`,
      body: () => ({ outcome: 'ACCEPTED' }),
      status: 404,
    },
    {
      name: 'PATCH /appointments/:id/opening',
      verb: 'patch',
      path: () => `/appointments/${a.appointmentId}/opening`,
      body: () => ({ start: futureAt(62, 15) }),
      status: 404,
    },
    // --- Horario de cada profesional por sede (DX-233) ---
    {
      name: 'GET /providers/:providerId/schedule',
      verb: 'get',
      path: () => `/providers/${a.dentistUserId}/schedule`,
      status: 404,
    },
    {
      name: 'PUT /providers/:providerId/schedule',
      verb: 'put',
      path: () => `/providers/${a.dentistUserId}/schedule`,
      body: () => ({ locations: [] }),
      status: 404,
    },
    {
      name: 'GET /providers/:providerId/schedule-overrides',
      verb: 'get',
      path: () => `/providers/${a.dentistUserId}/schedule-overrides`,
      status: 404,
    },
    {
      name: 'POST /providers/:providerId/schedule-overrides',
      verb: 'post',
      path: () => `/providers/${a.dentistUserId}/schedule-overrides`,
      body: () => ({
        locationId: b.locationId,
        date: futureAt(91, 15).slice(0, 10),
        ranges: [],
      }),
      status: 404,
    },
    {
      // Con un profesional de B: la excepción de A «no existe» para B.
      name: 'DELETE /providers/:providerId/schedule-overrides/:overrideId',
      verb: 'delete',
      path: () =>
        `/providers/${clinicB.adminUserId}/schedule-overrides/${a.providerOverrideId}`,
      status: 404,
    },
    {
      name: 'DELETE /providers/:providerId/schedule-overrides/:overrideId (profesional de A)',
      verb: 'delete',
      path: () =>
        `/providers/${a.dentistUserId}/schedule-overrides/${a.providerOverrideId}`,
      status: 404,
    },
    // --- Flujo del paciente en la clínica (DX-200) ---
    {
      name: 'POST /appointments/:id/undo-arrival',
      verb: 'post',
      path: () => `/appointments/${a.appointmentId}/undo-arrival`,
      status: 404,
    },
    {
      // El panel de la sede de A: la sede ajena se rechaza antes del handler.
      name: 'GET /appointments/in-clinic con X-Location-Id de A',
      verb: 'get',
      path: () => '/appointments/in-clinic',
      locationId: () => a.locationId,
      status: 400,
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
    {
      // DX-089: leer las sedes permitidas de un miembro de A desde B.
      name: 'GET /staff/:userId/locations',
      verb: 'get',
      path: () => `/staff/${a.dentistUserId}/locations`,
      status: 404,
    },
    {
      // DX-089: restringir a un miembro de A a una sede de B.
      name: 'PUT /staff/:userId/locations',
      verb: 'put',
      path: () => `/staff/${a.dentistUserId}/locations`,
      body: () => ({ locationIds: [b.locationId] }),
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
    // --- indicaciones postoperatorias (DX-222) ---
    {
      name: 'PATCH /post-op-templates/:id',
      verb: 'patch',
      path: () => `/post-op-templates/${a.postOpTemplateId}`,
      body: () => ({ title: 'Hackeada', active: false }),
      status: 404,
    },
    {
      name: 'GET /appointments/:appointmentId/post-op-instructions',
      verb: 'get',
      path: () => `/appointments/${a.appointmentId}/post-op-instructions`,
      status: 404,
    },
    {
      // Entregar en la cita de A (con la plantilla de A) desde B.
      name: 'POST /appointments/:appointmentId/post-op-instructions/deliveries',
      verb: 'post',
      path: () =>
        `/appointments/${a.appointmentId}/post-op-instructions/deliveries`,
      body: () => ({ templateId: a.postOpTemplateId, channel: 'PRINT' }),
      status: 404,
    },
    {
      name: 'GET /patients/:patientId/post-op-deliveries',
      verb: 'get',
      path: () => `/patients/${a.patientId}/post-op-deliveries`,
      status: 404,
    },
    {
      name: 'GET /patients/:patientId/post-op-deliveries/:id',
      verb: 'get',
      path: () =>
        `/patients/${a.patientId}/post-op-deliveries/${a.postOpDeliveryId}`,
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
    // SEC-009: B no puede borrar el dominio de A.
    {
      name: 'DELETE /domains/:id',
      verb: 'delete',
      path: () => `/domains/${a.domainId}`,
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
    // DX-191: B → 404 sobre el paciente y el implante de A, y la búsqueda por
    // lote no devuelve los de A.
    'GET /patients/:patientId/implants': 'implants.e2e-spec.ts',
    'POST /patients/:patientId/implants': 'implants.e2e-spec.ts',
    'GET /patients/:patientId/implant-card': 'implants.e2e-spec.ts',
    'POST /patients/:patientId/implant-card/print': 'implants.e2e-spec.ts',
    'POST /implants/:id/void': 'implants.e2e-spec.ts',
    // DX-151: B → 404 en lista, detalle, URL, subida y anulación del documento
    // de A, sin cambios en sus filas.
    'POST /patients/:patientId/documents': 'patient-documents.e2e-spec.ts',
    'GET /patients/:patientId/documents': 'patient-documents.e2e-spec.ts',
    'GET /patients/:patientId/documents/:id': 'patient-documents.e2e-spec.ts',
    'GET /patients/:patientId/documents/:id/url/inline':
      'patient-documents.e2e-spec.ts',
    'GET /patients/:patientId/documents/:id/url/download':
      'patient-documents.e2e-spec.ts',
    'POST /patients/:patientId/documents/:id/void':
      'patient-documents.e2e-spec.ts',
    'GET /patients/:patientId/account-statement':
      'account-statement.e2e-spec.ts',
    // DX-203: B → 404 sobre el pagador de A (y el familiar no suma de otra).
    'GET /patients/:patientId/family-account-statement':
      'patient-responsible-parties.e2e-spec.ts',
    'GET /patients/:patientId/billable-plans': 'billable-plans.e2e-spec.ts',
    // DX-212: B → 404 sobre la evolución de A.
    'GET /clinical-entries/:id/rda-readiness': 'rda-codes.e2e-spec.ts',
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
          // El precio de catálogo (100): sin rebaja, no es un descuento
          // (SEC-041).
          price: 100,
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
