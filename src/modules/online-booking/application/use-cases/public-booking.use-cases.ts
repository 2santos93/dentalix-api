import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type {
  OnlineBookingMode,
  OnlineBookingPatientKind,
} from '@prisma/client';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { HourCycle } from '../../../../shared/format/regional-format';
import { civilDateIn, parseCivilDate } from '../../../../shared/time/civil-day';
import { CreateAppointmentUseCase } from '../../../appointments/application/use-cases/create-appointment.use-case';
import { OVERLAP_MESSAGES } from '../../../appointments/application/appointment-overlap-error';
import {
  BOOKING_CODE_MAX_ATTEMPTS,
  BOOKING_CODE_TTL_MINUTES,
  BOOKING_CODES_PER_HOUR,
  BOOKING_SESSION_TTL_MINUTES,
  BOT_CHALLENGE_VERIFIER,
  bookingCodeMatches,
  checkFormToken,
  deriveBookingKey,
  generateBookingCode,
  generateSessionToken,
  hashSessionToken,
  hmacBookingCode,
  honeypotTripped,
  isWellFormedBookingCode,
  isWellFormedSessionToken,
  issueFormToken,
  type BotChallengeVerifier,
} from '../../domain/booking-security';
import {
  ONLINE_BOOKING_MESSAGES,
  ONLINE_SLOT_TAKEN_CODE,
  SessionAlreadyUsedError,
} from '../../domain/online-booking-errors';
import {
  durationFor,
  modeFor,
  type OnlineBookingSettings,
} from '../../domain/online-booking-settings';
import {
  MAX_ONLINE_SLOT_DAYS,
  type OnlineSlot,
} from '../../domain/online-slots';
import {
  ONLINE_BOOKING_REPOSITORY,
  type BookableCatalog,
  type BookingSession,
  type OnlineBookingRepository,
  type PatientIdentity,
  type RequestRowInput,
} from '../../domain/ports/online-booking-repository.port';
import { OnlineBookingEmail } from '../online-booking-email';
import {
  OnlineSlotService,
  type PublicProvider,
  type ResolvedChoice,
} from '../online-slot.service';

export const ONLINE_BOOKING_CLOCK = Symbol('ONLINE_BOOKING_CLOCK');
export type OnlineBookingClock = () => Date;

/** Lo que llega de cualquier formulario de la página (anti-bots). */
export interface AntiBotInput {
  /** Campo trampa: un humano no lo ve; lleno = bot. */
  website?: unknown;
  formToken?: unknown;
  challengeToken?: string | null;
}

export interface PublicRequestInfo extends AuditRequestMeta {
  /** Host de la página (para el enlace de gestión). */
  host?: string;
}

export interface PublicBookingConfig {
  clinicName: string;
  newPatientMode: OnlineBookingMode;
  existingPatientMode: OnlineBookingMode;
  /** Sin política de datos publicada, un paciente nuevo no puede reservar. */
  newPatientsAllowed: boolean;
  minLeadMinutesNew: number;
  minLeadMinutesExisting: number;
  maxAdvanceDays: number;
  locations: {
    id: string;
    name: string;
    address: string | null;
    timeZone: string;
    locale: string | null;
    hourCycle: HourCycle | null;
  }[];
  types: {
    id: string;
    name: string;
    durationNewMinutes: number;
    durationExistingMinutes: number;
    locationIds: string[];
    providerIds: string[];
  }[];
  providers: { id: string; name: string; locationIds: string[] }[];
  privacyPolicy: {
    id: string;
    version: number;
    policyText: string;
    generalText: string;
  } | null;
  formToken: string;
}

export interface PublicSlotsInput {
  locationId: string;
  appointmentTypeId: string;
  providerId: string | null;
  patientKind: OnlineBookingPatientKind;
  from: string;
  days: number;
  sessionToken: string | null;
}

export interface PublicSlotsView {
  timeZone: string;
  durationMinutes: number;
  slots: OnlineSlot[];
  truncated: boolean;
}

export interface NewPatientData {
  firstName: string;
  lastName: string;
  birthDate: string;
  email: string;
  phone: string;
  consentPolicyVersionId: string;
  consentAccepted: boolean;
}

