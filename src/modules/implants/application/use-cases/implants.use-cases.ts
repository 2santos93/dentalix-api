import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patients/application/assert-patient-in-clinic';
import { civilDateIn } from '../../../../shared/time/civil-day';
import type {
  ImplantCatalogEntry,
  ImplantLotMatch,
  PatientImplant,
} from '../../domain/entities/patient-implant.entity';
import {
  composeImplantCard,
  type ImplantCard,
} from '../../domain/implant-card';
import {
  isCalendarDay,
  normalizeImplantInput,
  validateImplantInput,
  validatePlacedOn,
  validateVoidReason,
  type ImplantInput,
} from '../../domain/implant-rules';
import {
  PATIENT_IMPLANT_REPOSITORY,
  type ImplantLotQuery,
  type PatientImplantRepository,
} from '../../domain/ports/patient-implant-repository.port';

export type ImplantClock = () => Date;
export const IMPLANT_CLOCK = Symbol('IMPLANT_CLOCK');

export const IMPLANT_NOT_FOUND_MESSAGE = 'Implante no encontrado';
export const PLAN_ITEM_NOT_OF_PATIENT_MESSAGE =
  'El ítem del plan no es de un plan de este paciente';

export interface RegisterImplantInput extends ImplantInput {
  /** `YYYY-MM-DD`; por defecto, hoy en la zona de la sede. */
  placedOn?: string;
  treatmentPlanItemId?: string;
}

@Injectable()
export class RegisterImplantUseCase {
  constructor(
    @Inject(PATIENT_IMPLANT_REPOSITORY)
    private readonly repo: PatientImplantRepository,
    @Inject(IMPLANT_CLOCK) private readonly now: ImplantClock,
  ) {}

  /**
   * Registra un componente colocado. Profesional (token), sede (request o
   * principal) y hora de grabación (BD) nunca salen del cuerpo. Inalterable
   * desde aquí: corregir es anular y registrar otro.
   */
  async execute(
    patientId: string,
    input: RegisterImplantInput,
    professionalId: string,
  ): Promise<PatientImplant> {
    const errors = validateImplantInput(input);
    if (errors.length > 0) {
      throw new BadRequestException(
        `No se puede registrar el implante: ${errors.join('; ')}.`,
      );
    }
    if (!(await this.repo.loadPatient(patientId))) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    const location = await this.repo.resolveLocation();
    const placedOn = validatePlacedOn(
      input.placedOn,
      civilDateIn(this.now(), location.timeZone),
    );
    const planItemId = input.treatmentPlanItemId ?? null;
    if (
      planItemId !== null &&
      !(await this.repo.planItemBelongsToPatient(planItemId, patientId))
    ) {
      throw new BadRequestException(PLAN_ITEM_NOT_OF_PATIENT_MESSAGE);
    }
    return this.repo.create({
      ...normalizeImplantInput(input),
      patientId,
      locationId: location.id,
      professionalId,
      placedOn,
      treatmentPlanItemId: planItemId,
    });
  }
}

@Injectable()
export class ListPatientImplantsUseCase {
  constructor(
    @Inject(PATIENT_IMPLANT_REPOSITORY)
    private readonly repo: PatientImplantRepository,
  ) {}

  /** Más reciente primero; incluye anulados. 404 si el paciente no es de aquí. */
  async execute(patientId: string): Promise<PatientImplant[]> {
    if (!(await this.repo.loadPatient(patientId))) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    return this.repo.listByPatient(patientId);
  }
}

@Injectable()
export class VoidImplantUseCase {
  constructor(
    @Inject(PATIENT_IMPLANT_REPOSITORY)
    private readonly repo: PatientImplantRepository,
    @Inject(IMPLANT_CLOCK) private readonly now: ImplantClock,
  ) {}

