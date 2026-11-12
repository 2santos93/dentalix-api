import { randomUUID } from 'node:crypto';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { UpdateTreatmentPlanItemUseCase } from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan-item.use-case';
import { testDiscountPolicy } from '../src/modules/treatment-plans/application/use-cases/__fixtures__/discount-fixtures';
import type { DentalCatalogRepository } from '../src/modules/dental-catalog/domain/ports/dental-catalog-repository.port';
import type { DentalCatalogItem } from '../src/modules/dental-catalog/domain/entities/dental-catalog-item.entity';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { PrismaRecallRepository } from '../src/modules/recall/infrastructure/prisma-recall.repository';
import {
  GetPatientRecallsUseCase,
  SetPatientRecallUseCase,
  type SetPatientRecallInput,
} from '../src/modules/recall/application/use-cases/recall.use-cases';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';
import {
  type DefaultRecallTypes,
  seedDefaultRecallTypes,
} from './support/recall-types';
import {
  pauseAfterSql,
  reachedWithin,
  settle,
  sqlStop,
  waitForLockWaiters,
} from './support/postgres-concurrency';

// DX-015-bis (porción 2, D9/D10) · Exclusión entre tipos de recall con los
// casos de uso y repositorios REALES sobre Postgres como dentalix_app (RLS
// FORCE): Higiene y Mantenimiento periodontal comparten HYGIENE_PERIO, así
// que un paciente no tiene los dos activos. «El último procedimiento manda»:
// un DONE de mantenimiento periodontal desactiva la higiene (y lo devuelve en
// `recallUpdates`), una profilaxis posterior lo invierte; dos DONE
// concurrentes no dejan los dos activos; el PUT (alta o reactivación) también
// excluye; y el relleno único (`dx_recall_exclusion_backfill`). `raw`
// (DIRECT_URL, owner) siembra, comprueba y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const plans = new PrismaTreatmentPlanRepository(prisma, tenantContext);
const recallRepo = new PrismaRecallRepository(prisma, tenantContext);

const SUBDOMAIN = 'dx015bis-exclusion';
const EMAIL = `odontologa@${SUBDOMAIN}.test`;
/** 10:00 del 10/04/2027 en Caracas (UTC−4). */
const APRIL = new Date('2027-04-10T14:00:00.000Z');
/** 10:00 del 20/05/2027 en Caracas. */
const MAY = new Date('2027-05-20T14:00:00.000Z');
/** «Hoy» del PUT: 07/11/2027 en Caracas. */
const PUT_NOW = new Date('2027-11-07T15:00:00.000Z');
const DAY = (d: string) => new Date(`${d}T00:00:00.000Z`);

type Code = 'PROFILAXIS' | 'MANTENIMIENTO' | 'COMBO';
interface Seeded {
  tenantId: string;
  userId: string;
  sede: string;
  types: DefaultRecallTypes;
  catalog: Record<Code, DentalCatalogItem>;
}
let s: Seeded;

const catalogRepo = {
  findById: (id: string) =>
    Promise.resolve(Object.values(s.catalog).find((c) => c.id === id) ?? null),
  findByIds: (ids: string[]) =>
    Promise.resolve(Object.values(s.catalog).filter((c) => ids.includes(c.id))),
} as unknown as DentalCatalogRepository;

const ADMIN = () => ({ userId: s.userId, role: ClinicRole.ADMIN });
const audit = (): AuditRequestContext => ({
  tenantId: s.tenantId,
  locationId: s.sede,
  actor: { userId: s.userId, role: ClinicRole.ADMIN },
  requestId: 'dx015bis-exclusion-int',
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
    data: { email: EMAIL, passwordHash: 'x', fullName: 'Dra. Briceño' },
  });
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: ClinicRole.ADMIN },
  });
  const sede = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Los Palos Grandes',
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
    MANTENIMIENTO: await item(
      'PERIO-MANTENIMIENTO',
      'Mantenimiento periodontal',
    ),
    // Fuera del catálogo semilla: dispara a la vez Higiene y Perio (abajo).
    COMBO: await item('DX015BIS-COMBO', 'Profilaxis con raspado'),
  };
  const types = await seedDefaultRecallTypes(raw, tenant.id);
  await raw.recallTypeTrigger.createMany({
    data: [types.HYGIENE, types.PERIO].map((recallTypeId) => ({
      tenantId: tenant.id,
      recallTypeId,
      catalogItemId: catalog.COMBO.id,
    })),
  });
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
      data: { tenantId: s.tenantId, firstName: name, lastName: 'Exclusión' },
    })
  ).id;
}

