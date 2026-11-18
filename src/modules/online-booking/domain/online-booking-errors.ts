import { ConflictException } from '@nestjs/common';

/**
 * DX-016: mensajes de la página pública de reserva. Uno solo para «no hay
 * reserva online aquí» (desactivada, clínica desconocida o host sin clínica):
 * no dice cuál de las tres.
 */
export const ONLINE_BOOKING_MESSAGES = {
  unavailable: 'La reserva online no está disponible en esta clínica.',
  invalidOption:
    'Esa opción ya no está disponible. Vuelve a elegir sede, tratamiento y profesional.',
  slotTaken:
    'Ese hueco se acaba de ocupar. Elige otra hora: las demás siguen disponibles.',
  slotGone:
    'Esa hora ya no está disponible. Elige otra de la lista actualizada.',
  badRequest:
    'No pudimos procesar tu reserva. Revisa los datos y vuelve a intentarlo.',
  tooFast:
    'Has completado el formulario demasiado rápido. Espera unos segundos y vuelve a enviarlo.',
  formExpired:
    'El formulario caducó. Recarga la página y vuelve a elegir tu hora.',
  challengeFailed:
    'No pudimos comprobar que no eres un robot. Vuelve a intentarlo.',
  codeSent:
    'Si los datos coinciden con una ficha de la clínica, te enviamos un código de 6 dígitos a ese email. Caduca en 10 minutos.',
  codeInvalid: 'El código no es correcto o caducó. Revísalo o pide uno nuevo.',
  sessionInvalid:
    'Tu verificación caducó. Vuelve a identificarte para reservar.',
  noPolicy:
    'La clínica todavía no puede recibir pacientes nuevos por internet. Llámala para pedir tu cita.',
  outdatedPolicy:
    'La política de tratamiento de datos cambió mientras reservabas. Recarga la página para ver la versión vigente.',
  consentRequired:
    'Para reservar como paciente nuevo tienes que aceptar el tratamiento de tus datos.',
  requestNotFound: 'Solicitud no encontrada',
  requestNotPending: 'Esta solicitud ya se resolvió.',
} as const;

/** Código del 409 de dos reservas del mismo hueco a la vez. */
export const ONLINE_SLOT_TAKEN_CODE = 'ONLINE_SLOT_TAKEN';

export class OutdatedPolicyError extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      error: 'Conflict',
      code: 'PRIVACY_POLICY_OUTDATED',
      message: ONLINE_BOOKING_MESSAGES.outdatedPolicy,
    });
  }
}

/** La sesión ya reservó (dos envíos a la vez con la misma). */
export class SessionAlreadyUsedError extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      error: 'Conflict',
      code: 'ONLINE_SESSION_USED',
      message:
        'Esta verificación ya se usó para una reserva. Vuelve a identificarte para reservar otra.',
    });
  }
}