export interface CreateBookingInput extends AntiBotInput {
  locationId: string;
  appointmentTypeId: string;
  providerId: string | null;
  start: Date;
  /** Paciente nuevo: sus datos. Existente: `null` y la sesión del código. */
  newPatient: NewPatientData | null;
  sessionToken: string | null;
}

export interface BookingResult {
  status: 'BOOKED' | 'REQUESTED';
  start: Date;
  end: Date;
  timeZone: string;
  locationName: string;
  providerName: string;
  appointmentTypeName: string;
  /** Formato de la sede para escribir la fecha y la hora. */
  locale: string | null;
  hourCycle: HourCycle | null;
  /** Enlace de gestión (DX-005) de una reserva directa; `null` si no. */
  manageUrl: string | null;
}

/** El reloj de la sede si es uno conocido; si no, `null` (la web no inventa uno). */
function hourCycleOf(value: string | null): HourCycle | null {
  return value === 'h12' || value === 'h23' ? value : null;
}

const NAME_MAX = 80;
const EMAIL_MAX = 254;
const PHONE_MAX = 40;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ONE_LINE = /^[^\p{Cc}\u2028\u2029]+$/u;

function bad(): BadRequestException {
  return new BadRequestException(ONLINE_BOOKING_MESSAGES.badRequest);
}

function unavailable(): NotFoundException {
  return new NotFoundException(ONLINE_BOOKING_MESSAGES.unavailable);
}

function slotTaken(sessionToken: string | null): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: ONLINE_SLOT_TAKEN_CODE,
    message: ONLINE_BOOKING_MESSAGES.slotTaken,
    ...(sessionToken ? { sessionToken } : {}),
  });
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') throw bad();
  const v = value.trim().replace(/\s+/g, ' ');
  if (!v || v.length > NAME_MAX || !ONE_LINE.test(v)) throw bad();
  return v;
}

function cleanEmail(value: unknown): string {
  if (typeof value !== 'string') throw bad();
  const v = value.trim().toLowerCase();
  if (v.length > EMAIL_MAX || !EMAIL_SHAPE.test(v)) throw bad();
  return v;
}

function cleanBirthDate(value: unknown, now: Date): string {
  if (typeof value !== 'string' || parseCivilDate(value) === null) throw bad();
  // Ni en el futuro ni de hace más de 130 años.
  const today = now.toISOString().slice(0, 10);
  const oldest = `${Number(today.slice(0, 4)) - 130}${today.slice(4)}`;
  if (value > today || value < oldest) throw bad();
  return value;
}

function cleanPhone(value: unknown): string {
  if (typeof value !== 'string') throw bad();
  const v = value.trim();
  if (!v || v.length > PHONE_MAX || !/^[+\d][\d\s().-]{5,}$/.test(v)) {
    throw bad();
  }
  return v;
}

/**
 * Base de los casos de uso públicos: clínica SOLO del host (la RLS hace el
 * resto), reserva activada y la protección anti-bots.
 */
abstract class PublicBookingBase {
  protected readonly formKey: Buffer;

  constructor(
    protected readonly repo: OnlineBookingRepository,
    protected readonly tenantContext: TenantContextService,
    protected readonly slotService: OnlineSlotService,
    protected readonly clock: OnlineBookingClock,
    protected readonly challenge: BotChallengeVerifier,
    config: ConfigService,
  ) {
    this.formKey = deriveBookingKey(
      config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      'form',
    );
  }

