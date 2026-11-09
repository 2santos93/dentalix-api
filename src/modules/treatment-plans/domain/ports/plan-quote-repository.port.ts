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
   */
  accept(
    patientId: string,
    planId: string,
    decide: (source: PlanQuoteSource) => NewPlanAcceptance,
  ): Promise<AcceptPlanOutcome>;

  /**
   * DX-379: emite el presupuesto (primera impresión) en UNA transacción con
   * la fila del plan bloqueada: relee el presupuesto, deja que `decide` diga
   * qué validez guardar (`null` = no se guarda nada) y, si la hay, la escribe
   * solo si el plan aún no tiene fechas. Devuelve el presupuesto releído, o
   * `null` si el plan no existe para este paciente (404).
   */
  issue(
    patientId: string,
    planId: string,
    decide: (source: PlanQuoteSource) => QuoteValidity | null,
  ): Promise<PlanQuoteSource | null>;
}
