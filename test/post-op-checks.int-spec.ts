import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { UpdateTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan-item.use-case';
import { testDiscountPolicy } from '../src/modules/treatment-plans/application/use-cases/__fixtures__/discount-fixtures';
import type { DentalCatalogRepository } from '../src/modules/dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogItem } from '../src/modules/dental-catalog/domain/entities/dental-catalog-item.entity';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { PrismaClinicalEntryAddendumRepository } from '../src/modules/clinical-entries/infrastructure/repositories/prisma-clinical-entry-addendum.repository';
import { PrismaPostOpCheckRepository } from '../src/modules/post-op-checks/infrastructure/prisma-post-op-check.repository';
import {
  PostOpChecksUseCases,
  type PostOpCheckView,
} from '../src/modules/post-op-checks/application/post-op-checks.use-cases';
import { postOpCheckFromProcedure } from '../src/modules/post-op-checks/infrastructure/post-op-check-from-procedure';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';
import {
  holdLock,
  settle,
  waitForLockWaiters,
} from './support/postgres-concurrency';

// DX-566 · Control postoperatorio con el caso de uso del ítem, el repositorio
// de planes y el de controles REALES sobre Postgres como dentalix_app (RLS
// FORCE). `raw` (DIRECT_URL, owner) siembra, comprueba y limpia. Fechas fijas
// de 2027 en Caracas (UTC−4, sin cambio de hora) y reloj inyectado.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const plans = new PrismaTreatmentPlanRepository(prisma, tenantContext);
const checksRepo = new PrismaPostOpCheckRepository(
  prisma,
  tenantContext,
  new PrismaClinicalEntryAddendumRepository(prisma, tenantContext),
);

const SUBDOMAIN = 'dx566-control-postop';
const OTHER_SUBDOMAIN = 'dx566-control-postop-b';
const EMAIL = `odontologa@${SUBDOMAIN}.test`;
const COLLEAGUE_EMAIL = `colega@${SUBDOMAIN}.test`;
/** Viernes 09/04/2027, 10:00 en Caracas. */
const FRIDAY_DONE = new Date('2027-04-09T14:00:00.000Z');
/** Lunes 12/04/2027, 11:00 en Caracas: el día de la llamada. */
const MONDAY_CALL = new Date('2027-04-12T15:00:00.000Z');
const DAY = (d: string) => new Date(`${d}T00:00:00.000Z`);

interface Seeded {
  tenantId: string;
  userId: string;
  sede: string;
  sinZona: string;
  norte: string;
  colegaId: string;
  extraction: DentalCatalogItem;
  resin: DentalCatalogItem;
  otherTenantId: string;
}
let s: Seeded;

const catalogRepo = {
  findById: (id: string) =>
    Promise.resolve([s.extraction, s.resin].find((c) => c.id === id) ?? null),
  findByIds: (ids: string[]) =>
    Promise.resolve([s.extraction, s.resin].filter((c) => ids.includes(c.id))),
} as unknown as DentalCatalogRepository;

const updateAt = (at: Date) =>
  new UpdateTreatmentPlanItemUseCase(
    plans,
    catalogRepo,
    testDiscountPolicy(),
    () => at,
  );
const ADMIN = () => ({ userId: s.userId, role: ClinicRole.ADMIN });
const audit = (locationId = s.sede): AuditRequestContext => ({
  tenantId: s.tenantId,
  locationId,
  actor: { userId: s.userId, role: ClinicRole.ADMIN },
  requestId: 'dx566-int',
  ip: null,
  userAgent: null,
});
const inSede = <T>(fn: () => Promise<T>, sede = s.sede) =>
  tenantContext.run(s.tenantId, sede, fn);
const checksAt = (at: Date) =>
  new PostOpChecksUseCases(checksRepo, tenantContext, () => at);

async function seed(): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
  });
  const other = await raw.tenant.create({
    data: { name: OTHER_SUBDOMAIN, subdomain: OTHER_SUBDOMAIN },
  });
  const user = await raw.user.create({
    data: { email: EMAIL, passwordHash: 'x', fullName: 'Dra. Carmen Rojas' },
  });
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: ClinicRole.ADMIN },
  });
  const sede = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Chacao',
    }),
  });
  const sinZona = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede sin zona',
      timeZone: null,
    }),
  });
  const norte = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Norte',
    }),
  });
  const colega = await raw.user.create({
    data: {
      email: COLLEAGUE_EMAIL,
      passwordHash: 'x',
      fullName: 'Dr. Luis Méndez',
    },
  });
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: colega.id, role: ClinicRole.DENTIST },
  });
  // Lunes a viernes, sin festivos ni horario: el calendario más simple.
  await raw.locationWorkingCalendar.updateMany({
    where: { tenantId: tenant.id },
    data: { workingWeekdays: [1, 2, 3, 4, 5] },
  });
  const item = async (
    code: string,
    labelEs: string,
    postOp: boolean,
  ): Promise<DentalCatalogItem> => {
    const row = await raw.dentalCatalogItem.create({
      data: {
        tenantId: tenant.id,
        code,
        kind: 'PROCEDURE',
        labelEs,
        color: '#0E7490',
        defaultPrice: 40,
        requiresPostOpCheck: postOp,
        postOpCheckAfterDays: 1,
      },
    });
    return {
      ...row,
      defaultPrice: 40,
      suggestedClinicalNoteTemplateId: null,
    };
  };
  return {
    tenantId: tenant.id,
    userId: user.id,
    sede: sede.id,
    sinZona: sinZona.id,
    norte: norte.id,
    colegaId: colega.id,
    extraction: await item('CIR-EXO-SIMPLE', 'Extracción simple', true),
    resin: await item('OP-RESINA-1', 'Resina de una superficie', false),
    otherTenantId: other.id,
  };
}

