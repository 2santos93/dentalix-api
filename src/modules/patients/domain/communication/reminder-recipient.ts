import { firstNameOnly } from '../../../appointment-confirmations/application/confirmation-token';
import { ageInYears } from '../../../odontogram/domain/dentition';

/** Mayoría de edad en los países de las sedes (CO y ES). */
export const ADULT_AGE = 18;

/**
 * A quién van dirigidos los avisos automáticos del paciente (DX-128, como
 * Dentrix Ascend): un menor los recibe a nombre de su tutor o, sin tutor, de
 * su contacto principal (el de emergencia); si no hay ninguno, a su nombre.
 * El correo y el móvil son los de la ficha (para un menor suelen ser los del
 * tutor): esto decide a quién se saluda y se explica, no otra dirección.
 */
export interface ReminderRecipient {
  kind: 'PATIENT' | 'GUARDIAN' | 'CONTACT';
  /** Nombre de pila de a quien se escribe (nunca el apellido). */
  name: string | null;
  minor: boolean;
}

export interface RecipientPatientFields {
  firstName: string;
  birthDate: Date | null;
  guardianName: string | null;
  emergencyContactName: string | null;
}

/**
 * `birthDate` es una fecha civil (medianoche UTC en la BD); la edad se cuenta
 * en el día UTC de `now` (la diferencia con el día de la sede son horas, el
 * día del cumpleaños).
 */
export function reminderRecipient(
  patient: RecipientPatientFields,
  now: Date,
): ReminderRecipient {
  const minor =
    patient.birthDate !== null &&
    ageInYears(
      patient.birthDate.toISOString().slice(0, 10),
      now.toISOString().slice(0, 10),
    ) < ADULT_AGE;
  if (minor) {
    const guardian = firstNameOnly(patient.guardianName);
    if (guardian) return { kind: 'GUARDIAN', name: guardian, minor };
    const contact = firstNameOnly(patient.emergencyContactName);
    if (contact) return { kind: 'CONTACT', name: contact, minor };
  }
  return { kind: 'PATIENT', name: firstNameOnly(patient.firstName), minor };
}
