import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  SignatureRequestChannel,
  SignatureRequestType,
  TreatmentPlanStatus,
} from '@prisma/client';
import {
  composeQuoteContent,
  firstIssueValidity,
  PLAN_QUOTE_COMPOSITION,
  quoteSourceExpiry,
  quoteValidityOf,
} from '../../treatment-plans/application/use-cases/plan-quote.use-cases';
import {
  computeQuoteHash,
  type QuoteComposition,
} from '../../treatment-plans/domain/plan-quote';
import type { QuoteValidity } from '../../treatment-plans/domain/quote-validity';
import {
  documentText,
  documentTypeName,
  type ClinicDocumentTypeNames,
} from '../../patients/domain/document-type';
import { DocumentTypeNamesReader } from '../../patients/domain/ports/document-type-names-repository.port';
import { maskEmail } from '../../../shared/privacy/mask-email';
import { civilDateIn } from '../../../shared/time/civil-day';
import {
  SIGNATURE_REQUEST_REPOSITORY,
  type CreateSignatureRequestRepoInput,
  type SignatureRecipientContext,
  type SignatureRequestRepository,
} from '../domain/ports/signature-request-repository.port';
import { resolveSignatureRecipient } from '../domain/signature-recipient';
import {
  generateSignatureToken,
  hashSignatureToken,
  signatureLinkExpiry,
  SIGNATURE_PUBLIC_PATH,
} from '../domain/signature-token';
import {
  BUDGET_ACCEPTANCE_TERMS,
  BUDGET_REQUEST_TITLE,
} from './use-cases/signature-requests.use-cases';
import {
  BUDGET_SECOND_CURRENCY_SOURCE,
  composeBudgetPresentation,
  NO_SECOND_CURRENCY,
  type BudgetSecondCurrencySource,
} from './budget-presentation';

/** Una opción lista para su solicitud de firma (sin el id: lo pone quien llama). */
export interface FollowUpBudgetOption {
  planId: string;
  /** La fila de `signature_requests` (origin FOLLOW_UP, sin usuario). */
  request: Omit<CreateSignatureRequestRepoInput, 'createdById'>;
  /** Texto plano: viaja SOLO en el email, nunca se guarda ni se registra. */
  url: string;
  /** DX-379 (M-3): validez que fija la primera emisión, si el plan no la tenía. */
  planQuoteValidity: QuoteValidity | null;
}

export type FollowUpBudgetRecipient =
  | {
      ok: true;
      email: string;
      destinationMasked: string;
      greetingName: string;
      patientFirstName: string | null;
      minor: boolean;
    }
  | { ok: false };

export type FollowUpBudgetLinksResult =
  | {
      ok: true;
      recipient: Extract<FollowUpBudgetRecipient, { ok: true }>;
      options: FollowUpBudgetOption[];
      clinicName: string;
    }
  | { ok: false; reason: 'NO_EMAIL' | 'NOT_SENDABLE' };

function responsibleDocument(
  doc: SignatureRecipientContext['responsibles'][number]['document'],
  names: ClinicDocumentTypeNames,
): string | null {
  if (!doc.docNumber) return null;
  return doc.docType
    ? documentText(
        documentTypeName(doc.docType, doc.docTypeLabel, names),
        doc.docNumber,
      )
    : doc.docNumber;
}

/**
 * DX-561: las solicitudes de aceptación a distancia (DX-415) que lleva un aviso
 * del seguimiento automático, una por opción PRESENTED del grupo. La misma
 * foto, hash, condiciones, destinatario (`resolveSignatureRecipient`: en un
 * menor, solo su responsable) y caducidad que un envío de la clínica; la sede
 * es la de la presentación y el profesional, el que elaboró el plan (lo
 * valida quien llama). No escribe nada: la transacción del aviso las guarda.
 */
@Injectable()
export class FollowUpBudgetLinks {
  constructor(
    @Inject(SIGNATURE_REQUEST_REPOSITORY)
    private readonly repo: SignatureRequestRepository,
    private readonly documentTypeNames: DocumentTypeNamesReader,
    @Inject(PLAN_QUOTE_COMPOSITION)
    private readonly composition: QuoteComposition,
    // DX-560: la segunda moneda de la sede y su tasa guardada (nunca el
    // proveedor); sin ella (tests), sin segunda moneda.
    @Optional()
    @Inject(BUDGET_SECOND_CURRENCY_SOURCE)
    private readonly secondCurrency: BudgetSecondCurrencySource = NO_SECOND_CURRENCY,
  ) {}

