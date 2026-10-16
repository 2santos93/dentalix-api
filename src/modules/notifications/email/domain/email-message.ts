/**
 * Mensaje listo para entregar al proveedor. Solo vive en memoria y, cifrado,
 * en `email_outbox.payload` mientras está pendiente: NUNCA se registra en el
 * log ni se guarda en claro.
 */
export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export const EMAIL_TEMPLATES = [
  'invitation',
  'password-reset',
  'email-verify',
  'appointment-reminder',
] as const;
export type EmailTemplateName = (typeof EMAIL_TEMPLATES)[number];

/** Idiomas con plantilla. Hoy solo español (el producto es es-CO). */
export type EmailLocale = 'es';

/** Marca de la clínica que firma el email; `null` = email de plataforma. */
export interface EmailBrand {
  clinicName: string;
  /** URL absoluta http(s) del logo, o `null` si no tiene (o no es usable). */
  logoUrl: string | null;
  /** Color hex `#RRGGBB` validado, o `null` para el de Dentalix. */
  primaryColor: string | null;
}

export interface InvitationEmailVars {
  inviteeName: string;
  roleLabel: string;
  acceptUrl: string;
  expiresInDays: number;
}

export interface PasswordResetEmailVars {
  userName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export interface EmailVerifyEmailVars {
  userName: string;
  verifyUrl: string;
  expiresInHours: number;
}

export interface AppointmentReminderEmailVars {
  patientName: string;
  /** Fecha y hora ya formateadas en la zona de la sede ("lunes 20 de octubre, 9:30 a. m."). */
  startsAtLabel: string;
  locationName: string;
  locationAddress: string | null;
  /** Enlace de confirmación (DX-005), si se emitió uno. */
  confirmUrl: string | null;
}

export interface EmailVarsByTemplate {
  invitation: InvitationEmailVars;
  'password-reset': PasswordResetEmailVars;
  'email-verify': EmailVerifyEmailVars;
  'appointment-reminder': AppointmentReminderEmailVars;
}

/** Lo que el remitente produce para una plantilla: asunto, HTML y texto. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}
