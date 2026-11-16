import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PriceSource, ToothSurface } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  CURRENCY_DIGITS_CATALOG,
  type CurrencyDigits,
  type CurrencyDigitsCatalog,
} from '../../../../shared/money/currency-digits';
import { fromCents, toCents } from '../../../../shared/money/money';
import type { TreatmentPlanItem } from '../../domain/entities/treatment-plan-item.entity';
import type { TreatmentPlanWithItems } from '../../domain/entities/treatment-plan.entity';
import {
  TREATMENT_PLAN_REPOSITORY,
  type TemplateItemInput,
  type TreatmentPlanRepository,
} from '../../domain/ports/treatment-plan-repository.port';
import {
  PRICING_SOURCE,
  type PricingSource,
} from '../../domain/ports/pricing-source.port';
import {
  NO_REFERENCE_RATES,
  REFERENCE_RATE_SOURCE,
  type ReferenceRateSource,
} from '../../domain/ports/reference-rate-source.port';
import { memoizedRates, resolveCurrentReference } from '../current-reference';
import { freezeWithRate, withAgreementBase } from './reference-rate';
import { NO_DISCOUNT, type DiscountActor } from './item-discount';
import { PLAN_CURRENCY_CHANGED_MESSAGE } from './add-treatment-plan-item.use-case';
import {
  TREATMENT_PLAN_TEMPLATE_REPOSITORY,
  type TreatmentPlanTemplateRepository,
} from '../../../treatment-plan-templates/domain/ports/treatment-plan-template-repository.port';
import type {
  TreatmentPlanTemplate,
  TreatmentPlanTemplateLine,
} from '../../../treatment-plan-templates/domain/entities/treatment-plan-template.entity';
import {
  mergeIntervals,
  placedVisit,
  placementOverflows,
  planVisitOffset,
  shiftIntervals,
} from '../../../treatment-plan-templates/domain/plan-template-placement';
import {
  inactiveTemplate,
  nothingToApply,
  PLAN_NOT_FOUND_MESSAGE,
  PLAN_TEMPLATE_NOT_FOUND_MESSAGE,
  planNotEditable,
  priceMissing,
  toothRequired,
  unknownLine,
  visitOverflow,
} from '../../../treatment-plan-templates/application/plan-template-errors';
import type { ReferenceSnapshot } from '../../../discounts/domain/reference-in-plan';
import type { CurrentReference } from '../current-reference';

/** D6: por qué una línea de la plantilla no entra en el plan. */
export type TemplateLineSkip = 'CATALOG_ITEM_INACTIVE';

/** Por qué una línea aplicable no tiene precio (la vista previa no falla). */
export type TemplatePriceIssue = 'NO_PRICE' | 'RATE_MISSING';

export interface TemplateLineChoice {
  lineId: string;
  toothNumber?: string;
  surfaces?: ToothSurface[];
}

export interface ApplyPlanTemplateInput {
  templateId: string;
  /** Diente común a todas las líneas (D2). */
  toothNumber?: string;
  /** El diente (y las superficies) de cada línea; gana al común. */
  lines?: TemplateLineChoice[];
}

/** Una línea de la vista previa, con el precio vigente del paciente. */
export interface TemplatePreviewLine {
  lineId: string;
  position: number;
  catalogItemId: string;
  catalogItemLabel: string;
  catalogItemCode: string;
  quantity: number;
  /** Visita de la plantilla. */
  templateVisit: number;
  /** Visita del plan a la que va (desplazada); null si se omite. */
  targetVisit: number | null;
  visitLabel: string | null;
  asksSurfaces: boolean;
  /** Precio unitario en la moneda del plan; null sin precio. */
  unitPrice: number | null;
  priceSource: PriceSource | null;
  agreementName: string | null;
  /** `unitPrice × quantity`; null sin precio. */
  lineTotal: number | null;
  priceMissing: boolean;
  priceIssue: TemplatePriceIssue | null;
  skipped: TemplateLineSkip | null;
}

export interface TemplatePreview {
  planId: string;
  templateId: string;
  templateVersion: number;
  currency: string;
  currencyDigits: CurrencyDigits;
  /** La mayor visita viva del plan (0 si no tiene ítems). */
  visitOffset: number;
  lines: TemplatePreviewLine[];
  /** Los intervalos del plan tal como quedarían. */
  visitIntervals: Record<string, number>;
  /** Ítems que se crearían (líneas aplicables × cantidad). */
  itemCount: number;
  /** Suma de las líneas con precio. */
  total: number;
}

