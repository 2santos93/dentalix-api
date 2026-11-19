import {
  DEFAULT_EMAIL_LOCALE,
  EMAIL_LOCALES,
  EmailBrand,
  EmailLocale,
  EmailTemplateName,
  EmailVarsByTemplate,
  EmailVerifyEmailVars,
  InvitationEmailVars,
  MfaEnrollmentCodeEmailVars,
  MfaNoticeEmailVars,
  NewLoginEmailVars,
  PasswordResetEmailVars,
  PaymentReceiptEmailVars,
  PaymentReceiptSummaryEmailVars,
  PostOpInstructionsEmailVars,
  LOCALIZED_EMAIL_TEMPLATES,
  RegistrationNoticeEmailVars,
  RenderedEmail,
  SignatureBudgetAcceptedEmailVars,
  SignatureCodeEmailVars,
  SignatureRequestEmailVars,
  SlotOfferEmailVars,
  OnlineBookingCodeEmailVars,
  OnlineBookingReceivedEmailVars,
  SignedConsentCopyEmailVars,
  PrescriptionCopyEmailVars,
  ExternalOrderCopyEmailVars,
  PaymentLinkEmailVars,
  PaymentReportRejectedEmailVars,
  WeeklyDigestEmailVars,
  QuoteFollowUpEmailVars,
  AppointmentSeriesEmailVars,
} from '../../domain/email-message';
import { PRESCRIPTION_COPY_CATALOG } from './catalog/prescription-copy.catalog';
import { QUOTE_FOLLOW_UP_CATALOG } from './catalog/quote-follow-up.catalog';
import { APPOINTMENT_SERIES_CATALOG } from './catalog/appointment-series.catalog';
import { EmailBlock, EmailTable, renderLayout } from './layout';
import { appointmentReminder } from './appointment-reminder.template';

// DX-497: re-exportado para quien ya lo importaba de aquí (vista previa).
export { cancellationPolicyText } from './appointment-reminder.template';

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

function paymentReceipt(
  vars: PaymentReceiptEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  const clinic = brand?.clinicName ?? PRODUCT_NAME;
  const where = vars.locationAddress
    ? `${vars.locationName} (${vars.locationAddress})`
    : vars.locationName;
  const responsible = vars.responsibleName?.trim() || null;
  // DX-515-bis: el título congelado en el recibo, o el de siempre.
  const title = vars.title ?? 'Recibo de caja';
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
        ? `${title} N.º ${vars.reference} (abono anterior a la numeración consecutiva: sin serie).`
        : `${title} N.º ${vars.reference}`,
    },
  ];
  // DX-515-bis: la leyenda congelada, justo bajo el título (como en el papel).
  if (vars.legend) blocks.push({ kind: 'paragraph', text: vars.legend });
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
  // DX-570: recibido, aplicado y vuelto (con su tasa y su día).
  if (vars.cashChange) {
    blocks.push(
      {
        kind: 'paragraph',
        text: `Recibido: ${vars.cashChange.tenderedLabel} · Aplicado: ${vars.cashChange.appliedLabel}`,
      },
      ...vars.cashChange.changeLines.map((line): EmailBlock => ({
        kind: 'paragraph',
        text: `Vuelto: ${line}`,
      })),
    );
    if (vars.cashChange.remainderLabel) {
      blocks.push({
        kind: 'paragraph',
        text: `Sin devolver, sumado al abono: ${vars.cashChange.remainderLabel}`,
      });
    }
  }
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
    subject: `${title} ${vars.reference}${vars.voided ? ' (ANULADO)' : ''} · ${clinic}`,
    heading: `Hola, ${responsible ?? vars.patientName}`,
    blocks,
    action: null,
  });
}

/**
 * DX-401: el resumen de abonos de un período. Una línea por forma de pago con
 * su número de recibo (los anulados, marcados y fuera de los totales) y el
 * total de cada moneda por separado: USD y VES nunca se suman.
 */
