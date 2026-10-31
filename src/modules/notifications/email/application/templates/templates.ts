import {
  AppointmentReminderEmailVars,
  EmailBrand,
  EmailLocale,
  EmailTemplateName,
  EmailVarsByTemplate,
  EmailVerifyEmailVars,
  InvitationEmailVars,
  PasswordResetEmailVars,
  PaymentReceiptEmailVars,
  PostOpInstructionsEmailVars,
  RegistrationNoticeEmailVars,
  ReminderCancellationPolicyVars,
  RenderedEmail,
  SignatureCodeEmailVars,
  SignatureRequestEmailVars,
} from '../../domain/email-message';
import { EmailBlock, renderLayout } from './layout';
import { endSentence } from '../../../../../shared/format/end-sentence';

const PRODUCT_NAME = 'Dentalix';

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

function invitation(
  vars: InvitationEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  const clinic = brand?.clinicName ?? PRODUCT_NAME;
  return renderLayout({
    brand,
    subject: `Te invitaron a unirte a ${clinic}`,
    heading: `Hola, ${vars.inviteeName}`,
    blocks: [
      {
        kind: 'paragraph',
        text: `${clinic} te invitó a unirte a su equipo en ${PRODUCT_NAME} con el rol de ${vars.roleLabel}.`,
      },
      {
        kind: 'paragraph',
        text: 'Para aceptar, abre el enlace y crea tu contraseña (o entra con la tuya si ya tienes cuenta).',
      },
      {
        kind: 'note',
        text: `El enlace caduca en ${plural(vars.expiresInDays, 'día', 'días')} y solo sirve una vez. Si no esperabas esta invitación, ignora este correo.`,
      },
    ],
    action: { label: 'Aceptar invitación', url: vars.acceptUrl },
  });
}

function passwordReset(
  vars: PasswordResetEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  return renderLayout({
    brand,
    subject: 'Restablece tu contraseña',
    heading: `Hola, ${vars.userName}`,
    blocks: [
      {
        kind: 'paragraph',
        text: 'Recibimos una solicitud para restablecer la contraseña de tu cuenta.',
      },
      {
        kind: 'note',
        text: `El enlace caduca en ${plural(vars.expiresInMinutes, 'minuto', 'minutos')}. Si no lo pediste tú, ignora este correo: tu contraseña no cambia.`,
      },
    ],
    action: { label: 'Restablecer contraseña', url: vars.resetUrl },
  });
}

function emailVerify(
  vars: EmailVerifyEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  return renderLayout({
    brand,
    subject: 'Confirma tu correo electrónico',
    heading: 'Hola:',
    blocks: [
      {
        kind: 'paragraph',
        text: 'Confirma que este correo es tuyo para terminar de configurar tu cuenta.',
      },
      {
        kind: 'note',
        text: `El enlace caduca en ${plural(vars.expiresInHours, 'hora', 'horas')}. Para confirmar te pediremos la contraseña que elegiste. Si no has pedido crear una clínica en Dentalix, ignora este correo.`,
      },
    ],
    action: { label: 'Confirmar correo', url: vars.verifyUrl },
  });
}

function registrationNotice(
  vars: RegistrationNoticeEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  return renderLayout({
    brand,
    subject: 'Intento de registro con tu correo',
    heading: `Hola, ${vars.userName}`,
    blocks: [
      {
        kind: 'paragraph',
        text: `Alguien intentó registrar una clínica nueva en ${PRODUCT_NAME} con este correo, que ya tiene una cuenta. No creamos nada nuevo.`,
      },
      {
        kind: 'note',
        text: 'Si eras tú, inicia sesión en tu clínica o recupera tu contraseña desde la pantalla de inicio de sesión. Si no fuiste tú, ignora este correo: tu cuenta no cambia.',
      },
    ],
    action: { label: 'Ir a Dentalix', url: vars.loginUrl },
  });
}

/**
 * DX-291: el texto de `{politica_cancelacion}` en el recordatorio: cuántas
 * horas de aviso pide la sede, el texto de la clínica y el cargo, si lo hay.
 */