/** Un plan en borrador con un ítem ACEPTADO de ese procedimiento. */
async function planItem(patientId: string, code: Code): Promise<string> {
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

const done = (itemId: string, at: Date) =>
  inSede(() =>
    new UpdateTreatmentPlanItemUseCase(
      plans,
      catalogRepo,
      testDiscountPolicy(),
      () => at,
    ).execute(itemId, { status: 'DONE' }, ADMIN(), audit()),
  );

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
    ).execute(patientId, { id: recallTypeId }, input, s.userId, audit()),
  );

/** Estado de cada recall del paciente por tipo. */
async function stateOf(
  patientId: string,
): Promise<Record<string, { active: boolean; excluded: boolean }>> {
  const rows = await raw.patientRecall.findMany({
    where: { patientId },
    select: { recallTypeId: true, active: true, excludedAt: true },
  });
  const name = (id: string) =>
    id === s.types.HYGIENE ? 'HYGIENE' : id === s.types.PERIO ? 'PERIO' : id;
  return Object.fromEntries(
    rows.map((r) => [
      name(r.recallTypeId),
      { active: r.active, excluded: r.excludedAt !== null },
    ]),
  );
}

const exclusionEvents = (patientId: string) =>
  raw.auditEvent.findMany({
    where: {
      tenantId: s.tenantId,
      patientId,
      resourceType: 'PATIENT_RECALL',
      metadata: { path: ['reason'], equals: 'EXCLUSION' },
    },
    orderBy: { occurredAt: 'asc' },
  });

