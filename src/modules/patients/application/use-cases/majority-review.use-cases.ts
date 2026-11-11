import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ResponsibleRelationship } from '@prisma/client';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
  checkPeriodDays,
  civilDateIn,
} from '../../../../shared/time/civil-day';
import { isMinor } from '../../domain/responsible-parties/majority-age';
import {
  MAJORITY_REVIEW_NOTE_MAX,
  majorityDateOf,
  majorityReviewState,
  type MajorityReviewDecision,
  type MajorityReviewStatus,
} from '../../domain/responsible-parties/majority-review';
import {
  MAJORITY_REVIEW_REPOSITORY,
  type MajorityReviewRepository,
  type MajorityReviewSnapshot,
} from '../../domain/ports/majority-review-repository.port';
import { PATIENT_NOT_FOUND_MESSAGE } from '../assert-patient-in-clinic';
import { RESPONSIBLES_CLOCK } from './responsible-parties.use-cases';

export const MAJORITY_REVIEW_MINOR_MESSAGE =
  'El paciente todavía es menor de edad: el paso a la mayoría de edad se revisa cuando la cumpla.';
export const MAJORITY_REVIEW_NO_BIRTH_DATE_MESSAGE =
  'El paciente no tiene fecha de nacimiento: regístrala en su ficha para revisar el paso a la mayoría de edad.';
export const MAJORITY_REVIEW_NO_RESPONSIBLES_MESSAGE =
  'El paciente no tiene responsables: no hay nada que revisar.';
export const MAJORITY_REVIEW_NOT_APPLICABLE_MESSAGE =
  'Sus responsables se registraron cuando ya era mayor de edad: sus avisos siguen la regla general y no hace falta revisarlos.';
export const MAJORITY_REVIEW_NOTE_MESSAGE = `La nota no puede pasar de ${MAJORITY_REVIEW_NOTE_MAX} caracteres.`;
export const COMING_OF_AGE_MAX_DAYS = 366;
export const COMING_OF_AGE_INVALID_PERIOD_MESSAGE =
  'Las fechas «desde» y «hasta» tienen que ser días válidos (AAAA-MM-DD) y «desde» no puede ser posterior a «hasta».';
export const COMING_OF_AGE_LOCATION_NOT_FOUND_MESSAGE = 'Sede no encontrada';
export const COMING_OF_AGE_PERIOD_TOO_LONG_MESSAGE = `El período no puede pasar de ${COMING_OF_AGE_MAX_DAYS} días.`;

/** Ficha: aviso y modal «Paso a la mayoría de edad» (DX-342). */
export interface MajorityReviewView {
  status: MajorityReviewStatus;
  majorityDate: string | null;
  /** Mayoría de edad de la clínica con la que se cuenta. */
  majorityAge: number;
  decision: MajorityReviewDecision | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  responsibles: {
    id: string;
    name: string;
    relationship: ResponsibleRelationship;
    receivesNotices: boolean;
    isPayer: boolean;
  }[];
}

export interface ComingOfAgeItem {
  patientId: string;
  fullName: string;
  patientCode: string;
  birthDate: string;
  majorityDate: string;
  majorityAge: number;
  status: MajorityReviewStatus;
  /** Ya adulto y PENDING con la mayoría antes de `from`. */
  overdue: boolean;
  responsiblesCount: number;
  /** Sede del paciente (la de su última cita atendida); null sin ninguna. */
  locationId: string | null;
  locationName: string | null;
}

export interface ComingOfAgeList {
  from: string;
  to: string;
  majorityAge: number;
  restrictedToLocations: boolean;
  items: ComingOfAgeItem[];
}

