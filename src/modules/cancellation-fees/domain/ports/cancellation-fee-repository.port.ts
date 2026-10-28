import type { AppointmentStatus, CancellationFeeStatus } from '@prisma/client';

// Sin `tenantId` en ningún input: el tenant sale SIEMPRE del contexto de la
// petición y todo se lee y escribe bajo RLS (una cita de otra clínica no
// existe: 404).

/** El cargo o la condonación ya registrados de una cita. */
export interface CancellationFeeRecord {
  id: string;
  status: CancellationFeeStatus;
  amount: number | null;
  currency: string | null;
  planId: string | null;
  planItemId: string | null;
  /**
   * El ítem del cargo se quitó del plan (soft delete): el cargo quedó anulado
   * y ya no hay nada que cobrar. La decisión de la cita sigue siendo única.
   */
  planItemRemoved: boolean;
  waiveReason: string | null;
  policyVersionId: string | null;
  createdAt: Date;
  /** Nombre de quien lo decidió; `null` si ya no es resoluble. */
  createdByName: string | null;
  /**
   * SEC-050: lo que cobra HOY el ítem del cargo (precio − descuento); `null`
   * sin ítem o con el ítem retirado.
   */
  itemAmount: number | null;
  /**
   * SEC-050: el ítem vivo no cobra lo que dice el cargo (`amount`): alguien lo
   * cambió por fuera de este flujo (antes de SEC-050, o directamente en la BD).
   */
  itemMismatch: boolean;
  /** SEC-050: anulación del cargo (cuándo, quién y por qué); `null` sin anular. */
  voidedAt: Date | null;
  voidedByName: string | null;
  voidReason: string | null;
}

/** La versión de la política COMUNICADA al paciente (la de la cita). */
export interface CommunicatedPolicy {
  id: string;
  version: number;
  noticeHours: number;
  suggestedFee: number | null;
  currency: string | null;
}

/** Todo lo que el cargo necesita saber de una cita, leído bajo RLS. */
export interface CancellationFeeContext {
  appointment: {
    id: string;
    patientId: string;
    locationId: string;
    start: Date;
    status: AppointmentStatus;
    lateCancellation: boolean | null;
    policyVersionId: string | null;
  };
  communicated: CommunicatedPolicy | null;
  /** De la política VIGENTE de la sede de la cita (false sin política). */
  receptionCanCharge: boolean;
  /** Formato y reloj de la sede de la cita, en crudo: los pide quien pinta (G1-B, I4). */
  locationLocale: string | null;
  locationHourCycle: string | null;
  fee: CancellationFeeRecord | null;
}

export interface ChargeFeeInput {
  appointmentId: string;
  amount: number;
  currency: string;
  /** La cita solo se cobra si sigue como al decidir (estado y versión). */
  expectedStatus: AppointmentStatus;
  expectedPolicyVersionId: string;
  createdById: string;
}

export interface WaiveFeeInput {
  appointmentId: string;
  reason: string;
  expectedStatus: AppointmentStatus;
  createdById: string;
}

export interface VoidFeeInput {
  appointmentId: string;
  reason: string;
  voidedById: string;
}

/**
 * - OK: cargo anulado y su ítem retirado del plan, en una transacción.
 * - NOT_CHARGED / ALREADY_VOIDED: no hay cargo que anular (o ya se anuló:
 *   otra petición ganó).
 * - PAID: los abonos vivos del plan ya no caben en lo que queda por cobrar.
 * - STALE: la cita se retiró entre la lectura y la escritura.
 */
export type FeeVoidOutcome =
  | { outcome: 'OK'; fee: CancellationFeeRecord }
  | { outcome: 'NOT_CHARGED' | 'ALREADY_VOIDED' | 'PAID' | 'STALE' };

/**
 * - OK: registrado (y, en el cargo, el plan/ítem creado) en una transacción.
 * - EXISTS: la cita ya tenía su cargo o su condonación (otra petición ganó).
 * - STALE: la cita cambió entre la lectura y la escritura; no se tocó nada.
 */
export type FeeWriteOutcome =
  | { outcome: 'OK'; fee: CancellationFeeRecord }
  | { outcome: 'EXISTS' | 'STALE' };

export const CANCELLATION_FEE_REPOSITORY = Symbol(
  'CANCELLATION_FEE_REPOSITORY',
);

export interface CancellationFeeRepository {
  /** `null` si la cita no existe en esta clínica (o está retirada). */
  loadContext(appointmentId: string): Promise<CancellationFeeContext | null>;
  /**
   * Con la cita bloqueada: crea (o reutiliza) el plan ACCEPTED «Cargos
   * administrativos» del paciente en esa moneda, le añade el ítem DONE del
   * cargo y registra la decisión. El índice único por cita impide un segundo
   * cargo aunque lleguen dos peticiones a la vez.
   */
  charge(input: ChargeFeeInput): Promise<FeeWriteOutcome>;
  /** Con la cita bloqueada: registra la condonación con su motivo. */
  waive(input: WaiveFeeInput): Promise<FeeWriteOutcome>;
  /**
   * SEC-050: con la cita y el cargo bloqueados, marca el cargo como anulado
   * (autor y motivo) y DESPUÉS retira su ítem del plan: el trigger
   * `treatment_plan_items_cancellation_fee_locked` solo deja retirar el ítem
   * de un cargo ya anulado en la misma transacción. No anula si los abonos
   * vivos del plan superarían lo que queda por cobrar en él.
   */
  voidFee(input: VoidFeeInput): Promise<FeeVoidOutcome>;
}
