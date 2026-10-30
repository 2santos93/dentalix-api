import { INestApplication } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  Prisma,
  PrismaClient,
  Sex,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
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
import {
  ID_INPUTS_IN_MATRIX,
  TENANT_ISOLATION_MATRIX_SPEC,
} from './support/tenant-id-inputs';
import { CapturingMailer } from './support/capture-mailer';
import { EmailDispatcher } from '../src/modules/notifications/email/application/email-dispatcher.service';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { CONFIRMATION_LINK_NOT_FOUND_MESSAGE } from '../src/modules/appointment-confirmations/application/find-confirmation-by-token';
import {
  LOCATION_BY_REQUEST_MESSAGE,
  PERFORMED_LOCATION_NOT_FOUND_MESSAGE,
} from '../src/modules/treatment-plans/domain/plan-item-attribution';
import { clinicTables, TenantTable } from './support/tenant-tables';
import { pdfFixture } from './support/document-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationBody,
} from './support/location-fixtures';

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
 *
 * DX-207 (TST-022): también los ids que llegan por la QUERY o el CUERPO. Los
 * casos `queryIds`/`bodyIds` mandan, sobre una ruta y unos recursos de B, UN
 * id de A en el campo nombrado (el resto, de B): se exige un 400/404 con el
 * mensaje exacto en español o una lectura sin filas de A, y la misma
 * fotografía. Las rutas públicas por `:token` (y el restablecer contraseña,
 * con el token en el cuerpo) se atacan sin sesión en el host de B con el
 * token de A: 404 y nada de A cambia (tampoco sus `user_tokens`).
 */

// PNG real de 1x1 con un píxel visible (la API rechaza una firma en blanco).
const SIGNATURE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
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

