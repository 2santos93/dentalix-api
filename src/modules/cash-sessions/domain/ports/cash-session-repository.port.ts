import type { CashSessionStatus, PaymentMethod } from '@prisma/client';
import type { ArqueoLine, ExpectedLine } from '../arqueo';
import type {
  CashAdjustmentView,
  CashSessionDetail,
  CashSessionSummary,
  CashSettings,
} from '../cash-session.entity';

export const CASH_SESSION_REPOSITORY = Symbol('CASH_SESSION_REPOSITORY');

/** Qué cajas ve quien consulta: RECEPTION solo las suyas. */
export interface CashSessionScope {
  openedById?: string;
}

export interface OpenCashSessionData {
  locationId: string;
  openedById: string;
  floats: { currency: string; cents: number }[];
  notes: string | null;
}

export interface ListCashSessionsParams extends CashSessionScope {
  locationId?: string;
  /** Días civiles YYYY-MM-DD (ambos inclusive) en la zona de cada sede. */
  from?: string;
  to?: string;
  status?: CashSessionStatus;
  skip: number;
  take: number;
}

/** Lo que el cierre necesita saber, leído con la caja bloqueada. */
export interface CloseContext {
  locationId: string;
  openedById: string;
  timeZone: string;
  /** «Arqueo ciego» de la clínica en el momento del cierre. */
  blind: boolean;
  expected: ExpectedLine[];
}

/** El cierre que decide el caso de uso a partir del `CloseContext`. */
export interface ClosingDraft {
  lines: ArqueoLine[];
  hasDifference: boolean;
  differenceReason: string | null;
  notes: string | null;
  blind: boolean;
  /** YYYY-MM-DD. */
  suggestedLockDate: string;
}

export type CloseOutcome = 'CLOSED' | 'NOT_FOUND' | 'NOT_OPEN';
export type ReopenOutcome =
  'REOPENED' | 'NOT_FOUND' | 'NOT_CLOSED' | 'ALREADY_OPEN';

export interface CorrectionData {
  currency: string;
  method: PaymentMethod;
  cents: number;
  reason: string;
  createdById: string;
}

export type CorrectionOutcome =
  | { kind: 'CREATED'; adjustment: CashAdjustmentView }
  | { kind: 'NOT_FOUND' }
  | { kind: 'NOT_CLOSED' };

/** Detalle tal como sale de la BD; el caso de uso decide qué se enseña. */
export type CashSessionRecord = Omit<CashSessionDetail, 'blindHidden' | 'can'>;

export interface CashSessionRepository {
  getSettings(): Promise<CashSettings>;
  updateSettings(settings: CashSettings): Promise<CashSettings>;

  /**
   * La sede viva de esta clínica con ese id, o la sede por defecto si no se
   * pide ninguna; `null` si el id no es de una sede viva de la clínica.
   */
  resolveLocation(locationId?: string): Promise<string | null>;

  /** Los códigos que NO están en el catálogo de monedas. */
  missingCurrencies(codes: readonly string[]): Promise<string[]>;

  /**
   * Abre la caja con su fondo (misma transacción) y le une los ajustes
   * pendientes de la sede. `ALREADY_OPEN` si el usuario ya tiene una abierta
   * en esa sede (índice único parcial).
   */
  open(data: OpenCashSessionData): Promise<{ id: string } | 'ALREADY_OPEN'>;

  /** La caja abierta del usuario en la sede, si la hay. */
  findOpenId(locationId: string, userId: string): Promise<string | null>;

  list(
    params: ListCashSessionsParams,
  ): Promise<{ items: CashSessionSummary[]; total: number }>;

  detail(
    id: string,
    scope: CashSessionScope,
  ): Promise<CashSessionRecord | null>;

  /**
   * Cierra con la caja bloqueada (FOR UPDATE): calcula el esperado en esa
   * misma foto, deja que `decide` arme el cierre (puede lanzar: se deshace
   * todo) y guarda cierre, líneas y estado en la misma transacción.
   */
  close(
    id: string,
    scope: CashSessionScope,
    closedById: string,
    decide: (context: CloseContext) => ClosingDraft,
  ): Promise<CloseOutcome>;

  reopen(
    id: string,
    reopenedById: string,
    reason: string,
  ): Promise<ReopenOutcome>;

  /**
   * Corrección de una caja cerrada: un ajuste con motivo en la caja abierta de
   * quien la hace en esa sede, o pendiente de la siguiente que se abra.
   */
  addCorrection(id: string, data: CorrectionData): Promise<CorrectionOutcome>;
}
