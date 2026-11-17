import { moneyWithCode } from '../../../shared/format/money-with-code';
import type { RegionalFormat } from '../../../shared/format/regional-format';
import type {
  WeeklyDigestEmailRow,
  WeeklyDigestEmailVars,
} from '../../notifications/email/domain/email-message';
import type {
  DigestMetric,
  DigestMetricKey,
  DigestSection,
  WeeklyDigest,
} from './weekly-digest';
import {
  weekLongLabel,
  weekShortLabel,
  type DigestWeek,
} from './weekly-digest-schedule';

/** Rutas de la web a las que enlaza el resumen (DX-568, D6). */
export const WEEKLY_DIGEST_SETTINGS_PATH = '/settings/resumen-semanal';
export const WEEKLY_DIGEST_UNSUBSCRIBE_PATH = '/resumen/baja';
const RECEIVABLES_PATH = '/caja/cartera';
const CASH_SESSIONS_PATH = '/caja?tab=turnos';

export const UNAVAILABLE_TEXT = 'No disponible';
const NO_VALUE = '—';

const LABELS: Record<DigestMetricKey, string> = {
  collected: 'Cobrado',
  production: 'Producido',
  completedAppointments: 'Citas atendidas',
  noShows: 'Inasistencias',
  newPatients: 'Pacientes nuevos',
  quotesPresented: 'Presupuestos presentados',
  quotesAccepted: 'Presupuestos aceptados',
  overdueBalance: 'Saldo vencido',
  openCashSessions: 'Cajas sin cerrar',
};

/** Enlace de la cifra al informe con el mismo filtro (sin host, ninguno). */
export function metricUrl(
  base: string | null,
  key: DigestMetricKey,
  week: DigestWeek,
  locationId: string | null,
): string | null {
  if (!base) return null;
  const period = `periodo=custom&desde=${week.weekStart}&hasta=${week.weekEnd}`;
  switch (key) {
    case 'collected':
    case 'production':
    case 'completedAppointments':
    case 'noShows':
    case 'newPatients':
      return `${base}/reportes?tab=comparar-sedes&${period}`;
    case 'quotesPresented':
    case 'quotesAccepted':
      return `${base}/reportes?tab=presupuestos&${period}${
        locationId ? `&sede=${encodeURIComponent(locationId)}` : ''
      }`;
    case 'overdueBalance':
      return `${base}${RECEIVABLES_PATH}`;
    case 'openCashSessions':
      return `${base}${CASH_SESSIONS_PATH}`;
  }
}

/** «+12,5 %», «−3 %», «0 %»; sin variación, «—». */
export function changeText(change: number | null, fmt: RegionalFormat): string {
  if (change === null) return NO_VALUE;
  if (change === 0) return fmt.percent(0, 1);
  const sign = change > 0 ? '+' : '−';
  return `${sign}${fmt.percent(Math.abs(change), 1)}`;
}

function amountText(
  value: number | null,
  currency: string | null,
  fmt: RegionalFormat,
): string {
  if (value === null) return NO_VALUE;
  // Importes SIEMPRE con el código ISO (DX-521), nunca un símbolo.
  return currency
    ? moneyWithCode(value, currency, fmt, null)
    : fmt.number(value, { min: 0, max: 2 });
}

function countText(value: number | null, fmt: RegionalFormat): string {
  return value === null ? NO_VALUE : fmt.number(value, { min: 0, max: 0 });
}

function isMoney(key: DigestMetricKey): boolean {
  return (
    key === 'collected' || key === 'production' || key === 'overdueBalance'
  );
}

function valueText(
  metric: DigestMetric,
  side: 'current' | 'previous',
  fmt: RegionalFormat,
): string {
  const value = metric[side];
  if (isMoney(metric.key)) return amountText(value, metric.currency, fmt);
  if (metric.key === 'quotesPresented' || metric.key === 'quotesAccepted') {
    const amount = metric.amount?.[side] ?? null;
    if (value === null) return NO_VALUE;
    return amount !== null && metric.currency
      ? `${countText(value, fmt)} · ${moneyWithCode(amount, metric.currency, fmt, null)}`
      : countText(value, fmt);
  }
  if (metric.key === 'noShows' && side === 'current' && value !== null) {
    const rate = metric.rate ?? null;
    return rate === null
      ? countText(value, fmt)
      : `${countText(value, fmt)} (${fmt.percent(rate, 1)})`;
  }
  return countText(value, fmt);
}

