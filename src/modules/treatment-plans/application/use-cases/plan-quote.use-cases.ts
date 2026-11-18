import type { DocumentRegionalDto } from '../../../../shared/locations/document-regional.dto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ClinicRole,
  ExpiredQuoteAcceptanceMode,
  TreatmentPlanStatus,
} from '@prisma/client';
import {
  EXPIRED_NOT_EXPIRED_MESSAGE,
  ExpiredAcceptanceInputError,
  NO_EXPIRED_ACCEPTANCE,
  parseExpiredAcceptance,
  quoteExpiredAcceptMessage,
  type ExpiredAcceptanceChoice,
  type ExpiredAcceptanceInput,
  type ExpiredAcceptanceRecord,
} from '../../domain/expired-quote-acceptance';
import { locationTimeZoneRequired } from '../../../../shared/locations/location-time-zone';
import { requireLocationFormat } from '../../../../shared/locations/location-regional';
import type { Repricing } from '../repricing';
import { AcceptanceRepricer } from './plan-repricing.use-cases';
import { quoteExpiredConflict } from '../quote-expiry';
import {
  buildQuoteContent,
  computeAcceptanceHash,
  computeQuoteHash,
  parseQuoteContent,
  withListPriceCurrencies,
  type QuoteComposition,
  type QuoteContent,
  type QuoteItem,
  type QuoteTotal,
} from '../../domain/plan-quote';
import { acceptPlanError } from '../../domain/plan-status-machine';
import {
  PartialAcceptanceError,
  decidePartial,
  splitTotals,
  type PartialPlanState,
  type PartialSplit,
} from '../../domain/partial-acceptance';
import {
  isQuoteExpired,
  issueQuoteValidity,
  quoteCanExpire,
  storedQuoteValidity,
  validityOnFirstIssue,
  type QuoteValidity,
} from '../../domain/quote-validity';
import {
  PLAN_QUOTE_REPOSITORY,
  type AcceptInstallments,
  type AcceptPartial,
  type AcceptReprice,
  type NewPlanAcceptance,
  type PlanQuoteRepository,
  type PlanAcceptanceRemoteEvidence,
  type PlanAcceptancePortalEvidence,
  type PlanPresentation,
  type PlanQuoteSource,
} from '../../domain/ports/plan-quote-repository.port';
import {
  parseSignaturePng,
  SignatureImageError,
} from '../../../consents/domain/signature-image';
import {
  documentText,
  documentTypeName,
  type ClinicDocumentTypeNames,
} from '../../../patients/domain/document-type';
import { DocumentTypeNamesReader } from '../../../patients/domain/ports/document-type-names-repository.port';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import {
  parseInstallmentTerms,
  planInstallmentSchedule,
  type InstallmentTerms,
  type InstallmentTermsInput,
} from '../../../payment-plans/application/schedule/installment-schedule';
import { PLAN_CURRENCY_NOT_IN_CATALOG_MESSAGE } from '../../../payment-plans/application/use-cases/create-payment-plan.use-case';
import {
  CURRENCY_DIGITS_CATALOG,
  type CurrencyDigitsCatalog,
} from '../../../../shared/money/currency-digits';
import { toCents } from '../../../../shared/money/money';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { CLINIC_LANGUAGE } from '../../../../shared/i18n/patient-language';

export type PlanQuoteClock = () => Date;
export const PLAN_QUOTE_CLOCK = Symbol('PLAN_QUOTE_CLOCK');
/**
 * DX-502: cómo se componen los presupuestos nuevos (`PLAN_QUOTE_COMPOSE_V4`):
 * `current` (v4, por defecto) o `legacy` (v2/v3, como antes de DX-502). Leer y
 * verificar fotos v1–v4 no depende de esto.
 */
export const PLAN_QUOTE_COMPOSITION = Symbol('PLAN_QUOTE_COMPOSITION');

export const PLAN_NOT_FOUND_MESSAGE = 'Plan de tratamiento no encontrado';
export const PLAN_ACCEPTED_CONFLICT_MESSAGE =
  'El plan ya fue aceptado y firmado: no se puede volver a firmar.';
export const QUOTE_CHANGED_MESSAGE =
  'El presupuesto cambió desde que se mostró: revísalo de nuevo con el paciente antes de firmar.';
const SIGNER_NAME_MAX = 200;

/** La aceptación como la ve la vista imprimible. */
export interface PlanQuoteAcceptanceView {
  signerName: string;
  /** PNG en base64, sin prefijo `data:`. */
  signature: string;
  acceptedAt: Date;
  acceptedByName: string;
  acceptanceHash: string;
  /** `true` si la foto y la firma guardadas coinciden con sus hashes. */
  integrityOk: boolean;
  /** DX-415: aceptado a distancia por enlace con código (evidencias). */
  remote: PlanAcceptanceRemoteEvidence | null;
  /** DX-101-bis: aceptado por el paciente desde su portal. */
  portal: PlanAcceptancePortalEvidence | null;
  ipAddress: string | null;
  userAgent: string | null;
  /**
   * DX-379 (C): copia del último día válido del presupuesto al firmar (antes
   * de recotizar); null en aceptaciones anteriores o sin validez guardada.
   */
  quoteValidUntil: string | null;
  /** Cómo se aceptó un presupuesto vencido; null si no lo estaba. */
  expiredMode: ExpiredAcceptanceRecord['mode'];
  expiredReason: ExpiredAcceptanceRecord['reason'];
  expiredNote: string | null;
  /** La recotización hecha en la firma (REPRICE). */
  repricingId: string | null;
  /**
   * DX-417: aceptación PARCIAL. El plan pendiente con los ítems no
   * aceptados, sus ids y su total al firmar; null si se aceptó entero.
   */
  pendingPlanId: string | null;
  pendingItemIds: string[] | null;
  pendingTotal: number | null;
}