  protected tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw unavailable();
    return tenantId;
  }

  protected async enabledSettings(): Promise<OnlineBookingSettings> {
    this.tenantId();
    const settings = await this.repo.getSettings();
    if (!settings.enabled) throw unavailable();
    return settings;
  }

  protected async guardBots(
    input: AntiBotInput,
    ip: string | null,
  ): Promise<void> {
    if (honeypotTripped(input.website)) throw bad();
    const check = checkFormToken(
      this.formKey,
      this.tenantId(),
      input.formToken,
      this.clock(),
    );
    if (check === 'TOO_FAST') {
      throw new BadRequestException(ONLINE_BOOKING_MESSAGES.tooFast);
    }
    if (check === 'EXPIRED') {
      throw new BadRequestException(ONLINE_BOOKING_MESSAGES.formExpired);
    }
    if (check !== 'OK') throw bad();
    if (
      !(await this.challenge.verify({
        token: input.challengeToken ?? null,
        ip,
      }))
    ) {
      throw new BadRequestException(ONLINE_BOOKING_MESSAGES.challengeFailed);
    }
  }

  /** La sesión del código (o de reintento), viva y sin gastar; si no, 401. */
  protected async session(
    token: string | null,
  ): Promise<BookingSession | null> {
    if (token === null) return null;
    if (!isWellFormedSessionToken(token)) {
      throw new UnauthorizedException(ONLINE_BOOKING_MESSAGES.sessionInvalid);
    }
    const session = await this.repo.findSession(hashSessionToken(token));
    if (
      !session ||
      session.consumedAt !== null ||
      session.expiresAt.getTime() <= this.clock().getTime()
    ) {
      throw new UnauthorizedException(ONLINE_BOOKING_MESSAGES.sessionInvalid);
    }
    return session;
  }

  protected async offer(): Promise<{
    catalog: BookableCatalog;
    providers: PublicProvider[];
  }> {
    const catalog = await this.repo.catalog();
    const providers = await this.slotService.providers(
      catalog.locations.map((l) => l.id),
    );
    return { catalog, providers };
  }
}

/** GET /public/booking: lo que la página puede ofrecer. */
@Injectable()
export class GetPublicBookingConfigUseCase extends PublicBookingBase {
  constructor(
    @Inject(ONLINE_BOOKING_REPOSITORY) repo: OnlineBookingRepository,
    tenantContext: TenantContextService,
    slotService: OnlineSlotService,
    @Inject(ONLINE_BOOKING_CLOCK) clock: OnlineBookingClock,
    @Inject(BOT_CHALLENGE_VERIFIER) challenge: BotChallengeVerifier,
    config: ConfigService,
  ) {
    super(repo, tenantContext, slotService, clock, challenge, config);
  }

  async execute(): Promise<PublicBookingConfig> {
    const settings = await this.enabledSettings();
    const { catalog, providers } = await this.offer();
    const locations = catalog.locations.filter(
      (l): l is typeof l & { timeZone: string } => l.timeZone !== null,
    );
    const types = catalog.types
      .map((t) => {
        const locationIds = locations
          .filter(
            (l) =>
              this.slotService.offeredAt(t, l.id) &&
              this.slotService.providersFor(t, l.id, providers).length > 0,
          )
          .map((l) => l.id);
        const providerIds = providers
          .filter((p) =>
            locationIds.some(
              (l) => this.slotService.providersFor(t, l, [p]).length > 0,
            ),
          )
          .map((p) => p.id);
        return {
          id: t.appointmentTypeId,
          name: t.name,
          durationNewMinutes: durationFor(t, t, 'NEW'),
          durationExistingMinutes: durationFor(t, t, 'EXISTING'),
          locationIds,
          providerIds,
        };
      })
      .filter((t) => t.locationIds.length > 0);
    const offeredLocations = new Set(types.flatMap((t) => t.locationIds));
    const offeredProviders = new Set(types.flatMap((t) => t.providerIds));
    return {
      clinicName: catalog.clinicName,
      newPatientMode: settings.newPatientMode,
      existingPatientMode: settings.existingPatientMode,
      newPatientsAllowed: catalog.privacyPolicy !== null,
      minLeadMinutesNew: settings.minLeadMinutesNew,
      minLeadMinutesExisting: settings.minLeadMinutesExisting,
      maxAdvanceDays: settings.maxAdvanceDays,
      locations: locations
        .filter((l) => offeredLocations.has(l.id))
        .map((l) => ({
          id: l.id,
          name: l.name,
          address: l.address,
          timeZone: l.timeZone,
          locale: l.locale,
          hourCycle: hourCycleOf(l.hourCycle),
        })),
      types,
      providers: providers
        .filter((p) => offeredProviders.has(p.id))
        .map((p) => ({
          id: p.id,
          name: p.fullName,
          locationIds: p.locationIds,
        })),
      privacyPolicy: catalog.privacyPolicy,
      formToken: issueFormToken(this.formKey, this.tenantId(), this.clock()),
    };
  }
}

