import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientLinksRepository } from '../src/modules/reports/infrastructure/prisma-patient-links.repository';
import {
  GetPatientLinksUseCase,
  type PatientLinksReport,
} from '../src/modules/reports/application/use-cases/get-patient-links.use-case';
import type {
  PatientLinkMetrics,
  PatientLinkType,
} from '../src/modules/reports/domain/patient-links';
import type { AllowedLocations } from '../src/shared/tenancy/location-access';
import { resetDatabase } from './support/e2e-fixtures';
import { ReportSeeder } from './support/reports-fixtures';
import {
  linkTemplates,
  patientLinkSeeding,
  type LinkClinic,
} from './support/patient-links-fixtures';

// DX-424 · «Enlaces del paciente» contra Postgres de verdad, como dentalix_app
// (DATABASE_URL, sin BYPASSRLS) con la clínica fijada por runWithTenant.
// `raw` (DIRECT_URL, owner) solo siembra, con los triggers apagados
// (session_replication_role = replica) para poder fijar las horas de envío,
// apertura y firma en el pasado: los triggers las ponen con la hora del
// servidor. Las sedes están en America/Caracas (UTC−4 fijo).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };
/** «Ahora» del informe: decide qué enlaces ya caducaron. */
const AS_OF = new Date('2026-11-15T12:00:00Z');
const HOUR = 60 * 60 * 1000;

/** Instante de la hora de pared `hhmm` del día `day` en Caracas. */
function local(day: string, hhmm: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h + 4, min));
}
const plusHours = (date: Date, hours: number) =>
  new Date(date.getTime() + hours * HOUR);

interface Clinic extends LinkClinic {
  main: string;
  norte: string;
  empty: string;
}

async function clinic(name: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name, subdomain: name },
  });
  const seed = new ReportSeeder(raw, tenant.id);
  const main = await seed.location('Sede principal');
  const norte = await seed.location('Sede Norte');
  const empty = await seed.location('Sede sin enlaces');
  const userId = (await seed.dentist()).userId;
  const templates = await linkTemplates(raw, tenant.id);
  return {
    tenantId: tenant.id,
    main,
    norte,
    empty,
    userId,
    seed,
    ...templates,
  };
}

const { seedWithoutTriggers, signature, anamnesis, confirmation, postOp } =
  patientLinkSeeding(raw);

const row = (rows: PatientLinkMetrics[], type: PatientLinkType) => {
  const found = rows.find((r) => r.linkType === type);
  if (!found) throw new Error(`sin fila ${type}`);
  return found;
};

