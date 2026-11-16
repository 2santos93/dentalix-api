import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type { CivilPeriod } from '../comparison-period';
import type {
  QuoteFunnelDetailStep,
  QuoteFunnelPresentationOutcome,
  QuoteFunnelRejectionReason,
  QuoteFunnelSums,
  RejectionReasonSums,
} from '../quote-funnel';

/** Una sede que quien consulta puede ver (DX-089), viva (activa o no). */
export interface QuoteFunnelLocation {
  id: string;
  name: string;
  isActive: boolean;
}

/** Quien elaboró algún presupuesto presentado (`createdById`, miembro vivo). */
export interface QuoteFunnelProfessional {
  userId: string;
  fullName: string;
}

/**
 * A qué se acota el embudo: sedes de la PRIMERA presentación del grupo, si
 * entran las presentaciones sin sede (solo quien ve todas y sin elegir una),
 * quién lo elaboró y la moneda del catálogo (null = no se resuelve: ningún
 * importe es válido).
 */
export interface QuoteFunnelScope {
  locationIds: readonly string[];
  includeWithoutLocation: boolean;
  professionalId?: string;
  currency: string | null;
}

/** Sumas de un profesional (null = «Sin atribuir») o del total. */
export interface QuoteFunnelProfessionalSums extends QuoteFunnelSums {
  professionalId: string | null;
  professionalName: string | null;
}

export interface QuoteFunnelAggregate {
  total: QuoteFunnelSums;
  byProfessional: QuoteFunnelProfessionalSums[];
  rejectionReasons: RejectionReasonSums[];
}

export interface QuoteFunnelDetailFilter {
  step: QuoteFunnelDetailStep;
  reason?: QuoteFunnelRejectionReason;
}

/** Una presentación del detalle (importes ya en la moneda del catálogo). */
export interface QuoteFunnelPresentationRow {
  groupId: string;
  /** Los planes de la presentación: opciones y sus pendientes (DX-417). */
  planIds: string[];
  /** El plan de la primera opción presentada (el enlace a la ficha). */
  firstPlanId: string;
  /** null = paciente eliminado: no se nombra ni se enlaza. */
  patientId: string | null;
  patientName: string | null;
  presentedAt: Date;
  locationId: string | null;
  locationName: string | null;
  /** Zona de la sede (o de la principal): la fecha se pinta con ella. */
  timeZone: string;
  professionalId: string | null;
  professionalName: string | null;
  optionCount: number;
  /** null = sin tasa (o sin moneda de catálogo): fuera de los importes. */
  presentedAmount: number | null;
  acceptedAmount: number | null;
  scheduledAmount: number | null;
  doneAmount: number | null;
  collectedAmount: number | null;
  outcome: QuoteFunnelPresentationOutcome;
  rejectionReason: QuoteFunnelRejectionReason | null;
}

export const QUOTE_FUNNEL_REPOSITORY = Symbol('QUOTE_FUNNEL_REPOSITORY');

export interface QuoteFunnelRepository {
  /** Sedes vivas de la clínica que el usuario ve, en orden de creación. */
  listLocations(allowed: AllowedLocations): Promise<QuoteFunnelLocation[]>;
  /** ¿Es una sede viva de la clínica en contexto? */
  locationInClinic(locationId: string): Promise<boolean>;
  /**
   * Miembros vivos que elaboraron algún presupuesto presentado en esas sedes
   * (o sin sede, con `includeWithoutLocation`), por nombre.
   */
  listProfessionals(
    locationIds: readonly string[],
    includeWithoutLocation: boolean,
  ): Promise<QuoteFunnelProfessional[]>;
  /** El embudo del período: total, por profesional y motivos. */
  aggregate(
    period: CivilPeriod,
    scope: QuoteFunnelScope,
  ): Promise<QuoteFunnelAggregate>;
  /** Las presentaciones de un paso o desenlace, paginadas. */
  listPresentations(
    period: CivilPeriod,
    scope: QuoteFunnelScope,
    filter: QuoteFunnelDetailFilter,
    page: { skip: number; take: number },
  ): Promise<{ items: QuoteFunnelPresentationRow[]; total: number }>;
}
