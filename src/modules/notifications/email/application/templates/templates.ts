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
  RegistrationNoticeEmailVars,
  RenderedEmail,
} from '../../domain/email-message';
import { EmailBlock, renderLayout } from './layout';

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

function appointmentReminder(
  vars: AppointmentReminderEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  const clinic = brand?.clinicName ?? PRODUCT_NAME;
  const where = vars.locationAddress
    ? `${vars.locationName} (${vars.locationAddress})`
    : vars.locationName;
  const blocks: EmailBlock[] = [
    { kind: 'paragraph', text: `Te recordamos tu cita en ${clinic}.` },
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
  return renderLayout({
    brand,
    subject: `Recordatorio de tu cita en ${clinic}`,
    heading: `Hola, ${vars.patientName}`,
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
  const blocks: EmailBlock[] = [
    {
      kind: 'paragraph',
      text: `Te enviamos el recibo de tu abono en ${clinic}.`,
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
    { kind: 'paragraph', text: `Plan: ${vars.planLabel}` },
  );
  if (vars.balanceLabel) {
    blocks.push({
      kind: 'paragraph',
      text: `Saldo del plan tras el abono: ${vars.balanceLabel}`,
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
    heading: `Hola, ${vars.patientName}`,
    blocks,
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
