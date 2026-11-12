import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { UpdateTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan-item.use-case';
import { RemoveTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/remove-treatment-plan-item.use-case';
import { testDiscountPolicy } from '../src/modules/treatment-plans/application/use-cases/__fixtures__/discount-fixtures';
import type { DentalCatalogRepository } from '../src/modules/dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogItem } from '../src/modules/dental-catalog/domain/entities/dental-catalog-item.entity';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';
import {
  type DefaultRecallTypes,
  seedDefaultRecallTypes,
} from './support/recall-types';
import { PrismaRecallRepository } from '../src/modules/recall/infrastructure/prisma-recall.repository';
import {
  GetPatientRecallsUseCase,
  SetPatientRecallUseCase,
  type SetPatientRecallInput,
} from '../src/modules/recall/application/use-cases/recall.use-cases';
import {
  backendPid,
  settle,
  waitForLockWaiters,
} from './support/postgres-concurrency';

// DX-015-bis · «El reloj lo mueve el procedimiento», con el caso de uso y el
// repositorio de planes REALES sobre Postgres como dentalix_app (RLS FORCE).
// El criterio del ticket tal cual: una profilaxis DONE el 10/04/2027 a las
// 22:30 en Caracas (02:30 UTC del 11) deja el recall de Higiene con vence el
// 10/10/2027. Además: un procedimiento que no dispara no toca nada; sacarlo de
// DONE vuelve a la base anterior (D5); corregir la fecha recalcula; dos DONE
// concurrentes del mismo paciente dejan UNA fila con el máximo. `raw`
// (DIRECT_URL, owner) siembra, comprueba y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const plans = new PrismaTreatmentPlanRepository(prisma, tenantContext);

const SUBDOMAIN = 'dx015bis-procedimiento';
const EMAIL = `odontologa@${SUBDOMAIN}.test`;
/** 22:30 del 10/04/2027 en Caracas (UTC−4). */
const DONE_AT = new Date('2027-04-11T02:30:00.000Z');
const DAY = (d: string) => new Date(`${d}T00:00:00.000Z`);

interface Seeded {
  tenantId: string;
  userId: string;
  sede: string;
  types: DefaultRecallTypes;
  catalog: Record<'PROFILAXIS' | 'RESINA' | 'RASPADO', DentalCatalogItem>;
}
let s: Seeded;

const catalogRepo = {
  findById: (id: string) =>
    Promise.resolve(Object.values(s.catalog).find((c) => c.id === id) ?? null),
  findByIds: (ids: string[]) =>
    Promise.resolve(Object.values(s.catalog).filter((c) => ids.includes(c.id))),
} as unknown as DentalCatalogRepository;

const updateAt = (at: Date) =>
  new UpdateTreatmentPlanItemUseCase(
    plans,
    catalogRepo,
    testDiscountPolicy(),
    () => at,
  );
const ADMIN = () => ({ userId: s.userId, role: ClinicRole.ADMIN });
const audit = (): AuditRequestContext => ({
  tenantId: s.tenantId,
  locationId: s.sede,
  actor: { userId: s.userId, role: ClinicRole.ADMIN },
  requestId: 'dx015bis-int',
  ip: null,
  userAgent: null,
});
const inSede = <T>(fn: () => Promise<T>) =>
  tenantContext.run(s.tenantId, s.sede, fn);

async function seed(): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
  });
  const user = await raw.user.create({
    data: { email: EMAIL, passwordHash: 'x', fullName: 'Dra. Rondón' },
  });
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: ClinicRole.ADMIN },
  });
  const sede = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Chacao',
      timeZone: 'America/Caracas',
    }),
  });
  const item = async (code: string, labelEs: string) => {
    const row = await raw.dentalCatalogItem.create({
      data: {
        tenantId: tenant.id,
        code,
        kind: 'PROCEDURE',
        labelEs,
        color: '#0E7490',
        defaultPrice: 40,
      },
    });
    return {
      ...row,
      defaultPrice: 40,
      suggestedClinicalNoteTemplateId: null,
    } as DentalCatalogItem;
  };
  // Los códigos del catálogo semilla: la siembra liga los disparadores.
  const catalog = {
    PROFILAXIS: await item('PREV-PROFILAXIS', 'Profilaxis'),
    RESINA: await item('OP-RESINA-1', 'Resina de una superficie'),
    RASPADO: await item('PERIO-RASPADO', 'Raspado y alisado radicular'),
  };
  const types = await seedDefaultRecallTypes(raw, tenant.id);
  return {
    tenantId: tenant.id,
    userId: user.id,
    sede: sede.id,
    types,
    catalog,
  };
}

