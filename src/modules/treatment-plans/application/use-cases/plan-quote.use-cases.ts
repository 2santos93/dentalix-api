import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import {
  buildQuoteContent,
  computeAcceptanceHash,
  computeQuoteHash,
  parseQuoteContent,
  type QuoteContent,
} from '../../domain/plan-quote';
import { acceptPlanError } from '../../domain/plan-status-machine';
import {
  PLAN_QUOTE_REPOSITORY,
  type NewPlanAcceptance,
  type PlanQuoteRepository,
  type PlanAcceptanceRemoteEvidence,
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

export type PlanQuoteClock = () => Date;
export const PLAN_QUOTE_CLOCK = Symbol('PLAN_QUOTE_CLOCK');

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
  ipAddress: string | null;
  userAgent: string | null;
}

/** El presupuesto para verlo o imprimirlo. */
export interface PlanQuoteDocument extends QuoteContent {
  visitOrganization?: PlanQuoteSource['visitOrganization'];
  planStatus: TreatmentPlanStatus;
  clinicLogoUrl: string | null;
  contentHash: string;
  acceptance: PlanQuoteAcceptanceView | null;
}

export interface AcceptTreatmentPlanInput {
  signerName: string;
  /** `data:image/png;base64,…` o base64 pelado. */
  signature: string;
  /** El `contentHash` del presupuesto que se mostró al paciente. */
  contentHash: string;
}

/** Lo que pone el servidor, nunca el cliente. */
export interface AcceptTreatmentPlanMeta {
  acceptedById: string;
  ipAddress: string | null;
  userAgent: string | null;
}

function todayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Hoy (`YYYY-MM-DD`) en la zona de la sede del presupuesto. */
export function quoteIssuedOn(source: PlanQuoteSource, now: Date): string {
  return todayIn(source.location.timeZone, now);
}

/**
 * El presupuesto VIVO del plan, emitido hoy en la zona de la sede, con el
 * nombre visible de hoy del documento (DX-327, R17). Al aceptar se congela
 * este texto (R18).
 */
function liveContent(
  source: PlanQuoteSource,
  now: Date,
  names: ClinicDocumentTypeNames,
): QuoteContent {
  return composeQuoteContent(source, quoteIssuedOn(source, now), names);
}

/**
 * El presupuesto del plan tal como está AHORA, emitido el día `issuedOn`.
 * DX-415: con el `issuedOn` de la foto enviada, su hash es el de la foto si y
 * solo si nada del presupuesto cambió (ítems, precios, convenio, paciente,
 * sede, profesional).
 */
export function composeQuoteContent(
  source: PlanQuoteSource,
  issuedOn: string,
  names: ClinicDocumentTypeNames,
): QuoteContent {
  const { patient } = source;
  return buildQuoteContent(
    {
      planId: source.plan.id,
      patientId: source.plan.patientId,
      currency: source.plan.currency,
      clinicName: source.clinic.name,
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
    issuedOn,
  );
}

/**
 * Un plan aceptado se imprime con la FOTO firmada (lo que vio y firmó el
 * paciente), nunca con el plan vivo; `integrityOk` recalcula los dos hashes.
 */
function toDocument(
  source: PlanQuoteSource,
  now: Date,
  names: ClinicDocumentTypeNames,
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
    planStatus: source.plan.status,
    clinicLogoUrl: source.clinic.logoUrl,
  };
  const stored = source.acceptance;
  if (!stored) {
    const content = liveContent(source, now, names);
    return {
      ...content,
      ...base,
      contentHash: computeQuoteHash(content),
      acceptance: null,
    };
  }
  const content = parseQuoteContent(stored.content);
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
    contentHash: stored.contentHash,
    acceptance: {
      signerName: stored.signerName,
      signature: stored.signature,
      acceptedAt: stored.acceptedAt,
      acceptedByName: stored.acceptedByName,
      acceptanceHash: stored.acceptanceHash,
      integrityOk,
      remote: stored.remote,
      ipAddress: stored.ipAddress,
      userAgent: stored.userAgent,
    },
  };
}

@Injectable()
export class GetPlanQuoteUseCase {
  constructor(
    @Inject(PLAN_QUOTE_REPOSITORY)
    private readonly repo: PlanQuoteRepository,
    @Inject(PLAN_QUOTE_CLOCK)
    private readonly now: PlanQuoteClock,
    private readonly documentTypeNames: DocumentTypeNamesReader,
  ) {}

  /** El presupuesto imprimible; 404 si el plan no es de este paciente/clínica. */
  async execute(patientId: string, planId: string): Promise<PlanQuoteDocument> {
    const source = await this.repo.loadSource(patientId, planId);
    if (!source) {
      throw new NotFoundException(PLAN_NOT_FOUND_MESSAGE);
    }
    // Un plan aceptado se imprime con su foto: los nombres de la clínica solo
    // hacen falta para componer el presupuesto vivo.
    const names = source.acceptance ? {} : await this.documentTypeNames.get();
    return toDocument(source, this.now(), names);
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

@Injectable()
export class AcceptTreatmentPlanUseCase {
  constructor(
    @Inject(PLAN_QUOTE_REPOSITORY)
    private readonly repo: PlanQuoteRepository,
    @Inject(PLAN_QUOTE_CLOCK)
    private readonly now: PlanQuoteClock,
    private readonly documentTypeNames: DocumentTypeNamesReader,
  ) {}

  /**
   * Aceptar = firmar la foto del presupuesto. Se recompone el presupuesto con
   * el plan bloqueado y su hash tiene que ser el que se mostró: si algo cambió
   * entre medias (un ítem, un precio, el día), 409 y no se firma. Firma, hora
   * (del servidor) y autor (del token) quedan sellados con un segundo hash. El
   * plan pasa a ACCEPTED y sus ítems propuestos, a aceptados; las demás
   * opciones abiertas de su grupo, a REJECTED (DX-040), todo en la misma
   * transacción.
   */
  async execute(
    patientId: string,
    planId: string,
    input: AcceptTreatmentPlanInput,
    meta: AcceptTreatmentPlanMeta,
  ): Promise<PlanQuoteDocument> {
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
    const acceptedAt = this.now();
    // Fuera de la transacción del plan (spec §4.6): si el ADMIN cambia un
    // nombre entre el GET y la firma, el hash vivo cambia → 409 (R18).
    const names = await this.documentTypeNames.get();

    const outcome = await this.repo.accept(
      patientId,
      planId,
      (source): NewPlanAcceptance => {
        if (source.acceptance) {
          throw new ConflictException(PLAN_ACCEPTED_CONFLICT_MESSAGE);
        }
        // Máquina de estados (DX-040): se firma un borrador o un plan
        // presentado, y también uno ya aceptado sin firma (DX-012). Rechazado,
        // completado o cancelado: 409.
        const transitionError = acceptPlanError(source.plan.status, {
          allowAlreadyAccepted: true,
        });
        if (transitionError) throw new ConflictException(transitionError);
        if (source.items.length === 0) {
          throw new BadRequestException(
            'El plan no tiene ítems: agrega al menos un procedimiento antes de aceptarlo.',
          );
        }
        const content = liveContent(source, acceptedAt, names);
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
        };
      },
    );
    if (outcome.kind === 'NOT_FOUND') {
      throw new NotFoundException(PLAN_NOT_FOUND_MESSAGE);
    }
    if (outcome.kind === 'ALREADY_ACCEPTED') {
      throw new ConflictException(PLAN_ACCEPTED_CONFLICT_MESSAGE);
    }
    return toDocument(outcome.source, acceptedAt, names);
  }
}