export function cancellationPolicyText(
  policy: ReminderCancellationPolicyVars,
): string {
  const parts = [
    `Política de cancelación: si no puedes asistir, avísanos con al menos ${policy.noticeHours} h de antelación.`,
  ];
  const text = policy.text.trim();
  if (text) parts.push(text);
  if (policy.feeLabel)
    parts.push(
      // Algunos símbolos de moneda ya acaban en punto («ج.م.»).
      endSentence(
        `La inasistencia o la cancelación con menos aviso puede tener un cargo de ${policy.feeLabel}`,
      ),
    );
  return parts.join(' ');
}

function appointmentReminder(
  vars: AppointmentReminderEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  const clinic = brand?.clinicName ?? PRODUCT_NAME;
  const where = vars.locationAddress
    ? `${vars.locationName} (${vars.locationAddress})`
    : vars.locationName;
  // DX-128: la de un menor va a su tutor: se le saluda y se nombra al paciente.
  const guardian = vars.guardianName?.trim() || null;
  const whose = guardian ? `la cita de ${vars.patientName}` : 'tu cita';
  const blocks: EmailBlock[] = [
    { kind: 'paragraph', text: `Te recordamos ${whose} en ${clinic}.` },
    {
      kind: 'paragraph',
      text: `Fecha y hora: ${vars.startsAtLabel} (hora de la sede)`,
    },
    { kind: 'paragraph', text: `Sede: ${where}` },
  ];
  if (vars.providerName) {
    blocks.push({
      kind: 'paragraph',
      text: `Profesional: ${vars.providerName}`,
    });
  }
  blocks.push({
    kind: 'note',
    text: vars.confirmUrl
      ? 'Usa el botón para confirmarla o avisarnos si no puedes asistir.'
      : 'Si no puedes asistir, avísanos con tiempo para darle el espacio a otro paciente.',
  });
  if (vars.cancellationPolicy) {
    blocks.push({
      kind: 'note',
      text: cancellationPolicyText(vars.cancellationPolicy),
    });
  }
  return renderLayout({
    brand,
    subject: `Recordatorio de ${whose} en ${clinic}`,
    heading: `Hola, ${guardian ?? vars.patientName}`,
    blocks,
    action: vars.confirmUrl
      ? { label: 'Confirmar o cancelar', url: vars.confirmUrl }
      : null,
    footerLink: vars.unsubscribeUrl
      ? {
          lead: '¿No quieres recibir más recordatorios?',
          label: 'Dejar de recibir recordatorios',
          url: vars.unsubscribeUrl,
        }
      : null,
  });
}

function paymentReceipt(
  vars: PaymentReceiptEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  const clinic = brand?.clinicName ?? PRODUCT_NAME;
  const where = vars.locationAddress
    ? `${vars.locationName} (${vars.locationAddress})`
    : vars.locationName;
  const responsible = vars.responsibleName?.trim() || null;
  const blocks: EmailBlock[] = [
    {
      kind: 'paragraph',
      text: responsible
        ? `Te enviamos el recibo del abono de ${vars.patientName} en ${clinic}.`
        : `Te enviamos el recibo de tu abono en ${clinic}.`,
    },
    {
      kind: 'paragraph',
      text: vars.legacy
        ? `Recibo de caja N.º ${vars.reference} (abono anterior a la numeración consecutiva: sin serie).`
        : `Recibo de caja N.º ${vars.reference}`,
    },
  ];
  if (vars.voided) {
    blocks.push({
      kind: 'paragraph',
      text: `ANULADO el ${vars.voided.dateLabel}. Motivo: ${vars.voided.reason}`,
    });
  }
  if (vars.patientDocLabel) {
    blocks.push({
      kind: 'paragraph',
      text: `Documento: ${vars.patientDocLabel}`,
    });
  }
  blocks.push(
    {
      kind: 'paragraph',
      text: `Valor: ${vars.amountLabel} · ${vars.methodLabel} · ${vars.paidOnLabel}`,
    },
    {
      kind: 'paragraph',
      text: `${vars.toOpeningBalance ? 'Concepto' : 'Plan'}: ${vars.planLabel}`,
    },
  );
  if (vars.balanceLabel) {
    blocks.push({
      kind: 'paragraph',
      text: `${vars.toOpeningBalance ? 'Saldo pendiente tras este abono' : 'Saldo del plan tras el abono'}: ${vars.balanceLabel}`,
    });
  }
  blocks.push({ kind: 'paragraph', text: `Sede: ${where}` });
  if (vars.cashierName) {
    blocks.push({ kind: 'paragraph', text: `Recibió: ${vars.cashierName}` });
  }
  blocks.push(
    { kind: 'note', text: vars.fiscalLine ?? 'Datos fiscales pendientes' },
    { kind: 'note', text: vars.legalNotice },
  );
  return renderLayout({
    brand,
    subject: `Recibo de caja ${vars.reference}${vars.voided ? ' (ANULADO)' : ''} · ${clinic}`,
    heading: `Hola, ${responsible ?? vars.patientName}`,
    blocks,
    action: null,
  });
}

