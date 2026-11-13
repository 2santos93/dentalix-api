import { googleCalendarUrl } from '../../../../../shared/calendar/appointment-calendar';
import { endSentence } from '../../../../../shared/format/end-sentence';
import type {
  AppointmentReminderEmailVars,
  EmailBrand,
  EmailLocale,
  ReminderCancellationPolicyVars,
  RenderedEmail,
} from '../../domain/email-message';
import {
  APPOINTMENT_REMINDER_CATALOG,
  type AppointmentReminderTexts,
} from './catalog/appointment-reminder.catalog';
import { type EmailBlock, renderLayout } from './layout';

// DX-497: esta plantilla NO lleva textos para el paciente: todos salen del
// catálogo por idioma (lo comprueba appointment-reminder.architecture.spec).
const PRODUCT_NAME = 'Dentalix';

/**
 * DX-291: el texto de `{politica_cancelacion}` en el recordatorio: cuántas
 * horas de aviso pide la sede, el texto de la clínica (tal como lo escribió)
 * y el cargo, si lo hay. DX-497: en el idioma del catálogo pedido.
 */
export function cancellationPolicyText(
  policy: ReminderCancellationPolicyVars,
  texts: AppointmentReminderTexts = APPOINTMENT_REMINDER_CATALOG.es,
): string {
  const parts = [texts.policyNotice(policy.noticeHours)];
  const text = policy.text.trim();
  if (text) parts.push(text);
  // Algunos símbolos de moneda ya acaban en punto («ج.م.»).
  if (policy.feeLabel)
    parts.push(endSentence(texts.policyFee(policy.feeLabel)));
  return parts.join(' ');
}

/**
 * DX-026: recordatorio de cita. DX-128: el de un menor va a su tutor: se le
 * saluda y se nombra al paciente. DX-497: en el idioma pedido.
 */
export function appointmentReminder(
  vars: AppointmentReminderEmailVars,
  brand: EmailBrand | null,
  locale: EmailLocale,
): RenderedEmail {
  const t = APPOINTMENT_REMINDER_CATALOG[locale];
  const clinic = brand?.clinicName ?? PRODUCT_NAME;
  const where = vars.locationAddress
    ? `${vars.locationName} (${vars.locationAddress})`
    : vars.locationName;
  const guardian = vars.guardianName?.trim() || null;
  const whose = guardian ? t.appointmentOf(vars.patientName) : t.ownAppointment;
  const blocks: EmailBlock[] = [
    { kind: 'paragraph', text: t.intro(whose, clinic) },
    { kind: 'paragraph', text: t.dateTime(vars.startsAtLabel) },
    { kind: 'paragraph', text: t.location(where) },
  ];
  if (vars.providerName) {
    blocks.push({ kind: 'paragraph', text: t.provider(vars.providerName) });
  }
  blocks.push({
    kind: 'note',
    text: vars.confirmUrl ? t.noteWithLink : t.noteWithoutLink,
  });
  if (vars.cancellationPolicy) {
    blocks.push({
      kind: 'note',
      text: cancellationPolicyText(vars.cancellationPolicy, t),
    });
  }
  return renderLayout({
    brand,
    chrome: t,
    subject: t.subject(whose, clinic),
    heading: t.heading(guardian ?? vars.patientName),
    blocks,
    action: vars.confirmUrl ? { label: t.action, url: vars.confirmUrl } : null,
    // DX-469: «Añadir a mi calendario» (.ics y Google Calendar).
    links: vars.calendar
      ? {
          lead: t.calendarLead,
          items: [
            { label: t.calendarIcs, url: vars.calendar.icsUrl },
            {
              label: t.calendarGoogle,
              url: googleCalendarUrl(
                {
                  start: new Date(vars.calendar.start),
                  end: new Date(vars.calendar.end),
                  clinicName: clinic,
                  providerName: vars.providerName,
                  locationName: vars.locationName,
                  locationAddress: vars.locationAddress,
                },
                {
                  summary: t.calendarSummary(clinic, vars.providerName),
                  details: t.calendarDetails,
                },
              ),
            },
          ],
        }
      : null,
    footerLink: vars.unsubscribeUrl
      ? {
          lead: t.unsubscribeLead,
          label: t.unsubscribeLabel,
          url: vars.unsubscribeUrl,
        }
      : null,
  });
}
