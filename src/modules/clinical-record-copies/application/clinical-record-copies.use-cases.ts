import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { requireLocationTimeZone } from '../../../shared/locations/location-time-zone';
import { civilDateIn, civilRangeInZone } from '../../../shared/time/civil-day';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../patients/application/assert-patient-in-clinic';
import {
  documentText,
  documentTypeName,
} from '../../patients/domain/document-type';
import { DocumentTypeNamesReader } from '../../patients/domain/ports/document-type-names-repository.port';
import { ListClinicalEntriesUseCase } from '../../clinical-entries/application/use-cases/list-clinical-entries.use-case';
import {
  TOOTH_RECORD_REPOSITORY,
  type ToothRecordRepository,
} from '../../odontogram/domain/ports/tooth-record-repository.port';
import { AnesthesiaUseCases } from '../../anesthesia/application/use-cases/anesthesia.use-cases';
import { SedationUseCases } from '../../sedation/application/use-cases/sedation.use-cases';
import { ListPatientConsentsUseCase } from '../../consents/application/use-cases/patient-consents.use-cases';
import { ListPatientPrescriptionsUseCase } from '../../prescriptions/application/use-cases/prescriptions.use-cases';
import {
  CLINICAL_RECORD_COPY_MESSAGES,
  checkCopyRequest,
  type ClinicalRecordCopySection,
  type ClinicalRecordCopySummary,
  type CopyRequestInput,
} from '../domain/clinical-record-copy';
import {
  assembleCopyContent,
  isCopyEmpty,
  type CopyContent,
  type CopySources,
} from '../domain/copy-content';
import {
  CLINICAL_RECORD_COPY_REPOSITORY,
  type ClinicalRecordCopyRepository,
  type CopyContext,
} from '../domain/ports/clinical-record-copy-repository.port';

export const CLINICAL_RECORD_COPY_CLOCK = Symbol('CLINICAL_RECORD_COPY_CLOCK');
export type ClinicalRecordCopyClock = () => Date;

/** El documento entero que pinta la vista imprimible. Sin ids internos. */
export interface ClinicalRecordCopyDocument {
  copy: ClinicalRecordCopySummary;
  clinic: {
    name: string;
    legalName: string | null;
    taxIdLabel: string | null;
    taxId: string | null;
  };
  location: {
    name: string;
    address: string | null;
    timeZone: string;
    locale: string | null;
    hourCycle: string | null;
  };
  patient: {
    name: string;
    patientCode: number;
    document: string | null;
    /** Día civil (YYYY-MM-DD) o null. */
    birthDate: string | null;
  };
  content: CopyContent;
  /** Ninguna sección elegida trae registros en el período. */
  empty: boolean;
}

/**
 * DX-456: «Copia de la historia clínica» de un paciente.
 *
 * - `generate`: valida, deja la generación y su evento EXPORT (misma
 *   transacción) y devuelve el resumen. No devuelve contenido clínico.
 * - `document`: arma el documento de una generación con las MISMAS lecturas
 *   que la ficha (evoluciones con sus adendas, anestesia, sedación,
 *   consentimientos, recetas; la carta del odontograma con su proyección) y
 *   lo recorta al período y a lo registrado hasta la generación.
 */
@Injectable()
export class ClinicalRecordCopiesUseCases {
  constructor(
    @Inject(CLINICAL_RECORD_COPY_REPOSITORY)
    private readonly repo: ClinicalRecordCopyRepository,
    @Inject(CLINICAL_RECORD_COPY_CLOCK)
    private readonly now: ClinicalRecordCopyClock,
    private readonly tenantContext: TenantContextService,
    private readonly documentTypeNames: DocumentTypeNamesReader,
    private readonly entries: ListClinicalEntriesUseCase,
    @Inject(TOOTH_RECORD_REPOSITORY)
    private readonly toothRecords: ToothRecordRepository,
    private readonly anesthesia: AnesthesiaUseCases,
    private readonly sedation: SedationUseCases,
    private readonly consents: ListPatientConsentsUseCase,
    private readonly prescriptions: ListPatientPrescriptionsUseCase,
  ) {}

  async generate(
    patientId: string,
    input: CopyRequestInput,
    audit: AuditRequestContext,
  ): Promise<ClinicalRecordCopySummary> {
    const locationId = await this.repo.generationLocationId();
    const ctx = await this.context(patientId, locationId);
    const timeZone = requireLocationTimeZone(ctx.location);
    const check = checkCopyRequest(input, civilDateIn(this.now(), timeZone));
    if (!check.ok) throw new BadRequestException(check.message);
    return this.repo.create(
      { patientId, locationId, ...check.value },
      { ...audit, locationId },
    );
  }

  async list(patientId: string): Promise<ClinicalRecordCopySummary[]> {
    await this.context(patientId, null);
    return this.repo.list(patientId);
  }

