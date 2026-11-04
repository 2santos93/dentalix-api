import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { ClinicRole } from '@prisma/client';
import {
  callerPhoneCandidates,
  MIN_CALLER_DIGITS,
} from '../../patients/domain/caller-lookup/caller-phone';
import {
  CALLER_LOOKUP_REPOSITORY,
  type CallerLookupRepository,
  type CallerMatchedBy,
  type CallerNextAppointment,
  type CallerVisitRef,
} from '../domain/caller-lookup-repository.port';
import {
  PatientBalanceFlags,
  type PatientBalanceView,
} from '../../collections/application/patient-balance-flags';
import { PatientMedicalAlertFlags } from '../../medical-history/application/patient-medical-alert-flags';
import { CLINICAL_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { CALLER_LOOKUP_CLOCK } from './caller-lookup-clock';

export const CALLER_PHONE_TOO_SHORT_CODE = 'CALLER_PHONE_TOO_SHORT';
export const CALLER_PHONE_TOO_SHORT_MESSAGE = 'Escribe el número completo';

export interface CallerLookupMatch {
  id: string;
  firstName: string;
  lastName: string;
  matchedBy: CallerMatchedBy;
  nextAppointment: CallerNextAppointment | null;
  lastVisit: CallerVisitRef | null;
  balance: PatientBalanceView;
  /** Solo para los roles clínicos; RECEPTION no recibe la clave. */
  hasCriticalAlert?: boolean;
}

export interface CallerLookupResult {
  matches: CallerLookupMatch[];
}

/**
 * «¿Quién llama?» (DX-224): los pacientes que tienen ese teléfono (o cuyo
 * responsable de pago lo tiene), con su contexto para atender la llamada. El
 * número se lee con el prefijo de la sede activa y se compara por E.164
 * completo. Nunca lo registra: ni logs ni auditoría.
 */
@Injectable()
export class CallerLookupUseCase {
  constructor(
    @Inject(CALLER_LOOKUP_REPOSITORY)
    private readonly repo: CallerLookupRepository,
    private readonly balances: PatientBalanceFlags,
    private readonly alerts: PatientMedicalAlertFlags,
    @Inject(CALLER_LOOKUP_CLOCK) private readonly now: () => Date,
  ) {}

  async execute(phone: string, role: ClinicRole): Promise<CallerLookupResult> {
    const region = await this.repo.defaultPhoneRegion();
    const candidates = callerPhoneCandidates(phone, region);
    if (candidates.status === 'TOO_SHORT') {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: CALLER_PHONE_TOO_SHORT_CODE,
        message: CALLER_PHONE_TOO_SHORT_MESSAGE,
        minDigits: MIN_CALLER_DIGITS,
      });
    }
    if (candidates.status === 'NONE') return { matches: [] };

    const found = await this.repo.findByPhoneE164(candidates.e164s);
    if (found.length === 0) return { matches: [] };
    const ids = found.map((m) => m.patientId);
    const now = this.now();
    const clinical = CLINICAL_ROLES.includes(role);

    const [next, last, balances, alerts] = await Promise.all([
      this.repo.nextAppointments(ids, now),
      this.repo.lastVisits(ids, now),
      this.balances.viewsForPatients(ids, role),
      clinical
        ? this.alerts
            .todayInSede()
            .then((day) => this.alerts.forPatients(ids, day))
        : Promise.resolve(null),
    ]);

    return {
      matches: found.map((m) => ({
        id: m.patientId,
        firstName: m.firstName,
        lastName: m.lastName,
        matchedBy: m.matchedBy,
        nextAppointment: next.get(m.patientId) ?? null,
        lastVisit: last.get(m.patientId) ?? null,
        balance: balances.get(m.patientId) ?? {
          overdue: { hasOverdue: false, overdueDays: null },
          pending: [],
        },
        ...(alerts
          ? {
              hasCriticalAlert:
                alerts.get(m.patientId)?.hasCriticalAlert ?? false,
            }
          : {}),
      })),
    };
  }
}
