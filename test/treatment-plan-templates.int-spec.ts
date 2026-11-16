import { HttpException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import type { TemplateItemInput } from '../src/modules/treatment-plans/domain/ports/treatment-plan-repository.port';
import { assertTemplateApplicable } from '../src/modules/treatment-plans/application/use-cases/apply-plan-template.use-case';
import { freezeReference } from '../src/modules/discounts/domain/reference-in-plan';
import { PLAN_TEMPLATE_PLAN_NOT_EDITABLE } from '../src/modules/treatment-plan-templates/application/plan-template-errors';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-559, capa DB: plantillas de plan (RLS FORCE con NULLIF, FK compuestas,
// CHECK, sin DELETE de la cabecera) y la aplicación todo o nada con el plan
// bloqueado FOR UPDATE frente a una aceptación concurrente. Lo que se prueba
// va por la MISMA ruta que la app (runWithTenant, rol dentalix_app, sujeto a
// RLS); `raw` (DIRECT_URL, superusuario) siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const plans = new PrismaTreatmentPlanRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx559-int-a', 'dx559-int-b'];
const EMAIL = 'dx559-int@example.com';
const FK_VIOLATION = { code: 'P2003' };

interface Clinic {
  tenantId: string;
  locationId: string;
  patientId: string;
  catalogItemId: string;
  templateId: string;
}

let userId: string;

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const location = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, { tenantId, name: 'Sede' }),
  });
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Ana', lastName: subdomain },
  });
  const catalogItem = await raw.dentalCatalogItem.create({
    data: {
      tenantId,
      code: 'ENDO',
      kind: 'PROCEDURE',
      labelEs: 'Endodoncia',
      color: '#2A2B3C',
      defaultPrice: 120,
    },
  });
  const template = await raw.treatmentPlanTemplate.create({
    data: {
      tenantId,
      name: 'Endodoncia + corona',
      visitIntervals: { '2': 7 },
      lines: {
        create: [
          { catalogItemId: catalogItem.id, position: 0, visit: 1 },
          { catalogItemId: catalogItem.id, position: 1, visit: 2 },
        ],
      },
    },
  });
  return {
    tenantId,
    locationId: location.id,
    patientId: patient.id,
    catalogItemId: catalogItem.id,
    templateId: template.id,
  };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.auditEvent.deleteMany({ where });
  await raw.treatmentPlanItem.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.treatmentPlanTemplate.deleteMany({ where });
  await raw.dentalCatalogItem.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: where.tenantId } });
}

