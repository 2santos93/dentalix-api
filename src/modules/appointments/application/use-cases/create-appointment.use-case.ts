import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  SCHEDULE_BLOCKED_RACE_MESSAGE,
  ScheduleBlockedRaceError,
} from '../../../schedule-blocks/domain/schedule-block-rules';
import type { ClinicRole } from '@prisma/client';
import { APPOINTMENT_REPOSITORY } from '../../domain/ports/appointment-repository.port';
import type {
  AppointmentRepository,
  CreateAppointmentRepoInput,
} from '../../domain/ports/appointment-repository.port';
import { AppointmentWriteResult } from '../../domain/entities/appointment.entity';
import { checkScheduleBlocks } from '../schedule-block-check';
import { assertNotOnHoliday } from '../holiday-check';
import {
  SCHEDULE_BLOCK_CLOCK,
  systemScheduleBlockClock,
  type ScheduleBlockClock,
} from '../../../schedule-blocks/application/schedule-block-clock';
import {
  OVERLAP_MESSAGES,
  overlapExclusionScope,
} from '../appointment-overlap-error';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { LOCATION_SCHEDULE_REPOSITORY } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import type { LocationScheduleRepository } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import {
  businessHoursErrorMessage,
  fitsBusinessHours,
} from '../../../location-schedule/application/business-hours';
import { STAFF_REPOSITORY } from '../../../staff/domain/ports/staff-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import { APPOINTMENT_TYPE_REPOSITORY } from '../../../appointment-types/domain/ports/appointment-type-repository.port';
import type { AppointmentTypeRepository } from '../../../appointment-types/domain/ports/appointment-type-repository.port';
import { endFromDuration } from '../../../appointment-types/domain/appointment-type-rules';
import { SCHEDULE_BLOCK_REPOSITORY } from '../../../schedule-blocks/domain/ports/schedule-block-repository.port';
import type { ScheduleBlockRepository } from '../../../schedule-blocks/domain/ports/schedule-block-repository.port';
import { assertAttendsAt } from '../../../staff/domain/provider-location';
import { assertAttendingRole } from '../../../staff/domain/attending';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { ProviderAvailabilityService } from '../../../provider-schedule/application/provider-availability.service';
import { requireLocationFormat } from '../../../../shared/locations/location-regional';
import { collectWarnings, type Warnings } from '../appointment-warnings';
import { ChairAssignmentService } from '../chair-assignment';
import type { Chair } from '../../../chairs/domain/entities/chair.entity';
import { resolveAppointmentProviderId } from '../../../chairs/domain/chair-rules';
import {
  attemptRule,
  type SlotRuleCollector,
  type SlotRuleFailure,
} from '../slot-rule-failure';

// NOTE: deliberately NO `tenantId`/`status` field — tenant comes from the
// guarded request context (the repository reads it, never this input), and
// a newly created appointment always starts SCHEDULED (the schema default).
export interface CreateAppointmentInput {
  planItemIds?: string[];
  patientId: string;
  /**
   * DX-211: opcional si viene `chairId` con profesional por defecto (el
   * elegido manda siempre; sin ninguno, 400).
   */
  providerId?: string;
  start: Date;
  /** DX-121: opcional si viene `appointmentTypeId` (sale de su duración). */
  end?: Date;
  reason?: string;
  notes?: string;
  createdById?: string;
  /** DX-121: tipo de cita (de esta clínica y activo). */
  appointmentTypeId?: string;
  /**
   * DX-122: sede de la cita cuando no es la del request (agendar desde
   * «Pendientes»: la de la entrada, ya validada). Manda en el horario y en los
   * bloqueos que se miran. No llega del cliente.
   */
  locationId?: string;
  /** DX-122: la entrada de pendientes que esta cita resuelve (pasa a SCHEDULED). */
  waitlistEntryId?: string;
  /** DX-210: «Adelantar si hay hueco». */
  wantsEarlier?: boolean;
  /**
   * DX-446: rol de quien agenda (decide si puede saltarse un hueco
   * reservado). Lo pone el controlador desde el token, nunca el cliente.
   */
  actorRole?: ClinicRole | null;
  /** DX-446: «Agendar igualmente» en un hueco reservado (5–300 caracteres). */
  overrideReason?: string;
  /** DX-211: sillón de la cita (de esta clínica, de su sede y activo). */
  chairId?: string;
  /**
   * DX-263: el lote de importación que crea la cita (`createImported`). No
   * llega del cliente.
   */
  importBatchId?: string;
  /** DX-016: la crea la reserva online (marca «Online»). No llega del cliente. */
  origin?: CreateAppointmentRepoInput['origin'];
  /** DX-016: trabajo en la misma transacción del alta (ver el repositorio). */
  inTransaction?: CreateAppointmentRepoInput['inTransaction'];
  /** DX-465: agendar desde recall (canal y nota del «Agendó» de ese recall). */
  recallContact?: CreateAppointmentRepoInput['recallContact'];
}

