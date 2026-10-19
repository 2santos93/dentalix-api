import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { fitsBusinessHours } from '../src/modules/location-schedule/application/business-hours';
import {
  DEMO_EMAIL_DOMAIN,
  DEMO_PASSWORD,
  DEMO_SUBDOMAIN,
  DEMO_USERS,
  assertLocalEnvironment,
  seedDemo,
} from '../prisma/seed-demo';
import { hostFor } from './support/tenant-host';

// Este spec escribe y BORRA EN DURO: solo puede correr contra una base de test.
for (const key of ['DATABASE_URL', 'DIRECT_URL'] as const) {
  if (!process.env[key]?.includes('_test')) {
    throw new Error(
      `seed-demo.int-spec: ${key} no apunta a una base de test (*_test*); aborto.`,
    );
  }
}

// `raw` (DIRECT_URL, superusuario) es SOLO para inspeccionar y limpiar: ve
// todas las filas saltando la RLS, que es justo lo que hace falta para
// comprobar que el seed no escribió nada fuera del tenant demo. El seed en sí
// corre por DATABASE_URL (rol con RLS), igual que la API.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// Toda tabla con `tenantId`, en orden seguro para borrar (hijas primero).
const TENANT_TABLES = [
  'patient_implants',
  // DX-027: caja por turno (hijas de cash_sessions y de payments).
  'cash_session_adjustments',
  'cash_session_reopenings',
  'cash_session_closing_lines',
  'cash_session_closings',
  'cash_session_floats',
  // DX-150: cobranza (hijas de patients y locations).
  'collection_notes',
  'payment_promises',
  'prescription_items',
  'prescriptions',
  'prescription_templates',
  'perio_site_measures',
  'perio_tooth_measures',
  'perio_exams',
  'patient_consents',
  'consent_templates',
  'installments',
  'payment_plans',
  'payments',
  // Después de payments (payments."cashSessionId").
  'cash_sessions',
  'treatment_plan_acceptances',
  'treatment_plan_items',
  'treatment_plans',
  'tooth_records',
  'patient_dentition_events',
  'clinical_entry_addenda',
  'clinical_entries',
  'clinical_note_template_prompts',
  'clinical_note_templates',
  'medical_history_versions',
  'appointment_confirmations',
  // DX-210: ofertas de huecos (hijas de appointment_waitlist y appointments).
  'waitlist_offers',
  'appointment_waitlist',
  'appointments',
  'appointment_types',
  'inventory_movements',
  'inventory_items',
  'schedule_blocks',
  'location_schedule_ranges',
  'location_schedules',
  'data_processing_consents',
  'privacy_policy_versions',
  'patients',
  'dental_catalog_items',
  'clinic_invitations',
  'clinic_memberships',
  'tenant_domains',
  'locations',
] as const;

type Counts = Record<string, number>;

async function countsFor(tenantId: string): Promise<Counts> {
  const out: Counts = {};
  for (const table of TENANT_TABLES) {
    const rows = await raw.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1::uuid`,
      tenantId,
    );
    out[table] = rows[0].n;
  }
  return out;
}

async function countsOutside(tenantIds: string[]): Promise<Counts> {
  const out: Counts = {};
  for (const table of TENANT_TABLES) {
    const rows = await raw.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "${table}" WHERE NOT ("tenantId" = ANY($1::uuid[]))`,
      tenantIds,
    );
    out[table] = rows[0].n;
  }
  return out;
}

/** Borra (duro, solo en la base de test) todo tenant demo, vivo o retirado. */
async function purgeDemo(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: DEMO_SUBDOMAIN },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length > 0) {
    for (const table of TENANT_TABLES) {
      await raw.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE "tenantId" = ANY($1::uuid[])`,
        ids,
      );
    }
    await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  await raw.user.deleteMany({
    where: {
      OR: [
        { email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` } },
        { email: FOREIGN_OWNER_EMAIL },
      ],
    },
  });
}

const FOREIGN_OWNER_EMAIL = 'duena@otra-clinica.example.com';