describe('Enlaces del paciente en la BD (DX-424, int)', () => {
  const context = new TenantContextService();
  const prisma = new PrismaService(context);
  const repo = new PrismaPatientLinksRepository(prisma, context);
  const useCase = new GetPatientLinksUseCase(repo, () => AS_OF);
  let a: Clinic;
  let b: Clinic;

  const report = (
    tenantId: string,
    opts: {
      allowed?: AllowedLocations;
      locationId?: string;
      period?: { from: string; to: string };
    } = {},
  ): Promise<PatientLinksReport> =>
    context.run(tenantId, () =>
      useCase.execute({
        ...(opts.period ?? OCTOBER),
        allowedLocationIds: opts.allowed ?? 'ALL',
        ...(opts.locationId ? { locationId: opts.locationId } : {}),
      }),
    );
  const locationRows = (r: PatientLinksReport, locationId: string) => {
    const found = r.locations.find((l) => l.locationId === locationId);
    if (!found) throw new Error(`sin sede ${locationId}`);
    return found.rows;
  };

  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(raw);
    a = await clinic('dx424-a');
    b = await clinic('dx424-b');
    const day = (d: number, hhmm = '09:00') =>
      local(`2026-10-${String(d).padStart(2, '0')}`, hhmm);

    // --- Firma de consentimientos, sede principal -------------------------
    // Enviado, abierto y firmado a las 3 h.
    await signature(a, {
      locationId: a.main,
      createdAt: day(5),
      expiresAt: day(12),
      signedAt: plusHours(day(5), 3),
    });
    // Anulado antes de caducar: NO es «caducado sin abrir».
    await signature(a, {
      locationId: a.main,
      createdAt: day(6),
      expiresAt: day(9),
      revokedAt: day(7),
    });
    // Caducado sin abrir.
    await signature(a, {
      locationId: a.main,
      createdAt: day(7),
      expiresAt: day(10),
    });
    // Abierto (pidió el código) y caducado sin firmar: abierto, no «sin abrir».
    await signature(a, {
      locationId: a.main,
      createdAt: day(8),
      expiresAt: day(11),
      openedAt: plusHours(day(8), 1),
    });
    // Aún vigente (caduca después de AS_OF): ni abierto ni caducado.
    await signature(a, {
      locationId: a.main,
      createdAt: day(8, '10:00'),
      expiresAt: new Date('2026-11-30T12:00:00Z'),
    });
    // 31/10 22:00 en Caracas (ya 01/11 en UTC): del período; caducado.
    await signature(a, {
      locationId: a.main,
      createdAt: day(31, '22:00'),
      expiresAt: local('2026-11-07', '22:00'),
    });
    // 30/09 23:30 en Caracas (ya 01/10 en UTC): fuera del período.
    await signature(a, {
      locationId: a.main,
      createdAt: local('2026-09-30', '23:30'),
      expiresAt: day(7),
    });
    // Presupuesto aceptado a las 5 h.
    await signature(a, {
      locationId: a.main,
      type: 'BUDGET',
      createdAt: day(10),
      expiresAt: day(17),
      signedAt: plusHours(day(10), 5),
    });
    // Sede Norte: firmado a las 10 h.
    await signature(a, {
      locationId: a.norte,
      createdAt: day(12),
      expiresAt: day(19),
      signedAt: plusHours(day(12), 10),
    });

    // --- Anamnesis, sede principal ------------------------------------------
    // Enviada y no abierta antes de caducar → «caducados sin abrir».
    await anamnesis(a, {
      locationId: a.main,
      createdAt: day(3),
      expiresAt: day(5),
    });
    // Abierta y enviada a las 2 h.
    await anamnesis(a, {
      locationId: a.main,
      createdAt: day(4),
      expiresAt: day(11),
      openedAt: plusHours(day(4), 1),
      submittedAt: plusHours(day(4), 2),
    });
    // Anulada (otro enlace la reemplazó): no caducó.
    await anamnesis(a, {
      locationId: a.main,
      createdAt: day(5),
      expiresAt: day(6),
      revokedAt: day(5, '12:00'),
    });
    // Abierta y caducada sin enviar.
    await anamnesis(a, {
      locationId: a.main,
      createdAt: day(6),
      expiresAt: day(8),
      openedAt: plusHours(day(6), 4),
    });

    // --- Confirmación de cita: la sede es la de la CITA -------------------
    await confirmation(a, {
      locationId: a.norte,
      createdAt: day(5),
      respondedAt: plusHours(day(5), 1),
    });
    await confirmation(a, { locationId: a.main, createdAt: day(6) });

    // --- Indicaciones postoperatorias -------------------------------------
    await postOp(a, {
      locationId: a.main,
      deliveredAt: day(12),
      channel: 'EMAIL',
      tokenExpiresAt: day(30),
      firstOpenedAt: plusHours(day(12), 6),
    });
    await postOp(a, {
      locationId: a.main,
      deliveredAt: day(13),
      channel: 'WHATSAPP_LINK',
      tokenExpiresAt: day(20),
    });
    // Impresa: no es un enlace.
    await postOp(a, {
      locationId: a.main,
      deliveredAt: day(14),
      channel: 'PRINT',
    });

    // --- Clínica B: un consentimiento en octubre --------------------------
    await signature(b, {
      locationId: b.main,
      createdAt: day(9),
      expiresAt: day(16),
      signedAt: plusHours(day(9), 1),
    });
  }, 120_000);

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it('firma: enviada, abierta y firmada cuenta en su sede; la anulada no es «caducada»', async () => {
    const r = await report(a.tenantId);
    expect(r.asOf).toEqual(AS_OF);
    expect(r.locations.map((l) => l.locationId)).toEqual([
      a.main,
      a.norte,
      a.empty,
    ]);
    expect(row(locationRows(r, a.main), 'CONSENT_SIGNATURE')).toEqual({
      linkType: 'CONSENT_SIGNATURE',
      tracksOpened: true,
      tracksCompleted: true,
      sent: 6,
      opened: 2,
      completed: 1,
      expiredUnopened: 2,
      openedRate: 33.3,
      completedRate: 16.7,
      expiredUnopenedRate: 33.3,
      medianHoursToComplete: 3,
    });
    expect(row(locationRows(r, a.norte), 'CONSENT_SIGNATURE')).toMatchObject({
      sent: 1,
      opened: 1,
      completed: 1,
      expiredUnopened: 0,
      completedRate: 100,
      medianHoursToComplete: 10,
    });
    expect(row(locationRows(r, a.main), 'BUDGET_SIGNATURE')).toMatchObject({
      sent: 1,
      opened: 1,
      completed: 1,
      expiredUnopened: 0,
      openedRate: 100,
      expiredUnopenedRate: 0,
      medianHoursToComplete: 5,
    });
  });

  it('el total junta las sedes y su mediana es la de todos los enlaces (no la media de medianas)', async () => {
    const r = await report(a.tenantId);
    expect(row(r.totals, 'CONSENT_SIGNATURE')).toMatchObject({
      sent: 7,
      opened: 3,
      completed: 2,
      expiredUnopened: 2,
      openedRate: 42.9,
      completedRate: 28.6,
      medianHoursToComplete: 6.5,
    });
  });

  it('anamnesis: enviada y no abierta antes de caducar → «caducados sin abrir»; anulada, no', async () => {
    const r = await report(a.tenantId);
    expect(row(locationRows(r, a.main), 'ANAMNESIS')).toEqual({
      linkType: 'ANAMNESIS',
      tracksOpened: true,
      tracksCompleted: true,
      sent: 4,
      opened: 2,
      completed: 1,
      expiredUnopened: 1,
      openedRate: 50,
      completedRate: 25,
      expiredUnopenedRate: 25,
      medianHoursToComplete: 2,
    });
  });

  it('confirmación: la sede es la de la cita; sin señal de apertura, abiertos y «sin abrir» en null', async () => {
    const r = await report(a.tenantId);
    expect(row(locationRows(r, a.norte), 'APPOINTMENT_CONFIRMATION')).toEqual({
      linkType: 'APPOINTMENT_CONFIRMATION',
      tracksOpened: false,
      tracksCompleted: true,
      sent: 1,
      opened: null,
      completed: 1,
      expiredUnopened: null,
      openedRate: null,
      completedRate: 100,
      expiredUnopenedRate: null,
      medianHoursToComplete: 1,
    });
    expect(
      row(locationRows(r, a.main), 'APPOINTMENT_CONFIRMATION'),
    ).toMatchObject({ sent: 1, completed: 0, completedRate: 0 });
  });

  it('indicaciones: solo las de enlace; abiertas y caducadas sin abrir, sin «completado»', async () => {
    const r = await report(a.tenantId);
    expect(row(locationRows(r, a.main), 'POST_OP_INSTRUCTIONS')).toEqual({
      linkType: 'POST_OP_INSTRUCTIONS',
      tracksOpened: true,
      tracksCompleted: false,
      sent: 2,
      opened: 1,
      completed: null,
      expiredUnopened: 1,
      openedRate: 50,
      completedRate: null,
      expiredUnopenedRate: 50,
      medianHoursToComplete: null,
    });
  });

  it('sin envíos en el período, las tasas son null («—»)', async () => {
    const r = await report(a.tenantId);
    for (const metrics of locationRows(r, a.empty)) {
      expect(metrics).toMatchObject({
        sent: 0,
        openedRate: null,
        completedRate: null,
        expiredUnopenedRate: null,
        medianHoursToComplete: null,
      });
    }
    const september = await report(a.tenantId, {
      period: { from: '2025-09-01', to: '2025-09-30' },
    });
    expect(september.totals.every((t) => t.sent === 0)).toBe(true);
    expect(september.totals.every((t) => t.openedRate === null)).toBe(true);
  });

  it('un miembro que solo ve la sede principal no ve las cifras de la Norte', async () => {
    const r = await report(a.tenantId, { allowed: [a.main] });
    expect(r.restrictedToLocations).toBe(true);
    expect(r.locations.map((l) => l.locationId)).toEqual([a.main]);
    expect(row(r.totals, 'CONSENT_SIGNATURE')).toMatchObject({
      sent: 6,
      completed: 1,
    });
    expect(row(r.totals, 'APPOINTMENT_CONFIRMATION')).toMatchObject({
      sent: 1,
      completed: 0,
    });
  });

  it('filtro por sede', async () => {
    const r = await report(a.tenantId, { locationId: a.norte });
    expect(r.locationId).toBe(a.norte);
    expect(r.locations.map((l) => l.locationId)).toEqual([a.norte]);
    expect(row(r.totals, 'ANAMNESIS').sent).toBe(0);
  });

  it('sin datos de pacientes en la respuesta', async () => {
    const text = JSON.stringify(await report(a.tenantId));
    expect(text).not.toMatch(/Paciente|paciente@example\.com|pa\*\*\*/);
    const patients = await raw.patient.findMany({
      where: { tenantId: a.tenantId },
      select: { id: true },
    });
    for (const p of patients) expect(text).not.toContain(p.id);
  });

  it('aislamiento entre clínicas: B solo ve lo suyo', async () => {
    const r = await report(b.tenantId);
    expect(row(r.totals, 'CONSENT_SIGNATURE')).toMatchObject({
      sent: 1,
      completed: 1,
    });
    expect(row(r.totals, 'ANAMNESIS').sent).toBe(0);
  });

  it('la RLS sola ya aísla: el repositorio con las sedes de A y la clínica B fijada → nada', async () => {
    const data = await context.run(b.tenantId, () =>
      repo.load(OCTOBER, [a.main, a.norte], AS_OF),
    );
    expect(data).toEqual({ locations: [], rows: [] });
  });
});

