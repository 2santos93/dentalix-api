import type {
  PatientCommunicationPatch,
  PatientCommunicationState,
} from '../ports/patient-communication-repository.port';

const sameDate = (a: Date | null, b: Date | null) =>
  a?.getTime() === b?.getTime();

/** Agrupa columnas de opt-in/baja como los campos de preferencias de la auditoría. */
export function effectiveCommunicationChanges(
  current: PatientCommunicationState,
  patch: PatientCommunicationPatch,
): string[] {
  const changed: string[] = [];
  if (patch.phone !== undefined && patch.phone !== current.phone)
    changed.push('phone');
  if (
    patch.contactChannel !== undefined &&
    patch.contactChannel !== current.contactChannel
  )
    changed.push('contactChannel');
  if (
    (patch.whatsappOptInAt !== undefined &&
      !sameDate(patch.whatsappOptInAt, current.whatsappOptInAt)) ||
    (patch.whatsappOptInSource !== undefined &&
      patch.whatsappOptInSource !== current.whatsappOptInSource) ||
    (patch.whatsappOptInById !== undefined &&
      patch.whatsappOptInById !== (current.whatsappOptInBy?.id ?? null))
  )
    changed.push('whatsappOptIn');
  if (
    (patch.reminderOptOutAt !== undefined &&
      !sameDate(patch.reminderOptOutAt, current.reminderOptOutAt)) ||
    (patch.reminderOptOutSource !== undefined &&
      patch.reminderOptOutSource !== current.reminderOptOutSource)
  )
    changed.push('reminderOptOutAt');
  return changed.sort();
}