export interface SkippedTemplateLine {
  lineId: string;
  catalogItemId: string;
  catalogItemLabel: string;
  reason: TemplateLineSkip;
}

export interface TemplateApplication {
  createdItems: TreatmentPlanItem[];
  skipped: SkippedTemplateLine[];
}

/** Precio resuelto de una línea aplicable, o por qué no lo hay. */
type LinePrice =
  | {
      ok: true;
      current: CurrentReference;
      reference: ReferenceSnapshot;
      unitPrice: number;
    }
  | { ok: false; issue: TemplatePriceIssue; error?: HttpException }
  | { ok: 'gone' };

const EDITABLE_STATUSES = new Set(['DRAFT', 'PRESENTED']);

/**
 * D7: una plantilla solo entra en un plan en borrador o presentado y sin
 * firma. A diferencia de «añadir ítem», un plan ACEPTADO sin firma tampoco la
 * admite: la plantilla arma un presupuesto, no amplía uno aceptado.
 */
export function assertTemplateApplicable(plan: TreatmentPlanWithItems): void {
  if (!EDITABLE_STATUSES.has(plan.status) || plan.acceptance) {
    throw planNotEditable(plan.status, plan.acceptance !== null);
  }
}

function isApplicable(line: TreatmentPlanTemplateLine): boolean {
  return line.catalogItemActive;
}

/**
 * Vista previa y aplicación de una plantilla de plan (DX-559, D2–D8, D10).
 * Cada línea se resuelve con el MISMO camino que «añadir ítem»
 * (`resolveCurrentReference` → convenio vigente, lista de la sede, catálogo;
 * en la moneda del plan con la tasa congelada), sin descuento (D5). Los
 * precios se resuelven ANTES de la transacción (solo leen, como en el alta de
 * un ítem); el estado del plan, la moneda y el desplazamiento de visitas se
 * vuelven a mirar con el plan bloqueado.
 */
@Injectable()
export class ApplyPlanTemplateUseCase {
  private readonly logger = new Logger(ApplyPlanTemplateUseCase.name);

  constructor(
    @Inject(TREATMENT_PLAN_REPOSITORY)
    private readonly repo: TreatmentPlanRepository,
    @Inject(TREATMENT_PLAN_TEMPLATE_REPOSITORY)
    private readonly templates: TreatmentPlanTemplateRepository,
    @Inject(PRICING_SOURCE)
    private readonly pricing: PricingSource,
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly currencyDigits: CurrencyDigitsCatalog,
    @Optional()
    @Inject(REFERENCE_RATE_SOURCE)
    private readonly rates: ReferenceRateSource = NO_REFERENCE_RATES,
  ) {}

  /** Lo que entraría, con precios y visitas destino. No escribe nada. */
  async preview(
    planId: string,
    templateId: string,
    actor: DiscountActor,
  ): Promise<TemplatePreview> {
    const { plan, template } = await this.load(planId, templateId);
    const offset = planVisitOffset(
      plan.items.map((i) => ({ visit: i.visit ?? 1 })),
    );
    this.assertNoOverflow(template, offset);
    const prices = await this.resolvePrices(plan, template, actor);
    const digits = (await this.currencyDigits.table([plan.currency])).of(
      plan.currency,
    );

    let totalCents = 0;
    let itemCount = 0;
    const lines = template.lines.map((line): TemplatePreviewLine => {
      const price = prices.get(line.id);
      const skipped =
        !isApplicable(line) || price?.ok === 'gone'
          ? 'CATALOG_ITEM_INACTIVE'
          : null;
      const priced = price?.ok === true ? price : null;
      const lineCents =
        priced && !skipped ? toCents(priced.unitPrice) * line.quantity : null;
      if (lineCents !== null) totalCents += lineCents;
      if (!skipped) itemCount += line.quantity;
      return {
        lineId: line.id,
        position: line.position,
        catalogItemId: line.catalogItemId,
        catalogItemLabel: line.catalogItemLabel,
        catalogItemCode: line.catalogItemCode,
        quantity: line.quantity,
        templateVisit: line.visit,
        targetVisit: skipped ? null : placedVisit(line.visit, offset),
        visitLabel: line.visitLabel,
        asksSurfaces: line.asksSurfaces,
        unitPrice: skipped ? null : (priced?.unitPrice ?? null),
        priceSource: skipped ? null : (priced?.current.resolved.source ?? null),
        agreementName: skipped
          ? null
          : (priced?.current.resolved.agreementName ?? null),
        lineTotal: lineCents === null ? null : fromCents(lineCents),
        priceMissing: !skipped && !priced,
        priceIssue:
          !skipped && price && price.ok === false ? price.issue : null,
        skipped,
      };
    });
    return {
      planId,
      templateId: template.id,
      templateVersion: template.version,
      currency: plan.currency,
      currencyDigits: digits,
      visitOffset: offset,
      lines,
      visitIntervals: mergeIntervals(
        plan.visitIntervals ?? {},
        shiftIntervals(template.visitIntervals, offset),
      ),
      itemCount,
      total: fromCents(totalCents),
    };
  }

