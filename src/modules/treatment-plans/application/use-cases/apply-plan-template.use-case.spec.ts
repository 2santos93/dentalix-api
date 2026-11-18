import { HttpException, NotFoundException } from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';
import { catalogPricing } from './__fixtures__/catalog-pricing-source';
import { ADMIN_ACTOR, DENTIST_ACTOR } from './__fixtures__/discount-fixtures';
import { ApplyPlanTemplateUseCase } from './apply-plan-template.use-case';
import { DISCOUNT_REFERENCE_RATE_MISSING_CODE } from './reference-rate';
import {
  AUDIT_CTX,
  InMemoryTreatmentPlanTemplateRepository,
} from '../../../treatment-plan-templates/application/__fixtures__/in-memory-treatment-plan-templates';
import {
  PLAN_TEMPLATE_INACTIVE,
  PLAN_TEMPLATE_NOTHING_TO_APPLY,
  PLAN_TEMPLATE_PLAN_NOT_EDITABLE,
  PLAN_TEMPLATE_PRICE_MISSING,
  PLAN_TEMPLATE_TOOTH_REQUIRED,
  PLAN_TEMPLATE_UNKNOWN_LINE,
  PLAN_TEMPLATE_VISIT_OVERFLOW,
} from '../../../treatment-plan-templates/application/plan-template-errors';
import type { PlanTemplateDraft } from '../../../treatment-plan-templates/domain/plan-template-rules';
import { referenceCurrencyDigitsCatalog } from '../../../../shared/money/__fixtures__/reference-currency-digits';
import type { PricingContext } from '../../domain/pricing/resolve-item-price';

const ENDO = 'endo';
const CROWN = 'crown';
const POST = 'post';
const FREE = 'free';

interface CatalogRow {
  defaultPrice: number | null;
  category: string | null;
  allowDiscount: boolean;
}

function setup(
  options: {
    pricingExtra?: Partial<
      Omit<
        PricingContext,
        'catalogItem' | 'planCurrency' | 'planRoundingDigits'
      >
    >;
    inactive?: string[];
  } = {},
) {
  const plans = new InMemoryTreatmentPlanRepository();
  const templates = new InMemoryTreatmentPlanTemplateRepository();
  const catalog = new Map<string, CatalogRow>([
    [ENDO, { defaultPrice: 120, category: null, allowDiscount: true }],
    [CROWN, { defaultPrice: 250.5, category: null, allowDiscount: true }],
    [POST, { defaultPrice: 40, category: null, allowDiscount: true }],
    [FREE, { defaultPrice: null, category: null, allowDiscount: true }],
  ]);
  for (const id of catalog.keys()) {
    templates.addCatalogItem({
      id,
      kind: 'PROCEDURE',
      labelEs: `Proc ${id}`,
      active: !(options.inactive ?? []).includes(id),
    });
  }
  const pricing = catalogPricing(
    { findById: (id) => Promise.resolve(catalog.get(id) as never) },
    options.pricingExtra,
  );
  const useCase = new ApplyPlanTemplateUseCase(
    plans,
    templates,
    pricing,
    referenceCurrencyDigitsCatalog(),
  );
  return { plans, templates, useCase };
}

const ENDO_CROWN: PlanTemplateDraft = {
  name: 'Endodoncia + corona',
  visitIntervals: { '2': 7, '3': 14 },
  lines: [
    {
      catalogItemId: ENDO,
      quantity: 1,
      visit: 1,
      visitLabel: 'Apertura',
      asksSurfaces: false,
    },
    {
      catalogItemId: POST,
      quantity: 1,
      visit: 2,
      visitLabel: null,
      asksSurfaces: false,
    },
    {
      catalogItemId: CROWN,
      quantity: 1,
      visit: 3,
      visitLabel: 'Corona',
      asksSurfaces: true,
    },
  ],
};

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const body = error.getResponse() as { code?: string };
    return body.code ?? error.getStatus();
  }
  return 'resolved';
}

async function bodyOf(
  promise: Promise<unknown>,
): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return error.getResponse() as Record<string, unknown>;
  }
  throw new Error('se esperaba un error');
}

