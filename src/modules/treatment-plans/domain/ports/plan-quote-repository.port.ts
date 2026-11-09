import type { DocumentRegionalDto } from '../../../../shared/locations/document-regional.dto';
import type { ClinicFiscalData } from '../../../../shared/clinic/clinic-fiscal';
import type {
  ConsentSignerType,
  DocumentType,
  SignatureRequestChannel,
  TreatmentPlanStatus,
} from '@prisma/client';
import type { QuoteLocation, QuoteSourceItem } from '../plan-quote';
import type { QuoteValidity } from '../quote-validity';
import type { ExpiredAcceptanceRecord } from '../expired-quote-acceptance';
import type { Repricing } from '../../application/repricing';
import type { RepricingSubject } from './plan-repricing-repository.port';

/** La aceptación firmada tal como está guardada (DX-012). */
export interface StoredPlanAcceptance {
  /** JSONB tal cual; se valida con `parseQuoteContent` al leerlo. */
  content: unknown;
  contentHash: string;
  signerName: string;
  /** PNG en base64, sin prefijo `data:`. */
  signature: string;
  acceptedAt: Date;
  acceptedByName: string;
  acceptanceHash: string;
  ipAddress: string | null;
  userAgent: string | null;
  /** DX-415: aceptado por el paciente a distancia; `null` en la clínica. */
  remote: PlanAcceptanceRemoteEvidence | null;
  /**
   * DX-019-bis (B): el logo congelado al firmar (columna propia, fuera del
   * contenido y de sus hashes); `null` = se firmó sin logo y se imprime sin él.
   */
  clinicLogoUrl: string | null;
  /**
   * DX-379 (C): cómo se aceptó (columnas fuera del contenido y de sus
   * hashes). Sin `mode`, el presupuesto no estaba vencido.
   */
  expiry: ExpiredAcceptanceRecord;
}

/** Evidencias de la aceptación a distancia, congeladas al firmar (DX-415). */
export interface PlanAcceptanceRemoteEvidence {
  signatureRequestId: string;
  channel: SignatureRequestChannel;
  destinationMasked: string;
  sentAt: Date;
  openedAt: Date;
  verifiedAt: Date;
  /**
   * DX-514: quién firmó por el enlace, el paciente o su representante (el de
   * la solicitud). `acceptedByName` es quien la envió, no quien firmó. Sin
   * ella la aceptación sigue siendo a distancia: nunca «Registró la firma».
   */
  signerType?: ConsentSignerType;
}

/**
 * Todo lo que el presupuesto de un plan necesita, leído bajo la RLS de la
 * clínica en contexto. La sede es la del request (`X-Location-Id`) o, en la
 * vista consolidada, la principal.
 */
export interface PlanQuoteSource {
  visitOrganization?: {
    itemId: string;
    visit: number;
    label: string | null;
    minDaysAfterPrevious: number;
  }[];
  plan: {
    id: string;
    patientId: string;
    status: TreatmentPlanStatus;
    currency: string;
    /**
     * DX-379: validez guardada (`YYYY-MM-DD`, las dos o ninguna); `null` si el
     * plan aún no se presentó ni se imprimió (o es anterior a DX-379).
     */
    quoteIssuedOn: string | null;
    quoteValidUntil: string | null;
    /** Sede de la presentación (DX-040); null sin presentar. */
    presentedLocationId: string | null;
    /**
     * DX-379 (C): la sede con la que se decide si el presupuesto venció y se
     * escribe su fecha (D-13): la de la presentación o, sin presentar, la de
     * este presupuesto. `timeZone` null si la sede de la presentación no
     * tiene una zona válida (quien decide da el 409 de zona); `locale` y
     * `hourCycle` crudos (pueden faltar).
     */
    quoteRegional: {
      locationId: string;
      timeZone: string | null;
      locale: string | null;
      hourCycle: string | null;
    };
  };
  /** Ítems vivos, en orden de alta. */
  items: QuoteSourceItem[];
  patient: {
    firstName: string;
    lastName: string;
    docType: DocumentType;
    /** DX-327: nombre libre del documento (R7); null = sin etiqueta. */
    docTypeLabel: string | null;
    docNumber: string | null;
  };
  /**
   * DX-019: `fiscal`, los de hoy: entran en el contenido que se presenta y se
   * firma. DX-019-bis (B): `logoKey`, la clave de hoy que congela la
   * aceptación (`clinicLogoKeyToFreeze`); el logo NO entra en el contenido.
   */
  clinic: {
    name: string;
    logoUrl: string | null;
    logoKey: string | null;
    fiscal: ClinicFiscalData;
    /** DX-379: días de validez del ajuste de hoy (para un plan sin fechas guardadas). */
    quoteValidityDays: number;
  };
  location: QuoteLocation & { timeZone: string };
  /** DX-354: región de la sede del presupuesto; `null` si le falta algo. No entra en el contenido firmado ni en su hash. */
  regional: DocumentRegionalDto | null;
  /** Quien creó el plan; `null` si no consta. */
  professionalName: string | null;
  acceptance: StoredPlanAcceptance | null;
}