  /**
   * Crea los N ítems de cada línea aplicable (D3) en sus visitas desplazadas
   * (D4), con el precio vigente y sin descuento (D5), y fusiona los
   * intervalos; todo o nada (D8). Las líneas de procedimientos desactivados
   * se omiten y se devuelven en `skipped` (D6).
   */
  async apply(
    planId: string,
    input: ApplyPlanTemplateInput,
    actor: DiscountActor,
    audit?: AuditRequestContext,
  ): Promise<TemplateApplication> {
    const { plan, template } = await this.load(planId, input.templateId);
    const choices = this.choicesFor(template, input.lines ?? []);

    // D2: el diente antes que los precios (400 barato, sin leer nada más).
    for (const line of template.lines.filter(isApplicable)) {
      const tooth = choices.get(line.id)?.toothNumber ?? input.toothNumber;
      if (!tooth) throw toothRequired(line.id, line.catalogItemLabel);
    }
    const prices = await this.resolvePrices(plan, template, actor);
    const applicable = template.lines.filter(
      (line) => isApplicable(line) && prices.get(line.id)?.ok !== 'gone',
    );
    if (applicable.length === 0) throw nothingToApply();
    for (const line of applicable) {
      const price = prices.get(line.id);
      if (price?.ok === false) {
        throw (
          price.error ??
          priceMissing(line.id, line.catalogItemLabel, plan.currency)
        );
      }
    }
    const skipped = template.lines
      .filter((line) => !applicable.includes(line))
      .map((line): SkippedTemplateLine => ({
        lineId: line.id,
        catalogItemId: line.catalogItemId,
        catalogItemLabel: line.catalogItemLabel,
        reason: 'CATALOG_ITEM_INACTIVE',
      }));

    const createdItems = await this.repo.addTemplateItems(
      planId,
      (locked) => {
        assertTemplateApplicable(locked);
        if (locked.currency !== plan.currency) {
          throw new ConflictException(PLAN_CURRENCY_CHANGED_MESSAGE);
        }
        // El desplazamiento, con los ítems que hay AL ESCRIBIR.
        const offset = planVisitOffset(
          locked.items.map((i) => ({ visit: i.visit ?? 1 })),
        );
        this.assertNoOverflow(template, offset, applicable);
        const items: TemplateItemInput[] = applicable.flatMap((line) => {
          const price = prices.get(line.id);
          if (price?.ok !== true) return [];
          const choice = choices.get(line.id);
          const toothNumber = (choice?.toothNumber ?? input.toothNumber)!;
          const surfaces = line.asksSurfaces ? (choice?.surfaces ?? []) : [];
          const { context, resolved, catalogCurrency } = price.current;
          return Array.from({ length: line.quantity }, () => ({
            toothNumber,
            surfaces,
            catalogItemId: line.catalogItemId,
            catalogPrice: resolved.price,
            pricing: {
              basePrice: resolved.basePrice,
              catalogCurrency,
              priceSource: resolved.source,
              agreementId: resolved.agreementId,
              agreementName: resolved.agreementName,
              pricingLocationId: context.locationId,
              reference: price.reference,
            },
            // D5: el precio es la referencia y el descuento, 0.
            price: price.unitPrice,
            discount: 0,
            createdById: actor.userId,
            ...NO_DISCOUNT,
            visit: placedVisit(line.visit, offset),
            visitLabel: line.visitLabel,
          }));
        });
        const current = locked.visitIntervals ?? {};
        const merged = mergeIntervals(
          current,
          shiftIntervals(template.visitIntervals, offset),
        );
        const changed =
          Object.keys(merged).length !== Object.keys(current).length;
        return { items, visitIntervals: changed ? merged : null };
      },
      audit ? { context: audit, templateId: template.id } : undefined,
    );
    return { createdItems, skipped };
  }

