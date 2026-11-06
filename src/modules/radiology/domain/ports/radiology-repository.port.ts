import type {
  RadiologyLicenseCategory,
  RadiologyRecordKind,
  RadiologyRecordRecord,
} from '../entities/radiology-record.entity';

export const RADIOLOGY_REPOSITORY = Symbol('RADIOLOGY_REPOSITORY');
/** Reloj del módulo: los tests fijan «hoy» de la sede. */
export const RADIOLOGY_CLOCK = Symbol('RADIOLOGY_CLOCK');
export type RadiologyClock = () => Date;

export type RadiologyRecordStatusFilter = 'LIVE' | 'VOIDED' | 'ALL';

export interface ListRadiologyRepoParams {
  /** `undefined` = todas las sedes de la clínica (vista consolidada). */
  locationIds?: readonly string[];
  kind?: RadiologyRecordKind;
  status: RadiologyRecordStatusFilter;
  page: number;
  pageSize: number;
}

// Sin `tenantId`: sale del contexto del request, nunca del cliente.
export interface CreateRadiologyRepoInput {
  locationId: string;
  equipmentId: string | null;
  kind: RadiologyRecordKind;
  category: RadiologyLicenseCategory | null;
  reference: string | null;
  issuer: string;
  issuedOn: string;
  expiresOn: string;
  /** Miembro ACTIVO de la clínica (comprobado por el caso de uso). */
  officerUserId: string | null;
  officerName: string | null;
  notes: string | null;
  createdById: string;
}

/** El documento entero tras la edición (el caso de uso ya mezcló y validó). */
export type UpdateRadiologyRepoInput = Omit<
  CreateRadiologyRepoInput,
  'kind' | 'createdById'
> & { updatedById: string };

/**
 * DX-544: preselección de los avisos de «Mi día». Sin `tenantId`: lo pone el
 * contexto del request (y la RLS).
 */
export interface RadiologyDueRepoParams {
  /** `undefined` = todas las sedes de la clínica (vista consolidada). */
  locationIds?: readonly string[];
  /** Día civil: vence en él o antes. */
  expiresOnOrBefore: string;
}

export interface RadiologyRepository {
  /**
   * Página bajo RLS: el vencimiento más próximo primero (y el id para
   * desempatar), con `renewed` calculado contra TODOS los vivos del grupo.
   */
  list(
    params: ListRadiologyRepoParams,
  ): Promise<{ rows: RadiologyRecordRecord[]; total: number }>;
  /**
   * Los documentos VIVOS, sin renovar, de esas sedes que vencen en
   * `expiresOnOrBefore` o antes. Superconjunto: el estado exacto lo decide el
   * caso de uso con el día de cada sede.
   */
  listDueCandidates(
    params: RadiologyDueRepoParams,
  ): Promise<RadiologyRecordRecord[]>;
  /** Por id; uno de otra clínica da `null` (RLS). */
  findById(id: string): Promise<RadiologyRecordRecord | null>;
  create(input: CreateRadiologyRepoInput): Promise<RadiologyRecordRecord>;
  /** Edita SOLO si sigue vivo (condicional en la BD): `null` si se anuló. */
  update(
    id: string,
    input: UpdateRadiologyRepoInput,
  ): Promise<RadiologyRecordRecord | null>;
  /** Anula SOLO si sigue vivo: `null` si ya estaba anulado. */
  void(
    id: string,
    input: { voidedById: string; voidReason: string },
  ): Promise<RadiologyRecordRecord | null>;
}