  async prepare(input: {
    patientId: string;
    locationId: string;
    /** Opción → su profesional (validado por quien llama). */
    options: { planId: string; professionalUserId: string }[];
    linkBase: string;
    now: Date;
  }): Promise<FollowUpBudgetLinksResult> {
    const { patientId, locationId, now } = input;
    const ctx = await this.repo.loadRecipientContext(patientId);
    if (!ctx) return { ok: false, reason: 'NOT_SENDABLE' };
    const names = await this.documentTypeNames.get(locationId);
    const expiresAt = signatureLinkExpiry(now);
    const options: FollowUpBudgetOption[] = [];
    let signer: Extract<
      ReturnType<typeof resolveSignatureRecipient>,
      { ok: true }
    > | null = null;
    let clinicName = '';
    for (const option of input.options) {
      const budget = await this.repo.loadBudget(
        patientId,
        option.planId,
        locationId,
      );
      if (!budget) return { ok: false, reason: 'NOT_SENDABLE' };
      const { quote } = budget;
      if (
        quote.plan.status !== TreatmentPlanStatus.PRESENTED ||
        quote.acceptance ||
        quote.items.length === 0 ||
        quoteSourceExpiry(quote, now).expired
      ) {
        return { ok: false, reason: 'NOT_SENDABLE' };
      }
      const firstIssue = firstIssueValidity(quote, now);
      const content = composeQuoteContent(
        quote,
        firstIssue ?? quoteValidityOf(quote, now),
        names,
        this.composition,
      );
      clinicName = content.clinicName;
      // El destinatario, con el documento del paciente tal como lo pinta el
      // presupuesto (el mismo en todas las opciones).
      if (!signer) {
        const decided = resolveSignatureRecipient({
          patient: { ...ctx.patient, document: content.patient.document },
          responsibles: ctx.responsibles.map((r) => ({
            ...r,
            documentText: responsibleDocument(r.document, names),
          })),
          majorityAge: ctx.majorityAge,
          today: civilDateIn(now, ctx.timeZone),
          timeZone: ctx.timeZone,
          majorityReview: ctx.majorityReview,
        });
        if (!decided.ok) return { ok: false, reason: 'NO_EMAIL' };
        signer = decided;
      }
      // DX-560: la misma presentación congelada que un envío de la clínica.
      const presentation = await composeBudgetPresentation(
        quote,
        content,
        this.secondCurrency,
        now,
      );
      const token = generateSignatureToken();
      options.push({
        planId: option.planId,
        url: `${input.linkBase}${SIGNATURE_PUBLIC_PATH}/${token}`,
        planQuoteValidity: firstIssue,
        request: {
          locationId: quote.location.id,
          patientId,
          type: SignatureRequestType.BUDGET,
          channel: SignatureRequestChannel.EMAIL,
          templateId: null,
          templateVersion: null,
          treatmentPlanId: quote.plan.id,
          title: BUDGET_REQUEST_TITLE,
          body: BUDGET_ACCEPTANCE_TERMS,
          budgetContent: content,
          budgetContentHash: computeQuoteHash(content),
          budgetPresentation: presentation,
          professionalUserId: option.professionalUserId,
          professionalName: (
            content.professionalName ?? content.clinicName
          ).slice(0, 200),
          signerType: signer.signerType,
          signerName: signer.signerName,
          signerDocument: signer.signerDocument,
          destination: signer.email,
          destinationMasked: maskEmail(signer.email),
          tokenHash: hashSignatureToken(token),
          expiresAt,
          createdAt: now,
        },
      });
    }
    if (!signer || options.length === 0) {
      return { ok: false, reason: 'NOT_SENDABLE' };
    }
    return {
      ok: true,
      recipient: {
        ok: true,
        email: signer.email,
        destinationMasked: maskEmail(signer.email),
        greetingName: signer.greetingName,
        patientFirstName: signer.patientFirstName,
        minor: signer.minor,
      },
      options,
      clinicName,
    };
  }
}