/** DX-041: códigos y textos de la aceptación con cuotas. */
export const INSTALLMENT_SIMULATION_STALE = 'INSTALLMENT_SIMULATION_STALE';
export const INSTALLMENT_SIMULATION_STALE_MESSAGE =
  'El saldo a financiar cambió desde la simulación: vuelve a simular las cuotas con el paciente antes de firmar.';
export const INSTALLMENTS_WITH_PARTIAL_MESSAGE =
  'Las cuotas se eligen al aceptar el presupuesto entero: acepta esta parte y crea el plan de cuotas después.';

/** El presupuesto para verlo o imprimirlo. */
export interface PlanQuoteDocument extends QuoteContent {
  visitOrganization?: PlanQuoteSource['visitOrganization'];
  /**
   * DX-560: el texto para el paciente de cada ítem en su idioma, fuera del
   * contenido sellado (no cambia el hash ni la versión).
   */
  presentation: PlanPresentation;
  planStatus: TreatmentPlanStatus;
  clinicLogoUrl: string | null;
  /** DX-354: región de la sede del documento; fuera del contenido firmado. */
  regional: DocumentRegionalDto | null;
  contentHash: string;
  acceptance: PlanQuoteAcceptanceView | null;
}

/** DX-041: lo que devuelve aceptar: el presupuesto firmado y su plan de cuotas. */
export interface AcceptedPlanQuote extends PlanQuoteDocument {
  /** El plan de cuotas creado en la aceptación; null si se aceptó sin él. */
  paymentPlanId: string | null;
}

export interface AcceptTreatmentPlanInput {
  signerName: string;
  /** `data:image/png;base64,…` o base64 pelado. */
  signature: string;
  /**
   * El `contentHash` del presupuesto que se mostró al paciente. DX-379 (C):
   * con REPRICE, el del presupuesto recotizado de la vista previa.
   */
  contentHash: string;
  /** DX-379 (C): cómo aceptar un presupuesto vencido (solo si lo está). */
  expired?: ExpiredAcceptanceInput;
  /**
   * DX-417: aceptar solo estos ítems; los demás pasan a un plan pendiente.
   * El `contentHash` es entonces el del presupuesto de lo aceptado (vista
   * previa de la aceptación parcial).
   */
  partial?: { itemIds: string[] };
  /**
   * DX-041: aceptar con el plan de cuotas de un escenario simulado (POST
   * /treatment-plans/:id/installment-simulation). `totalToFinance` es el
   * saldo que mostró la simulación: si al aceptar es otro, 409
   * `INSTALLMENT_SIMULATION_STALE` y no se acepta.
   */
  installmentPlan?: InstallmentTermsInput & { totalToFinance: number };
}

/** Lo que pone el servidor, nunca el cliente. */
export interface AcceptTreatmentPlanMeta {
  acceptedById: string;
  /** Rol de quien firma (del token): topes de descuento al recotizar. */
  role: ClinicRole;
  ipAddress: string | null;
  userAgent: string | null;
  /**
   * DX-417 (ronda 1, M-7): quién y desde dónde, para el evento propio del
   * alta del plan pendiente de una aceptación parcial.
   */
  audit?: AuditRequestContext;
}

/**
 * DX-379: la validez del presupuesto del plan. La guardada al presentarlo o
 * al imprimirlo por primera vez; sin ella (plan anterior a DX-379 o borrador
 * nunca impreso), emitido hoy en la zona de la sede con los días del ajuste
 * de la clínica, como hasta ahora.
 */
export function quoteValidityOf(
  source: PlanQuoteSource,
  now: Date,
): QuoteValidity {
  return (
    storedQuoteValidity(source.plan) ??
    issueQuoteValidity(
      now,
      source.location.timeZone,
      source.clinic.quoteValidityDays,
    )
  );
}

/**
 * DX-379 (D-2): la validez que fija emitir el presupuesto por primera vez
 * (imprimirlo o enviarlo a firmar a distancia), o `null` si no se guarda
 * nada. La regla es la del dominio (`validityOnFirstIssue`).
 */
export function firstIssueValidity(
  source: PlanQuoteSource,
  now: Date,
): QuoteValidity | null {
  return validityOnFirstIssue(
    {
      status: source.plan.status,
      signed: source.acceptance !== null,
      itemCount: source.items.length,
      quoteIssuedOn: source.plan.quoteIssuedOn,
      quoteValidUntil: source.plan.quoteValidUntil,
    },
    now,
    source.location.timeZone,
    source.clinic.quoteValidityDays,
  );
}

/** ¿Venció el presupuesto del plan leído? Y su último día válido. */
export interface QuoteSourceExpiry {
  expired: boolean;
  validUntil: string | null;
}

