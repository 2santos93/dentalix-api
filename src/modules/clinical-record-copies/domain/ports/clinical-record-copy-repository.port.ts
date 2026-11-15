import type { DocumentType } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { InstantRange } from '../../../../shared/time/civil-day';
import type { MedicalHistory } from '../../../medical-history/domain/entities/medical-history.entity';
import type {
  ClinicalRecordCopySection,
  ClinicalRecordCopySummary,
} from '../clinical-record-copy';
import type { CopyAppointmentSource, CopyLookups } from '../copy-content';

export const CLINICAL_RECORD_COPY_REPOSITORY = Symbol(
  'CLINICAL_RECORD_COPY_REPOSITORY',
);

/** Lo que la cabecera de la copia necesita (paciente, clínica y sede). */
export interface CopyContext {
  patient: {
    firstName: string;
    lastName: string;
    patientCode: number;
    docType: DocumentType;
    docTypeLabel: string | null;
    docNumber: string | null;
    birthDate: Date | null;
  };
  clinic: {
    name: string;
    legalName: string | null;
    taxIdLabel: string | null;
    taxId: string | null;
  };
  location: {
    id: string;
    name: string;
    address: string | null;
    timeZone: string | null;
    locale: string | null;
    hourCycle: string | null;
  };
}

export interface NewClinicalRecordCopy {
  patientId: string;
  locationId: string;
  from: string;
  to: string;
  sections: ClinicalRecordCopySection[];
  deliveredTo: string | null;
}

export interface CopyLookupIds {
  userIds: Iterable<string | null>;
  locationIds: Iterable<string | null>;
  entryIds: Iterable<string>;
  catalogItemIds: Iterable<string | null>;
}

export interface ClinicalRecordCopyRepository {
  /**
   * Sede en la que se genera: la de la cabecera; sin ella, la del miembro o la
   * principal (`TenantContextService.writeLocationId`). 403 para un miembro
   * restringido sin sede activa.
   */
  generationLocationId(): Promise<string>;

  /** Paciente vivo de la clínica, clínica y sede; null si no hay paciente. */
  loadContext(
    patientId: string,
    locationId: string,
  ): Promise<CopyContext | null>;

  /**
   * INSERTA la generación y su evento EXPORT en la MISMA transacción: o las
   * dos o ninguna. El evento no lleva el texto de «entregado a».
   */
  create(
    record: NewClinicalRecordCopy,
    audit: AuditRequestContext,
  ): Promise<ClinicalRecordCopySummary>;

  /**
   * Generaciones del paciente, la más reciente primero. Para un miembro
   * restringido (DX-089), solo las de sus sedes permitidas.
   */
  list(patientId: string): Promise<ClinicalRecordCopySummary[]>;

  /** Una generación del paciente, o null (de otro paciente o clínica). */
  find(
    patientId: string,
    id: string,
  ): Promise<ClinicalRecordCopySummary | null>;

  /** Nombres de autores, sedes y procedimientos, en pocas consultas. */
  lookups(ids: CopyLookupIds): Promise<CopyLookups>;

  /**
   * Versiones de la anamnesis registradas en el rango, con el MISMO mapeo que
   * la ficha (`mapMedicalHistoryVersion`).
   */
  anamnesisVersions(
    patientId: string,
    range: InstantRange,
  ): Promise<MedicalHistory[]>;

  /**
   * Citas vivas del paciente que empiezan en el rango. Para un miembro
   * restringido, solo las de sus sedes (DX-089), como la agenda.
   */
  appointments(
    patientId: string,
    range: InstantRange,
  ): Promise<CopyAppointmentSource[]>;
}
