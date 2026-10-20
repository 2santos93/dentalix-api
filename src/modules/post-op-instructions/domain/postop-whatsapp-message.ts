/**
 * Mensaje de WhatsApp con el enlace a las indicaciones. A propósito NO recibe
 * el título ni el texto de la plantilla: el procedimiento del paciente no debe
 * viajar en un canal de mensajería, solo el enlace.
 */
export function postOpWhatsAppMessage(input: {
  firstName: string;
  clinicName: string;
  url: string;
}): string {
  const { firstName, clinicName, url } = input;
  return `Hola ${firstName}, te saludamos de ${clinicName}. Aquí tienes tus indicaciones de cuidado tras la visita: ${url}`;
}
