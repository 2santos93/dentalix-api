import type {
  CollectionChannel,
  CollectionOutcome,
  PaymentPromiseStatus,
} from '@prisma/client';
import type { PromisePayment } from './payment-promise-rule';

/*
 * Cobranza (DX-150): lo que recepción registra al gestionar el cobro de un
 * paciente. Sin datos clínicos: canal, resultado, una nota administrativa
 * corta, importes y fechas.
 */

export const COLLECTION_NOTE_TEXT_MAX = 280;

export interface StaffRef {
  id: string;
  /** `null` si ya no es resoluble (usuario fuera de la clínica). */
  fullName: string | null;
}

export interface CollectionNoteView {
  id: string;
  patientId: string;
  locationId: string | null;
  channel: CollectionChannel;
  outcome: CollectionOutcome;
  text: string | null;
  author: StaffRef;
  createdAt: Date;
}

export interface PaymentPromiseView {
  id: string;
  patientId: string;
  locationId: string;
  amount: number;
  currency: string;
  /** Día civil (YYYY-MM-DD) en la zona de la sede. */
  dueDate: string;
  status: PaymentPromiseStatus;
  createdBy: StaffRef;
  createdAt: Date;
  settledAt: Date | null;
  /** Lo cubierto por los abonos que cuentan (regla de payment-promise-rule.ts). */
  covered: number;
}

/** Un compromiso tal como sale de la BD, con la zona de su sede. */
export interface PaymentPromiseRow extends Omit<PaymentPromiseView, 'covered'> {
  timeZone: string;
}

export interface PatientCollections {
  notes: CollectionNoteView[];
  promises: PaymentPromiseView[];
}

export interface PatientCollectionRows {
  notes: CollectionNoteView[];
  promises: PaymentPromiseRow[];
}

/** Un compromiso abierto con lo necesario para evaluarlo. */
export interface OpenPromise {
  id: string;
  patientId: string;
  amount: number;
  currency: string;
  dueDate: string;
  createdAt: Date;
  /** Zona IANA de la sede del compromiso. */
  timeZone: string;
}

export interface PatientPayment extends PromisePayment {
  patientId: string;
}

export interface NewCollectionNote {
  patientId: string;
  locationId: string | null;
  channel: CollectionChannel;
  outcome: CollectionOutcome;
  text: string | null;
  authorId: string;
}

export interface NewPaymentPromise {
  patientId: string;
  locationId: string;
  amount: number;
  currency: string;
  dueDate: string;
  createdById: string;
}