async function patient(name: string): Promise<string> {
  return (
    await raw.patient.create({
      data: {
        tenantId: s.tenantId,
        firstName: name,
        lastName: 'Postoperatorio',
        phone: '0414-123-4567',
      },
    })
  ).id;
}

async function planItem(
  patientId: string,
  catalog: DentalCatalogItem = s.extraction,
): Promise<string> {
  const plan = await raw.treatmentPlan.create({
    data: { tenantId: s.tenantId, patientId, currency: 'USD' },
  });
  const item = await raw.treatmentPlanItem.create({
    data: {
      tenantId: s.tenantId,
      planId: plan.id,
      toothNumber: '48',
      catalogItemId: catalog.id,
      catalogPrice: 40,
      price: 40,
      status: 'ACCEPTED',
    },
  });
  return item.id;
}

let nextSlot = 0;

/** Cita del viernes, COMPLETED, ligada al ítem (y con evolución si se pide). */
async function appointmentFor(
  patientId: string,
  itemId: string,
  withEntry: boolean,
): Promise<{ appointmentId: string; entryId: string | null }> {
  const slot = nextSlot++;
  const appointment = await raw.appointment.create({
    data: {
      tenantId: s.tenantId,
      locationId: s.sede,
      patientId,
      providerId: s.userId,
      // Una franja distinta por cita (sin solaparse): el viernes en Caracas.
      start: new Date(
        Date.parse('2027-04-09T12:00:00.000Z') + slot * 3_600_000,
      ),
      end: new Date(Date.parse('2027-04-09T12:45:00.000Z') + slot * 3_600_000),
      status: 'COMPLETED',
    },
  });
  await raw.appointmentPlanItem.create({
    data: {
      tenantId: s.tenantId,
      patientId,
      appointmentId: appointment.id,
      planItemId: itemId,
      active: true,
    },
  });
  const entry = withEntry
    ? await raw.clinicalEntry.create({
        data: {
          tenantId: s.tenantId,
          patientId,
          locationId: s.sede,
          entryDate: FRIDAY_DONE,
          notes: 'Exodoncia del 48 sin complicaciones.',
          performedById: s.userId,
          appointmentId: appointment.id,
        },
      })
    : null;
  return { appointmentId: appointment.id, entryId: entry?.id ?? null };
}

