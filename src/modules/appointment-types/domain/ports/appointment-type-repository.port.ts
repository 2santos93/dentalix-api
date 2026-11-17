import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { AppointmentType } from '../entities/appointment-type.entity';

// Sin `tenantId`: sale del contexto del request, nunca del cliente.
export interface CreateAppointmentTypeRepoInput {
  name: string;
  durationMinutes: number;
  color: string;
  active: boolean;
  /** DX-446: por defecto, false. */
  isUrgent?: boolean;
  /** DX-564: ya validado; por defecto, `{}`. */
  preVisitInstructions?: Record<string, string>;
  createdById?: string;
}

export interface UpdateAppointmentTypeRepoInput {
  name?: string;
  durationMinutes?: number;
  color?: string;
  active?: boolean;
  isUrgent?: boolean;
  /** DX-564: el mapa entero ya validado (sustituye al guardado). */
  preVisitInstructions?: Record<string, string>;
  updatedById?: string;
}

export const APPOINTMENT_TYPE_REPOSITORY = Symbol(
  'APPOINTMENT_TYPE_REPOSITORY',
);

export interface AppointmentTypeRepository {
  /** Tipos vivos (no retirados) de la clínica en contexto, por nombre. */
  list(params: { includeInactive: boolean }): Promise<AppointmentType[]>;
  /**
   * Tipo vivo por id, activo o no. Bajo RLS: uno de otra clínica (o retirado)
   * da `null`, igual que uno inexistente.
   */
  findById(id: string): Promise<AppointmentType | null>;
  /**
   * DX-360: alta, cambio y retiro dejan su evento (APPOINTMENT_TYPE) en la
   * misma transacción; un cambio que no cambia nada, ninguno.
   */
  create(
    input: CreateAppointmentTypeRepoInput,
    audit: AuditRequestContext,
  ): Promise<AppointmentType>;
  update(
    id: string,
    input: UpdateAppointmentTypeRepoInput,
    audit: AuditRequestContext,
  ): Promise<AppointmentType>;
  /** Borrado lógico: `deletedAt` y `active = false`. Las citas no cambian. */
  softDelete(id: string, audit: AuditRequestContext): Promise<void>;
  /**
   * DX-564: `tenants.patientLanguages` de la clínica en contexto (los idiomas
   * en que se pueden escribir las indicaciones).
   */
  patientLanguages(): Promise<string[]>;
}
