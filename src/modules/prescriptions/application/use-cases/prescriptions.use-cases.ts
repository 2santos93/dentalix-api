import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole, DocType } from '@prisma/client';
import type {
  Prescription,
  PrescriptionDocument,
  PrescriptionPatient,
} from '../../domain/entities/prescription.entity';
import {
  PRESCRIPTION_REPOSITORY,
  type CreatePrescriptionRepoInput,
  type PrescriptionRepository,
} from '../../domain/ports/prescription-repository.port';
import {
  ageForSnapshot,
  weightForSnapshot,
} from '../../domain/patient-snapshot';
import {
  ageInYears,
  checkPrescriptionSafety,
  hasBlockingAlerts,
  type SafetyAlert,
  type SafetyCheckResult,
  type SafetyItem,
} from '../../domain/prescription-safety';
import {
  computePrescriptionHash,
  expectedPrescriptionHash,
  type PrescriptionItemContent,
} from '../../domain/prescription-hash';
import {
  computeValidUntil,
  MAX_PRESCRIPTION_ITEMS,
  validatePrescription,
  type PrescriptionItemInput,
} from '../../domain/prescription-rules';
import { quantityInWords } from '../../domain/quantity-in-words';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patients/application/assert-patient-in-clinic';

export type PrescriptionClock = () => Date;
export const PRESCRIPTION_CLOCK = Symbol('PRESCRIPTION_CLOCK');

export const PRESCRIPTION_NOT_FOUND_MESSAGE = 'Receta no encontrada';
/** Hasta cuántos días después de hoy se puede fechar la dispensación. */
export const MAX_DISPENSATION_DAYS_AHEAD = 90;

const DOC_TYPE_LABEL: Record<DocType, string> = {
  CC: 'CC',
  TI: 'TI',
  CE: 'CE',
  PASSPORT: 'Pasaporte',
  OTHER: 'Doc.',
};

export interface IssuePrescriptionInput {
  items: PrescriptionItemInput[];
  /** `YYYY-MM-DD`; por defecto, hoy en la zona de la sede. */
  dispensationDate?: string;
  notes?: string;
  /** Nº de registro profesional si el perfil aún no lo tiene. */
  professionalLicense?: string;
  /**
   * Confirmación explícita ante una alerta de alergia (DX-013). Desde DX-300
   * cuenta como `safetyOverride` (clientes anteriores).
   */
  allergyOverride?: boolean;
  /** DX-300: confirmación explícita de los avisos bloqueantes. */
  safetyOverride?: boolean;
  /** DX-300: motivo de la confirmación (obligatorio si hay bloqueantes). */
  safetyOverrideReason?: string;
}

/** Previsualización de avisos (DX-300) para el modal, antes de emitir. */
export interface PrescriptionSafetyPreview {
  rulesVersion: string;
  /** `MISSING` = el paciente no tiene anamnesis. */
  anamnesis: 'PRESENT' | 'MISSING';
  hasBlocking: boolean;
  alerts: SafetyAlert[];
}

export const SAFETY_OVERRIDE_REASON_MAX = 500;

