import {
  BadRequestException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CatalogKind,
  DentitionType,
  ToothRecordOrigin,
  ToothRecordStatus,
  ToothSurface,
} from '@prisma/client';
import { TOOTH_RECORD_REPOSITORY } from '../../domain/ports/tooth-record-repository.port';
import type { ToothRecordRepository } from '../../domain/ports/tooth-record-repository.port';
import { ToothRecord } from '../../domain/entities/tooth-record.entity';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import { DENTITION_EVENT_REPOSITORY } from '../../domain/ports/dentition-event-repository.port';
import type { DentitionEventRepository } from '../../domain/ports/dentition-event-repository.port';
import {
  hasPrimaryPredecessor,
  isPrimaryTooth,
  positionOfTooth,
  resolveDentition,
  toothAllowedIn,
} from '../../domain/dentition';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { ODONTOGRAM_CLOCK, type OdontogramClock } from '../odontogram-clock';
import { patientBirthDate } from './dentition.use-cases';

// FDI/ISO-3950 tooth codes: permanent dentition is quadrants 1-4 with tooth
// position 1-8 (11-18, 21-28, 31-38, 41-48); primary (deciduous) dentition is
// quadrants 5-8 with tooth position 1-5 (51-55, 61-65, 71-75, 81-85).
export const FDI_TOOTH_NUMBER_PATTERN = /^([1-4][1-8]|[5-8][1-5])$/;

export function isValidFdiToothNumber(
  toothNumber: unknown,
): toothNumber is string {
  return (
    typeof toothNumber === 'string' &&
    FDI_TOOTH_NUMBER_PATTERN.test(toothNumber)
  );
}

const VALID_TOOTH_SURFACES = new Set<string>(Object.values(ToothSurface));

export function isValidToothSurface(surface: unknown): surface is ToothSurface {
  return typeof surface === 'string' && VALID_TOOTH_SURFACES.has(surface);
}

export function areValidToothSurfaces(
  surfaces: unknown,
): surfaces is ToothSurface[] {
  return Array.isArray(surfaces) && surfaces.every(isValidToothSurface);
}

export function isValidCatalogKind(kind: unknown): kind is CatalogKind {
  return kind === CatalogKind.DIAGNOSIS || kind === CatalogKind.PROCEDURE;
}

// NOTE: deliberately NO `tenantId`/`id`/`createdAt`/`performedById` field —
// tenant comes from the guarded request context (never the client, same
// convention as CreateClinicalEntryInput / CreateCatalogItemInput);
// `performedById` is passed as a separate explicit argument sourced from
// `req.user.sub` in the controller, never taken from the request body.
//
// `catalogItemId`/`clinicalEntryId` are optional and are deliberately NOT
// existence/ownership-checked here: a bad or cross-tenant id would only ever
// resolve to nothing under RLS when later joined, so it renders harmlessly.
// Follow-up: add an explicit existence check once the catalog/entry lookups
// are wired through this module (tracked, not scope-creeped into Task 2).
export interface AddToothRecordInput {
  toothNumber: string;
  surfaces?: ToothSurface[];
  kind: CatalogKind;
  catalogItemId?: string;
  status?: ToothRecordStatus;
  notes?: string;
  clinicalEntryId?: string;
  /** DX-120: THIS_CLINIC si se omite. */
  origin?: ToothRecordOrigin;
  recordedAt?: Date;
}

/** Mensaje 422 cuando el diente no corresponde a la dentición de su posición. */
export function dentitionMismatchMessage(
  toothNumber: string,
  dentition: DentitionType,
): string {
  const position = positionOfTooth(toothNumber);
  if (isPrimaryTooth(toothNumber)) {
    return `El diente ${toothNumber} es temporal, pero la posición ${position} está en dentición permanente. Cambia la dentición de esa posición (mixta o temporal) antes de registrar.`;
  }
  if (dentition === DentitionType.PRIMARY && !hasPrimaryPredecessor(position)) {
    return `El diente ${toothNumber} aún no ha erupcionado según la dentición del paciente. Márcalo como erupcionado antes de registrar.`;
  }
  return `El diente ${toothNumber} es permanente, pero la posición ${position} está en dentición temporal. Cambia la dentición de esa posición (mixta o permanente) antes de registrar.`;
}

