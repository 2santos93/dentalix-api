import type { WaitlistOfferOutcome } from '@prisma/client';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import type { PublicSlotOfferState } from '../slot-offer-link';

export const SLOT_OFFER_REPOSITORY = Symbol('SLOT_OFFER_REPOSITORY');

/**
 * DX-435: la oferta tal como la resuelve el enlace público (bajo la RLS de la
 * clínica del host). Solo lo que hace falta para decidir y pintar la página:
 * nombre de pila, cuándo, con quién y dónde. Nada clínico.
 */
export interface PublicSlotOffer {
  id: string;
  tenantId: string;
  locationId: string;
  providerId: string;
  patientId: string;
  waitlistEntryId: string | null;
  appointmentId: string | null;
  outcome: WaitlistOfferOutcome;
  expiresAt: Date | null;
  /** Cuándo se creó: para saber si otra oferta ganó el hueco después. */
  createdAt: Date;
  slotStart: Date;
  /** Cuándo terminaría la cita del candidato si acepta (su duración, no el hueco entero). */
  appointmentEnd: Date;
  patientFirstName: string;
  providerName: string | null;
  locationName: string;
  locationAddress: string | null;
  timeZone: string;
  /** Formato de la sede (locale BCP 47 y 12/24 h) para pintar la hora como ella. */
  locale: string | null;
  hourCycle: string | null;
  /** La cita que se adelantaría (solo citas «Adelantar si hay hueco»). */
  currentAppointmentStart: Date | null;
  /** Tipo de la entrada de pendientes, si sigue activo (la cita nace con él). */
  appointmentTypeId: string | null;
}

export interface ClinicBrandingRow {
  name: string;
  primaryColor: string | null;
  logoUrl: string | null;
}

/** Lo que pasó al aceptar (o rechazar) desde el enlace. */
export interface SlotOfferResolution {
  state: PublicSlotOfferState;
  /** La cita creada o movida (solo al ganar). */
  appointmentId: string | null;
}

export interface SlotOfferRepository {
  findByTokenHash(tokenHash: string): Promise<PublicSlotOffer | null>;
  findClinicBranding(): Promise<ClinicBrandingRow | null>;
  /**
   * ¿Hay ya una cita viva del profesional, o del paciente (otra que la que se
   * adelantaría), que choca con la cita que crearía la oferta?
   */
  slotTaken(offer: PublicSlotOffer): Promise<boolean>;
  /**
   * Acepta en UNA transacción, con el candado de asignación del profesional
   * (el mismo de «Agendar aquí», DX-122): relee la oferta, comprueba que siga
   * pendiente y vigente y que ninguna otra del hueco ganó, crea la cita (o
   * mueve la marcada «Adelantar si hay hueco») con el anti-solape de la BD,
   * marca la oferta ACCEPTED, las demás pendientes del hueco TAKEN_BY_OTHER y
   * lo audita todo con origen PUBLIC_LINK. Exactamente una aceptación gana.
   */
  accept(
    offer: PublicSlotOffer,
    now: Date,
    meta: AuditRequestMeta,
  ): Promise<SlotOfferResolution>;
  /** Clínicas vivas (el barrido de caducadas las recorre todas). */
  tenantIds(): Promise<string[]>;
  /**
   * Barrido: pasa a EXPIRED (auditado, SLOT_OFFER_EXPIRED) hasta `limit`
   * ofertas con enlace PENDING de la clínica cuyo `expiresAt` ya pasó.
   * Devuelve cuántas cambió.
   */
  expireDue(tenantId: string, now: Date, limit: number): Promise<number>;
  /** Rechaza si sigue pendiente y vigente (si caducó, la marca EXPIRED). */
  decline(
    offer: PublicSlotOffer,
    now: Date,
    meta: AuditRequestMeta,
  ): Promise<SlotOfferResolution>;
}
