import { Inject, Injectable } from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import { DocumentTypeNamesReader } from '../../patients/domain/ports/document-type-names-repository.port';
import type { ClinicDocumentTypeNames } from '../../patients/domain/document-type';
import { composeQuoteContent } from '../../treatment-plans/application/use-cases/plan-quote.use-cases';
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
  'type' | 'treatmentPlanId' | 'budgetContent' | 'budgetContentHash'
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
 * recompone con el día de emisión de la foto (si no, cambiaría cada día): su
 * hash coincide con el enviado si y solo si no cambió nada de lo que el
 * presupuesto muestra (ítems, precios, descuentos, convenio, paciente, sede o
 * profesional). Además el plan tiene que seguir «Presentado» y sin aceptar:
 * aceptado, rechazado o cancelado en la clínica, el enlace ya no sirve.
 */
export function budgetStillMatches(
  request: BudgetRequest,
  quote: PlanQuoteSource,
  names: ClinicDocumentTypeNames,
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
  const live = composeQuoteContent(quote, sent.issuedOn, names);
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

  async isStillValid(request: SignatureRequestRecord): Promise<boolean> {
    if (request.type !== 'BUDGET') return true;
    if (!request.treatmentPlanId) return false;
    const [budget, names] = await Promise.all([
      this.repo.loadBudget(
        request.patientId,
        request.treatmentPlanId,
        request.locationId,
      ),
      this.documentTypeNames.get(),
    ]);
    return budget !== null && budgetStillMatches(request, budget.quote, names);
  }

  /**
   * La comprobación para repetirla dentro de la transacción de la firma, con
   * el plan bloqueado (los nombres de documento se leen antes: son de la
   * clínica, no del plan).
   */
  async matcher(
    request: BudgetRequest,
  ): Promise<(quote: PlanQuoteSource) => boolean> {
    const names = await this.documentTypeNames.get();
    return (quote) => budgetStillMatches(request, quote, names);
  }
}
