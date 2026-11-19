import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ClinicRole, ExtraPermission } from '@prisma/client';
import {
  checkPeriodDays,
  PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
} from '../../../shared/time/civil-day';
import { shiftCivilYears, type CivilPeriod } from '../domain/comparison-period';

/*
 * Alcance común de «Profesionales» e «Inasistencias» (DX-304), el mismo que
 * «Previsión» (DX-567): ADMIN o quien tenga FINANCIAL_REPORTS_VIEW (DX-090) ve
 * toda la clínica (CLINIC); un DENTIST, solo lo suyo (OWN) y pedir lo de otro
 * es 403; recepción y asistente, 403.
 */

export interface ProfessionalReportActor {
  userId: string;
  role: ClinicRole;
  permissions: readonly ExtraPermission[];
}

export type ProfessionalReportScopeKind = 'CLINIC' | 'OWN';

/** Tope del período por calendario, como «Producción por procedimiento». */
export const PROFESSIONAL_REPORT_MAX_MONTHS = 24;

export const PROFESSIONAL_REPORT_INVALID_PERIOD_MESSAGE =
  'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».';
export const PROFESSIONAL_REPORT_PERIOD_TOO_LONG_MESSAGE =
  'El período admite como mucho 24 meses.';

export function professionalReportPeriod(
  from: string,
  to: string,
): CivilPeriod {
  const period = checkPeriodDays(from, to);
  if (!period.ok) {
    throw new BadRequestException(
      period.problem === 'OUT_OF_RANGE'
        ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
        : PROFESSIONAL_REPORT_INVALID_PERIOD_MESSAGE,
    );
  }
  // 24 meses por calendario (el 29/02 + 24 meses cae en el 28/02).
  if (
    period.to >=
    shiftCivilYears(period.from, PROFESSIONAL_REPORT_MAX_MONTHS / 12)
  ) {
    throw new BadRequestException(PROFESSIONAL_REPORT_PERIOD_TOO_LONG_MESSAGE);
  }
  return { from: period.from, to: period.to };
}

/** ¿Ve toda la clínica? */
export function seesWholeClinic(actor: ProfessionalReportActor): boolean {
  return (
    actor.role === ClinicRole.ADMIN ||
    actor.permissions.includes(ExtraPermission.FINANCIAL_REPORTS_VIEW)
  );
}

/**
 * El profesional al que se acota la consulta y el alcance. El DENTIST
 * siempre se acota a sí mismo (aunque no lo pida).
 */
export function professionalScopeOf(
  actor: ProfessionalReportActor,
  professionalId: string | undefined,
  messages: { forbidden: string; ownOnly: string },
): { professionalId?: string; kind: ProfessionalReportScopeKind } {
  if (seesWholeClinic(actor)) {
    return { professionalId, kind: 'CLINIC' };
  }
  if (actor.role !== ClinicRole.DENTIST) {
    throw new ForbiddenException(messages.forbidden);
  }
  if (professionalId !== undefined && professionalId !== actor.userId) {
    throw new ForbiddenException(messages.ownOnly);
  }
  return { professionalId: actor.userId, kind: 'OWN' };
}