describe('plantillas de plan de tratamiento (int, DX-559)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    await raw.user.deleteMany({ where: { email: EMAIL } });
    userId = (
      await raw.user.create({
        data: { email: EMAIL, passwordHash: 'x', fullName: 'Dra. Ríos' },
      })
    ).id;
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await raw.user.deleteMany({ where: { id: userId } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  const audit = (): AuditRequestContext => ({
    tenantId: a.tenantId,
    locationId: a.locationId,
    actor: { userId, role: 'DENTIST' },
    requestId: null,
    ip: null,
    userAgent: null,
  });

  function item(visit: number): TemplateItemInput {
    const priced = {
      catalogPrice: 120,
      basePrice: 120,
      catalogCurrency: 'USD',
      priceSource: 'CATALOG' as const,
    };
    return {
      toothNumber: '36',
      surfaces: [],
      catalogItemId: a.catalogItemId,
      catalogPrice: 120,
      pricing: {
        basePrice: 120,
        catalogCurrency: 'USD',
        priceSource: 'CATALOG',
        agreementId: null,
        agreementName: null,
        pricingLocationId: a.locationId,
        reference: freezeReference(priced, 'USD', 2, null),
      },
      price: 120,
      discount: 0,
      createdById: userId,
      visit,
      visitLabel: null,
    };
  }

  async function newPlan(): Promise<string> {
    return (
      await raw.treatmentPlan.create({
        data: { tenantId: a.tenantId, patientId: a.patientId, currency: 'USD' },
      })
    ).id;
  }

  describe.each(['treatment_plan_templates', 'treatment_plan_template_lines'])(
    '%s',
    (table) => {
      it('tiene RLS ENABLE + FORCE y la política del tenant con NULLIF', async () => {
        const rows = await raw.$queryRawUnsafe<
          { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
        >(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '"${table}"'::regclass`,
        );
        expect(rows[0]).toEqual({
          relrowsecurity: true,
          relforcerowsecurity: true,
        });
        const policies = await raw.$queryRaw<
          { policyname: string; qual: string }[]
        >`SELECT policyname, qual FROM pg_policies WHERE tablename = ${table}`;
        expect(policies.map((p) => p.policyname)).toEqual(['tenant_isolation']);
        expect(policies[0].qual).toContain('NULLIF');
      });
    },
  );

  it('cada clínica ve solo sus plantillas y líneas, y no escribe en otra', async () => {
    const templates = await asA((tx) => tx.treatmentPlanTemplate.findMany());
    expect(templates.map((t) => t.id)).toEqual([a.templateId]);
    const lines = await asA((tx) => tx.treatmentPlanTemplateLine.findMany());
    expect(new Set(lines.map((l) => l.templateId))).toEqual(
      new Set([a.templateId]),
    );
    await expect(
      asA((tx) =>
        tx.treatmentPlanTemplate.create({
          data: { tenantId: b.tenantId, name: 'Intrusa' },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    // Sin GUC (NULLIF): ninguna fila, nunca un error de conversión.
    const bare = await prisma.runWithTenant('', (tx) =>
      tx.treatmentPlanTemplate.findMany(),
    );
    expect(bare).toEqual([]);
  });

  it('FK compuesta: una línea no cuelga de la plantilla ni del catálogo de otra clínica', async () => {
    await expect(
      raw.treatmentPlanTemplateLine.create({
        data: {
          tenantId: a.tenantId,
          templateId: a.templateId,
          catalogItemId: b.catalogItemId,
          position: 10,
        },
      }),
    ).rejects.toMatchObject(FK_VIOLATION);
    await expect(
      raw.treatmentPlanTemplateLine.create({
        data: {
          tenantId: a.tenantId,
          templateId: b.templateId,
          catalogItemId: a.catalogItemId,
          position: 10,
        },
      }),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it.each([
    ['cantidad 0', { quantity: 0 }, 'quantity_check'],
    ['cantidad 21', { quantity: 21 }, 'quantity_check'],
    ['visita 0', { visit: 0 }, 'visit_check'],
    ['visita 51', { visit: 51 }, 'visit_check'],
    ['posición 50', { position: 50 }, 'position_check'],
    ['etiqueta vacía', { visitLabel: '  ' }, 'visit_label_check'],
  ])('CHECK de la línea: %s', async (_name, extra, check) => {
    await expect(
      raw.treatmentPlanTemplateLine.create({
        data: {
          tenantId: a.tenantId,
          templateId: a.templateId,
          catalogItemId: a.catalogItemId,
          position: 20,
          ...extra,
        },
      }),
    ).rejects.toThrow(new RegExp(`treatment_plan_template_lines_${check}`));
  });

  it.each([
    ['nombre vacío', { name: '   ' }, 'name_check'],
    ['nombre de 81', { name: 'x'.repeat(81) }, 'name_check'],
    [
      'intervalo de la visita 1',
      { visitIntervals: { '1': 3 } },
      'visit_intervals_check',
    ],
    [
      'intervalo de la visita 51',
      { visitIntervals: { '51': 3 } },
      'visit_intervals_check',
    ],
    [
      'días negativos',
      { visitIntervals: { '2': -1 } },
      'visit_intervals_check',
    ],
    ['días de más', { visitIntervals: { '2': 3651 } }, 'visit_intervals_check'],
    [
      'días con decimales',
      { visitIntervals: { '2': 1.5 } },
      'visit_intervals_check',
    ],
    ['no es un objeto', { visitIntervals: [7] }, 'visit_intervals_check'],
  ])('CHECK de la plantilla: %s', async (_name, extra, check) => {
    await expect(
      raw.treatmentPlanTemplate.create({
        data: { tenantId: a.tenantId, name: 'Válida', ...extra },
      }),
    ).rejects.toThrow(new RegExp(`treatment_plan_templates_${check}`));
  });

  it('la app no borra plantillas (se desactivan); sus líneas sí se reemplazan', async () => {
    await expect(
      asA(
        (tx) =>
          tx.$executeRaw`DELETE FROM "treatment_plan_templates" WHERE false`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asA(
        (tx) =>
          tx.$executeRaw`DELETE FROM "treatment_plan_template_lines" WHERE false`,
      ),
    ).resolves.toBe(0);
  });

  describe('aplicar (addTemplateItems)', () => {
    it('crea los ítems, fusiona los intervalos y deja el evento en la misma transacción', async () => {
      const planId = await newPlan();
      const created = await tenantContext.run(a.tenantId, () =>
        plans.addTemplateItems(
          planId,
          () => ({
            items: [item(1), item(2), item(2)],
            visitIntervals: { '2': 7 },
          }),
          { context: audit(), templateId: a.templateId },
        ),
      );
      expect(created.map((i) => i.visit)).toEqual([1, 2, 2]);
      const plan = await raw.treatmentPlan.findUniqueOrThrow({
        where: { id: planId },
      });
      expect(plan.visitIntervals).toEqual({ '2': 7 });
      const events = await raw.auditEvent.findMany({
        where: { tenantId: a.tenantId, resourceId: planId },
        select: {
          action: true,
          resourceType: true,
          patientId: true,
          metadata: true,
        },
      });
      expect(events).toEqual([
        {
          action: 'UPDATE',
          resourceType: 'TREATMENT_PLAN',
          patientId: a.patientId,
          metadata: {
            reason: 'PLAN_TEMPLATE_APPLIED',
            params: { templateId: a.templateId, itemsCreated: '3' },
          },
        },
      ]);
    });

    it('todo o nada: si falla una línea, o los intervalos, no entra ningún ítem ni el evento', async () => {
      const planId = await newPlan();
      const run = (decision: {
        items: TemplateItemInput[];
        visitIntervals: Record<string, number> | null;
      }) =>
        tenantContext.run(a.tenantId, () =>
          plans.addTemplateItems(planId, () => decision, {
            context: audit(),
            templateId: a.templateId,
          }),
        );
      // La segunda línea rompe el CHECK de la visita (1..1000).
      await expect(
        run({ items: [item(1), item(1001)], visitIntervals: null }),
      ).rejects.toThrow();
      // Los ítems entran, pero los intervalos rompen el CHECK del plan.
      await expect(
        run({ items: [item(1), item(2)], visitIntervals: { '2': -5 } }),
      ).rejects.toThrow();
      expect(await raw.treatmentPlanItem.count({ where: { planId } })).toBe(0);
      expect(
        await raw.auditEvent.count({
          where: { tenantId: a.tenantId, resourceId: planId },
        }),
      ).toBe(0);
    });

    it('una aceptación concurrente gana: aplicar espera al bloqueo, ve ACCEPTED y responde 409 sin escribir', async () => {
      const planId = await newPlan();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let markLocked!: () => void;
      const locked = new Promise<void>((resolve) => (markLocked = resolve));
      const acceptance = raw.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "treatment_plans" WHERE "id" = ${planId}::uuid FOR UPDATE`;
          await tx.treatmentPlan.update({
            where: { id: planId },
            data: { status: 'ACCEPTED' },
          });
          markLocked();
          await held;
        },
        { timeout: 20_000 },
      );
      await locked;
      let settled = false;
      const applying = tenantContext
        .run(a.tenantId, () =>
          plans.addTemplateItems(planId, (plan) => {
            assertTemplateApplicable(plan);
            return { items: [item(1)], visitIntervals: null };
          }),
        )
        .finally(() => {
          settled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Sigue esperando el bloqueo de la aceptación.
      expect(settled).toBe(false);
      release();
      await acceptance;
      const error = await applying.then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getResponse()).toMatchObject({
        code: PLAN_TEMPLATE_PLAN_NOT_EDITABLE,
        status: 'ACCEPTED',
      });
      expect(await raw.treatmentPlanItem.count({ where: { planId } })).toBe(0);
    });

    it('un plan de otra clínica es invisible: 404', async () => {
      const foreign = (
        await raw.treatmentPlan.create({
          data: {
            tenantId: b.tenantId,
            patientId: b.patientId,
            currency: 'USD',
          },
        })
      ).id;
      await expect(
        tenantContext.run(a.tenantId, () =>
          plans.addTemplateItems(foreign, () => ({
            items: [item(1)],
            visitIntervals: null,
          })),
        ),
      ).rejects.toMatchObject({ status: 404 });
      expect(
        await raw.treatmentPlanItem.count({ where: { planId: foreign } }),
      ).toBe(0);
    });
  });
});