function noteOf(metric: DigestMetric, fmt: RegionalFormat): string | null {
  const notes: string[] = [];
  if (metric.withoutRate > 0) {
    notes.push(`sin tasa (${countText(metric.withoutRate, fmt)})`);
  } else if (metric.rateProviderTimedOut) {
    notes.push('sin tasa');
  }
  if (metric.openBeforeToday && metric.openBeforeToday > 0) {
    notes.push(
      metric.openBeforeToday === 1
        ? '1 abierta antes de hoy'
        : `${countText(metric.openBeforeToday, fmt)} abiertas antes de hoy`,
    );
  }
  return notes.length > 0 ? notes.join(' · ') : null;
}

function rowOf(
  metric: DigestMetric,
  section: DigestSection,
  week: DigestWeek,
  fmt: RegionalFormat,
  base: string | null,
): WeeklyDigestEmailRow {
  const label =
    isMoney(metric.key) && metric.currency
      ? `${LABELS[metric.key]} (${metric.currency})`
      : LABELS[metric.key];
  const url = metricUrl(base, metric.key, week, section.locationId);
  if (metric.unavailable) {
    return {
      label,
      current: UNAVAILABLE_TEXT,
      previous: NO_VALUE,
      change: NO_VALUE,
      note: null,
      url,
    };
  }
  return {
    label,
    current: valueText(metric, 'current', fmt),
    previous: valueText(metric, 'previous', fmt),
    change: changeText(metric.change, fmt),
    note: noteOf(metric, fmt),
    url,
  };
}

/** Las notas al pie: definiciones y, si hace falta, qué quiere decir cada marca. */
function notesOf(digest: WeeklyDigest): string[] {
  const all = digest.sections.flatMap((s) => s.metrics);
  const notes = [
    'Cobrado y producido van por moneda, sin convertir. «Semana anterior» es la de lunes a domingo justo antes.',
    '«Presupuestos aceptados» son los presentados en la semana que ya se aceptaron: puede crecer después de este envío.',
    'El saldo vencido y las cajas sin cerrar son los de hoy; la variación del saldo es frente al del resumen anterior.',
  ];
  if (all.some((m) => m.withoutRate > 0 || m.rateProviderTimedOut)) {
    notes.push(
      '«sin tasa (N)»: N abonos o presupuestos en otra moneda no suman por falta de tasa de cambio; la cifra está incompleta.',
    );
  }
  if (all.some((m) => m.unavailable)) {
    notes.push(
      `«${UNAVAILABLE_TEXT}»: no se pudo calcular esa cifra al preparar el resumen; el informe la muestra al abrirlo.`,
    );
  }
  return notes;
}

export interface WeeklyDigestEmailInput {
  digest: WeeklyDigest;
  clinicName: string;
  /** Formato de la sede principal. */
  fmt: RegionalFormat;
  /** `<protocolo>://<host de la clínica>`; null = sin enlaces. */
  linkBase: string | null;
  /** Token de baja de la entrega; null en la prueba. */
  unsubscribeToken: string | null;
  isTest: boolean;
}

/** Las variables del email `weekly-digest`, ya escritas (DX-568, D6). */
export function weeklyDigestEmailVars(
  input: WeeklyDigestEmailInput,
): WeeklyDigestEmailVars {
  const { digest, fmt, linkBase } = input;
  return {
    clinicName: input.clinicName,
    periodLabel: weekShortLabel(digest.week),
    periodLongLabel: weekLongLabel(digest.week),
    isTest: input.isTest,
    sections: digest.sections.map((section) => ({
      title: section.name,
      rows: section.metrics.map((metric) =>
        rowOf(metric, section, digest.week, fmt, linkBase),
      ),
    })),
    notes: notesOf(digest),
    unsubscribeUrl:
      linkBase && input.unsubscribeToken && !input.isTest
        ? `${linkBase}${WEEKLY_DIGEST_UNSUBSCRIBE_PATH}/${input.unsubscribeToken}`
        : null,
    settingsUrl: linkBase ? `${linkBase}${WEEKLY_DIGEST_SETTINGS_PATH}` : null,
  };
}
