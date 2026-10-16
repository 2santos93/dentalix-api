import {
  AppointmentReminderEmailVars,
  EmailBrand,
  EmailLocale,
  EmailTemplateName,
  EmailVarsByTemplate,
  EmailVerifyEmailVars,
  InvitationEmailVars,
  PasswordResetEmailVars,
  RenderedEmail,
} from '../../domain/email-message';
import { renderLayout } from './layout';

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
    heading: `Hola, ${vars.userName}`,
    blocks: [
      {
        kind: 'paragraph',
        text: 'Confirma que este correo es tuyo para terminar de configurar tu cuenta.',
      },
      {
        kind: 'note',
        text: `El enlace caduca en ${plural(vars.expiresInHours, 'hora', 'horas')}. Si no creaste una cuenta, ignora este correo.`,
      },
    ],
    action: { label: 'Confirmar correo', url: vars.verifyUrl },
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
  return renderLayout({
    brand,
    subject: `Recordatorio de tu cita en ${clinic}`,
    heading: `Hola, ${vars.patientName}`,
    blocks: [
      {
        kind: 'paragraph',
        text: `Te recordamos tu cita el ${vars.startsAtLabel} en ${where}.`,
      },
      {
        kind: 'note',
        text: vars.confirmUrl
          ? 'Usa el botón para confirmarla o avisarnos si no puedes asistir.'
          : 'Si no puedes asistir, avísanos con tiempo para darle el espacio a otro paciente.',
      },
    ],
    action: vars.confirmUrl
      ? { label: 'Confirmar o cancelar', url: vars.confirmUrl }
      : null,
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