/** Lo que el modal necesita antes de emitir (spec §4.4). */
export interface PrescriptionIssuerView {
  locationId: string;
  locationName: string;
  locationAddress: string | null;
  clinicName: string;
  professionalName: string;
  professionalLicense: string | null;
  professionalSpecialty: string | null;
  validityDays: number;
  maxItems: number;
  printQuantityInWords: boolean;
  requireClinicalRecordNumber: boolean;
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function todayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** La fecha prevista de dispensación: real, no pasada y no muy lejana. */
function resolveDispensationDate(
  requested: string | undefined,
  today: string,
): string {
  if (requested === undefined) return today;
  const parsed = new Date(`${requested}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(requested) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== requested
  ) {
    throw new BadRequestException(
      'La fecha de dispensación no existe en el calendario',
    );
  }
  if (requested < today) {
    throw new BadRequestException(
      'La fecha de dispensación no puede ser anterior a hoy',
    );
  }
  if (requested > addDays(today, MAX_DISPENSATION_DAYS_AHEAD)) {
    throw new BadRequestException(
      `La fecha de dispensación no puede ser más de ${MAX_DISPENSATION_DAYS_AHEAD} días posterior a hoy`,
    );
  }
  return requested;
}

/** `«{tipo} {número}»` en toda clínica (spec R8), o `null` sin número. */
function patientDocument(patient: PrescriptionPatient): string | null {
  if (!patient.docNumber) return null;
  return `${DOC_TYPE_LABEL[patient.docType]} ${patient.docNumber}`;
}

function toItemContent(
  item: PrescriptionItemInput,
  position: number,
): PrescriptionItemContent {
  // Tras validatePrescription los obligatorios existen; `?? ''`/`?? 0` solo
  // satisfacen al tipo.
  const totalQuantity = item.totalQuantity ?? 0;
  return {
    position,
    activeIngredient: (item.activeIngredient ?? '').trim(),
    brandName: trimmedOrNull(item.brandName),
    concentration: (item.concentration ?? '').trim(),
    pharmaceuticalForm: (item.pharmaceuticalForm ?? '').trim(),
    route: (item.route ?? '').trim(),
    dose: (item.dose ?? '').trim(),
    frequency: (item.frequency ?? '').trim(),
    durationDays: item.durationDays ?? 0,
    totalQuantity,
    quantityUnit: (item.quantityUnit ?? '').trim(),
    quantityInWords: quantityInWords(totalQuantity),
    packages: item.packages ?? null,
    instructions: trimmedOrNull(item.instructions),
  };
}

/** Los avisos con la edad del paciente el día de hoy en la zona de la sede. */
function safetyFor(
  patient: PrescriptionPatient,
  items: readonly SafetyItem[],
  today: string,
): SafetyCheckResult {
  return checkPrescriptionSafety({
    items,
    anamnesis: patient.anamnesis,
    ageYears: patient.birthDate ? ageInYears(patient.birthDate, today) : null,
  });
}

function conflictMessage(blocking: SafetyAlert[], confirmed: boolean): string {
  const detail = blocking.map((a) => a.message).join(' ');
  return confirmed
    ? `Escribe el motivo por el que emites la receta pese a los avisos de seguridad. ${detail}`
    : `Avisos de seguridad sin confirmar: ${detail} Confirma y escribe el motivo para emitir igualmente.`;
}

@Injectable()
export class GetPrescriptionIssuerUseCase {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY)
    private readonly repo: PrescriptionRepository,
  ) {}

  /** Sede, profesional con su perfil y los ajustes de receta de la clínica. */
  async execute(professionalUserId: string): Promise<PrescriptionIssuerView> {
    const issuer = await this.repo.loadIssuer(professionalUserId);
    const { settings } = issuer;
    return {
      locationId: issuer.location.id,
      locationName: issuer.location.name,
      locationAddress: issuer.location.address,
      clinicName: issuer.clinicName,
      professionalName: issuer.professional.name,
      professionalLicense: issuer.professional.license,
      professionalSpecialty: trimmedOrNull(issuer.professional.specialty),
      validityDays: settings.validityDays,
      maxItems: MAX_PRESCRIPTION_ITEMS,
      printQuantityInWords: settings.printQuantityInWords,
      requireClinicalRecordNumber: settings.requireClinicalRecordNumber,
    };
  }
}

@Injectable()
export class IssuePrescriptionUseCase {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY)
    private readonly repo: PrescriptionRepository,
    @Inject(PRESCRIPTION_CLOCK)
    private readonly now: PrescriptionClock,
  ) {}

  /**
   * Emitir = foto congelada de la receta única (spec §4.3). Valida con las
   * reglas únicas y los ajustes de la clínica, recalcula los avisos de
   * seguridad con la anamnesis vigente (DX-300: 409 si hay bloqueantes sin
   * confirmación y motivo), congela edad, peso, especialidad y el ajuste de
   * las letras, y sella todo con el hash v3. Profesional, sede, ajustes y
   * hora salen del servidor, nunca del cuerpo.
   */
  async execute(
    patientId: string,
    input: IssuePrescriptionInput,
    professionalUserId: string,
  ): Promise<Prescription> {
    const patient = await this.repo.loadPatient(patientId);
    if (!patient) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    const issuer = await this.repo.loadIssuer(professionalUserId);
    const { settings } = issuer;
    // El registro del perfil (lo gestiona ADMIN en Personal) manda: el del
    // cuerpo solo cubre el hueco de un perfil que aún no lo tiene, para que un
    // profesional no selle recetas con un registro distinto al de su ficha.
    const providedLicense = issuer.professional.license
      ? null
      : trimmedOrNull(input.professionalLicense);
    const license = issuer.professional.license ?? providedLicense;

    const errors = validatePrescription({
      items: input.items,
      patient: { docNumber: patient.docNumber },
      professionalLicense: license,
      requireClinicalRecordNumber: settings.requireClinicalRecordNumber,
    });
    if (errors.length > 0) {
      throw new BadRequestException(
        `No se puede emitir la receta: ${errors.join('; ')}.`,
      );
    }

    const issuedAt = this.now();
    const today = todayIn(issuer.location.timeZone, issuedAt);
    const dispensationDate = resolveDispensationDate(
      input.dispensationDate,
      today,
    );
    const items = input.items.map((item, i) => toItemContent(item, i + 1));

    // DX-300: avisos recalculados AQUÍ, en el servidor, con la anamnesis
    // vigente: lo que el modal enseñó antes es solo una previsualización.
    const safety = safetyFor(patient, items, today);
    const blocking = safety.alerts.filter((a) => a.severity === 'BLOCKING');
    const confirmed =
      input.safetyOverride === true || input.allergyOverride === true;
    const reason = trimmedOrNull(input.safetyOverrideReason);
    if (reason !== null && reason.length > SAFETY_OVERRIDE_REASON_MAX) {
      throw new BadRequestException(
        `El motivo admite como mucho ${SAFETY_OVERRIDE_REASON_MAX} caracteres`,
      );
    }
    if (blocking.length > 0 && (!confirmed || reason === null)) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: conflictMessage(blocking, confirmed),
        allergyMatches: safety.allergyMatches,
        safetyAlerts: safety.alerts,
      });
    }
    const allergyMatches = safety.allergyMatches;

    // Lo que se sella y lo que se inserta son el mismo objeto. Las letras se
    // guardan siempre en fase 1 (réplicas anteriores); `printQuantityInWords`
    // congela si esta receta las muestra.
    const content: Omit<CreatePrescriptionRepoInput, 'contentHash'> = {
      singleFormat: true,
      printQuantityInWords: settings.printQuantityInWords,
      locationId: issuer.location.id,
      patientId: patient.id,
      professionalId: professionalUserId,
      issuedAt,
      dispensationDate,
      validUntil: computeValidUntil(dispensationDate, settings.validityDays),
      patientName: `${patient.firstName} ${patient.lastName}`,
      patientDocument: patientDocument(patient),
      patientBirthYear: patient.birthDate
        ? patient.birthDate.getUTCFullYear()
        : null,
      patientAgeYears: ageForSnapshot(patient.birthDate, today),
      patientWeightKg: weightForSnapshot(patient.anamnesis?.weightKg ?? null),
      clinicalRecordNumber: settings.requireClinicalRecordNumber
        ? patient.docNumber
        : null,
      professionalName: issuer.professional.name,
      professionalLicense: license as string,
      professionalSpecialty: trimmedOrNull(issuer.professional.specialty),
      professionalEmail: issuer.professional.email,
      clinicName: issuer.clinicName,
      locationName: issuer.location.name,
      locationAddress: issuer.location.address,
      notes: trimmedOrNull(input.notes),
      allergyOverride: allergyMatches.length > 0,
      allergyMatches,
      safetyRulesVersion: safety.rulesVersion,
      safetyAlerts: safety.alerts,
      safetyOverrideReason: hasBlockingAlerts(safety.alerts) ? reason : null,
      items,
    };
    const created = await this.repo.create({
      ...content,
      contentHash: computePrescriptionHash(content),
    });

    if (providedLicense) {
      await this.repo.saveProfessionalLicense(
        professionalUserId,
        providedLicense,
      );
    }
    return created;
  }
}

@Injectable()
export class CheckPrescriptionSafetyUseCase {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY)
    private readonly repo: PrescriptionRepository,
    @Inject(PRESCRIPTION_CLOCK)
    private readonly now: PrescriptionClock,
  ) {}

  /**
   * DX-300: los avisos que daría la emisión con lo que el modal lleva escrito
   * (sin validar campos legales ni guardar nada). 404 si el paciente no es de
   * esta clínica. Solo una vista previa: la emisión los vuelve a calcular.
   */
  async execute(
    patientId: string,
    items: readonly SafetyItem[],
    professionalUserId: string,
  ): Promise<PrescriptionSafetyPreview> {
    const patient = await this.repo.loadPatient(patientId);
    if (!patient) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    // La sede del request da la zona horaria del «hoy» de la edad.
    const issuer = await this.repo.loadIssuer(professionalUserId);
    const safety = safetyFor(
      patient,
      items,
      todayIn(issuer.location.timeZone, this.now()),
    );
    return {
      rulesVersion: safety.rulesVersion,
      anamnesis: patient.anamnesis ? 'PRESENT' : 'MISSING',
      hasBlocking: hasBlockingAlerts(safety.alerts),
      alerts: safety.alerts,
    };
  }
}

@Injectable()
export class ListPatientPrescriptionsUseCase {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY)
    private readonly repo: PrescriptionRepository,
  ) {}

  /** 404 (no lista vacía) si el paciente no es de esta clínica. */
  async execute(patientId: string): Promise<Prescription[]> {
    if (!(await this.repo.loadPatient(patientId))) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    return this.repo.listByPatient(patientId);
  }
}

@Injectable()
export class GetPrescriptionUseCase {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY)
    private readonly repo: PrescriptionRepository,
  ) {}

  /** La receta para verla o imprimirla; `integrityOk` recalcula el hash. */
  async execute(id: string): Promise<PrescriptionDocument> {
    const rx = await this.repo.findById(id);
    if (!rx) {
      throw new NotFoundException(PRESCRIPTION_NOT_FOUND_MESSAGE);
    }
    // Una fila que ni siquiera se puede sellar con su formato no valida: nunca
    // un 500 al leer.
    return {
      ...rx,
      integrityOk: expectedPrescriptionHash(rx) === rx.contentHash,
    };
  }
}

@Injectable()
export class VoidPrescriptionUseCase {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY)
    private readonly repo: PrescriptionRepository,
    @Inject(PRESCRIPTION_CLOCK)
    private readonly now: PrescriptionClock,
  ) {}

  /**
   * Anular es lo ÚNICO que admite una receta emitida: guarda motivo, autor (del
   * token) y fecha (del servidor). La anula quien la emitió o un ADMIN.
   */
  async execute(
    id: string,
    reason: string,
    actor: { userId: string; role: ClinicRole },
  ): Promise<Prescription> {
    const trimmed = reason.trim();
    if (trimmed === '') {
      throw new BadRequestException('El motivo de la anulación es obligatorio');
    }
    const current = await this.repo.findById(id);
    if (!current) {
      throw new NotFoundException(PRESCRIPTION_NOT_FOUND_MESSAGE);
    }
    if (
      actor.role !== ClinicRole.ADMIN &&
      current.professionalId !== actor.userId
    ) {
      throw new ForbiddenException(
        'Solo quien emitió la receta o un administrador puede anularla',
      );
    }
    const outcome = await this.repo.void(id, {
      voidedById: actor.userId,
      voidedAt: this.now(),
      reason: trimmed,
    });
    if (outcome.kind === 'NOT_FOUND') {
      throw new NotFoundException(PRESCRIPTION_NOT_FOUND_MESSAGE);
    }
    if (outcome.kind === 'ALREADY_VOIDED') {
      throw new ConflictException('La receta ya está anulada');
    }
    return outcome.prescription;
  }
}
