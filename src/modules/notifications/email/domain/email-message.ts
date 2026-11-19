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
  'payment-receipt-summary',
  'post-op-instructions',
  'signature-request',
  'signature-code',
  'signature-budget-accepted',
  'slot-offer',
  'signed-consent-copy',
  'prescription-copy',
  'mfa-notice',
  'mfa-enrollment-code',
  'payment-link',
  'payment-report-rejected',
  'external-order-copy',
  'weekly-digest',
  'quote-follow-up',
  'new-login',
  'online-booking-code',
  'online-booking-received',
] as const;
export type EmailTemplateName = (typeof EMAIL_TEMPLATES)[number];

/**
 * DX-149-quater: si un correo de clínica gasta su tope diario
 * (`MAIL_TENANT_DAILY_LIMIT`, DX-088) y si lo respeta.
 * - `clinic`: lo dispara la clínica (su personal o sus trabajos): cuenta en
 *   el tope y, si encola con tope, se frena al pasarlo.
 * - `self-service`: lo pide la propia persona desde un endpoint PÚBLICO
 *   (restablecer la contraseña). Ni cuenta ni se frena: si contara, un
 *   tercero agotaría el cupo de la clínica pidiendo restablecimientos para su
 *   personal y la dejaría 24 h sin correos (ni del personal ni
 *   restablecimientos legítimos). Lo acotan el tope por destinatario y el
 *   suyo propio (el restablecimiento: por usuario, en `user_tokens`).
 * Los de plataforma (sin clínica) no entran en ningún recuento de clínica;
 * se clasifican igual para que la tabla sea exhaustiva.
 */
export type TenantDailyBudget = 'clinic' | 'self-service';

export const TENANT_DAILY_BUDGET: Readonly<
  Record<EmailTemplateName, TenantDailyBudget>
> = {
  invitation: 'clinic',
  'password-reset': 'self-service',
  'email-verify': 'clinic',
  'appointment-reminder': 'clinic',
  'registration-notice': 'clinic',
  'payment-receipt': 'clinic',
  'payment-receipt-summary': 'clinic',
  'post-op-instructions': 'clinic',
  'signature-request': 'clinic',
  'signature-code': 'clinic',
  'signature-budget-accepted': 'clinic',
  'slot-offer': 'clinic',
  'signed-consent-copy': 'clinic',
  'prescription-copy': 'clinic',
  'mfa-notice': 'clinic',
  'mfa-enrollment-code': 'clinic',
  'payment-link': 'clinic',
  'payment-report-rejected': 'clinic',
  'external-order-copy': 'clinic',
  // DX-568: lo dispara la clínica (su trabajo semanal o el ADMIN que pide la
  // prueba): cuenta en el tope diario.
  'weekly-digest': 'clinic',
  // DX-561: lo dispara la clínica (su trabajo de seguimiento): cuenta en el
  // tope diario y, al encolarse con tope, se frena al pasarlo.
  'quote-follow-up': 'clinic',
  // DX-137: aviso de seguridad del inicio de sesión de un miembro en la
  // clínica, como `mfa-notice` (se encola sin tope: no se calla).
  'new-login': 'clinic',
  // DX-016: los pide la propia persona desde la página PÚBLICA de reserva
  // (como el restablecimiento): si contaran, un tercero agotaría el cupo de la
  // clínica. Los acotan el tope por destinatario, el rate limit de la página,
  // el tope de códigos por paciente y la protección anti-bots.
  'online-booking-code': 'self-service',
  'online-booking-received': 'self-service',
};

/** Las plantillas que no gastan el tope diario de la clínica (ver arriba). */
export const TENANT_DAILY_EXEMPT_TEMPLATES: readonly EmailTemplateName[] =
  EMAIL_TEMPLATES.filter((t) => TENANT_DAILY_BUDGET[t] === 'self-service');

/**
 * Idiomas con catálogo de textos (DX-497). Los formatos de fecha, hora e
 * importe son SIEMPRE los de la sede (G1-B, DX-315), no los del idioma.
 */