/** GET /public/booking/slots: solo instantes libres. */
@Injectable()
export class ListPublicSlotsUseCase extends PublicBookingBase {
  constructor(
    @Inject(ONLINE_BOOKING_REPOSITORY) repo: OnlineBookingRepository,
    tenantContext: TenantContextService,
    slotService: OnlineSlotService,
    @Inject(ONLINE_BOOKING_CLOCK) clock: OnlineBookingClock,
    @Inject(BOT_CHALLENGE_VERIFIER) challenge: BotChallengeVerifier,
    config: ConfigService,
  ) {
    super(repo, tenantContext, slotService, clock, challenge, config);
  }

  async execute(input: PublicSlotsInput): Promise<PublicSlotsView> {
    const settings = await this.enabledSettings();
    if (
      parseCivilDate(input.from) === null ||
      !Number.isInteger(input.days) ||
      input.days < 1 ||
      input.days > MAX_ONLINE_SLOT_DAYS
    ) {
      throw bad();
    }
    const session = await this.session(input.sessionToken);
    const { catalog, providers } = await this.offer();
    const choice = this.slotService.resolve(
      catalog,
      providers,
      input.locationId,
      input.appointmentTypeId,
      input.providerId,
    );
    if (!choice) {
      throw new NotFoundException(ONLINE_BOOKING_MESSAGES.invalidOption);
    }
    const result = await this.slotService.slots(settings, choice, {
      locationId: input.locationId,
      appointmentTypeId: input.appointmentTypeId,
      providerId: input.providerId,
      // Con sesión manda el paciente identificado (su duración y sus citas).
      patientKind: session?.patientKind ?? input.patientKind,
      patientId: session?.patientId ?? null,
      fromDay: input.from,
      days: input.days,
      now: this.clock(),
    });
    return result;
  }
}

/** POST /public/booking/verification: pedir el código (respuesta idéntica siempre). */
@Injectable()
export class RequestBookingCodeUseCase extends PublicBookingBase {
  private readonly codeKey: Buffer;

  constructor(
    @Inject(ONLINE_BOOKING_REPOSITORY) repo: OnlineBookingRepository,
    tenantContext: TenantContextService,
    slotService: OnlineSlotService,
    @Inject(ONLINE_BOOKING_CLOCK) clock: OnlineBookingClock,
    @Inject(BOT_CHALLENGE_VERIFIER) challenge: BotChallengeVerifier,
    config: ConfigService,
    private readonly email: OnlineBookingEmail,
  ) {
    super(repo, tenantContext, slotService, clock, challenge, config);
    this.codeKey = deriveBookingKey(
      config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      'code',
    );
  }

  async execute(
    input: AntiBotInput & {
      firstName: unknown;
      lastName: unknown;
      birthDate: unknown;
      email: unknown;
    },
    meta: AuditRequestMeta,
  ): Promise<{ verificationId: string; expiresAt: Date; message: string }> {
    await this.enabledSettings();
    await this.guardBots(input, meta.ip);
    const now = this.clock();
    const identity: PatientIdentity = {
      firstName: cleanName(input.firstName),
      lastName: cleanName(input.lastName),
      birthDate: cleanBirthDate(input.birthDate, now),
      email: cleanEmail(input.email),
    };
    const matches = await this.repo.findExistingPatients(identity);
    // Solo con UNA ficha que casa, y sin pasar el tope por hora, se envía.
    let patientId: string | null = matches.length === 1 ? matches[0] : null;
    if (
      patientId &&
      (await this.repo.countCodesSince(
        patientId,
        new Date(now.getTime() - 60 * 60_000),
      )) >= BOOKING_CODES_PER_HOUR
    ) {
      patientId = null;
    }
    const id = randomUUID();
    const code = generateBookingCode();
    const expiresAt = new Date(
      now.getTime() + BOOKING_CODE_TTL_MINUTES * 60_000,
    );
    await this.repo.createVerification(
      {
        id,
        patientId,
        codeHmac: hmacBookingCode(this.codeKey, id, code),
        codeExpiresAt: expiresAt,
      },
      meta,
    );
    if (patientId) {
      const { catalog } = await this.offer();
      await this.email.sendCode({
        tenantId: this.tenantId(),
        to: identity.email,
        referenceId: id,
        firstName: identity.firstName,
        clinicName: catalog.clinicName,
        code,
      });
    }
    return {
      verificationId: id,
      expiresAt,
      message: ONLINE_BOOKING_MESSAGES.codeSent,
    };
  }
}

