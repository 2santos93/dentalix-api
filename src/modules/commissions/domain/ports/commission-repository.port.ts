import type { ClinicRole } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type {
  CandidateItem,
  CommissionLineDraft,
  PlanReleaseInfo,
  SettledLine,
  SettlementPeriod,
} from '../commission-calculator';
import type {
  CommissionCategoryPercent,
  CommissionRuleTerms,
} from '../commission-rule';
import type { CommissionLineView, CommissionSettlementSummary } from '../views';

export const COMMISSION_REPOSITORY = Symbol('COMMISSION_REPOSITORY');
export const COMMISSION_CLOCK = Symbol('COMMISSION_CLOCK');
export type CommissionClock = () => Date;

/** Un profesional de la clínica al que se le puede poner regla. */
export interface CommissionProfessional {
  membershipId: string;
  userId: string;
  name: string;
  role: ClinicRole;
  /** Membresía vigente (no retirada). */
  active: boolean;
}

export interface CommissionRuleRecord {
  id: string;
  terms: CommissionRuleTerms;
  active: boolean;
  updatedAt: Date;
}

/** Ventana UTC holgada que contiene el período en cualquier zona (±14 h). */
export interface UtcWindow {
  start: Date;
  end: Date;
}

/** Lecturas de la liquidación de UN profesional, dentro de una transacción. */
export interface CommissionReader {
  rule(membershipId: string): Promise<CommissionRuleRecord | null>;
  /** Ítems realizados por el profesional con algo aún sin liquidarle. */
  candidates(
    professional: CommissionProfessional,
    terms: CommissionRuleTerms,
    window: UtcWindow,
  ): Promise<CandidateItem[]>;
  planRelease(planIds: readonly string[]): Promise<PlanReleaseInfo[]>;
  /** Devengos ya liquidados cuya base vigente no coincide con lo liquidado. */
  settledToAdjust(professional: CommissionProfessional): Promise<SettledLine[]>;
  /** El «hasta» de la última liquidación cerrada (AAAA-MM-DD) o null. */
  lastClosedTo(membershipId: string): Promise<string | null>;
  overlaps(membershipId: string, period: SettlementPeriod): Promise<boolean>;
  /** Nombre visible de cada paciente (por id). */
  patientNames(patientIds: readonly string[]): Promise<Map<string, string>>;
  /** Zona de cada sede (409 si alguna no tiene una válida). */
  zones(
    locationIds: readonly string[],
  ): Promise<(locationId: string) => string>;
  /** Hoy en la sede de la petición. */
  today(now: Date): Promise<string>;
}

export interface NewSettlement {
  professional: CommissionProfessional;
  period: SettlementPeriod;
  terms: CommissionRuleTerms;
  lines: readonly CommissionLineDraft[];
}

export interface ClosedSettlement {
  id: string;
  lockDateBefore: string | null;
  lockDateAfter: string;
}

export interface CommissionRepository {
  /** Profesionales a los que se puede poner regla (DENTIST y ADMIN vigentes, o con regla), con su regla. */
  listProfessionals(): Promise<
    {
      professional: CommissionProfessional;
      rule: CommissionRuleRecord | null;
    }[]
  >;
  /** Categorías del catálogo de la clínica (recortadas, sin repetir). */
  listCategories(): Promise<string[]>;
  /** El profesional de la clínica con ese usuario, o null. */
  findProfessional(userId: string): Promise<CommissionProfessional | null>;
  /** Crea o cambia la regla y la audita (CLINIC_SETTINGS COMMISSION_RULE) en la misma transacción. */
  saveRule(
    professional: CommissionProfessional,
    terms: CommissionRuleTerms,
    active: boolean,
    ctx: AuditRequestContext,
  ): Promise<CommissionRuleRecord>;
  /** Lecturas de la vista previa en una transacción. */
  read<T>(fn: (reader: CommissionReader) => Promise<T>): Promise<T>;
  /**
   * Cierra con el candado del profesional tomado: `prepare` calcula con el
   * lector de la MISMA transacción y devuelve la liquidación (o lanza). Inserta
   * la cabecera y las líneas, sube el cierre contable hasta el «hasta» (nunca
   * lo retrocede) y audita, todo junto.
   */
  close(
    membershipId: string,
    prepare: (reader: CommissionReader) => Promise<NewSettlement>,
    ctx: AuditRequestContext,
  ): Promise<ClosedSettlement>;
  listSettlements(filter: {
    userId?: string;
    limit: number;
  }): Promise<CommissionSettlementSummary[]>;
  getSettlement(id: string): Promise<{
    summary: CommissionSettlementSummary;
    categoryPercents: CommissionCategoryPercent[];
    lines: CommissionLineView[];
  } | null>;
}