export const EMAIL_LOCALES = ['es', 'en'] as const;
export type EmailLocale = (typeof EMAIL_LOCALES)[number];
/** El idioma de la clínica: el de las plantillas sin catálogo por idioma. */
export const DEFAULT_EMAIL_LOCALE: EmailLocale = 'es';
/**
 * DX-497: plantillas que se escriben en el idioma del paciente (las demás
 * solo existen en el de la clínica: pedirles otro es un error de quien llama).
 */
export const LOCALIZED_EMAIL_TEMPLATES: readonly EmailTemplateName[] = [
  'appointment-reminder',
  // DX-468: la copia de la receta, en el idioma del paciente.
  'prescription-copy',
  // DX-561: el aviso de seguimiento del presupuesto.
  'quote-follow-up',
];

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
   * DX-469: «Añadir a mi calendario»: el .ics del enlace de confirmación y
   * el inicio/fin (ISO) de la cita para el enlace de Google Calendar. null o
   * ausente = sin enlace de confirmación: el email no lo ofrece.
   */
  calendar?: { icsUrl: string; start: string; end: string } | null;
  /**
   * DX-291: la variable `{politica_cancelacion}` del recordatorio: la política
   * VIGENTE de la sede al enviarlo (horas de aviso, texto de la clínica e
   * importe del cargo ya formateado). null/ausente = la sede no tiene
   * política (o el email es anterior a DX-291) y el bloque no sale.
   */
  cancellationPolicy?: ReminderCancellationPolicyVars | null;
  /**
   * DX-290: enlace de un solo uso al cuestionario de salud (paciente nuevo o
   * con la anamnesis caducada). Solo el enlace: el email no dice nada
   * clínico. null/ausente = no lo lleva.
   */
  anamnesisUrl?: string | null;
  /**
   * DX-290: el paciente ya tiene un enlace vivo de un envío anterior (no se
   * emite otro): el email solo le recuerda que lo use. Sin enlace.
   */
  anamnesisPending?: boolean;
  /**
   * DX-564: indicaciones previas del tipo de la cita, ya en el idioma del
   * paciente (o en español si no hay texto en el suyo). Texto plano de la
   * clínica con saltos de línea. null/ausente = no hay: el bloque no sale.
   */
  preVisitInstructions?: string | null;
}

/** DX-291: el bloque de la política de cancelación del recordatorio. */
export interface ReminderCancellationPolicyVars {
  noticeHours: number;
  /** Texto de la clínica para el paciente (puede ir vacío). */
  text: string;
  /** Importe del cargo ya formateado («50,00 USD»), o null si no hay. */
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
  /** «Razón social · identificador fiscal …», o null si los datos fiscales están pendientes. */
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
  /**
   * DX-515-bis: el título del recibo congelado en su foto; ausente = «Recibo
   * de caja», como siempre.
   */
  title?: string;
  /** DX-515-bis: la leyenda congelada en la foto; ausente = ninguna. */
  legend?: string;
  /**
   * DX-570: recibido, aplicado y vuelto de un cobro en efectivo, ya
   * formateados (cada línea con su medio, su importe, su equivalente y la
   * tasa con su día). Ausente sin vuelto: el email es el de antes.
   */
  cashChange?: {
    tenderedLabel: string;
    appliedLabel: string;
    changeLines: string[];
    /** La diferencia no devuelta que se sumó al abono; null si no hubo. */
    remainderLabel: string | null;
  };
}

/**
 * DX-401: resumen de los abonos de un período. Igual que el recibo: el
 * documento enmascarado, nada clínico y sin enlaces (el resumen va en el
 * propio email). Fechas e importes ya formateados con los de la sede.
 */
