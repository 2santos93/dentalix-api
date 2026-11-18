import type { FollowUpReportRow } from './ports/quote-follow-up-repository.port';
import type { FollowUpSkipReason } from './quote-follow-up-schedule';
import { MAX_FOLLOW_UP_STEPS } from './quote-follow-up-settings';

/** Días tras el envío en que una aceptación cuenta para el aviso (D5). */
export const ACCEPTED_WITHIN_DAYS = 14;

export interface FollowUpStepStats {
  /** 1..3, o null en el total. */
  step: number | null;
  sent: number;
  opened: number;
  acceptedWithin14Days: number;
  /** abiertos ÷ enviados, en % (1 decimal); null sin envíos. */
  openRate: number | null;
  /** aceptados en 14 días ÷ enviados, en % (1 decimal); null sin envíos. */
  acceptanceRate: number | null;
}

export interface FollowUpSkipCount {
  reason: FollowUpSkipReason;
  count: number;
}

export interface FollowUpReportDefinition {
  key:
    'sent' | 'opened' | 'acceptedWithin14Days' | 'acceptanceRate' | 'skipped';
  label: string;
  howItIsCalculated: string[];
}

function percent(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

function stats(
  step: number | null,
  rows: FollowUpReportRow[],
): FollowUpStepStats {
  const sent = rows.filter((r) => r.status === 'SENT');
  const opened = sent.filter((r) => r.opened).length;
  const accepted = sent.filter((r) => r.acceptedWithin14Days).length;
  return {
    step,
    sent: sent.length,
    opened,
    acceptedWithin14Days: accepted,
    openRate: percent(opened, sent.length),
    acceptanceRate: percent(accepted, sent.length),
  };
}

/** Por paso (1..3) y en total; las omisiones por motivo, de más a menos. */
export function buildFollowUpReport(rows: FollowUpReportRow[]): {
  steps: FollowUpStepStats[];
  total: FollowUpStepStats;
  skipped: FollowUpSkipCount[];
} {
  const steps: FollowUpStepStats[] = [];
  for (let step = 1; step <= MAX_FOLLOW_UP_STEPS; step++) {
    steps.push(
      stats(
        step,
        rows.filter((r) => r.step === step),
      ),
    );
  }
  const byReason = new Map<FollowUpSkipReason, number>();
  for (const r of rows) {
    if (r.status === 'SKIPPED' && r.reason) {
      byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
    }
  }
  return {
    steps,
    total: stats(null, rows),
    skipped: [...byReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

export const FOLLOW_UP_REPORT_DEFINITIONS: readonly FollowUpReportDefinition[] =
  [
    {
      key: 'sent',
      label: 'Enviados',
      howItIsCalculated: [
        'Avisos de seguimiento enviados en el período (la fecha del envío, en el día civil de la sede donde se presentó el presupuesto).',
        'Un aviso por presentación y paso: las opciones A/B van en el mismo email y cuentan una vez.',
      ],
    },
    {
      key: 'opened',
      label: 'Abiertos',
      howItIsCalculated: [
        'Enviados en los que el paciente abrió alguno de los enlaces del aviso (pidió el código de verificación).',
      ],
    },
    {
      key: 'acceptedWithin14Days',
      label: `Aceptados en ${ACCEPTED_WITHIN_DAYS} días`,
      howItIsCalculated: [
        `Enviados tras los que alguna opción del presupuesto se aceptó en los ${ACCEPTED_WITHIN_DAYS} días siguientes al envío (por el enlace o en la clínica).`,
        'Si el paciente acepta después de dos avisos, cuenta para los dos.',
      ],
    },
    {
      key: 'acceptanceRate',
      label: 'Tasa de aceptación',
      howItIsCalculated: [
        `Aceptados en ${ACCEPTED_WITHIN_DAYS} días ÷ enviados, en %. Sin envíos no hay tasa.`,
      ],
    },
    {
      key: 'skipped',
      label: 'Omitidos',
      howItIsCalculated: [
        'Pasos que no se enviaron en el período, por motivo: baja de los avisos, sin email, canal WhatsApp o ninguno, consentimiento revocado, presupuesto vencido, aceptado, rechazado o con cita agendada, otro aviso posterior (atrasado) o demasiado tarde.',
      ],
    },
  ];
