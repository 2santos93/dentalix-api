import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { DocumentType, ResponsibleRelationship } from '@prisma/client';
import { civilDateIn } from '../../../../shared/time/civil-day';
import {
  noticeRecipient,
  type NoticeRecipient,
} from '../../domain/communication/notice-recipient';
import { isMinor } from '../../domain/responsible-parties/majority-age';
import {
  MAX_RESPONSIBLE_PARTIES,
  payerConflict,
  SECOND_PAYER_MESSAGE,
  TOO_MANY_RESPONSIBLES_MESSAGE,
} from '../../domain/responsible-parties/single-payer';
import {
  RESPONSIBLE_PARTY_REPOSITORY,
  ResponsiblePartyConflictError,
  type PatientResponsiblesSnapshot,
  type ResponsibleContactFields,
  type ResponsibleForView,
  type ResponsiblePartyRepository,
  type ResponsiblePartyView,
  type UpdateResponsiblePartyData,
} from '../../domain/ports/responsible-party-repository.port';
import { PATIENT_NOT_FOUND_MESSAGE } from '../assert-patient-in-clinic';
import { docTypeLabelInput } from '../doc-type-label-input';

export const RESPONSIBLES_CLOCK = Symbol('RESPONSIBLES_CLOCK');

export const RESPONSIBLE_PATIENT_NOT_FOUND_MESSAGE =
  'Paciente responsable no encontrado';
export const RESPONSIBLE_PARTY_NOT_FOUND_MESSAGE = 'Responsable no encontrado';
export const SELF_RESPONSIBLE_MESSAGE =
  'Un paciente no puede ser su propio responsable.';
export const DUPLICATE_RESPONSIBLE_MESSAGE =
  'Ese paciente ya es responsable de este paciente.';
export const PICK_ONE_KIND_MESSAGE =
  'Elige un paciente de la clínica o escribe el nombre del contacto responsable, no las dos cosas.';
export const LABEL_NEEDS_TYPE_MESSAGE =
  'El nombre del documento necesita un tipo de documento.';
export const PATIENT_KIND_FIELDS_MESSAGE =
  'El responsable es un paciente: su nombre, documento, email y teléfono se cambian en su ficha.';
/** Mensaje cuando el índice único del pagador salta (alta simultánea). */
const PAYER_TAKEN_MESSAGE =
  'Este paciente ya tiene un pagador principal. Quítale esa marca antes de elegir a otro.';

/** Lo que muestra el bloque «Responsable y familia» de la ficha. */
export interface PatientResponsiblesView {
  patientId: string;
  /** Menor que la mayoría de edad de la clínica, en el día civil de la sede. */
  minor: boolean;
  /** Mayoría de edad de la clínica (DX-328). */
  majorityAge: number;
  parties: ResponsiblePartyView[];
  responsibleFor: ResponsibleForView[];
  /** A quién van hoy sus avisos (regla de destinatario). */
  noticeRecipient: NoticeRecipient;
}

export interface CreateResponsiblePartyInput {
  responsiblePatientId?: string;
  fullName?: string;
  docType?: DocumentType | null;
  docTypeLabel?: string | null;
  docNumber?: string | null;
  email?: string | null;
  phone?: string | null;
  relationship: ResponsibleRelationship;
  isPayer?: boolean;
  receivesNotices?: boolean;
}

export interface UpdateResponsiblePartyInput {
  relationship?: ResponsibleRelationship;
  isPayer?: boolean;
  receivesNotices?: boolean;
  fullName?: string;
  docType?: DocumentType | null;
  docTypeLabel?: string | null;
  docNumber?: string | null;
  email?: string | null;
  phone?: string | null;
}

const CONTACT_KEYS = [
  'fullName',
  'docType',
  'docTypeLabel',
  'docNumber',
  'email',
  'phone',
] as const;

const blank = (value: string | null | undefined): string | null =>
  value?.trim() || null;

/** ¿Trae datos de contacto? En un alta, vacío o null es «no trae». */
function hasContactFields(
  input: CreateResponsiblePartyInput | UpdateResponsiblePartyInput,
  { emptyIsAbsent }: { emptyIsAbsent: boolean },
): boolean {
  return CONTACT_KEYS.some((k) => {
    const value = input[k];
    if (value === undefined) return false;
    return !emptyIsAbsent || (value !== null && String(value).trim() !== '');
  });
}

function toView(
  snapshot: PatientResponsiblesSnapshot,
  now: Date,
): PatientResponsiblesView {
  const { majorityAge, timeZone } = snapshot.noticeSettings;
  const today = civilDateIn(now, timeZone);
  return {
    patientId: snapshot.patient.id,
    minor: isMinor(snapshot.patient.birthDate, majorityAge, today),
    majorityAge,
    parties: snapshot.parties,
    responsibleFor: snapshot.responsibleFor,
    noticeRecipient: noticeRecipient({
      patient: snapshot.patient,
      responsibles: snapshot.noticeResponsibles,
      majorityAge,
      today,
    }),
  };
}

