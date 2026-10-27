import type { ClinicCountry, ContactChannel } from '@prisma/client';
import type { NoticeResponsible } from '../../../patients/domain/communication/notice-recipient';
import type {
  PostOpDelivery,
  PostOpDeliveryChannel,
} from '../entities/post-op-delivery.entity';

/**
 * Lo que una entrega necesita saber de la cita (DX-222), leído bajo RLS: una
 * cita de otra clínica (o retirada) no existe.
 */
export interface PostOpAppointmentContext {
  appointment: {
    id: string;
    patientId: string;
    locationId: string;
    appointmentTypeId: string | null;
    start: Date;
    /** Nombre del profesional de la cita (`{{profesional}}`). */
    providerName: string;
  };
  patient: {
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    birthDate: Date | null;
    emergencyContactName: string | null;
    /** DX-128: baja de los envíos y canal de los avisos. */
    reminderOptOutAt: Date | null;
    contactChannel: ContactChannel;
  };
  /** Responsables VIVOS del paciente (DX-203), en orden de alta. */
  responsibles: NoticeResponsible[];
  location: {
    id: string;
    name: string;
    phone: string | null;
    country: ClinicCountry;
    /** Zona IANA de la sede. */
    timeZone: string;
    /** G1-B: formato y reloj en crudo; los exige (409) quien pinta `{{fecha}}`. */
    locale: string | null;
    hourCycle: string | null;
  };
  clinicName: string;
}

// Sin `tenantId` (sale del contexto) ni `deliveredAt` (lo pone la BD).
export interface CreatePostOpDeliveryRepoInput {
  patientId: string;
  appointmentId: string;
  locationId: string;
  templateId: string;
  templateCode: string;
  templateTitle: string;
  templateVersion: number;
  channel: PostOpDeliveryChannel;
  renderedText: string;
  deliveredById: string;
  deliveredByName: string;
  recipientMasked: string | null;
  sentToResponsible: boolean;
  /** Hash del token del enlace; el token en claro nunca llega aquí. */
  tokenHash: string | null;
  tokenExpiresAt: Date | null;
}

/** Una entrega con lo necesario para reimprimirla desde la ficha. */
export interface PostOpDeliveryDocumentView extends PostOpDelivery {
  clinic: { name: string; logoUrl: string | null; primaryColor: string | null };
  locationName: string;
  locationPhone: string | null;
  patientName: string;
}

/** Una entrega tal como la abre el paciente desde el enlace público. */
export interface PostOpPublicDeliveryView extends PostOpDelivery {
  clinic: { name: string; logoUrl: string | null; primaryColor: string | null };
  locationPhone: string | null;
}

export const POST_OP_DELIVERY_REPOSITORY = Symbol(
  'POST_OP_DELIVERY_REPOSITORY',
);

/**
 * Entregas de indicaciones postoperatorias (DX-222). Solo se registran y se
 * leen: no hay método para editarlas ni borrarlas (la BD también lo impide).
 */
export interface PostOpDeliveryRepository {
  /** `null` si la cita no es de la clínica en contexto o está retirada. */
  loadAppointmentContext(
    appointmentId: string,
  ): Promise<PostOpAppointmentContext | null>;
  /**
   * Ítems del catálogo realizados en la cita: procedimientos completados de
   * las evoluciones ligadas a ella o registrados el día civil `day` de la sede.
   */
  performedCatalogItemIds(input: {
    appointmentId: string;
    patientId: string;
    day: string;
    timeZone: string;
  }): Promise<string[]>;
  /** Nombre completo del usuario que entrega. */
  userName(userId: string): Promise<string | null>;
  create(input: CreatePostOpDeliveryRepoInput): Promise<PostOpDelivery>;
  /** Entregas de la cita, más recientes primero. */
  listByAppointment(appointmentId: string): Promise<PostOpDelivery[]>;
  /** Entregas del paciente, más recientes primero. */
  listByPatient(patientId: string): Promise<PostOpDelivery[]>;
  /** `null` si no existe, es de otro paciente o de otra clínica. */
  findForPatient(
    patientId: string,
    id: string,
  ): Promise<PostOpDeliveryDocumentView | null>;
  /** Entrega del enlace público; `null` si no existe o es de otra clínica. */
  findByTokenHash(tokenHash: string): Promise<PostOpPublicDeliveryView | null>;
  /**
   * Fija `firstOpenedAt` con la hora de la aplicación solo si seguía vacío (lo único
   * que la BD deja cambiar de una entrega, y una sola vez). `true` si la marcó.
   */
  markFirstOpened(id: string): Promise<boolean>;
}