function toView(
  snapshot: MajorityReviewSnapshot,
  now: Date,
): MajorityReviewView {
  const { settings, review } = snapshot;
  const state = majorityReviewState({
    birthDate: snapshot.patient.birthDate,
    majorityAge: settings.majorityAge,
    today: civilDateIn(now, settings.timeZone),
    timeZone: settings.timeZone,
    responsibles: snapshot.responsibles,
    review,
  });
  const reviewed = state.status === 'REVIEWED' && review !== null;
  return {
    status: state.status,
    majorityDate: state.majorityDate,
    majorityAge: settings.majorityAge,
    decision: state.decision,
    reviewedAt: reviewed ? review.reviewedAt.toISOString() : null,
    reviewedByName: reviewed ? review.reviewedByName : null,
    responsibles: snapshot.responsibles.map((r) => ({
      id: r.id,
      name: r.name,
      relationship: r.relationship,
      receivesNotices: r.receivesNotices,
      isPayer: r.isPayer,
    })),
  };
}

/**
 * DX-342: estado del paso a la mayoría de edad de un paciente, para el aviso
 * y el modal de su ficha. La edad cuenta en el día civil de la sede activa o
 * principal y con la mayoría de edad de la clínica.
 */
@Injectable()
export class GetMajorityReviewUseCase {
  constructor(
    @Inject(MAJORITY_REVIEW_REPOSITORY)
    private readonly repo: MajorityReviewRepository,
    @Inject(RESPONSIBLES_CLOCK) private readonly clock: () => Date,
  ) {}

  async execute(patientId: string): Promise<MajorityReviewView> {
    const snapshot = await this.repo.load(patientId);
    if (!snapshot) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    return toView(snapshot, this.clock());
  }
}

export interface ReviewMajorityInput {
  decision: MajorityReviewDecision;
  note?: string | null;
}

/**
 * DX-342: recepción revisa con el paciente, ya adulto, si sus envíos van a
 * él (PATIENT_SELF) o siguen yendo a su responsable (KEEP_RESPONSIBLE, con
 * su consentimiento). Solo para un paciente que cumplió la mayoría de edad
 * con un responsable de cuando era menor; la revisión vale para su fecha de
 * mayoría de edad vigente y rige la última.
 */
@Injectable()
export class ReviewMajorityUseCase {
  constructor(
    @Inject(MAJORITY_REVIEW_REPOSITORY)
    private readonly repo: MajorityReviewRepository,
    @Inject(RESPONSIBLES_CLOCK) private readonly clock: () => Date,
  ) {}

  async execute(
    patientId: string,
    input: ReviewMajorityInput,
    reviewedById: string,
  ): Promise<MajorityReviewView> {
    const note = input.note?.trim() || null;
    if (note && note.length > MAJORITY_REVIEW_NOTE_MAX) {
      throw new BadRequestException(MAJORITY_REVIEW_NOTE_MESSAGE);
    }
    const snapshot = await this.repo.load(patientId);
    if (!snapshot) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    const { settings } = snapshot;
    const now = this.clock();
    const today = civilDateIn(now, settings.timeZone);
    const { birthDate } = snapshot.patient;
    if (!birthDate) {
      throw new UnprocessableEntityException(
        MAJORITY_REVIEW_NO_BIRTH_DATE_MESSAGE,
      );
    }
    if (isMinor(birthDate, settings.majorityAge, today)) {
      throw new ConflictException(MAJORITY_REVIEW_MINOR_MESSAGE);
    }
    if (snapshot.responsibles.length === 0) {
      throw new UnprocessableEntityException(
        MAJORITY_REVIEW_NO_RESPONSIBLES_MESSAGE,
      );
    }
    const state = majorityReviewState({
      birthDate,
      majorityAge: settings.majorityAge,
      today,
      timeZone: settings.timeZone,
      responsibles: snapshot.responsibles,
      review: null,
    });
    if (state.status === 'NOT_APPLICABLE' || !state.majorityDate) {
      throw new UnprocessableEntityException(
        MAJORITY_REVIEW_NOT_APPLICABLE_MESSAGE,
      );
    }
    await this.repo.insert({
      patientId,
      decision: input.decision,
      note,
      majorityDate: state.majorityDate,
      reviewedById,
    });
    const after = await this.repo.load(patientId);
    if (!after) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    return toView(after, now);
  }
}