describe('Enlaces del paciente con 50 000 enlaces en 12 meses (DX-424, int)', () => {
  const context = new TenantContextService();
  const prisma = new PrismaService(context);
  const repo = new PrismaPatientLinksRepository(prisma, context);
  const useCase = new GetPatientLinksUseCase(repo, () => AS_OF);
  const YEAR = { from: '2025-11-01', to: '2026-10-31' };
  let c: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    c = await clinic('dx424-perf');
    const patientId = await c.seed.patient('perf');
    const t = c.tenantId;
    const locs = [c.main, c.norte];
    // 10 000 citas, una por hora (nunca se solapan): las de las
    // confirmaciones y las indicaciones.
    const appointments: Prisma.AppointmentCreateManyInput[] = [];
    for (let i = 0; i < 10_000; i++) {
      const start = new Date(Date.UTC(2025, 10, 1, 12) + i * HOUR);
      appointments.push({
        tenantId: t,
        locationId: locs[i % 2],
        patientId,
        providerId: c.userId,
        start,
        end: new Date(start.getTime() + HOUR / 2),
      });
    }
    for (let i = 0; i < appointments.length; i += 2000) {
      await raw.appointment.createMany({
        data: appointments.slice(i, i + 2000),
      });
    }
    // Envíos repartidos en los 365 días del período (minuto a minuto
    // distintos), con el patrón de apertura y completado según `g`.
    const sentAt = (g: string) =>
      `(TIMESTAMP '2025-11-01 12:00' + ((${g} % 365) * INTERVAL '1 day') + ((${g} % 600) * INTERVAL '1 minute'))`;
    const loc = (g: string) =>
      `(CASE WHEN ${g} % 2 = 0 THEN '${c.main}' ELSE '${c.norte}' END)::uuid`;
    await seedWithoutTriggers(async (tx) => {
      // 20 000 firmas (1 de cada 4, presupuesto): abiertas 2 de cada 3,
      // firmadas 1 de cada 3, a las 2 h. Una plantilla por fila: un solo
      // enlace vivo por paciente y plantilla.
      await tx.$executeRawUnsafe(`
        INSERT INTO "signature_requests" ("id", "tenantId", "locationId",
          "patientId", "type", "channel", "templateId", "templateVersion",
          "title", "body", "professionalUserId", "professionalName",
          "signerType", "signerName", "destination", "destinationMasked",
          "tokenHash", "expiresAt", "openedAt", "verifiedAt", "signedAt",
          "createdById", "createdAt", "updatedAt", "treatmentPlanId",
          "budgetContent", "budgetContentHash")
        SELECT gen_random_uuid(), '${t}', ${loc('g')}, '${patientId}',
               (CASE WHEN g % 4 = 0 THEN 'BUDGET' ELSE 'CONSENT' END)::"SignatureRequestType",
               'EMAIL'::"SignatureRequestChannel", CASE WHEN g % 4 = 0 THEN NULL ELSE gen_random_uuid() END,
               CASE WHEN g % 4 = 0 THEN NULL ELSE 1 END,
               'Documento', 'Texto', '${c.userId}', 'Dra. Reportes',
               'PATIENT'::"ConsentSignerType", 'Paciente', 'paciente@example.com', 'pa***@example.com',
               encode(sha256(('sig' || g)::bytea), 'hex'),
               ${sentAt('g')} + INTERVAL '7 days',
               CASE WHEN g % 3 <> 0 THEN ${sentAt('g')} + INTERVAL '1 hour' END,
               CASE WHEN g % 3 = 1 THEN ${sentAt('g')} + INTERVAL '1 hour' END,
               CASE WHEN g % 3 = 1 THEN ${sentAt('g')} + INTERVAL '2 hours' END,
               '${c.userId}', ${sentAt('g')}, now(),
               CASE WHEN g % 4 = 0 THEN gen_random_uuid() END,
               CASE WHEN g % 4 = 0 THEN '{"total": "120.00"}'::jsonb END,
               CASE WHEN g % 4 = 0 THEN encode(sha256(('bud' || g)::bytea), 'hex') END
          FROM generate_series(1, 20000) AS g`);
      // 10 000 anamnesis: la mitad enviadas a las 3 h.
      await tx.$executeRawUnsafe(`
        INSERT INTO "medical_history_submissions" ("id", "tenantId",
          "patientId", "locationId", "tokenHash", "expiresAt", "status",
          "questionnaireVersion", "answers", "submittedAt", "openedAt",
          "createdById", "createdAt", "updatedAt")
        SELECT gen_random_uuid(), '${t}', '${patientId}', ${loc('g')},
               encode(sha256(('mh' || g)::bytea), 'hex'),
               ${sentAt('g')} + INTERVAL '3 days',
               (CASE WHEN g % 2 = 0 THEN 'SUBMITTED' ELSE 'PENDING_PATIENT' END)::"MedicalHistorySubmissionStatus",
               '2026-10',
               CASE WHEN g % 2 = 0 THEN '{}'::jsonb END,
               CASE WHEN g % 2 = 0 THEN ${sentAt('g')} + INTERVAL '3 hours' END,
               CASE WHEN g % 2 = 0 THEN ${sentAt('g')} + INTERVAL '1 hour' END,
               '${c.userId}', ${sentAt('g')}, now()
          FROM generate_series(1, 10000) AS g`);
      // 10 000 confirmaciones, una por cita; 3 de cada 5 respondidas.
      await tx.$executeRawUnsafe(`
        INSERT INTO "appointment_confirmations" ("id", "tenantId",
          "appointmentId", "tokenHash", "expiresAt", "appointmentStart",
          "appointmentStatus", "respondedAt", "response", "createdAt",
          "updatedAt")
        SELECT gen_random_uuid(), a."tenantId", a."id",
               encode(sha256(('cf' || a.g)::bytea), 'hex'),
               a."start", a."start", 'SCHEDULED'::"AppointmentStatus",
               CASE WHEN a.g % 5 < 3 THEN ${sentAt('a.g')} + INTERVAL '4 hours' END,
               (CASE WHEN a.g % 5 < 3 THEN 'CONFIRM' END)::"AppointmentConfirmationResponse",
               ${sentAt('a.g')}, now()
          FROM (SELECT ap.*, row_number() OVER (ORDER BY ap."start") AS g
                  FROM "appointments" ap WHERE ap."tenantId" = '${t}') a`);
      // 10 000 indicaciones por email, la mitad abiertas.
      await tx.$executeRawUnsafe(`
        INSERT INTO "post_op_instruction_deliveries" ("id", "tenantId",
          "patientId", "appointmentId", "locationId", "templateId",
          "templateCode", "templateTitle", "templateVersion", "channel",
          "renderedText", "deliveredById", "deliveredByName", "deliveredAt",
          "tokenHash", "tokenExpiresAt", "firstOpenedAt", "createdAt")
        SELECT gen_random_uuid(), a."tenantId", a."patientId", a."id",
               a."locationId", '${c.postOpTemplateId}', 'POI-EXO',
               'Exodoncia simple', 1, 'EMAIL'::"PostOpDeliveryChannel", 'No enjuagar en 24 h',
               '${c.userId}', 'Dra. Reportes', ${sentAt('a.g')},
               encode(sha256(('po' || a.g)::bytea), 'hex'),
               ${sentAt('a.g')} + INTERVAL '30 days',
               CASE WHEN a.g % 2 = 0 THEN ${sentAt('a.g')} + INTERVAL '5 hours' END,
               ${sentAt('a.g')}
          FROM (SELECT ap.*, row_number() OVER (ORDER BY ap."start") AS g
                  FROM "appointments" ap WHERE ap."tenantId" = '${t}') a`);
    });
    for (const table of [
      'signature_requests',
      'medical_history_submissions',
      'appointment_confirmations',
      'post_op_instruction_deliveries',
      'appointments',
    ]) {
      await raw.$executeRawUnsafe(`ANALYZE "${table}"`);
    }
  }, 300_000);

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await raw.$disconnect();
  });

  it('el informe de 12 meses con 50 000 enlaces sale en menos de 500 ms como dentalix_app', async () => {
    const run = () =>
      context.run(c.tenantId, () =>
        useCase.execute({ ...YEAR, allowedLocationIds: 'ALL' }),
      );
    // La primera llamada abre las conexiones del pool: no es lo que se mide.
    await run();
    const timings: number[] = [];
    let r: PatientLinksReport | undefined;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      r = await run();
      timings.push(performance.now() - started);
    }
    const sent = r!.totals.reduce((s, t) => s + t.sent, 0);
    expect(sent).toBe(50_000);
    expect(row(r!.totals, 'CONSENT_SIGNATURE').sent).toBe(15_000);
    expect(row(r!.totals, 'BUDGET_SIGNATURE').sent).toBe(5_000);
    expect(row(r!.totals, 'ANAMNESIS')).toMatchObject({
      sent: 10_000,
      completed: 5_000,
      completedRate: 50,
      medianHoursToComplete: 3,
    });
    expect(row(r!.totals, 'APPOINTMENT_CONFIRMATION')).toMatchObject({
      sent: 10_000,
      completed: 6_000,
      medianHoursToComplete: 4,
    });
    expect(row(r!.totals, 'POST_OP_INSTRUCTIONS')).toMatchObject({
      sent: 10_000,
      opened: 5_000,
    });
    const best = Math.min(...timings);
    console.info(
      `DX-424 · 50 000 enlaces, 12 meses: ${timings.map((ms) => ms.toFixed(0)).join(' / ')} ms`,
    );
    expect(best).toBeLessThan(500);
  });
});