@Injectable()
export class AddToothRecordUseCase {
  constructor(
    @Inject(TOOTH_RECORD_REPOSITORY)
    private readonly repo: ToothRecordRepository,
    // Resuelve "¿este paciente es de ESTA clínica?" bajo RLS antes de insertar
    // (SEC-004): la FK a patients se chequea saltando la RLS, así que sin esto
    // se podía escribir contra un paciente de otra clínica.
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
    // DX-120: la dentición actual de la posición decide si el diente cabe.
    @Inject(DENTITION_EVENT_REPOSITORY)
    private readonly dentitionEvents: DentitionEventRepository,
    @Inject(ODONTOGRAM_CLOCK)
    private readonly now: OdontogramClock,
  ) {}

  /**
   * Append-only: ALWAYS inserts a brand-new record via `repo.create` — there
   * is no update/delete method on the port at all, so immutability is
   * enforced at the interface level, not just by convention.
   */
  async execute(
    patientId: string,
    input: AddToothRecordInput,
    performedById?: string,
  ): Promise<ToothRecord> {
    if (!isValidFdiToothNumber(input.toothNumber)) {
      throw new BadRequestException(
        'toothNumber must be a valid FDI code (permanent 11-18/21-28/31-38/41-48 or primary 51-55/61-65/71-75/81-85)',
      );
    }

    const surfaces = input.surfaces ?? [];
    if (!areValidToothSurfaces(surfaces)) {
      throw new BadRequestException(
        'surfaces must only contain valid ToothSurface values (MESIAL, DISTAL, OCCLUSAL, VESTIBULAR, LINGUAL)',
      );
    }

    if (!isValidCatalogKind(input.kind)) {
      throw new BadRequestException(
        'kind must be one of: DIAGNOSIS, PROCEDURE',
      );
    }

    // 404 si el paciente no es de esta clínica (SEC-004); de paso, su edad.
    const birthDate = await patientBirthDate(this.patients, patientId);
    await this.assertToothFitsDentition(
      patientId,
      birthDate,
      input.toothNumber,
    );

    // Rebuild the payload from only the known fields — same defensive
    // convention as CreateClinicalEntryUseCase / CreateCatalogItemUseCase:
    // anything sneaked into `input` beyond this shape (e.g. a client-supplied
    // `tenantId`) is dropped here, never forwarded to the repository.
    return this.repo.create({
      patientId,
      toothNumber: input.toothNumber,
      surfaces,
      kind: input.kind,
      catalogItemId: input.catalogItemId,
      status: input.status,
      notes: input.notes,
      clinicalEntryId: input.clinicalEntryId,
      performedById,
      origin: input.origin,
      recordedAt: input.recordedAt,
    });
  }

  /**
   * DX-120: un temporal no cabe en una posición en permanente, ni un
   * permanente en una en temporal (422). La dentición es la de HOY: el último
   * evento de la posición o, sin eventos, la que toca por la edad en el día
   * civil de la clínica (el mismo que muestra GET dentition).
   */
  private async assertToothFitsDentition(
    patientId: string,
    birthDate: Date | null,
    toothNumber: string,
  ): Promise<void> {
    const position = positionOfTooth(toothNumber);
    const state = resolveDentition({
      birthDate,
      onDate: civilDateIn(this.now(), await this.repo.clinicTimeZone()),
      events: (await this.dentitionEvents.listByPatient(patientId)).filter(
        (e) => e.position === position,
      ),
    });
    const { dentition } = state.positions.find((p) => p.position === position)!;
    if (!toothAllowedIn(toothNumber, dentition)) {
      throw new UnprocessableEntityException(
        dentitionMismatchMessage(toothNumber, dentition),
      );
    }
  }
}
