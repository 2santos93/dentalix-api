import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentArrivalSource, AppointmentStatus } from '@prisma/client';
import { normalizeIp } from '@nestjs/throttler';
import type { HourCycle } from '../../../shared/format/regional-format';
import {
  hashPublicLinkToken,
  isWellFormedPublicLinkToken,
} from '../../../shared/public-links/public-link-token';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { civilDateIn, civilDayRange } from '../../../shared/time/civil-day';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import { UpdateAppointmentUseCase } from '../../appointments/application/use-cases/update-appointment.use-case';
import { findConfirmationByToken } from '../../appointment-confirmations/application/find-confirmation-by-token';
import { firstNameOnly } from '../../appointment-confirmations/application/confirmation-token';
import {
  APPOINTMENT_CONFIRMATION_REPOSITORY,
  type AppointmentConfirmationRepository,
} from '../../appointment-confirmations/domain/ports/appointment-confirmation-repository.port';
import type { ClinicBranding } from '../../appointment-confirmations/domain/entities/appointment-confirmation.entity';
import {
  birthDateMatches,
  normalizeBirthDate,
} from '../../patient-access/domain/patient-access';
import {
  ARRIVAL_MESSAGES,
  DEFAULT_CHECK_IN_SETTINGS,
  arrivalWindow,
  checkInResult,
  isLateArrival,
  orderPending,
  type ArrivalState,
  type CheckInResult,
  type CheckInSettings,
} from '../domain/check-in-rules';
import {
  CHECK_IN_FAILURE_WINDOW_MINUTES,
  CHECK_IN_LOCKED_CODE,
  CHECK_IN_LOCKED_MESSAGE,
  CHECK_IN_LOCK_MINUTES,
  CHECK_IN_DOCUMENT_MAX_FAILURES,
  CHECK_IN_MAX_FAILURES,
  CHECK_IN_NO_MATCH_CODE,
  CHECK_IN_NO_MATCH_MESSAGE,
  CHECK_IN_QR_INACTIVE_CODE,
  CHECK_IN_QR_INACTIVE_MESSAGE,
  CHECK_IN_RESPONSE_FLOOR_MS,
  checkInClientKey,
  checkInDocumentKey,
  type CheckInAttemptState,
  documentMatches,
  lockedUntil,
  normalizeCheckInDocument,
  retryAfterSeconds,
} from '../domain/check-in-identity';
import {
  CHECK_IN_REPOSITORY,
  type ArrivalAppointment,
  type CheckInRepository,
} from '../domain/ports/check-in-repository.port';
import { CheckInPendingService } from './check-in-pending.service';

/**
 * Lo único que la página pública ve de la cita al llegar: nombre de pila,
 * hora y sede. LISTA BLANCA: ni apellidos, ni profesional, ni motivo, ni
 * los pendientes (solo «pase por recepción»).
 */
export interface PublicArrivalAppointment {
  patientFirstName: string | null;
  start: Date;
  locationName: string;
  timeZone: string | null;
  locale: string | null;
  hourCycle: HourCycle | null;
}

/** «Ya llegué» de una cita. LISTA BLANCA (test que serializa la respuesta). */
export interface PublicArrivalView {
  state: ArrivalState;
  /** Desde y hasta cuándo se puede marcar hoy (solo TOO_EARLY, AVAILABLE y TOO_LATE). */
  opensAt: Date | null;
  closesAt: Date | null;
  /** Solo con la llegada marcada y el paciente aún en la sala de espera. */
  result: CheckInResult | null;
  /** Turno del día (DX-588), con la llegada marcada. */
  turnNumber: number | null;
  /** `null` con UNAVAILABLE: la página no enseña nada de la cita. */
  appointment: PublicArrivalAppointment | null;
}

/** La sede del QR para la página pública. */
export interface PublicCheckInQrView {
  clinic: ClinicBranding | null;
  locationName: string;
  timeZone: string | null;
  locale: string | null;
  hourCycle: HourCycle | null;
}

export interface CheckInIdentifyInput {
  documentNumber: unknown;
  birthDate: unknown;
}

export const CHECK_IN_SLEEPER = Symbol('CHECK_IN_SLEEPER');
export type CheckInSleeper = (ms: number) => Promise<void>;
export const realCheckInSleeper: CheckInSleeper = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const CHECK_IN_CLOCK = Symbol('CHECK_IN_CLOCK');
export type CheckInClock = () => Date;

const UNAVAILABLE_VIEW: PublicArrivalView = {
  state: 'UNAVAILABLE',
  opensAt: null,
  closesAt: null,
  result: null,
  turnNumber: null,
  appointment: null,
};