/** DX-207: petición pública (sin sesión) en el host de una clínica. */
function publicRequest(
  app: INestApplication<App>,
  clinic: Clinic,
  verb: Verb,
  path: string,
  body?: object,
): request.Test {
  const req = request(app.getHttpServer())
    [verb](`/api/v1${path}`)
    .set('X-Tenant-Host', clinic.host);
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
  // DX-207: el token de restablecer de un miembro de A no tiene `tenantId`;
  // usarlo desde el host de B no puede gastarlo ni invalidarlo.
  shot.userTokens = await raw.userToken.findMany({
    where: { user: { memberships: { some: { tenantId: tenantA } } } },
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
  /**
   * DX-207: ids de A que B manda por la query o el cuerpo, con el nombre que
   * les da `test/support/uuid-inputs.ts` (`providerIds[]`,
   * `items[].catalogItemId`...). La ruta es el `MÉTODO /ruta` del nombre.
   */
  queryIds?: string[];
  bodyIds?: string[];
  /** DX-207: el `message` exacto del error (en español). */
  message?: string | (() => string);
  /** DX-207: comprobación de una lectura 200 (ninguna fila de A). */
  expectBody?: (body: unknown, text: string) => void;
  /** DX-207: ruta pública (sin sesión) en el host de B. */
  public?: boolean;
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
  /** DX-274: un gasto de A con un pago, y una categoría propia de A. */
  expenseId: string;
  expensePaymentId: string;
  expenseCategoryId: string;
  /** DX-105: una lista de precios de A con un precio cargado. */
  priceListId: string;
  /** DX-105: un convenio de A por lista de precios. */
  agreementId: string;
  scheduleBlockId: string;
  waitlistEntryId: string;
  noteTemplateId: string;
  waitlistOfferId: string;
  /** DX-203: un responsable (contacto) del paciente de A. */
  responsiblePartyId: string;
  coverageId: string;
  /** DX-105: la asignación del convenio al paciente de A (creada por la API). */
  patientAgreementId: string;
  /** Caja por turno cerrada de A (DX-027). */
  cashSessionId: string;
  /** DX-222: plantilla de indicaciones de A (con vínculo) y una entrega. */
  postOpTemplateId: string;
  postOpDeliveryId: string;
  /** DX-233: excepción por fecha del horario de la dentista de A. */
  providerOverrideId: string;
  /** DX-207: una evolución de A, su política de datos y una pregunta. */
  clinicalEntryId: string;
  privacyPolicyId: string;
  notePromptId: string;
  /** DX-207: token del enlace de confirmación de la cita de A. */
  confirmationToken: string;
  /** DX-316: un festivo de la sede nueva de A (y su fila de calendario). */
  holidayId: string;
}

interface SeedB {
  patientId: string;
  catalogItemId: string;
  /**
   * Sede propia de B (DX-089: B intenta restringir a un miembro de A a ella;
   * DX-233: cuerpo de las excepciones).
   */
  locationId: string;
  /** DX-050: plan propio de B con un ítem aceptado (B lo marca realizado). */
  planId: string;
  planItemId: string;
  /**
   * DX-207: recursos propios de B sobre los que B manda UN id de A por la
   * query o el cuerpo (así el 400/404 solo puede venir de ese id).
   */
  payerId: string;
  coverageId: string;
  priceListId: string;
  agreementId: string;
  appointmentId: string;
  waitlistEntryId: string;
  dentistUserId: string;
  postOpTemplateId: string;
  consentTemplateId: string;
  noteTemplateId: string;
  /** Segundo paciente de B, fuera de pendientes (el primero ya está). */
  secondPatientId: string;
  /** DX-051: abono propio de B y la versión de su imputación (PUT de B). */
  paymentId: string;
  allocationVersion: string;
}

function futureAt(daysAhead: number, hourUtc: number): string {
  const date = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date.toISOString();
}

/** DX-207: día civil (YYYY-MM-DD) a `daysAhead` días (negativo: pasado). */
function day(daysAhead: number): string {
  return futureAt(daysAhead, 12).slice(0, 10);
}

/** DX-207: instante ISO de las 00:00 UTC a `daysAhead` días, para la query. */
function isoDay(daysAhead: number): string {
  return encodeURIComponent(futureAt(daysAhead, 0));
}

async function seedClinicData(
  app: INestApplication<App>,
  clinic: Clinic,
  docNumber: string,
): Promise<{ patientId: string; catalogItemId: string }> {
  const patient = await create(app, clinic, '/patients', {
    firstName: 'Paciente',
    lastName: clinic.subdomain,
    docType: 'NATIONAL_ID',
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
  const location = await create(
    app,
    a,
    '/locations',
    locationBody(REGIONAL_BOGOTA_FIXTURE, { name: 'Sede Norte A' }),
  );
  // Recordatorios por sede (DX-026): A los activa en su sede nueva.
  await api(app, a, 'put', `/reminder-settings/${location.id}`, {
    enabled: true,
    leadHours: [48, 2],
  }).expect(200);
  // DX-279: política de cancelación de la sede nueva de A.
  const cancellationPolicy = await create(
    app,
    a,
    `/locations/${location.id}/cancellation-policy`,
    {
      noticeHours: 24,
      suggestedFee: 50000,
      currency: 'COP',
      patientText: 'Avísanos con 24 horas.',
    },
  );
  // DX-291: una inasistencia de A con su cargo (fila en cancellation_fees y
  // plan «Cargos administrativos»).
  const noShowStart = new Date(Date.now() - 72 * 3_600_000);
  const noShow = await raw.appointment.create({
    data: {
      tenantId: a.tenantId,
      locationId: location.id,
      patientId,
      providerId: randomUUID(),
      start: noShowStart,
      end: new Date(noShowStart.getTime() + 30 * 60_000),
      status: 'NO_SHOW',
      noShowMarkedAt: new Date(),
      policyVersionId: cancellationPolicy.id,
    },
  });
  await create(app, a, `/appointments/${noShow.id}/cancellation-fee`, {});
  // DX-316: un festivo en el calendario de la sede nueva de A (la fila de
  // location_working_calendars la crea el trigger del alta).
  const holiday = await create(app, a, `/locations/${location.id}/holidays`, {
    date: '2027-05-03',
    name: 'Cierre anual de A',
  });
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
    type: 'EMPLOYER',
  });

  // DX-274: una categoría propia, un gasto de A (con esa categoría) y un pago.
  const expenseCategory = await create(app, a, '/expense-categories', {
    name: 'Seguros de A',
  });
  const expense = await create(app, a, '/expenses', {
    category: 'Seguros de A',
    supplier: 'Proveedor de A',
    description: 'Póliza anual de A',
    amount: 100000,
    currency: 'COP',
    invoiceDate: '2026-01-15',
  });
  const expensePaid = (
    await api(app, a, 'post', `/expenses/${expense.id}/payments`, {
      amount: 40000,
      method: 'TRANSFER',
    }).expect(201)
  ).body as { payments: IdBody[] };

  // DX-105: una lista de precios de A con un precio (para `price_list_items`).
  const priceList = await create(app, a, '/price-lists', {
    name: 'Lista de A',
    currency: 'COP',
  });
  await api(app, a, 'put', `/price-lists/${priceList.id}/items`, {
    items: [{ catalogItemId, price: 90000 }],
  }).expect(200);

  // DX-105: un convenio de A (pagador + lista de precios).
  const agreement = await create(app, a, '/agreements', {
    name: 'Convenio de A',
    payerId: payer.id,
    kind: 'PRICE_LIST',
    priceListId: priceList.id,
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

  // DX-105: el convenio de A asignado al paciente de A, con su cobertura.
  const patientAgreement = (
    await api(app, a, 'put', `/patients/${patientId}/agreement`, {
      agreementId: agreement.id,
      coverageId: coverage.id,
    }).expect(200)
  ).body as IdBody;

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

  // DX-207: una evolución de A (para `clinicalEntryId`), su política de
  // tratamiento de datos (para `dataConsents.policyVersionId`) y el enlace de
  // confirmación de su cita (token público).
  const clinicalEntry = await create(
    app,
    a,
    `/patients/${patientId}/clinical-entries`,
    { notes: 'Evolución de A' },
  );
  await create(app, a, '/privacy-policies', {
    policyText: 'Política de tratamiento de datos de A (Ley 1581).',
    generalText: 'Autorizo el tratamiento de mis datos personales.',
    sensitiveHealthText:
      'Autorizo el tratamiento de mis datos sensibles de salud (historia clínica). No está obligado a autorizarlo. Finalidad: la atención odontológica.',
    marketingText: 'Autorizo recibir comunicaciones comerciales.',
  });
  const policies = await api(app, a, 'get', '/privacy-policies').expect(200);
  const link = await api(
    app,
    a,
    'post',
    `/appointments/${appointment.id}/confirmation-link`,
    {},
  ).expect(201);
  const notePrompt = await raw.clinicalNoteTemplatePrompt.findFirstOrThrow({
    where: { templateId: noteTemplate.id },
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
    payerId: payer.id,
    expenseId: expense.id,
    expensePaymentId: expensePaid.payments[0].id,
    expenseCategoryId: expenseCategory.id,
    priceListId: priceList.id,
    agreementId: agreement.id,
    scheduleBlockId: scheduleBlock.id,
    waitlistEntryId: waitlistEntry.id,
    noteTemplateId: noteTemplate.id,
    waitlistOfferId: waitlistOffer.id,
    responsiblePartyId: responsibleParty.id,
    coverageId: coverage.id,
    patientAgreementId: patientAgreement.id,
    cashSessionId: cashSession.id,
    postOpTemplateId: postOpTemplate.id,
    postOpDeliveryId: (postOpDelivery.body as { delivery: IdBody }).delivery.id,
    providerOverrideId: providerOverride.id,
    holidayId: holiday.id,
    clinicalEntryId: clinicalEntry.id,
    privacyPolicyId: (policies.body as { current: IdBody }).current.id,
    notePromptId: notePrompt.id,
    confirmationToken: (link.body as { url: string }).url.split(
      '/confirmar/',
    )[1],
  };
}

/** DX-207: recursos propios de B para los casos de ids por query/cuerpo. */
async function seedBExtras(
  app: INestApplication<App>,
  b: Clinic,
  patientId: string,
): Promise<
  Omit<
    SeedB,
    | 'patientId'
    | 'catalogItemId'
    | 'locationId'
    | 'planId'
    | 'planItemId'
    | 'paymentId'
    | 'allocationVersion'
  >
> {
  await api(app, b, 'put', '/locations/schedule', {
    ranges: [],
  }).expect(200);
  const payer = await create(app, b, '/payers', {
    name: 'Pagador de B',
    type: 'EMPLOYER',
  });
  const coverage = await create(app, b, `/patients/${patientId}/coverages`, {
    payerId: payer.id,
    memberNumber: 'EMP-00042',
  });
  const priceList = await create(app, b, '/price-lists', {
    name: 'Lista de B',
    currency: 'COP',
  });
  const agreement = await create(app, b, '/agreements', {
    name: 'Convenio de B',
    payerId: payer.id,
    kind: 'PERCENT_DISCOUNT',
    percent: 10,
  });
  // Pide adelantar: `PATCH /appointments/:id/opening` la acepta.
  const appointment = await create(app, b, '/appointments', {
    patientId,
    providerId: b.adminUserId,
    start: futureAt(8, 15),
    end: futureAt(8, 16),
    reason: 'Control de B',
    wantsEarlier: true,
  });
  const waitlistEntry = await create(app, b, '/waitlist', { patientId });
  const dentist = await seedMember(raw, b, ClinicRole.DENTIST);
  const postOpTemplate = await create(app, b, '/post-op-templates', {
    code: 'POI-B',
    title: 'Indicaciones de B',
    body: 'Hola {{paciente}}.',
  });
  const consentTemplate = await create(app, b, '/consent-templates', {
    title: 'Consentimiento de B',
    body: 'Yo, {{paciente}}, autorizo.',
  });
  const secondPatient = await create(app, b, '/patients', {
    firstName: 'Segunda',
    lastName: 'Paciente de B',
    docType: 'NATIONAL_ID',
    docNumber: '9102',
    sex: Sex.F,
  });
  // Con su propia política publicada, la de A no es «la vigente» de B.
  await create(app, b, '/privacy-policies', {
    policyText: 'Política de tratamiento de datos de B (Ley 1581).',
    generalText: 'Autorizo el tratamiento de mis datos personales.',
    sensitiveHealthText:
      'Autorizo el tratamiento de mis datos sensibles de salud (historia clínica). No está obligado a autorizarlo. Finalidad: la atención odontológica.',
    marketingText: 'Autorizo recibir comunicaciones comerciales.',
  });
  const noteTemplate = await create(app, b, '/clinical-note-templates', {
    name: 'Plantilla de B',
    body: 'Superficie {{Superficie}}',
    prompts: [{ label: 'Superficie', type: 'ONE', options: ['O', 'M'] }],
  });
  return {
    payerId: payer.id,
    coverageId: coverage.id,
    priceListId: priceList.id,
    agreementId: agreement.id,
    appointmentId: appointment.id,
    waitlistEntryId: waitlistEntry.id,
    dentistUserId: dentist.userId,
    postOpTemplateId: postOpTemplate.id,
    consentTemplateId: consentTemplate.id,
    noteTemplateId: noteTemplate.id,
    secondPatientId: secondPatient.id,
  };
}

describe('Tenant isolation matrix (e2e, DX-068)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let a: SeedA;
  let b: SeedB;
  let tables: TenantTable[];
  // DX-207: los tokens de invitación y de restablecer de A solo viajan por
  // email; se leen del transporte, como lo haría su destinatario.
  const mailer = new CapturingMailer();
  let invitationTokenA: string;
  let resetTokenA: string;
  const shotOfA = (): Promise<Record<string, unknown>> =>
    snapshot(tables, clinicA.tenantId, clinicB.tenantId);
  /** DX-207: los ids de A sembrados (ninguno puede salir en una respuesta a B). */
  const idsOfA = (): string[] => [
    clinicA.adminUserId,
    ...Object.values(a as unknown as Record<string, string>).filter((v) =>
      /^[0-9a-f-]{36}$/.test(v),
    ),
  ];

  beforeAll(async () => {
    app = await createE2eApp((builder) =>
      builder.overrideProvider(MAILER).useValue(mailer),
    );
    await resetDatabase(raw);
    clinicA = await registerClinic(app, 'clinica-aislada-a');
    clinicB = await registerClinic(app, 'clinica-aislada-b');
    a = await seedA(app, clinicA);
    const sedesB = await api(app, clinicB, 'get', '/locations').expect(200);
    const dataB = await seedClinicData(app, clinicB, '9101');
    const planB = await create(
      app,
      clinicB,
      `/patients/${dataB.patientId}/treatment-plans`,
      { currency: 'USD' },
    );
    const itemB = await create(
      app,
      clinicB,
      `/treatment-plans/${planB.id}/items`,
      {
        toothNumber: '21',
        catalogItemId: dataB.catalogItemId,
        price: 100,
      },
    );
    await api(
      app,
      clinicB,
      'patch',
      `/treatment-plans/${planB.id}/items/${itemB.id}`,
      {
        status: 'ACCEPTED',
      },
    ).expect(200);
    // DX-051: B cobra en su plan (el reparto lo imputa a su ítem) y lee la
    // versión de esa imputación, para mandar luego un ítem de A en su PUT.
    // Cobrado hace 10 días: fuera del período de la caja que B consulta.
    const paymentB = await create(
      app,
      clinicB,
      `/treatment-plans/${planB.id}/payments`,
      {
        amount: 40,
        currency: 'USD',
        paidAt: futureAt(-10, 15),
        method: 'CASH',
      },
    );
    const allocationsB = await api(
      app,
      clinicB,
      'get',
      `/payments/${paymentB.id}/allocations`,
    ).expect(200);
    b = {
      ...dataB,
      locationId: (sedesB.body as IdBody[])[0].id,
      planId: planB.id,
      planItemId: itemB.id,
      paymentId: paymentB.id,
      allocationVersion: (allocationsB.body as { version: string }).version,
      ...(await seedBExtras(app, clinicB, dataB.patientId)),
    };
    tables = await clinicTables(raw);
    invitationTokenA = await mailer.invitationToken('invitada@a.test');
    const ownerA = `owner@${clinicA.subdomain}.test`;
    await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .set('X-Tenant-Host', clinicA.host)
      .send({ email: ownerA })
      .expect(202);
    resetTokenA = (
      await mailer.waitFor(ownerA, /\/restablecer\/([A-Za-z0-9_-]{43})/)
    )[1];
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
      // DX-051: base, imputación e historial del abono de A.
      'payment_plan_amounts',
      'payment_allocations',
      'payment_allocation_movements',
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
      // DX-105: listas de precios y sus precios.
      'price_lists',
      'price_list_items',
      // DX-105: convenios.
      'agreements',
      'patient_agreements',
      // DX-170: plantillas de evolución y sus preguntas.
      'clinical_note_templates',
      'clinical_note_template_prompts',
      // DX-150: cobranza.
      'collection_notes',
      'payment_promises',
      // DX-203: responsables de pago y avisos.
      'patient_responsible_parties',
      'location_reminder_settings',
      // DX-279: versiones de la política de cancelación.
      'cancellation_policy_versions',
      // DX-316: calendario de la sede nueva de A y su festivo.
      'location_working_calendars',
      'location_holidays',
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
      // DX-274: gasto, pago y categoría propia de A.
      'expenses',
      'expense_payments',
      'expense_categories',
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
    // --- política de cancelación y asistencia (DX-279) ---
    {
      name: 'GET /locations/:id/cancellation-policy',
      verb: 'get',
      path: () => `/locations/${a.locationId}/cancellation-policy`,
      status: 404,
    },
    {
      name: 'POST /locations/:id/cancellation-policy',
      verb: 'post',
      path: () => `/locations/${a.locationId}/cancellation-policy`,
      body: () => ({ noticeHours: 1, patientText: 'Hackeada' }),
      status: 404,
    },
    {
      name: 'GET /appointments/:id/cancellation-preview',
      verb: 'get',
      path: () => `/appointments/${a.appointmentId}/cancellation-preview`,
      status: 404,
    },
    {
      name: 'GET /patients/:id/attendance-summary',
      verb: 'get',
      path: () => `/patients/${a.patientId}/attendance-summary`,
      status: 404,
    },
    // --- cargo por inasistencia y vista previa del email (DX-291) ---
    {
      name: 'GET /appointments/:id/cancellation-fee',
      verb: 'get',
      path: () => `/appointments/${a.appointmentId}/cancellation-fee`,
      status: 404,
    },
    {
      name: 'POST /appointments/:id/cancellation-fee',
      verb: 'post',
      path: () => `/appointments/${a.appointmentId}/cancellation-fee`,
      body: () => ({}),
      status: 404,
    },
    {
      name: 'POST /appointments/:id/cancellation-fee/waive',
      verb: 'post',
      path: () => `/appointments/${a.appointmentId}/cancellation-fee/waive`,
      body: () => ({ reason: 'Intento ajeno' }),
      status: 404,
    },
    // SEC-050: anular el cargo de A desde B.
    {
      name: 'POST /appointments/:id/cancellation-fee/void',
      verb: 'post',
      path: () => `/appointments/${a.appointmentId}/cancellation-fee/void`,
      body: () => ({ reason: 'Intento ajeno' }),
      status: 404,
    },
    {
      name: 'GET /locations/:id/cancellation-policy/email-preview',
      verb: 'get',
      path: () =>
        `/locations/${a.locationId}/cancellation-policy/email-preview`,
      status: 404,
    },
    // --- calendario de la sede (DX-316): la sede de A no existe para B ---
    {
      name: 'GET /locations/:id/calendar',
      verb: 'get',
      path: () => `/locations/${a.locationId}/calendar`,
      status: 404,
      message: 'No encontramos esa sede.',
    },
    {
      name: 'PUT /locations/:id/calendar/working-weekdays',
      verb: 'put',
      path: () => `/locations/${a.locationId}/calendar/working-weekdays`,
      body: () => ({ workingWeekdays: [0] }),
      status: 404,
      message: 'No encontramos esa sede.',
    },
    {
      name: 'POST /locations/:id/holidays',
      verb: 'post',
      path: () => `/locations/${a.locationId}/holidays`,
      body: () => ({ date: '2027-05-04', name: 'Intruso' }),
      status: 404,
      message: 'No encontramos esa sede.',
    },
    {
      name: 'PATCH /locations/:id/holidays/:holidayId',
      verb: 'patch',
      path: () => `/locations/${a.locationId}/holidays/${a.holidayId}`,
      body: () => ({ name: 'Intruso' }),
      status: 404,
      message: 'No encontramos esa sede.',
    },
    {
      name: 'DELETE /locations/:id/holidays/:holidayId',
      verb: 'delete',
      path: () => `/locations/${a.locationId}/holidays/${a.holidayId}`,
      status: 404,
      message: 'No encontramos esa sede.',
    },
    // La sede se comprueba antes que el fichero: B recibe 404 aunque no mande
    // archivo, y no se lee nada de A.
    {
      name: 'POST /locations/:id/holidays/import/preview',
      verb: 'post',
      path: () => `/locations/${a.locationId}/holidays/import/preview`,
      status: 404,
      message: 'No encontramos esa sede.',
    },
    {
      name: 'POST /locations/:id/holidays/import',
      verb: 'post',
      path: () => `/locations/${a.locationId}/holidays/import`,
      status: 404,
      message: 'No encontramos esa sede.',
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
    // DX-050: B marca realizado SU ítem atribuyéndoselo a la dentista de A.
    // La membresía de A no existe para B (RLS): 404, y nada de A cambia (el
    // ítem de B tampoco: ver «B no puede atribuir…» abajo).
    {
      name: 'PATCH /treatment-plans/:id/items/:itemId (DX-050: realizado por un profesional de A)',
      verb: 'patch',
      path: () => `/treatment-plans/${b.planId}/items/${b.planItemId}`,
      body: () => ({ status: 'DONE', performedById: a.dentistUserId }),
      bodyIds: ['performedById'],
      status: 404,
    },
    // DX-305: B intenta registrar SU ítem como realizado en una sede de A. La
    // sede nunca llega al marcar realizado (400 antes de leer nada); la de un
    // «Sin atribuir» ya realizado se prueba en «B no puede atribuir…» abajo.
    {
      name: 'PATCH /treatment-plans/:id/items/:itemId (DX-305: realizado en una sede de A)',
      verb: 'patch',
      path: () => `/treatment-plans/${b.planId}/items/${b.planItemId}`,
      body: () => ({ status: 'DONE', performedLocationId: a.locationId }),
      bodyIds: ['performedLocationId'],
      status: 400,
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
    // DX-051: la imputación del abono de A.
    {
      name: 'GET /payments/:id/allocations',
      verb: 'get',
      path: () => `/payments/${a.paymentId}/allocations`,
      status: 404,
    },
    {
      name: 'PUT /payments/:id/allocations',
      verb: 'put',
      path: () => `/payments/${a.paymentId}/allocations`,
      body: () => ({
        expectedVersion: b.allocationVersion,
        mode: 'AUTO',
      }),
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
    // --- gastos (DX-274) ---
    {
      name: 'GET /expenses/:id',
      verb: 'get',
      path: () => `/expenses/${a.expenseId}`,
      status: 404,
    },
    {
      name: 'PATCH /expenses/:id',
      verb: 'patch',
      path: () => `/expenses/${a.expenseId}`,
      body: () => ({ description: 'Hackeado', amount: 1 }),
      status: 404,
    },
    {
      name: 'POST /expenses/:id/void',
      verb: 'post',
      path: () => `/expenses/${a.expenseId}/void`,
      body: () => ({ reason: 'Intento desde otra clínica' }),
      status: 404,
    },
    {
      name: 'POST /expenses/:id/payments',
      verb: 'post',
      path: () => `/expenses/${a.expenseId}/payments`,
      body: () => ({ amount: 1000, method: 'CARD' }),
      status: 404,
    },
    {
      name: 'POST /expenses/:id/payments/:paymentId/void',
      verb: 'post',
      path: () =>
        `/expenses/${a.expenseId}/payments/${a.expensePaymentId}/void`,
      body: () => ({ reason: 'Intento desde otra clínica' }),
      status: 404,
    },
    {
      name: 'POST /expenses/:id/attachment',
      verb: 'post',
      path: () => `/expenses/${a.expenseId}/attachment`,
      body: () => ({ uploadId: '9b2f9a6e-3f1c-4d2e-8a55-0d3f6a1b7c10' }),
      status: 404,
    },
    {
      name: 'GET /expenses/:id/attachment/url',
      verb: 'get',
      path: () => `/expenses/${a.expenseId}/attachment/url`,
      status: 404,
    },
    {
      name: 'DELETE /expense-categories/:id',
      verb: 'delete',
      path: () => `/expense-categories/${a.expenseCategoryId}`,
      status: 404,
    },
    // La lista de B no trae el gasto de A.
    {
      name: 'GET /expenses (lista de B)',
      verb: 'get',
      path: () => '/expenses',
      status: 200,
      responseBody: { items: [], total: 0, page: 1, pageSize: 50 },
    },
    // --- listas de precios (DX-105) ---
    {
      name: 'PATCH /price-lists/:id',
      verb: 'patch',
      path: () => `/price-lists/${a.priceListId}`,
      body: () => ({ name: 'Hackeado', active: false }),
      status: 404,
    },
    {
      name: 'DELETE /price-lists/:id',
      verb: 'delete',
      path: () => `/price-lists/${a.priceListId}`,
      status: 404,
    },
    {
      name: 'GET /price-lists/:id/items',
      verb: 'get',
      path: () => `/price-lists/${a.priceListId}/items`,
      status: 404,
    },
    {
      name: 'PUT /price-lists/:id/items',
      verb: 'put',
      path: () => `/price-lists/${a.priceListId}/items`,
      body: () => ({ items: [{ catalogItemId: b.catalogItemId, price: 1 }] }),
      status: 404,
    },
    // --- convenios (DX-105) ---
    {
      name: 'PATCH /agreements/:id',
      verb: 'patch',
      path: () => `/agreements/${a.agreementId}`,
      body: () => ({ name: 'Hackeado', active: false }),
      status: 404,
    },
    {
      name: 'DELETE /agreements/:id',
      verb: 'delete',
      path: () => `/agreements/${a.agreementId}`,
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
    {
      name: 'POST /patients/:patientId/coverages/:coverageId/verification',
      verb: 'post',
      path: () =>
        `/patients/${a.patientId}/coverages/${a.coverageId}/verification`,
      body: () => ({ checkedMemberNumber: 'AFI-A-0001' }),
      status: 404,
    },
    // --- convenio del paciente (DX-105) ---
    {
      name: 'GET /patients/:patientId/agreement',
      verb: 'get',
      path: () => `/patients/${a.patientId}/agreement?includeHistory=true`,
      status: 404,
    },
    {
      name: 'PUT /patients/:patientId/agreement',
      verb: 'put',
      path: () => `/patients/${a.patientId}/agreement`,
      body: () => ({ agreementId: a.agreementId }),
      status: 404,
    },
    {
      name: 'DELETE /patients/:patientId/agreement',
      verb: 'delete',
      path: () => `/patients/${a.patientId}/agreement`,
      status: 404,
    },
    // --- precio resuelto de un ítem nuevo (DX-105) ---
    {
      name: 'GET /patients/:patientId/price-quote',
      verb: 'get',
      path: () =>
        `/patients/${a.patientId}/price-quote?catalogItemId=${b.catalogItemId}&currency=USD`,
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
      bodyIds: ['appointmentId'],
      status: 404,
    },
    {
      name: 'POST /patients/:patientId/clinical-entries (plantilla de A)',
      verb: 'post',
      path: () => `/patients/${b.patientId}/clinical-entries`,
      body: () => ({ templateId: a.noteTemplateId, answers: [] }),
      bodyIds: ['templateId'],
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
      // DX-273 «Traer a esta cita» sobre una cita y un ítem de A.
      name: 'POST /appointments/:id/plan-items/:planItemId/claim',
      verb: 'post',
      path: () =>
        `/appointments/${a.appointmentId}/plan-items/${a.planItemId}/claim`,
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
    {
      // DX-014: «Comparar sedes» con la sede de A como sede activa.
      name: 'GET /reports/locations-comparison con X-Location-Id de A',
      verb: 'get',
      path: () => '/reports/locations-comparison?from=2026-10-01&to=2026-10-31',
      locationId: () => a.locationId,
      status: 400,
    },
    {
      name: 'GET /reports/locations-comparison.csv con X-Location-Id de A',
      verb: 'get',
      path: () =>
        '/reports/locations-comparison.csv?from=2026-10-01&to=2026-10-31',
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
      // DX-319: también el nº de registro sanitario y si se imprime.
      body: () => ({
        name: 'Hackeada',
        isActive: false,
        healthRegistrationNumber: 'Hackeada',
        showHealthRegistrationNumber: true,
      }),
      status: 404,
    },
    {
      // La sede ajena se rechaza en TenantContextInterceptor, antes del handler.
      name: 'PUT /locations/schedule con X-Location-Id de A',
      verb: 'put',
      path: () => '/locations/schedule',
      body: () => ({
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
        docType: 'NATIONAL_ID',
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
      name: `GET /audit-events ?${filter} de A`,
      verb: 'get',
      path: () => `/audit-events?${filter}=${id()}`,
      queryIds: [filter],
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
    // ======================================================================
    // DX-207 (TST-022): ids de A por la QUERY. La ruta y el resto de los
    // filtros son de B; la respuesta es un 400/404 con su mensaje en español
    // o una lectura sin filas de A (la fotografía la comprueba el runner).
    // ======================================================================
    {
      name: 'GET /appointments ?providerIds[] de A',
      verb: 'get',
      path: () =>
        `/appointments?from=${isoDay(0)}&to=${isoDay(30)}&providerIds=${clinicA.adminUserId}&providerIds=${a.dentistUserId}`,
      queryIds: ['providerIds[]'],
      status: 400,
      message: 'Algún profesional no pertenece a esta clínica',
    },
    // B tiene su propia cita en el rango: el filtro de A la deja fuera y la
    // de A no aparece.
    ...(
      [
        ['providerId', () => clinicA.adminUserId],
        ['locationId', () => a.locationId],
      ] as const
    ).map(([field, id]): IsolationCase => ({
      name: `GET /appointments ?${field} de A`,
      verb: 'get',
      path: () =>
        `/appointments?from=${isoDay(0)}&to=${isoDay(30)}&${field}=${id()}`,
      queryIds: [field],
      status: 200,
      responseBody: [],
    })),
    ...(
      [
        [
          'providerId',
          () => `providerId=${a.dentistUserId}&locationId=${b.locationId}`,
          'Profesional no encontrado',
        ],
        [
          'locationId',
          () => `providerId=${clinicB.adminUserId}&locationId=${a.locationId}`,
          'Sede no encontrada',
        ],
        [
          'patientId',
          () =>
            `providerId=${clinicB.adminUserId}&locationId=${b.locationId}&patientId=${a.patientId}`,
          'Paciente no encontrado',
        ],
      ] as const
    ).map(([field, query, message]): IsolationCase => ({
      name: `GET /appointments/openings ?${field} de A`,
      verb: 'get',
      path: () =>
        `/appointments/openings?from=${day(60)}&to=${day(61)}&durationMinutes=30&${query()}`,
      queryIds: [field],
      status: 404,
      message,
    })),
    {
      name: 'GET /schedule-blocks ?locationId de A',
      verb: 'get',
      path: () =>
        `/schedule-blocks?from=${isoDay(0)}&to=${isoDay(90)}&locationId=${a.locationId}`,
      queryIds: ['locationId'],
      status: 404,
      message: 'Sede no encontrada',
    },
    {
      name: 'GET /schedule-blocks ?providerIds[] de A',
      verb: 'get',
      path: () =>
        `/schedule-blocks?from=${isoDay(0)}&to=${isoDay(90)}&providerIds=${clinicA.adminUserId}&providerIds=${a.dentistUserId}`,
      queryIds: ['providerIds[]'],
      status: 404,
      message: 'Profesional no encontrado',
    },
    {
      // La cita de A cae en la franja. Con la sede y el profesional de A
      // (como lo probaría un atacante) la sede se rechaza primero…
      name: 'GET /schedule-blocks/affected-appointments ?locationId (y providerId) de A',
      verb: 'get',
      path: () =>
        `/schedule-blocks/affected-appointments?start=${isoDay(6)}&end=${isoDay(9)}&providerId=${clinicA.adminUserId}&locationId=${a.locationId}`,
      queryIds: ['locationId'],
      status: 404,
      message: 'Sede no encontrada',
    },
    {
      // …y con la sede de B, el profesional de A también.
      name: 'GET /schedule-blocks/affected-appointments ?providerId de A',
      verb: 'get',
      path: () =>
        `/schedule-blocks/affected-appointments?start=${isoDay(6)}&end=${isoDay(9)}&providerId=${clinicA.adminUserId}&locationId=${b.locationId}`,
      queryIds: ['providerId'],
      status: 404,
      message: 'Profesional no encontrado',
    },
    {
      name: 'GET /schedule/roster ?locationId de A',
      verb: 'get',
      path: () =>
        `/schedule/roster?weekStart=${day(7)}&locationId=${a.locationId}`,
      queryIds: ['locationId'],
      status: 404,
      message: 'Sede no encontrada',
    },
    {
      name: 'GET /waitlist ?locationId de A',
      verb: 'get',
      path: () => `/waitlist?locationId=${a.locationId}`,
      queryIds: ['locationId'],
      status: 404,
      message: 'Sede no encontrada',
    },
    {
      name: 'GET /appointments/openings/:locationId/candidates ?providerId de A',
      verb: 'get',
      path: () =>
        `/appointments/openings/${b.locationId}/candidates?start=${encodeURIComponent(futureAt(61, 15))}&end=${encodeURIComponent(futureAt(61, 16))}&providerId=${a.dentistUserId}`,
      queryIds: ['providerId'],
      status: 404,
      message: 'Profesional no encontrado',
    },
    ...(
      [
        ['locationId', () => a.locationId],
        ['cursor', () => a.planId],
      ] as const
    ).map(([field, id]): IsolationCase => ({
      name: `GET /treatment-plans/unscheduled ?${field} de A`,
      verb: 'get',
      path: () => `/treatment-plans/unscheduled?${field}=${id()}`,
      queryIds: [field],
      status: 200,
      responseBody: { items: [], nextCursor: null, limit: 25 },
    })),
    {
      name: 'GET /patients/:patientId/price-quote ?catalogItemId de A',
      verb: 'get',
      path: () =>
        `/patients/${b.patientId}/price-quote?catalogItemId=${a.catalogItemId}&currency=USD`,
      queryIds: ['catalogItemId'],
      status: 404,
      message: 'Procedimiento no encontrado.',
    },
    // Reportes y cartera: la sede de A se rechaza; el profesional de A
    // filtra a nada (ni una fila, ni un total).
    ...(
      [
        [
          '/reports/discounts',
          `from=${day(-30)}&to=${day(0)}&`,
          'professionalId',
        ],
        [
          '/reports/discounts.csv',
          `from=${day(-30)}&to=${day(0)}&`,
          'professionalId',
        ],
        ['/receivables/aging', '', 'providerId'],
        ['/receivables/aging.csv', '', 'providerId'],
      ] as const
    ).flatMap(([route, range, providerField]): IsolationCase[] => [
      {
        name: `GET ${route} ?locationId de A`,
        verb: 'get',
        path: () => `${route}?${range}locationId=${a.locationId}`,
        queryIds: ['locationId'],
        status: 400,
        message: 'La sede no es de esta clínica.',
      },
      {
        name: `GET ${route} ?${providerField} de A`,
        verb: 'get',
        path: () => `${route}?${range}${providerField}=${clinicA.adminUserId}`,
        queryIds: [providerField],
        status: 200,
        expectBody: (body, text) => {
          if (route.endsWith('.csv')) {
            // Solo la cabecera del CSV.
            expect(text.trim().split('\r\n')).toHaveLength(1);
          } else {
            expect(body).toMatchObject({ items: [], total: 0, totals: [] });
          }
        },
      },
    ]),
    {
      name: 'GET /cash-sessions/current ?locationId de A',
      verb: 'get',
      path: () => `/cash-sessions/current?locationId=${a.locationId}`,
      queryIds: ['locationId'],
      status: 400,
      message: 'La sede no es de esta clínica.',
    },
    {
      // A tiene una caja cerrada; B no ve ninguna.
      name: 'GET /cash-sessions ?locationId de A',
      verb: 'get',
      path: () => `/cash-sessions?locationId=${a.locationId}`,
      queryIds: ['locationId'],
      status: 200,
      responseBody: { items: [], total: 0, page: 1, pageSize: 20 },
    },
    {
      // B tiene pacientes; ninguno tiene la cobertura del pagador de A.
      name: 'GET /patients ?payerId de A',
      verb: 'get',
      path: () => `/patients?payerId=${a.payerId}`,
      queryIds: ['payerId'],
      status: 200,
      responseBody: { items: [], total: 0, page: 1, pageSize: 20 },
    },
    {
      name: 'GET /patients/:patientId/consents/preview ?templateId de A',
      verb: 'get',
      path: () =>
        `/patients/${b.patientId}/consents/preview?templateId=${a.consentTemplateId}`,
      queryIds: ['templateId'],
      status: 404,
      message: 'Plantilla no encontrada',
    },
    {
      name: 'GET /patients/:patientId/consents/preview ?treatmentPlanId de A',
      verb: 'get',
      path: () =>
        `/patients/${b.patientId}/consents/preview?templateId=${b.consentTemplateId}&treatmentPlanId=${a.planId}`,
      queryIds: ['treatmentPlanId'],
      status: 404,
      message: 'Plan de tratamiento no encontrado',
    },
    // `GET /payments` (la caja) no tiene `locationId` en la query: la sede va
    // en `X-Location-Id`. La de A en la query se descarta (whitelist) y B ve
    // su caja vacía (A tiene un abono hoy); la de A en la cabecera se rechaza.
    {
      name: 'GET /payments ?locationId de A (se descarta)',
      verb: 'get',
      path: () =>
        `/payments?from=${day(-1)}&to=${day(1)}&locationId=${a.locationId}`,
      status: 200,
      expectBody: (body) =>
        expect(body).toMatchObject({
          items: [],
          total: 0,
          summary: { count: 0 },
        }),
    },
    {
      name: 'GET /payments con X-Location-Id de A',
      verb: 'get',
      path: () => `/payments?from=${day(-1)}&to=${day(1)}`,
      locationId: () => a.locationId,
      status: 400,
    },
    // ======================================================================
    // DX-207 (TST-022): ids de A en el CUERPO, sobre recursos de B. Ni se crea
    // ni se cambia nada en A ni en B (el recuento de B está en la fotografía).
    // ======================================================================
    {
      // B ya publicó su política: la de A «no es la vigente» de B.
      name: 'POST /patients body.dataConsents.policyVersionId de A',
      verb: 'post',
      path: () => '/patients',
      body: () => ({
        firstName: 'Con política',
        lastName: 'Ajena',
        docType: 'NATIONAL_ID',
        docNumber: '9198',
        sex: Sex.F,
        dataConsents: {
          policyVersionId: a.privacyPolicyId,
          decisions: [{ scope: 'GENERAL', granted: true }],
        },
      }),
      bodyIds: ['dataConsents.policyVersionId'],
      status: 409,
    },
    {
      name: 'POST /patients/:id/payment-promises body.locationId de A',
      verb: 'post',
      path: () => `/patients/${b.patientId}/payment-promises`,
      body: () => ({
        amount: 1000,
        currency: 'COP',
        dueDate: futureAt(10, 15).slice(0, 10),
        locationId: a.locationId,
      }),
      bodyIds: ['locationId'],
      status: 400,
      message: 'La sede no es de esta clínica.',
    },
    {
      name: 'POST /patients/:patientId/coverages body.payerId de A',
      verb: 'post',
      path: () => `/patients/${b.patientId}/coverages`,
      body: () => ({ payerId: a.payerId }),
      bodyIds: ['payerId'],
      status: 400,
      message: 'Pagador no encontrado.',
    },
    {
      name: 'PATCH /patients/:patientId/coverages/:coverageId body.payerId de A',
      verb: 'patch',
      path: () => `/patients/${b.patientId}/coverages/${b.coverageId}`,
      body: () => ({ payerId: a.payerId }),
      bodyIds: ['payerId'],
      status: 400,
      message: 'Pagador no encontrado.',
    },
    {
      name: 'PUT /patients/:patientId/agreement body.agreementId de A',
      verb: 'put',
      path: () => `/patients/${b.patientId}/agreement`,
      body: () => ({ agreementId: a.agreementId }),
      bodyIds: ['agreementId'],
      status: 400,
      message: 'Convenio no encontrado.',
    },
    {
      name: 'PUT /patients/:patientId/agreement body.coverageId de A',
      verb: 'put',
      path: () => `/patients/${b.patientId}/agreement`,
      body: () => ({ agreementId: b.agreementId, coverageId: a.coverageId }),
      bodyIds: ['coverageId'],
      status: 400,
      message: 'Cobertura no encontrada.',
    },
    ...(
      [
        [
          'payerId',
          () => ({ kind: 'PERCENT_DISCOUNT', percent: 5, payerId: a.payerId }),
          'Pagador no encontrado.',
        ],
        [
          'priceListId',
          () => ({ kind: 'PRICE_LIST', priceListId: a.priceListId }),
          'Lista de precios no encontrada.',
        ],
        [
          'locationId',
          () => ({
            kind: 'PERCENT_DISCOUNT',
            percent: 5,
            locationId: a.locationId,
          }),
          'Sede no encontrada.',
        ],
      ] as const
    ).flatMap(([field, patch, message]): IsolationCase[] => [
      {
        name: `POST /agreements body.${field} de A`,
        verb: 'post',
        path: () => '/agreements',
        body: () => ({
          name: `Convenio con ${field} ajeno`,
          payerId: b.payerId,
          ...patch(),
        }),
        bodyIds: [field],
        status: 400,
        message,
      },
      {
        name: `PATCH /agreements/:id body.${field} de A`,
        verb: 'patch',
        path: () => `/agreements/${b.agreementId}`,
        body: patch,
        bodyIds: [field],
        status: 400,
        message,
      },
    ]),
    {
      name: 'POST /price-lists body.locationId de A',
      verb: 'post',
      path: () => '/price-lists',
      body: () => ({
        name: 'Lista con sede ajena',
        currency: 'COP',
        locationId: a.locationId,
      }),
      bodyIds: ['locationId'],
      status: 400,
      message: 'Sede no encontrada.',
    },
    {
      name: 'PATCH /price-lists/:id body.locationId de A',
      verb: 'patch',
      path: () => `/price-lists/${b.priceListId}`,
      body: () => ({ locationId: a.locationId }),
      bodyIds: ['locationId'],
      status: 400,
      message: 'Sede no encontrada.',
    },
    {
      name: 'PUT /payments/:id/allocations body.allocations[].treatmentPlanItemId de A',
      verb: 'put',
      path: () => `/payments/${b.paymentId}/allocations`,
      body: () => ({
        expectedVersion: b.allocationVersion,
        mode: 'MANUAL',
        allocations: [{ treatmentPlanItemId: a.planItemId, amount: 1 }],
      }),
      bodyIds: ['allocations[].treatmentPlanItemId'],
      status: 400,
      message: 'El ítem no es de este plan o ya no existe.',
    },
    {
      name: 'PUT /price-lists/:id/items body.items[].catalogItemId de A',
      verb: 'put',
      path: () => `/price-lists/${b.priceListId}/items`,
      body: () => ({ items: [{ catalogItemId: a.catalogItemId, price: 1 }] }),
      bodyIds: ['items[].catalogItemId'],
      status: 400,
      message:
        'Hay prestaciones que no existen en el catálogo de esta clínica.',
    },
    {
      name: 'POST /patients/:patientId/clinical-entries body.answers[].promptId de A',
      verb: 'post',
      path: () => `/patients/${b.patientId}/clinical-entries`,
      body: () => ({
        templateId: b.noteTemplateId,
        answers: [{ promptId: a.notePromptId, values: ['O'] }],
      }),
      bodyIds: ['answers[].promptId'],
      status: 400,
      message: () =>
        `La pregunta ${a.notePromptId} no es de la plantilla «Plantilla de B»`,
    },
    ...(
      [
        [
          'patientId',
          () => ({ patientId: a.patientId }),
          404,
          'Paciente no encontrado',
        ],
        [
          'providerId',
          () => ({ providerId: a.dentistUserId }),
          404,
          'Profesional no encontrado',
        ],
        [
          'appointmentTypeId',
          () => ({ appointmentTypeId: a.appointmentTypeId }),
          400,
          'El tipo de cita no existe o está desactivado',
        ],
        [
          'planItemIds[]',
          () => ({ planItemIds: [a.planItemId] }),
          404,
          'Algún tratamiento no existe o no pertenece a este paciente.',
        ],
      ] as const
    ).map(([field, patch, status, message]): IsolationCase => ({
      name: `POST /appointments body.${field} de A`,
      verb: 'post',
      path: () => '/appointments',
      body: () => ({
        patientId: b.patientId,
        providerId: clinicB.adminUserId,
        start: futureAt(9, 15),
        end: futureAt(9, 16),
        ...patch(),
      }),
      bodyIds: [field],
      status,
      message,
    })),
    {
      name: 'PATCH /appointments/:id body.providerId de A',
      verb: 'patch',
      path: () => `/appointments/${b.appointmentId}`,
      body: () => ({ providerId: a.dentistUserId }),
      bodyIds: ['providerId'],
      status: 404,
      message: 'Profesional no encontrado',
    },
    {
      name: 'PATCH /appointments/:id body.planItemIds[] de A',
      verb: 'patch',
      path: () => `/appointments/${b.appointmentId}`,
      body: () => ({ planItemIds: [a.planItemId] }),
      bodyIds: ['planItemIds[]'],
      status: 404,
      message: 'Algún tratamiento no existe o no pertenece a este paciente.',
    },
    {
      // La cita de B pide adelantar (`wantsEarlier`): solo el profesional
      // de A puede hacer fallar el movimiento.
      name: 'PATCH /appointments/:id/opening body.providerId de A',
      verb: 'patch',
      path: () => `/appointments/${b.appointmentId}/opening`,
      body: () => ({ start: futureAt(5, 15), providerId: a.dentistUserId }),
      bodyIds: ['providerId'],
      status: 404,
      message: 'Profesional no encontrado',
    },
    {
      name: 'PUT /staff/:userId/locations body.locationIds[] de A',
      verb: 'put',
      path: () => `/staff/${b.dentistUserId}/locations`,
      body: () => ({ locationIds: [a.locationId] }),
      bodyIds: ['locationIds[]'],
      status: 400,
      message: 'Alguna sede no existe en esta clínica.',
    },
    ...(
      [
        [
          'locationId',
          () => ({ locationId: a.locationId }),
          'Sede no encontrada',
        ],
        [
          'providerId',
          () => ({ providerId: a.dentistUserId }),
          'Profesional no encontrado',
        ],
      ] as const
    ).map(([field, patch, message]): IsolationCase => ({
      name: `POST /schedule-blocks body.${field} de A`,
      verb: 'post',
      path: () => '/schedule-blocks',
      body: () => ({
        start: futureAt(70, 13),
        end: futureAt(70, 14),
        kind: 'MEETING',
        ...patch(),
      }),
      bodyIds: [field],
      status: 404,
      message,
    })),
    {
      name: 'PUT /providers/:providerId/schedule body.locations[].locationId de A',
      verb: 'put',
      path: () => `/providers/${clinicB.adminUserId}/schedule`,
      body: () => ({
        locations: [
          {
            locationId: a.locationId,
            ranges: [{ weekday: 1, startMinute: 480, endMinute: 600 }],
          },
        ],
      }),
      bodyIds: ['locations[].locationId'],
      status: 400,
      message: 'Sede no encontrada',
    },
    {
      name: 'POST /providers/:providerId/schedule-overrides body.locationId de A',
      verb: 'post',
      path: () => `/providers/${clinicB.adminUserId}/schedule-overrides`,
      body: () => ({
        locationId: a.locationId,
        date: futureAt(92, 15).slice(0, 10),
        ranges: [],
      }),
      bodyIds: ['locationId'],
      status: 400,
      message: 'Sede no encontrada',
    },
    {
      name: 'POST /waitlist body.patientId de A',
      verb: 'post',
      path: () => '/waitlist',
      body: () => ({ patientId: a.patientId }),
      bodyIds: ['patientId'],
      status: 404,
      message: 'Paciente no encontrado',
    },
    // Con el segundo paciente de B (el primero ya está en pendientes).
    ...(
      [
        [
          'locationId',
          () => ({ locationId: a.locationId }),
          404,
          'Sede no encontrada',
        ],
        [
          'providerId',
          () => ({ providerId: a.dentistUserId }),
          404,
          'Profesional no encontrado',
        ],
        [
          'appointmentTypeId',
          () => ({ appointmentTypeId: a.appointmentTypeId }),
          400,
          'El tipo de cita no existe o está desactivado',
        ],
      ] as const
    ).map(([field, patch, status, message]): IsolationCase => ({
      name: `POST /waitlist body.${field} de A`,
      verb: 'post',
      path: () => '/waitlist',
      body: () => ({ patientId: b.secondPatientId, ...patch() }),
      bodyIds: [field],
      status,
      message,
    })),
    ...(
      [
        [
          'providerId',
          () => ({ providerId: a.dentistUserId }),
          404,
          'Profesional no encontrado',
        ],
        [
          'appointmentTypeId',
          () => ({ appointmentTypeId: a.appointmentTypeId }),
          400,
          'El tipo de cita no existe o está desactivado',
        ],
      ] as const
    ).map(([field, patch, status, message]): IsolationCase => ({
      name: `POST /waitlist/:id/schedule body.${field} de A`,
      verb: 'post',
      path: () => `/waitlist/${b.waitlistEntryId}/schedule`,
      body: () => ({
        providerId: clinicB.adminUserId,
        start: futureAt(11, 15),
        ...patch(),
      }),
      bodyIds: [field],
      status,
      message,
    })),
    ...(
      [
        [
          'providerId',
          () => ({ providerId: a.dentistUserId }),
          'Profesional no encontrado',
        ],
        [
          'patientId',
          () => ({ patientId: a.patientId }),
          'Paciente no encontrado',
        ],
        [
          'waitlistEntryId',
          () => ({ waitlistEntryId: a.waitlistEntryId }),
          'Pendiente no encontrado',
        ],
        [
          'appointmentId',
          () => ({ appointmentId: a.appointmentId }),
          'Cita no encontrada',
        ],
      ] as const
    ).map(([field, patch, message]): IsolationCase => ({
      name: `POST /appointments/openings/:locationId/offers body.${field} de A`,
      verb: 'post',
      path: () => `/appointments/openings/${b.locationId}/offers`,
      body: () => ({
        slotStart: futureAt(62, 15),
        slotEnd: futureAt(62, 16),
        providerId: clinicB.adminUserId,
        patientId: b.patientId,
        channel: 'PHONE',
        ...patch(),
      }),
      bodyIds: [field],
      status: 404,
      message,
    })),
    {
      // El ítem de B va también: el de A sobra (no es un ítem vivo del plan).
      name: 'PATCH /treatment-plans/:id/visits body.items[].itemId de A',
      verb: 'patch',
      path: () => `/treatment-plans/${b.planId}/visits`,
      body: () => ({
        items: [
          { itemId: b.planItemId, visit: 1 },
          { itemId: a.planItemId, visit: 1 },
        ],
        visitIntervals: {},
      }),
      bodyIds: ['items[].itemId'],
      status: 400,
      message: 'Incluye todos los ítems vivos del plan una sola vez.',
    },
    {
      name: 'POST /treatment-plans/:id/items body.catalogItemId de A',
      verb: 'post',
      path: () => `/treatment-plans/${b.planId}/items`,
      body: () => ({ toothNumber: '22', catalogItemId: a.catalogItemId }),
      bodyIds: ['catalogItemId'],
      status: 404,
      message: 'Prestación no encontrada en el catálogo de esta clínica.',
    },
    // La prestación y la evolución del odontograma no tienen FK: el caso de
    // uso comprueba que sean de B (y la evolución, de su paciente).
    {
      name: 'POST /patients/:patientId/tooth-records body.catalogItemId de A',
      verb: 'post',
      path: () => `/patients/${b.patientId}/tooth-records`,
      body: () => ({
        toothNumber: '11',
        kind: 'PROCEDURE',
        catalogItemId: a.catalogItemId,
      }),
      bodyIds: ['catalogItemId'],
      status: 404,
      message: 'Prestación no encontrada en el catálogo de esta clínica.',
    },
    {
      name: 'POST /patients/:patientId/tooth-records body.clinicalEntryId de A',
      verb: 'post',
      path: () => `/patients/${b.patientId}/tooth-records`,
      body: () => ({
        toothNumber: '11',
        kind: 'PROCEDURE',
        catalogItemId: b.catalogItemId,
        clinicalEntryId: a.clinicalEntryId,
      }),
      bodyIds: ['clinicalEntryId'],
      status: 404,
      message:
        'Evolución no encontrada en la historia clínica de este paciente',
    },
    {
      name: 'POST /treatment-plans/:id/items/bulk-discount body.itemIds[] de A',
      verb: 'post',
      path: () => `/treatment-plans/${b.planId}/items/bulk-discount`,
      body: () => ({ itemIds: [a.planItemId], percent: 5 }),
      bodyIds: ['itemIds[]'],
      status: 404,
      message: 'Algún ítem no existe o no es de este plan de tratamiento.',
    },
    {
      name: 'POST /cash-sessions/open body.locationId de A',
      verb: 'post',
      path: () => '/cash-sessions/open',
      body: () => ({ locationId: a.locationId, floats: [] }),
      bodyIds: ['locationId'],
      status: 400,
      message: 'La sede no es de esta clínica.',
    },
    ...(
      [
        [
          'templateId',
          () => ({ templateId: a.consentTemplateId }),
          'Plantilla no encontrada',
        ],
        [
          'treatmentPlanId',
          () => ({ treatmentPlanId: a.planId }),
          'Plan de tratamiento no encontrado',
        ],
      ] as const
    ).map(([field, patch, message]): IsolationCase => ({
      name: `POST /patients/:patientId/consents body.${field} de A`,
      verb: 'post',
      path: () => `/patients/${b.patientId}/consents`,
      body: () => ({
        templateId: b.consentTemplateId,
        templateVersion: 1,
        signerType: 'PATIENT',
        patientSignature: SIGNATURE_PNG,
        professionalSignature: SIGNATURE_PNG,
        ...patch(),
      }),
      bodyIds: [field],
      status: 404,
      message,
    })),
    {
      name: 'POST /post-op-templates body.appointmentTypeIds[] de A',
      verb: 'post',
      path: () => '/post-op-templates',
      body: () => ({
        code: 'POI-AJENO',
        title: 'Con tipo ajeno',
        body: 'Texto',
        appointmentTypeIds: [a.appointmentTypeId],
      }),
      bodyIds: ['appointmentTypeIds[]'],
      status: 400,
      message: 'Algún tipo de cita no existe en esta clínica',
    },
    ...(
      [
        [
          'appointmentTypeIds[]',
          () => ({ appointmentTypeIds: [a.appointmentTypeId] }),
          'Algún tipo de cita no existe en esta clínica',
        ],
        [
          'catalogItemIds[]',
          () => ({ catalogItemIds: [a.catalogItemId] }),
          'Algún procedimiento del catálogo no existe en esta clínica',
        ],
      ] as const
    ).map(([field, patch, message]): IsolationCase => ({
      name: `PATCH /post-op-templates/:id body.${field} de A`,
      verb: 'patch',
      path: () => `/post-op-templates/${b.postOpTemplateId}`,
      body: patch,
      bodyIds: [field],
      status: 400,
      message,
    })),
    {
      name: 'POST /appointments/:appointmentId/post-op-instructions/deliveries body.templateId de A',
      verb: 'post',
      path: () =>
        `/appointments/${b.appointmentId}/post-op-instructions/deliveries`,
      body: () => ({ templateId: a.postOpTemplateId, channel: 'PRINT' }),
      bodyIds: ['templateId'],
      status: 404,
      message: 'Plantilla de indicaciones no encontrada',
    },
    {
      name: 'POST /patients/:patientId/medical-history/requests body.appointmentId de A',
      verb: 'post',
      path: () => `/patients/${b.patientId}/medical-history/requests`,
      body: () => ({ appointmentId: a.appointmentId }),
      bodyIds: ['appointmentId'],
      status: 404,
      message: 'Cita no encontrada',
    },
    // ======================================================================
    // DX-207: rutas públicas por token. El token de A, sin sesión, en el host
    // de B: «no existe» (y nada de A cambia). Que el mismo token SÍ vale en
    // el host de A lo comprueba «control: los tokens de A valen en su host».
    // ======================================================================
    ...(
      [
        ['get', undefined],
        ['post', () => ({ action: 'confirm' })],
      ] as const
    ).map(([verb, body]): IsolationCase => ({
      name: `${verb.toUpperCase()} /public/appointment-confirmations/:token (token de A en el host de B)`,
      verb,
      path: () => `/public/appointment-confirmations/${a.confirmationToken}`,
      body,
      public: true,
      status: 404,
      message: CONFIRMATION_LINK_NOT_FOUND_MESSAGE,
    })),
    {
      // Contrato de la pantalla de invitación (sin enumerar): 200 NOT_FOUND,
      // el mismo cuerpo que para un token inventado.
      name: 'GET /public/invitations/:token (token de A en el host de B)',
      verb: 'get',
      path: () => `/public/invitations/${invitationTokenA}`,
      public: true,
      status: 200,
      responseBody: { status: 'NOT_FOUND' },
    },
    {
      name: 'POST /public/invitations/:token/accept (token de A en el host de B)',
      verb: 'post',
      path: () => `/public/invitations/${invitationTokenA}/accept`,
      body: () => ({ password: 'Intrusa123!', fullName: 'Intrusa' }),
      public: true,
      status: 404,
      message:
        'La invitación no existe o el enlace ya no es válido (puede que te hayan enviado uno más reciente).',
    },
    {
      name: 'POST /auth/reset-password/check (token de A en el host de B)',
      verb: 'post',
      path: () => '/auth/reset-password/check',
      body: () => ({ token: resetTokenA }),
      public: true,
      status: 200,
      responseBody: { status: 'INVALID' },
    },
    {
      name: 'POST /auth/reset-password (token de A en el host de B)',
      verb: 'post',
      path: () => '/auth/reset-password',
      body: () => ({ token: resetTokenA, password: 'Intrusa123!' }),
      public: true,
      status: 404,
      message:
        'El enlace para restablecer la contraseña no es válido o ya fue reemplazado por uno más reciente. Pide un enlace nuevo.',
    },
  ];

  /**
   * Rutas con roles y `:param` cuyo aislamiento entre clínicas ya prueba otro
   * spec (B → 404 sobre el recurso de A). Cada una cita dónde.
   */
  const COVERED_ELSEWHERE: Record<string, string> = {
    // DX-307: paciente/evolución/anestésico de otra clínica → 404; las
    // ediciones responden siempre 405 (inalterable).
    'GET /patients/:patientId/anesthesia': 'anesthesia.e2e-spec.ts',
    'GET /patients/:patientId/clinical-entries/:entryId/anesthesia':
      'anesthesia.e2e-spec.ts',
    'POST /patients/:patientId/clinical-entries/:entryId/anesthesia':
      'anesthesia.e2e-spec.ts',
    'POST /patients/:patientId/clinical-entries/:entryId/anesthesia/check':
      'anesthesia.e2e-spec.ts',
    'PATCH /patients/:patientId/clinical-entries/:entryId/anesthesia/:id':
      'anesthesia.e2e-spec.ts',
    'PUT /patients/:patientId/clinical-entries/:entryId/anesthesia/:id':
      'anesthesia.e2e-spec.ts',
    'DELETE /patients/:patientId/clinical-entries/:entryId/anesthesia/:id':
      'anesthesia.e2e-spec.ts',
    'PATCH /anesthetics/:id': 'anesthesia.e2e-spec.ts',
    // DX-377: la clínica B no edita el medio de pago de A (404).
    'PATCH /payment-methods/:id': 'payment-methods.e2e-spec.ts',
    // DX-214: recepción consulta avisos de A; administrador de B obtiene 404
    // y no se añade ningún evento VIEW a la auditoría de A.
    'GET /patients/:id/communication/opt-out-warnings':
      'reminder-opt-out.e2e-spec.ts',
    // Contra el paciente de A; los casos de aquí (cita y plantilla de A) van
    // sobre el paciente de B y prueban los ids del cuerpo (DX-207).
    'POST /patients/:patientId/clinical-entries':
      'patient-tenant-fk.e2e-spec.ts',
    // DX-256: «guarda dos visitas; recepción no organiza y clínica ajena no
    // encuentra el plan» prueba GET/PATCH B → 404 y snapshot de plan, ítems,
    // intervalos, aceptación y hash del presupuesto de A sin cambios.
    'GET /treatment-plans/:id/visits': 'plan-visits.e2e-spec.ts',
    'PATCH /treatment-plans/:id/visits': 'plan-visits.e2e-spec.ts',
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
    // DX-300: B → 404 sobre el paciente de A en la previsualización de avisos.
    'POST /patients/:patientId/prescriptions/safety-check':
      'prescriptions.e2e-spec.ts',
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
    // DX-107: lote de importación de otra clínica → 404.
    'GET /patient-imports/:id': 'patient-imports.e2e-spec.ts',
    'GET /patient-imports/:id/errors.csv': 'patient-imports.e2e-spec.ts',
    'POST /patient-imports/:id/confirm': 'patient-imports.e2e-spec.ts',
    'POST /patient-imports/:id/undo': 'patient-imports.e2e-spec.ts',
    // DX-262: abonar al saldo migrado de otra clínica → 404.
    'POST /opening-balances/:id/payments': 'opening-balances.e2e-spec.ts',
    // DX-262: la hoja de saldos del lote de otra clínica → 404.
    'POST /patient-imports/:id/balances': 'opening-balances.e2e-spec.ts',
    'DELETE /patient-imports/:id/balances': 'opening-balances.e2e-spec.ts',
    'POST /patient-imports/:id/balances/undo': 'opening-balances.e2e-spec.ts',
    'GET /patient-imports/:id/balances/errors.csv':
      'opening-balances.e2e-spec.ts',
    'POST /patients/:patientId/documents': 'patient-documents.e2e-spec.ts',
    'POST /patients/:patientId/documents/upload-url':
      'patient-documents-direct-disk.e2e-spec.ts',
    'POST /patients/:patientId/documents/:id/complete':
      'patient-documents-direct-disk.e2e-spec.ts',
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
    // DX-099: B → 404 sobre el paciente, el envío y el token de A, sin tocar
    // el envío ni la HC de A.
    'POST /patients/:patientId/medical-history/requests':
      'medical-history-submissions.e2e-spec.ts',
    'GET /patients/:patientId/medical-history/requests':
      'medical-history-submissions.e2e-spec.ts',
    'GET /medical-history/submissions/:id':
      'medical-history-submissions.e2e-spec.ts',
    'POST /medical-history/submissions/:id/accept':
      'medical-history-submissions.e2e-spec.ts',
    'POST /medical-history/submissions/:id/reject':
      'medical-history-submissions.e2e-spec.ts',
    'POST /medical-history/submissions/:id/revoke':
      'medical-history-submissions.e2e-spec.ts',
    // DX-375: el ADMIN de otra clínica corrige la tasa manual de A → 404.
    'PUT /exchange/manual-rates/:id':
      'payment-frozen-exchange-rate.e2e-spec.ts',
  };

  /** `MÉTODO /ruta` de un caso (las dos primeras palabras de su nombre). */
  const routeOf = (c: IsolationCase): string =>
    c.name.split(' ').slice(0, 2).join(' ');

  it('cubre toda ruta de clínica con :param (aquí o en el spec citado)', () => {
    // Solo cuentan los casos que atacan el recurso de la RUTA (los de ids por
    // query/cuerpo y los públicos van sobre recursos de B o sin sesión).
    const covered = new Set(
      cases.filter((c) => !c.queryIds && !c.bodyIds && !c.public).map(routeOf),
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

  /**
   * DX-207: rutas públicas por `:token` cuyo caso «token de A en el host de
   * B → 404 sin tocar nada de A» ya está en otro spec.
   */
  const PUBLIC_TOKEN_COVERED_ELSEWHERE: Record<string, string> = {
    // «en el host de otra clínica, o con un token inventado, 404» y la baja
    // de A sigue sin registrar.
    'GET /public/reminder-opt-outs/:token': 'reminder-opt-out.e2e-spec.ts',
    'POST /public/reminder-opt-outs/:token': 'reminder-opt-out.e2e-spec.ts',
    // «el token de A en el host de B → 404» y la apertura sigue sin marcar.
    'GET /public/post-op-instructions/:token':
      'public-post-op-instructions.e2e-spec.ts',
    'POST /public/post-op-instructions/:token/opened':
      'public-post-op-instructions.e2e-spec.ts',
    // «el token de A en el host de B → 404» (GET y POST del formulario).
    'GET /public/medical-history/:token':
      'medical-history-submissions.e2e-spec.ts',
    'POST /public/medical-history/:token':
      'medical-history-submissions.e2e-spec.ts',
  };

  it('DX-207: cada id por query/cuerpo de la lista de la matriz tiene su caso, y ningún caso sobra', () => {
    const fromCases = cases.flatMap((c) => [
      ...(c.queryIds ?? []).map((f) => `${routeOf(c)} ?${f}`),
      ...(c.bodyIds ?? []).map((f) => `${routeOf(c)} body.${f}`),
    ]);
    expect({
      sinCaso: ID_INPUTS_IN_MATRIX.filter((id) => !fromCases.includes(id)),
      casoFueraDeLaLista: fromCases.filter(
        (id) => !ID_INPUTS_IN_MATRIX.includes(id),
      ),
    }).toEqual({ sinCaso: [], casoFueraDeLaLista: [] });
    expect(TENANT_ISOLATION_MATRIX_SPEC).toBe(path.basename(__filename));
  });

  it('DX-207: cada ruta pública por :token tiene su caso «token de A en el host de B» (aquí o en el spec citado)', async () => {
    const byToken = Object.entries(ROUTE_ACCESS)
      .filter(
        ([key, access]) =>
          access.kind === 'public' &&
          access.tenantScoped &&
          key.includes('/:token'),
      )
      .map(([key]) => key);
    const covered = new Set(cases.filter((c) => c.public).map(routeOf));
    expect({
      sinCubrir: byToken.filter(
        (k) => !covered.has(k) && !(k in PUBLIC_TOKEN_COVERED_ELSEWHERE),
      ),
      exencionSobrante: Object.keys(PUBLIC_TOKEN_COVERED_ELSEWHERE).filter(
        (k) => covered.has(k) || !byToken.includes(k),
      ),
    }).toEqual({ sinCubrir: [], exencionSobrante: [] });
    for (const spec of new Set(Object.values(PUBLIC_TOKEN_COVERED_ELSEWHERE))) {
      await expect(
        fs.access(path.join(__dirname, spec)),
      ).resolves.toBeUndefined();
    }
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    'B → %s: responde lo esperado y no toca nada de A',
    async (_name, c) => {
      const before = await shotOfA();
      const req = c.public
        ? publicRequest(app, clinicB, c.verb, c.path(), c.body?.())
        : api(app, clinicB, c.verb, c.path(), c.body?.());
      if (c.locationId) req.set('X-Location-Id', c.locationId());
      const res = await req;
      if (res.status !== c.status) {
        // Diagnóstico de fallos transitorios: solo campos de error, nunca
        // cuerpos de petición ni respuestas de éxito con posibles tokens.
        const error = res.body as {
          message?: unknown;
          error?: unknown;
          code?: unknown;
        };
        throw new Error(
          `${c.name}: HTTP ${res.status} (esperado ${c.status}); ${JSON.stringify({ message: error.message, error: error.error, code: error.code })}`,
        );
      }
      expect({ status: res.status }).toEqual({ status: c.status });
      if ('responseBody' in c) {
        expect(res.text === '' ? null : res.body).toEqual(c.responseBody);
      }
      if (c.message !== undefined) {
        expect((res.body as { message?: unknown }).message).toBe(
          typeof c.message === 'function' ? c.message() : c.message,
        );
      }
      c.expectBody?.(res.body, res.text);
      // Ninguna respuesta de B lleva el tenant de A ni un id de A que B no
      // haya mandado él mismo (el eco de su propio filtro no es una fuga).
      const sent = `${c.path()} ${JSON.stringify(c.body?.() ?? {})}`;
      expect(
        [clinicA.tenantId, ...idsOfA()].filter(
          (id) => res.text.includes(id) && !sent.includes(id),
        ),
      ).toEqual([]);
      expect(await shotOfA()).toEqual(before);
    },
  );

  it('DX-207, control: los tokens de A sí valen en el host de A (el 404 de B es por el host)', async () => {
    const pub = (verb: Verb, path: string, body?: object) =>
      publicRequest(app, clinicA, verb, path, body);
    await pub(
      'get',
      `/public/appointment-confirmations/${a.confirmationToken}`,
    ).expect(200);
    const invitation = await pub(
      'get',
      `/public/invitations/${invitationTokenA}`,
    ).expect(200);
    expect(invitation.body).not.toEqual({ status: 'NOT_FOUND' });
    await pub('post', '/auth/reset-password/check', { token: resetTokenA })
      .expect(200)
      .expect({ status: 'VALID' });
  });

  it('DX-050: B no puede atribuir su ítem a un profesional de A (queda aceptado, sin atribución ni odontograma)', async () => {
    await api(
      app,
      clinicB,
      'patch',
      `/treatment-plans/${b.planId}/items/${b.planItemId}`,
      { status: 'DONE', performedById: a.dentistUserId },
    ).expect(404);
    expect(
      await raw.treatmentPlanItem.findUniqueOrThrow({
        where: { id: b.planItemId },
      }),
    ).toMatchObject({
      status: 'ACCEPTED',
      performedById: null,
      performedByMembershipId: null,
    });
    expect(
      await raw.toothRecord.count({
        where: { sourcePlanItemId: b.planItemId },
      }),
    ).toBe(0);
  });

  it('DX-305: B no puede atribuir su «Sin atribuir» a una sede de A (400, y el ítem sigue sin atribuir)', async () => {
    const planItem = await raw.treatmentPlanItem.findUniqueOrThrow({
      where: { id: b.planItemId },
      select: { tenantId: true, planId: true, catalogItemId: true },
    });
    // Como los DONE de antes de DX-050: realizado, sin quién, dónde ni cuándo.
    const legacy = await raw.treatmentPlanItem.create({
      data: { ...planItem, toothNumber: '22', price: 100, status: 'DONE' },
      select: { id: true },
    });
    const res = await api(
      app,
      clinicB,
      'patch',
      `/treatment-plans/${b.planId}/items/${legacy.id}`,
      {
        performedById: clinicB.adminUserId,
        completedAt: '2026-09-14T15:00:00.000Z',
        performedLocationId: a.locationId,
      },
    ).expect(400);
    expect((res.body as { message: string }).message).toBe(
      PERFORMED_LOCATION_NOT_FOUND_MESSAGE,
    );
    expect(
      await raw.treatmentPlanItem.findUniqueOrThrow({
        where: { id: legacy.id },
      }),
    ).toMatchObject({ performedById: null, performedLocationId: null });
    // Y al marcar realizado, la sede no se elige en el cuerpo.
    const done = await api(
      app,
      clinicB,
      'patch',
      `/treatment-plans/${b.planId}/items/${b.planItemId}`,
      { status: 'DONE', performedLocationId: a.locationId },
    ).expect(400);
    expect((done.body as { message: string }).message).toBe(
      LOCATION_BY_REQUEST_MESSAGE,
    );
    await raw.treatmentPlanItem.delete({ where: { id: legacy.id } });
  });

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
