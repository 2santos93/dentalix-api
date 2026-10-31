/**
 * Estado de una solicitud de firma a distancia tal como lo ve la ficha
 * (DX-243): Enviado · Abierto · Bloqueado · Caducado · Anulado · Firmado por
 * paciente · Completo (además firmó el profesional en la app). Se calcula,
 * no se guarda: caducar depende de la hora.
 */
export const SIGNATURE_REQUEST_STATUSES = [
  'SENT',
  'OPENED',
  'LOCKED',
  'EXPIRED',
  'REVOKED',
  'SIGNED_BY_PATIENT',
  'COMPLETE',
] as const;
export type SignatureRequestStatus =
  (typeof SIGNATURE_REQUEST_STATUSES)[number];

export interface SignatureStatusInput {
  expiresAt: Date;
  openedAt: Date | null;
  lockedAt: Date | null;
  revokedAt: Date | null;
  signedAt: Date | null;
  /** El consentimiento resultante ya lleva la firma del profesional. */
  countersigned: boolean;
}

export function signatureRequestStatus(
  input: SignatureStatusInput,
  now: Date,
): SignatureRequestStatus {
  if (input.signedAt) {
    return input.countersigned ? 'COMPLETE' : 'SIGNED_BY_PATIENT';
  }
  if (input.revokedAt) return 'REVOKED';
  if (input.lockedAt) return 'LOCKED';
  if (input.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return input.openedAt ? 'OPENED' : 'SENT';
}

/**
 * ¿Sirve todavía el enlace público? Caducado, usado, anulado o bloqueado
 * responden lo mismo («Enlace no válido»), sin decir cuál de ellos.
 */
export function isLinkUsable(
  input: Omit<SignatureStatusInput, 'countersigned'>,
  now: Date,
): boolean {
  const status = signatureRequestStatus(
    { ...input, countersigned: false },
    now,
  );
  return status === 'SENT' || status === 'OPENED';
}