/**
 * DX-379 (C): ¿venció el presupuesto? Con el día civil de la sede del plan
 * (`quoteRegional`: la de la presentación o, sin presentar, la del
 * presupuesto), la misma regla que `quoteExpired` de la API (D-13). Solo un
 * borrador o un plan presentado, sin firmar y con validez guardada puede
 * estar vencido. Si la sede de la presentación no tiene zona válida, 409
 * `LOCATION_TIMEZONE_REQUIRED` (nunca se decide con otra zona).
 */
export function quoteSourceExpiry(
  source: PlanQuoteSource,
  now: Date,
): QuoteSourceExpiry {
  const validUntil = source.plan.quoteValidUntil;
  if (
    validUntil === null ||
    source.acceptance !== null ||
    !quoteCanExpire(source.plan.status)
  ) {
    return { expired: false, validUntil };
  }
  const { timeZone, locationId } = source.plan.quoteRegional;
  if (timeZone === null) throw locationTimeZoneRequired(locationId);
  return { expired: isQuoteExpired(validUntil, now, timeZone), validUntil };
}

/**
 * Un día `YYYY-MM-DD` con el formato de la sede del vencimiento (la de la
 * presentación del plan), la misma en las tres vías de aceptación.
 */
export function quoteDayText(source: PlanQuoteSource, day: string): string {
  const { locationId, locale, hourCycle } = source.plan.quoteRegional;
  return requireLocationFormat({ id: locationId, locale, hourCycle }).civilDate(
    day,
  );
}

/**
 * El presupuesto VIVO del plan, con su validez (DX-379) y el nombre visible
 * de hoy del documento (DX-327, R17). Al aceptar se congela este texto (R18).
 */
function liveContent(
  source: PlanQuoteSource,
  now: Date,
  names: ClinicDocumentTypeNames,
  composition: QuoteComposition,
): QuoteContent {
  return composeQuoteContent(
    source,
    quoteValidityOf(source, now),
    names,
    composition,
  );
}

/**
 * El presupuesto del plan tal como está AHORA, con la validez `validity`.
 * DX-415: con las fechas y la composición de la foto enviada, su hash es el
 * de la foto si y solo si nada del presupuesto cambió (ítems, precios,
 * convenio, paciente, sede, profesional). DX-502: un enlace v2/v3 enviado
 * antes del despliegue se recompone con la regla de entonces y sigue valiendo.
 */
export function composeQuoteContent(
  source: PlanQuoteSource,
  validity: QuoteValidity,
  names: ClinicDocumentTypeNames,
  composition: QuoteComposition = 'current',
): QuoteContent {
  const { patient } = source;
  return buildQuoteContent(
    {
      planId: source.plan.id,
      patientId: source.plan.patientId,
      currency: source.plan.currency,
      clinicName: source.clinic.name,
      clinicFiscal: source.clinic.fiscal,
      location: {
        id: source.location.id,
        name: source.location.name,
        address: source.location.address,
      },
      patient: {
        name: `${patient.firstName} ${patient.lastName}`.trim(),
        document: documentText(
          documentTypeName(patient.docType, patient.docTypeLabel, names),
          patient.docNumber,
        ),
      },
      professionalName: source.professionalName,
      items: source.items,
    },
    validity,
    composition,
  );
}

/**
 * DX-560: la presentación al paciente del plan leído. Sin ella (una lectura
 * que no la compone), el nombre de cada ítem del presupuesto en español.
 * En un plan ACEPTADO sale del catálogo de HOY, no de la foto firmada:
 * congelar los textos en la aceptación queda fuera de alcance (la foto
 * firmada sigue siendo `items[].procedure`).
 */
export function planPresentationOf(source: PlanQuoteSource): PlanPresentation {
  if (source.presentation) return source.presentation;
  const visits = new Map(
    (source.visitOrganization ?? []).map((v) => [v.itemId, v.visit]),
  );
  return {
    language: CLINIC_LANGUAGE,
    items: source.items.map((i) => ({
      itemId: i.id,
      visit: visits.get(i.id) ?? 1,
      label: i.procedure,
      language: CLINIC_LANGUAGE,
    })),
  };
}

/**
 * Un plan aceptado se imprime con la FOTO firmada (lo que vio y firmó el
 * paciente), nunca con el plan vivo; `integrityOk` recalcula los dos hashes.
 * DX-502: una foto v4 lleva la moneda de cada precio de lista; a una v1/v2/v3
 * se le completa con la congelada en sus ítems, sin tocar lo sellado.
 * DX-019-bis (B): el logo, el congelado al firmar (fuera de la foto y de sus
 * hashes); sin firmar, el de hoy, como los datos fiscales.
 */