async function patient(name: string): Promise<string> {
  return (
    await raw.patient.create({
      data: { tenantId: s.tenantId, firstName: name, lastName: 'Recall' },
    })
  ).id;
}

/** Un plan en borrador con un ítem ACEPTADO de ese procedimiento. */
async function planItem(patientId: string, code: keyof Seeded['catalog']) {
  const plan = await raw.treatmentPlan.create({
    data: { tenantId: s.tenantId, patientId, currency: 'USD' },
  });
  const item = await raw.treatmentPlanItem.create({
    data: {
      tenantId: s.tenantId,
      planId: plan.id,
      toothNumber: '11',
      catalogItemId: s.catalog[code].id,
      catalogPrice: 40,
      price: 40,
      status: 'ACCEPTED',
    },
  });
  return item.id;
}

/** El PUT …/recalls/:kind real (caso de uso + repositorio Prisma). */
const recallRepo = new PrismaRecallRepository(prisma, tenantContext);
/** 11:00 del 07/11/2027 en Caracas: «hoy» del PUT. */
const PUT_NOW = new Date('2027-11-07T15:00:00.000Z');
const putRecall = (
  patientId: string,
  recallTypeId: string,
  input: SetPatientRecallInput,
) =>
  inSede(() =>
    new SetPatientRecallUseCase(
      recallRepo,
      () => PUT_NOW,
      new GetPatientRecallsUseCase(recallRepo, () => PUT_NOW),
    ).execute(patientId, { id: recallTypeId }, input, s.userId),
  );

const recallsOf = (patientId: string) =>
  raw.patientRecall.findMany({
    where: { patientId },
    orderBy: { createdAt: 'asc' },
  });

const done = (itemId: string, at = DONE_AT) =>
  inSede(() =>
    updateAt(at).execute(itemId, { status: 'DONE' }, ADMIN(), audit()),
  );