/** Cita ligada al ítem a medida (la elección de la cita y el cierre DX-439). */
async function linkedAppointment(
  patientId: string,
  itemId: string,
  input: {
    start: string;
    locationId?: string;
    status?: 'COMPLETED' | 'CANCELLED' | 'IN_CHAIR';
    providerId?: string;
  },
): Promise<string> {
  const start = new Date(input.start);
  const appointment = await raw.appointment.create({
    data: {
      tenantId: s.tenantId,
      locationId: input.locationId ?? s.sede,
      patientId,
      providerId: input.providerId ?? s.colegaId,
      start,
      end: new Date(start.getTime() + 30 * 60_000),
      status: input.status ?? 'COMPLETED',
      // En el sillón: la llegada y el paso al sillón van con la cita.
      ...(input.status === 'IN_CHAIR'
        ? { arrivedAt: start, seatedAt: start }
        : {}),
    },
  });
  await raw.appointmentPlanItem.create({
    data: {
      tenantId: s.tenantId,
      patientId,
      appointmentId: appointment.id,
      planItemId: itemId,
      active: true,
    },
  });
  return appointment.id;
}

/** Una sede con zona y calendario de lunes a viernes (para casos aislados). */
async function extraLocation(name: string): Promise<string> {
  const location = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: s.tenantId,
      name,
    }),
  });
  await raw.locationWorkingCalendar.updateMany({
    where: { locationId: location.id },
    data: { workingWeekdays: [1, 2, 3, 4, 5] },
  });
  return location.id;
}

const done = (itemId: string, at = FRIDAY_DONE, sede = s.sede) =>
  inSede(
    () =>
      updateAt(at).execute(itemId, { status: 'DONE' }, ADMIN(), audit(sede)),
    sede,
  );

const checksOf = (itemId: string) =>
  raw.postOpCheck.findMany({
    where: { planItemId: itemId },
    orderBy: { createdAt: 'asc' },
  });

const eventsOf = (checkId: string) =>
  raw.auditEvent.findMany({
    where: { resourceType: 'POST_OP_CHECK', resourceId: checkId },
    orderBy: { occurredAt: 'asc' },
    select: {
      action: true,
      metadata: true,
      actorUserId: true,
      patientId: true,
    },
  });

/** Como la app (dentalix_app, RLS FORCE), en la clínica sembrada. */
const asApp = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  prisma.runWithTenant(s.tenantId, fn);

