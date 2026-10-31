import type { ConsentSignerType, ContactChannel } from '@prisma/client';
import { firstNameOnly } from '../../appointment-confirmations/application/confirmation-token';
import {
  noticeRecipient,
  type NoticeResponsible,
} from '../../patients/domain/communication/notice-recipient';

export const SIGNATURE_OPTED_OUT_MESSAGE =
  'El paciente dio de baja los envíos: fírmalo en la clínica.';
export const SIGNATURE_NO_EMAIL_MESSAGE =
  'El paciente no tiene email: añádelo en su ficha para enviarle el documento.';
export const SIGNATURE_MINOR_NO_RESPONSIBLE_MESSAGE =
  'El paciente es menor de edad: registra en su ficha un responsable que reciba avisos y tenga email para enviarle el documento.';

export interface SignatureRecipientInput {
  patient: {
    firstName: string;
    lastName: string;
    birthDate: Date | null;
    email: string | null;
    emergencyContactName: string | null;
    reminderOptOutAt: Date | null;
    contactChannel: ContactChannel;
    /** El documento del paciente tal como lo pinta el texto (o null). */
    document: string | null;
  };
  /** Responsables vivos, con su documento ya en texto. */
  responsibles: (NoticeResponsible & { documentText: string | null })[];
  majorityAge: number;
  /** Día civil de la sede (YYYY-MM-DD). */
  today: string;
}

export type SignatureRecipient =
  | {
      ok: true;
      signerType: ConsentSignerType;
      /** Nombre completo de quien firma (queda sellado). */
      signerName: string;
      signerDocument: string | null;
      email: string;
      /** Nombre de pila con el que se le saluda. */
      greetingName: string;
      /** Menor: el nombre de pila del paciente (el email dice de quién es). */
      patientFirstName: string | null;
      minor: boolean;
    }
  | { ok: false; reason: string };

const clean = (email: string | null): string | null => email?.trim() || null;

/**
 * A quién va la firma a distancia (DX-243). Un adulto firma por sí mismo y
 * solo con SU email (nunca se le manda a un responsable). Un menor, según la
 * mayoría de edad de la clínica (DX-328) en el día civil de la sede, firma por
 * medio de su responsable registrado (DX-203) que recibe avisos, y SOLO al
 * email del propio responsable: el código prueba que firma quien dice
 * (signerType GUARDIAN con su nombre). A diferencia de los avisos, nunca cae
 * en el email de la ficha del menor (podría ser el del propio menor). Sin
 * responsable con email no se envía. La baja de los envíos (DX-128) lo impide
 * siempre.
 */
export function resolveSignatureRecipient(
  input: SignatureRecipientInput,
): SignatureRecipient {
  const { patient } = input;
  if (patient.reminderOptOutAt !== null || patient.contactChannel === 'NONE') {
    return { ok: false, reason: SIGNATURE_OPTED_OUT_MESSAGE };
  }
  const notice = noticeRecipient({
    patient: {
      firstName: patient.firstName,
      birthDate: patient.birthDate,
      email: patient.email,
      emergencyContactName: patient.emergencyContactName,
    },
    responsibles: input.responsibles,
    majorityAge: input.majorityAge,
    today: input.today,
    automatic: false,
  });

  if (!notice.minor) {
    const email = clean(patient.email);
    if (!email) return { ok: false, reason: SIGNATURE_NO_EMAIL_MESSAGE };
    return {
      ok: true,
      signerType: 'PATIENT',
      signerName: `${patient.firstName} ${patient.lastName}`.trim(),
      signerDocument: patient.document,
      email,
      greetingName: firstNameOnly(patient.firstName) ?? patient.firstName,
      patientFirstName: null,
      minor: false,
    };
  }

  const responsible = input.responsibles.find(
    (r) => r.id === notice.responsiblePartyId,
  );
  const email = clean(notice.email);
  // Solo RESPONSIBLE: el email es el del responsable. GUARDIAN/CONTACT irían
  // al email de la ficha del menor.
  if (!responsible || !email || notice.kind !== 'RESPONSIBLE') {
    return { ok: false, reason: SIGNATURE_MINOR_NO_RESPONSIBLE_MESSAGE };
  }
  return {
    ok: true,
    signerType: 'GUARDIAN',
    signerName: responsible.name.trim(),
    signerDocument: responsible.documentText,
    email,
    greetingName: firstNameOnly(responsible.name) ?? responsible.name,
    patientFirstName: firstNameOnly(patient.firstName),
    minor: true,
  };
}
