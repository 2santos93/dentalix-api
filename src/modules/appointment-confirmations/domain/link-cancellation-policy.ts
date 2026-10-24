import { computeCancellationNotice } from '../../cancellation-policies/domain/cancellation-policy';

/**
 * DX-291: la política de cancelación VIGENTE de la sede de la cita, tal como
 * la ve el paciente en el enlace (y en el recordatorio). Nada clínico: solo
 * las horas de aviso, el texto de la clínica y el importe sugerido.
 */
export interface LinkCancellationPolicy {
  id: string;
  version: number;
  noticeHours: number;
  patientText: string;
  suggestedFee: number | null;
  currency: string | null;
}

export const LINK_POLICY_MESSAGES = {
  acknowledgeRequired: (hours: number) =>
    `Cancelación con menos de ${hours} h de aviso: para cancelar, acepta la política de cancelación de la clínica.`,
  policyChanged:
    'La política de cancelación de la clínica cambió: vuelve a leerla antes de responder.',
} as const;

/**
 * ¿Cancelar AHORA por el enlace sería tardío? Mismo cálculo que guarda la
 * cancelación (DX-279): aviso en minutos UTC menor que las horas de la
 * política. Sin política, nunca.
 */
export function isLateLinkCancellation(
  start: Date,
  now: Date,
  policy: Pick<LinkCancellationPolicy, 'noticeHours'> | null,
): boolean {
  return computeCancellationNotice({
    start,
    cancelledAt: now,
    byKind: 'PATIENT_LINK',
    noticeHours: policy?.noticeHours ?? null,
  }).lateCancellation;
}

/**
 * Lo que impide registrar la respuesta del paciente, o `null`:
 * - POLICY_CHANGED: el paciente leyó otra versión (la página manda la que
 *   mostró) → 409, la página se recarga con la vigente;
 * - ACK_REQUIRED: cancela tarde sin aceptar la política → 400 en español.
 * Confirmar y «Quiero que me llamen» nunca piden aceptación.
 */
export function linkResponseBlock(input: {
  cancelling: boolean;
  late: boolean;
  acknowledgePolicy: boolean;
  /** La versión que mostró la página (`null` = ninguna); sin enviar = no se comprueba. */
  shownPolicyVersionId: string | null | undefined;
  currentPolicyId: string | null;
}): 'POLICY_CHANGED' | 'ACK_REQUIRED' | null {
  if (
    input.shownPolicyVersionId !== undefined &&
    input.shownPolicyVersionId !== input.currentPolicyId
  )
    return 'POLICY_CHANGED';
  if (input.cancelling && input.late && !input.acknowledgePolicy)
    return 'ACK_REQUIRED';
  return null;
}
