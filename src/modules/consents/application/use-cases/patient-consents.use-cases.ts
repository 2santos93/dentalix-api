import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConsentSignerType } from '@prisma/client';
import {
  PatientConsent,
  PatientConsentDocument,
  PatientConsentSummary,
} from '../../domain/entities/patient-consent.entity';
import { ConsentTemplate } from '../../domain/entities/consent-template.entity';
import {
  documentText,
  documentTypeName,
  type ClinicDocumentTypeNames,
} from '../../../patients/domain/document-type';
import { DocumentTypeNamesReader } from '../../../patients/domain/ports/document-type-names-repository.port';
import {
  CONSENT_TEMPLATE_REPOSITORY,
  type ConsentTemplateRepository,
} from '../../domain/ports/consent-template-repository.port';
import {
  PATIENT_CONSENT_REPOSITORY,
  type ConsentSigningContext,
  type PatientConsentRepository,
} from '../../domain/ports/patient-consent-repository.port';
import {
  formatConsentDate,
  renderConsent,
  usesVariable,
} from '../../domain/render-consent';
import { computeConsentHash } from '../../domain/consent-hash';
import { requireLocationFormat } from '../../../../shared/locations/location-regional';
import {
  parseSignaturePng,
  SignatureImageError,
} from '../../domain/signature-image';
import { CONSENT_TEMPLATE_NOT_FOUND_MESSAGE } from './consent-templates.use-cases';
import { PATIENT_REPOSITORY } from '../../../patients/domain/ports/patient-repository.port';
import type { PatientRepository } from '../../../patients/domain/ports/patient-repository.port';
import {
  assertPatientInClinic,
  PATIENT_NOT_FOUND_MESSAGE,
} from '../../../patients/application/assert-patient-in-clinic';

export type ConsentClock = () => Date;
export const CONSENT_CLOCK = Symbol('CONSENT_CLOCK');

export const PLAN_NOT_FOUND_MESSAGE = 'Plan de tratamiento no encontrado';
export const CONSENT_NOT_FOUND_MESSAGE = 'Consentimiento no encontrado';
const NO_TREATMENT = 'No especificado';
const NO_DOCUMENT = 'Sin documento';

export interface PreviewPatientConsentInput {
  templateId: string;
  treatmentPlanId?: string;
}

export interface ConsentPreview {
  templateId: string;
  templateVersion: number;
  title: string;
  body: string;
  professionalName: string;
}

export interface SignPatientConsentInput extends PreviewPatientConsentInput {
  /** La versión que vio el paciente en la vista previa. */
  templateVersion: number;
  signerType: ConsentSignerType;
  guardianName?: string;
  guardianDocument?: string;
  patientSignature: string;
  professionalSignature: string;
}