function toDocument(
  source: PlanQuoteSource,
  now: Date,
  names: ClinicDocumentTypeNames,
  composition: QuoteComposition,
): PlanQuoteDocument {
  const base = {
    visitOrganization:
      source.visitOrganization ??
      source.items.map((i) => ({
        itemId: i.id,
        visit: 1,
        label: null,
        minDaysAfterPrevious: 0,
      })),
    presentation: planPresentationOf(source),
    planStatus: source.plan.status,
    regional: source.regional,
  };
  const stored = source.acceptance;
  if (!stored) {
    // Compuesto como v2/v3 (`legacy`), la moneda de cada precio de lista se
    // completa para mostrarla con la congelada en el ítem: no está sellada en
    // esas versiones, así que el hash no cambia.
    const content = withListPriceCurrencies(
      liveContent(source, now, names, composition),
      source.items,
    );
    return {
      ...content,
      ...base,
      clinicLogoUrl: source.clinic.logoUrl,
      contentHash: computeQuoteHash(content),
      acceptance: null,
    };
  }
  const content = withListPriceCurrencies(
    parseQuoteContent(stored.content),
    source.items,
  );
  const integrityOk =
    computeQuoteHash(content) === stored.contentHash &&
    computeAcceptanceHash({
      contentHash: stored.contentHash,
      signerName: stored.signerName,
      signature: stored.signature,
      acceptedAt: stored.acceptedAt,
    }) === stored.acceptanceHash;
  return {
    ...content,
    ...base,
    // DX-019-bis (B): el logo congelado al firmar; `null`, sin logo.
    clinicLogoUrl: stored.clinicLogoUrl,
    contentHash: stored.contentHash,
    acceptance: {
      signerName: stored.signerName,
      signature: stored.signature,
      acceptedAt: stored.acceptedAt,
      acceptedByName: stored.acceptedByName,
      acceptanceHash: stored.acceptanceHash,
      integrityOk,
      remote: stored.remote,
      portal: stored.portal,
      ipAddress: stored.ipAddress,
      userAgent: stored.userAgent,
      quoteValidUntil: stored.expiry.quoteValidUntil,
      expiredMode: stored.expiry.mode,
      expiredReason: stored.expiry.reason,
      expiredNote: stored.expiry.note,
      repricingId: stored.expiry.repricingId,
      pendingPlanId: stored.partial?.pendingPlanId ?? null,
      pendingItemIds: stored.partial?.pendingItemIds ?? null,
      pendingTotal: stored.partial?.pendingTotal ?? null,
    },
  };
}

/** DX-417: el presupuesto con solo los ítems `itemIds` (en su orden). */
function sourceWithItems(
  source: PlanQuoteSource,
  itemIds: readonly string[],
): PlanQuoteSource {
  const keep = new Set(itemIds);
  return {
    ...source,
    items: source.items.filter((i) => keep.has(i.id)),
    visitOrganization: source.visitOrganization?.filter((v) =>
      keep.has(v.itemId),
    ),
    presentation: source.presentation && {
      ...source.presentation,
      items: source.presentation.items.filter((i) => keep.has(i.itemId)),
    },
  };
}

/** DX-417: la regla de la partición como error HTTP (con `code` si lo tiene). */
function partialHttpError(error: PartialAcceptanceError): HttpException {
  if (error.kind === 'NOT_FOUND') return new NotFoundException(error.message);
  if (error.kind === 'BAD_REQUEST') {
    return new BadRequestException(error.message);
  }
  return new ConflictException(
    error.code
      ? {
          statusCode: 409,
          error: 'Conflict',
          code: error.code,
          message: error.message,
        }
      : error.message,
  );
}

/** DX-417: `decidePartial` con sus errores en HTTP. */
function decidePartialOrThrow(
  state: PartialPlanState,
  itemIds: readonly string[],
): PartialSplit {
  try {
    return decidePartial(state, itemIds);
  } catch (error) {
    if (error instanceof PartialAcceptanceError) {
      throw partialHttpError(error);
    }
    throw error;
  }
}

@Injectable()
export class GetPlanQuoteUseCase {
  constructor(
    @Inject(PLAN_QUOTE_REPOSITORY)
    private readonly repo: PlanQuoteRepository,
    @Inject(PLAN_QUOTE_CLOCK)
    private readonly now: PlanQuoteClock,
    private readonly documentTypeNames: DocumentTypeNamesReader,
    @Optional()
    @Inject(PLAN_QUOTE_COMPOSITION)
    private readonly composition: QuoteComposition = 'current',
  ) {}

  /** El presupuesto imprimible; 404 si el plan no es de este paciente/clínica. */
  async execute(patientId: string, planId: string): Promise<PlanQuoteDocument> {
    const source = await this.repo.loadSource(patientId, planId);
    if (!source) {
      throw new NotFoundException(PLAN_NOT_FOUND_MESSAGE);
    }
    // Un plan aceptado se imprime con su foto: los nombres de la clínica solo
    // hacen falta para componer el presupuesto vivo.
    // DX-524: con el nombre de la sede del plan.
    const names = source.acceptance
      ? {}
      : await this.documentTypeNames.get(source.location.id);
    return toDocument(source, this.now(), names, this.composition);
  }
}

/**
 * DX-379 (D-2): imprimir el presupuesto. La primera impresión de un plan en
 * borrador o presentado, sin firmar, con ítems y sin fechas guardadas, fija
 * su validez
 * (hoy en la zona de la sede + los días del ajuste); las siguientes, otro día
 * o con otro ajuste, imprimen las mismas fechas. Idempotente: devuelve lo
 * mismo que el GET, que sigue siendo de solo lectura (lo usa también el modal
 * de aceptar para mostrar el resumen).
 */
@Injectable()
export class IssuePlanQuoteUseCase {
  constructor(
    @Inject(PLAN_QUOTE_REPOSITORY)
    private readonly repo: PlanQuoteRepository,
    @Inject(PLAN_QUOTE_CLOCK)
    private readonly now: PlanQuoteClock,
    private readonly documentTypeNames: DocumentTypeNamesReader,
    @Optional()
    @Inject(PLAN_QUOTE_COMPOSITION)
    private readonly composition: QuoteComposition = 'current',
  ) {}

