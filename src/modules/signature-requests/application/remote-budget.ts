import { Inject, Injectable } from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import { DocumentTypeNamesReader } from '../../patients/domain/ports/document-type-names-repository.port';
import type { ClinicDocumentTypeNames } from '../../patients/domain/document-type';
import { composeQuoteContent } from '../../treatment-plans/application/use-cases/plan-quote.use-cases';
import { isQuoteExpired } from '../../treatment-plans/domain/quote-validity';
import {
  computeQuoteHash,
  parseQuoteContent,
  type QuoteContent,
} from '../../treatment-plans/domain/plan-quote';
import type { PlanQuoteSource } from '../../treatment-plans/domain/ports/plan-quote-repository.port';
import type { SignatureRequestRecord } from '../domain/entities/signature-request.entity';
import {
  SIGNATURE_REQUEST_REPOSITORY,
  type SignatureRequestRepository,
} from '../domain/ports/signature-request-repository.port';

/** Lo que una solicitud BUDGET lleva siempre (CHECK signature_requests_budget_check). */
type BudgetRequest = Pick<
  SignatureRequestRecord,
  | 'type'
  | 'treatmentPlanId'
  | 'budgetContent'
  | 'budgetContentHash'
  | 'locationId'
>;

/** La foto enviada, validada; `null` si la solicitud no es de un presupuesto. */
export function sentBudget(request: BudgetRequest): QuoteContent | null {
  if (
    request.type !== 'BUDGET' ||
    !request.treatmentPlanId ||
    !request.budgetContentHash
  ) {
    return null;
  }
  return parseQuoteContent(request.budgetContent);
}

/**
 * ¿Sigue el plan vivo siendo EXACTAMENTE el presupuesto enviado (DX-415)? Se
 * recompone con la validez de la foto, emisión y vencimiento (si no,
 * cambiaría cada día; DX-379: y un enlace enviado antes de guardar la validez
 * en el plan, o con otro ajuste de días, sigue valiendo): su
 * hash coincide con el enviado si y solo si no cambió nada de lo que el
 * presupuesto muestra (ítems, precios, descuentos, convenio, paciente, sede o
 * profesional). Además el plan tiene que seguir «Presentado» y sin aceptar:
 * aceptado, rechazado o cancelado en la clínica, el enlace ya no sirve.
 *
 * DX-379 (C): y el presupuesto enviado no puede haber vencido entre el envío
 * y la firma (`now` posterior a su último día válido en el día de la sede
 * del plan): el paciente ve «Enlace no válido» como en el resto de casos.
 */
export function budgetStillMatches(
  request: BudgetRequest,
  quote: PlanQuoteSource,
  names: ClinicDocumentTypeNames,
  now: Date,
): boolean {
  const sent = sentBudget(request);
  if (
    !sent ||
    quote.plan.id !== request.treatmentPlanId ||
    quote.plan.status !== TreatmentPlanStatus.PRESENTED ||
    quote.acceptance !== null ||
    computeQuoteHash(sent) !== request.budgetContentHash
  ) {
    return false;
  }
  // La zona de la sede de la presentación o, si no tiene una válida, la de
  // la sede desde la que se envió (la ruta pública nunca da 409 de zona).
  if (
    isQuoteExpired(
      sent.validUntil,
      now,
      quote.plan.quoteRegional.timeZone ?? quote.location.timeZone,
    )
  ) {
    return false;
  }
  // DX-502: un enlace v2/v3 (anterior a DX-502) se recompone con la regla de
  // entonces; una foto v1 nunca se envió por enlace (DX-415 es posterior).
  if (sent.version === 1) return false;
  const live = composeQuoteContent(
    quote,
    { issuedOn: sent.issuedOn, validUntil: sent.validUntil },
    names,
    sent.version === 4 ? 'current' : 'legacy',
  );
  return computeQuoteHash(live) === request.budgetContentHash;
}

/**
 * Comprueba el presupuesto de una solicitud BUDGET contra el plan vivo, en la
 * sede desde la que se envió (la ruta pública no trae sede). Las solicitudes
 * de consentimiento siempre pasan.
 */
@Injectable()
export class RemoteBudgetCheck {
  constructor(
    @Inject(SIGNATURE_REQUEST_REPOSITORY)
    private readonly repo: SignatureRequestRepository,
    private readonly documentTypeNames: DocumentTypeNamesReader,
  ) {}

  async isStillValid(
    request: SignatureRequestRecord,
    now: Date,
  ): Promise<boolean> {
    if (request.type !== 'BUDGET') return true;
    if (!request.treatmentPlanId) return false;
    const [budget, names] = await Promise.all([
      this.repo.loadBudget(
        request.patientId,
        request.treatmentPlanId,
        request.locationId,
      ),
      // DX-524: la sede desde la que se envió.
      this.documentTypeNames.get(request.locationId),
    ]);
    return (
      budget !== null && budgetStillMatches(request, budget.quote, names, now)
    );
  }

  /**
   * DX-502: la moneda del catálogo de cada ítem del plan vivo, para mostrar
   * la de un enlace v2/v3 (que no la guardó). Vacío si no es un presupuesto
   * anterior a DX-502: una foto v4 ya la lleva y no se lee nada.
   */
  async listPriceCurrencies(
    request: SignatureRequestRecord,
  ): Promise<{ id: string; listPriceCurrency: string | null }[]> {
    const sent = sentBudget(request);
    if (!sent || sent.version === 4 || !request.treatmentPlanId) return [];
    const budget = await this.repo.loadBudget(
      request.patientId,
      request.treatmentPlanId,
      request.locationId,
    );
    return (
      budget?.quote.items.map((i) => ({
        id: i.id,
        listPriceCurrency: i.listPriceCurrency,
      })) ?? []
    );
  }

  /**
   * La comprobación para repetirla dentro de la transacción de la firma, con
   * el plan bloqueado (los nombres de documento se leen antes: son de la
   * clínica, no del plan).
   */
  async matcher(
    request: BudgetRequest,
    now: Date,
  ): Promise<(quote: PlanQuoteSource) => boolean> {
    const names = await this.documentTypeNames.get(request.locationId);
    return (quote) => budgetStillMatches(request, quote, names, now);
  }
}
