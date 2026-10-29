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
  'registration-notice',
  'payment-receipt',
  'post-op-instructions',
] as const;
export type EmailTemplateName = (typeof EMAIL_TEMPLATES)[number];

/** Idioma de la plantilla (la app está en español). Los formatos son los de la sede (G1-B). */
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

/**
 * DX-144 (SEC-034): sin el nombre de quien pidió el alta. Cualquiera puede
 * pedirla con un email ajeno, así que el email no lleva NADA escrito por el
 * solicitante (saludo genérico).
 */
export interface EmailVerifyEmailVars {
  verifyUrl: string;
  expiresInHours: number;
}

/**
 * DX-029: alguien intentó registrar una clínica con un email que ya tiene
 * cuenta. Va al titular (nunca a quien lo intentó) y no lleva token.
 */
export interface RegistrationNoticeEmailVars {
  userName: string;
  /** Página de la web para iniciar sesión o recuperar la contraseña. */
  loginUrl: string;
}

/**
 * DX-026: recordatorio de cita. Solo lo logístico (cuándo, dónde, con quién y
 * el enlace): ni motivo de consulta ni tratamiento, que son datos clínicos.
 */
export interface AppointmentReminderEmailVars {
  /** Nombre de pila del paciente. */
  patientName: string;
  /**
   * DX-128: a quién se saluda cuando no es el paciente (un menor: su tutor o
   * contacto principal, nombre de pila). null/ausente = al paciente.
   */
  guardianName?: string | null;
  /** Fecha y hora ya formateadas en la zona de la sede ("martes 20 de octubre de 2026 a las 9:30 a. m."). */
  startsAtLabel: string;
  locationName: string;
  locationAddress: string | null;
  /** Profesional de la cita, o null si ya no se puede nombrar. */
  providerName: string | null;
  /** Enlace de confirmación (DX-005), si se emitió uno. */
  confirmUrl: string | null;
  /** Enlace de baja de los recordatorios (DX-128), si se emitió uno. */
  unsubscribeUrl: string | null;
  /**
   * DX-291: la variable `{politica_cancelacion}` del recordatorio: la política
   * VIGENTE de la sede al enviarlo (horas de aviso, texto de la clínica e
   * importe del cargo ya formateado). null/ausente = la sede no tiene
   * política (o el email es anterior a DX-291) y el bloque no sale.
   */
  cancellationPolicy?: ReminderCancellationPolicyVars | null;
}

/** DX-291: el bloque de la política de cancelación del recordatorio. */
export interface ReminderCancellationPolicyVars {
  noticeHours: number;
  /** Texto de la clínica para el paciente (puede ir vacío). */
  text: string;
  /** Importe del cargo ya formateado («50.000 COP»), o null si no hay. */
  feeLabel: string | null;
}

/**
 * DX-136: recibo de caja de un abono, sacado de la foto del recibo. El
 * documento del paciente va enmascarado; nada clínico (solo el nombre del
 * plan). Sin enlaces: el recibo va en el propio email.
 */
export interface PaymentReceiptEmailVars {
  patientName: string;
  /**
   * DX-203: va al responsable del paciente (nombre de pila): el email lo
   * saluda a él y dice de quién es el abono.
   */
  responsibleName?: string | null;
  /** `NOR-000123`, o `REC-xxxxxxxx` si es un abono «sin serie». */
  reference: string;
  legacy: boolean;
  locationName: string;
  locationAddress: string | null;
  /** «Razón social · NIT/NIF …», o null si los datos fiscales están pendientes. */
  fiscalLine: string | null;
  /** «{nombre visible} ******5678» (DX-327), o null sin documento. */
  patientDocLabel: string | null;
  amountLabel: string;
  paidOnLabel: string;
  methodLabel: string;
  /** «Plan del …» o, contra el saldo migrado, «Saldo migrado · concepto · corte …». */
  planLabel: string;
  /**
   * DX-262 (revisión N1): el abono va a un saldo migrado, no a un plan: el
   * correo dice «Concepto» y «Saldo pendiente tras este abono».
   */
  toOpeningBalance?: boolean;
  /** Saldo del plan (o pendiente del saldo migrado) tras el abono, ya formateado; null si no se conoce. */
  balanceLabel: string | null;
  cashierName: string | null;
  voided: { dateLabel: string; reason: string } | null;
  legalNotice: string;
}

/**
 * DX-222: indicaciones de cuidado tras la visita. Solo el enlace a la página
 * pública y el teléfono de la sede: ni el título ni el texto de la plantilla,
 * que nombran el procedimiento (dato clínico), viajan en el email.
 */
export interface PostOpInstructionsEmailVars {
  /** Nombre de pila del paciente. */
  patientFirstName: string;
  clinicName: string;
  /** Teléfono de la sede de la cita, o null si no tiene. */
  locationPhone: string | null;
  /** Enlace público a las indicaciones (`/indicaciones/<token>`). */
  url: string;
  /** DX-203: va al responsable (nombre de pila): se le saluda a él. */
  responsibleName: string | null;
}

export interface EmailVarsByTemplate {
  invitation: InvitationEmailVars;
  'password-reset': PasswordResetEmailVars;
  'email-verify': EmailVerifyEmailVars;
  'appointment-reminder': AppointmentReminderEmailVars;
  'registration-notice': RegistrationNoticeEmailVars;
  'payment-receipt': PaymentReceiptEmailVars;
  'post-op-instructions': PostOpInstructionsEmailVars;
}

/** Lo que el remitente produce para una plantilla: asunto, HTML y texto. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}