describe('ApplyPlanTemplateUseCase (DX-559)', () => {
  it('en un plan vacío: visitas 1, 2 y 3, intervalos, precio de catálogo sin descuento y auditoría', async () => {
    const { plans, templates, useCase } = setup();
    const plan = plans.seedPlan();
    const template = await templates.create(
      { ...ENDO_CROWN, active: true },
      AUDIT_CTX,
    );
    const result = await useCase.apply(
      plan.id,
      {
        templateId: template.id,
        toothNumber: '36',
        lines: [
          {
            lineId: template.lines[2].id,
            toothNumber: '46',
            surfaces: ['OCCLUSAL'],
          },
        ],
      },
      DENTIST_ACTOR,
      AUDIT_CTX,
    );
    expect(
      result.createdItems.map((i) => ({
        catalogItemId: i.catalogItemId,
        visit: i.visit,
        visitLabel: i.visitLabel,
        toothNumber: i.toothNumber,
        surfaces: i.surfaces,
        price: i.price,
        discount: i.discount,
        catalogPrice: i.catalogPrice,
        priceSource: i.priceSource,
      })),
    ).toEqual([
      {
        catalogItemId: ENDO,
        visit: 1,
        visitLabel: 'Apertura',
        toothNumber: '36',
        surfaces: [],
        price: 120,
        discount: 0,
        catalogPrice: 120,
        priceSource: 'CATALOG',
      },
      {
        catalogItemId: POST,
        visit: 2,
        visitLabel: null,
        toothNumber: '36',
        surfaces: [],
        price: 40,
        discount: 0,
        catalogPrice: 40,
        priceSource: 'CATALOG',
      },
      {
        catalogItemId: CROWN,
        visit: 3,
        visitLabel: 'Corona',
        toothNumber: '46',
        surfaces: ['OCCLUSAL'],
        price: 250.5,
        discount: 0,
        catalogPrice: 250.5,
        priceSource: 'CATALOG',
      },
    ]);
    expect(result.skipped).toEqual([]);
    expect((await plans.findPlanById(plan.id))?.visitIntervals).toEqual({
      '2': 7,
      '3': 14,
    });
    expect(plans.templateApplications).toEqual([
      { planId: plan.id, templateId: template.id, itemsCreated: 3 },
    ]);
  });

  it('con visitas vivas, se desplaza detrás de la mayor sin pisar sus intervalos', async () => {
    const { plans, templates, useCase } = setup();
    const plan = plans.seedPlan({ visitIntervals: { '2': 30, '4': 1 } });
    plans.seedItem({ planId: plan.id, visit: 1 });
    plans.seedItem({ planId: plan.id, visit: 2 });
    // Uno retirado no cuenta para el desplazamiento.
    plans.seedItem({ planId: plan.id, visit: 9, deletedAt: new Date() });
    const template = await templates.create(
      { ...ENDO_CROWN, active: true },
      AUDIT_CTX,
    );
    const preview = await useCase.preview(plan.id, template.id, DENTIST_ACTOR);
    expect(preview.visitOffset).toBe(2);
    expect(preview.lines.map((l) => l.targetVisit)).toEqual([3, 4, 5]);
    expect(preview.visitIntervals).toEqual({ '2': 30, '4': 1, '5': 14 });

    const result = await useCase.apply(
      plan.id,
      { templateId: template.id, toothNumber: '11' },
      DENTIST_ACTOR,
    );
    expect(result.createdItems.map((i) => i.visit)).toEqual([3, 4, 5]);
    expect((await plans.findPlanById(plan.id))?.visitIntervals).toEqual({
      '2': 30,
      '4': 1,
      '5': 14,
    });
    // Sin contexto de auditoría, sin evento.
    expect(plans.templateApplications).toEqual([]);
  });

  it('cantidad N crea N ítems iguales en esa visita y con el mismo diente', async () => {
    const { plans, templates, useCase } = setup();
    const plan = plans.seedPlan();
    const template = await templates.create(
      {
        name: 'Sellantes',
        visitIntervals: {},
        lines: [
          {
            catalogItemId: POST,
            quantity: 3,
            visit: 1,
            visitLabel: null,
            asksSurfaces: false,
          },
        ],
        active: true,
      },
      AUDIT_CTX,
    );
    const preview = await useCase.preview(plan.id, template.id, DENTIST_ACTOR);
    expect(preview).toMatchObject({ itemCount: 3, total: 120 });
    expect(preview.lines[0]).toMatchObject({ unitPrice: 40, lineTotal: 120 });
    const result = await useCase.apply(
      plan.id,
      { templateId: template.id, toothNumber: '16' },
      DENTIST_ACTOR,
    );
    expect(
      result.createdItems.map((i) => [i.toothNumber, i.visit, i.price]),
    ).toEqual([
      ['16', 1, 40],
      ['16', 1, 40],
      ['16', 1, 40],
    ]);
    // Sin intervalos que fusionar, el plan no cambia.
    expect((await plans.findPlanById(plan.id))?.visitIntervals).toBeUndefined();
  });

  it('un procedimiento desactivado se omite (vista previa y aplicar); sin ninguno aplicable, 422', async () => {
    const { plans, templates, useCase } = setup({ inactive: [POST] });
    const plan = plans.seedPlan();
    const template = await templates.create(
      { ...ENDO_CROWN, active: true },
      AUDIT_CTX,
    );
    const preview = await useCase.preview(plan.id, template.id, DENTIST_ACTOR);
    expect(preview.lines[1]).toMatchObject({
      skipped: 'CATALOG_ITEM_INACTIVE',
      targetVisit: null,
      unitPrice: null,
      priceMissing: false,
    });
    expect(preview.total).toBe(370.5);
    const result = await useCase.apply(
      plan.id,
      { templateId: template.id, toothNumber: '36' },
      DENTIST_ACTOR,
    );
    expect(result.createdItems.map((i) => i.catalogItemId)).toEqual([
      ENDO,
      CROWN,
    ]);
    expect(result.skipped).toEqual([
      {
        lineId: template.lines[1].id,
        catalogItemId: POST,
        catalogItemLabel: 'Proc post',
        reason: 'CATALOG_ITEM_INACTIVE',
      },
    ]);

    const onlyInactive = await templates.create(
      {
        name: 'Solo inactivo',
        visitIntervals: {},
        lines: [ENDO_CROWN.lines[1]],
        active: true,
      },
      AUDIT_CTX,
    );
    expect(
      await codeOf(
        useCase.apply(plan.id, { templateId: onlyInactive.id }, DENTIST_ACTOR),
      ),
    ).toBe(PLAN_TEMPLATE_NOTHING_TO_APPLY);
  });

  it('sin diente para una línea: 400 con su lineId y no se crea nada', async () => {
    const { plans, templates, useCase } = setup();
    const plan = plans.seedPlan();
    const template = await templates.create(
      { ...ENDO_CROWN, active: true },
      AUDIT_CTX,
    );
    const body = await bodyOf(
      useCase.apply(
        plan.id,
        {
          templateId: template.id,
          lines: [
            { lineId: template.lines[0].id, toothNumber: '11' },
            { lineId: template.lines[1].id, toothNumber: '11' },
          ],
        },
        DENTIST_ACTOR,
      ),
    );
    expect(body).toMatchObject({
      statusCode: 400,
      code: PLAN_TEMPLATE_TOOTH_REQUIRED,
      lineId: template.lines[2].id,
    });
    expect((await plans.findPlanById(plan.id))?.items).toEqual([]);
  });

  it('un lineId que no es de la plantilla: 400', async () => {
    const { plans, templates, useCase } = setup();
    const plan = plans.seedPlan();
    const template = await templates.create(
      { ...ENDO_CROWN, active: true },
      AUDIT_CTX,
    );
    expect(
      await codeOf(
        useCase.apply(
          plan.id,
          {
            templateId: template.id,
            toothNumber: '11',
            lines: [{ lineId: 'otra-linea', toothNumber: '12' }],
          },
          DENTIST_ACTOR,
        ),
      ),
    ).toBe(PLAN_TEMPLATE_UNKNOWN_LINE);
  });

  it.each([
    TreatmentPlanStatus.ACCEPTED,
    TreatmentPlanStatus.REJECTED,
    TreatmentPlanStatus.COMPLETED,
    TreatmentPlanStatus.CANCELLED,
  ])(
    'un plan %s da 409 con el estado (también aceptado sin firma)',
    async (status) => {
      const { plans, templates, useCase } = setup();
      const plan = plans.seedPlan({ status });
      const template = await templates.create(
        { ...ENDO_CROWN, active: true },
        AUDIT_CTX,
      );
      const body = await bodyOf(
        useCase.apply(
          plan.id,
          { templateId: template.id, toothNumber: '11' },
          DENTIST_ACTOR,
        ),
      );
      expect(body).toMatchObject({
        statusCode: 409,
        code: PLAN_TEMPLATE_PLAN_NOT_EDITABLE,
        status,
      });
      expect(body.message).toMatch(/^El plan está /);
      expect(
        await codeOf(useCase.preview(plan.id, template.id, DENTIST_ACTOR)),
      ).toBe(PLAN_TEMPLATE_PLAN_NOT_EDITABLE);
    },
  );

  it('un plan firmado da 409 aunque su estado lo admitiera', async () => {
    const { plans, templates, useCase } = setup();
    const plan = plans.seedPlan({
      status: TreatmentPlanStatus.PRESENTED,
      acceptance: {
        signerName: 'Paciente',
        acceptedAt: new Date(),
        remote: null,
        portal: null,
      },
    });
    const template = await templates.create(
      { ...ENDO_CROWN, active: true },
      AUDIT_CTX,
    );
    const body = await bodyOf(
      useCase.apply(
        plan.id,
        { templateId: template.id, toothNumber: '11' },
        DENTIST_ACTOR,
      ),
    );
    expect(body.code).toBe(PLAN_TEMPLATE_PLAN_NOT_EDITABLE);
    expect(body.message).toMatch(/firmado/);
  });

  it('el estado se vuelve a mirar con el plan bloqueado: una aceptación que se cuela da 409 y nada entra', async () => {
    const { plans, templates, useCase } = setup();
    const draft = plans.seedPlan();
    const accepted = plans.seedPlan({ status: TreatmentPlanStatus.ACCEPTED });
    const template = await templates.create(
      { ...ENDO_CROWN, active: true },
      AUDIT_CTX,
    );
    // La lectura previa ve el plan en borrador; el bloqueo, ya aceptado.
    const staleRead = await plans.findPlanById(draft.id);
    jest
      .spyOn(plans, 'findPlanById')
      .mockResolvedValueOnce({ ...staleRead!, id: accepted.id });
    expect(
      await codeOf(
        useCase.apply(
          accepted.id,
          { templateId: template.id, toothNumber: '11' },
          DENTIST_ACTOR,
        ),
      ),
    ).toBe(PLAN_TEMPLATE_PLAN_NOT_EDITABLE);
    expect((await plans.findPlanById(accepted.id))?.items).toEqual([]);
  });

  it('una plantilla desactivada da 409; una inexistente o de otra clínica, 404', async () => {
    const { plans, templates, useCase } = setup();
    const plan = plans.seedPlan();
    const template = await templates.create(
      { ...ENDO_CROWN, active: false },
      AUDIT_CTX,
    );
    expect(
      await codeOf(useCase.preview(plan.id, template.id, DENTIST_ACTOR)),
    ).toBe(PLAN_TEMPLATE_INACTIVE);
    await expect(
      useCase.preview(plan.id, 'no-existe', DENTIST_ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      useCase.preview('no-existe', template.id, DENTIST_ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('sin precio: la vista previa lo marca y aplicar da 422 con la línea, sin crear nada', async () => {
    const { plans, templates, useCase } = setup();
    const plan = plans.seedPlan();
    const template = await templates.create(
      {
        name: 'Con libre',
        visitIntervals: {},
        lines: [
          ENDO_CROWN.lines[0],
          { ...ENDO_CROWN.lines[0], catalogItemId: FREE },
        ],
        active: true,
      },
      AUDIT_CTX,
    );
    const preview = await useCase.preview(plan.id, template.id, DENTIST_ACTOR);
    expect(preview.lines[1]).toMatchObject({
      priceMissing: true,
      priceIssue: 'NO_PRICE',
      unitPrice: null,
      lineTotal: null,
    });
    expect(preview.total).toBe(120);
    const body = await bodyOf(
      useCase.apply(
        plan.id,
        { templateId: template.id, toothNumber: '11' },
        DENTIST_ACTOR,
      ),
    );
    expect(body).toMatchObject({
      statusCode: 422,
      code: PLAN_TEMPLATE_PRICE_MISSING,
      lineId: template.lines[1].id,
    });
    expect((await plans.findPlanById(plan.id))?.items).toEqual([]);
  });

  it('la fuente del precio es la de hoy para el paciente: la lista de la sede gana al catálogo', async () => {
    const { plans, templates, useCase } = setup({
      pricingExtra: { locationList: { price: 95, currency: 'USD' } },
    });
    const plan = plans.seedPlan();
    const template = await templates.create(
      {
        name: 'Una',
        visitIntervals: {},
        lines: [ENDO_CROWN.lines[0]],
        active: true,
      },
      AUDIT_CTX,
    );
    const preview = await useCase.preview(plan.id, template.id, DENTIST_ACTOR);
    expect(preview.lines[0]).toMatchObject({
      unitPrice: 95,
      priceSource: 'PRICE_LIST',
    });
    const [item] = (
      await useCase.apply(
        plan.id,
        { templateId: template.id, toothNumber: '11' },
        DENTIST_ACTOR,
      )
    ).createdItems;
    expect(item).toMatchObject({
      price: 95,
      catalogPrice: 95,
      discount: 0,
      priceSource: 'PRICE_LIST',
      basePrice: 120,
      discountReason: null,
    });
  });

  it('sin tasa (catálogo en otra moneda): la vista previa lo marca y aplicar da 422 con la línea', async () => {
    const { plans, templates, useCase } = setup({
      pricingExtra: { catalogCurrency: 'EUR' },
    });
    const plan = plans.seedPlan();
    const template = await templates.create(
      {
        name: 'Una',
        visitIntervals: {},
        lines: [ENDO_CROWN.lines[0]],
        active: true,
      },
      AUDIT_CTX,
    );
    const preview = await useCase.preview(plan.id, template.id, ADMIN_ACTOR);
    expect(preview.lines[0]).toMatchObject({
      priceMissing: true,
      priceIssue: 'RATE_MISSING',
    });
    const body = await bodyOf(
      useCase.apply(
        plan.id,
        { templateId: template.id, toothNumber: '11' },
        ADMIN_ACTOR,
      ),
    );
    expect(body).toMatchObject({
      statusCode: 422,
      code: DISCOUNT_REFERENCE_RATE_MISSING_CODE,
      lineId: template.lines[0].id,
    });
  });

  it('desbordar la visita 1000 da 409', async () => {
    const { plans, templates, useCase } = setup();
    const plan = plans.seedPlan();
    plans.seedItem({ planId: plan.id, visit: 998 });
    const template = await templates.create(
      { ...ENDO_CROWN, active: true },
      AUDIT_CTX,
    );
    expect(
      await codeOf(useCase.preview(plan.id, template.id, DENTIST_ACTOR)),
    ).toBe(PLAN_TEMPLATE_VISIT_OVERFLOW);
    expect(
      await codeOf(
        useCase.apply(
          plan.id,
          { templateId: template.id, toothNumber: '11' },
          DENTIST_ACTOR,
        ),
      ),
    ).toBe(PLAN_TEMPLATE_VISIT_OVERFLOW);
  });

  it('editar la plantilla después no cambia los ítems ya creados', async () => {
    const { plans, templates, useCase } = setup();
    const plan = plans.seedPlan();
    const template = await templates.create(
      { ...ENDO_CROWN, active: true },
      AUDIT_CTX,
    );
    await useCase.apply(
      plan.id,
      { templateId: template.id, toothNumber: '11' },
      DENTIST_ACTOR,
    );
    await templates.update(template.id, {
      lines: [{ ...ENDO_CROWN.lines[0], quantity: 5 }],
      visitIntervals: {},
      expectedVersion: 1,
    });
    expect(
      (await plans.findPlanById(plan.id))?.items.map((i) => i.catalogItemId),
    ).toEqual([ENDO, POST, CROWN]);
  });
});
