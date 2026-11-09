import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaDocumentTypeNamesRepository } from '../src/modules/patients/infrastructure/repositories/prisma-document-type-names.repository';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPlanQuoteRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-plan-quote.repository';
import {
  AcceptTreatmentPlanUseCase,
  PreviewPartialAcceptanceUseCase,
} from '../src/modules/treatment-plans/application/use-cases/plan-quote.use-cases';
import type { AcceptanceRepricer } from '../src/modules/treatment-plans/application/use-cases/plan-repricing.use-cases';
import {
  computeQuoteHash,
  parseQuoteContent,
} from '../src/modules/treatment-plans/domain/plan-quote';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import {
  backendPid,
  settle,
  waitForLockWaiters,
} from './support/postgres-concurrency';

// DX-417 sobre Postgres: la aceptación parcial mueve los ítems pendientes a
// un plan nuevo sin disparar los triggers de foto congelada ni de
// imputaciones, firma el subconjunto, deja el pendiente fuera del grupo de
// opciones y aceptable después; el trigger de un plan firmado ya no deja
// SACAR un ítem; el enlace es de escritura única; dos firmas a la vez dejan
// una sola aceptación y un solo pendiente; con abonos, cuotas o saldo a favor
// no se escribe nada; la reserva de cita del ítem movido sigue. Todo por el
// repositorio real (rol dentalix_app, RLS); `raw` (owner) siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const documentTypeNames = new PrismaDocumentTypeNamesRepository(
  prisma,
  tenantContext,
);
const quotes = new PrismaPlanQuoteRepository(prisma, tenantContext);

// 9/11/2026 11:00 en Caracas: reloj fijo (DX-460).
const NOW = new Date('2026-11-09T15:00:00.000Z');
const now = () => NOW;
const DAY = (d: string) => new Date(`${d}T00:00:00.000Z`);
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const RESTRICT =
  /restrict_violation|23001|P2004|no pasan a otro plan|no cambia/;

const preview = new PreviewPartialAcceptanceUseCase(
  quotes,
  now,
  documentTypeNames,
  {} as AcceptanceRepricer,
);
const accept = new AcceptTreatmentPlanUseCase(quotes, now, documentTypeNames);

interface Clinic {
  tenantId: string;
  userId: string;
  locationId: string;
  catalogItemId: string;
}

const clinics: Clinic[] = [];
let a: Clinic;

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const user = await raw.user.create({
    data: {
      email: `${subdomain}@example.com`,
      passwordHash: 'x',
      fullName: `Dra ${subdomain}`,
    },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede principal',
    }),
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: `c-${subdomain}`,
      kind: 'PROCEDURE',
      labelEs: 'Resina',
      color: '#123456',
    },
  });
  const clinic = {
    tenantId: tenant.id,
    userId: user.id,
    locationId: location.id,
    catalogItemId: catalog.id,
  };
  clinics.push(clinic);
  return clinic;
}

async function patient(c: Clinic, firstName: string): Promise<string> {
  const row = await raw.patient.create({
    data: { tenantId: c.tenantId, firstName, lastName: 'Prueba' },
  });
  return row.id;
}

/**
 * Plan PRESENTED en VES con `prices.length` ítems propuestos, con la foto del
 * precio (catálogo en USD, convertido) y la validez guardada.
 */