/** Crea (vía superusuario) un tenant ajeno con un ADMIN, opcionalmente con más miembros. */
async function createForeignTenant(
  subdomain: string,
  extraMemberIds: string[] = [],
): Promise<string> {
  const tenant = await raw.tenant.create({
    data: { name: `Ajena ${subdomain}`, subdomain },
  });
  const owner = await raw.user.upsert({
    where: { email: FOREIGN_OWNER_EMAIL },
    update: {},
    create: {
      email: FOREIGN_OWNER_EMAIL,
      passwordHash: 'x',
      fullName: 'Dueña',
    },
  });
  for (const userId of [owner.id, ...extraMemberIds]) {
    await raw.clinicMembership.create({
      data: { tenantId: tenant.id, userId, role: ClinicRole.ADMIN },
    });
  }
  return tenant.id;
}

async function purgeTenant(tenantId: string): Promise<void> {
  await raw.clinicMembership.deleteMany({ where: { tenantId } });
  await raw.tenant.delete({ where: { id: tenantId } });
  await raw.user.deleteMany({ where: { email: FOREIGN_OWNER_EMAIL } });
}

async function liveDemoTenantId(): Promise<string> {
  const tenant = await raw.tenant.findFirstOrThrow({
    where: { subdomain: DEMO_SUBDOMAIN, deletedAt: null },
    select: { id: true },
  });
  return tenant.id;
}