/** Lo que pone el servidor, nunca el cliente. */
export interface SignPatientConsentMeta {
  recordedById: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * `«{nombre visible} {número}»` (DX-327, R8 y R17), o `null` sin número. Va
 * al cuerpo (`{documento}`) y a `signerDocument`, y queda sellado (R18).
 */
function documentOf(
  patient: ConsentSigningContext['patient'],
  names: ClinicDocumentTypeNames,
): string | null {
  return documentText(
    documentTypeName(patient.docType, patient.docTypeLabel, names),
    patient.docNumber,
  );
}

function treatmentOf(plan: ConsentSigningContext['plan']): string {
  if (!plan || plan.items.length === 0) return NO_TREATMENT;
  return plan.items
    .map((item) => `${item.label} (diente ${item.toothNumber})`)
    .join('; ');
}

/**
 * Plantilla viva + contexto (paciente, plan, clínica, profesional) → texto
 * resuelto. Lo comparten la vista previa y la firma, para que lo que se firma
 * sea exactamente lo que se mostró.
 */
async function prepare(
  templates: ConsentTemplateRepository,
  consents: PatientConsentRepository,
  documentTypeNames: DocumentTypeNamesReader,
  now: Date,
  patientId: string,
  input: PreviewPatientConsentInput,
  professionalUserId: string,
): Promise<{
  template: ConsentTemplate;
  context: ConsentSigningContext;
  title: string;
  body: string;
  /** El documento del paciente tal como va en el cuerpo (R18). */
  document: string | null;
}> {
  const template = await templates.findById(input.templateId);
  if (!template) {
    throw new NotFoundException(CONSENT_TEMPLATE_NOT_FOUND_MESSAGE);
  }
  if (!template.active) {
    throw new BadRequestException(
      'La plantilla está desactivada: no se pueden firmar consentimientos con ella',
    );
  }
  const context = await consents.loadSigningContext({
    patientId,
    treatmentPlanId: input.treatmentPlanId,
    professionalUserId,
  });
  if (!context) {
    throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
  }
  if (context.plan === null) {
    throw new NotFoundException(PLAN_NOT_FOUND_MESSAGE);
  }
  const document = documentOf(context.patient, await documentTypeNames.get());
  const body = renderConsent(template.body, {
    paciente: `${context.patient.firstName} ${context.patient.lastName}`,
    documento: document ?? NO_DOCUMENT,
    profesional: context.professionalName,
    clinica: context.clinicName,
    // El formato de la sede (409 si le falta) solo si la plantilla lo pinta.
    fecha: usesVariable(template.body, 'fecha')
      ? formatConsentDate(
          now,
          context.timeZone,
          requireLocationFormat(context.location),
        )
      : '',
    tratamiento: treatmentOf(context.plan),
  });
  return { template, context, title: template.title, body, document };
}

@Injectable()
export class PreviewPatientConsentUseCase {
  constructor(
    @Inject(CONSENT_TEMPLATE_REPOSITORY)
    private readonly templates: ConsentTemplateRepository,
    @Inject(PATIENT_CONSENT_REPOSITORY)
    private readonly consents: PatientConsentRepository,
    @Inject(CONSENT_CLOCK)
    private readonly now: ConsentClock,
    private readonly documentTypeNames: DocumentTypeNamesReader,
  ) {}