/** Lo que se inserta al aceptar (todo calculado por el caso de uso). */
export interface NewPlanAcceptance {
  locationId: string;
  signerName: string;
  signature: string;
  content: object;
  contentHash: string;
  acceptanceHash: string;
  acceptedAt: Date;
  acceptedById: string;
  ipAddress: string | null;
  userAgent: string | null;
  /**
   * DX-379 (C): cómo se aceptó un presupuesto vencido. Sin ella, se guarda
   * solo la copia de la validez del plan leído (sin modo).
   */
  expiry?: ExpiredAcceptanceRecord;
}

/**
 * DX-379 (C): recotizar en la MISMA transacción de la firma, antes de firmar
 * (aceptar un presupuesto vencido «actualizando los precios»).
 */
export interface AcceptReprice {
  /** Autor de la recotización (quien firma en la clínica). */
  actorUserId: string;
  /**
   * Con el plan bloqueado: valida el presupuesto leído y calcula la
   * recotización de TODOS los ítems propuestos. Si lanza, nada se escribe.
   */
  decide(source: PlanQuoteSource, subject: RepricingSubject): Repricing;
}

/** La recotización hecha en la firma, para quien decide la aceptación. */
export interface AcceptRepriced {
  repricingId: string;
  /** El presupuesto leído ANTES de recotizar (con la validez vencida). */
  before: PlanQuoteSource;
}

export type AcceptPlanOutcome =
  | { kind: 'NOT_FOUND' }
  | { kind: 'ALREADY_ACCEPTED' }
  | { kind: 'ACCEPTED'; source: PlanQuoteSource };

export const PLAN_QUOTE_REPOSITORY = Symbol('PLAN_QUOTE_REPOSITORY');

export interface PlanQuoteRepository {
  /**
   * El presupuesto del plan `planId` del paciente `patientId`, o `null` si el
   * paciente o el plan no son de esta clínica, el plan está retirado o es de
   * otro paciente (todo indistinguible: 404).
   */
  loadSource(
    patientId: string,
    planId: string,
  ): Promise<PlanQuoteSource | null>;

  /**
   * Acepta en UNA transacción con la fila del plan bloqueada (FOR UPDATE):
   * relee el presupuesto, deja que `decide` lo valide y calcule la aceptación
   * (si lanza, no se escribe nada), la inserta, pasa el plan a ACCEPTED y sus
   * ítems PROPOSED a ACCEPTED. Dos firmas simultáneas: la segunda choca con el
   * índice único y sale como `ALREADY_ACCEPTED`.
   *
   * DX-379 (C): con `reprice`, antes de `decide` y en la misma transacción,
   * recotiza (ítems con la marca, validez renovada y fila de la recotización
   * con source ACCEPT) y relee el presupuesto: `decide` recibe el recotizado
   * y la recotización. Si algo lanza después, la recotización se deshace.
   */
  accept(
    patientId: string,
    planId: string,
    decide: (
      source: PlanQuoteSource,
      repriced: AcceptRepriced | null,
    ) => NewPlanAcceptance,
    reprice?: AcceptReprice,
  ): Promise<AcceptPlanOutcome>;

  /**
   * DX-379 (C): el presupuesto como quedaría tras recotizar en la firma: hace
   * lo mismo que `accept` con `reprice` hasta releer el presupuesto y lo
   * DESHACE todo (no queda nada escrito). `null` si el plan no existe para
   * este paciente (404).
   */
  previewRepriced(
    patientId: string,
    planId: string,
    reprice: AcceptReprice,
  ): Promise<{ source: PlanQuoteSource; repricing: Repricing } | null>;

  /**
   * DX-379: emite el presupuesto (primera impresión). Lee el presupuesto sin
   * bloquear y deja que `decide` diga qué validez guardar (`null` = nada: se
   * devuelve lo leído sin bloquear). Si hay que guardar, en UNA transacción
   * con el grupo del plan bloqueado relee, vuelve a llamar a `decide` (puede
   * llamarse dos veces) y escribe solo si el plan aún no tiene fechas.
   * Devuelve el presupuesto releído, o `null` si el plan no existe para este
   * paciente (404).
   */
  issue(
    patientId: string,
    planId: string,
    decide: (source: PlanQuoteSource) => QuoteValidity | null,
  ): Promise<PlanQuoteSource | null>;
}
