import { OutgoingEmail } from '../email-message';

export const MAILER = Symbol('MAILER');

/**
 * Puerto de salida hacia el proveedor de email. Lanza si el proveedor no
 * aceptó el mensaje; el despachador decide si reintenta.
 */
export interface Mailer {
  send(message: OutgoingEmail): Promise<void>;
}