function translateConflict(err: unknown): never {
  if (err instanceof ResponsiblePartyConflictError) {
    if (err.kind === 'PAYER') {
      throw new UnprocessableEntityException(PAYER_TAKEN_MESSAGE);
    }
    throw new ConflictException(DUPLICATE_RESPONSIBLE_MESSAGE);
  }
  throw err;
}

/**
 * DX-327 (R7) en la edición de un contacto: la etiqueta exige un tipo; quitar
 * el tipo la quita; y solo se borra si el tipo CAMBIA y no llega otra. El
 * diálogo de contacto reenvía siempre el tipo: reenviar el mismo la conserva
 * (pre-flight I1).
 */
function contactDocType(
  current: ResponsiblePartyView,
  input: UpdateResponsiblePartyInput,
): Partial<Pick<ResponsibleContactFields, 'docType' | 'docTypeLabel'>> {
  if (input.docType === undefined && input.docTypeLabel === undefined) {
    return {};
  }
  const docType = input.docType === undefined ? current.docType : input.docType;
  const docTypeLabel = docTypeLabelInput(input.docTypeLabel);
  if (docTypeLabel && docType === null) {
    throw new BadRequestException(LABEL_NEEDS_TYPE_MESSAGE);
  }
  const fields: Partial<
    Pick<ResponsibleContactFields, 'docType' | 'docTypeLabel'>
  > = {};
  if (input.docType !== undefined) fields.docType = input.docType;
  if (docType === null) {
    fields.docTypeLabel = null;
  } else if (docTypeLabel !== undefined) {
    fields.docTypeLabel = docTypeLabel;
  } else if (docType !== current.docType) {
    fields.docTypeLabel = null;
  }
  return fields;
}

async function loadOr404(
  repo: ResponsiblePartyRepository,
  patientId: string,
): Promise<PatientResponsiblesSnapshot> {
  const snapshot = await repo.load(patientId);
  if (!snapshot) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
  return snapshot;
}

/** Bloque «Responsable y familia» de la ficha (DX-203). */
@Injectable()
export class ListResponsiblePartiesUseCase {
  constructor(
    @Inject(RESPONSIBLE_PARTY_REPOSITORY)
    private readonly repo: ResponsiblePartyRepository,
    @Inject(RESPONSIBLES_CLOCK) private readonly clock: () => Date,
  ) {}

  async execute(patientId: string): Promise<PatientResponsiblesView> {
    return toView(await loadOr404(this.repo, patientId), this.clock());
  }
}

/**
 * Vincula un responsable (DX-203): otro paciente de ESTA clínica (404 si no
 * lo es: RLS, sin revelar si existe en otra) o un contacto sin ficha con su
 * nombre. Reglas: nadie es su propio responsable; el mismo paciente una sola
 * vez (409); como mucho un pagador principal (422 en español) y
 * MAX_RESPONSIBLE_PARTIES responsables. La BD repite las dos primeras con
 * índices únicos parciales (por si dos altas se cruzan).
 */
@Injectable()
export class CreateResponsiblePartyUseCase {
  constructor(
    @Inject(RESPONSIBLE_PARTY_REPOSITORY)
    private readonly repo: ResponsiblePartyRepository,
  ) {}

