/**
 * Mensaje de WhatsApp con el enlace al cuestionario. Solo el saludo, la
 * clínica y el enlace: nada de salud viaja por un canal de mensajería.
 */
export function anamnesisWhatsAppMessage(input: {
  firstName: string | null;
  clinicName: string;
  url: string;
}): string {
  const greeting = input.firstName ? `Hola ${input.firstName}` : 'Hola';
  return `${greeting}, le saludamos de ${input.clinicName}. Antes de su cita, responda su cuestionario de salud aquí (el enlace es personal): ${input.url}`;
}