/** Primer día de `year - years` con el mismo mes y día (29/2 → 28/2). */
function minusYears(day: string, years: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const year = y - years;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const dd = m === 2 && d === 29 && !leap ? 28 : d;
  return `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** Un día antes (para el 29/2, cuya mayoría cae el 1/3 de un año no bisiesto). */
function dayBefore(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * DX-342: «Pasan a la mayoría de edad»: los pacientes con responsable cuya
 * fecha de mayoría de edad (nacimiento + mayoría de edad de la clínica, el
 * 29/2 como `isMinor`) cae en [from, to], más los ya adultos que siguen
 * PENDING con la mayoría antes de `from` (`overdue`). Un miembro restringido
 * a unas sedes (DX-525) solo ve a los pacientes de esas sedes (la de su última
 * cita atendida, como la deuda de DX-145 y el recall); `locationId` filtra
 * por una sede (403 si no le está permitida).
 */
@Injectable()
export class ListComingOfAgeUseCase {
  constructor(
    @Inject(MAJORITY_REVIEW_REPOSITORY)
    private readonly repo: MajorityReviewRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(RESPONSIBLES_CLOCK) private readonly clock: () => Date,
  ) {}

  async execute(query: {
    from: string;
    to: string;
    locationId?: string;
  }): Promise<ComingOfAgeList> {
    const check = checkPeriodDays(query.from, query.to);
    if (!check.ok) {
      throw new BadRequestException(
        check.problem === 'OUT_OF_RANGE'
          ? PERIOD_DAY_OUT_OF_RANGE_MESSAGE
          : COMING_OF_AGE_INVALID_PERIOD_MESSAGE,
      );
    }
    if (check.days > COMING_OF_AGE_MAX_DAYS) {
      throw new BadRequestException(COMING_OF_AGE_PERIOD_TOO_LONG_MESSAGE);
    }
    const { from, to } = check;
    const allowed = this.tenantContext.getAllowedLocationIds();
    const restricted = allowed !== 'ALL';
    if (query.locationId) {
      // 404 antes que 403: una sede de otra clínica no existe aquí.
      if (!(await this.repo.locationExists(query.locationId))) {
        throw new NotFoundException(COMING_OF_AGE_LOCATION_NOT_FOUND_MESSAGE);
      }
      this.tenantContext.assertLocationAllowed(query.locationId);
    }
    const locationIds = query.locationId
      ? [query.locationId]
      : restricted
        ? [...allowed]
        : undefined;

    const settings = await this.repo.settings();
    const { majorityAge, timeZone } = settings;
    const today = civilDateIn(this.clock(), timeZone);
    const candidates = await this.repo.comingOfAge({
      minBirthDate: dayBefore(minusYears(from, majorityAge)),
      maxBirthDate: minusYears(to, majorityAge),
      majorityAge,
      locationIds,
    });

    const items: ComingOfAgeItem[] = [];
    for (const c of candidates) {
      const majorityDate = majorityDateOf(c.birthDate, majorityAge);
      if (!majorityDate || majorityDate > to) continue;
      const state = majorityReviewState({
        birthDate: c.birthDate,
        majorityAge,
        today,
        timeZone,
        responsibles: [{ createdAt: c.firstResponsibleAt }],
        review: c.review,
      });
      const inRange = majorityDate >= from;
      const overdue = !inRange && state.status === 'PENDING';
      if (!inRange && !overdue) continue;
      items.push({
        patientId: c.patientId,
        fullName: `${c.firstName.trim()} ${c.lastName.trim()}`,
        patientCode: String(c.patientCode),
        birthDate: c.birthDate.toISOString().slice(0, 10),
        majorityDate,
        majorityAge,
        status: state.status,
        overdue,
        responsiblesCount: c.responsiblesCount,
        locationId: c.locationId,
        locationName: c.locationName,
      });
    }
    items.sort(
      (a, b) =>
        Number(b.overdue) - Number(a.overdue) ||
        a.majorityDate.localeCompare(b.majorityDate) ||
        a.fullName.localeCompare(b.fullName, 'es') ||
        a.patientId.localeCompare(b.patientId),
    );
    return {
      from,
      to,
      majorityAge,
      restrictedToLocations: restricted,
      items,
    };
  }
}