  /** El documento como quedaría firmado ahora, sin guardar nada. */
  async execute(
    patientId: string,
    input: PreviewPatientConsentInput,
    professionalUserId: string,
  ): Promise<ConsentPreview> {
    const { template, context, title, body } = await prepare(
      this.templates,
      this.consents,
      this.documentTypeNames,
      this.now(),
      patientId,
      input,
      professionalUserId,
    );
    return {
      templateId: template.id,
      templateVersion: template.version,
      title,
      body,
      professionalName: context.professionalName,
    };
  }
}

function requiredTrimmed(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function parseSignature(value: string, noun: string): string {
  try {
    return parseSignaturePng(value, noun);
  } catch (error) {
    if (error instanceof SignatureImageError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}

@Injectable()
export class SignPatientConsentUseCase {
  constructor(
    @Inject(CONSENT_TEMPLATE_REPOSITORY)
    private readonly templates: ConsentTemplateRepository,
    @Inject(PATIENT_CONSENT_REPOSITORY)
    private readonly consents: PatientConsentRepository,
    @Inject(CONSENT_CLOCK)
    private readonly now: ConsentClock,
    private readonly documentTypeNames: DocumentTypeNamesReader,
  ) {}

  /**
   * Firma = foto congelada. Se guarda el texto YA renderizado (editar la
   * plantilla después no lo cambia), las firmas, `signedAt` del reloj del
   * servidor y un SHA-256 de todo ello. El autor sale del token
   * (`meta.recordedById`), nunca del cuerpo. Append-only: un solo INSERT.
   */
  async execute(
    patientId: string,
    input: SignPatientConsentInput,
    meta: SignPatientConsentMeta,
  ): Promise<PatientConsent> {
    // Las validaciones baratas, antes de tocar la base.
    let guardian: { name: string; document: string } | null = null;
    if (input.signerType === ConsentSignerType.GUARDIAN) {
      const name = requiredTrimmed(input.guardianName);
      const document = requiredTrimmed(input.guardianDocument);
      if (!name || !document) {
        throw new BadRequestException(
          'Si firma un tutor, su nombre y su documento son obligatorios',
        );
      }
      guardian = { name, document };
    }

    const signedAt = this.now();
    const { template, context, title, body, document } = await prepare(
      this.templates,
      this.consents,
      this.documentTypeNames,
      signedAt,
      patientId,
      input,
      meta.recordedById,
    );
    if (template.version !== input.templateVersion) {
      throw new ConflictException(
        'La plantilla cambió desde la vista previa: revisa el texto de nuevo antes de firmar',
      );
    }
    // Las firmas se descomprimen para buscar tinta: aunque el coste está
    // acotado (SEC-026), solo se paga con el paciente, el plan y la plantilla
    // ya comprobados (lecturas, sin transacción ni bloqueos abiertos).
    const patientSignature = parseSignature(
      input.patientSignature,
      input.signerType === ConsentSignerType.GUARDIAN
        ? 'la firma del tutor'
        : 'la firma del paciente',
    );
    const professionalSignature = parseSignature(
      input.professionalSignature,
      'la firma del profesional',
    );

    const signerName =
      guardian?.name ??
      `${context.patient.firstName} ${context.patient.lastName}`;
    // El mismo texto que el cuerpo: una sola lectura de los nombres.
    const signerDocument = guardian?.document ?? document;
    const contentHash = computeConsentHash({
      title,
      body,
      signerType: input.signerType,
      signerName,
      signerDocument,
      professionalName: context.professionalName,
      patientSignature,
      professionalSignature,
      signedAt,
    });

    return this.consents.create({
      patientId,
      templateId: template.id,
      templateVersion: template.version,
      treatmentPlanId: input.treatmentPlanId ?? null,
      title,
      body,
      signerType: input.signerType,
      signerName,
      signerDocument,
      professionalName: context.professionalName,
      patientSignature,
      professionalSignature,
      contentHash,
      signedAt,
      recordedById: meta.recordedById,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }
}

@Injectable()
export class ListPatientConsentsUseCase {
  constructor(
    @Inject(PATIENT_CONSENT_REPOSITORY)
    private readonly consents: PatientConsentRepository,
    @Inject(PATIENT_REPOSITORY)
    private readonly patients: PatientRepository,
  ) {}

  /** 404 (no lista vacía) si el paciente no es de esta clínica. */
  async execute(patientId: string): Promise<PatientConsentSummary[]> {
    await assertPatientInClinic(this.patients, patientId);
    return this.consents.listByPatient(patientId);
  }
}

@Injectable()
export class GetPatientConsentUseCase {
  constructor(
    @Inject(PATIENT_CONSENT_REPOSITORY)
    private readonly consents: PatientConsentRepository,
    private readonly documentTypeNames: DocumentTypeNamesReader,
  ) {}

  /**
   * El documento firmado para verlo o imprimirlo. `integrityOk` recalcula el
   * hash con lo que hay en la base: si alguien alterase la fila por fuera de
   * la app, la vista lo diría.
   */
  async execute(
    patientId: string,
    id: string,
  ): Promise<PatientConsentDocument> {
    const doc = await this.consents.findDocument(patientId, id);
    if (!doc) {
      throw new NotFoundException(CONSENT_NOT_FOUND_MESSAGE);
    }
    const expected = computeConsentHash({
      title: doc.title,
      body: doc.body,
      signerType: doc.signerType,
      signerName: doc.signerName,
      signerDocument: doc.signerDocument,
      professionalName: doc.professionalName,
      patientSignature: doc.patientSignature,
      professionalSignature: doc.professionalSignature,
      signedAt: doc.signedAt,
    });
    // La cabecera es en vivo (R18): el nombre visible de hoy; lo firmado
    // (cuerpo y `signerDocument`) es texto sellado y no se recalcula.
    const { patient } = doc;
    return {
      ...doc,
      patient: {
        ...patient,
        docTypeName: documentTypeName(
          patient.docType,
          patient.docTypeLabel,
          await this.documentTypeNames.get(),
        ),
      },
      integrityOk: expected === doc.contentHash,
    };
  }
}
