import type { WaitlistPriority, WaitlistStatus } from '@prisma/client';
import type {
  WaitlistEntry,
  WaitlistPage,
} from '../entities/waitlist-entry.entity';

export const WAITLIST_REPOSITORY = Symbol('WAITLIST_REPOSITORY');

export interface ListWaitlistParams {
  status: WaitlistStatus;
  /** Sede explícita; si falta, la del request (`X-Location-Id`) o todas. */
  locationId?: string;
  page: number;
  pageSize: number;
}

export interface CreateWaitlistEntryRepoInput {
  /** Sede del alta; si falta, la del request o la sede por defecto. */
  locationId?: string;
  patientId: string;
  providerId: string | null;
  appointmentTypeId: string | null;
  durationMinutes: number;
  priority: WaitlistPriority;
  preferredWindow: string | null;
  note: string | null;
  createdById: string;
}

export interface WaitlistRepository {
  /** Urgentes primero y, dentro, la más antigua primero. */
  list(params: ListWaitlistParams): Promise<WaitlistPage>;
  findById(id: string): Promise<WaitlistEntry | null>;
  create(input: CreateWaitlistEntryRepoInput): Promise<WaitlistEntry>;
  /**
   * Descarta la entrada SOLO si sigue OPEN (a prueba de carreras). `null` si
   * ya no lo estaba.
   */
  dismiss(
    id: string,
    reason: string,
    dismissedById: string,
  ): Promise<WaitlistEntry | null>;
}