function postOpInstructions(
  vars: PostOpInstructionsEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  // La clínica sale de las variables (la del contexto), no de `brand`, que
  // puede faltar.
  const clinic = vars.clinicName;
  const responsible = vars.responsibleName?.trim() || null;
  const blocks: EmailBlock[] = [
    {
      kind: 'paragraph',
      text: responsible
        ? `Te enviamos las indicaciones de cuidado de ${vars.patientFirstName} tras su visita a ${clinic}.`
        : `Te enviamos tus indicaciones de cuidado tras tu visita a ${clinic}.`,
    },
  ];
  const phone = vars.locationPhone?.trim() || null;
  if (phone) {
    blocks.push({
      kind: 'note',
      text: `Si tienes dudas, llama a la sede al ${phone}.`,
    });
  }
  return renderLayout({
    brand,
    subject: `Indicaciones de ${clinic}`,
    heading: `Hola, ${responsible ?? vars.patientFirstName}`,
    blocks,
    action: { label: 'Ver indicaciones', url: vars.url },
  });
}

function signatureRequest(
  vars: SignatureRequestEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  const clinic = vars.clinicName;
  const patient = vars.patientFirstName?.trim() || null;
  return renderLayout({
    brand,
    subject: `${clinic} te envió un documento para firmar`,
    heading: `Hola, ${vars.recipientFirstName}`,
    blocks: [
      {
        kind: 'paragraph',
        text: patient
          ? `${clinic} te envió un documento de ${patient} para que lo leas y lo firmes desde tu teléfono o tu computador.`
          : `${clinic} te envió un documento para que lo leas y lo firmes desde tu teléfono o tu computador.`,
      },
      {
        kind: 'paragraph',
        text: 'Al abrir el enlace te pediremos un código de 6 dígitos que te enviaremos a este mismo correo.',
      },
      {
        kind: 'note',
        text: `El enlace caduca el ${vars.expiresAtLabel} y solo sirve una vez. Si no esperabas este correo, no lo abras y avisa a la clínica.`,
      },
    ],
    action: { label: 'Ver y firmar', url: vars.url },
  });
}

function signatureCode(
  vars: SignatureCodeEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  return renderLayout({
    brand,
    subject: `Tu código para firmar en ${vars.clinicName}`,
    heading: `Hola, ${vars.recipientFirstName}`,
    blocks: [
      { kind: 'paragraph', text: `Tu código de verificación es: ${vars.code}` },
      {
        kind: 'note',
        text: `Caduca en ${plural(vars.expiresInMinutes, 'minuto', 'minutos')}. No lo compartas con nadie: la clínica nunca te lo pedirá. Si no lo pediste tú, ignora este correo.`,
      },
    ],
    action: null,
  });
}

type Renderer<T extends EmailTemplateName> = (
  vars: EmailVarsByTemplate[T],
  brand: EmailBrand | null,
) => RenderedEmail;

const RENDERERS: { [T in EmailTemplateName]: Renderer<T> } = {
  invitation,
  'password-reset': passwordReset,
  'email-verify': emailVerify,
  'appointment-reminder': appointmentReminder,
  'registration-notice': registrationNotice,
  'payment-receipt': paymentReceipt,
  'post-op-instructions': postOpInstructions,
  'signature-request': signatureRequest,
  'signature-code': signatureCode,
};

/**
 * Renderiza una plantilla en el idioma pedido (hoy solo `es`). La marca de la
 * clínica firma el email cuando hay tenant; sin ella firma Dentalix.
 */
export function renderEmail<T extends EmailTemplateName>(
  template: T,
  vars: EmailVarsByTemplate[T],
  brand: EmailBrand | null,
  locale: EmailLocale = 'es',
): RenderedEmail {
  if (locale !== 'es') {
    throw new Error(`Idioma de email no soportado: ${String(locale)}`);
  }
  const render = RENDERERS[template] as Renderer<T>;
  return render(vars, brand);
}
