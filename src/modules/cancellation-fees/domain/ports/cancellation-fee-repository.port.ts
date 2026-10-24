import type {
  AppointmentStatus,
  CancellationFeeStatus,
  ClinicCountry,
} from '@prisma/client';
import type { FeeCoverage } from '../cancellation-fee';

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
  waiveReason: string | null;
  policyVersionId: string | null;
  createdAt: Date;
  /** Nombre de quien lo decidió; `null` si ya no es resoluble. */
  createdByName: string | null;
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
  locationCountry: ClinicCountry;
  locationTimeZone: string;
  /** Coberturas vivas del paciente con el tipo de su pagador. */
  coverages: FeeCoverage[];
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
}
