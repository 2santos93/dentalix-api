import type { DocType, TreatmentPlanStatus } from '@prisma/client';
import type { QuoteLocation, QuoteSourceItem } from '../plan-quote';

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
}

/**
 * Todo lo que el presupuesto de un plan necesita, leído bajo la RLS de la
 * clínica en contexto. La sede es la del request (`X-Location-Id`) o, en la
 * vista consolidada, la principal.
 */
export interface PlanQuoteSource {
  plan: {
    id: string;
    patientId: string;
    status: TreatmentPlanStatus;
    currency: string;
  };
  /** Ítems vivos, en orden de alta. */
  items: QuoteSourceItem[];
  patient: {
    firstName: string;
    lastName: string;
    docType: DocType;
    docNumber: string | null;
  };
  clinic: { name: string; logoUrl: string | null };
  location: QuoteLocation & { timeZone: string };
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
}