  /** El plan y la plantilla de esta clínica; D7 sobre el plan leído. */
  private async load(
    planId: string,
    templateId: string,
  ): Promise<{
    plan: TreatmentPlanWithItems;
    template: TreatmentPlanTemplate;
  }> {
    const plan = await this.repo.findPlanById(planId);
    if (!plan) throw new NotFoundException(PLAN_NOT_FOUND_MESSAGE);
    const template = await this.templates.findById(templateId);
    if (!template) throw new NotFoundException(PLAN_TEMPLATE_NOT_FOUND_MESSAGE);
    // El problema del plan primero: una plantilla inactiva no lo arregla.
    assertTemplateApplicable(plan);
    if (!template.active) throw inactiveTemplate();
    return { plan, template };
  }

  /** Las elecciones por línea; un `lineId` ajeno a la plantilla, 400. */
  private choicesFor(
    template: TreatmentPlanTemplate,
    choices: TemplateLineChoice[],
  ): Map<string, TemplateLineChoice> {
    const ids = new Set(template.lines.map((l) => l.id));
    const out = new Map<string, TemplateLineChoice>();
    for (const choice of choices) {
      const lineId = choice.lineId.toLowerCase();
      if (!ids.has(lineId)) throw unknownLine(choice.lineId);
      out.set(lineId, { ...choice, lineId });
    }
    return out;
  }

  /** D4: 409 si una visita o un intervalo desplazado pasaría de 1000. */
  private assertNoOverflow(
    template: TreatmentPlanTemplate,
    offset: number,
    lines: readonly TreatmentPlanTemplateLine[] = template.lines.filter(
      isApplicable,
    ),
  ): void {
    if (
      placementOverflows(
        lines.map((l) => l.visit),
        template.visitIntervals,
        offset,
      )
    ) {
      throw visitOverflow();
    }
  }

  /**
   * El precio vigente de cada línea aplicable: una resolución por
   * procedimiento y una tasa por par de monedas en toda la petición. Sin
   * precio o sin tasa, la línea lo dice (la vista previa no falla; aplicar
   * da 422). Un procedimiento que ya no existe (retirado entre la lectura de
   * la plantilla y esta) cuenta como omitido.
   */
  private async resolvePrices(
    plan: TreatmentPlanWithItems,
    template: TreatmentPlanTemplate,
    actor: DiscountActor,
  ): Promise<Map<string, LinePrice>> {
    const rates = memoizedRates(this.rates);
    const byItem = new Map<string, Promise<LinePrice>>();
    const out = new Map<string, LinePrice>();
    for (const line of template.lines.filter(isApplicable)) {
      let price = byItem.get(line.catalogItemId);
      if (!price) {
        price = this.priceOf(plan, line, actor, rates);
        byItem.set(line.catalogItemId, price);
      }
      const resolved = await price;
      out.set(
        line.id,
        resolved.ok === false && resolved.error
          ? { ...resolved, error: withLineId(resolved.error, line.id) }
          : resolved,
      );
    }
    return out;
  }

  private async priceOf(
    plan: TreatmentPlanWithItems,
    line: TreatmentPlanTemplateLine,
    actor: DiscountActor,
    rates: ReferenceRateSource,
  ): Promise<LinePrice> {
    const current = await resolveCurrentReference(
      this.pricing,
      rates,
      plan.patientId,
      line.catalogItemId,
      plan.currency,
    );
    if (!current) return { ok: 'gone' };
    let frozen: ReferenceSnapshot;
    try {
      frozen = freezeWithRate(
        current.priced,
        plan.currency,
        current.asked,
        actor.role,
      );
    } catch (error) {
      if (error instanceof HttpException) {
        return { ok: false, issue: 'RATE_MISSING', error };
      }
      throw error;
    }
    const reference = await withAgreementBase(
      rates,
      current.priced,
      plan.currency,
      frozen,
      (message) => this.logger.warn(message),
    );
    if (reference.referencePriceInPlan === null) {
      return { ok: false, issue: 'NO_PRICE' };
    }
    return {
      ok: true,
      current,
      reference,
      unitPrice: reference.referencePriceInPlan,
    };
  }
}

/** El 422 de «sin tasa» de DX-513-bis con la línea que lo provoca (D5). */
function withLineId(error: HttpException, lineId: string): HttpException {
  const body = error.getResponse();
  return new HttpException(
    typeof body === 'object' ? { ...body, lineId } : { message: body, lineId },
    error.getStatus(),
  );
}