describe('seed demo (prisma/seed-demo.ts)', () => {
  let app: INestApplication<App>;
  let firstCounts: Counts;
  let outsideBefore: Counts;
  let usersBefore: string[];

  beforeAll(async () => {
    await purgeDemo();
    outsideBefore = await countsOutside([]);
    usersBefore = (await raw.user.findMany({ select: { email: true } })).map(
      (u) => u.email,
    );

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  }, 60000);

  afterAll(async () => {
    await app.close();
    await purgeDemo();
    await raw.$disconnect();
  });

  it('se niega a correr con NODE_ENV=production', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(seedDemo({ quiet: true })).rejects.toThrow(/production/);
    } finally {
      process.env.NODE_ENV = previous;
    }
    expect(
      await raw.tenant.count({ where: { subdomain: DEMO_SUBDOMAIN } }),
    ).toBe(0);
  });

  it('se niega si DATABASE_URL apunta a un host que no es local, salvo ALLOW_DEMO_SEED=1', async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL =
      'postgresql://dentalix_app:x@db.prod.example.com:5432/dentalix_test?schema=public';
    try {
      await expect(seedDemo({ quiet: true })).rejects.toThrow(/no es local/);
    } finally {
      process.env.DATABASE_URL = previous;
    }
    expect(
      await raw.tenant.count({ where: { subdomain: DEMO_SUBDOMAIN } }),
    ).toBe(0);

    const remote = 'postgresql://u:p@10.0.0.8:5432/x';
    expect(() => assertLocalEnvironment({ DATABASE_URL: remote })).toThrow(
      /no es local/,
    );
    expect(() =>
      assertLocalEnvironment({ DATABASE_URL: remote, ALLOW_DEMO_SEED: '1' }),
    ).not.toThrow();
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(() =>
        assertLocalEnvironment({
          DATABASE_URL: `postgresql://u:p@${host}:5432/x`,
        }),
      ).not.toThrow();
    }
    // ALLOW_DEMO_SEED no levanta la negativa de producción.
    expect(() =>
      assertLocalEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://u:p@localhost:5432/x',
        ALLOW_DEMO_SEED: '1',
      }),
    ).toThrow(/production/);
  });

  it('no toca un tenant `demo` que no creó el seed (ni sin flags ni con --reset)', async () => {
    const foreignId = await createForeignTenant(DEMO_SUBDOMAIN);
    try {
      await expect(seedDemo({ quiet: true })).rejects.toThrow(/no lo creó/);
      await expect(seedDemo({ quiet: true, reset: true })).rejects.toThrow(
        /no lo creó/,
      );
      const tenant = await raw.tenant.findUniqueOrThrow({
        where: { id: foreignId },
      });
      expect(tenant.deletedAt).toBeNull();
      expect(
        await raw.clinicMembership.count({
          where: { tenantId: foreignId, deletedAt: null },
        }),
      ).toBe(1);
    } finally {
      await purgeTenant(foreignId);
    }
  }, 60000);

  it('la primera corrida crea la clínica demo completa', async () => {
    const result = await seedDemo({ quiet: true });
    expect(result.status).toBe('created');
    expect(result.password).toBe(DEMO_PASSWORD);
    expect(result.users.map((u) => u.email)).toEqual(
      DEMO_USERS.map((u) => u.email),
    );
    const tenantId = await liveDemoTenantId();
    expect(result.tenantId).toBe(tenantId);

    const tenant = await raw.tenant.findUniqueOrThrow({
      where: { id: tenantId },
    });
    expect(tenant.name).toBe('Clínica Demo');
    expect(tenant.primaryColor).not.toBe('#0F5E9C');

    firstCounts = await countsFor(tenantId);
    expect(firstCounts.locations).toBe(2);
    expect(firstCounts.location_schedules).toBe(2);
    expect(firstCounts.clinic_memberships).toBe(5);
    expect(firstCounts.patients).toBe(25);
    expect(firstCounts.medical_history_versions).toBeGreaterThanOrEqual(8);
    expect(firstCounts.clinical_entries).toBeGreaterThanOrEqual(10);
    expect(firstCounts.clinical_entry_addenda).toBeGreaterThanOrEqual(1);
    expect(firstCounts.tooth_records).toBeGreaterThanOrEqual(10);
    // DX-120: dentición mixta de la paciente infantil (3 posiciones).
    expect(firstCounts.patient_dentition_events).toBe(3);
    expect(firstCounts.appointments).toBeGreaterThanOrEqual(40);
    expect(firstCounts.treatment_plans).toBeGreaterThanOrEqual(6);
    expect(firstCounts.payments).toBeGreaterThanOrEqual(10);
    expect(firstCounts.payment_plans).toBe(1);
    expect(firstCounts.installments).toBeGreaterThanOrEqual(3);
    expect(firstCounts.inventory_items).toBeGreaterThanOrEqual(8);
    expect(firstCounts.inventory_movements).toBeGreaterThanOrEqual(10);
    // Catálogo por defecto del registro real.
    expect(firstCounts.dental_catalog_items).toBeGreaterThan(50);
    // DX-005: una confirmación pendiente + una "pide llamada".
    expect(firstCounts.appointment_confirmations).toBe(2);
    // DX-037: política v1 y la autorización de cada alta (≥ 2 filas por paciente).
    expect(firstCounts.privacy_policy_versions).toBe(1);
    expect(firstCounts.data_processing_consents).toBeGreaterThanOrEqual(50);
    // DX-006: 3 plantillas y 1 consentimiento firmado.
    expect(firstCounts.consent_templates).toBe(3);
    expect(firstCounts.patient_consents).toBe(1);
    // DX-012: un presupuesto aceptado con firma.
    expect(firstCounts.treatment_plan_acceptances).toBe(1);
    // DX-007: dos exámenes periodontales FINAL del mismo paciente.
    expect(firstCounts.perio_exams).toBe(2);
    expect(firstCounts.perio_site_measures).toBe(2 * 28 * 6);
    // DX-013: 3 plantillas de receta y una receta emitida con 2 medicamentos.
    expect(firstCounts.prescription_templates).toBe(3);
    expect(firstCounts.prescriptions).toBe(1);
    expect(firstCounts.prescription_items).toBe(2);
    // DX-191: implante + pilar de un paciente y otro paciente con el mismo lote.
    expect(firstCounts.patient_implants).toBe(3);
    // DX-170: las 6 plantillas de evolución de ejemplo.
    expect(firstCounts.clinical_note_templates).toBe(6);
    // DX-150: tres gestiones de cobro y un compromiso abierto.
    expect(firstCounts.collection_notes).toBe(3);
    expect(firstCounts.payment_promises).toBe(1);
    // DX-027: un turno cerrado con arqueo (2 líneas) y otro abierto.
    expect(firstCounts.cash_sessions).toBe(2);
    expect(firstCounts.cash_session_floats).toBe(2);
    expect(firstCounts.cash_session_closings).toBe(1);
    expect(firstCounts.cash_session_closing_lines).toBe(2);
    // DX-121: 5 tipos de cita con color.
    expect(firstCounts.appointment_types).toBe(5);
    // DX-122: vacaciones y almuerzo; pendientes del calendario + uno manual.
    expect(firstCounts.schedule_blocks).toBe(2);
    expect(firstCounts.appointment_waitlist).toBeGreaterThanOrEqual(3);
    expect(result.confirmationUrl).toMatch(
      /^http:\/\/demo\.localhost:3001\/confirmar\/[A-Za-z0-9_-]{43}$/,
    );
  }, 120000);

  it('deja tipos de cita con color y citas demo con tipo (DX-121)', async () => {
    const tenantId = await liveDemoTenantId();
    const types = await raw.appointmentType.findMany({ where: { tenantId } });
    expect(types.every((t) => /^#[0-9A-F]{6}$/.test(t.color))).toBe(true);
    const typed = await raw.appointment.count({
      where: { tenantId, appointmentTypeId: { not: null } },
    });
    expect(typed).toBeGreaterThanOrEqual(10);
  });

  it('deja evoluciones redactadas con plantilla y ligadas a su cita atendida (DX-170)', async () => {
    const tenantId = await liveDemoTenantId();
    const entries = await raw.clinicalEntry.findMany({
      where: { tenantId, templateId: { not: null } },
      include: { appointment: true, template: true },
    });
    expect(entries.map((e) => e.template?.name).sort()).toEqual([
      'Profilaxis',
      'Resina',
    ]);
    for (const e of entries) {
      expect(e.appointment).toMatchObject({
        status: 'COMPLETED',
        patientId: e.patientId,
        providerId: e.performedById,
      });
      expect(e.notes).not.toMatch(/\{\{/);
    }
    const resin = entries.find((e) => e.template?.name === 'Resina');
    expect(resin?.notes).toContain('Diente 36, superficie O');
  });

  it('deja un bloqueo de vacaciones, uno de almuerzo y 3 pendientes abiertos (DX-122)', async () => {
    const tenantId = await liveDemoTenantId();
    const blocks = await raw.scheduleBlock.findMany({
      where: { tenantId },
      orderBy: { start: 'asc' },
    });
    expect(blocks.map((b) => [b.kind, b.allowsBooking])).toEqual([
      ['LUNCH', true],
      ['VACATION', false],
    ]);
    // Las vacaciones no pisan ninguna cita viva de la dentista.
    const vacation = blocks[1];
    await expect(
      raw.appointment.count({
        where: {
          tenantId,
          providerId: vacation.providerId!,
          deletedAt: null,
          status: { not: 'CANCELLED' },
          start: { lt: vacation.end },
          end: { gt: vacation.start },
        },
      }),
    ).resolves.toBe(0);
    const open = await raw.appointmentWaitlistEntry.findMany({
      where: { tenantId, status: 'OPEN' },
    });
    expect(open).toHaveLength(3);
    // Revisión H2: ningún paciente sale dos veces en la lista.
    expect(new Set(open.map((e) => e.patientId)).size).toBe(3);
    expect(open.filter((e) => e.sourceAppointmentId === null)).toEqual([
      expect.objectContaining({ priority: 'URGENT' }),
    ]);
  });

  it('la sede principal tiene recordatorios por email activos a 48 h y 2 h (DX-026)', async () => {
    const tenantId = await liveDemoTenantId();
    const settings = await raw.locationReminderSettings.findMany({
      where: { tenantId },
      include: { location: { select: { name: true } } },
    });
    expect(
      settings.map((s) => [s.location.name, s.enabled, s.leadHours]),
    ).toEqual([['Sede principal', true, [48, 2]]]);
  });

  it('deja una cita futura con confirmación pendiente y otra que pide llamada (DX-005)', async () => {
    const tenantId = await liveDemoTenantId();
    const confirmations = await raw.appointmentConfirmation.findMany({
      where: { tenantId },
      include: { appointment: true },
      orderBy: { appointmentStart: 'asc' },
    });
    expect(confirmations).toHaveLength(2);
    const [pending, callMe] = confirmations;

    expect(pending.respondedAt).toBeNull();
    expect(pending.appointment.status).toBe('SCHEDULED');
    expect(pending.appointment.confirmationSentAt).not.toBeNull();
    expect(pending.appointment.start.getTime()).toBeGreaterThan(Date.now());

    expect(callMe.response).toBe('CALL_ME');
    expect(callMe.appointment.status).toBe('SCHEDULED');
    expect(callMe.appointment.callbackRequestedAt).not.toBeNull();
  });

  it('cada paciente tiene su autorización versionada y uno revocó MARKETING (DX-037)', async () => {
    const tenantId = await liveDemoTenantId();
    const policy = await raw.privacyPolicyVersion.findFirstOrThrow({
      where: { tenantId },
    });
    expect(policy.version).toBe(1);
    const patients = await raw.patient.findMany({
      where: { tenantId },
      include: { dataProcessingConsents: true },
    });
    for (const patient of patients) {
      const scopes = patient.dataProcessingConsents.map((c) => c.scope);
      expect(scopes).toEqual(
        expect.arrayContaining(['GENERAL', 'SENSITIVE_HEALTH']),
      );
      expect(
        patient.dataProcessingConsents.every(
          (c) => c.channel === 'IN_PERSON' && c.policyVersionId === policy.id,
        ),
      ).toBe(true);
      // Resumen deprecado coherente con la fila GENERAL.
      expect(patient.dataConsentAccepted).toBe(true);
      expect(patient.dataConsentPolicyVersion).toBe('v1');
    }
    const revoked = patients.filter((p) =>
      p.dataProcessingConsents.some(
        (c) => c.scope === 'MARKETING' && !c.granted,
      ),
    );
    expect(revoked).toHaveLength(1);
  });

  it('reparte los roles pedidos con la contraseña documentada', async () => {
    const tenantId = await liveDemoTenantId();
    const memberships = await raw.clinicMembership.findMany({
      where: { tenantId, deletedAt: null },
      include: { user: true },
    });
    const byEmail = Object.fromEntries(
      memberships.map((m) => [m.user.email, m.role]),
    );
    expect(byEmail).toEqual(
      Object.fromEntries(DEMO_USERS.map((u) => [u.email, u.role])),
    );
    expect(byEmail[`admin@${DEMO_EMAIL_DOMAIN}`]).toBe('ADMIN');
  });

  it('las citas cubren semana pasada/actual/próxima, varios estados, sedes y dentistas, dentro del horario', async () => {
    const tenantId = await liveDemoTenantId();
    const appointments = await raw.appointment.findMany({
      where: { tenantId, deletedAt: null },
    });
    const statuses = new Set(appointments.map((a) => a.status));
    for (const s of [
      'SCHEDULED',
      'CONFIRMED',
      'COMPLETED',
      'CANCELLED',
      'NO_SHOW',
    ]) {
      expect(statuses).toContain(s);
    }
    expect(new Set(appointments.map((a) => a.locationId)).size).toBe(2);
    expect(new Set(appointments.map((a) => a.providerId)).size).toBe(2);

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    expect(appointments.some((a) => a.start.getTime() < now - 2 * day)).toBe(
      true,
    );
    expect(appointments.some((a) => a.start.getTime() > now + 2 * day)).toBe(
      true,
    );
    expect(
      appointments.every(
        (a) =>
          a.start.getTime() > now - 15 * day &&
          a.start.getTime() < now + 15 * day,
      ),
    ).toBe(true);

    const schedules = await raw.locationSchedule.findMany({
      where: { tenantId, deletedAt: null },
      include: { ranges: { where: { deletedAt: null } } },
    });
    const hoursByLocation = new Map(
      schedules.map((s) => [
        s.locationId,
        { timezone: s.timezone, ranges: s.ranges },
      ]),
    );
    for (const a of appointments) {
      const hours = hoursByLocation.get(a.locationId);
      expect(hours).toBeDefined();
      expect(fitsBusinessHours(a.start, a.end, hours ?? null)).toBe(true);
    }
  });

  it('planes, pagos, plan de pagos e inventario son coherentes', async () => {
    const tenantId = await liveDemoTenantId();
    const plans = await raw.treatmentPlan.findMany({
      where: { tenantId },
      include: { items: true },
    });
    expect(new Set(plans.map((p) => p.status)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(plans.flatMap((p) => p.items.map((i) => i.status)))).toEqual(
      new Set(['PROPOSED', 'ACCEPTED', 'DONE']),
    );
    expect(plans.every((p) => p.currency === 'COP')).toBe(true);

    const payments = await raw.payment.findMany({
      where: { tenantId, deletedAt: null },
    });
    const sixtyDaysAgo = Date.now() - 61 * 24 * 60 * 60 * 1000;
    expect(payments.every((p) => p.currency === 'COP')).toBe(true);
    expect(
      payments.every(
        (p) =>
          p.paidAt.getTime() >= sixtyDaysAgo &&
          p.paidAt.getTime() <= Date.now(),
      ),
    ).toBe(true);
    expect(new Set(payments.map((p) => p.locationId)).size).toBe(2);
    expect(new Set(payments.map((p) => p.method)).size).toBeGreaterThanOrEqual(
      3,
    );
    // Ningún plan cobra más de lo facturable (ítems ACCEPTED|DONE).
    for (const plan of plans) {
      const billable = plan.items
        .filter((i) => i.status !== 'PROPOSED')
        .reduce((s, i) => s + Number(i.price) - Number(i.discount), 0);
      const paid = payments
        .filter((p) => p.treatmentPlanId === plan.id)
        .reduce((s, p) => s + Number(p.amount), 0);
      expect(paid).toBeLessThanOrEqual(billable);
    }

    const paymentPlan = await raw.paymentPlan.findFirstOrThrow({
      where: { tenantId },
      include: { installments: true },
    });
    expect(paymentPlan.status).toBe('ACTIVE');
    expect(paymentPlan.installments).toHaveLength(
      paymentPlan.installmentsCount,
    );

    const lowStock = await raw.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM (
         SELECT i.id, i."minStock",
           COALESCE(SUM(CASE m.type WHEN 'OUT' THEN -m.quantity ELSE m.quantity END), 0) AS stock
         FROM inventory_items i
         LEFT JOIN inventory_movements m ON m."itemId" = i.id
         WHERE i."tenantId" = $1::uuid AND i."deletedAt" IS NULL
         GROUP BY i.id, i."minStock"
       ) s WHERE s.stock < s."minStock"`,
      tenantId,
    );
    expect(lowStock[0].n).toBeGreaterThanOrEqual(2);
    const items = await raw.inventoryItem.findMany({ where: { tenantId } });
    expect(new Set(items.map((i) => i.locationId)).size).toBe(2);
  });

  it('DX-012: un presupuesto presentable (borrador con descuento) y otro aceptado con firma', async () => {
    const tenantId = await liveDemoTenantId();
    const acceptance = await raw.treatmentPlanAcceptance.findFirstOrThrow({
      where: { tenantId },
      include: { plan: { include: { items: true } } },
    });
    expect(acceptance.plan.status).toBe('ACCEPTED');
    expect(acceptance.plan.items.every((i) => i.status === 'ACCEPTED')).toBe(
      true,
    );
    expect(acceptance.signature.startsWith('iVBORw0KGgo')).toBe(true);
    expect(acceptance.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const presentable = await raw.treatmentPlan.findMany({
      where: {
        tenantId,
        status: 'DRAFT',
        acceptance: null,
        items: { some: { discount: { gt: 0 } } },
      },
    });
    expect(presentable.length).toBeGreaterThanOrEqual(1);
  });

  it('DX-040: un grupo A/B presentado hace más de 7 días, sin cita futura, sale en «Presupuestos por seguir»', async () => {
    const tenantId = await liveDemoTenantId();
    const options = await raw.treatmentPlan.findMany({
      where: { tenantId, optionGroupId: { not: null } },
      include: { items: { where: { deletedAt: null } } },
      orderBy: { optionLabel: 'asc' },
    });
    expect(options.map((p) => p.optionLabel)).toEqual([
      'Opción A: implante',
      'Opción B: puente fijo',
    ]);
    expect(new Set(options.map((p) => p.optionGroupId)).size).toBe(1);
    expect(new Set(options.map((p) => p.patientId)).size).toBe(1);
    expect(options.map((p) => p.items.length)).toEqual([2, 3]);
    for (const option of options) {
      expect(option.status).toBe('PRESENTED');
      expect(Date.now() - (option.presentedAt?.getTime() ?? 0)).toBeGreaterThan(
        7 * 24 * 60 * 60 * 1000,
      );
    }
    const future = await raw.appointment.count({
      where: {
        tenantId,
        patientId: options[0].patientId,
        deletedAt: null,
        start: { gt: new Date() },
      },
    });
    expect(future).toBe(0);

    const reception = DEMO_USERS.find((u) => u.role === ClinicRole.RECEPTION);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(DEMO_SUBDOMAIN))
      .send({ email: reception?.email, password: DEMO_PASSWORD })
      .expect(201);
    const token = (login.body as { accessToken: string }).accessToken;
    const res = await request(app.getHttpServer())
      .get('/api/v1/treatment-plans/pending-follow-up')
      .set('X-Tenant-Host', hostFor(DEMO_SUBDOMAIN))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      (res.body as { items: { planId: string }[] }).items
        .map((i) => i.planId)
        .sort(),
    ).toEqual(options.map((p) => p.id).sort());
  });

  it('el estado de cuenta demo enseña saldo y una cuota vencida (DX-011)', async () => {
    const tenantId = await liveDemoTenantId();
    const paymentPlan = await raw.paymentPlan.findFirstOrThrow({
      where: { tenantId },
      select: { patientId: true },
    });
    const reception = DEMO_USERS.find((u) => u.role === ClinicRole.RECEPTION);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(DEMO_SUBDOMAIN))
      .send({ email: reception?.email, password: DEMO_PASSWORD })
      .expect(201);
    const token = (login.body as { accessToken: string }).accessToken;

    const res = await request(app.getHttpServer())
      .get(`/api/v1/patients/${paymentPlan.patientId}/account-statement`)
      .set('X-Tenant-Host', hostFor(DEMO_SUBDOMAIN))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = res.body as {
      summary: { currency: string; balance: number; overdueCount: number }[];
    };
    const cop = body.summary.find((s) => s.currency === 'COP');
    expect(cop?.balance).toBeGreaterThan(0);
    expect(cop?.overdueCount).toBeGreaterThanOrEqual(1);
  });

  it('una segunda corrida no duplica nada', async () => {
    const result = await seedDemo({ quiet: true });
    expect(result.status).toBe('skipped');
    const tenantId = await liveDemoTenantId();
    expect(result.tenantId).toBe(tenantId);
    expect(await countsFor(tenantId)).toEqual(firstCounts);
    expect(
      await raw.tenant.count({ where: { subdomain: DEMO_SUBDOMAIN } }),
    ).toBe(1);
  }, 120000);

  it('no escribe nada fuera del tenant demo', async () => {
    const demoIds = (
      await raw.tenant.findMany({
        where: { subdomain: DEMO_SUBDOMAIN },
        select: { id: true },
      })
    ).map((t) => t.id);
    expect(await countsOutside(demoIds)).toEqual(outsideBefore);

    const newUsers = (await raw.user.findMany({ select: { email: true } }))
      .map((u) => u.email)
      .filter((e) => !usersBefore.includes(e));
    expect(newUsers.sort()).toEqual(DEMO_USERS.map((u) => u.email).sort());
  });

  it('todos los usuarios demo inician sesión en demo.localhost con la contraseña documentada', async () => {
    for (const user of DEMO_USERS) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('X-Tenant-Host', hostFor(DEMO_SUBDOMAIN))
        .send({ email: user.email, password: DEMO_PASSWORD })
        .expect(201);
      expect((res.body as { accessToken: string }).accessToken).toBeDefined();
    }
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(DEMO_SUBDOMAIN))
      .send({ email: DEMO_USERS[0].email, password: 'otra-cosa' })
      .expect(401);
  });

  it('--reset aborta sin escribir si un usuario demo es miembro vivo de otra clínica', async () => {
    const demoId = await liveDemoTenantId();
    const dentist = await raw.user.findFirstOrThrow({
      where: { email: DEMO_USERS[1].email, deletedAt: null },
    });
    const otherId = await createForeignTenant('otra-clinica', [dentist.id]);
    try {
      await expect(seedDemo({ quiet: true, reset: true })).rejects.toThrow(
        /otra-clinica/,
      );
      expect(await liveDemoTenantId()).toBe(demoId);
      expect(
        await raw.user.count({
          where: {
            email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` },
            deletedAt: null,
          },
        }),
      ).toBe(DEMO_USERS.length);
      expect(await countsFor(demoId)).toEqual(firstCounts);
    } finally {
      await purgeTenant(otherId);
    }
  }, 60000);

  it('--reset retira la demo anterior en blando y la reconstruye igual', async () => {
    const oldId = await liveDemoTenantId();
    const result = await seedDemo({ quiet: true, reset: true });
    expect(result.status).toBe('rebuilt');
    const newId = await liveDemoTenantId();
    expect(newId).not.toBe(oldId);
    expect(result.tenantId).toBe(newId);

    const old = await raw.tenant.findUniqueOrThrow({ where: { id: oldId } });
    expect(old.deletedAt).not.toBeNull();
    // Las citas dependen del día (si la corrida cruza la medianoche cambia la
    // ventana), así que se comparan aparte y con margen.
    const { appointments: newAppointments, ...rebuilt } =
      await countsFor(newId);
    const { appointments: firstAppointments, ...first } = firstCounts;
    expect(firstAppointments).toBeGreaterThan(0);
    expect(rebuilt).toEqual(first);
    expect(newAppointments).toBeGreaterThanOrEqual(40);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(DEMO_SUBDOMAIN))
      .send({ email: DEMO_USERS[0].email, password: DEMO_PASSWORD })
      .expect(201);
  }, 120000);
});