  async execute(patientId: string, planId: string): Promise<PlanQuoteDocument> {
    const now = this.now();
    const source = await this.repo.issue(patientId, planId, (current) =>
      firstIssueValidity(current, now),
    );
    if (!source) {
      throw new NotFoundException(PLAN_NOT_FOUND_MESSAGE);
    }
    const names = source.acceptance
      ? {}
      : await this.documentTypeNames.get(source.location.id);
    return toDocument(source, now, names, this.composition);
  }
}

function parseSignature(value: string): string {
  try {
    return parseSignaturePng(value, 'la firma del paciente');
  } catch (error) {
    if (error instanceof SignatureImageError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}

/** 400 con el texto de una elección incoherente (motivo, nota, huella). */
function parseExpiredChoice(
  input: ExpiredAcceptanceInput | undefined,
): ExpiredAcceptanceChoice | null {
  if (!input) return null;
  try {
    return parseExpiredAcceptance(input);
  } catch (error) {
    if (error instanceof ExpiredAcceptanceInputError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}

/**
 * Se puede firmar el presupuesto leído (con el plan bloqueado): sin firmar,
 * en un estado que admite aceptar y con ítems.
 */
function assertSignable(source: PlanQuoteSource): void {
  if (source.acceptance) {
    throw new ConflictException(PLAN_ACCEPTED_CONFLICT_MESSAGE);
  }
  // Máquina de estados (DX-040): se firma un borrador o un plan presentado, y
  // también uno ya aceptado sin firma (DX-012). Rechazado, completado o
  // cancelado: 409.
  const transitionError = acceptPlanError(source.plan.status, {
    allowAlreadyAccepted: true,
  });
  if (transitionError) throw new ConflictException(transitionError);
  if (source.items.length === 0) {
    throw new BadRequestException(
      'El plan no tiene ítems: agrega al menos un procedimiento antes de aceptarlo.',
    );
  }
}

@Injectable()
export class AcceptTreatmentPlanUseCase {
  constructor(
    @Inject(PLAN_QUOTE_REPOSITORY)
    private readonly repo: PlanQuoteRepository,
    @Inject(PLAN_QUOTE_CLOCK)
    private readonly now: PlanQuoteClock,
    private readonly documentTypeNames: DocumentTypeNamesReader,
    @Optional()
    @Inject(PLAN_QUOTE_COMPOSITION)
    private readonly composition: QuoteComposition = 'current',
    @Optional()
    private readonly repricer?: AcceptanceRepricer,
    @Optional()
    private readonly audit?: RecordAuditEventUseCase,
    // DX-041: las cuotas se reparten en unidades de la moneda del plan.
    @Optional()
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly currencyDigits?: CurrencyDigitsCatalog,
  ) {}

  /**
   * Aceptar = firmar la foto del presupuesto. Se recompone el presupuesto con
   * el plan bloqueado y su hash tiene que ser el que se mostró: si algo cambió
   * entre medias (un ítem, un precio o, sin validez guardada, el día), 409 y
   * no se firma. DX-379: con la validez guardada se firman sus fechas. Firma,
   * hora (del servidor) y autor (del token) quedan sellados con un segundo
   * hash. El plan pasa a ACCEPTED y sus ítems propuestos, a aceptados; las
   * demás opciones abiertas de su grupo, a REJECTED (DX-040), todo en la
   * misma transacción.
   *
   * DX-379 (C): un presupuesto VENCIDO (día de la sede del plan posterior a
   * su último día válido) no se firma sin elegir cómo (409 `QUOTE_EXPIRED`):
   * con los precios originales y un motivo, o actualizando los precios en la
   * misma transacción (la recotización de todos los propuestos, con la huella
   * de su vista previa; el `contentHash` es entonces el del presupuesto
   * recotizado). Elegir cómo con un presupuesto no vencido: 400.
   */
  async execute(
    patientId: string,
    planId: string,
    input: AcceptTreatmentPlanInput,
    meta: AcceptTreatmentPlanMeta,
  ): Promise<AcceptedPlanQuote> {
    // Las validaciones baratas, antes de tocar la base. La firma va aquí y
    // no tras comprobar el plan (como en los consentimientos, SEC-026): esa
    // comprobación ocurre dentro de la transacción de `accept`, con la fila
    // del plan bloqueada, y descomprimir la firma ahí alargaría el bloqueo;
    // adelantarla costaría releer el presupuesto entero. El coste de la firma
    // ya está acotado por sus dimensiones y el tope de inflate.
    const signature = parseSignature(input.signature);
    const signerName = input.signerName.trim();
    if (signerName === '') {
      throw new BadRequestException('El nombre de quien firma es obligatorio.');
    }
    if (signerName.length > SIGNER_NAME_MAX) {
      throw new BadRequestException(
        `El nombre de quien firma admite hasta ${SIGNER_NAME_MAX} caracteres.`,
      );
    }
    const choice = parseExpiredChoice(input.expired);
    // DX-041: el escenario de cuotas, validado como el alta (400 aquí).
    if (input.installmentPlan && input.partial) {
      throw new BadRequestException(INSTALLMENTS_WITH_PARTIAL_MESSAGE);
    }
    const installments = input.installmentPlan
      ? await this.installmentsStep(input.installmentPlan, meta)
      : undefined;
    const acceptedAt = this.now();
    // Fuera de la transacción del plan (spec §4.6): si el ADMIN cambia un
    // nombre entre el GET y la firma, el hash vivo cambia → 409 (R18).
    // DX-524: con los de cada sede; se elige la del plan al leerlo.
    const book = await this.documentTypeNames.book();
    // DX-379 (C): «actualizar los precios»: los vigentes se leen antes de la
    // transacción (como en la recotización); dentro se recalcula.
    const reprice =
      choice?.mode === ExpiredQuoteAcceptanceMode.REPRICE
        ? await this.repriceStep(
            patientId,
            planId,
            meta,
            acceptedAt,
            choice.repricePreviewHash,
          )
        : undefined;

    // DX-417: aceptar en parte. La partición se decide con el plan bloqueado
    // (y recotizado, si se recotiza); lo firmado es solo lo aceptado.
    const partialItemIds = input.partial?.itemIds;
    const partial: AcceptPartial | undefined = partialItemIds
      ? {
          decide: (_source, state) =>
            decidePartialOrThrow(state, partialItemIds),
          contentHashOf: (kept) =>
            computeQuoteHash(
              liveContent(
                kept,
                acceptedAt,
                book.forLocation(kept.location.id),
                this.composition,
              ),
            ),
        }
      : undefined;

    const outcome = await this.repo.accept(
      patientId,
      planId,
      (source, repriced, split): NewPlanAcceptance => {
        let expiry: ExpiredAcceptanceRecord;
        if (repriced) {
          // Ya comprobado sobre el presupuesto vencido, antes de recotizar.
          expiry = {
            ...NO_EXPIRED_ACCEPTANCE,
            quoteValidUntil: repriced.before.plan.quoteValidUntil,
            mode: ExpiredQuoteAcceptanceMode.REPRICE,
            repricingId: repriced.repricingId,
          };
        } else {
          assertSignable(source);
          expiry = expiryOf(source, acceptedAt, choice);
        }
        const signed = split
          ? sourceWithItems(source, split.acceptedItemIds)
          : source;
        const content = liveContent(
          signed,
          acceptedAt,
          book.forLocation(source.location.id),
          this.composition,
        );
        const contentHash = computeQuoteHash(content);
        if (contentHash !== input.contentHash) {
          throw new ConflictException(QUOTE_CHANGED_MESSAGE);
        }
        return {
          locationId: source.location.id,
          signerName,
          signature,
          content,
          contentHash,
          acceptanceHash: computeAcceptanceHash({
            contentHash,
            signerName,
            signature,
            acceptedAt,
          }),
          acceptedAt,
          acceptedById: meta.acceptedById,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          expiry,
          ...(split
            ? {
                partial: {
                  pendingItemIds: split.pendingItemIds,
                  pendingTotal: splitTotals(
                    source.items,
                    split,
                    source.plan.currency,
                    this.composition,
                  ).pending.net,
                },
              }
            : {}),
        };
      },
      reprice,
      partial,
      installments,
    );
    if (outcome.kind === 'NOT_FOUND') {
      throw new NotFoundException(PLAN_NOT_FOUND_MESSAGE);
    }
    if (outcome.kind === 'ALREADY_ACCEPTED') {
      throw new ConflictException(PLAN_ACCEPTED_CONFLICT_MESSAGE);
    }
    await this.recordPendingCreated(
      patientId,
      planId,
      outcome.source.acceptance?.partial?.pendingPlanId ?? null,
      meta.audit,
    );
    await this.recordPaymentPlanCreated(
      patientId,
      planId,
      outcome.paymentPlanId,
      meta.audit,
    );
    return {
      ...toDocument(
        outcome.source,
        acceptedAt,
        book.forLocation(outcome.source.location.id),
        this.composition,
      ),
      paymentPlanId: outcome.paymentPlanId,
    };
  }

  /**
   * DX-041: el plan de cuotas que crea la aceptación. Las condiciones se
   * validan antes de la transacción; dentro, con el plan ya aceptado, se
   * reparte sobre lo facturable releído con la MISMA función que el alta
   * (`planInstallmentSchedule`) y, si ese saldo no es el simulado, 409.
   */
  private async installmentsStep(
    plan: NonNullable<AcceptTreatmentPlanInput['installmentPlan']>,
    meta: AcceptTreatmentPlanMeta,
  ): Promise<AcceptInstallments> {
    const terms: InstallmentTerms = parseInstallmentTerms(plan);
    const expectedCents = toCents(plan.totalToFinance);
    if (!this.currencyDigits) {
      throw new Error('El catálogo de monedas no está configurado');
    }
    // Todas las monedas del catálogo (pocas filas): la del plan se sabe
    // dentro de la transacción.
    const digits = await this.currencyDigits.table();
    return {
      build: (billable, source) => {
        if (toCents(billable) !== expectedCents) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: INSTALLMENT_SIMULATION_STALE,
            message: INSTALLMENT_SIMULATION_STALE_MESSAGE,
          });
        }
        const currency = source.plan.currency;
        if (!digits.has(currency)) {
          throw new UnprocessableEntityException(
            PLAN_CURRENCY_NOT_IN_CATALOG_MESSAGE(currency),
          );
        }
        const schedule = planInstallmentSchedule(
          terms,
          billable,
          digits.roundingDigits(currency),
        );
        return {
          treatmentPlanId: source.plan.id,
          patientId: source.plan.patientId,
          currency,
          totalToFinance: schedule.totalToFinance,
          downPayment: schedule.downPayment,
          installmentsCount: schedule.installmentsCount,
          periodicity: schedule.periodicity,
          startDate: schedule.startDate,
          createdById: meta.acceptedById,
          installments: schedule.installments,
          // Sin excepción del cierre contable en la firma: PERIOD_LOCKED.
          lockActor: null,
        };
      },
    };
  }

  /**
   * DX-041: el plan de cuotas nacido en la aceptación tiene su propio evento
   * de alta (CREATE PAYMENT_PLAN, `reason` PLAN_ACCEPTED_WITH_INSTALLMENTS,
   * `params.treatmentPlanId`), como el de POST …/payment-plan. El SIGN del
   * plan lo escribe el @Audit de la ruta con `params.paymentPlanId`.
   */
  private async recordPaymentPlanCreated(
    patientId: string,
    planId: string,
    paymentPlanId: string | null,
    ctx: AuditRequestContext | undefined,
  ): Promise<void> {
    if (!paymentPlanId || !ctx || !this.audit) return;
    await this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'CREATE',
      resourceType: 'PAYMENT_PLAN',
      resourceId: paymentPlanId,
      patient: { kind: 'patient', id: patientId },
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        reason: 'PLAN_ACCEPTED_WITH_INSTALLMENTS',
        params: { treatmentPlanId: planId },
      },
    });
  }

  /**
   * DX-417 (ronda 1, M-7): el plan pendiente tiene su propio evento de alta
   * (CREATE TREATMENT_PLAN con `params.splitFromPlanId`, sin importes), para
   * que la auditoría filtrada por él diga quién lo creó y cuándo. El SIGN del
   * original lo escribe el @Audit de la ruta.
   */
  private async recordPendingCreated(
    patientId: string,
    planId: string,
    pendingPlanId: string | null,
    ctx: AuditRequestContext | undefined,
  ): Promise<void> {
    if (!pendingPlanId || !ctx || !this.audit) return;
    await this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'CREATE',
      resourceType: 'TREATMENT_PLAN',
      resourceId: pendingPlanId,
      patient: { kind: 'patient', id: patientId },
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: {
        reason: 'PLAN_SPLIT_PENDING',
        params: { splitFromPlanId: planId },
      },
    });
  }

  /** La recotización de la firma: precios vigentes leídos y su decisión. */
  private async repriceStep(
    patientId: string,
    planId: string,
    meta: AcceptTreatmentPlanMeta,
    at: Date,
    previewHash: string,
  ): Promise<AcceptReprice> {
    const repricer = this.requireRepricer();
    const actor = { userId: meta.acceptedById, role: meta.role };
    const context = await repricer.read(patientId, planId, actor, at);
    return {
      actorUserId: meta.acceptedById,
      decide: (source, subject) => {
        assertSignable(source);
        if (!quoteSourceExpiry(source, at).expired) {
          throw new BadRequestException(EXPIRED_NOT_EXPIRED_MESSAGE);
        }
        return repricer.decide(context, subject, previewHash);
      },
    };
  }

  private requireRepricer(): AcceptanceRepricer {
    if (!this.repricer) {
      throw new Error('AcceptanceRepricer no está configurado');
    }
    return this.repricer;
  }
}