describe('DX-015-bis · exclusión entre tipos de recall (int)', () => {
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

  it('Higiene y Mantenimiento periodontal comparten grupo (siembra)', async () => {
    const types = await raw.recallType.findMany({
      where: { id: { in: [s.types.HYGIENE, s.types.PERIO] } },
      select: { exclusionGroup: true },
    });
    expect(types.map((t) => t.exclusionGroup)).toEqual([
      'HYGIENE_PERIO',
      'HYGIENE_PERIO',
    ]);
  });

  it('DONE de PERIO-MANTENIMIENTO con una Higiene activa: la Higiene queda inactiva, sale en recallUpdates y se audita; una profilaxis después lo invierte', async () => {
    const patientId = await patient('Invierte');
    const profilaxis = await planItem(patientId, 'PROFILAXIS');
    await done(profilaxis, APRIL);
    expect(await stateOf(patientId)).toEqual({
      HYGIENE: { active: true, excluded: false },
    });

    const mantenimiento = await planItem(patientId, 'MANTENIMIENTO');
    const out = await done(mantenimiento, MAY);
    const hygiene = await raw.patientRecall.findFirstOrThrow({
      where: { patientId, recallTypeId: s.types.HYGIENE },
    });
    const perio = await raw.patientRecall.findFirstOrThrow({
      where: { patientId, recallTypeId: s.types.PERIO },
    });
    expect(out.recallUpdates).toEqual([
      {
        recallId: perio.id,
        recallTypeId: s.types.PERIO,
        recallTypeName: 'Mantenimiento periodontal',
        dueAt: '2027-08-20',
        deactivated: false,
        replacedBy: null,
      },
      {
        recallId: hygiene.id,
        recallTypeId: s.types.HYGIENE,
        recallTypeName: 'Higiene',
        dueAt: '2027-10-10',
        deactivated: true,
        replacedBy: {
          recallTypeId: s.types.PERIO,
          recallTypeName: 'Mantenimiento periodontal',
        },
      },
    ]);
    expect(await stateOf(patientId)).toEqual({
      HYGIENE: { active: false, excluded: true },
      PERIO: { active: true, excluded: false },
    });
    // La fila se conserva (su base no cambia) y la desactivación se audita.
    expect(hygiene).toMatchObject({ lastDoneAt: DAY('2027-04-10') });
    expect(await exclusionEvents(patientId)).toEqual([
      expect.objectContaining({
        action: 'UPDATE',
        resourceId: hygiene.id,
        actorUserId: s.userId,
        metadata: {
          reason: 'EXCLUSION',
          params: {
            recallTypeId: s.types.HYGIENE,
            replacedByRecallId: perio.id,
            replacedByRecallTypeId: s.types.PERIO,
          },
        },
      }),
    ]);

    // Una profilaxis posterior devuelve el turno a la higiene.
    const second = await done(
      await planItem(patientId, 'PROFILAXIS'),
      new Date('2027-08-25T14:00:00.000Z'),
    );
    expect(second.recallUpdates).toEqual([
      expect.objectContaining({
        recallId: hygiene.id,
        dueAt: '2028-02-25',
        deactivated: false,
      }),
      expect.objectContaining({
        recallId: perio.id,
        deactivated: true,
        replacedBy: {
          recallTypeId: s.types.HYGIENE,
          recallTypeName: 'Higiene',
        },
      }),
    ]);
    expect(await stateOf(patientId)).toEqual({
      HYGIENE: { active: true, excluded: false },
      PERIO: { active: false, excluded: true },
    });
    expect((await exclusionEvents(patientId)).map((e) => e.resourceId)).toEqual(
      [hygiene.id, perio.id],
    );
  });

  it('un recall retirado a mano (sin excludedAt) no lo reactiva un DONE ni cuenta para la exclusión', async () => {
    const patientId = await patient('RetiradoAMano');
    await done(await planItem(patientId, 'MANTENIMIENTO'), APRIL);
    await putRecall(patientId, s.types.PERIO, {
      intervalMonths: 3,
      active: false,
    });
    const out = await done(await planItem(patientId, 'MANTENIMIENTO'), MAY);
    expect(out.recallUpdates).toEqual([
      expect.objectContaining({
        recallTypeId: s.types.PERIO,
        deactivated: false,
      }),
    ]);
    expect(await stateOf(patientId)).toEqual({
      PERIO: { active: false, excluded: false },
    });
  });

  it('sacar de DONE (CLEAR) no aplica la exclusión', async () => {
    const patientId = await patient('Clear');
    await done(await planItem(patientId, 'PROFILAXIS'), APRIL);
    const mantenimiento = await planItem(patientId, 'MANTENIMIENTO');
    await done(mantenimiento, MAY);
    // Reactiva la higiene a mano: el perio queda inactivo.
    await putRecall(patientId, s.types.HYGIENE, { intervalMonths: 6 });
    expect(await stateOf(patientId)).toEqual({
      HYGIENE: { active: true, excluded: false },
      PERIO: { active: false, excluded: true },
    });
    const cleared = await inSede(() =>
      new UpdateTreatmentPlanItemUseCase(
        plans,
        catalogRepo,
        testDiscountPolicy(),
        () => MAY,
      ).execute(mantenimiento, { status: 'ACCEPTED' }, ADMIN(), audit()),
    );
    expect(cleared.recallUpdates.every((u) => !u.deactivated)).toBe(true);
    expect(await stateOf(patientId)).toEqual({
      HYGIENE: { active: true, excluded: false },
      PERIO: { active: false, excluded: true },
    });
  });

  it('dos DONE concurrentes (perio y profilaxis) de un paciente sin recalls no dejan los dos activos', async () => {
    // Varios pacientes a la vez, cada DONE en su plan. Sin el advisory lock
    // este caso también pasaba (otro bloqueo del camino del DONE serializa al
    // paciente): el de abajo (PUT contra un DONE a medias) es el que lo prueba.
    const patients = await Promise.all(
      ['A', 'B', 'C', 'D'].map((n) => patient(`Carrera${n}`)),
    );
    const items = await Promise.all(
      patients.map(async (p) => [
        await planItem(p, 'PROFILAXIS'),
        await planItem(p, 'MANTENIMIENTO'),
      ]),
    );
    const results = await Promise.all(
      items.flatMap(([profilaxis, mantenimiento]) => [
        settle(done(profilaxis, APRIL)),
        settle(done(mantenimiento, APRIL)),
      ]),
    );
    expect(results.map((r) => r.status)).toEqual(
      results.map(() => 'fulfilled'),
    );
    for (const p of patients) {
      const state = await stateOf(p);
      expect(Object.keys(state).sort()).toEqual(['HYGIENE', 'PERIO']);
      expect(Object.values(state).filter((r) => r.active)).toHaveLength(1);
      // El otro, desactivado por la exclusión (reactivable por un DONE).
      expect(Object.values(state).filter((r) => r.excluded)).toHaveLength(1);
    }
  });

  it('un DONE de profilaxis a medias y el alta del perio por PUT: el PUT espera el bloqueo del paciente, ve la higiene y la desactiva', async () => {
    // Sin el advisory lock el PUT no esperaría: la higiene recién insertada
    // (sin confirmar) no se ve y quedarían las dos activas.
    const patientId = await patient('CarreraPut');
    const profilaxis = await planItem(patientId, 'PROFILAXIS');
    const stop = sqlStop(/INSERT INTO "patient_recalls"/);
    const undo = pauseAfterSql(prisma, [stop]);
    try {
      const doing = settle(done(profilaxis, APRIL));
      const pid = await reachedWithin(stop, doing, 'DONE de profilaxis');
      const putting = settle(
        putRecall(patientId, s.types.PERIO, { intervalMonths: 3 }),
      );
      await waitForLockWaiters(raw, [pid], 1);
      stop.release.open();
      const [d, p] = await Promise.all([doing, putting]);
      expect([d.status, p.status]).toEqual(['fulfilled', 'fulfilled']);
      expect(p.status === 'fulfilled' && p.value.recallUpdates).toEqual([
        expect.objectContaining({
          recallTypeId: s.types.HYGIENE,
          deactivated: true,
        }),
      ]);
    } finally {
      undo();
    }
    expect(await stateOf(patientId)).toEqual({
      HYGIENE: { active: false, excluded: true },
      PERIO: { active: true, excluded: false },
    });
  });

  it('un CLEAR de un procedimiento que dispara dos tipos y un PUT a la vez no se bloquean en cruz (orden de id)', async () => {
    // El recall de Higiene (sortOrder 10, el primero que recalcula el CLEAR)
    // con el id MAYOR; el de Perio con el menor. Sin bloquear antes todos
    // los recalls del paciente en orden de id, el CLEAR tendría la higiene y
    // pediría el perio, y el PUT (que bloquea en orden de id) tendría el perio
    // y pediría la higiene: 40P01.
    const patientId = await patient('CruceOrden');
    const [low, high] = [randomUUID(), randomUUID()].sort();
    for (const [id, recallTypeId, kind, months] of [
      [high, s.types.HYGIENE, 'HYGIENE', 6],
      [low, s.types.PERIO, null, 3],
    ] as const) {
      await raw.patientRecall.create({
        data: {
          id,
          tenantId: s.tenantId,
          patientId,
          recallTypeId,
          kind,
          intervalMonths: months,
          lastDoneAt: DAY('2027-01-10'),
          manualDoneAt: DAY('2027-01-10'),
          locationId: s.sede,
          createdById: s.userId,
          updatedById: s.userId,
        },
      });
    }
    const combo = await planItem(patientId, 'COMBO');
    await done(combo, APRIL);

    const stop = sqlStop(/dx_recall_recompute/);
    const undo = pauseAfterSql(prisma, [stop]);
    try {
      const clearing = settle(
        inSede(() =>
          new UpdateTreatmentPlanItemUseCase(
            plans,
            catalogRepo,
            testDiscountPolicy(),
            () => MAY,
          ).execute(combo, { status: 'ACCEPTED' }, ADMIN(), audit()),
        ),
      );
      const pid = await reachedWithin(stop, clearing, 'CLEAR del combo');
      const putting = settle(
        putRecall(patientId, s.types.PERIO, { intervalMonths: 4 }),
      );
      await waitForLockWaiters(raw, [pid], 1);
      stop.release.open();
      const [c, p] = await Promise.all([clearing, putting]);
      expect(
        [c, p].map((r) =>
          r.status === 'rejected' ? String(r.reason) : r.status,
        ),
      ).toEqual(['fulfilled', 'fulfilled']);
    } finally {
      undo();
    }
    expect(await stateOf(patientId)).toEqual({
      HYGIENE: { active: false, excluded: true },
      PERIO: { active: true, excluded: false },
    });
  });

  describe('PUT del recall', () => {
    it('el alta de un tipo con grupo desactiva el otro y lo devuelve; editar el activo no toca nada', async () => {
      const patientId = await patient('PutAlta');
      await done(await planItem(patientId, 'PROFILAXIS'), APRIL);
      const hygiene = await raw.patientRecall.findFirstOrThrow({
        where: { patientId, recallTypeId: s.types.HYGIENE },
      });
      const out = await putRecall(patientId, s.types.PERIO, {
        intervalMonths: 3,
        lastDoneAt: '2027-05-01',
      });
      expect(out.recallUpdates).toEqual([
        {
          recallId: hygiene.id,
          recallTypeId: s.types.HYGIENE,
          recallTypeName: 'Higiene',
          dueAt: '2027-10-10',
          deactivated: true,
          replacedBy: {
            recallTypeId: s.types.PERIO,
            recallTypeName: 'Mantenimiento periodontal',
          },
        },
      ]);
      expect(out.recalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            recallTypeId: s.types.HYGIENE,
            active: false,
            status: 'INACTIVE',
          }),
        ]),
      );
      expect(await exclusionEvents(patientId)).toHaveLength(1);

      // Cambiar el intervalo del que ya está activo no desactiva nada.
      const edit = await putRecall(patientId, s.types.PERIO, {
        intervalMonths: 4,
      });
      expect(edit.recallUpdates).toEqual([]);

      // Reactivar la higiene a mano desactiva el perio.
      const back = await putRecall(patientId, s.types.HYGIENE, {
        intervalMonths: 6,
      });
      expect(back.recallUpdates).toEqual([
        expect.objectContaining({
          recallTypeId: s.types.PERIO,
          replacedBy: {
            recallTypeId: s.types.HYGIENE,
            recallTypeName: 'Higiene',
          },
        }),
      ]);
      expect(await stateOf(patientId)).toEqual({
        HYGIENE: { active: true, excluded: false },
        PERIO: { active: false, excluded: true },
      });
    });

    it('un tipo sin grupo (Control) no excluye a nadie', async () => {
      const patientId = await patient('PutControl');
      await done(await planItem(patientId, 'PROFILAXIS'), APRIL);
      const out = await putRecall(patientId, s.types.CHECKUP, {
        intervalMonths: 12,
      });
      expect(out.recallUpdates).toEqual([]);
      expect(await stateOf(patientId)).toMatchObject({
        HYGIENE: { active: true, excluded: false },
      });
    });
  });

  describe('relleno único (dx_recall_exclusion_backfill)', () => {
    const backfill = () =>
      raw.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${s.tenantId}, true)`;
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT public.dx_recall_exclusion_backfill(${s.tenantId}::uuid) AS n`;
        return n;
      });

    /** Dos recalls activos del mismo grupo, como los dejó la porción 1. */
    async function both(
      name: string,
      hygieneDay: string,
      perioDay: string,
    ): Promise<string> {
      const patientId = await patient(name);
      for (const [recallTypeId, kind, months, day] of [
        [s.types.HYGIENE, 'HYGIENE', 6, hygieneDay],
        [s.types.PERIO, null, 3, perioDay],
      ] as const) {
        await raw.patientRecall.create({
          data: {
            tenantId: s.tenantId,
            patientId,
            recallTypeId,
            kind,
            intervalMonths: months,
            lastDoneAt: DAY(day),
            manualDoneAt: DAY(day),
            source: 'BACKFILL',
            locationId: s.sede,
            createdById: s.userId,
            updatedById: s.userId,
          },
        });
      }
      return patientId;
    }

    it('deja activo el de base más reciente; con la misma, el de intervalo menor (perio); no borra nada y repetirlo no cambia nada', async () => {
      const recent = await both('RellenoReciente', '2027-03-01', '2026-12-01');
      const tie = await both('RellenoEmpate', '2027-02-01', '2027-02-01');
      const single = await patient('RellenoSolo');
      await done(await planItem(single, 'PROFILAXIS'), APRIL);
      const before = await raw.patientRecall.count({
        where: { tenantId: s.tenantId },
      });

      expect(await backfill()).toBeGreaterThanOrEqual(2);
      expect(await stateOf(recent)).toEqual({
        HYGIENE: { active: true, excluded: false },
        PERIO: { active: false, excluded: true },
      });
      expect(await stateOf(tie)).toEqual({
        HYGIENE: { active: false, excluded: true },
        PERIO: { active: true, excluded: false },
      });
      expect(await stateOf(single)).toEqual({
        HYGIENE: { active: true, excluded: false },
      });
      expect(
        await raw.patientRecall.count({ where: { tenantId: s.tenantId } }),
      ).toBe(before);
      expect(await backfill()).toBe(0);

      // Ningún paciente de la clínica queda con dos activos del grupo.
      const doubles = await raw.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM (
          SELECT pr."patientId"
            FROM "patient_recalls" pr
            JOIN "recall_types" rt ON rt."id" = pr."recallTypeId"
           WHERE pr."tenantId" = ${s.tenantId}::uuid AND pr."active"
             AND rt."exclusionGroup" IS NOT NULL
           GROUP BY pr."patientId", rt."exclusionGroup"
          HAVING count(*) > 1) x`;
      expect(doubles[0].n).toBe(0);

      // El que dejó inactivo lo reactiva un DONE posterior de su disparador.
      await done(await planItem(recent, 'MANTENIMIENTO'), MAY);
      expect(await stateOf(recent)).toEqual({
        HYGIENE: { active: false, excluded: true },
        PERIO: { active: true, excluded: false },
      });
    });
  });
});
