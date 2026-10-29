import type { DocumentType } from '@prisma/client';
import {
  documentTypeName,
  type ClinicDocumentTypeNames,
} from '../domain/document-type';
import type { ResponsiblePartyView } from '../domain/ports/responsible-party-repository.port';

/**
 * DX-327 (R17, spec §4.6): las salidas de pacientes y responsables llevan el
 * nombre visible ya resuelto (`docTypeName`). Los nombres de la clínica se
 * leen una vez por petición (`DocumentTypeNamesReader.get()`) y se pasan
 * aquí: nunca una lectura por fila.
 */
export type WithDocTypeName<T> = T & { docTypeName: string };

export function withDocTypeName<
  T extends { docType: DocumentType; docTypeLabel: string | null },
>(item: T, names: ClinicDocumentTypeNames): WithDocTypeName<T> {
  return {
    ...item,
    docTypeName: documentTypeName(item.docType, item.docTypeLabel, names),
  };
}

export type ResponsiblePartyOutput = Omit<
  ResponsiblePartyView,
  'responsiblePatient'
> & {
  responsiblePatient: WithDocTypeName<
    NonNullable<ResponsiblePartyView['responsiblePatient']>
  > | null;
  /** Null si el contacto no tiene tipo. */
  docTypeName: string | null;
};

export function responsiblePartyWithDocTypeName(
  party: ResponsiblePartyView,
  names: ClinicDocumentTypeNames,
): ResponsiblePartyOutput {
  return {
    ...party,
    responsiblePatient:
      party.responsiblePatient &&
      withDocTypeName(party.responsiblePatient, names),
    docTypeName:
      party.docType === null
        ? null
        : documentTypeName(party.docType, party.docTypeLabel, names),
  };
}