/**
 * DX-263: una cita de la hoja de citas del importador. La sede, el
 * profesional y el tipo ya vienen resueltos a ids (por nombre y email); el
 * paciente puede no existir todavía (lo creará el mismo lote): `null`.
 */
export interface ImportedAppointmentInput {
  patientId: string | null;
  providerId: string;
  locationId: string;
  start: Date;
  end?: Date;
  appointmentTypeId?: string;
  reason?: string;
}

/** La entrada con la hora de fin ya resuelta (explícita o por el tipo). */
type ResolvedAppointmentInput = CreateAppointmentInput & { end: Date };

/** Lo que `prepare` deja listo para `write`: la cita validada y sus avisos. */
interface PreparedAppointment {
  input: ResolvedAppointmentInput & { providerId: string };
  chair: Chair | null;
  warnings: Warnings;
  blockCheck: Awaited<ReturnType<typeof checkScheduleBlocks>>;
}

/**
 * DX-562: lo común a todas las fechas de una serie, ya validado una vez
 * (tipo, paciente, sede, sillón y profesional): solo cambia la hora.
 */
export interface SeriesSlotContext {
  input: ResolvedAppointmentInput & { providerId: string; locationId: string };
  chair: Chair | null;
  /** Duración de cada cita (la de la base: fin explícito o la del tipo). */
  durationMs: number;
}

/**
 * DX-263: marcador del paciente que aún no existe en `validateImported`
 * (nunca se consulta ni se escribe: `checkPatient` es false).
 */
const NO_PATIENT_YET = '00000000-0000-0000-0000-000000000000';

export const APPOINTMENT_TYPE_UNAVAILABLE_MESSAGE =
  'El tipo de cita no existe o está desactivado';

export const PROVIDER_REQUIRED_MESSAGE = 'Elige un profesional';
export const CHAIR_WITHOUT_PROVIDER_MESSAGE =
  'Elige un profesional: el sillón no tiene profesional por defecto';

