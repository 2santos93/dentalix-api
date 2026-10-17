import type {
  ContactChannel,
  WaitlistOfferChannel,
  WaitlistOfferOutcome,
} from '@prisma/client';
import type { AppointmentTypeSummary } from '../../../appointment-types/domain/entities/appointment-type.entity';
import type {
  AppointmentCandidateSource,
  EntryCandidateSource,
} from '../opening-candidates';

export const OPENING_CANDIDATES_REPOSITORY = Symbol(
  'OPENING_CANDIDATES_REPOSITORY',
);

/** El paciente de un candidato: nombre y contacto (DX-128), nada clínico. */
export interface CandidatePatient {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  contactChannel: ContactChannel;
  reminderOptOutAt: Date | null;
  /** DX-128: permiso de WhatsApp; sin él no se le ofrece por WhatsApp. */
  whatsappOptInAt: Date | null;
}

export interface EntryCandidateRow extends EntryCandidateSource {
  patient: CandidatePatient;
  appointmentType: AppointmentTypeSummary | null;
  preferredWindow: string | null;
  note: string | null;
}

export interface AppointmentCandidateRow extends AppointmentCandidateSource {
  patient: CandidatePatient;
  appointmentType: AppointmentTypeSummary | null;
  reason: string | null;
}

/** Oferta de un hueco libre a un candidato (DX-210). */
export interface WaitlistOffer {
  id: string;
  locationId: string;
  slotStart: Date;
  slotEnd: Date;
  providerId: string;
  patientId: string;
  waitlistEntryId: string | null;
  appointmentId: string | null;
  channel: WaitlistOfferChannel;
  outcome: WaitlistOfferOutcome;
  /** Día civil (YYYY-MM-DD) de la oferta en la zona de la sede. */
  offerDay: string;
  createdById: string;
  outcomeById: string | null;
  outcomeAt: Date | null;
  createdAt: Date;
}

export interface CreateWaitlistOfferRepoInput {
  locationId: string;
  slotStart: Date;
  slotEnd: Date;
  providerId: string;
  patientId: string;
  waitlistEntryId: string | null;
  appointmentId: string | null;
  channel: WaitlistOfferChannel;
  outcome: WaitlistOfferOutcome;
  offerDay: string;
  createdById: string;
}

export interface OfferSummary {
  /** Ofertas de hoy (zona de la sede) al paciente, en cualquier hueco. */
  today: number;
  /** Ya se le ofreció ESTE hueco («aviso enviado»). */
  forSlot: boolean;
  /** La última oferta de ESTE hueco aún sin respuesta (para anotarla). */
  pendingOfferId: string | null;
}

/** Lo que se comprueba antes de ofrecer: de quién es y si sigue vigente. */
export interface OfferTarget {
  patientId: string;
  locationId: string;
  /** Pendiente OPEN o cita marcada y agendada/confirmada. */
  active: boolean;
}

export interface OpeningCandidatesRepository {
  /**
   * Pendientes OPEN de la sede, de pacientes no archivados, con duración
   * menor o igual a `maxDurationMinutes` (lo grueso; la regla fina es de
   * `rankOpeningCandidates`).
   */
  listOpenEntries(params: {
    locationId: string;
    maxDurationMinutes: number;
  }): Promise<EntryCandidateRow[]>;
  /**
   * Citas vivas de la sede marcadas «Adelantar si hay hueco», agendadas o
   * confirmadas, que empiezan desde `from` (el día civil siguiente al hueco),
   * del profesional si se indica.
   */
  listWantsEarlier(params: {
    locationId: string;
    from: Date;
    providerId: string | null;
  }): Promise<AppointmentCandidateRow[]>;
  /** Ofertas de hoy y del hueco por paciente (los que no tienen, no salen). */
  offersSummary(params: {
    patientIds: string[];
    offerDay: string;
    locationId: string;
    slotStart: Date;
    slotEnd: Date;
  }): Promise<Map<string, OfferSummary>>;
  /** Contacto del paciente vivo de esta clínica, o `null`. */
  patientContact(patientId: string): Promise<CandidatePatient | null>;
  entryTarget(id: string): Promise<OfferTarget | null>;
  appointmentTarget(id: string): Promise<OfferTarget | null>;
  /**
   * Registra la oferta si el paciente lleva menos de `cap` ofertas en
   * `offerDay`. Cuenta e inserta bajo un candado por paciente: dos ofertas a
   * la vez no pasan las dos del tope. `null` = tope alcanzado.
   */
  createOffer(
    input: CreateWaitlistOfferRepoInput,
    cap: number,
  ): Promise<{ offer: WaitlistOffer; offersToday: number } | null>;
  findOffer(id: string): Promise<WaitlistOffer | null>;
  /** Anota el resultado SOLO si sigue PENDING; `null` si ya tenía. */
  recordOutcome(
    id: string,
    outcome: Exclude<WaitlistOfferOutcome, 'PENDING'>,
    byId: string,
  ): Promise<WaitlistOffer | null>;
}