  /** Lo anula quien lo registró o un ADMIN, con motivo; una sola vez. */
  async execute(
    id: string,
    reason: string | undefined,
    actor: { userId: string; role: ClinicRole },
  ): Promise<PatientImplant> {
    const trimmed = validateVoidReason(reason);
    const current = await this.repo.findById(id);
    if (!current) throw new NotFoundException(IMPLANT_NOT_FOUND_MESSAGE);
    if (
      actor.role !== ClinicRole.ADMIN &&
      current.professionalId !== actor.userId
    ) {
      throw new ForbiddenException(
        'Solo quien registró el implante o un administrador puede anularlo',
      );
    }
    if (current.voidedAt) {
      throw new ConflictException('El implante ya está anulado');
    }
    const outcome = await this.repo.void(id, {
      voidedById: actor.userId,
      voidedAt: this.now(),
      reason: trimmed,
    });
    if (outcome.kind === 'NOT_FOUND') {
      throw new NotFoundException(IMPLANT_NOT_FOUND_MESSAGE);
    }
    if (outcome.kind === 'ALREADY_VOIDED') {
      throw new ConflictException('El implante ya está anulado');
    }
    return outcome.implant;
  }
}

function requireDay(date: string | undefined): string {
  if (!date || !isCalendarDay(date)) {
    throw new BadRequestException(
      'Indica el día de la intervención (AAAA-MM-DD)',
    );
  }
  return date;
}

@Injectable()
export class GetImplantCardUseCase {
  constructor(
    @Inject(PATIENT_IMPLANT_REPOSITORY)
    private readonly repo: PatientImplantRepository,
    @Inject(IMPLANT_CLOCK) private readonly now: ImplantClock,
  ) {}

  /** La tarjeta de la intervención de ese día (404 si no hay implantes). */
  async execute(
    patientId: string,
    date: string | undefined,
  ): Promise<ImplantCard> {
    const placedOn = requireDay(date);
    const patient = await this.repo.loadPatient(patientId);
    if (!patient) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    const implants = await this.repo.listByPatientOn(patientId, placedOn);
    if (implants.length === 0) {
      throw new NotFoundException(
        'No hay implantes registrados para este paciente en esa fecha',
      );
    }
    const [clinicName, locations] = await Promise.all([
      this.repo.clinicName(),
      this.repo.locations([...new Set(implants.map((i) => i.locationId))]),
    ]);
    return composeImplantCard({
      clinicName,
      patient,
      placedOn,
      implants,
      locations,
    });
  }

  /**
   * Imprimir/entregar: registra la fecha de entrega en los implantes vivos
   * del día que aún no la tienen (la primera entrega queda; una reimpresión no
   * la mueve) y devuelve la tarjeta.
   */
  async deliver(
    patientId: string,
    date: string | undefined,
    actorId: string,
  ): Promise<ImplantCard> {
    const placedOn = requireDay(date);
    await this.execute(patientId, placedOn);
    await this.repo.markCardDelivered(patientId, placedOn, {
      deliveredById: actorId,
      deliveredAt: this.now(),
    });
    return this.execute(patientId, placedOn);
  }
}

@Injectable()
export class ImplantCatalogUseCase {
  constructor(
    @Inject(PATIENT_IMPLANT_REPOSITORY)
    private readonly repo: PatientImplantRepository,
  ) {}

  execute(): Promise<ImplantCatalogEntry[]> {
    return this.repo.catalog();
  }
}

/** Lote/REF de búsqueda: recortado, 1–80 caracteres. */
function searchTerm(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
}

@Injectable()
export class SearchImplantsByLotUseCase {
  constructor(
    @Inject(PATIENT_IMPLANT_REPOSITORY)
    private readonly repo: PatientImplantRepository,
  ) {}

  /**
   * «¿Quién recibió este lote / esta referencia?»: coincidencia exacta sin
   * distinguir mayúsculas. Con los dos, ambos deben coincidir. SIEMPRE en
   * toda la clínica: una retirada de lote no se acota a la sede activa (un
   * paciente operado en otra sede quedaría sin avisar).
   */
  async execute(query: ImplantLotQuery): Promise<ImplantLotMatch[]> {
    const lot = searchTerm(query.lot);
    const reference = searchTerm(query.reference);
    if (!lot && !reference) {
      throw new BadRequestException(
        'Indica el lote o la referencia (REF) a buscar',
      );
    }
    return this.repo.searchByLot({ lot, reference });
  }
}