function noMatch(): BadRequestException {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code: CHECK_IN_NO_MATCH_CODE,
    message: CHECK_IN_NO_MATCH_MESSAGE,
  });
}

function locked(retryAfter: number): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      code: CHECK_IN_LOCKED_CODE,
      message: CHECK_IN_LOCKED_MESSAGE,
      retryAfterSeconds: retryAfter,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/** El MISMO 404 para un QR malformado, desconocido, revocado, de otra clínica o de una sede retirada. */
export function inactiveQr(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    code: CHECK_IN_QR_INACTIVE_CODE,
    message: CHECK_IN_QR_INACTIVE_MESSAGE,
  });
}

/** Preferencia al elegir entre varias citas de hoy del mismo paciente. */
const STATE_RANK: Record<ArrivalState, number> = {
  ARRIVED: 0,
  AVAILABLE: 1,
  TOO_EARLY: 2,
  TOO_LATE: 3,
  UNAVAILABLE: 4,
};

/**
 * DX-265: «Ya llegué» público. Dos entradas:
 * - el enlace firmado de la cita (DX-005): ver el estado y marcar la llegada;
 * - el QR de la sede: el paciente escribe documento y fecha de nacimiento y
 *   se marca la llegada de SU cita de hoy en esa sede.
 * Las dos pasan por el MISMO camino que «Llegó» de recepción
 * (`UpdateAppointmentUseCase.arriveByPatient`) y lo dejan auditado con su
 * origen. El tenant sale SOLO del host; la RLS hace invisible lo de otra
 * clínica.
 */
@Injectable()
export class PublicCheckInUseCases {
  private readonly logger = new Logger(PublicCheckInUseCases.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(CHECK_IN_REPOSITORY) private readonly repo: CheckInRepository,
    @Inject(APPOINTMENT_CONFIRMATION_REPOSITORY)
    private readonly confirmations: AppointmentConfirmationRepository,
    private readonly appointments: UpdateAppointmentUseCase,
    private readonly pending: CheckInPendingService,
    @Inject(CHECK_IN_CLOCK) private readonly clock: CheckInClock,
    @Inject(CHECK_IN_SLEEPER) private readonly sleep: CheckInSleeper,
  ) {}

  // --- Enlace de la cita ----------------------------------------------------

  /** Lo que ve la página del enlace. Solo lee. */
  async linkView(token: string): Promise<PublicArrivalView> {
    const target = await this.linkTarget(token);
    if (!target) return UNAVAILABLE_VIEW;
    return this.view(target.appointment, target.settings, this.clock());
  }

  /** «Ya llegué» desde el enlace. Idempotente; fuera de ventana, 409 y nada cambia. */
  async linkArrive(
    token: string,
    request: AuditRequestMeta | null,
  ): Promise<PublicArrivalView> {
    const target = await this.linkTarget(token);
    if (!target) throw new ConflictException(ARRIVAL_MESSAGES.UNAVAILABLE);
    const view = await this.arrive(
      target.appointment,
      target.settings,
      AppointmentArrivalSource.PATIENT_LINK,
      request,
    );
    if (view.state === 'AVAILABLE') {
      // No debería quedar sin llegada sin un error (que `arrive` relanza).
      throw new ConflictException(ARRIVAL_MESSAGES.UNAVAILABLE);
    }
    if (view.state !== 'ARRIVED') {
      throw new ConflictException(ARRIVAL_MESSAGES[view.state]);
    }
    return view;
  }

  /**
   * La cita del enlace si la sede ofrece «Ya llegué» por enlace. Un enlace
   * revocado (recepción emitió otro) o de una cita borrada no sirve. El enlace
   * caduca al empezar la cita (DX-005), pero para llegar vale todo el día de
   * la cita: la ventana la pone la sede.
   */
  private async linkTarget(token: string): Promise<{
    appointment: ArrivalAppointment;
    settings: CheckInSettings;
  } | null> {
    const { confirmation, appointment } = await findConfirmationByToken(
      this.tenantContext,
      this.confirmations,
      token,
    );
    if (confirmation.revokedAt || !appointment) return null;
    const target = await this.repo.findArrivalAppointment(appointment.id);
    if (!target) return null;
    const settings = await this.settingsOf(target.locationId);
    return settings.linkEnabled ? { appointment: target, settings } : null;
  }

  // --- QR de la sede --------------------------------------------------------

  async qrView(token: string): Promise<PublicCheckInQrView> {
    const location = await this.qrLocation(token);
    return {
      clinic: await this.confirmations.findClinicBranding(),
      locationName: location.locationName,
      timeZone: location.timeZone,
      locale: location.locale,
      hourCycle: location.hourCycle,
    };
  }