async function presentedPlan(
  c: Clinic,
  patientId: string,
  prices: number[],
  data: Partial<Prisma.TreatmentPlanUncheckedCreateInput> = {},
): Promise<{ planId: string; itemIds: string[] }> {
  const row = await raw.treatmentPlan.create({
    data: {
      tenantId: c.tenantId,
      patientId,
      currency: 'VES',
      status: 'PRESENTED',
      presentedAt: new Date('2026-11-02T14:00:00.000Z'),
      presentedLocationId: c.locationId,
      quoteIssuedOn: DAY('2026-11-02'),
      quoteValidUntil: DAY('2026-12-02'),
      createdById: c.userId,
      notes: 'Plan de prueba',
      visitIntervals: { '2': 15 },
      ...data,
    },
  });
  const itemIds: string[] = [];
  for (const [i, price] of prices.entries()) {
    const item = await raw.treatmentPlanItem.create({
      data: {
        tenantId: c.tenantId,
        planId: row.id,
        toothNumber: String(11 + i),
        catalogItemId: c.catalogItemId,
        price,
        discount: i === 0 ? 10.5 : 0,
        catalogCurrency: 'USD',
        catalogPrice: price,
        basePrice: price,
        visit: i + 1,
        createdAt: new Date(Date.UTC(2026, 10, 2, 14, i)),
      },
    });
    itemIds.push(item.id);
  }
  return { planId: row.id, itemIds };
}

function inClinic<T>(c: Clinic, fn: () => Promise<T>) {
  return tenantContext.run(c.tenantId, c.locationId, fn);
}

const META = (c: Clinic) => ({
  acceptedById: c.userId,
  role: ClinicRole.DENTIST,
  ipAddress: null,
  userAgent: null,
});

/** Vista previa y firma de los ítems `itemIds` (los que se aceptan). */
async function acceptPartially(
  c: Clinic,
  patientId: string,
  planId: string,
  itemIds: string[],
) {
  return inClinic(c, async () => {
    const shown = await preview.execute(
      patientId,
      planId,
      { itemIds },
      { userId: c.userId, role: ClinicRole.DENTIST },
    );
    const doc = await accept.execute(
      patientId,
      planId,
      {
        signerName: 'Ana Prueba',
        signature: PNG,
        contentHash: shown.accepted.contentHash,
        partial: { itemIds },
      },
      META(c),
    );
    return { shown, doc };
  });
}