/**
 * Lo que la aceptación guarda del vencimiento (sin recotizar): vencido sin
 * elegir cómo, 409 `QUOTE_EXPIRED`; con elección y sin vencer, 400; con los
 * precios originales, su motivo. Sin vencer, la copia de la validez.
 */
function expiryOf(
  source: PlanQuoteSource,
  at: Date,
  choice: ExpiredAcceptanceChoice | null,
): ExpiredAcceptanceRecord {
  const { expired, validUntil } = quoteSourceExpiry(source, at);
  if (!expired || validUntil === null) {
    if (choice) throw new BadRequestException(EXPIRED_NOT_EXPIRED_MESSAGE);
    return { ...NO_EXPIRED_ACCEPTANCE, quoteValidUntil: validUntil };
  }
  if (!choice) {
    throw quoteExpiredConflict(
      validUntil,
      quoteExpiredAcceptMessage(quoteDayText(source, validUntil)),
    );
  }
  if (choice.mode !== ExpiredQuoteAcceptanceMode.ORIGINAL_PRICES) {
    // REPRICE recotiza antes (repriceStep); aquí no puede llegar.
    throw new Error('REPRICE sin recotización');
  }
  return {
    quoteValidUntil: validUntil,
    mode: choice.mode,
    reason: choice.reason,
    note: choice.note,
    repricingId: null,
  };
}