function paymentReceiptSummary(
  vars: PaymentReceiptSummaryEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  const clinic = brand?.clinicName ?? PRODUCT_NAME;
  const responsible = vars.responsibleName?.trim() || null;
  const blocks: EmailBlock[] = [
    {
      kind: 'paragraph',
      text: responsible
        ? `Te enviamos el resumen de los abonos de ${vars.patientName} en ${clinic} del ${vars.periodLabel}.`
        : `Te enviamos el resumen de tus abonos en ${clinic} del ${vars.periodLabel}.`,
    },
  ];
  if (vars.patientDocLabel) {
    blocks.push({
      kind: 'paragraph',
      text: `Documento: ${vars.patientDocLabel}`,
    });
  }
  for (const line of vars.lines) {
    blocks.push({
      kind: 'paragraph',
      text:
        `Recibo N.º ${line.receiptNumber} · ${line.dateLabel} · ${line.locationName} · ` +
        `${line.methodLabel} · ${line.amountLabel}${line.voided ? ' (ANULADO)' : ''}`,
    });
  }
  blocks.push({
    kind: 'paragraph',
    text:
      vars.totalLabels.length > 0
        ? `Total abonado: ${vars.totalLabels.join(' · ')}`
        : 'Total abonado: sin abonos vigentes en el período',
  });
  if (vars.voidedCount > 0) {
    blocks.push({
      kind: 'paragraph',
      text: `${plural(vars.voidedCount, 'recibo anulado', 'recibos anulados')}: no suman en el total.`,
    });
  }
  blocks.push(
    { kind: 'note', text: vars.fiscalLine ?? 'Datos fiscales pendientes' },
    { kind: 'note', text: vars.notice },
  );
  return renderLayout({
    brand,
    subject: `Resumen de abonos del ${vars.periodLabel} · ${clinic}`,
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

/** DX-021-bis: solo el hecho; nunca códigos, secretos ni quién lo hizo. */
function mfaNoticeText(vars: MfaNoticeEmailVars): {
  subject: string;
  body: string;
  note: string;
} {
  switch (vars.kind) {
    case 'ENABLED':
      return {
        subject: 'Se activó la verificación en dos pasos en tu cuenta',
        body: `Acaban de activar la verificación en dos pasos de tu cuenta de ${PRODUCT_NAME}.`,
        note: 'Si no fuiste tú, cambia tu contraseña ahora y avisa a la administración de tu clínica.',
      };
    case 'RECOVERY_CODE_USED':
      return {
        subject: 'Se usó un código de recuperación en tu cuenta',
        body: `Acabas de entrar a ${PRODUCT_NAME} con un código de recuperación. Te ${vars.recoveryCodesRemaining === 1 ? 'queda' : 'quedan'} ${plural(vars.recoveryCodesRemaining ?? 0, 'código', 'códigos')}.`,
        note: 'Si no fuiste tú, cambia tu contraseña ahora y genera códigos nuevos desde tu perfil.',
      };
    case 'RESET_BY_ADMIN':
      return {
        subject: 'Se restableció tu verificación en dos pasos',
        body: `Un administrador de tu clínica restableció la verificación en dos pasos de tu cuenta de ${PRODUCT_NAME}. Tus códigos de recuperación y tus dispositivos de confianza ya no sirven, y tus sesiones se cerraron.`,
        note: 'Vuelve a activarla desde tu perfil. Si no lo pediste, avisa a la administración de tu clínica.',
      };
    case 'ATTEMPTS_LOCKED':
      return {
        subject: 'Intentos fallidos en la verificación de tu cuenta',
        body: `Alguien escribió tu contraseña de ${PRODUCT_NAME} correctamente y falló varias veces el código de verificación. Por seguridad, los códigos quedan en espera unos minutos.`,
        note: 'Si no fuiste tú, cambia tu contraseña ahora: eso corta el intento y te deja entrar enseguida.',
      };
  }
}

function mfaNotice(
  vars: MfaNoticeEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  const { subject, body, note } = mfaNoticeText(vars);
  return renderLayout({
    brand,
    subject,
    heading: 'Aviso de seguridad',
    blocks: [
      { kind: 'paragraph', text: body },
      { kind: 'note', text: note },
    ],
    action: null,
  });
}

/** DX-137: inicio de sesión desde un dispositivo nuevo, con «No fui yo». */
function newLogin(
  vars: NewLoginEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  const where = vars.ipPrefix ? ` (red ${vars.ipPrefix})` : '';
  const when = vars.whenLabel ? ` el ${vars.whenLabel}` : '';
  return renderLayout({
    brand,
    subject: `Nuevo inicio de sesión en ${vars.clinicName}`,
    heading: `Hola, ${vars.userName}`,
    blocks: [
      {
        kind: 'paragraph',
        text: `Se inició sesión con tu cuenta en ${vars.clinicName}${when} desde un dispositivo que no habíamos visto: ${vars.deviceLabel}${where}.`,
      },
      {
        kind: 'paragraph',
        text: 'Si fuiste tú, no tienes que hacer nada.',
      },
      {
        kind: 'note',
        text: `Si no fuiste tú, pulsa «No fui yo»: cerramos todas tus sesiones y te llevamos a cambiar la contraseña. El enlace vale ${plural(vars.expiresInHours, 'hora', 'horas')} y una sola vez.`,
      },
    ],
    action: { label: 'No fui yo', url: vars.notMeUrl },
  });
}

function mfaEnrollmentCode(
  vars: MfaEnrollmentCodeEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  return renderLayout({
    brand,
    subject: 'Tu código para activar la verificación en dos pasos',
    heading: 'Activa la verificación en dos pasos',
    blocks: [
      { kind: 'paragraph', text: `Tu código es: ${vars.code}` },
      { kind: 'paragraph', text: `Referencia: ${vars.ref}` },
      {
        kind: 'note',
        text: `Vale solo para el intento que muestra esta referencia y admite 10 intentos. Caduca en ${plural(vars.expiresInMinutes, 'minuto', 'minutos')}. Se pidió con tu contraseña correcta: si no fuiste tú, tu contraseña está comprometida. No compartas el código y avisa al equipo de seguridad de ${PRODUCT_NAME}.`,
      },
    ],
    action: null,
  });
}

function signatureBudgetAccepted(
  vars: SignatureBudgetAcceptedEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  return renderLayout({
    brand,
    subject: `${vars.clinicName} recibió tu aceptación`,
    heading: `Hola, ${vars.recipientFirstName}`,
    blocks: [
      {
        kind: 'paragraph',
        text: `El ${vars.acceptedAtLabel} registramos tu aceptación del presupuesto que te envió ${vars.clinicName}.`,
      },
      vars.viaPortal
        ? {
            // DX-101-bis: el portal sigue abierto mientras el enlace viva;
            // sin enlace en el email (como el resto).
            kind: 'paragraph',
            text: `Lo verás como aceptado en tu portal de paciente mientras el enlace que te compartió la clínica siga activo. Si necesitas una copia del presupuesto firmado, pídesela a ${vars.clinicName}.`,
          }
        : {
            // DX-514: nunca se manda a la página en la que firmó (ese enlace
            // ya está usado y dice «Enlace no válido»); la copia la da la
            // clínica.
            kind: 'paragraph',
            text: `El enlace con el que firmaste ya no se puede volver a usar. Si necesitas una copia del presupuesto firmado, pídesela a ${vars.clinicName}.`,
          },
      {
        kind: 'note',
        text: 'Si no fuiste tú, avisa a la clínica cuanto antes.',
      },
    ],
    action: null,
  });
}

/** DX-016: el código de un solo uso de la reserva online. */
function onlineBookingCode(
  vars: OnlineBookingCodeEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  return renderLayout({
    brand,
    subject: `Tu código para reservar en ${vars.clinicName}`,
    heading: `Hola, ${vars.recipientFirstName}`,
    blocks: [
      { kind: 'paragraph', text: `Tu código de verificación es: ${vars.code}` },
      {
        kind: 'note',
        text: `Caduca en ${plural(vars.expiresInMinutes, 'minuto', 'minutos')} y solo sirve una vez. No lo compartas con nadie: la clínica nunca te lo pedirá. Si no lo pediste tú, ignora este correo.`,
      },
    ],
    action: null,
  });
}

/** DX-016: acuse de la reserva o de la solicitud online. */
function onlineBookingReceived(
  vars: OnlineBookingReceivedEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  const withProvider = vars.providerName ? ` con ${vars.providerName}` : '';
  const when = `el ${vars.slotLabel} en ${vars.locationName}${withProvider}`;
  if (vars.state === 'REQUESTED') {
    return renderLayout({
      brand,
      subject: `${vars.clinicName} recibió tu solicitud de cita`,
      heading: `Hola, ${vars.recipientFirstName}`,
      blocks: [
        {
          kind: 'paragraph',
          text: `Recibimos tu solicitud de cita para ${when}.`,
        },
        {
          kind: 'paragraph',
          text: 'La clínica la revisará y te escribirá para confirmarla. Hasta entonces la hora no queda reservada.',
        },
        {
          kind: 'note',
          text: 'Si no pediste esta cita, ignora este correo.',
        },
      ],
      action: null,
    });
  }
  return renderLayout({
    brand,
    subject: `Tu cita en ${vars.clinicName} está reservada`,
    heading: `Hola, ${vars.recipientFirstName}`,
    blocks: [
      { kind: 'paragraph', text: `Tu cita quedó reservada para ${when}.` },
      {
        kind: 'paragraph',
        text: 'Desde el enlace puedes confirmarla o, si no puedes ir, cancelarla para que otra persona aproveche la hora.',
      },
      {
        kind: 'note',
        text: 'El enlace es personal: no lo compartas. Si no pediste esta cita, avisa a la clínica.',
      },
    ],
    action: vars.manageUrl
      ? { label: 'Ver mi cita', url: vars.manageUrl }
      : null,
  });
}

function slotOffer(
  vars: SlotOfferEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  const withProvider = vars.providerName ? ` con ${vars.providerName}` : '';
  return renderLayout({
    brand,
    subject: `${vars.clinicName} tiene un hueco libre para ti`,
    heading: `Hola, ${vars.patientFirstName}`,
    blocks: [
      {
        kind: 'paragraph',
        text: `Se liberó un hueco el ${vars.slotLabel} en ${vars.locationName}${withProvider}.`,
      },
      {
        kind: 'paragraph',
        text: 'Si te viene bien, ábrelo y acéptalo: se lo queda el primero que lo acepte. Si no, puedes rechazarlo desde el mismo enlace.',
      },
      {
        kind: 'note',
        text: `La oferta caduca el ${vars.expiresAtLabel} y el enlace solo sirve una vez. Si no esperabas este correo, ignóralo.`,
      },
    ],
    action: { label: 'Ver el hueco', url: vars.url },
  });
}

function signedConsentCopy(
  vars: SignedConsentCopyEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  const onBehalf = vars.patientFirstName
    ? ` que firmaste en nombre de ${vars.patientFirstName}`
    : ' que firmaste';
  return renderLayout({
    brand,
    subject: `Tu copia del documento firmado en ${vars.clinicName}`,
    heading: `Hola, ${vars.recipientFirstName}`,
    blocks: [
      {
        kind: 'paragraph',
        text: `${vars.clinicName} te envía la copia en PDF del documento${onBehalf} a distancia. Ábrela y descárgala desde el enlace.`,
      },
      {
        kind: 'note',
        text: `El enlace caduca el ${vars.expiresAtLabel} y solo sirve una vez: guarda el PDF al descargarlo. Si necesitas otra copia, pídesela a la clínica. Si no esperabas este correo, no lo abras y avisa a la clínica.`,
      },
    ],
    action: { label: 'Descargar mi copia', url: vars.url },
  });
}

/**
 * DX-468: la copia informativa de la receta, en el idioma del paciente
 * (catálogo por clave). Nada clínico en el email.
 */
function prescriptionCopy(
  vars: PrescriptionCopyEmailVars,
  brand: EmailBrand | null,
  locale: EmailLocale,
): RenderedEmail {
  const t = PRESCRIPTION_COPY_CATALOG[locale];
  return renderLayout({
    brand,
    chrome: t,
    subject: t.subject(vars.clinicName),
    heading: t.heading(vars.recipientFirstName),
    blocks: [
      {
        kind: 'paragraph',
        text: t.intro(vars.clinicName, vars.patientFirstName),
      },
      { kind: 'paragraph', text: t.notOfficial },
      { kind: 'note', text: t.note(vars.expiresAtLabel) },
    ],
    action: { label: t.action, url: vars.url },
  });
}

function paymentLink(
  vars: PaymentLinkEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  return renderLayout({
    brand,
    subject: `${vars.clinicName} te envía los datos para tu pago`,
    heading: vars.patientFirstName ? `Hola, ${vars.patientFirstName}` : 'Hola',
    blocks: [
      {
        kind: 'paragraph',
        text: `En el enlace tienes los datos de ${vars.clinicName} para hacer tu pago. Cuando lo hagas, avísanos desde la misma página con la referencia y, si puedes, el comprobante.`,
      },
      {
        kind: 'note',
        text: `El enlace es personal, caduca el ${vars.expiresAtLabel} y solo sirve para un reporte. Si no esperabas este correo, no lo abras y avisa a la clínica.`,
      },
    ],
    action: { label: 'Ver los datos para pagar', url: vars.url },
  });
}

function paymentReportRejected(
  vars: PaymentReportRejectedEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  return renderLayout({
    brand,
    subject: `${vars.clinicName} no pudo confirmar tu pago`,
    heading: vars.patientFirstName ? `Hola, ${vars.patientFirstName}` : 'Hola',
    blocks: [
      {
        kind: 'paragraph',
        text: `${vars.clinicName} no pudo confirmar el pago que nos reportaste. La clínica te contactará para revisarlo.`,
      },
      {
        kind: 'note',
        text: 'Si tienes dudas, escribe o llama a la clínica.',
      },
    ],
    action: null,
  });
}

/**
 * DX-572: la copia de una orden de estudios o referencia, por un enlace de un
 * solo uso. Nada clínico en el email: ni los estudios, ni el centro, ni la
 * nota (van en el PDF tras abrir el enlace).
 */
function externalOrderCopy(
  vars: ExternalOrderCopyEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  const intro = vars.patientFirstName
    ? `${vars.clinicName} te envía una copia de ${vars.documentLabel} de ${vars.patientFirstName}. Descárgala desde el enlace para llevarla al centro o al especialista.`
    : `${vars.clinicName} te envía una copia de ${vars.documentLabel}. Descárgala desde el enlace para llevarla al centro o al especialista.`;
  return renderLayout({
    brand,
    subject: `Tu copia de la orden de ${vars.clinicName}`,
    heading: vars.recipientFirstName
      ? `Hola, ${vars.recipientFirstName}`
      : 'Hola',
    blocks: [
      { kind: 'paragraph', text: intro },
      {
        kind: 'note',
        text: `El enlace es personal, sirve para una sola descarga y caduca el ${vars.expiresAtLabel}. Si no esperabas este correo, no lo abras y avisa a la clínica.`,
      },
    ],
    action: { label: 'Descargar mi copia', url: vars.url },
  });
}

/** DX-568: las columnas de cada tabla del resumen semanal. */
export const WEEKLY_DIGEST_COLUMNS = [
  'Cifra',
  'Esta semana',
  'Semana anterior',
  'Variación',
] as const;

/**
 * DX-568: el resumen semanal para los ADMIN. Solo recuentos e importes por
 * sede (ningún dato de pacientes); cada cifra enlaza al informe con el mismo
 * filtro. La prueba lleva «[Prueba]» en el asunto y no lleva baja.
 */
function weeklyDigest(
  vars: WeeklyDigestEmailVars,
  brand: EmailBrand | null,
): RenderedEmail {
  const hasLinks = vars.sections.some((s) => s.rows.some((r) => r.url));
  const tables: EmailTable[] = vars.sections.map((section) => ({
    title: section.title,
    columns: [...WEEKLY_DIGEST_COLUMNS],
    rows: section.rows.map((row) => ({
      cells: [
        { text: row.label },
        { text: row.current, url: row.url },
        { text: row.previous },
        { text: row.change },
      ],
      note: row.note,
    })),
  }));
  const blocks: EmailBlock[] = [
    {
      kind: 'paragraph',
      text: `Estas son las cifras de ${vars.clinicName} de la semana ${vars.periodLongLabel}, por sede y para toda la clínica, frente a la semana anterior.${hasLinks ? ' Cada cifra abre el informe con la misma semana.' : ''}`,
    },
  ];
  if (vars.isTest) {
    blocks.push({
      kind: 'note',
      text: 'Es una prueba que pediste desde Ajustes: el resumen de verdad les llega a los destinatarios elegidos el día y a la hora configurados.',
    });
  }
  return renderLayout({
    brand,
    subject: `${vars.isTest ? '[Prueba] ' : ''}Resumen semanal de ${vars.clinicName}: ${vars.periodLabel}`,
    heading: 'Resumen semanal',
    blocks,
    tables,
    closingBlocks: vars.notes.map((text) => ({ kind: 'note', text })),
    action: null,
    links: vars.settingsUrl
      ? {
          lead: 'Para cambiar el día, la hora o quién lo recibe:',
          items: [{ label: 'Cambiar los ajustes', url: vars.settingsUrl }],
        }
      : null,
    footerLink: vars.unsubscribeUrl
      ? {
          lead: 'Te llega porque eres administrador de la clínica.',
          label: 'Dejar de recibir este resumen',
          url: vars.unsubscribeUrl,
        }
      : null,
  });
}

/** DX-561: letra de cada opción del aviso (A, B, C), por su orden. */
const OPTION_LETTERS = ['A', 'B', 'C'] as const;

/**
 * DX-561: el aviso de seguimiento de un presupuesto presentado, en el idioma
 * del paciente. Una opción: un botón. Varias (A/B): un enlace por opción con
 * su letra, nunca su etiqueta (puede nombrar el tratamiento). La baja, al pie.
 */
function quoteFollowUp(
  vars: QuoteFollowUpEmailVars,
  brand: EmailBrand | null,
  locale: EmailLocale,
): RenderedEmail {
  if (vars.urls.length < 1 || vars.urls.length > OPTION_LETTERS.length) {
    throw new Error('El aviso de seguimiento lleva de 1 a 3 enlaces');
  }
  const t = QUOTE_FOLLOW_UP_CATALOG[locale];
  const single = vars.urls.length === 1;
  return renderLayout({
    brand,
    chrome: t,
    subject: t.subject(vars.clinicName, vars.patientFirstName),
    heading: t.heading(vars.recipientFirstName),
    blocks: [
      {
        kind: 'paragraph',
        text: t.intro(vars.clinicName, vars.patientFirstName),
      },
      { kind: 'note', text: t.expires(vars.expiresInHours) },
      { kind: 'note', text: t.note },
    ],
    action: single ? { label: t.action, url: vars.urls[0] } : null,
    links: single
      ? null
      : {
          lead: t.optionsLead,
          items: vars.urls.map((url, i) => ({
            label: t.option(OPTION_LETTERS[i]),
            url,
          })),
        },
    footerLink: vars.unsubscribeUrl
      ? {
          lead: t.unsubscribeLead,
          label: t.unsubscribeLabel,
          url: vars.unsubscribeUrl,
        }
      : null,
  });
}

/**
 * DX-562: el aviso único de una serie de citas, en el idioma del paciente:
 * dónde, con quién y la lista de fechas (numeradas, una por línea). Sin
 * botón: cada cita lleva su enlace de confirmación en su recordatorio.
 */
function appointmentSeries(
  vars: AppointmentSeriesEmailVars,
  brand: EmailBrand | null,
  locale: EmailLocale,
): RenderedEmail {
  if (vars.dateLabels.length < 2 || vars.dateLabels.length > 26) {
    throw new Error('El aviso de una serie lleva de 2 a 26 fechas');
  }
  const t = APPOINTMENT_SERIES_CATALOG[locale];
  return renderLayout({
    brand,
    chrome: t,
    subject: t.subject(vars.clinicName, vars.patientFirstName),
    heading: t.heading(vars.recipientFirstName),
    blocks: [
      {
        kind: 'paragraph',
        text: t.intro({
          count: vars.dateLabels.length,
          location: vars.locationName,
          provider: vars.providerName,
          patient: vars.patientFirstName,
        }),
      },
      {
        kind: 'paragraph',
        lead: t.datesLead,
        multiline: true,
        text: vars.dateLabels
          .map((label, i) => `${i + 1}. ${label}`)
          .join('\n'),
      },
      { kind: 'note', text: t.note },
    ],
    action: null,
    // DX-128: como el recordatorio, la baja al pie.
    footerLink: vars.unsubscribeUrl
      ? {
          lead: t.unsubscribeLead,
          label: t.unsubscribeLabel,
          url: vars.unsubscribeUrl,
        }
      : null,
  });
}

type Renderer<T extends EmailTemplateName> = (
  vars: EmailVarsByTemplate[T],
  brand: EmailBrand | null,
  locale: EmailLocale,
) => RenderedEmail;

const RENDERERS: { [T in EmailTemplateName]: Renderer<T> } = {
  invitation,
  'password-reset': passwordReset,
  'email-verify': emailVerify,
  'appointment-reminder': appointmentReminder,
  'registration-notice': registrationNotice,
  'payment-receipt': paymentReceipt,
  'payment-receipt-summary': paymentReceiptSummary,
  'post-op-instructions': postOpInstructions,
  'signature-request': signatureRequest,
  'signature-code': signatureCode,
  'signature-budget-accepted': signatureBudgetAccepted,
  'slot-offer': slotOffer,
  'signed-consent-copy': signedConsentCopy,
  'prescription-copy': prescriptionCopy,
  'payment-link': paymentLink,
  'payment-report-rejected': paymentReportRejected,
  'external-order-copy': externalOrderCopy,
  'weekly-digest': weeklyDigest,
  'quote-follow-up': quoteFollowUp,
  'new-login': newLogin,
  'mfa-notice': mfaNotice,
  'mfa-enrollment-code': mfaEnrollmentCode,
  'online-booking-code': onlineBookingCode,
  'online-booking-received': onlineBookingReceived,
  'appointment-series': appointmentSeries,
};

/**
 * Renderiza una plantilla en el idioma pedido. Solo las de
 * `LOCALIZED_EMAIL_TEMPLATES` tienen catálogo por idioma (DX-497); las demás
 * existen solo en el de la clínica. La marca de la clínica firma el email
 * cuando hay tenant; sin ella firma Dentalix.
 */
export function renderEmail<T extends EmailTemplateName>(
  template: T,
  vars: EmailVarsByTemplate[T],
  brand: EmailBrand | null,
  locale: EmailLocale = DEFAULT_EMAIL_LOCALE,
): RenderedEmail {
  if (
    !EMAIL_LOCALES.includes(locale) ||
    (locale !== DEFAULT_EMAIL_LOCALE &&
      !LOCALIZED_EMAIL_TEMPLATES.includes(template))
  ) {
    throw new Error(`Idioma de email no soportado: ${String(locale)}`);
  }
  const render = RENDERERS[template] as Renderer<T>;
  return render(vars, brand, locale);
}