describe('DX-566 · control postoperatorio (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeTenantsBySubdomain(raw, [SUBDOMAIN, OTHER_SUBDOMAIN]);
    await raw.user.deleteMany({
      where: { email: { in: [EMAIL, COLLEAGUE_EMAIL] } },
    });
    s = await seed();
  }, 60_000);

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, [SUBDOMAIN, OTHER_SUBDOMAIN]);
    await raw.user.deleteMany({
      where: { email: { in: [EMAIL, COLLEAGUE_EMAIL] } },
    });
    await Promise.all([raw.$disconnect(), prisma.$disconnect()]);
  });

  it('marcar hecha una extracción con control a 1 día un viernes crea el control para el lunes (siguiente día hábil), con su cita y auditado', async () => {
    const patientId = await patient('Viernes');
    const itemId = await planItem(patientId);
    const { appointmentId } = await appointmentFor(patientId, itemId, false);
    await done(itemId);
    const [check] = await checksOf(itemId);
    expect(check).toMatchObject({
      patientId,
      status: 'PENDING',
      dueOn: DAY('2027-04-12'),
      locationId: s.sede,
      professionalId: s.userId,
      appointmentId,
      catalogItemId: s.extraction.id,
      procedureName: 'Extracción simple',
    });
    expect(await eventsOf(check.id)).toEqual([
      {
        action: 'CREATE',
        metadata: {
          reason: 'POST_OP_CHECK_CREATED',
          params: { itemId, appointmentId },
        },
        actorUserId: s.userId,
        patientId,
      },
    ]);
  });

  it('un procedimiento que no pide control no crea nada', async () => {
    const patientId = await patient('Resina');
    const itemId = await planItem(patientId, s.resin);
    await done(itemId);
    expect(await checksOf(itemId)).toEqual([]);
  });

  it('idempotente: el alta repetida (otro DONE del mismo ítem) no duplica el PENDING', async () => {
    const patientId = await patient('Idempotente');
    const itemId = await planItem(patientId);
    await done(itemId);
    const item = await raw.treatmentPlanItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    const again = await Promise.all(
      [1, 2].map(() =>
        asApp((tx) =>
          postOpCheckFromProcedure(tx, { tenantId: s.tenantId, item }),
        ),
      ),
    );
    expect(again).toEqual([null, null]);
    expect(await checksOf(itemId)).toHaveLength(1);
  });

  it('sacarlo de DONE (CLEAR) anula el pendiente; uno ya cerrado no cambia', async () => {
    const patientId = await patient('Revertido');
    const itemId = await planItem(patientId);
    await done(itemId);
    await inSede(() =>
      updateAt(FRIDAY_DONE).execute(
        itemId,
        { status: 'ACCEPTED' },
        ADMIN(),
        audit(),
      ),
    );
    const [check] = await checksOf(itemId);
    expect(check).toMatchObject({
      status: 'CANCELLED',
      cancelledReason: 'PROCEDURE_REVERTED',
      closedById: s.userId,
      outcome: null,
    });
    expect((await eventsOf(check.id)).map((e) => e.metadata)).toEqual([
      expect.objectContaining({ reason: 'POST_OP_CHECK_CREATED' }),
      {
        reason: 'POST_OP_CHECK_PROCEDURE_REVERTED',
        params: { itemId },
        statusChange: { from: 'PENDING', to: 'CANCELLED' },
      },
    ]);

    // Otro DONE crea un control nuevo; si se cierra y se vuelve a revertir,
    // el cerrado se queda como está.
    await done(itemId);
    const second = (await checksOf(itemId))[1];
    await inSede(() =>
      checksAt(MONDAY_CALL).recordAttempt(
        second.id,
        { outcome: 'FINE' },
        ADMIN(),
        audit(),
      ),
    );
    await inSede(() =>
      updateAt(FRIDAY_DONE).execute(
        itemId,
        { status: 'ACCEPTED' },
        ADMIN(),
        audit(),
      ),
    );
    expect((await checksOf(itemId)).map((c) => [c.status, c.outcome])).toEqual([
      ['CANCELLED', null],
      ['DONE', 'FINE'],
    ]);
  });

  it('borrar el ítem anula el pendiente (ITEM_DELETED)', async () => {
    const patientId = await patient('Borrado');
    const itemId = await planItem(patientId);
    await done(itemId);
    await inSede(() => plans.softDeleteItem(itemId, audit()));
    const [check] = await checksOf(itemId);
    expect(check).toMatchObject({
      status: 'CANCELLED',
      cancelledReason: 'ITEM_DELETED',
    });
  });

  it('corregir la fecha del DONE (CORRECT, ADMIN) recalcula el día de la llamada', async () => {
    const patientId = await patient('Corregido');
    const itemId = await planItem(patientId);
    await done(itemId);
    // M1: el catálogo cambia sus días DESPUÉS del alta; el recálculo usa los
    // que el control congeló (1), no los de hoy (5).
    await raw.dentalCatalogItem.update({
      where: { id: s.extraction.id },
      data: { postOpCheckAfterDays: 5 },
    });
    try {
      // Al martes 06/04/2027: la llamada pasa al miércoles 07.
      await inSede(() =>
        updateAt(MONDAY_CALL).execute(
          itemId,
          { completedAt: new Date('2027-04-06T15:00:00.000Z') },
          ADMIN(),
          audit(),
        ),
      );
    } finally {
      await raw.dentalCatalogItem.update({
        where: { id: s.extraction.id },
        data: { postOpCheckAfterDays: 1 },
      });
    }
    const [check] = await checksOf(itemId);
    expect(check).toMatchObject({
      status: 'PENDING',
      dueOn: DAY('2027-04-07'),
    });
    expect((await eventsOf(check.id)).map((e) => e.metadata)).toContainEqual({
      reason: 'POST_OP_CHECK_RESCHEDULED',
      params: { itemId },
    });
  });

  it('una sede sin zona horaria no crea el control y no bloquea el DONE', async () => {
    const patientId = await patient('SinZona');
    const itemId = await planItem(patientId);
    const out = await done(itemId, FRIDAY_DONE, s.sinZona);
    expect(out.status).toBe('DONE');
    expect(await checksOf(itemId)).toEqual([]);
  });

  it('la lista del lunes lo trae (con teléfono y WhatsApp) y el contador lo cuenta; el martes sale como vencido', async () => {
    const patientId = await patient('Lista');
    const itemId = await planItem(patientId);
    await done(itemId);
    const [check] = await checksOf(itemId);
    const list = await inSede(() =>
      checksAt(MONDAY_CALL).list({
        role: ClinicRole.RECEPTION,
        pageSize: 100,
      }),
    );
    const row = list.items.find((i) => i.id === check.id);
    expect(row).toMatchObject({
      dueOn: '2027-04-12',
      overdueDays: 0,
      patientName: 'Lista Postoperatorio',
      patientPhone: '0414-123-4567',
      whatsAppDigits: '584141234567',
      clinicalHidden: true,
      procedureName: null,
      attempts: null,
    });
    const tuesday = new Date('2027-04-13T15:00:00.000Z');
    const count = await inSede(() => checksAt(tuesday).count({}));
    const onlyTuesday = await inSede(() =>
      checksAt(tuesday).count({ include: 'today' }),
    );
    expect(count.total).toBeGreaterThan(0);
    expect(count.overdue).toBe(count.total);
    expect(onlyTuesday).toEqual({ total: 0, overdue: 0 });
    // El viernes de la extracción todavía no toca llamar.
    const friday = await inSede(() =>
      checksAt(FRIDAY_DONE).list({ role: ClinicRole.ADMIN, pageSize: 100 }),
    );
    expect(friday.items.map((i) => i.id)).not.toContain(check.id);
  });

  it('desenlace con evolución en la cita: ADENDA inmutable a esa evolución, en la misma transacción', async () => {
    const patientId = await patient('Adenda');
    const itemId = await planItem(patientId);
    const { entryId } = await appointmentFor(patientId, itemId, true);
    await done(itemId);
    const [check] = await checksOf(itemId);
    const useCases = checksAt(MONDAY_CALL);
    const first = await inSede(() =>
      useCases.recordAttempt(
        check.id,
        { outcome: 'NO_ANSWER' },
        ADMIN(),
        audit(),
      ),
    );
    expect(first).toMatchObject({ status: 'PENDING', attemptsCount: 1 });
    const closed = await inSede(() =>
      useCases.recordAttempt(
        check.id,
        { outcome: 'DISCOMFORT', note: 'Dolor leve, toma analgésico' },
        ADMIN(),
        audit(),
      ),
    );
    expect(closed).toMatchObject({
      status: 'DONE',
      outcome: 'DISCOMFORT',
      clinicalEntryId: entryId,
      attemptsCount: 2,
    });
    const addendum = await raw.clinicalEntryAddendum.findUniqueOrThrow({
      where: { id: closed.addendumId! },
    });
    expect(addendum).toMatchObject({
      clinicalEntryId: entryId,
      reason: 'Control postoperatorio',
      authorId: s.userId,
    });
    expect(addendum.text).toContain('Resultado: Molestias.');
    expect(addendum.text).toContain('Nota: Dolor leve, toma analgésico');
    expect(addendum.text).toContain('No contesta · Dra. Carmen Rojas');
    // La auditoría lleva el resultado y dónde quedó, nunca la nota.
    const events = await eventsOf(check.id);
    expect(events.at(-1)).toMatchObject({
      action: 'UPDATE',
      metadata: {
        reason: 'POST_OP_CHECK_DISCOMFORT',
        statusChange: { from: 'PENDING', to: 'DONE' },
        params: {
          attemptId: closed.attemptId,
          clinicalEntryId: entryId,
          addendumId: closed.addendumId,
        },
      },
    });
    expect(JSON.stringify(events)).not.toContain('analgésico');
    // Inmutable (DX-038) como la app.
    await expect(
      asApp(
        (tx) =>
          tx.$executeRaw`UPDATE "clinical_entry_addenda" SET "text" = 'otro' WHERE "id" = ${addendum.id}::uuid`,
      ),
    ).rejects.toThrow();
    // Cerrado: otro intento es 409 y la fila no cambia.
    await expect(
      inSede(() =>
        useCases.recordAttempt(check.id, { outcome: 'FINE' }, ADMIN(), audit()),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('sin evolución en la cita: EVOLUCIÓN nueva SIN cita (nombra la cita en el texto) y la cita sigue en «Falta evolución»; tres «No contesta» = No localizado', async () => {
    const patientId = await patient('Evolucion');
    const itemId = await planItem(patientId);
    const { appointmentId } = await appointmentFor(patientId, itemId, false);
    await done(itemId);
    const [check] = await checksOf(itemId);
    const useCases = checksAt(MONDAY_CALL);
    const results: PostOpCheckView[] = [];
    for (let i = 0; i < 3; i++) {
      results.push(
        await inSede(() =>
          useCases.recordAttempt(
            check.id,
            { outcome: 'NO_ANSWER' },
            ADMIN(),
            audit(),
          ),
        ),
      );
    }
    const last = results[2];
    expect(results.map((r) => r.status)).toEqual([
      'PENDING',
      'PENDING',
      'UNREACHABLE',
    ]);
    expect(last).toMatchObject({
      status: 'UNREACHABLE',
      outcome: null,
      addendumId: null,
      attemptsCount: 3,
    });
    const entry = await raw.clinicalEntry.findUniqueOrThrow({
      where: { id: last.clinicalEntryId as string },
    });
    expect(entry).toMatchObject({
      patientId,
      appointmentId: null,
      reason: 'Control postoperatorio',
      performedById: s.userId,
      locationId: s.sede,
    });
    expect(entry.notes).toContain(
      'Resultado: No localizado tras 3 intentos de llamada.',
    );
    // «Control de la cita del 09/04/2027» (formato de la sede).
    expect(entry.notes).toMatch(/Control de la cita del .*2027\./);
    // La cita no queda documentada por la llamada: sigue sin evolución.
    expect(await raw.clinicalEntry.count({ where: { appointmentId } })).toBe(0);
  });

  it('guardas de integridad como dentalix_app: identidad congelada, cerrado inmutable, sin DELETE; intentos append-only', async () => {
    const patientId = await patient('Guardas');
    const itemId = await planItem(patientId);
    await done(itemId);
    const [check] = await checksOf(itemId);
    const fails = (sql: Prisma.Sql) =>
      expect(asApp((tx) => tx.$executeRaw(sql))).rejects.toThrow();
    await fails(
      Prisma.sql`UPDATE "post_op_checks" SET "procedureName" = 'Otra' WHERE "id" = ${check.id}::uuid`,
    );
    await fails(
      Prisma.sql`UPDATE "post_op_checks" SET "createdAt" = "createdAt" - interval '1 day' WHERE "id" = ${check.id}::uuid`,
    );
    await fails(
      Prisma.sql`DELETE FROM "post_op_checks" WHERE "id" = ${check.id}::uuid`,
    );
    await fails(
      Prisma.sql`UPDATE "post_op_checks" SET "status" = 'DONE' WHERE "id" = ${check.id}::uuid`,
    );
    // La fecha sí cambia mientras está PENDING (la corrección del ítem).
    await asApp(
      (tx) =>
        tx.$executeRaw`UPDATE "post_op_checks" SET "dueOn" = '2027-04-13' WHERE "id" = ${check.id}::uuid`,
    );
    const closed = await inSede(() =>
      checksAt(MONDAY_CALL).recordAttempt(
        check.id,
        { outcome: 'FINE' },
        ADMIN(),
        audit(),
      ),
    );
    await fails(
      Prisma.sql`UPDATE "post_op_checks" SET "dueOn" = '2027-04-14' WHERE "id" = ${check.id}::uuid`,
    );
    await fails(
      Prisma.sql`UPDATE "post_op_check_attempts" SET "note" = 'x' WHERE "id" = ${closed.attemptId}::uuid`,
    );
    await fails(
      Prisma.sql`DELETE FROM "post_op_check_attempts" WHERE "id" = ${closed.attemptId}::uuid`,
    );
    // Un intento sobre un control cerrado lo rechaza la BD aunque la app no mire.
    await fails(
      Prisma.sql`INSERT INTO "post_op_check_attempts" ("id", "tenantId", "checkId", "outcome", "byId")
                 VALUES (gen_random_uuid(), ${s.tenantId}::uuid, ${check.id}::uuid, 'FINE', ${s.userId}::uuid)`,
    );
  });

  it('RLS: otra clínica no ve ni cuenta los controles', async () => {
    const patientId = await patient('Aislado');
    const itemId = await planItem(patientId);
    await done(itemId);
    const seen = await prisma.runWithTenant(s.otherTenantId, (tx) =>
      tx.postOpCheck.count({ where: { planItemId: itemId } }),
    );
    expect(seen).toBe(0);
    const counted = await tenantContext.run(s.otherTenantId, () =>
      checksAt(MONDAY_CALL).count({}),
    );
    expect(counted).toEqual({ total: 0, overdue: 0 });
  });

  it('fusión de pacientes (DX-266): el control pasa al conservado y el resto no cambia', async () => {
    const absorbed = await patient('Absorbido');
    const kept = await patient('Conservado');
    const itemId = await planItem(absorbed);
    await done(itemId);
    const [before] = await checksOf(itemId);
    await asApp(
      (tx) =>
        tx.$queryRaw`SELECT dx_merge_patients(${absorbed}::uuid, ${kept}::uuid, ${s.userId}::uuid)`,
    );
    const [after] = await checksOf(itemId);
    expect(after).toEqual({
      ...before,
      patientId: kept,
    });
  });

  // ---------------------------------------------------------------------
  // Revisión independiente (I2)
  // ---------------------------------------------------------------------

  it('(a) DX-439: el DONE desde la cita atendida usa ESA cita aunque haya otra ligada más tarde', async () => {
    const patientId = await patient('CierreCita');
    const itemId = await planItem(patientId);
    const closing = await linkedAppointment(patientId, itemId, {
      start: '2027-04-09T20:00:00.000Z',
    });
    await linkedAppointment(patientId, itemId, {
      start: '2027-04-09T21:00:00.000Z',
    });
    await inSede(() =>
      updateAt(FRIDAY_DONE).execute(
        itemId,
        { status: 'DONE', appointmentId: closing },
        ADMIN(),
        audit(),
      ),
    );
    const [check] = await checksOf(itemId);
    expect(check).toMatchObject({
      appointmentId: closing,
      dueOn: DAY('2027-04-12'),
    });
  });

  it('(b) la cita ligada elegida: la más tardía del mismo día civil en la sede, COMPLETED o en clínica; nunca otro día, otra sede ni CANCELLED', async () => {
    const patientId = await patient('EleccionCita');
    const itemId = await planItem(patientId);
    // Candidatas descartadas (más tardías a propósito).
    await linkedAppointment(patientId, itemId, {
      start: '2027-04-10T14:30:00.000Z', // sábado: otro día
    });
    await linkedAppointment(patientId, itemId, {
      start: '2027-04-09T22:30:00.000Z',
      locationId: s.norte, // otra sede
    });
    await linkedAppointment(patientId, itemId, {
      start: '2027-04-09T23:30:00.000Z',
      status: 'CANCELLED',
    });
    // Válidas: gana la más tardía (en el sillón).
    await linkedAppointment(patientId, itemId, {
      start: '2027-04-09T19:30:00.000Z',
    });
    const latest = await linkedAppointment(patientId, itemId, {
      start: '2027-04-09T21:30:00.000Z',
      status: 'IN_CHAIR',
    });
    await done(itemId);
    const [check] = await checksOf(itemId);
    expect(check.appointmentId).toBe(latest);
  });

  it('(c) CORRECT de sede y profesional: el pendiente se muda a la sede y al profesional corregidos', async () => {
    const patientId = await patient('CorrigeSede');
    const itemId = await planItem(patientId);
    await done(itemId);
    await inSede(() =>
      updateAt(MONDAY_CALL).execute(
        itemId,
        { performedLocationId: s.norte, performedById: s.colegaId },
        ADMIN(),
        audit(),
      ),
    );
    const [check] = await checksOf(itemId);
    expect(check).toMatchObject({
      status: 'PENDING',
      locationId: s.norte,
      professionalId: s.colegaId,
      dueOn: DAY('2027-04-12'),
    });
  });

  it('(d) sede sin calendario: no se crea y el DONE sigue; horario con tramos solo el miércoles: la llamada cae el miércoles', async () => {
    const sinCalendario = await extraLocation('Sede sin calendario');
    await raw.locationWorkingCalendar.deleteMany({
      where: { locationId: sinCalendario },
    });
    const p1 = await patient('SinCalendario');
    const i1 = await planItem(p1);
    const out = await done(i1, FRIDAY_DONE, sinCalendario);
    expect(out.status).toBe('DONE');
    expect(await checksOf(i1)).toEqual([]);

    const soloMiercoles = await extraLocation('Sede solo miércoles');
    const schedule = await raw.locationSchedule.create({
      data: {
        tenantId: s.tenantId,
        locationId: soloMiercoles,
        timezone: 'America/Caracas',
      },
    });
    await raw.locationScheduleRange.create({
      data: {
        tenantId: s.tenantId,
        scheduleId: schedule.id,
        weekday: 3,
        startMinute: 8 * 60,
        endMinute: 17 * 60,
      },
    });
    const p2 = await patient('SoloMiercoles');
    const i2 = await planItem(p2);
    await done(i2, FRIDAY_DONE, soloMiercoles);
    const [check] = await checksOf(i2);
    expect(check.dueOn).toEqual(DAY('2027-04-14'));
  });

  it('(e) carrera intento contra CLEAR: el CLEAR que llega antes anula y el intento recibe 409 sin dejar nada', async () => {
    const patientId = await patient('Carrera');
    const itemId = await planItem(patientId);
    await done(itemId);
    const [check] = await checksOf(itemId);
    const held = await holdLock(
      raw,
      (tx) =>
        tx.$queryRaw`SELECT 1 FROM "post_op_checks" WHERE "id" = ${check.id}::uuid FOR UPDATE`,
    );
    const clear = settle(
      inSede(() =>
        updateAt(FRIDAY_DONE).execute(
          itemId,
          { status: 'ACCEPTED' },
          ADMIN(),
          audit(),
        ),
      ),
    );
    await waitForLockWaiters(raw, [held.pid], 1);
    const attempt = settle(
      inSede(() =>
        checksAt(MONDAY_CALL).recordAttempt(
          check.id,
          { outcome: 'FINE' },
          ADMIN(),
          audit(),
        ),
      ),
    );
    await waitForLockWaiters(raw, [held.pid], 2);
    held.release();
    await held.done;
    expect(await clear).toMatchObject({ status: 'fulfilled' });
    const failed = await attempt;
    expect(failed).toMatchObject({ status: 'rejected' });
    expect(JSON.stringify(failed)).toContain('ya está cerrado');
    expect(
      await raw.postOpCheck.findUniqueOrThrow({ where: { id: check.id } }),
    ).toMatchObject({ status: 'CANCELLED', clinicalEntryId: null });
    expect(
      await raw.postOpCheckAttempt.count({ where: { checkId: check.id } }),
    ).toBe(0);
  });

  it('(f) DONE tras CLEAR crea un PENDING nuevo (el anulado se queda)', async () => {
    const patientId = await patient('RehechoTrasClear');
    const itemId = await planItem(patientId);
    await done(itemId);
    await inSede(() =>
      updateAt(FRIDAY_DONE).execute(
        itemId,
        { status: 'ACCEPTED' },
        ADMIN(),
        audit(),
      ),
    );
    await done(itemId);
    const checks = await checksOf(itemId);
    expect(checks.map((c) => c.status)).toEqual(['CANCELLED', 'PENDING']);
    expect(checks[1].id).not.toBe(checks[0].id);
  });

  it('(g) sede sin formato regional: cerrar da 409 LOCATION_LOCALE_REQUIRED y no queda nada', async () => {
    const sinFormato = await extraLocation('Sede sin formato');
    const patientId = await patient('SinFormato');
    const itemId = await planItem(patientId);
    await done(itemId, FRIDAY_DONE, sinFormato);
    const [check] = await checksOf(itemId);
    await raw.location.update({
      where: { id: sinFormato },
      data: { locale: null },
    });
    await expect(
      inSede(
        () =>
          checksAt(MONDAY_CALL).recordAttempt(
            check.id,
            { outcome: 'FINE' },
            ADMIN(),
            audit(sinFormato),
          ),
        sinFormato,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'LOCATION_LOCALE_REQUIRED' },
    });
    expect(
      await raw.postOpCheck.findUniqueOrThrow({ where: { id: check.id } }),
    ).toMatchObject({ status: 'PENDING' });
    expect(
      await raw.postOpCheckAttempt.count({ where: { checkId: check.id } }),
    ).toBe(0);
  });
});
