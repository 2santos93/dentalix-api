import { phoneInternational, type PhoneRegion } from './phone-number';

/**
 * DX-387: lo que muestra la web de un teléfono guardado, `phoneInternational
 * ?? phone`. El formato es el del adaptador, leído con la región de la sede
 * que corresponda; quien llama la resuelve UNA vez por petición y la pasa
 * aquí, nunca una lectura por fila.
 */
export type WithPhoneInternational<T> = T & {
  phoneInternational: string | null;
};

export function withPhoneInternational<T extends { phone: string | null }>(
  item: T,
  region: PhoneRegion | null,
): WithPhoneInternational<T> {
  return {
    ...item,
    phoneInternational: phoneInternational(item.phone, region),
  };
}

/** Descripción Swagger común del campo (DX-387). */
export const PHONE_INTERNATIONAL_DOC =
  'DX-387: el teléfono en formato internacional de la librería, con su extensión, leído con la región por defecto de la sede (la activa o la principal; en una sede, la suya). null si no hay teléfono o no se puede leer de una sola forma: la web muestra entonces `phone` tal cual.';