  /**
   * Identificación con el QR y llegada. Solo se buscan las citas de HOY en
   * ESA sede; un fallo (no hay paciente, no tiene cita hoy aquí, datos mal
   * escritos) responde SIEMPRE lo mismo y suma al contador de la sede e IP;
   * al quinto, 429 durante 15 minutos. Todas las respuestas tardan al menos
   * lo mismo.
   */
  async qrIdentify(
    token: string,
    input: CheckInIdentifyInput,
    request: AuditRequestMeta | null,
  ): Promise<PublicArrivalView> {
    const location = await this.qrLocation(token);
    const startedAt = Date.now();
    const floor = async () => {
      const elapsed = Date.now() - startedAt;
      if (elapsed < CHECK_IN_RESPONSE_FLOOR_MS) {
        await this.sleep(CHECK_IN_RESPONSE_FLOOR_MS - elapsed);
      }
    };
    const tenantId = this.tenantContext.getTenantId()!;
    // IPv6 por /64 (como el limitador): rotar la dirección dentro del mismo
    // prefijo no reinicia el contador.
    const clientKey = checkInClientKey(
      tenantId,
      location.locationId,
      request?.ip ? normalizeIp(request.ip) : null,
    );
    // DX-265 (revisión): también por documento, para frenar a quien rota de
    // IP contra un mismo paciente. Clave = SHA-256 del documento normalizado
    // (exista o no el paciente: misma respuesta y mismo trabajo).
    const documentKey = checkInDocumentKey(
      tenantId,
      location.locationId,
      input.documentNumber,
    );
    const keys = [clientKey, documentKey];
    // Tope por clave: 5 por IP, 10 por documento (ver CHECK_IN_DOCUMENT_MAX_FAILURES).
    const maxFor = [CHECK_IN_MAX_FAILURES, CHECK_IN_DOCUMENT_MAX_FAILURES];
    const now = this.clock();
    // Cada intento se anota ANTES de comparar, en los dos contadores (una
    // sentencia atómica cada uno): una ráfaga a la vez no compara más de
    // CHECK_IN_MAX_FAILURES datos; pasado el tope, 429 sin comparar.
    const attempts: CheckInAttemptState[] = [];
    for (const [n, key] of keys.entries()) {
      attempts.push(
        await this.repo.reserveAttempt(location.locationId, key, {
          maxAttempts: maxFor[n],
          lockMinutes: CHECK_IN_LOCK_MINUTES,
          windowMinutes: CHECK_IN_FAILURE_WINDOW_MINUTES,
        }),
      );
    }
    const lock = attempts
      .map((a) => lockedUntil(a, now))
      .filter((d): d is Date => d !== null)
      .sort((x, y) => y.getTime() - x.getTime())[0];
    if (lock) {
      await floor();
      throw locked(retryAfterSeconds(lock, now));
    }

    const matches = await this.matchToday(location, input, now);
    if (matches.length === 0) {
      await floor();
      // El quinto fallo (por IP o por documento) bloquea ya, y lo dice.
      const reached = keys.filter(
        (_, n) => attempts[n].failedAttempts >= maxFor[n],
      );
      if (reached.includes(documentKey)) {
        // Rastro para el personal sin el documento: sede y hora.
        this.logger.warn({
          event: 'self_check_in.document_locked',
          tenantId,
          locationId: location.locationId,
          lockMinutes: CHECK_IN_LOCK_MINUTES,
        });
      }
      if (reached.length > 0) {
        let until = now;
        for (const key of reached) {
          const d = await this.repo.lockClient(
            location.locationId,
            key,
            CHECK_IN_LOCK_MINUTES,
          );
          if (d.getTime() > until.getTime()) until = d;
        }
        throw locked(retryAfterSeconds(until, now));
      }
      throw noMatch();
    }
    // Acertar devuelve solo este intento: nunca limpia fallos anteriores ni un
    // bloqueo (los fallos solo caducan con su ventana).
    for (const key of keys) {
      await this.repo.refundAttempt(location.locationId, key);
    }

    // Varias citas hoy en la sede (raro): la que ya está en curso, si no la
    // que se puede marcar, si no la más próxima.
    const ranked = (
      await Promise.all(
        matches.map(async (id) => {
          const a = await this.repo.findArrivalAppointment(id);
          if (!a) return null;
          const w = arrivalWindow({
            start: a.start,
            status: a.status,
            timeZone: a.timeZone,
            settings: location.settings,
            now,
          });
          return { a, rank: STATE_RANK[w.state] };
        }),
      )
    )
      .filter((x): x is { a: ArrivalAppointment; rank: number } => x !== null)
      .sort(
        (x, y) => x.rank - y.rank || x.a.start.getTime() - y.a.start.getTime(),
      );
    if (ranked.length === 0) {
      await floor();
      throw noMatch();
    }
    const view = await this.arrive(
      ranked[0].a,
      location.settings,
      AppointmentArrivalSource.SEDE_QR,
      request,
    );
    await floor();
    return view;
  }