  async document(
    patientId: string,
    copyId: string,
  ): Promise<ClinicalRecordCopyDocument> {
    const copy = await this.repo.find(patientId, copyId);
    if (!copy) {
      // Paciente inexistente o de otra clínica: el mismo 404 que la ficha.
      await this.context(patientId, null);
      throw new NotFoundException(CLINICAL_RECORD_COPY_MESSAGES.copyNotFound);
    }
    // DX-089: la copia es de una sede; fuera de las del miembro, 403.
    this.tenantContext.assertLocationAllowed(copy.location.id);
    const ctx = await this.context(patientId, copy.location.id);
    const timeZone = requireLocationTimeZone(ctx.location);
    const range = civilRangeInZone(copy.from, copy.to, timeZone);
    const window = { ...range, asOf: copy.generatedAt };
    const sources = await this.sources(patientId, copy.sections, range);
    const names = await this.repo.lookups({
      userIds: [
        ...(sources.evolutions ?? []).flatMap((e) => [
          e.performedById,
          ...e.addenda.map((a) => a.authorId),
        ]),
        ...(sources.anamnesis ?? []).map((v) => v.createdById),
        ...(sources.toothRecords ?? []).map((r) => r.performedById),
        ...(sources.anesthesia ?? []).map((a) => a.authorId),
        ...(sources.appointments ?? []).map((a) => a.providerId),
      ],
      locationIds: [
        ...(sources.anesthesia ?? []).map((a) => a.locationId),
        ...(sources.sedation ?? []).map((s) => s.locationId),
        ...(sources.appointments ?? []).map((a) => a.locationId),
      ],
      entryIds: (sources.evolutions ?? []).map((e) => e.id),
      catalogItemIds: (sources.toothRecords ?? []).map((r) => r.catalogItemId),
    });
    const content = assembleCopyContent(copy.sections, sources, window, names);
    const docNames = await this.documentTypeNames.get(copy.location.id);
    const { patient, clinic, location } = ctx;
    return {
      copy,
      clinic: {
        name: clinic.name,
        legalName: clinic.legalName?.trim() || null,
        taxIdLabel: clinic.taxIdLabel?.trim() || null,
        taxId: clinic.taxId?.trim() || null,
      },
      location: {
        name: location.name,
        address: location.address?.trim() || null,
        timeZone,
        locale: location.locale,
        hourCycle: location.hourCycle,
      },
      patient: {
        name: `${patient.firstName} ${patient.lastName}`.trim(),
        patientCode: patient.patientCode,
        document: documentText(
          documentTypeName(patient.docType, patient.docTypeLabel, docNames),
          patient.docNumber,
        ),
        birthDate: patient.birthDate
          ? patient.birthDate.toISOString().slice(0, 10)
          : null,
      },
      content,
      empty: isCopyEmpty(content),
    };
  }

  /** Paciente vivo de esta clínica (404 si no) y, con sede, su contexto. */
  private async context(
    patientId: string,
    locationId: string | null,
  ): Promise<CopyContext> {
    const ctx = await this.repo.loadContext(
      patientId,
      locationId ?? (await this.repo.generationLocationId()),
    );
    if (!ctx) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    return ctx;
  }

  /** Solo se lee lo que piden las secciones elegidas. */
  private async sources(
    patientId: string,
    sections: readonly ClinicalRecordCopySection[],
    range: { start: Date; end: Date },
  ): Promise<CopySources> {
    const wants = (s: ClinicalRecordCopySection) => sections.includes(s);
    const [
      evolutions,
      anamnesis,
      toothRecords,
      anesthesia,
      sedation,
      consents,
      prescriptions,
      appointments,
    ] = await Promise.all([
      wants('EVOLUTIONS') || wants('DIAGNOSES')
        ? // La MISMA lectura que la ficha (anuladas fuera, adendas en orden).
          // `to` es inclusivo en ese contrato: el último milisegundo del día.
          this.entries.execute(patientId, {
            from: range.start,
            to: new Date(range.end.getTime() - 1),
          })
        : undefined,
      wants('ANAMNESIS')
        ? this.repo.anamnesisVersions(patientId, range)
        : undefined,
      wants('ODONTOGRAM')
        ? this.toothRecords.listByPatient(patientId)
        : undefined,
      wants('ANESTHESIA_SEDATION')
        ? this.anesthesia.listByPatient(patientId)
        : undefined,
      wants('ANESTHESIA_SEDATION')
        ? this.sedation.listByPatient(patientId)
        : undefined,
      wants('CONSENTS') ? this.consents.execute(patientId) : undefined,
      wants('PRESCRIPTIONS')
        ? this.prescriptions.execute(patientId)
        : undefined,
      wants('APPOINTMENTS')
        ? this.repo.appointments(patientId, range)
        : undefined,
    ]);
    return {
      evolutions,
      anamnesis,
      toothRecords,
      anesthesia,
      sedation,
      consents,
      prescriptions,
      appointments,
    };
  }
}