export interface PaymentReceiptSummaryEmailVars {
  patientName: string;
  /** DX-203: va al responsable (nombre de pila); el email lo saluda a él. */
  responsibleName?: string | null;
  /** «{nombre visible} ******5678», o null sin documento. */
  patientDocLabel: string | null;
  /** «01/10/2026 al 31/10/2026». */
  periodLabel: string;
  /** «Razón social · Id. fiscal …», o null si los datos fiscales están pendientes. */
  fiscalLine: string | null;
  /** Una por forma de pago, en orden de emisión. */
  lines: {
    receiptNumber: string;
    dateLabel: string;
    locationName: string;
    methodLabel: string;
    amountLabel: string;
    voided: boolean;
  }[];
  /** Total por moneda de lo no anulado («USD 150.00»); vacío si todo está anulado. */
  totalLabels: string[];
  voidedCount: number;
  notice: string;
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

/**
 * DX-243: enlace para firmar un documento a distancia. Nada clínico: ni el
 * título del documento ni el procedimiento; solo quién lo envía, a quién y el
 * enlace (el documento se ve tras verificar el código).
 */
export interface SignatureRequestEmailVars {
  /** Nombre de pila de quien firma (el paciente o su responsable). */
  recipientFirstName: string;
  /** Va al responsable de un menor: el nombre de pila del paciente. */
  patientFirstName: string | null;
  clinicName: string;
  /** Enlace público (`/firmar/<token>`). */
  url: string;
  /** Caducidad del enlace, ya formateada en la zona y el formato de la sede. */
  expiresAtLabel: string;
}

/** DX-243: el código de 6 dígitos que abre el documento. Solo el código. */
/** DX-021-bis: qué pasó con la verificación en dos pasos de la cuenta. */
export type MfaNoticeKind =
  'ENABLED' | 'RECOVERY_CODE_USED' | 'RESET_BY_ADMIN' | 'ATTEMPTS_LOCKED';

export interface MfaNoticeEmailVars {
  kind: MfaNoticeKind;
  /** Códigos de recuperación que quedan (`RECOVERY_CODE_USED`). */
  recoveryCodesRemaining?: number;
}

/** DX-021-bis, SEC-066: código del correo para el alta forzada del MFA. */
export interface MfaEnrollmentCodeEmailVars {
  code: string;
  /** Dice cuál de varios correos es el del intento que está en pantalla. */
  ref: string;
  expiresInMinutes: number;
}

export interface SignatureCodeEmailVars {
  recipientFirstName: string;
  clinicName: string;
  code: string;
  expiresInMinutes: number;
}

/**
 * DX-415: confirmación de que la aceptación del presupuesto quedó registrada.
 * Nada clínico ni importes: quién, qué clínica y cuándo.
 */
export interface SignatureBudgetAcceptedEmailVars {
  recipientFirstName: string;
  clinicName: string;
  /** Hora de la aceptación, ya formateada en la zona y el formato de la sede. */
  acceptedAtLabel: string;
  /**
   * DX-101-bis: aceptado desde el portal del paciente (su enlace de acceso
   * sigue sirviendo hasta que caduque). Ausente: por el enlace de firma
   * (DX-415), que ya no se puede volver a usar.
   */
  viaPortal?: boolean;
}

/**
 * DX-435: un hueco libre con enlace para aceptarlo (el primero que acepta se
 * lo queda). Cuándo, dónde y con quién; nada clínico.
 */
/** DX-016: el código de la reserva online. Nada clínico. */
export interface OnlineBookingCodeEmailVars {
  recipientFirstName: string;
  clinicName: string;
  code: string;
  expiresInMinutes: number;
}

/**
 * DX-016: acuse de la reserva online. `BOOKED`/`ACCEPTED` = la cita está
 * agendada (con el enlace DX-005 para confirmarla o cancelarla); `REQUESTED`
 * = solicitud recibida, la clínica la confirmará. Sin motivo ni tratamiento
 * más allá del nombre del tipo de cita que eligió el propio paciente.
 */
export interface OnlineBookingReceivedEmailVars {
  recipientFirstName: string;
  clinicName: string;
  state: 'BOOKED' | 'ACCEPTED' | 'REQUESTED';
  /** Inicio, ya formateado en la zona y el formato de la sede. */
  slotLabel: string;
  locationName: string;
  providerName: string | null;
  /** Enlace `/confirmar/<token>`; `null` en una solicitud. */
  manageUrl: string | null;
}

export interface SlotOfferEmailVars {
  patientFirstName: string;
  clinicName: string;
  /** Inicio del hueco, ya formateado en la zona y el formato de la sede. */
  slotLabel: string;
  locationName: string;
  providerName: string | null;
  /** Enlace público (`/hueco/<token>`). */
  url: string;
  expiresAtLabel: string;
}

/**
 * DX-443: la copia del PDF firmado a distancia, con un enlace de un solo uso.
 * Nada clínico: ni el título del documento ni el procedimiento; quién lo
 * envía, a quién y el enlace (el PDF se descarga desde la página).
 */
export interface SignedConsentCopyEmailVars {
  /** Nombre de pila de quien firmó (el paciente o su responsable). */
  recipientFirstName: string;
  /** Firmó el responsable de un menor: el nombre de pila del paciente. */
  patientFirstName: string | null;
  clinicName: string;
  /** Enlace público (`/copia/<token>`). */
  url: string;
  /** Caducidad del enlace, ya formateada en la zona y el formato de la sede. */
  expiresAtLabel: string;
}

/**
 * DX-468: la copia informativa de una receta emitida, con un enlace
 * caducable. Nada clínico: quién la envía, para quién y el enlace (la receta
 * se ve en la página tras validar el token).
 */
export interface PrescriptionCopyEmailVars {
  /** Nombre de pila de quien la recibe (el paciente o su responsable). */
  recipientFirstName: string | null;
  /** Va al responsable de un menor: el nombre de pila del paciente. */
  patientFirstName: string | null;
  clinicName: string;
  /** Enlace público (`/receta/copia/<token>`). */
  url: string;
  /** Caducidad del enlace, ya escrita con el formato de la sede. */
  expiresAtLabel: string;
}

/**
 * DX-569: el enlace para pagar y reportar el pago. Nada de importes,
 * tratamientos ni salud (como el mensaje de WhatsApp): quién lo envía, a
 * quién y el enlace.
 */
export interface PaymentLinkEmailVars {
  patientFirstName: string | null;
  clinicName: string;
  /** Enlace público (`/pago/<token>`). */
  url: string;
  /** Caducidad del enlace, ya formateada en la zona y el formato de la sede. */
  expiresAtLabel: string;
}

/**
 * DX-569: la clínica no pudo confirmar el pago reportado. Nunca el motivo
 * interno ni importes: que la clínica contactará.
 */
export interface PaymentReportRejectedEmailVars {
  patientFirstName: string | null;
  clinicName: string;
}

/**
 * DX-572: la copia de una orden de estudios o referencia, con un enlace de un
 * solo uso. Nada clínico: quién la envía, para quién, qué documento (el tipo,
 * nunca los estudios, el centro ni la nota) y el enlace.
 */
export interface ExternalOrderCopyEmailVars {
  /** Nombre de pila de quien la recibe (el paciente o su responsable). */
  recipientFirstName: string | null;
  /** Va al responsable de un menor: el nombre de pila del paciente. */
  patientFirstName: string | null;
  clinicName: string;
  /** «la orden de estudios de imagen», «la referencia al especialista». */
  documentLabel: string;
  /** Enlace público (`/orden/copia/<token>`). */
  url: string;
  /** Caducidad del enlace, ya escrita con el formato de la sede. */
  expiresAtLabel: string;
}

/** DX-568: una cifra del resumen semanal, ya escrita con el formato de la sede. */
export interface WeeklyDigestEmailRow {
  /** «Cobrado (USD)», «Citas atendidas». */
  label: string;
  /** Esta semana («USD 1.250,00», «12», «No disponible»). */
  current: string;
  /** Semana anterior («—» si no hay base). */
  previous: string;
  /** Variación («+12,5 %», «−3», «—»). */
  change: string;
  /** Aviso de la cifra («sin tasa (2)», «3 abiertas antes de hoy»). */
  note: string | null;
  /** Enlace al informe con el mismo filtro; null sin host de la clínica. */
  url: string | null;
}

/** DX-568: el bloque de una sede (o el total de la clínica). */
export interface WeeklyDigestEmailSection {
  title: string;
  rows: WeeklyDigestEmailRow[];
}

/**
 * DX-568: resumen semanal para los ADMIN de la clínica. Solo recuentos e
 * importes por sede: ni un nombre, documento ni dato de ningún paciente.
 */
/**
 * DX-137: alguien entró a la cuenta desde un dispositivo que no se vio en 90
 * días. Solo lo resumido: navegador y sistema y la red (IP truncada).
 */
export interface NewLoginEmailVars {
  userName: string;
  clinicName: string;
  /** «Chrome en Windows». */
  deviceLabel: string;
  /** «190.202.15.0/24», o `null` si no se supo. */
  ipPrefix: string | null;
  /** Cuándo, en la zona y el formato de la clínica, o `null` si no los tiene. */
  whenLabel: string | null;
  /** Enlace «No fui yo» (`/no-fui-yo/<token>`). */
  notMeUrl: string;
  expiresInHours: number;
}

export interface WeeklyDigestEmailVars {
  clinicName: string;
  /** «3 nov–9 nov». */
  periodLabel: string;
  /** «del lunes 3 al domingo 9 de noviembre de 2026». */
  periodLongLabel: string;
  /** La prueba que pide el ADMIN: asunto con «[Prueba]» y sin baja. */
  isTest: boolean;
  sections: WeeklyDigestEmailSection[];
  /** Definiciones y avisos al pie de las tablas. */
  notes: string[];
  /** `/resumen/baja/<token>`; null en la prueba o sin host. */
  unsubscribeUrl: string | null;
  /** `/settings/resumen-semanal`; null sin host. */
  settingsUrl: string | null;
}

/**
 * DX-561: aviso de seguimiento de un presupuesto presentado. SOLO el nombre
 * de la clínica, el saludo, un texto neutro, los enlaces de aceptación (uno
 * por opción, sin su etiqueta: puede nombrar el tratamiento) y la baja. Ni
 * importes, ni tratamientos, ni el profesional.
 */
export interface QuoteFollowUpEmailVars {
  /** Nombre de pila de quien lo recibe (el paciente o su responsable). */
  recipientFirstName: string | null;
  /** Va al responsable de un menor: el nombre de pila del paciente. */
  patientFirstName: string | null;
  clinicName: string;
  /** Un enlace `/firmar/<token>` por opción, en orden (A, B, C). 1–3. */
  urls: string[];
  /** Horas que vale el enlace (SIGNATURE_LINK_TTL_HOURS). */
  expiresInHours: number;
  /** Enlace de baja de los avisos (DX-128), si se emitió uno. */
  unsubscribeUrl: string | null;
}

export interface EmailVarsByTemplate {
  invitation: InvitationEmailVars;
  'password-reset': PasswordResetEmailVars;
  'email-verify': EmailVerifyEmailVars;
  'appointment-reminder': AppointmentReminderEmailVars;
  'registration-notice': RegistrationNoticeEmailVars;
  'payment-receipt': PaymentReceiptEmailVars;
  'payment-receipt-summary': PaymentReceiptSummaryEmailVars;
  'post-op-instructions': PostOpInstructionsEmailVars;
  'signature-request': SignatureRequestEmailVars;
  'signature-code': SignatureCodeEmailVars;
  'mfa-notice': MfaNoticeEmailVars;
  'mfa-enrollment-code': MfaEnrollmentCodeEmailVars;
  'signature-budget-accepted': SignatureBudgetAcceptedEmailVars;
  'slot-offer': SlotOfferEmailVars;
  'signed-consent-copy': SignedConsentCopyEmailVars;
  'prescription-copy': PrescriptionCopyEmailVars;
  'payment-link': PaymentLinkEmailVars;
  'payment-report-rejected': PaymentReportRejectedEmailVars;
  'external-order-copy': ExternalOrderCopyEmailVars;
  'weekly-digest': WeeklyDigestEmailVars;
  'quote-follow-up': QuoteFollowUpEmailVars;
  'new-login': NewLoginEmailVars;
  'online-booking-code': OnlineBookingCodeEmailVars;
  'online-booking-received': OnlineBookingReceivedEmailVars;
}

/** Lo que el remitente produce para una plantilla: asunto, HTML y texto. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}