  private async qrLocation(token: string) {
    if (
      !this.tenantContext.getTenantId() ||
      !isWellFormedPublicLinkToken(token)
    ) {
      throw inactiveQr();
    }
    const location = await this.repo.findQrLocation(hashPublicLinkToken(token));
    if (!location) throw inactiveQr();
    return location;
  }

  /**
   * Las citas de hoy en la sede cuyo paciente casa con el documento y la
   * fecha. Se comparan TODAS las candidatas (tiempo constante por fila), sin
   * cortar al primer acierto.
   */
  private async matchToday(
    location: { locationId: string; timeZone: string | null },
    input: CheckInIdentifyInput,
    now: Date,
  ): Promise<string[]> {
    const doc = normalizeCheckInDocument(input.documentNumber);
    const dob = normalizeBirthDate(input.birthDate);
    if (!location.timeZone) return [];
    const range = civilDayRange(
      civilDateIn(now, location.timeZone),
      location.timeZone,
    );
    const candidates = await this.repo.identificationCandidates(
      location.locationId,
      range.start,
      range.end,
    );
    const out: string[] = [];
    for (const c of candidates) {
      const docOk = documentMatches(doc ?? '\u0000', c.docNumber);
      const dobOk = birthDateMatches(dob, c.birthDate);
      if (docOk && dobOk && doc !== null) out.push(c.appointmentId);
    }
    return out;
  }

  // --- Común ------------------------------------------------------------------

  private async settingsOf(locationId: string): Promise<CheckInSettings> {
    const saved = await this.repo.findSettings(locationId);
    return saved
      ? {
          linkEnabled: saved.linkEnabled,
          minutesBefore: saved.minutesBefore,
          minutesAfter: saved.minutesAfter,
          lateMinutes: saved.lateMinutes,
        }
      : { ...DEFAULT_CHECK_IN_SETTINGS };
  }

  /**
   * Marca la llegada si toca (AVAILABLE) y devuelve la vista. Ya llegado:
   * nada cambia (idempotente, sin un segundo evento). Si recepción la marcó a
   * la vez, el cambio condicionado da 409 y se relee: también es ARRIVED.
   */
  private async arrive(
    appointment: ArrivalAppointment,
    settings: CheckInSettings,
    source: AppointmentArrivalSource,
    request: AuditRequestMeta | null,
  ): Promise<PublicArrivalView> {
    const now = this.clock();
    const before = await this.view(appointment, settings, now);
    if (before.state !== 'AVAILABLE') return before;
    let failure: HttpException | null = null;
    try {
      await this.appointments.arriveByPatient(appointment.id, {
        source,
        request,
      });
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      // Cambió bajo nuestros pies (recepción la marcó, la cancelaron…): se
      // responde con lo que hay ahora.
      failure = error;
    }
    const fresh = await this.repo.findArrivalAppointment(appointment.id);
    if (!fresh) return UNAVAILABLE_VIEW;
    const after = await this.view(fresh, settings, this.clock());
    // Sigue sin llegada y la escritura falló: no se disfraza de éxito.
    if (after.state === 'AVAILABLE' && failure !== null) throw failure;
    return after;
  }

  private async view(
    a: ArrivalAppointment,
    settings: CheckInSettings,
    now: Date,
  ): Promise<PublicArrivalView> {
    const w = arrivalWindow({
      start: a.start,
      status: a.status,
      timeZone: a.timeZone,
      settings,
      now,
    });
    if (w.state === 'UNAVAILABLE') return UNAVAILABLE_VIEW;
    let result: CheckInResult | null = null;
    if (a.status === AppointmentStatus.ARRIVED && a.timeZone) {
      const pending = await this.pending.forPatients(
        [a.patientId],
        { date: civilDateIn(a.start, a.timeZone), timeZone: a.timeZone },
        now,
      );
      const items = [...(pending.get(a.patientId) ?? [])];
      if (
        a.arrivedAt &&
        isLateArrival(a.start, a.arrivedAt, settings.lateMinutes)
      ) {
        items.push('LATE');
      }
      result = checkInResult(orderPending(items));
    }
    return {
      state: w.state,
      opensAt: w.opensAt,
      closesAt: w.closesAt,
      result,
      turnNumber: w.state === 'ARRIVED' ? a.turnNumber : null,
      appointment: {
        patientFirstName: firstNameOnly(a.patientFirstName),
        start: a.start,
        locationName: a.locationName,
        timeZone: a.timeZone,
        locale: a.locale,
        hourCycle: a.hourCycle,
      },
    };
  }
}
