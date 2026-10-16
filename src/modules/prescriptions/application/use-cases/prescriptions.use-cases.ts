import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClinicCountry, ClinicRole, DocType } from '@prisma/client';
import type {
  Prescription,
  PrescriptionDocument,
  PrescriptionPatient,
} from '../../domain/entities/prescription.entity';
import {
  PRESCRIPTION_REPOSITORY,
  type PrescriptionRepository,
} from '../../domain/ports/prescription-repository.port';
import { findAllergyMatches } from '../../domain/allergy-match';
import {
  computePrescriptionHash,
  type PrescriptionItemContent,
} from '../../domain/prescription-hash';
import {
  computeValidUntil,
  MAX_PRESCRIPTION_ITEMS,
  PRESCRIPTION_VALIDITY_DAYS,
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
  /** Registro profesional / nº de colegiado si el perfil aún no lo tiene. */
  professionalLicense?: string;
  /** Confirmación explícita del profesional ante una alerta de alergia. */
  allergyOverride?: boolean;
}

export interface PrescriptionIssuerView {
  country: ClinicCountry;
  locationId: string;
  locationName: string;
  locationAddress: string | null;
  clinicName: string;
  professionalName: string;
  professionalLicense: string | null;
  validityDays: number;
  maxItems: number;
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

function patientDocument(
  country: ClinicCountry,
  patient: PrescriptionPatient,
): string | null {
  if (!patient.docNumber) return null;
  // En ES el documento es el DNI/NIE tal cual; los tipos (CC, TI…) son de CO.
  return country === ClinicCountry.ES
    ? patient.docNumber
    : `${DOC_TYPE_LABEL[patient.docType]} ${patient.docNumber}`;
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

function hashOf(rx: Prescription): string {
  return computePrescriptionHash({
    ...rx,
    items: rx.items.map(({ id: _id, ...item }) => item),
  });
}

@Injectable()
export class GetPrescriptionIssuerUseCase {
  constructor(
    @Inject(PRESCRIPTION_REPOSITORY)
    private readonly repo: PrescriptionRepository,
  ) {}

  /** Lo que el modal necesita saber antes de emitir: país, sede y registro. */
  async execute(professionalUserId: string): Promise<PrescriptionIssuerView> {
    const issuer = await this.repo.loadIssuer(professionalUserId);
    const country = issuer.location.country;
    return {
      country,
      locationId: issuer.location.id,
      locationName: issuer.location.name,
      locationAddress: issuer.location.address,
      clinicName: issuer.clinicName,
      professionalName: issuer.professional.name,
      professionalLicense: issuer.professional.license,
      validityDays: PRESCRIPTION_VALIDITY_DAYS[country],
      maxItems: country === ClinicCountry.ES ? 1 : MAX_PRESCRIPTION_ITEMS,
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
   * Emitir = foto congelada. Valida los campos legales del país de la sede,
   * comprueba las alergias de la anamnesis vigente (409 sin confirmación
   * explícita), escribe la cantidad en letras y sella todo con un SHA-256.
   * Profesional, sede y hora salen del servidor, nunca del cuerpo.
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
    const country = issuer.location.country;
    const providedLicense = trimmedOrNull(input.professionalLicense);
    const license = providedLicense ?? issuer.professional.license;

    const errors = validatePrescription(country, {
      items: input.items,
      patient: { docNumber: patient.docNumber, birthDate: patient.birthDate },
      professionalLicense: license,
    });
    if (errors.length > 0) {
      throw new BadRequestException(
        `No se puede emitir la receta: ${errors.join('; ')}.`,
      );
    }

    const issuedAt = this.now();
    const dispensationDate = resolveDispensationDate(
      input.dispensationDate,
      todayIn(issuer.location.timeZone, issuedAt),
    );
    const items = input.items.map((item, i) => toItemContent(item, i + 1));

    const allergyMatches = findAllergyMatches(
      items.map((i) => i.activeIngredient),
      patient.allergies,
    );
    if (allergyMatches.length > 0 && input.allergyOverride !== true) {
      const detail = allergyMatches
        .map((m) => `${m.allergen} (${m.activeIngredient})`)
        .join(', ');
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `Alerta de alergia: el paciente tiene registrada alergia a ${detail}. Confirma que prescribes igualmente.`,
        allergyMatches,
      });
    }

    const content = {
      country,
      issuedAt,
      dispensationDate,
      validUntil: computeValidUntil(country, dispensationDate),
      patientId: patient.id,
      patientName: `${patient.firstName} ${patient.lastName}`,
      patientDocument: patientDocument(country, patient),
      patientBirthYear: patient.birthDate
        ? patient.birthDate.getUTCFullYear()
        : null,
      clinicalRecordNumber: patient.docNumber,
      professionalId: professionalUserId,
      professionalName: issuer.professional.name,
      professionalLicense: license as string,
      professionalEmail: issuer.professional.email,
      clinicName: issuer.clinicName,
      locationName: issuer.location.name,
      locationAddress: issuer.location.address,
      notes: trimmedOrNull(input.notes),
      allergyOverride: allergyMatches.length > 0,
      allergyMatches,
      items,
    };
    const created = await this.repo.create({
      ...content,
      locationId: issuer.location.id,
      contentHash: computePrescriptionHash(content),
    });

    if (providedLicense && providedLicense !== issuer.professional.license) {
      await this.repo.saveProfessionalLicense(
        professionalUserId,
        providedLicense,
      );
    }
    return created;
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
    return { ...rx, integrityOk: hashOf(rx) === rx.contentHash };
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