@Injectable()
export class CreateAppointmentUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY)
    private readonly repo: AppointmentRepository,
    // Se inyectan (no se re-implementan) para resolver "¿este paciente y este
    // profesional son de ESTA clínica?" — mismo patrón cross-module que
    // AddTreatmentPlanItemUseCase inyectando DENTAL_CATALOG_REPOSITORY.
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
    @Inject(STAFF_REPOSITORY)
    private readonly staff: StaffRepository,
    @Inject(LOCATION_SCHEDULE_REPOSITORY)
    private readonly schedule: LocationScheduleRepository,
    @Inject(APPOINTMENT_TYPE_REPOSITORY)
    private readonly types: AppointmentTypeRepository,
    // DX-122: no agendar encima de un bloqueo que no lo permite.
    @Inject(SCHEDULE_BLOCK_REPOSITORY)
    private readonly blocks: ScheduleBlockRepository,
    private readonly tenantContext: TenantContextService,
    // DX-233: fuera del horario del profesional en la sede → aviso, o 409 si
    // la clínica activó el modo estricto.
    private readonly availability: ProviderAvailabilityService,
    // DX-446: «¿ya se liberó el hueco reservado?» (inyectable en los tests).
    @Optional()
    @Inject(SCHEDULE_BLOCK_CLOCK)
    private readonly clock: ScheduleBlockClock = systemScheduleBlockClock,
    // DX-211: sillón de la cita. Opcional para los dobles de los specs
    // anteriores, que no agendan con sillón; la app siempre lo provee.
    @Optional()
    @Inject(ChairAssignmentService)
    private readonly chairs: ChairAssignmentService | null = null,
  ) {}

  async execute(
    input: CreateAppointmentInput,
  ): Promise<AppointmentWriteResult> {
    const resolved = await this.resolveEnd(input);

    // No agendar en el pasado: una cita nueva siempre es a futuro. Se compara
    // el INSTANTE (no solo la fecha), así que "hoy a una hora ya pasada" también
    // se rechaza — que es el caso que más se cuela por un `<input type="date">`
    // sin `min`. `start === now` se permite (solo se rechaza estrictamente
    // anterior), para no fallar por el segundo que tarda el submit en llegar.
    // Nota: esto aplica a CREAR; registrar/cerrar una cita YA pasada se hace
    // cambiando su estado (ver UpdateAppointmentUseCase, que solo valida el
    // pasado cuando se re-agenda).
    this.assertFuture(resolved);

    return this.createChecked(resolved, { checkHoliday: true });
  }

  /**
   * Carga HISTÓRICA: registra una cita que ya ocurrió (seed demo,
   * importaciones). Aplica EXACTAMENTE las mismas reglas que `execute` —
   * pertenencia de paciente y profesional, horario de la sede, solapes 409 —
   * salvo "no agendar en el pasado", que solo tiene sentido para quien agenda
   * desde la UI. Deliberadamente NO lo expone ningún controlador.
   * DX-263-bis: tampoco mira los festivos: una visita que YA ocurrió es un
   * hecho (pudo atenderse un día que después se marcó festivo).
   */
  async registerHistorical(
    input: CreateAppointmentInput,
  ): Promise<AppointmentWriteResult> {
    return this.createChecked(await this.resolveEnd(input), {
      checkHoliday: false,
    });
  }

  /**
   * DX-263: valida una cita importada con EXACTAMENTE las reglas de agendar a
   * mano (futura, tipo activo, sede permitida, profesional de la clínica que
   * atiende en la sede, horario de la sede y del profesional, festivos de la
   * sede, bloqueos y solapes de profesional y paciente) SIN escribir nada. Con `patientId`
   * null (paciente que creará el lote) no se mira el eje del paciente: no
   * tiene citas. Lanza la misma excepción HTTP que el alta manual; devuelve
   * los avisos que no la impiden.
   */
  async validateImported(
    input: ImportedAppointmentInput,
  ): Promise<Warnings & { end: Date }> {
    const resolved = await this.resolveEnd(this.importedInput(input));
    this.assertFuture(resolved);
    const prepared = await this.prepare(resolved, {
      checkPatient: input.patientId !== null,
      checkHoliday: true,
    });
    return { ...prepared.warnings, end: resolved.end };
  }

  /**
   * DX-562: lo común de una serie, con EXACTAMENTE las reglas de agendar a
   * mano que no dependen de la hora: tipo activo (y la duración), paciente de
   * la clínica, sede permitida (la del request o, sin cabecera, la de
   * escritura de la sesión), sillón y profesional que atiende en ella. Lanza
   * la misma excepción HTTP que el alta manual.
   */
  async prepareSeries(
    input: CreateAppointmentInput,
  ): Promise<SeriesSlotContext> {
    const resolved = await this.resolveEnd(input);
    const participants = await this.resolveParticipants(resolved, {
      checkPatient: true,
    });
    return {
      input: {
        ...resolved,
        providerId: participants.providerId,
        locationId: participants.target,
      },
      chair: participants.chair,
      durationMs: resolved.end.getTime() - resolved.start.getTime(),
    };
  }

  /**
   * DX-562: las reglas de agendar que dependen de la hora (pasado, horario y
   * festivos de la sede, horario del profesional, bloqueos y solapes del
   * profesional, del paciente y del sillón) para UNA fecha de la serie, sin
   * escribir y SIN pararse en la primera: devuelve todos los fallos (con la
   * misma excepción que daría la cita suelta) y los avisos.
   */
  async checkSeriesSlot(
    context: SeriesSlotContext,
    slot: { start: Date; end: Date },
  ): Promise<{ failures: SlotRuleFailure[]; warnings: Warnings }> {
    const failures: SlotRuleFailure[] = [];
    const collect: SlotRuleCollector = (f) => failures.push(f);
    try {
      this.assertFuture(slot);
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      collect({ step: 'PAST', error });
    }
    const prepared = await this.prepareFor(
      { ...context.input, start: slot.start, end: slot.end },
      context.input.locationId,
      context.chair,
      { checkPatient: true, checkHoliday: true },
      collect,
    );
    return { failures, warnings: prepared.warnings };
  }

  /**
   * DX-263: crea una cita importada (el trabajo del lote, con el paciente ya
   * creado), con las mismas reglas que `execute` y el respaldo de las EXCLUDE
   * de la BD. La cita queda ligada a su lote (`importBatchId`).
   */
  async createImported(
    input: ImportedAppointmentInput & {
      patientId: string;
      importBatchId: string;
      createdById?: string;
    },
  ): Promise<AppointmentWriteResult> {
    const resolved = await this.resolveEnd({
      ...this.importedInput(input),
      importBatchId: input.importBatchId,
      createdById: input.createdById,
    });
    this.assertFuture(resolved);
    return this.createChecked(resolved, { checkHoliday: true });
  }

  private importedInput(
    input: ImportedAppointmentInput,
  ): CreateAppointmentInput {
    return {
      // El eje del paciente se salta con `checkPatient: false`: ningún id se
      // inventa para él (el uuid nulo no es de nadie).
      patientId: input.patientId ?? NO_PATIENT_YET,
      providerId: input.providerId,
      locationId: input.locationId,
      start: input.start,
      end: input.end,
      appointmentTypeId: input.appointmentTypeId,
      reason: input.reason,
    };
  }

  private assertFuture(input: { start: Date }): void {
    if (input.start.getTime() < Date.now()) {
      throw new BadRequestException(
        'No se puede agendar una cita en el pasado',
      );
    }
  }

  /**
   * Hora de fin (DX-121): la explícita si viene; si no, la duración del tipo.
   * El tipo tiene que ser de ESTA clínica (RLS) y estar activo: uno
   * desactivado ya no se ofrece en el selector, así que tampoco se acepta.
   */
  private async resolveEnd(
    input: CreateAppointmentInput,
  ): Promise<ResolvedAppointmentInput> {
    let durationMinutes: number | undefined;
    if (input.appointmentTypeId !== undefined) {
      const type = await this.types.findById(input.appointmentTypeId);
      if (!type || !type.active) {
        throw new BadRequestException(APPOINTMENT_TYPE_UNAVAILABLE_MESSAGE);
      }
      durationMinutes = type.durationMinutes;
    }
    const end =
      input.end ??
      (durationMinutes !== undefined
        ? endFromDuration(input.start, durationMinutes)
        : undefined);
    if (end === undefined) {
      throw new BadRequestException('Indica la hora de fin o un tipo de cita');
    }
    if (end <= input.start) {
      throw new BadRequestException(
        'La hora de fin debe ser posterior a la de inicio.',
      );
    }
    return { ...input, end };
  }

  private async createChecked(
    input: ResolvedAppointmentInput,
    opts: { checkHoliday: boolean },
  ): Promise<AppointmentWriteResult> {
    return this.write(
      await this.prepare(input, { checkPatient: true, ...opts }),
    );
  }

  /**
   * Todas las reglas de agendar, sin escribir: pertenencia del paciente (si
   * `checkPatient`), sede, sillón, profesional, horario de la sede, festivos
   * de la sede (si `checkHoliday`), horario del profesional, bloqueos y
   * solapes. Lo que necesita `write`.
   */
  private async prepare(
    input: ResolvedAppointmentInput,
    opts: { checkPatient: boolean; checkHoliday: boolean },
  ): Promise<PreparedAppointment> {
    const { providerId, target, chair } = await this.resolveParticipants(
      input,
      opts,
    );
    return this.prepareFor({ ...input, providerId }, target, chair, opts);
  }

  /**
   * Paciente (si `checkPatient`), sede, sillón y profesional de la cita: lo
   * que no depende de la hora.
   */
  private async resolveParticipants(
    input: ResolvedAppointmentInput,
    opts: { checkPatient: boolean },
  ): Promise<{ providerId: string; target: string; chair: Chair | null }> {
    // `patientId` y `providerId` tienen que resolver a entidades REALES de ESTA
    // clínica, antes de mirar solapes (un id inválido hace que el solape no
    // signifique nada). Ambos repos filtran por tenant vía RLS, así que un
    // paciente/profesional de otro tenant devuelve null igual que uno inexistente.
    //
    // Por qué importa: `patientId` solo tenía una FK a `patients(id)`, que NO
    // valida el tenant (las FK de Postgres se chequean saltando la RLS), así que
    // se podía agendar contra un paciente de OTRA clínica. Y `providerId` no
    // tenía ninguna validación: cualquier UUID pasaba como "profesional".
    if (opts.checkPatient) {
      const patient = await this.patients.findById(input.patientId);
      if (!patient) {
        throw new NotFoundException('Paciente no encontrado');
      }
    }

    // DX-089: la sede de la cita (la de pendientes, ya permitida, o la misma en
    // la que el repositorio la escribirá: la del request o, sin cabecera, la
    // de escritura de la sesión) — y el profesional tiene que atender en ella
    // (DX-121d), también sin cabecera.
    if (input.locationId !== undefined) {
      this.tenantContext.assertLocationAllowed(input.locationId);
    }
    const target =
      input.locationId ?? (await this.repo.resolveWriteLocationId());

    // DX-211: el sillón es de esta clínica, de la sede de la cita y activo
    // (404/400). Sin profesional elegido, se toma el suyo por defecto.
    const chair =
      input.chairId !== undefined
        ? await this.requireChairs().load(input.chairId, {
            locationId: target,
            requireActive: true,
          })
        : null;
    const providerId = resolveAppointmentProviderId(input.providerId, chair);
    if (providerId === null) {
      throw new BadRequestException(
        chair ? CHAIR_WITHOUT_PROVIDER_MESSAGE : PROVIDER_REQUIRED_MESSAGE,
      );
    }
    const provider = await this.staff.findById(providerId);
    if (!provider) {
      throw new NotFoundException('Profesional no encontrado');
    }
    assertAttendsAt(provider, target);
    // DX-161: recepción y asistencia no atienden: no se les agenda.
    assertAttendingRole(provider);
    return { providerId, target, chair };
  }

  /**
   * El resto de reglas, con el profesional y el sillón ya resueltos. Sin
   * `collect` (agendar una cita) se para en la primera que falla; con él
   * (DX-562, una fecha de una serie) las mira todas y cada fallo HTTP va a
   * `collect` con su regla.
   */
  private async prepareFor(
    input: ResolvedAppointmentInput & { providerId: string },
    target: string,
    chair: Chair | null,
    opts: { checkPatient: boolean; checkHoliday: boolean },
    collect?: SlotRuleCollector,
  ): Promise<PreparedAppointment> {
    const attempt = <T>(
      step: SlotRuleFailure['step'],
      rule: () => Promise<T>,
      fallback: T,
    ): Promise<T> => attemptRule(collect, step, rule, fallback);
    // Horario de atención de la SEDE: la cita tiene que caber completa en un
    // tramo del día. Sede sin horario configurado => sin restricción (ver
    // fitsBusinessHours), así que esto no cambia nada hasta que la clínica lo
    // configure. Se lee la sede EN CONTEXTO, la misma en la que el repo escribirá
    // la cita.
    // 422 (DX-121): la petición es válida, pero ese hueco no existe.
    // DX-122: desde «Pendientes» la sede es la de la entrada, no la del request.
    const hours =
      input.locationId !== undefined
        ? await this.schedule.findByLocation(input.locationId)
        : await this.schedule.findForCurrentLocation();
    await attempt(
      'BUSINESS_HOURS',
      async () => {
        if (!fitsBusinessHours(input.start, input.end, hours)) {
          // DX-354: las horas del mensaje, con el formato y el reloj de la
          // sede; el formato se pide solo si el mensaje lleva horas (día
          // abierto).
          const source = await this.schedule.formatSourceOf(input.locationId);
          throw new UnprocessableEntityException(
            businessHoursErrorMessage(input.start, input.end, hours!, () =>
              requireLocationFormat(source),
            ),
          );
        }
      },
      undefined,
    );

    // DX-263-bis: un festivo de la sede (DX-316), en su zona, es 409 con su
    // nombre. Misma sede que el horario: la de pendientes o la del request.
    if (opts.checkHoliday) {
      await attempt(
        'LOCATION_HOLIDAY',
        () =>
          assertNotOnHoliday(this.schedule, {
            locationId: input.locationId,
            start: input.start,
            end: input.end,
          }),
        undefined,
      );
    }

    // DX-233: horario del profesional en la sede de la cita (`target`, la
    // misma en la que se escribe; DX-089). Sin horario configurado no cambia
    // nada; fuera de él, aviso (o 409 en modo estricto).
    const offSchedule = await attempt(
      'PROVIDER_OFF_SCHEDULE',
      () =>
        this.availability.warnOrReject({
          providerId: input.providerId,
          locationId: target,
          start: input.start,
          end: input.end,
        }),
      null,
    );

    // DX-122: bloqueos de la agenda del profesional o de la sede. Uno que no
    // deja agendar es un 409; uno que sí (almuerzo), un aviso en la respuesta.
    // DX-446: un hueco reservado deja pasar sus tipos, o todos desde la
    // liberación, o a quien puede saltárselo con motivo.
    const blockCheck = await attempt(
      'SCHEDULE_BLOCK',
      () =>
        checkScheduleBlocks(
          this.blocks,
          {
            providerId: input.providerId,
            start: input.start,
            end: input.end,
            locationId: input.locationId,
          },
          {
            appointmentTypeId: input.appointmentTypeId ?? null,
            now: this.clock(),
            actorRole: input.actorRole ?? null,
            overrideReason: input.overrideReason,
          },
        ),
      { warnings: [], override: null },
    );
    const warnings = collectWarnings(blockCheck.warnings, offSchedule);

    // Overlap rule: two half-open intervals [s1,e1) and [s2,e2) overlap iff
    // s1 < e2 AND s2 < e1 — enforced by the repository's findOverlapping
    // query. A CANCELLED appointment never blocks (repo excludes it).
    await attempt(
      'PROVIDER_OVERLAP',
      async () => {
        const overlapping = await this.repo.findOverlapping(
          input.providerId,
          input.start,
          input.end,
        );
        if (overlapping.length > 0) {
          throw new ConflictException(OVERLAP_MESSAGES.provider);
        }
      },
      undefined,
    );

    // Mismo criterio, otro eje: el PACIENTE tampoco puede estar en dos citas a
    // la vez (aunque sean con profesionales distintos — no puede estar en dos
    // sillones). Antes solo se validaba el solape del profesional.
    await attempt(
      'PATIENT_OVERLAP',
      async () => {
        const patientOverlapping = opts.checkPatient
          ? await this.repo.findOverlappingForPatient(
              input.patientId,
              input.start,
              input.end,
            )
          : [];
        if (patientOverlapping.length > 0) {
          throw new ConflictException(OVERLAP_MESSAGES.patient);
        }
      },
      undefined,
    );

    // DX-211: tercer eje, el SILLÓN: dos citas no lo ocupan a la vez (aunque
    // sean de profesionales y pacientes distintos).
    if (chair) {
      await attempt(
        'CHAIR_OVERLAP',
        () =>
          this.requireChairs().assertFree(chair, {
            locationId: target,
            start: input.start,
            end: input.end,
          }),
        undefined,
      );
    }
    return { input, chair, warnings, blockCheck };
  }

  /** Escribe la cita ya validada por `prepare`. */
  private async write({
    input,
    chair,
    warnings,
    blockCheck,
  }: PreparedAppointment): Promise<AppointmentWriteResult> {
    // The pre-checks in `prepare` handle the common case with a friendly 409 WITHOUT
    // hitting the DB. This try/catch is the race-proof backstop: if a
    // concurrent create slips past them, the DB's EXCLUDE constraints
    // (appointments_no_overlap_per_provider / ..._per_patient, SQLSTATE 23P01)
    // reject the INSERT — se mapea al MISMO 409 del pre-check correspondiente.
    try {
      const created = await this.repo.create({
        patientId: input.patientId,
        providerId: input.providerId,
        start: input.start,
        end: input.end,
        reason: input.reason,
        notes: input.notes,
        createdById: input.createdById,
        actorRole: input.actorRole ?? null,
        appointmentTypeId: input.appointmentTypeId,
        locationId: input.locationId,
        waitlistEntryId: input.waitlistEntryId,
        wantsEarlier: input.wantsEarlier,
        planItemIds: input.planItemIds,
        chairId: chair?.id,
        importBatchId: input.importBatchId,
        origin: input.origin,
        inTransaction: input.inTransaction,
        recallContact: input.recallContact,
      });
      // DX-273: un alta con ítems ya reservados en otra cita es 409; nunca avisa.
      return {
        ...created,
        ...warnings,
        planItemsReservedElsewhere: [],
        ...(blockCheck.override
          ? { reservedOverride: blockCheck.override }
          : {}),
      };
    } catch (error) {
      // DX-149: un bloqueo que no deja agendar se creó a la vez (visto dentro
      // de la transacción, con el candado de la agenda).
      if (error instanceof ScheduleBlockedRaceError) {
        throw new ConflictException(SCHEDULE_BLOCKED_RACE_MESSAGE);
      }
      const scope = overlapExclusionScope(error);
      if (scope === 'chair' && chair) {
        throw await this.requireChairs().raceConflict(chair.id, input);
      }
      if (scope === 'provider' || scope === 'patient') {
        throw new ConflictException(OVERLAP_MESSAGES[scope]);
      }
      throw error;
    }
  }

  private requireChairs(): ChairAssignmentService {
    if (!this.chairs) {
      throw new Error('ChairAssignmentService no está configurado');
    }
    return this.chairs;
  }
}