/** POST /public/booking/verification/:id/verify: el código abre la sesión. */
@Injectable()
export class VerifyBookingCodeUseCase extends PublicBookingBase {
  private readonly codeKey: Buffer;

  constructor(
    @Inject(ONLINE_BOOKING_REPOSITORY) repo: OnlineBookingRepository,
    tenantContext: TenantContextService,
    slotService: OnlineSlotService,
    @Inject(ONLINE_BOOKING_CLOCK) clock: OnlineBookingClock,
    @Inject(BOT_CHALLENGE_VERIFIER) challenge: BotChallengeVerifier,
    config: ConfigService,
  ) {
    super(repo, tenantContext, slotService, clock, challenge, config);
    this.codeKey = deriveBookingKey(
      config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      'code',
    );
  }

  async execute(
    verificationId: string,
    code: unknown,
    meta: AuditRequestMeta,
  ): Promise<{ sessionToken: string; expiresAt: Date }> {
    await this.enabledSettings();
    const invalid = () =>
      new BadRequestException(ONLINE_BOOKING_MESSAGES.codeInvalid);
    if (!isWellFormedBookingCode(code)) throw invalid();
    const row = await this.repo.findVerification(verificationId);
    const now = this.clock();
    if (
      !row ||
      row.verifiedAt !== null ||
      row.lockedAt !== null ||
      !row.codeExpiresAt ||
      row.codeExpiresAt.getTime() <= now.getTime()
    ) {
      throw invalid();
    }
    if (
      !row.patientId ||
      !bookingCodeMatches(this.codeKey, row.id, code, row.codeHmac)
    ) {
      await this.repo.recordFailedAttempt(row, BOOKING_CODE_MAX_ATTEMPTS, meta);
      throw invalid();
    }
    const sessionToken = generateSessionToken();
    const expiresAt = new Date(
      now.getTime() + BOOKING_SESSION_TTL_MINUTES * 60_000,
    );
    const ok = await this.repo.markVerified(
      row,
      { tokenHash: hashSessionToken(sessionToken), expiresAt },
      now,
      meta,
    );
    if (!ok) throw invalid();
    return { sessionToken, expiresAt };
  }
}

/**
 * POST /public/booking: reservar (directa) o pedir (solicitud). El inicio
 * tiene que estar entre los huecos del MISMO cálculo de la página; la cita la
 * crea `CreateAppointmentUseCase` con todas sus reglas y la EXCLUDE de la BD
 * decide entre dos reservas a la vez (la otra recibe 409 ONLINE_SLOT_TAKEN).
 */
@Injectable()
export class CreatePublicBookingUseCase extends PublicBookingBase {
  constructor(
    @Inject(ONLINE_BOOKING_REPOSITORY) repo: OnlineBookingRepository,
    tenantContext: TenantContextService,
    slotService: OnlineSlotService,
    @Inject(ONLINE_BOOKING_CLOCK) clock: OnlineBookingClock,
    @Inject(BOT_CHALLENGE_VERIFIER) challenge: BotChallengeVerifier,
    config: ConfigService,
    private readonly createAppointment: CreateAppointmentUseCase,
    private readonly email: OnlineBookingEmail,
  ) {
    super(repo, tenantContext, slotService, clock, challenge, config);
  }

