import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, DocumentType, Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { fitsBusinessHours } from '../src/modules/location-schedule/application/business-hours';
import { providerWorksAt } from '../src/modules/provider-schedule/domain/provider-availability';
import {
  DEMO_EMAIL_DOMAIN,
  DEMO_PASSWORD,
  DEMO_SUBDOMAIN,
  DEMO_USERS,
  assertLocalEnvironment,
  seedDemo,
} from '../prisma/seed-demo';
import {
  DEMO_ALFA_PAYER,
  DEMO_COMPARISON_HISTORY,
  DEMO_COVERAGES,
  DEMO_PRESCRIPTION,
  DEMO_PAYERS,
  DEMO_PRESCRIPTION_SETTINGS,
  DEMO_PROFESSIONAL_SPECIALTIES,
} from '../prisma/demo/data';
import { TENANT_TABLES, purgeDemoTenants } from './support/demo-tenant-purge';
import { hostFor } from './support/tenant-host';
import { PAYER_TYPES } from '../src/modules/payers/domain/payer-type';
import { storedPayerType } from '../src/modules/payers/domain/legacy-payer-type';
import { DOCUMENT_TYPES } from '../src/modules/patients/domain/document-type';
import { legacyStoredDocType } from '../src/modules/patients/domain/legacy-doc-type';

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
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

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
  await purgeDemoTenants(raw);
  await raw.user.deleteMany({ where: { email: FOREIGN_OWNER_EMAIL } });
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
  let seededBetween: { start: number; end: number };

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
    await app.listen(0, '127.0.0.1');
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
    const start = Date.now();
    const result = await seedDemo({ quiet: true });
    seededBetween = { start, end: Date.now() };
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
    // DX-316: cada sede con su calendario de lunes a viernes (trigger), sin
    // festivos (los de ejemplo son de G6.1).
    expect(firstCounts.location_working_calendars).toBe(2);
    expect(firstCounts.location_holidays).toBe(0);
    expect(firstCounts.clinic_memberships).toBe(6);
    // DX-089: solo «Recepción Norte» tiene sedes; el resto atiende en todas.
    expect(firstCounts.membership_locations).toBe(1);
    expect(firstCounts.patients).toBe(25);
    // DX-203: la abuela paga a Sofía y a Mateo; la madre y el padre, contactos.
    expect(firstCounts.patient_responsible_parties).toBe(4);
    // DX-153: 7 pagadores y una cobertura por paciente con aseguradora;
    // DX-105 añade «Empresa Alfa» (8).
    expect(firstCounts.payers).toBe(8);
    // SEC-047: más la cobertura de Empresa Alfa del paciente con ese convenio
    // (asignarlo exige una cobertura viva del pagador).
    expect(firstCounts.patient_coverages).toBe(DEMO_COVERAGES.length + 1);
    // DX-105: dos listas (Sede Norte y Convenio Alfa), sus 5 + 3 precios, dos
    // convenios (Sura −15 % y Empresa Alfa lista) y tres pacientes asignados.
    expect(firstCounts.price_lists).toBe(2);
    expect(firstCounts.price_list_items).toBe(8);
    expect(firstCounts.agreements).toBe(2);
    expect(firstCounts.patient_agreements).toBe(3);
    expect(firstCounts.medical_history_versions).toBeGreaterThanOrEqual(8);
    // DX-247: una anamnesis antigua confirmada «Sin cambios hoy».
    expect(firstCounts.medical_history_reviews).toBe(1);
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
    // DX-274: tres gastos (uno con pago completo, uno parcial, uno pendiente)
    // y la salida de caja menor del turno abierto (4.º gasto con su pago).
    expect(firstCounts.expenses).toBe(4);
    expect(firstCounts.expense_payments).toBe(3);
    // DX-121: 5 tipos de cita con color.
    expect(firstCounts.appointment_types).toBe(5);
    // DX-122: vacaciones y almuerzo; pendientes del calendario + uno manual.
    expect(firstCounts.schedule_blocks).toBe(2);
    expect(firstCounts.appointment_waitlist).toBeGreaterThanOrEqual(3);
    expect(result.confirmationUrl).toMatch(
      /^http:\/\/demo\.localhost:3001\/confirmar\/[A-Za-z0-9_-]{43}$/,
    );
  }, 120000);

  it('demo payers use generic types and no country', async () => {
    const tenantId = await liveDemoTenantId();
    const rows = await raw.$queryRawUnsafe<
      { name: string; type: string; country: string | null }[]
    >(
      `SELECT name, type::text AS type, country FROM payers WHERE "tenantId" = $1::uuid ORDER BY name`,
      tenantId,
    );
    const demo = [...DEMO_PAYERS, DEMO_ALFA_PAYER];
    expect(rows.map((row) => row.name).sort()).toEqual(
      demo.map((payer) => payer.name).sort(),
    );
    for (const payer of demo) {
      // La demo pide tipos genéricos; la fase 1 los guarda con el código anterior.
      expect(PAYER_TYPES).toContain(payer.type);
      const row = rows.find((r) => r.name === payer.name);
      expect({
        name: payer.name,
        type: row?.type,
        country: row?.country,
      }).toEqual({
        name: payer.name,
        type: storedPayerType(payer.type),
        country: null,
      });
    }
  });

  it('demo prescription is a single-format prescription with words, HC and specialty', async () => {
    const tenantId = await liveDemoTenantId();
    const tenant = await raw.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        prescriptionPrintQuantityInWords: true,
        prescriptionRequireClinicalRecordNumber: true,
        prescriptionValidityDays: true,
      },
    });
    expect({
      printQuantityInWords: tenant.prescriptionPrintQuantityInWords,
      requireClinicalRecordNumber:
        tenant.prescriptionRequireClinicalRecordNumber,
      validityDays: tenant.prescriptionValidityDays,
    }).toEqual(DEMO_PRESCRIPTION_SETTINGS);
    // DX-324: los ajustes los fija el ADMIN por su caso de uso, auditado.
    const settingsEvents = await raw.auditEvent.findMany({
      where: { tenantId, resourceType: 'CLINIC_SETTINGS' },
      select: { action: true, actorRole: true, metadata: true },
    });
    expect(settingsEvents).toEqual([
      expect.objectContaining({
        action: 'UPDATE',
        actorRole: ClinicRole.ADMIN,
        metadata: expect.objectContaining({
          reason: 'PRESCRIPTION_SETTINGS',
        }) as unknown,
      }),
    ]);

    const rx = await raw.prescription.findFirstOrThrow({
      where: { tenantId },
      include: { items: { orderBy: { position: 'asc' } } },
    });
    expect(rx).toMatchObject({
      singleFormat: true,
      printQuantityInWords: true,
      professionalSpecialty:
        DEMO_PROFESSIONAL_SPECIALTIES[DEMO_PRESCRIPTION.dentistIndex],
    });
    expect(rx.clinicalRecordNumber).toMatch(/\S/);
    expect(rx.items.map((item) => item.quantityInWords)).toEqual([
      'veintiuno',
      'nueve',
    ]);
    const memberships = await raw.clinicMembership.findMany({
      where: { tenantId, professionalSpecialty: { not: null } },
      select: { professionalSpecialty: true },
    });
    expect(memberships.map((m) => m.professionalSpecialty).sort()).toEqual(
      [...DEMO_PROFESSIONAL_SPECIALTIES].sort(),
    );
  });

  it('the demo clinic has no local document type names', async () => {
    // R16 (pre-flight M18): toda clínica empieza sin nombres locales, también
    // la demo; ni siembra ni valor por defecto los rellena, y no hay evento
    // DOCUMENT_TYPE_NAMES_SETTINGS.
    const tenantId = await liveDemoTenantId();
    const tenant = await raw.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        docTypeNameNationalId: true,
        docTypeNamePassport: true,
        docTypeNameResidencePermit: true,
        docTypeNameTaxId: true,
        docTypeNameOther: true,
      },
    });
    expect(tenant).toEqual({
      docTypeNameNationalId: null,
      docTypeNamePassport: null,
      docTypeNameResidencePermit: null,
      docTypeNameTaxId: null,
      docTypeNameOther: null,
    });
    const events = await raw.auditEvent.findMany({
      where: { tenantId, resourceType: 'CLINIC_SETTINGS' },
      select: { metadata: true },
    });
    expect(
      events.filter(
        (e) =>
          (e.metadata as { reason?: string } | null)?.reason ===
          'DOCUMENT_TYPE_NAMES_SETTINGS',
      ),
    ).toEqual([]);
  });

  it('demo patients and contacts use generic types, neutral numbers and no label', async () => {
    // DX-327 (spec §4.9, R14): tipos genéricos, números `DEMO-…`, sin
    // etiqueta libre y sin registro sanitario de un país. La siembra pasa por
    // los escritores de R5: la columna antigua es la proyección del genérico.
    const tenantId = await liveDemoTenantId();
    const pair = {
      docType: true,
      documentType: true,
      docTypeLabel: true,
      docNumber: true,
    } as const;
    const patients = await raw.patient.findMany({
      where: { tenantId },
      select: pair,
    });
    const contacts = await raw.patientResponsibleParty.findMany({
      where: { tenantId, docNumber: { not: null } },
      select: pair,
    });
    expect(patients.length).toBeGreaterThan(10);
    expect(contacts.length).toBeGreaterThan(0);
    for (const row of [...patients, ...contacts]) {
      expect(row.documentType).not.toBeNull();
      const documentType = row.documentType as DocumentType;
      expect({
        docNumber: row.docNumber?.startsWith('DEMO-'),
        documentType: DOCUMENT_TYPES.includes(documentType),
        docTypeLabel: row.docTypeLabel,
        docType: row.docType,
      }).toEqual({
        docNumber: true,
        documentType: true,
        docTypeLabel: null,
        docType: legacyStoredDocType(documentType),
      });
    }
    const implants = await raw.patientImplant.findMany({
      where: { tenantId },
      select: { sanitaryRegistration: true },
    });
    expect(implants.length).toBeGreaterThan(0);
    expect(
      implants.filter((i) => /INVI[M]A/i.test(i.sanitaryRegistration ?? '')),
    ).toEqual([]);
  });

  it('every demo location is reviewed and complete (G1)', async () => {
    const tenantId = await liveDemoTenantId();
    const locations = await raw.location.findMany({
      where: { tenantId, deletedAt: null },
    });
    expect(locations).toHaveLength(2);
    for (const location of locations) {
      expect(location.currency).toBe('COP');
      expect(location.timeZone).toBe('America/Bogota');
      expect(location.locale).toBe('es-CO');
      // G1-B: reloj explícito, el que la demo ya pintaba.
      expect(location.hourCycle).toBe('h23');
      expect(location.country).toBe('CO');
      // El backfill D5 deja esto en NULL: la demo lo fija ella misma.
      expect(location.regionalSettingsReviewedAt).toBeInstanceOf(Date);
    }
    // La demo no depende del barrido por país: no queda ninguna fila que el
    // backfill tuviera que rellenar.
    const [swept] = await raw.$queryRaw<{ n: number }[]>`
      SELECT dx_g1_backfill_location_regional(${tenantId}::uuid)::int AS n`;
    expect(swept.n).toBe(0);
    const [sweptClock] = await raw.$queryRaw<{ n: number }[]>`
      SELECT dx_g1b_backfill_location_hour_cycle(${tenantId}::uuid)::int AS n`;
    expect(sweptClock.n).toBe(0);
    const schedules = await raw.locationSchedule.findMany({
      where: { tenantId },
    });
    for (const schedule of schedules) {
      expect(schedule.timezone).toBe('America/Bogota');
    }
  });

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

  it('deja las 5 indicaciones postoperatorias de ejemplo, POI-EXO ligada a la exodoncia simple y una entrega impresa de ayer (DX-222)', async () => {
    const tenantId = await liveDemoTenantId();
    const templates = await raw.postOpInstructionTemplate.findMany({
      where: { tenantId },
      include: { links: true },
      orderBy: { code: 'asc' },
    });
    expect(templates.map((t) => t.code)).toEqual([
      'POI-CORDAL',
      'POI-ENDO',
      'POI-EXO',
      'POI-IMPLANTE',
      'POI-PROTESIS',
    ]);
    const exo = templates.find((t) => t.code === 'POI-EXO');
    const exoItems = await raw.dentalCatalogItem.findMany({
      where: {
        tenantId,
        id: {
          in: (exo?.links ?? [])
            .map((l) => l.catalogItemId)
            .filter((id): id is string => id !== null),
        },
      },
    });
    expect(exoItems).toEqual([
      expect.objectContaining({ code: 'CX-EXO-SIMPLE', kind: 'PROCEDURE' }),
    ]);

    const principal = await raw.location.findFirstOrThrow({
      where: { tenantId, name: 'Sede principal' },
    });
    expect(principal.phone).toBe('+57 601 555 0101');

    const deliveries = await raw.postOpInstructionDelivery.findMany({
      where: { tenantId },
      include: { appointment: true },
    });
    expect(deliveries).toHaveLength(1);
    const [delivery] = deliveries;
    expect(delivery).toMatchObject({
      templateId: exo?.id,
      templateCode: 'POI-EXO',
      templateVersion: 1,
      channel: 'PRINT',
      tokenHash: null,
      recipientMasked: null,
    });
    expect(delivery.renderedText).toContain('Clínica Demo');
    expect(delivery.renderedText).not.toMatch(/\{\{/);
    expect(delivery.appointment).toMatchObject({
      status: 'COMPLETED',
      patientId: delivery.patientId,
    });
    // Cita de un día anterior (ayer, o el último día con consulta): empezó
    // antes de la medianoche de hoy en Bogotá (UTC-5 fijo).
    const bogotaWall = new Date(Date.now() - 5 * 3600 * 1000);
    const todayStart =
      Date.UTC(
        bogotaWall.getUTCFullYear(),
        bogotaWall.getUTCMonth(),
        bogotaWall.getUTCDate(),
      ) +
      5 * 3600 * 1000;
    expect(delivery.appointment.start.getTime()).toBeLessThan(todayStart);
    await expect(
      raw.auditEvent.count({
        where: {
          tenantId,
          resourceType: 'POSTOP_DELIVERY',
          resourceId: delivery.id,
        },
      }),
    ).resolves.toBe(1);
  });

  it('deja una anamnesis por enlace enviada y pendiente de revisión en la sede principal (DX-099)', async () => {
    const tenantId = await liveDemoTenantId();
    const submissions = await raw.medicalHistorySubmission.findMany({
      where: { tenantId },
      include: { patient: true, location: true },
    });
    expect(submissions).toHaveLength(1);
    const [submission] = submissions;
    expect(submission).toMatchObject({
      status: 'SUBMITTED',
      resultingVersionId: null,
      reviewedById: null,
    });
    expect(submission.patient.firstName).toBe('Natalia');
    expect(submission.location.name).toBe('Sede principal');
    expect(submission.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // La HC de la paciente no cambia hasta que el doctor la acepte.
    const versions = await raw.medicalHistoryVersion.findMany({
      where: { tenantId, patientId: submission.patientId },
    });
    expect(versions.map((v) => v.source)).toEqual(['STAFF']);
    // Crear el enlace (recepción) y el envío (la paciente, sin actor).
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId,
        resourceType: 'MEDICAL_HISTORY_SUBMISSION',
        resourceId: submission.id,
      },
      orderBy: { occurredAt: 'asc' },
    });
    expect(
      events.map((e) => [e.action, (e.metadata as { reason?: string }).reason]),
    ).toEqual([
      ['CREATE', 'ANAMNESIS_LINK_CREATED'],
      ['UPDATE', 'ANAMNESIS_SUBMITTED'],
    ]);
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

  it('deja la rotación de la segunda dentista en dos sedes, una excepción y sus citas dentro (DX-233)', async () => {
    const tenantId = await liveDemoTenantId();
    const schedules = await raw.providerSchedule.findMany({
      where: { tenantId, deletedAt: null },
      include: {
        location: { select: { name: true } },
        ranges: { where: { deletedAt: null } },
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(new Set(schedules.map((s) => s.providerId)).size).toBe(1);
    const weekdays = Object.fromEntries(
      schedules.map((s) => [
        s.location.name,
        [...new Set(s.ranges.map((r) => r.weekday))].sort(),
      ]),
    );
    expect(weekdays).toEqual({
      'Sede principal': [1, 3, 5],
      'Sede Norte': [2, 4],
    });
    const overrides = await raw.providerScheduleOverride.findMany({
      where: { tenantId, deletedAt: null },
      include: { ranges: { where: { deletedAt: null } } },
    });
    expect(overrides).toHaveLength(2);
    expect(new Set(overrides.map((o) => o.date.toISOString())).size).toBe(1);
    expect(overrides.map((o) => o.ranges.length).sort()).toEqual([0, 1]);
    await expect(
      raw.auditEvent.count({
        where: { tenantId, resourceType: 'PROVIDER_SCHEDULE' },
      }),
    ).resolves.toBe(3);

    // Las citas de la rotación (salvo las de «En clínica» de hoy, mejor
    // esfuerzo) caen en su horario.
    const providerId = schedules[0].providerId;
    const snapshot = {
      providerId,
      configured: true,
      weekly: schedules.flatMap((s) =>
        s.ranges.map((r) => ({
          locationId: s.locationId,
          weekday: r.weekday,
          startMinute: r.startMinute,
          endMinute: r.endMinute,
        })),
      ),
      overrides: [],
    };
    // «Hoy» es el día civil de la clínica (Bogotá), no el de UTC: entre las
    // 19:00 y las 24:00 de Bogotá ya es mañana en UTC (DX-251).
    const civilDay = (d: Date): string =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(
        d,
      );
    const today = civilDay(new Date());
    const theirs = await raw.appointment.findMany({
      where: { tenantId, providerId, deletedAt: null },
    });
    expect(theirs.length).toBeGreaterThan(0);
    const outside = theirs.filter(
      (a) =>
        civilDay(a.start) !== today &&
        !providerWorksAt(
          snapshot,
          a.locationId,
          a.start,
          a.end,
          'America/Bogota',
        ),
    );
    expect(outside).toEqual([]);
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

  it('la recepción de la Sede Norte queda restringida a esa sede (DX-089)', async () => {
    const tenantId = await liveDemoTenantId();
    const norte = await raw.location.findFirstOrThrow({
      where: { tenantId, name: 'Sede Norte', deletedAt: null },
      select: { id: true },
    });
    const rows = await raw.membershipLocation.findMany({
      where: { tenantId },
      select: {
        locationId: true,
        membership: { select: { user: { select: { email: true } } } },
      },
    });
    expect(rows.map((r) => [r.membership.user.email, r.locationId])).toEqual([
      [`recepcion.norte@${DEMO_EMAIL_DOMAIN}`, norte.id],
    ]);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(DEMO_SUBDOMAIN))
      .send({
        email: `recepcion.norte@${DEMO_EMAIL_DOMAIN}`,
        password: DEMO_PASSWORD,
      })
      .expect(201);
    const token = (login.body as { accessToken: string }).accessToken;
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { role: string; loc?: string[] };
    expect(claims.role).toBe(ClinicRole.RECEPTION);
    expect(claims.loc).toEqual([norte.id]);

    const res = await request(app.getHttpServer())
      .get('/api/v1/locations')
      .set('X-Tenant-Host', hostFor(DEMO_SUBDOMAIN))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((res.body as { id: string }[]).map((l) => l.id)).toEqual([norte.id]);

    // La recepción de siempre no se tocó: sin filas, atiende en todas.
    const paola = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(DEMO_SUBDOMAIN))
      .send({
        email: `recepcion@${DEMO_EMAIL_DOMAIN}`,
        password: DEMO_PASSWORD,
      })
      .expect(201);
    const paolaToken = (paola.body as { accessToken: string }).accessToken;
    const paolaClaims = JSON.parse(
      Buffer.from(paolaToken.split('.')[1], 'base64url').toString('utf8'),
    ) as { loc?: string[] };
    expect(paolaClaims.loc).toBeUndefined();
  });

  it('DX-279: política de cancelación en la sede principal y una paciente con inasistencias y una cancelación tardía', async () => {
    const tenantId = await liveDemoTenantId();
    const policies = await raw.cancellationPolicyVersion.findMany({
      where: { tenantId },
      include: { location: { select: { name: true } } },
    });
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      version: 1,
      noticeHours: 24,
      currency: 'COP',
    });
    const late = await raw.appointment.findMany({
      where: { tenantId, lateCancellation: true },
    });
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({
      status: 'CANCELLED',
      cancelledByKind: 'STAFF_FOR_PATIENT',
      noticeMinutes: 300,
      locationId: policies[0].locationId,
    });
    const noShows = await raw.appointment.count({
      where: {
        tenantId,
        patientId: late[0].patientId,
        status: 'NO_SHOW',
        noShowMarkedAt: { not: null },
      },
    });
    expect(noShows).toBeGreaterThanOrEqual(2);
    // DX-291: las incidencias tienen la política comunicada (se pueden cobrar).
    const communicated = await raw.appointment.count({
      where: {
        tenantId,
        patientId: late[0].patientId,
        policyVersionId: policies[0].id,
        OR: [{ status: 'NO_SHOW' }, { lateCancellation: true }],
      },
    });
    expect(communicated).toBe(3);
    // DX-321: sus incidencias se pueden cobrar, y la inasistencia de otro
    // paciente con la política comunicada también.
    const chargeable = await raw.appointment.findMany({
      where: {
        tenantId,
        status: 'NO_SHOW',
        policyVersionId: policies[0].id,
        patientId: { not: late[0].patientId },
      },
      select: { patientId: true },
    });
    expect(chargeable).toHaveLength(1);
    // Las cancelaciones del calendario llevan origen y motivo, y no son tardías.
    const cancelled = await raw.appointment.findMany({
      where: { tenantId, status: 'CANCELLED', lateCancellation: false },
    });
    expect(cancelled.length).toBeGreaterThan(0);
    expect(cancelled.every((a) => a.cancelReasonCode !== null)).toBe(true);
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
    // Fuera del calendario de ±15 días solo queda la historia de «Comparar
    // sedes» (DX-014): citas ATENDIDAS de su día del mes anterior.
    const outsideCalendar = appointments.filter(
      (a) =>
        a.start.getTime() <= now - 15 * day ||
        a.start.getTime() >= now + 15 * day,
    );
    expect(
      outsideCalendar.filter(
        (a) =>
          a.status !== 'COMPLETED' ||
          a.reason !== DEMO_COMPARISON_HISTORY.reason ||
          a.start.getTime() < now - 35 * day,
      ),
    ).toEqual([]);

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

  it('los cobros de los turnos demo usan el instante de la siembra, también antes del mediodía', async () => {
    const tenantId = await liveDemoTenantId();
    const payments = await raw.payment.findMany({
      where: { tenantId, cashSessionId: { not: null } },
      select: { paidAt: true },
    });
    expect(payments).toHaveLength(3);
    for (const payment of payments) {
      expect(payment.paidAt.getTime()).toBeGreaterThanOrEqual(
        seededBetween.start,
      );
      expect(payment.paidAt.getTime()).toBeLessThanOrEqual(seededBetween.end);
    }
  });

  it('los gastos demo: pagado, parcial vencido, pendiente y una salida en el turno abierto (DX-274)', async () => {
    const tenantId = await liveDemoTenantId();
    const expenses = await raw.expense.findMany({
      where: { tenantId },
      include: { payments: true },
      orderBy: { invoiceDate: 'asc' },
    });
    expect(expenses.map((e) => e.category)).toEqual([
      'Servicios públicos',
      'Arriendo',
      'Laboratorio',
      'Mensajería',
    ]);
    const paid = (e: (typeof expenses)[number]) =>
      e.payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const [utilities, rent, lab, courier] = expenses;
    expect(paid(rent)).toBe(Number(rent.amount));
    expect(paid(utilities)).toBeGreaterThan(0);
    expect(paid(utilities)).toBeLessThan(Number(utilities.amount));
    expect(utilities.dueDate!.getTime()).toBeLessThan(Date.now());
    expect(paid(lab)).toBe(0);
    expect(lab.dueDate!.getTime()).toBeGreaterThan(Date.now());

    // La salida de caja está en el turno ABIERTO; los demás pagos, fuera de caja.
    const open = await raw.cashSession.findFirstOrThrow({
      where: { tenantId, status: 'OPEN' },
    });
    expect(courier.payments).toHaveLength(1);
    expect(courier.payments[0]).toMatchObject({
      cashSessionId: open.id,
      method: 'CASH',
    });
    expect(
      [utilities, rent, lab]
        .flatMap((e) => e.payments)
        .map((p) => p.cashSessionId),
    ).toEqual([null, null]);

    // El arqueo cerrado de la mañana no se tocó: su diferencia sigue siendo la sembrada.
    const closing = await raw.cashSessionClosingLine.findFirstOrThrow({
      where: { tenantId, method: 'CASH' },
    });
    expect(Number(closing.difference)).toBe(-2000);
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
    // DX-375: todos en COP salvo un abono de hoy en USD (tasa congelada o
    // «sin tasa» según haya tasa del día).
    expect(payments.filter((p) => p.currency !== 'COP')).toEqual([
      expect.objectContaining({
        currency: 'USD',
        exchangeRateCurrency: 'COP',
      }),
    ]);
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
    // Ningún plan cobra más de lo facturable (ítems ACCEPTED|DONE), salvo el
    // que deja DX-051 con 60000 de más para enseñar lo «sin imputar».
    const overpaid = plans.filter((plan) => {
      const billable = plan.items
        .filter((i) => i.status !== 'PROPOSED')
        .reduce((s, i) => s + Number(i.price) - Number(i.discount), 0);
      const paid = payments
        .filter((p) => p.treatmentPlanId === plan.id)
        .reduce((s, p) => s + Number(p.amount), 0);
      return paid > billable;
    });
    expect(overpaid.map((plan) => plan.notes)).toEqual(['Resinas en molares.']);

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

  it('DX-051: los abonos de la demo quedan imputados, uno fijado a mano, un plan con importe sin imputar y la cola vacía', async () => {
    const tenantId = await liveDemoTenantId();
    expect(
      await raw.paymentAllocation.count({ where: { tenantId } }),
    ).toBeGreaterThan(0);
    expect(
      await raw.paymentPlanAmount.count({ where: { tenantId, manual: true } }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await raw.paymentAllocation.count({
        where: { tenantId, source: 'MANUAL' },
      }),
    ).toBeGreaterThanOrEqual(1);

    // Por plan: Σ imputado + sin imputar = Σ bases de los abonos vivos.
    const perPlan = await raw.$queryRawUnsafe<
      { planId: string; base: string; allocated: string }[]
    >(
      `SELECT b."treatmentPlanId" AS "planId", SUM(b.amount)::text AS base,
              COALESCE((SELECT SUM(a.amount) FROM payment_allocations a
                         WHERE a."tenantId" = b."tenantId"
                           AND a."treatmentPlanId" = b."treatmentPlanId"), 0)::text AS allocated
         FROM payment_plan_amounts b
         JOIN payments p ON p."tenantId" = b."tenantId" AND p.id = b."paymentId"
        WHERE b."tenantId" = $1::uuid AND p."deletedAt" IS NULL
        GROUP BY b."tenantId", b."treatmentPlanId"`,
      tenantId,
    );
    const unallocated = perPlan.filter(
      (row) => Number(row.base) - Number(row.allocated) > 0,
    );
    expect(unallocated.length).toBeGreaterThanOrEqual(1);
    expect(
      perPlan.every((row) => Number(row.allocated) <= Number(row.base)),
    ).toBe(true);

    expect(
      await raw.planAllocationRebalanceRequest.count({ where: { tenantId } }),
    ).toBe(0);
  });

  it('DX-014: las dos sedes tienen actividad en el mes anterior y en el actual', async () => {
    const tenantId = await liveDemoTenantId();
    const month = (d: Date): string =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' })
        .format(d)
        .slice(0, 7);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
    }).format(new Date());
    const [y, m, d] = today.split('-').map(Number);
    const current = today.slice(0, 7);
    const previous = month(new Date(Date.UTC(y, m - 2, 15, 12)));
    // El mes actual solo se siembra si hay un día abierto (lunes a sábado)
    // antes de hoy en el mes.
    const openDayBefore = Array.from({ length: d - 1 }, (_, i) =>
      new Date(Date.UTC(y, m - 1, i + 1)).getUTCDay(),
    ).some((weekday) => weekday !== 0);
    const months = openDayBefore ? [previous, current] : [previous];

    const locations = await raw.location.findMany({
      where: { tenantId },
      select: { id: true },
    });
    const [appointments, payments, items] = await Promise.all([
      raw.appointment.findMany({
        where: { tenantId, status: 'COMPLETED', deletedAt: null },
        select: { locationId: true, start: true },
      }),
      raw.payment.findMany({
        where: { tenantId, deletedAt: null },
        select: { locationId: true, paidAt: true },
      }),
      raw.treatmentPlanItem.findMany({
        where: { tenantId, status: 'DONE', completedAt: { not: null } },
        select: { performedLocationId: true, completedAt: true },
      }),
    ]);
    for (const wanted of months) {
      for (const { id } of locations) {
        const where = `${wanted} en ${id}`;
        expect({
          where,
          completed: appointments.some(
            (a) => a.locationId === id && month(a.start) === wanted,
          ),
          paid: payments.some(
            (p) => p.locationId === id && month(p.paidAt) === wanted,
          ),
          done: items.some(
            (i) =>
              i.performedLocationId === id &&
              i.completedAt !== null &&
              month(i.completedAt) === wanted,
          ),
        }).toEqual({ where, completed: true, paid: true, done: true });
      }
    }
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

  it('DX-050: los realizados quedan atribuidos (quién, sede, fecha) en las dos sedes, y uno «Sin atribuir»', async () => {
    const tenantId = await liveDemoTenantId();
    const done = await raw.treatmentPlanItem.findMany({
      where: { tenantId, status: 'DONE', deletedAt: null },
      include: {
        performedByMembership: { select: { role: true } },
        performedLocation: { select: { name: true } },
      },
    });
    const attributed = done.filter((i) => i.performedById !== null);
    const unattributed = done.filter((i) => i.performedById === null);
    expect(unattributed).toHaveLength(1);
    expect(unattributed[0]).toMatchObject({
      performedLocationId: null,
      completedAt: null,
    });
    expect(attributed.length).toBe(done.length - 1);
    for (const item of attributed) {
      expect(item.performedByMembership?.role).toBe('DENTIST');
      expect(item.completedAt).not.toBeNull();
      expect(item.completedAt!.getTime()).toBeLessThanOrEqual(Date.now());
    }
    expect(new Set(attributed.map((i) => i.performedLocation?.name)).size).toBe(
      2,
    );
    expect(new Set(attributed.map((i) => i.performedById)).size).toBe(2);
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
    // Las filas de imputación tampoco: a igual fecha de realización, el ítem
    // se elige por `id` (uuid aleatorio), y de ello depende en cuántas filas se
    // parte un abono. Lo imputado en total sí es el mismo.
    const {
      appointments: newAppointments,
      payment_allocations: newAllocations,
      payment_allocation_movements: newMovements,
      ...rebuilt
    } = await countsFor(newId);
    const {
      appointments: firstAppointments,
      payment_allocations: firstAllocations,
      payment_allocation_movements: firstMovements,
      ...first
    } = firstCounts;
    expect(firstAppointments).toBeGreaterThan(0);
    expect(rebuilt).toEqual(first);
    expect(newAppointments).toBeGreaterThanOrEqual(40);
    expect(newAllocations).toBeGreaterThan(0);
    expect(newMovements).toBeGreaterThanOrEqual(newAllocations);
    expect(firstAllocations).toBeGreaterThan(0);
    expect(firstMovements).toBeGreaterThanOrEqual(firstAllocations);
    const allocatedIn = async (tenantId: string) =>
      (
        await raw.paymentAllocation.aggregate({
          where: { tenantId },
          _sum: { amount: true },
        })
      )._sum.amount?.toString();
    expect(await allocatedIn(newId)).toBe(await allocatedIn(oldId));

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(DEMO_SUBDOMAIN))
      .send({ email: DEMO_USERS[0].email, password: DEMO_PASSWORD })
      .expect(201);
  }, 120000);
});