  async execute(
    patientId: string,
    input: CreateResponsiblePartyInput,
    createdById: string,
  ): Promise<ResponsiblePartyView> {
    const byPatient = input.responsiblePatientId ?? null;
    let contact: ResponsibleContactFields | null = null;
    if (byPatient) {
      if (hasContactFields(input, { emptyIsAbsent: true })) {
        throw new BadRequestException(PICK_ONE_KIND_MESSAGE);
      }
      if (byPatient === patientId) {
        throw new BadRequestException(SELF_RESPONSIBLE_MESSAGE);
      }
    } else {
      const fullName = blank(input.fullName);
      if (!fullName) throw new BadRequestException(PICK_ONE_KIND_MESSAGE);
      const docType = input.docType ?? null;
      const docTypeLabel = docTypeLabelInput(input.docTypeLabel) ?? null;
      if (docTypeLabel !== null && docType === null) {
        throw new BadRequestException(LABEL_NEEDS_TYPE_MESSAGE);
      }
      contact = {
        fullName,
        docType,
        docTypeLabel,
        docNumber: blank(input.docNumber),
        email: blank(input.email)?.toLowerCase() ?? null,
        phone: blank(input.phone),
      };
    }

    const snapshot = await loadOr404(this.repo, patientId);
    if (byPatient) {
      const responsible = await this.repo.findPatient(byPatient);
      if (!responsible) {
        throw new NotFoundException(RESPONSIBLE_PATIENT_NOT_FOUND_MESSAGE);
      }
      if (
        snapshot.parties.some((p) => p.responsiblePatient?.id === byPatient)
      ) {
        throw new ConflictException(DUPLICATE_RESPONSIBLE_MESSAGE);
      }
    }
    if (snapshot.parties.length >= MAX_RESPONSIBLE_PARTIES) {
      throw new UnprocessableEntityException(TOO_MANY_RESPONSIBLES_MESSAGE);
    }
    const isPayer = input.isPayer ?? false;
    const payer = payerConflict(
      snapshot.parties.map((p) => ({
        id: p.id,
        isPayer: p.isPayer,
        name: p.fullName,
      })),
      { isPayer },
    );
    if (payer) {
      throw new UnprocessableEntityException(SECOND_PAYER_MESSAGE(payer.name));
    }

    return this.repo
      .create(
        patientId,
        {
          responsiblePatientId: byPatient,
          contact,
          relationship: input.relationship,
          isPayer,
          receivesNotices: input.receivesNotices ?? true,
        },
        createdById,
      )
      .catch(translateConflict);
  }
}

/**
 * Edita un responsable: parentesco, pagador principal y avisos; y, si es un
 * contacto, sus datos. Los de un paciente responsable se cambian en su ficha
 * (400). No cambia de forma: para eso se quita y se vuelve a vincular.
 */
@Injectable()
export class UpdateResponsiblePartyUseCase {
  constructor(
    @Inject(RESPONSIBLE_PARTY_REPOSITORY)
    private readonly repo: ResponsiblePartyRepository,
  ) {}

  async execute(
    patientId: string,
    partyId: string,
    input: UpdateResponsiblePartyInput,
  ): Promise<ResponsiblePartyView> {
    const snapshot = await loadOr404(this.repo, patientId);
    const current = snapshot.parties.find((p) => p.id === partyId);
    if (!current) {
      throw new NotFoundException(RESPONSIBLE_PARTY_NOT_FOUND_MESSAGE);
    }
    const touchesContact = hasContactFields(input, { emptyIsAbsent: false });
    if (current.kind === 'PATIENT' && touchesContact) {
      throw new BadRequestException(PATIENT_KIND_FIELDS_MESSAGE);
    }
    if (input.isPayer !== undefined) {
      const payer = payerConflict(
        snapshot.parties.map((p) => ({
          id: p.id,
          isPayer: p.isPayer,
          name: p.fullName,
        })),
        { id: partyId, isPayer: input.isPayer },
      );
      if (payer) {
        throw new UnprocessableEntityException(
          SECOND_PAYER_MESSAGE(payer.name),
        );
      }
    }

    const data: UpdateResponsiblePartyData = {
      relationship: input.relationship,
      isPayer: input.isPayer,
      receivesNotices: input.receivesNotices,
    };
    if (current.kind === 'CONTACT' && touchesContact) {
      const contact: Partial<ResponsibleContactFields> = {};
      if (input.fullName !== undefined) {
        const fullName = blank(input.fullName);
        if (!fullName) {
          throw new BadRequestException(
            'El nombre del contacto responsable es obligatorio.',
          );
        }
        contact.fullName = fullName;
      }
      Object.assign(contact, contactDocType(current, input));
      if (input.docNumber !== undefined) {
        contact.docNumber = blank(input.docNumber);
      }
      if (input.email !== undefined) {
        contact.email = blank(input.email)?.toLowerCase() ?? null;
      }
      if (input.phone !== undefined) contact.phone = blank(input.phone);
      data.contact = contact;
    }

    const saved = await this.repo
      .update(patientId, partyId, data)
      .catch(translateConflict);
    if (!saved)
      throw new NotFoundException(RESPONSIBLE_PARTY_NOT_FOUND_MESSAGE);
    return saved;
  }
}

/** Quita el vínculo (en blando: la auditoría conserva quién y cuándo). */
@Injectable()
export class RemoveResponsiblePartyUseCase {
  constructor(
    @Inject(RESPONSIBLE_PARTY_REPOSITORY)
    private readonly repo: ResponsiblePartyRepository,
  ) {}

  async execute(patientId: string, partyId: string): Promise<void> {
    await loadOr404(this.repo, patientId);
    if (!(await this.repo.remove(patientId, partyId))) {
      throw new NotFoundException(RESPONSIBLE_PARTY_NOT_FOUND_MESSAGE);
    }
  }
}