describe('DX-015-bis · el DONE de un procedimiento mueve el reloj del recall (int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeTenantsBySubdomain(raw, [SUBDOMAIN]);
    await raw.user.deleteMany({ where: { email: EMAIL } });
    s = await seed();
  }, 60_000);

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, [SUBDOMAIN]);
    await raw.user.deleteMany({ where: { email: EMAIL } });
    await Promise.all([raw.$disconnect(), prisma.$disconnect()]);
  });

  it('la siembra liga Higiene ← profilaxis y Mantenimiento periodontal ← raspado; Control sin disparador (no hay IMG-CONSULTA)', async () => {
    const triggers = await raw.recallTypeTrigger.findMany({
      where: { tenantId: s.tenantId },
      select: { recallTypeId: true, catalogItemId: true },
    });
    expect(triggers).toEqual(
      expect.arrayContaining([
        {
          recallTypeId: s.types.HYGIENE,
          catalogItemId: s.catalog.PROFILAXIS.id,
        },
        { recallTypeId: s.types.PERIO, catalogItemId: s.catalog.RASPADO.id },
      ]),
    );
    expect(triggers).toHaveLength(2);
  });

  it('criterio: profilaxis DONE el 10/04/2027 22:30 en Caracas (02:30 UTC del 11) → Higiene vence el 10/10/2027', async () => {
    const patientId = await patient('Criterio');
    const itemId = await planItem(patientId, 'PROFILAXIS');
    const out = await done(itemId);
    const [recall] = await recallsOf(patientId);
    expect(out.recallUpdates).toEqual([
      {
        recallId: recall.id,
        recallTypeId: s.types.HYGIENE,
        recallTypeName: 'Higiene',
        dueAt: '2027-10-10',
      },
    ]);
    expect(await recallsOf(patientId)).toEqual([
      expect.objectContaining({
        recallTypeId: s.types.HYGIENE,
        kind: 'HYGIENE',
        intervalMonths: 6,
        lastDoneAt: DAY('2027-04-10'),
        dueAt: DAY('2027-10-10'),
        manualDoneAt: null,
        lastDoneItemId: itemId,
        source: 'PROCEDURE',
        locationId: s.sede,
        createdById: s.userId,
      }),
    ]);
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: s.tenantId,
        resourceType: 'PATIENT_RECALL',
        resourceId: recall.id,
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        action: 'UPDATE',
        patientId,
        actorUserId: s.userId,
        metadata: {
          reason: 'RECALL_FROM_PROCEDURE',
          params: { itemId, recallTypeId: s.types.HYGIENE },
        },
      }),
    ]);
  });

  it('un procedimiento que no dispara (resina) no crea ni toca recalls', async () => {
    const patientId = await patient('Resina');
    await raw.patientRecall.create({
      data: {
        tenantId: s.tenantId,
        patientId,
        recallTypeId: s.types.HYGIENE,
        kind: 'HYGIENE',
        intervalMonths: 6,
        lastDoneAt: DAY('2026-12-01'),
        manualDoneAt: DAY('2026-12-01'),
        locationId: s.sede,
        createdById: s.userId,
        updatedById: s.userId,
      },
    });
    const before = await recallsOf(patientId);
    const out = await done(await planItem(patientId, 'RESINA'));
    expect(out.recallUpdates).toEqual([]);
    expect(await recallsOf(patientId)).toEqual(before);
  });

  it('con lo fijado a mano: el DONE posterior mueve la base; sacarlo de DONE (CLEAR) vuelve a lo fijado', async () => {
    const patientId = await patient('Fijado');
    const manual = await raw.patientRecall.create({
      data: {
        tenantId: s.tenantId,
        patientId,
        recallTypeId: s.types.HYGIENE,
        kind: 'HYGIENE',
        intervalMonths: 6,
        lastDoneAt: DAY('2026-12-01'),
        manualDoneAt: DAY('2026-12-01'),
        locationId: s.sede,
        createdById: s.userId,
        updatedById: s.userId,
      },
    });
    const itemId = await planItem(patientId, 'PROFILAXIS');
    const out = await done(itemId);
    expect(out.recallUpdates).toEqual([
      expect.objectContaining({ recallId: manual.id, dueAt: '2027-10-10' }),
    ]);
    const cleared = await inSede(() =>
      updateAt(DONE_AT).execute(
        itemId,
        { status: 'ACCEPTED' },
        ADMIN(),
        audit(),
      ),
    );
    expect(cleared.recallUpdates).toEqual([
      expect.objectContaining({ recallId: manual.id, dueAt: '2027-06-01' }),
    ]);
    expect(await recallsOf(patientId)).toEqual([
      expect.objectContaining({
        id: manual.id,
        source: 'MANUAL',
        lastDoneAt: DAY('2026-12-01'),
        lastDoneItemId: null,
      }),
    ]);
  });

  it('sin nada fijado, sacarlo de DONE deja la base que tenía (D5: no se borra ni se pierde)', async () => {
    const patientId = await patient('SinBase');
    const itemId = await planItem(patientId, 'PROFILAXIS');
    await done(itemId);
    await inSede(() =>
      updateAt(DONE_AT).execute(
        itemId,
        { status: 'ACCEPTED' },
        ADMIN(),
        audit(),
      ),
    );
    expect(await recallsOf(patientId)).toEqual([
      expect.objectContaining({
        source: 'PROCEDURE',
        lastDoneAt: DAY('2027-04-10'),
        dueAt: DAY('2027-10-10'),
        // El ítem ya no está DONE: ya no «da la base».
        lastDoneItemId: null,
      }),
    ]);
  });

  const recallEvents = (recallId: string) =>
    raw.auditEvent.findMany({
      where: {
        tenantId: s.tenantId,
        resourceType: 'PATIENT_RECALL',
        resourceId: recallId,
      },
      orderBy: { occurredAt: 'asc' },
    });

  it('borrar un ítem DONE (Eliminar) recalcula su recall como un CLEAR, y lo audita', async () => {
    const patientId = await patient('Borrado');
    const manual = await raw.patientRecall.create({
      data: {
        tenantId: s.tenantId,
        patientId,
        recallTypeId: s.types.HYGIENE,
        kind: 'HYGIENE',
        intervalMonths: 6,
        lastDoneAt: DAY('2026-12-01'),
        manualDoneAt: DAY('2026-12-01'),
        locationId: s.sede,
        createdById: s.userId,
        updatedById: s.userId,
      },
    });
    const itemId = await planItem(patientId, 'PROFILAXIS');
    await done(itemId);
    expect(await recallsOf(patientId)).toEqual([
      expect.objectContaining({ lastDoneItemId: itemId }),
    ]);
    await inSede(() =>
      new RemoveTreatmentPlanItemUseCase(plans).execute(itemId, audit()),
    );
    expect(await recallsOf(patientId)).toEqual([
      expect.objectContaining({
        id: manual.id,
        lastDoneAt: DAY('2026-12-01'),
        dueAt: DAY('2027-06-01'),
        lastDoneItemId: null,
      }),
    ]);
    // Dos eventos: el DONE que movió la base y el borrado que la devolvió.
    expect((await recallEvents(manual.id)).map((e) => e.metadata)).toEqual([
      {
        reason: 'RECALL_FROM_PROCEDURE',
        params: { itemId, recallTypeId: s.types.HYGIENE },
      },
      {
        reason: 'RECALL_FROM_PROCEDURE',
        params: { itemId, recallTypeId: s.types.HYGIENE },
      },
    ]);
  });

  it('un cambio que no mueve el recall no deja evento (lo fijado es posterior al DONE)', async () => {
    const patientId = await patient('SinCambio');
    const manual = await raw.patientRecall.create({
      data: {
        tenantId: s.tenantId,
        patientId,
        recallTypeId: s.types.HYGIENE,
        kind: 'HYGIENE',
        intervalMonths: 6,
        lastDoneAt: DAY('2027-06-01'),
        manualDoneAt: DAY('2027-06-01'),
        locationId: s.sede,
        createdById: s.userId,
        updatedById: s.userId,
      },
    });
    const itemId = await planItem(patientId, 'PROFILAXIS');
    const out = await done(itemId);
    // La respuesta sigue diciendo cómo quedó, pero sin evento: nada cambió.
    expect(out.recallUpdates).toEqual([
      expect.objectContaining({ recallId: manual.id, dueAt: '2027-12-01' }),
    ]);
    expect(await recallEvents(manual.id)).toEqual([]);
  });

  it('corregir la fecha del DONE (CORRECT, ADMIN) recalcula el vencimiento', async () => {
    const patientId = await patient('Corregido');
    const itemId = await planItem(patientId, 'PROFILAXIS');
    await done(itemId);
    const corrected = await inSede(() =>
      updateAt(new Date('2027-05-01T15:00:00.000Z')).execute(
        itemId,
        { completedAt: new Date('2027-03-01T15:00:00.000Z') },
        ADMIN(),
        audit(),
      ),
    );
    expect(corrected.recallUpdates).toEqual([
      expect.objectContaining({
        recallTypeId: s.types.HYGIENE,
        dueAt: '2027-09-01',
      }),
    ]);
    expect(await recallsOf(patientId)).toEqual([
      expect.objectContaining({
        lastDoneAt: DAY('2027-03-01'),
        lastDoneItemId: itemId,
      }),
    ]);
  });

  it('el raspado crea el de Mantenimiento periodontal (3 meses, sin clave del enum)', async () => {
    const patientId = await patient('Perio');
    const out = await done(await planItem(patientId, 'RASPADO'));
    expect(out.recallUpdates).toEqual([
      expect.objectContaining({
        recallTypeName: 'Mantenimiento periodontal',
        dueAt: '2027-07-10',
      }),
    ]);
    expect(await recallsOf(patientId)).toEqual([
      expect.objectContaining({ kind: null, intervalMonths: 3 }),
    ]);
  });

  it('un tipo desactivado no se mueve ni se crea', async () => {
    const patientId = await patient('Inactivo');
    await raw.recallType.update({
      where: { id: s.types.PERIO },
      data: { active: false },
    });
    try {
      const out = await done(await planItem(patientId, 'RASPADO'));
      expect(out.recallUpdates).toEqual([]);
      expect(await recallsOf(patientId)).toEqual([]);
    } finally {
      await raw.recallType.update({
        where: { id: s.types.PERIO },
        data: { active: true },
      });
    }
  });

  it('dos DONE concurrentes del mismo paciente sin recall: una sola fila, con el máximo', async () => {
    const patientId = await patient('CarreraNueva');
    const first = await planItem(patientId, 'PROFILAXIS');
    const second = await planItem(patientId, 'PROFILAXIS');
    const results = await Promise.all([
      settle(done(first, DONE_AT)),
      settle(done(second, new Date('2027-05-20T15:00:00.000Z'))),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await recallsOf(patientId)).toEqual([
      expect.objectContaining({
        lastDoneAt: DAY('2027-05-20'),
        dueAt: DAY('2027-11-20'),
        lastDoneItemId: second,
      }),
    ]);
  });

  it('dos DONE concurrentes con el recall bloqueado: el que espera relee los ítems y queda el máximo', async () => {
    const patientId = await patient('CarreraBloqueada');
    const recall = await raw.patientRecall.create({
      data: {
        tenantId: s.tenantId,
        patientId,
        recallTypeId: s.types.HYGIENE,
        kind: 'HYGIENE',
        intervalMonths: 6,
        lastDoneAt: DAY('2026-12-01'),
        manualDoneAt: DAY('2026-12-01'),
        locationId: s.sede,
        createdById: s.userId,
        updatedById: s.userId,
      },
    });
    const later = await planItem(patientId, 'PROFILAXIS');
    const earlier = await planItem(patientId, 'PROFILAXIS');
    // Una transacción ajena retiene la fila del recall: los dos DONE escriben
    // su ítem y esperan en el FOR UPDATE de dx_recall_recompute.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding!: (pid: number) => void;
    const held = new Promise<number>((resolve) => (holding = resolve));
    const holder = prisma.runWithTenant(s.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "patient_recalls" WHERE "id" = ${recall.id}::uuid FOR UPDATE`;
      holding(await backendPid(tx));
      await released;
    });
    const pid = await held;
    const a = settle(done(later, new Date('2027-05-20T15:00:00.000Z')));
    const b = settle(done(earlier, DONE_AT));
    await waitForLockWaiters(raw, [pid], 2);
    release();
    await holder;
    expect((await Promise.all([a, b])).map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
    expect(await recallsOf(patientId)).toEqual([
      expect.objectContaining({
        id: recall.id,
        lastDoneAt: DAY('2027-05-20'),
        lastDoneItemId: later,
      }),
    ]);
  });

  describe('PUT sin fecha: al editar se conserva lo fijado; solo el alta nace con hoy', () => {
    it('recall de un procedimiento (sin nada fijado): cambiar el intervalo no fija hoy ni suelta el ítem; sacarlo de DONE sigue D5', async () => {
      const patientId = await patient('EditaProcedimiento');
      const itemId = await planItem(patientId, 'PROFILAXIS');
      await done(itemId);
      const out = await putRecall(patientId, s.types.HYGIENE, {
        intervalMonths: 3,
      });
      expect(out.recalls).toEqual([
        expect.objectContaining({
          intervalMonths: 3,
          lastDoneAt: '2027-04-10',
          dueAt: '2027-07-10',
        }),
      ]);
      expect(await recallsOf(patientId)).toEqual([
        expect.objectContaining({
          source: 'PROCEDURE',
          intervalMonths: 3,
          manualDoneAt: null,
          preBackfillDoneAt: null,
          lastDoneAt: DAY('2027-04-10'),
          dueAt: DAY('2027-07-10'),
          lastDoneItemId: itemId,
        }),
      ]);
      // Sin nada fijado, sacarlo de DONE deja la base (D5), no la de hoy.
      await inSede(() =>
        updateAt(DONE_AT).execute(
          itemId,
          { status: 'ACCEPTED' },
          ADMIN(),
          audit(),
        ),
      );
      expect(await recallsOf(patientId)).toEqual([
        expect.objectContaining({
          manualDoneAt: null,
          lastDoneAt: DAY('2027-04-10'),
          dueAt: DAY('2027-07-10'),
          lastDoneItemId: null,
        }),
      ]);
    });

    it('fijado a mano en enero y procedimiento en junio: editar sin fecha deja lo fijado en enero y la base en junio', async () => {
      const patientId = await patient('EditaManual');
      await putRecall(patientId, s.types.HYGIENE, {
        intervalMonths: 6,
        lastDoneAt: '2027-01-15',
      });
      const itemId = await planItem(patientId, 'PROFILAXIS');
      await done(itemId, new Date('2027-06-10T15:00:00.000Z'));
      await putRecall(patientId, s.types.HYGIENE, { intervalMonths: 12 });
      expect(await recallsOf(patientId)).toEqual([
        expect.objectContaining({
          source: 'MANUAL',
          intervalMonths: 12,
          manualDoneAt: DAY('2027-01-15'),
          lastDoneAt: DAY('2027-06-10'),
          dueAt: DAY('2028-06-10'),
          lastDoneItemId: itemId,
        }),
      ]);
      // Sacarlo de DONE vuelve a lo fijado en enero (no a hoy).
      await inSede(() =>
        updateAt(DONE_AT).execute(
          itemId,
          { status: 'ACCEPTED' },
          ADMIN(),
          audit(),
        ),
      );
      expect(await recallsOf(patientId)).toEqual([
        expect.objectContaining({
          manualDoneAt: DAY('2027-01-15'),
          lastDoneAt: DAY('2027-01-15'),
          lastDoneItemId: null,
        }),
      ]);
    });

    it('recall rellenado (preBackfillDoneAt): editar sin fecha conserva preBackfillDoneAt y manualDoneAt; con fecha, se fija y se suelta', async () => {
      const patientId = await patient('EditaRellenado');
      await raw.patientRecall.create({
        data: {
          tenantId: s.tenantId,
          patientId,
          recallTypeId: s.types.CHECKUP,
          kind: 'CHECKUP',
          intervalMonths: 12,
          lastDoneAt: DAY('2026-09-01'),
          manualDoneAt: DAY('2026-09-01'),
          preBackfillDoneAt: DAY('2026-05-01'),
          source: 'BACKFILL',
          locationId: s.sede,
          createdById: s.userId,
          updatedById: s.userId,
        },
      });
      await putRecall(patientId, s.types.CHECKUP, {
        intervalMonths: 6,
        active: false,
      });
      expect(await recallsOf(patientId)).toEqual([
        expect.objectContaining({
          source: 'BACKFILL',
          intervalMonths: 6,
          active: false,
          manualDoneAt: DAY('2026-09-01'),
          preBackfillDoneAt: DAY('2026-05-01'),
          lastDoneAt: DAY('2026-09-01'),
          dueAt: DAY('2027-03-01'),
        }),
      ]);
      // Con fecha sí es lo fijado por el clínico: ya no la base congelada.
      await putRecall(patientId, s.types.CHECKUP, {
        intervalMonths: 6,
        lastDoneAt: '2027-02-01',
      });
      expect(await recallsOf(patientId)).toEqual([
        expect.objectContaining({
          source: 'BACKFILL',
          manualDoneAt: DAY('2027-02-01'),
          preBackfillDoneAt: null,
          lastDoneAt: DAY('2027-02-01'),
        }),
      ]);
    });

    it('recall nuevo sin fecha: nace con hoy en la sede (sin cambios)', async () => {
      const patientId = await patient('AltaSinFecha');
      const out = await putRecall(patientId, s.types.CHECKUP, {
        intervalMonths: 6,
      });
      expect(out.recalls).toEqual([
        expect.objectContaining({
          lastDoneAt: '2027-11-07',
          dueAt: '2028-05-07',
        }),
      ]);
      expect(await recallsOf(patientId)).toEqual([
        expect.objectContaining({
          source: 'MANUAL',
          manualDoneAt: DAY('2027-11-07'),
          lastDoneAt: DAY('2027-11-07'),
          preBackfillDoneAt: null,
          lastDoneItemId: null,
        }),
      ]);
    });
  });
});
