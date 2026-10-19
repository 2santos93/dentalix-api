export type PostOpDeliveryChannel = 'PRINT' | 'EMAIL' | 'WHATSAPP_LINK';

/**
 * Espejo plano de `PostOpInstructionDelivery`. Inalterable en BD: solo
 * `firstOpenedAt` pasa de null a la primera apertura del enlace público.
 */
export interface PostOpDelivery {
  id: string;
  tenantId: string;
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
  deliveredAt: Date;
  recipientMasked: string | null;
  sentToResponsible: boolean;
  tokenHash: string | null;
  tokenExpiresAt: Date | null;
  firstOpenedAt: Date | null;
  createdAt: Date;
}