/** Lo que devuelve la vista previa del presupuesto recotizado en la firma. */
export interface AcceptanceRepricePreview {
  repricing: Repricing;
  /** El presupuesto como se firmaría (su `contentHash` es el que se envía). */
  quote: PlanQuoteDocument;
}

/**
 * DX-379 (C): la vista previa de «actualizar los precios» al aceptar un
 * presupuesto vencido. Hace lo mismo que la firma con REPRICE hasta releer el
 * presupuesto recotizado y lo deshace: devuelve la recotización (su
 * `previewHash` es el `repricePreviewHash` de la firma) y el presupuesto que
 * se firmaría (su `contentHash`). No escribe nada.
 */
@Injectable()
export class PreviewAcceptanceRepricingUseCase {
  constructor(
    @Inject(PLAN_QUOTE_REPOSITORY)
    private readonly repo: PlanQuoteRepository,
    @Inject(PLAN_QUOTE_CLOCK)
    private readonly now: PlanQuoteClock,
    private readonly documentTypeNames: DocumentTypeNamesReader,
    private readonly repricer: AcceptanceRepricer,
    @Optional()
    @Inject(PLAN_QUOTE_COMPOSITION)
    private readonly composition: QuoteComposition = 'current',
  ) {}

  async execute(
    patientId: string,
    planId: string,
    actor: { userId: string; role: ClinicRole },
  ): Promise<AcceptanceRepricePreview> {
    const at = this.now();
    const context = await this.repricer.read(patientId, planId, actor, at);
    const result = await this.repo.previewRepriced(patientId, planId, {
      actorUserId: actor.userId,
      decide: (source, subject) => {
        assertSignable(source);
        // M-2: como la firma con REPRICE, solo un presupuesto vencido.
        if (!quoteSourceExpiry(source, at).expired) {
          throw new BadRequestException(EXPIRED_NOT_EXPIRED_MESSAGE);
        }
        return this.repricer.decide(context, subject, null);
      },
    });
    if (!result) throw new NotFoundException(PLAN_NOT_FOUND_MESSAGE);
    const names = await this.documentTypeNames.get(result.source.location.id);
    return {
      repricing: result.repricing,
      quote: toDocument(result.source, at, names, this.composition),
    };
  }
}

