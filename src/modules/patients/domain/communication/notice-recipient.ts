import { firstNameOnly } from '../../../appointment-confirmations/application/confirmation-token';
import { isMinor } from '../responsible-parties/majority-age';

/**
 * Un responsable del paciente (DX-203) tal como lo ve la regla de destinatario.
 * El email es el del contacto o, si el responsable es otro paciente, el de su
 * ficha.
 */
export interface NoticeResponsible {
  id: string;
  /** Nombre completo (del contacto o de la ficha del paciente responsable). */
  name: string;
  email: string | null;
  isPayer: boolean;
  receivesNotices: boolean;
  /**
   * El responsable es un paciente dado de baja de los envíos automáticos
   * (DX-128): no se le mandan recordatorios automáticos.
   */
  optedOut: boolean;
}

/**
 * Con qué se cuenta la edad del paciente (DX-203, DX-328): la zona de la sede
 * da el día civil y la clínica, su mayoría de edad.
 */
export interface NoticeSettings {
  timeZone: string;
  majorityAge: number;
}

export interface NoticePatientFields {
  firstName: string;
  birthDate: Date | null;
  email: string | null;
  emergencyContactName: string | null;
}

export interface NoticeRecipientInput {
  patient: NoticePatientFields;
  /** Responsables VIVOS del paciente. */
  responsibles: readonly NoticeResponsible[];
  /** Mayoría de edad de la clínica (ver majority-age.ts). */
  majorityAge: number;
  /** Día civil (YYYY-MM-DD) de la sede. */
  today: string;
  /** Envío automático (recordatorio): respeta la baja del responsable. */
  automatic?: boolean;
}

/**
 * - RESPONSIBLE: va al email del responsable (DX-203).
 * - GUARDIAN / CONTACT: un menor sin responsable con email: va al email de
 *   la ficha, saludando al responsable o, sin él, al contacto principal
 *   (DX-128, como Dentrix Ascend).
 * - PATIENT: al propio paciente.
 */
export type NoticeRecipientKind =
  'PATIENT' | 'RESPONSIBLE' | 'GUARDIAN' | 'CONTACT';

export interface NoticeRecipient {
  kind: NoticeRecipientKind;
  /** Nombre de pila de a quien se escribe (nunca el apellido). */
  name: string | null;
  /** Adónde va; null = no hay a quién mandarlo por email. */
  email: string | null;
  minor: boolean;
  /** El responsable que lo recibe (RESPONSIBLE y GUARDIAN). */
  responsiblePartyId: string | null;
}

const clean = (email: string | null): string | null => email?.trim() || null;

/**
 * Regla de destinatario de los avisos (DX-203): el recordatorio de cita
 * (DX-026), el recibo de caja (DX-136) y el estado de cuenta (DX-011) de un
 * paciente MENOR (por debajo de la mayoría de edad de la clínica, en el día
 * civil de la sede) o SIN email van al responsable que recibe avisos y tiene
 * email; primero el pagador principal y luego por orden de alta. Si no hay
 * ninguno, al email de la ficha (si lo hay). Un adulto con email recibe los
 * suyos.
 *
 * El canal y la baja del PACIENTE (DX-128) los aplica antes quien envía
 * (reminder-eligibility.ts): esto solo decide a quién.
 */
export function noticeRecipient(input: NoticeRecipientInput): NoticeRecipient {
  const { patient } = input;
  const minor = isMinor(patient.birthDate, input.majorityAge, input.today);
  const own = clean(patient.email);
  const candidates = input.responsibles
    .filter((r) => r.receivesNotices && !(input.automatic && r.optedOut))
    .sort((a, b) => Number(b.isPayer) - Number(a.isPayer));

  if (minor || !own) {
    const reachable = candidates.find((r) => clean(r.email));
    if (reachable) {
      return {
        kind: 'RESPONSIBLE',
        name: firstNameOnly(reachable.name),
        email: clean(reachable.email),
        minor,
        responsiblePartyId: reachable.id,
      };
    }
  }
  if (minor) {
    const named = candidates[0];
    if (named) {
      return {
        kind: 'GUARDIAN',
        name: firstNameOnly(named.name),
        email: own,
        minor,
        responsiblePartyId: named.id,
      };
    }
    const contact = firstNameOnly(patient.emergencyContactName);
    if (contact) {
      return {
        kind: 'CONTACT',
        name: contact,
        email: own,
        minor,
        responsiblePartyId: null,
      };
    }
  }
  return {
    kind: 'PATIENT',
    name: firstNameOnly(patient.firstName),
    email: own,
    minor,
    responsiblePartyId: null,
  };
}