describe('aceptación parcial del presupuesto (DX-417, int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    a = await seedClinic('dx417-int-a');
  });

  afterAll(async () => {
    const where = { tenantId: { in: clinics.map((c) => c.tenantId) } };
    // Sin `app.current_tenant` (owner): los triggers dejan borrar.
    await raw.treatmentPlanAcceptance.deleteMany({ where });
    await raw.appointmentPlanItem.deleteMany({ where });
    await raw.appointment.deleteMany({ where });
    await raw.payment.deleteMany({ where });
    await raw.paymentPlan.deleteMany({ where });
    await raw.planAllocationRebalanceRequest.deleteMany({ where });
    await raw.treatmentPlanItem.deleteMany({ where });
    await raw.treatmentPlan.deleteMany({ where });
    await raw.dentalCatalogItem.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({
      where: { id: { in: clinics.map((c) => c.tenantId) } },
    });
    await raw.user.deleteMany({
      where: { id: { in: clinics.map((c) => c.userId) } },
    });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  it('mueve los pendientes (mismo id) a un plan PRESENTED enlazado y firma solo lo aceptado', async () => {
    const p = await patient(a, 'Feliz');
    const { planId, itemIds } = await presentedPlan(a, p, [450, 120, 80.25]);
    const before = await raw.treatmentPlanItem.findMany({
      where: { id: { in: itemIds } },
      orderBy: { createdAt: 'asc' },
    });

    const { shown, doc } = await acceptPartially(a, p, planId, [
      itemIds[0],
      itemIds[2],
    ]);

    expect(shown.pending.totals[0]).toMatchObject({
      currency: 'VES',
      net: 120,
    });
    expect(shown.original.totals[0].net).toBe(439.5 + 120 + 80.25);
    expect(doc.contentHash).toBe(shown.accepted.contentHash);
    expect(doc.items.map((i) => i.id)).toEqual([itemIds[0], itemIds[2]]);

    const original = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: planId },
      include: { items: true, acceptance: true },
    });
    expect(original.status).toBe('ACCEPTED');
    expect(original.items.map((i) => [i.id, i.status]).sort()).toEqual(
      [
        [itemIds[0], 'ACCEPTED'],
        [itemIds[2], 'ACCEPTED'],
      ].sort(),
    );
    const acceptance = original.acceptance!;
    expect(acceptance.pendingItemIds).toEqual([itemIds[1]]);
    expect(acceptance.pendingTotal!.toNumber()).toBe(120);
    // La foto firmada es la del subconjunto y sigue íntegra.
    const content = parseQuoteContent(acceptance.content);
    expect(content.items.map((i) => i.id)).toEqual([itemIds[0], itemIds[2]]);
    expect(computeQuoteHash(content)).toBe(acceptance.contentHash);

    const pending = await raw.treatmentPlan.findUniqueOrThrow({
      where: { id: acceptance.pendingPlanId! },
      include: { items: true },
    });
    expect(pending).toMatchObject({
      status: 'PRESENTED',
      splitFromPlanId: planId,
      optionGroupId: null,
      optionLabel: null,
      currency: 'VES',
      createdById: a.userId,
      notes: 'Plan de prueba',
      presentedAt: original.presentedAt,
      presentedLocationId: a.locationId,
      quoteIssuedOn: DAY('2026-11-02'),
      quoteValidUntil: DAY('2026-12-02'),
      visitIntervals: { '2': 15 },
    });
    // Movido, no copiado: mismo id, sigue propuesto y con su foto intacta.
    expect(pending.items).toHaveLength(1);
    const moved = pending.items[0];
    const was = before[1];
    expect(moved).toMatchObject({
      id: was.id,
      status: 'PROPOSED',
      price: was.price,
      catalogCurrency: 'USD',
      catalogPrice: was.catalogPrice,
      basePrice: was.basePrice,
      visit: 2,
      createdAt: was.createdAt,
    });
  });

  it('el trigger de un plan firmado ya no deja SACAR un ítem hacia otro plan (tampoco al pendiente)', async () => {
    const p = await patient(a, 'Sacar');
    const { planId, itemIds } = await presentedPlan(a, p, [100, 50]);
    const { doc } = await acceptPartially(a, p, planId, [itemIds[0]]);
    const pendingPlanId = doc.acceptance!.pendingPlanId!;
    // Destino sin firmar: antes de DX-417 esto pasaba.
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.treatmentPlanItem.update({
          where: { id: itemIds[0] },
          data: { planId: pendingPlanId },
        }),
      ),
    ).rejects.toThrow(/sus ítems no pasan a otro plan/);
    // Tampoco el owner sin contexto. OJO (ronda 1, M-8): pasa porque el
    // DIRECT_URL local es superusuario y ve la aceptación pese a la RLS FORCE;
    // con un owner sin superusuario ni BYPASSRLS (producción) el EXISTS del
    // trigger no vería la fila sin `app.current_tenant`. Es la misma
    // limitación que la rama de destino anterior a DX-417; la app escribe
    // siempre con su clínica en contexto (caso de arriba). No se duplica en
    // test/owner-nosu: exigiría crear roles en el clúster compartido.
    await expect(
      raw.treatmentPlanItem.update({
        where: { id: itemIds[0] },
        data: { planId: pendingPlanId },
      }),
    ).rejects.toThrow(/sus ítems no pasan a otro plan/);
    // Hacia el original firmado, tampoco (la regla de antes, intacta).
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.treatmentPlanItem.update({
          where: { id: itemIds[1] },
          data: { planId },
        }),
      ),
    ).rejects.toThrow(RESTRICT);
  });

  it('el enlace es de escritura única, único por plan y no apunta a sí mismo', async () => {
    const p = await patient(a, 'Enlace');
    const { planId, itemIds } = await presentedPlan(a, p, [100, 50]);
    const { doc } = await acceptPartially(a, p, planId, [itemIds[0]]);
    const pendingPlanId = doc.acceptance!.pendingPlanId!;
    const other = await presentedPlan(a, p, [40]);
    for (const value of [other.planId, null]) {
      await expect(
        prisma.runWithTenant(a.tenantId, (tx) =>
          tx.treatmentPlan.update({
            where: { id: pendingPlanId },
            data: { splitFromPlanId: value },
          }),
        ),
      ).rejects.toThrow(/no cambia/);
    }
    await expect(
      raw.treatmentPlan.update({
        where: { id: other.planId },
        data: { splitFromPlanId: planId },
      }),
    ).rejects.toThrow(/no cambia/);
    // Un segundo pendiente del mismo plan: índice único.
    await expect(
      raw.treatmentPlan.create({
        data: {
          tenantId: a.tenantId,
          patientId: p,
          currency: 'VES',
          splitFromPlanId: planId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    // Nunca de otro paciente (FK compuesta).
    const q = await patient(a, 'Otro');
    await expect(
      raw.treatmentPlan.create({
        data: {
          tenantId: a.tenantId,
          patientId: q,
          currency: 'VES',
          splitFromPlanId: other.planId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('CHECK: las columnas del pendiente van las tres o ninguna', async () => {
    const p = await patient(a, 'Check');
    const { planId } = await presentedPlan(a, p, [100]);
    const other = await presentedPlan(a, p, [40]);
    const base: Prisma.TreatmentPlanAcceptanceUncheckedCreateInput = {
      tenantId: a.tenantId,
      planId,
      patientId: p,
      locationId: a.locationId,
      signerName: 'Ana',
      signature: PNG.split(',')[1],
      content: { version: 4 },
      contentHash: 'a'.repeat(64),
      acceptanceHash: 'a'.repeat(64),
      acceptedAt: NOW,
      acceptedById: a.userId,
    };
    for (const extra of [
      { pendingPlanId: other.planId },
      { pendingPlanId: other.planId, pendingItemIds: [], pendingTotal: 1 },
      {
        pendingPlanId: planId,
        pendingItemIds: [other.itemIds[0]],
        pendingTotal: 1,
      },
      {
        pendingPlanId: other.planId,
        pendingItemIds: [other.itemIds[0]],
        pendingTotal: -1,
      },
    ]) {
      await expect(
        prisma.runWithTenant(a.tenantId, (tx) =>
          tx.treatmentPlanAcceptance.create({ data: { ...base, ...extra } }),
        ),
      ).rejects.toThrow(/23514|check constraint/);
    }
  });

  it('dos firmas parciales a la vez con selecciones distintas: una sola aceptación y un solo pendiente coherente', async () => {
    const p = await patient(a, 'Carrera');
    const { planId, itemIds } = await presentedPlan(a, p, [100, 50, 25]);
    const selections = [[itemIds[0]], [itemIds[0], itemIds[1]]];
    // Las dos vistas previas, antes: cada firma lleva su propio hash.
    const hashes = await inClinic(a, () =>
      Promise.all(
        selections.map(async (ids) => {
          const shown = await preview.execute(
            p,
            planId,
            { itemIds: ids },
            { userId: a.userId, role: ClinicRole.DENTIST },
          );
          return shown.accepted.contentHash;
        }),
      ),
    );
    // M-9: otra transacción tiene el plan; las dos firmas esperan detrás de
    // ella (comprobado en pg_locks) y salen a la vez al soltarlo.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    let holderPid!: number;
    const holder = prisma.runWithTenant(a.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "treatment_plans" WHERE "id" = ${planId}::uuid FOR UPDATE`;
      holderPid = await backendPid(tx);
      locked();
      await released;
    });
    await isLocked;
    const signs = selections.map((ids, i) =>
      settle(
        inClinic(a, () =>
          accept.execute(
            p,
            planId,
            {
              signerName: 'Ana Prueba',
              signature: PNG,
              contentHash: hashes[i],
              partial: { itemIds: ids },
            },
            META(a),
          ),
        ),
      ),
    );
    await waitForLockWaiters(raw, [holderPid], 2);
    release();
    await holder;
    const results = await Promise.all(signs);

    const won = results.findIndex((r) => r.status === 'fulfilled');
    expect(won).toBeGreaterThanOrEqual(0);
    expect(results[1 - won]).toMatchObject({
      status: 'rejected',
      reason: { status: 409 },
    });
    const acceptances = await raw.treatmentPlanAcceptance.findMany({
      where: { planId },
    });
    expect(acceptances).toHaveLength(1);
    const pendings = await raw.treatmentPlan.findMany({
      where: { splitFromPlanId: planId },
      include: { items: true },
    });
    expect(pendings).toHaveLength(1);
    // Coherente con la que ganó: lo pendiente es justo lo que no eligió.
    const left = itemIds.filter((id) => !selections[won].includes(id));
    expect(pendings[0].items.map((i) => i.id).sort()).toEqual([...left].sort());
    expect([...acceptances[0].pendingItemIds].sort()).toEqual([...left].sort());
    expect(acceptances[0].pendingPlanId).toBe(pendings[0].id);
    expect(
      await raw.treatmentPlanItem.count({
        where: { planId, status: 'ACCEPTED' },
      }),
    ).toBe(selections[won].length);
  });

  it('mover los pendientes no encola un reparto de imputaciones para el pendiente', async () => {
    const p = await patient(a, 'Reparto');
    const { planId, itemIds } = await presentedPlan(a, p, [100, 50]);
    const { doc } = await acceptPartially(a, p, planId, [itemIds[0]]);
    expect(
      await raw.planAllocationRebalanceRequest.count({
        where: { treatmentPlanId: doc.acceptance!.pendingPlanId! },
      }),
    ).toBe(0);
  });

  it('M-4: la base no admite una aceptación que nombre un pendiente que no sale de su plan', async () => {
    const p = await patient(a, 'Enlace cruzado');
    // Un pendiente de OTRO plan (enlazado a mano: aún sin aceptación que lo
    // nombre) y un plan suelto.
    const third = await presentedPlan(a, p, [90]);
    const foreignPending = await raw.treatmentPlan.create({
      data: {
        tenantId: a.tenantId,
        patientId: p,
        currency: 'VES',
        splitFromPlanId: third.planId,
      },
    });
    const second = await presentedPlan(a, p, [70, 30]);
    const lonely = await presentedPlan(a, p, [40]);
    for (const pendingPlanId of [foreignPending.id, lonely.planId]) {
      await expect(
        prisma.runWithTenant(a.tenantId, (tx) =>
          tx.treatmentPlanAcceptance.create({
            data: {
              tenantId: a.tenantId,
              planId: second.planId,
              patientId: p,
              locationId: a.locationId,
              signerName: 'Ana',
              signature: PNG.split(',')[1],
              content: { version: 4 },
              contentHash: 'a'.repeat(64),
              acceptanceHash: 'a'.repeat(64),
              acceptedAt: NOW,
              acceptedById: a.userId,
              pendingPlanId,
              pendingItemIds: [second.itemIds[1]],
              pendingTotal: 30,
            },
          }),
        ),
      ).rejects.toThrow(/tiene que venir del plan aceptado/);
    }
    expect(
      await raw.treatmentPlanAcceptance.count({
        where: { planId: second.planId },
      }),
    ).toBe(0);
  });

  it('con abonos vivos, plan de cuotas o saldo a favor: 409 y no se escribe nada', async () => {
    const p = await patient(a, 'Cobrado');
    const { planId, itemIds } = await presentedPlan(a, p, [100, 50]);
    const shown = await inClinic(a, () =>
      preview.execute(
        p,
        planId,
        { itemIds: [itemIds[0]] },
        { userId: a.userId, role: ClinicRole.DENTIST },
      ),
    );
    await raw.payment.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.locationId,
        treatmentPlanId: planId,
        patientId: p,
        amount: 20,
        currency: 'VES',
        paidAt: NOW,
      },
    });
    await expect(
      inClinic(a, () =>
        accept.execute(
          p,
          planId,
          {
            signerName: 'Ana',
            signature: PNG,
            contentHash: shown.accepted.contentHash,
            partial: { itemIds: [itemIds[0]] },
          },
          META(a),
        ),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message:
        'El plan tiene abonos registrados: no se acepta en parte. Anula los abonos o acéptalo entero.',
    });
    expect(
      await raw.treatmentPlan.findUniqueOrThrow({ where: { id: planId } }),
    ).toMatchObject({ status: 'PRESENTED' });
    expect(await raw.treatmentPlanItem.count({ where: { planId } })).toBe(2);
    expect(
      await raw.treatmentPlan.count({ where: { splitFromPlanId: planId } }),
    ).toBe(0);
    expect(await raw.treatmentPlanAcceptance.count({ where: { planId } })).toBe(
      0,
    );
  });

  it('grupo de opciones: las hermanas pasan a REJECTED; el pendiente queda fuera y se acepta después, también en parte', async () => {
    const p = await patient(a, 'Grupo');
    const root = await presentedPlan(a, p, [300, 200, 100]);
    await raw.treatmentPlan.update({
      where: { id: root.planId },
      data: { optionGroupId: root.planId, optionLabel: 'Opción A' },
    });
    const sister = await presentedPlan(a, p, [999], {
      optionGroupId: root.planId,
      optionLabel: 'Opción B',
    });

    const { doc } = await acceptPartially(a, p, root.planId, [root.itemIds[0]]);
    const pendingPlanId = doc.acceptance!.pendingPlanId!;
    expect(
      await raw.treatmentPlan.findUniqueOrThrow({
        where: { id: sister.planId },
      }),
    ).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'OTHER_OPTION_ACCEPTED',
    });
    expect(
      await raw.treatmentPlan.findUniqueOrThrow({
        where: { id: pendingPlanId },
      }),
    ).toMatchObject({ status: 'PRESENTED', optionGroupId: null });

    // El pendiente se acepta otra vez en parte: su propio pendiente.
    const again = await acceptPartially(a, p, pendingPlanId, [root.itemIds[1]]);
    const second = again.doc.acceptance!.pendingPlanId!;
    expect(
      await raw.treatmentPlan.findUniqueOrThrow({ where: { id: second } }),
    ).toMatchObject({ status: 'PRESENTED', splitFromPlanId: pendingPlanId });
    expect(
      await raw.treatmentPlanItem.findUniqueOrThrow({
        where: { id: root.itemIds[2] },
      }),
    ).toMatchObject({ planId: second, status: 'PROPOSED' });
  });

  it('la reserva de cita del ítem movido sigue con él', async () => {
    const p = await patient(a, 'Cita');
    const { planId, itemIds } = await presentedPlan(a, p, [100, 50]);
    const start = new Date('2026-11-20T14:00:00.000Z');
    const appointment = await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.locationId,
        patientId: p,
        providerId: a.userId,
        start,
        end: new Date(start.getTime() + 30 * 60 * 1000),
        status: 'SCHEDULED',
      },
    });
    await raw.appointmentPlanItem.create({
      data: {
        tenantId: a.tenantId,
        patientId: p,
        appointmentId: appointment.id,
        planItemId: itemIds[1],
      },
    });

    const { doc } = await acceptPartially(a, p, planId, [itemIds[0]]);

    const link = await raw.appointmentPlanItem.findFirstOrThrow({
      where: { appointmentId: appointment.id },
      include: { planItem: { select: { planId: true } } },
    });
    expect(link).toMatchObject({
      planItemId: itemIds[1],
      deletedAt: null,
      planItem: { planId: doc.acceptance!.pendingPlanId },
    });
  });
});