/** DX-417: lo que queda pendiente en la vista previa de una aceptación parcial. */
export interface PartialAcceptancePending {
  items: QuoteItem[];
  totals: QuoteTotal[];
}

/** DX-417: la vista previa de una aceptación parcial. */
export interface PartialAcceptancePreview {
  /** El presupuesto de lo aceptado, como se firmaría (su `contentHash`). */
  accepted: PlanQuoteDocument;
  /** Lo que pasaría al plan pendiente. */
  pending: PartialAcceptancePending;
  /** Los totales del presupuesto entero (aceptado + pendiente). */
  original: { totals: QuoteTotal[] };
  /**
   * Con `reprice`: la recotización de TODO el plan (su `previewHash` es el
   * `expired.repricePreviewHash` de la firma); si no, null.
   */
  repricing: Repricing | null;
}

/**
 * DX-417: la vista previa de aceptar solo una parte del presupuesto. Compone
 * el presupuesto de lo aceptado (su `contentHash` es el que se firma), lo que
 * quedaría pendiente y los totales del plan entero, todos del servidor. No
 * escribe ni bloquea. Con `reprice` (un presupuesto vencido que se acepta
 * actualizando los precios), recotiza TODO el plan como
 * …/acceptance/reprice-preview, sin dejar nada escrito, y parte el resultado.
 */
@Injectable()
export class PreviewPartialAcceptanceUseCase {
  constructor(
    @Inject(PLAN_QUOTE_REPOSITORY)
    private readonly repo: PlanQuoteRepository,
    @Inject(PLAN_QUOTE_CLOCK)
    private readonly now: PlanQuoteClock,
    private readonly documentTypeNames: DocumentTypeNamesReader,
    private readonly repricer: AcceptanceRepricer,
    @Optional()
    @Inject(PLAN_QUOTE_COMPOSITION)
    private readonly composition: QuoteComposition = 'current',
  ) {}

  async execute(
    patientId: string,
    planId: string,
    input: { itemIds: string[]; reprice?: boolean },
    actor: { userId: string; role: ClinicRole },
  ): Promise<PartialAcceptancePreview> {
    const at = this.now();
    const repriced = input.reprice
      ? await this.readRepriced(patientId, planId, actor, at)
      : null;
    const read = input.reprice
      ? repriced
      : await this.repo.loadPartial(patientId, planId);
    if (!read) throw new NotFoundException(PLAN_NOT_FOUND_MESSAGE);
    const { source, state } = read;
    const split = decidePartialOrThrow(state, input.itemIds);
    const names = await this.documentTypeNames.get(source.location.id);
    const validity = quoteValidityOf(source, at);
    const pending = composeQuoteContent(
      sourceWithItems(source, split.pendingItemIds),
      validity,
      names,
      this.composition,
    );
    const { original } = splitTotals(
      source.items,
      split,
      source.plan.currency,
      this.composition,
    );
    return {
      accepted: toDocument(
        sourceWithItems(source, split.acceptedItemIds),
        at,
        names,
        this.composition,
      ),
      pending: { items: pending.items, totals: pending.totals },
      original: { totals: [original] },
      repricing: repriced?.repricing ?? null,
    };
  }

  /** Como …/acceptance/reprice-preview: recotiza todo y lo deshace. */
  private async readRepriced(
    patientId: string,
    planId: string,
    actor: { userId: string; role: ClinicRole },
    at: Date,
  ) {
    const context = await this.repricer.read(patientId, planId, actor, at);
    return this.repo.previewRepriced(patientId, planId, {
      actorUserId: actor.userId,
      decide: (source, subject) => {
        assertSignable(source);
        if (!quoteSourceExpiry(source, at).expired) {
          throw new BadRequestException(EXPIRED_NOT_EXPIRED_MESSAGE);
        }
        return this.repricer.decide(context, subject, null);
      },
    });
  }
}