  async execute(
    input: CreateBookingInput,
    meta: PublicRequestInfo,
  ): Promise<BookingResult> {
    const settings = await this.enabledSettings();
    await this.guardBots(input, meta.ip);
    if (!(input.start instanceof Date) || Number.isNaN(input.start.getTime())) {
      throw bad();
    }
    const session = await this.session(input.sessionToken);
    if (!session && !input.newPatient) {
      throw new UnauthorizedException(ONLINE_BOOKING_MESSAGES.sessionInvalid);
    }
    const now = this.clock();
    const { catalog, providers } = await this.offer();
    const choice = this.slotService.resolve(
      catalog,
      providers,
      input.locationId,
      input.appointmentTypeId,
      input.providerId,
    );
    if (!choice) {
      throw new NotFoundException(ONLINE_BOOKING_MESSAGES.invalidOption);
    }

    // Quién reserva: la sesión (existente, o reintento de una ficha nueva)
    // o los datos de un paciente nuevo.
    let patientId: string | null = session?.patientId ?? null;
    let patientKind: OnlineBookingPatientKind = session?.patientKind ?? 'NEW';
    let possibleDuplicate = false;
    let contact: { email: string | null; phone: string | null } = {
      email: null,
      phone: null,
    };
    let newPatient: (NewPatientData & { birthDate: string }) | null = null;
    if (!session && input.newPatient) {
      if (!catalog.privacyPolicy) {
        throw new ConflictException(ONLINE_BOOKING_MESSAGES.noPolicy);
      }
      if (input.newPatient.consentAccepted !== true) {
        throw new BadRequestException(ONLINE_BOOKING_MESSAGES.consentRequired);
      }
      newPatient = {
        firstName: cleanName(input.newPatient.firstName),
        lastName: cleanName(input.newPatient.lastName),
        birthDate: cleanBirthDate(input.newPatient.birthDate, now),
        email: cleanEmail(input.newPatient.email),
        phone: cleanPhone(input.newPatient.phone),
        consentPolicyVersionId: input.newPatient.consentPolicyVersionId,
        consentAccepted: true,
      };
      contact = { email: newPatient.email, phone: newPatient.phone };
      patientKind = 'NEW';
      // Una ficha parecida: no se crea otra; recepción comprueba.
      const candidate = await this.repo.findDuplicateCandidate(newPatient);
      if (candidate) {
        patientId = candidate;
        possibleDuplicate = true;
        newPatient = null;
      }
    }

    // El hueco tiene que salir del MISMO cálculo (su día, sus reglas).
    const slot = await this.findSlot(settings, choice, {
      start: input.start,
      patientKind,
      // Con una ficha «parecida» no se miran sus citas: no se revela nada de
      // otro paciente (la solicitud no crea cita).
      patientId: possibleDuplicate ? null : patientId,
      providerId: input.providerId,
      now,
    });
    if (!slot) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'ONLINE_SLOT_GONE',
        message: ONLINE_BOOKING_MESSAGES.slotGone,
      });
    }
    const provider = choice.providers.find((p) => p.id === slot.providerId)!;
    const mode: OnlineBookingMode = possibleDuplicate
      ? 'REQUEST'
      : modeFor(settings, patientKind);
    const row = (pid: string): RequestRowInput => ({
      locationId: choice.location.id,
      providerId: slot.providerId,
      appointmentTypeId: choice.type.appointmentTypeId,
      patientId: pid,
      patientKind,
      start: slot.start,
      end: slot.end,
      possibleDuplicate,
      contactEmail: contact.email,
      contactPhone: contact.phone,
      sessionId: session?.verificationId ?? null,
    });
    const result = (
      status: BookingResult['status'],
      manageUrl: string | null,
    ) => ({
      status,
      start: slot.start,
      end: slot.end,
      timeZone: choice.location.timeZone,
      locationName: choice.location.name,
      providerName: provider.fullName,
      appointmentTypeName: choice.type.name,
      locale: choice.location.locale,
      hourCycle: hourCycleOf(choice.location.hourCycle),
      manageUrl,
    });

    if (mode === 'REQUEST') {
      let requestId: string;
      if (newPatient) {
        let created = '';
        await this.repo.createNewPatient(
          this.newPatientInput(newPatient),
          meta,
          async (tx, pid) => {
            created = pid;
            requestId = await this.repo.insertRequestInTx(tx, row(pid), meta);
          },
        );
        patientId = created;
      } else {
        requestId = await this.repo.createRequest(row(patientId!), meta);
      }
      await this.email.sendReceived({
        tenantId: this.tenantId(),
        patientId: patientId!,
        referenceId: requestId!,
        clinicName: catalog.clinicName,
        state: 'REQUESTED',
        start: slot.start,
        locationId: choice.location.id,
        providerName: provider.fullName,
        manageUrl: null,
      });
      return result('REQUESTED', null);
    }

    // Reserva directa. Una ficha nueva se crea antes de la cita: si otro
    // gana el hueco, se devuelve una sesión para elegir otro sin duplicarla.
    if (newPatient) {
      patientId = await this.repo.createNewPatient(
        this.newPatientInput(newPatient),
        meta,
      );
    }
    let appointmentId: string;
    try {
      const created = await this.createAppointment.execute({
        patientId: patientId!,
        providerId: slot.providerId,
        locationId: choice.location.id,
        appointmentTypeId: choice.type.appointmentTypeId,
        start: slot.start,
        end: slot.end,
        actorRole: null,
        origin: 'ONLINE',
        inTransaction: async (tx, appointment) => {
          await this.repo.insertBookedInTx(
            tx,
            { ...row(patientId!), appointmentId: appointment.id },
            meta,
          );
        },
      });
      appointmentId = created.id;
    } catch (error) {
      throw await this.bookingConflict(
        error,
        newPatient ? patientId : null,
        now,
      );
    }
    const manageUrl = await this.email.manageUrl(
      this.tenantId(),
      appointmentId,
      meta.host,
    );
    await this.email.sendReceived({
      tenantId: this.tenantId(),
      patientId: patientId!,
      referenceId: appointmentId,
      clinicName: catalog.clinicName,
      state: 'BOOKED',
      start: slot.start,
      locationId: choice.location.id,
      providerName: provider.fullName,
      manageUrl,
    });
    return result('BOOKED', manageUrl);
  }

  private newPatientInput(p: NewPatientData) {
    return {
      firstName: p.firstName,
      lastName: p.lastName,
      birthDate: p.birthDate,
      email: p.email,
      phone: p.phone,
      policyVersionId: p.consentPolicyVersionId,
    };
  }

  private async findSlot(
    settings: OnlineBookingSettings,
    choice: ResolvedChoice,
    q: {
      start: Date;
      patientKind: OnlineBookingPatientKind;
      patientId: string | null;
      providerId: string | null;
      now: Date;
    },
  ): Promise<OnlineSlot | null> {
    const day = civilDateIn(q.start, choice.location.timeZone);
    const { slots } = await this.slotService.slots(settings, choice, {
      locationId: choice.location.id,
      appointmentTypeId: choice.type.appointmentTypeId,
      providerId: q.providerId,
      patientKind: q.patientKind,
      patientId: q.patientId,
      fromDay: day,
      days: 1,
      now: q.now,
    });
    return slots.find((s) => s.start.getTime() === q.start.getTime()) ?? null;
  }

  /**
   * Lo que devuelve la página si el alta de la cita falla. Un 409 / 422 de
   * agenda (otro ganó el hueco, un bloqueo nuevo, el horario cambió) es el
   * mensaje claro de «hueco ocupado»; un solape del propio paciente, el suyo.
   * Con una ficha recién creada, una sesión para reintentar sin duplicarla.
   */
  private async bookingConflict(
    error: unknown,
    newPatientId: string | null,
    now: Date,
  ): Promise<unknown> {
    const agenda =
      error instanceof ConflictException ||
      error instanceof UnprocessableEntityException ||
      error instanceof BadRequestException;
    if (!agenda || error instanceof SessionAlreadyUsedError) return error;
    let sessionToken: string | null = null;
    if (newPatientId) {
      sessionToken = generateSessionToken();
      await this.repo.createRetrySession(
        newPatientId,
        {
          tokenHash: hashSessionToken(sessionToken),
          expiresAt: new Date(
            now.getTime() + BOOKING_SESSION_TTL_MINUTES * 60_000,
          ),
        },
        now,
      );
    }
    const response = error.getResponse();
    const message =
      typeof response === 'object' && response !== null
        ? (response as { message?: unknown }).message
        : response;
    if (message === OVERLAP_MESSAGES.patient) {
      return new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'ONLINE_PATIENT_BUSY',
        message: 'Ya tienes otra cita a esa hora. Elige otra hora.',
        ...(sessionToken ? { sessionToken } : {}),
      });
    }
    return slotTaken(sessionToken);
  }
}
