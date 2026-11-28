import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConsentSignerType, ResponsibleRelationship } from '@prisma/client';
import {
  PatientConsent,
  PatientConsentDocument,
  PatientConsentSummary,
  StoredPatientConsentDocument,
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
  AlreadyCountersignedError,
  PATIENT_CONSENT_REPOSITORY,
  type ConsentSigningContext,
  type PatientConsentRepository,
  TemplateVersionChangedError,
} from '../../domain/ports/patient-consent-repository.port';
import {
  formatConsentDate,
  renderConsent,
  usesVariable,
  withoutTreatmentLabelLines,
} from '../../domain/render-consent';
import { representationClause } from '../../domain/representation-clause';
import {
  computeConsentHash,
  computeCountersignatureHash,
  computeRemoteConsentHash,
} from '../../domain/consent-hash';
import { requireLocationFormat } from '../../../../shared/locations/location-regional';
import {
  parseSignaturePng,
  SignatureImageError,
} from '../../domain/signature-image';
import { CONSENT_TEMPLATE_NOT_FOUND_MESSAGE } from './consent-templates.use-cases';
import {
  SIGNED_CONSENT_PDF_SCHEDULER,
  type SignedConsentPdfScheduler,
} from '../../domain/ports/signed-consent-pdf-repository.port';
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
export const CONSENT_NOT_REMOTE_MESSAGE =
  'Este consentimiento se firmó en la clínica: ya lleva la firma del profesional.';
export const CONSENT_ALREADY_COUNTERSIGNED_MESSAGE =
  'El profesional ya firmó este consentimiento.';
export const CONSENT_WRONG_PROFESSIONAL_MESSAGE = (name: string) =>
  `Solo ${name} puede firmar este consentimiento como profesional: es quien lo envió a firmar y quien nombra el texto.`;
export const CONSENT_TEMPLATE_CHANGED_MESSAGE =
  'La plantilla cambió desde la vista previa: revisa el texto de nuevo antes de firmar';
/**
 * DX-058: cuánto vale una vista previa para fijar `{{fecha}}`. Leer el texto
 * con el paciente y firmar lleva minutos; dos horas cubren una consulta larga
 * y acotan cuánto puede retroceder la fecha impresa un `previewedAt` manual.
 */
export const CONSENT_PREVIEW_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** Desfase tolerado entre relojes de instancias de la API. */
const CONSENT_PREVIEW_CLOCK_SKEW_MS = 5_000;
export const CONSENT_PREVIEW_EXPIRED_MESSAGE =
  'La vista previa caducó: vuelve a leer el texto con el paciente antes de firmar.';
/**
 * DX-060 (m-2): `{{tratamiento}}` sin plan (o con un plan sin procedimientos).
 * Se lee bien tras «a realizar:» o «autorizo …»; nunca «No especificado».
 */
export const NO_PLAN_TREATMENT =
  'el tratamiento indicado por el profesional en la consulta';
export const GUARDIAN_REQUIRED_MESSAGE =
  'Si firma un tutor, su nombre y su documento son obligatorios';
const NO_DOCUMENT = 'Sin documento';

export interface PreviewPatientConsentInput {
  templateId: string;
  treatmentPlanId?: string;
  /**
   * DX-060: quién firma. Con un tutor, el texto abre con la cláusula de
   * representación (nombre, documento y relación con el paciente).
   */
  signerType?: ConsentSignerType;
  guardianName?: string;
  guardianDocument?: string;
  guardianRelationship?: ResponsibleRelationship;
}

export interface Guardian {
  name: string;
  document: string;
  relationship?: ResponsibleRelationship;
}

export interface ConsentPreview {
  templateId: string;
  templateVersion: number;
  title: string;
  body: string;
  professionalName: string;
  /**
   * DX-058: el instante (reloj del servidor) con el que se pintó `{{fecha}}`.
   * La firma lo devuelve para que el texto firmado lleve esa misma fecha.
   */
  previewedAt: Date;
}

export interface SignPatientConsentInput extends PreviewPatientConsentInput {
  /** La versión que vio el paciente en la vista previa. */
  templateVersion: number;
  /**
   * DX-058: `previewedAt` de esa vista previa (ISO). Fija `{{fecha}}`; sin él
   * (cliente antiguo), la fecha es la de la firma.
   */
  previewedAt?: string;
  signerType: ConsentSignerType;
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

function hasTreatment(plan: ConsentSigningContext['plan']): boolean {
  return !!plan && plan.items.length > 0;
}

function treatmentOf(plan: ConsentSigningContext['plan']): string {
  if (!plan || plan.items.length === 0) return NO_PLAN_TREATMENT;
  return plan.items
    .map((item) => `${item.label} (diente ${item.toothNumber})`)
    .join('; ');
}

function requiredTrimmed(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * El tutor de la entrada, validado; `null` si firma el paciente. DX-060-bis:
 * también lo usa la firma a distancia con un tutor (400 sin nombre o sin
 * documento, igual que en la clínica).
 */
export function guardianOf(
  input: Pick<
    PreviewPatientConsentInput,
    'signerType' | 'guardianName' | 'guardianDocument' | 'guardianRelationship'
  >,
): Guardian | null {
  if (input.signerType !== ConsentSignerType.GUARDIAN) return null;
  const name = requiredTrimmed(input.guardianName);
  const document = requiredTrimmed(input.guardianDocument);
  if (!name || !document) {
    throw new BadRequestException(GUARDIAN_REQUIRED_MESSAGE);
  }
  return { name, document, relationship: input.guardianRelationship };
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
  /** Quien firma por el paciente, ya validado (o `null`). */
  guardian: Guardian | null;
}> {
  // Las validaciones baratas, antes de tocar la base.
  const guardian = guardianOf(input);
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
  // DX-524: el nombre de la sede donde se firma.
  const document = documentOf(
    context.patient,
    await documentTypeNames.get(context.location.id),
  );
  const patientName = `${context.patient.firstName} ${context.patient.lastName}`;
  // DX-060 (m-2): sin procedimientos, la línea que solo los rotulaba sobra.
  const source = hasTreatment(context.plan)
    ? template.body
    : withoutTreatmentLabelLines(template.body);
  const rendered = renderConsent(source, {
    paciente: patientName,
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
  const body = withRepresentation(rendered, guardian, patientName);
  return { template, context, title: template.title, body, document, guardian };
}

/**
 * DX-060 (m-3): con un tutor, el documento abre diciendo quién firma y por
 * quién. Se añade tras renderizar: lo que escribió el tutor nunca se
 * interpreta como variable. DX-060-bis: la firma a distancia con un tutor
 * congela el texto con este mismo párrafo.
 */
export function withRepresentation(
  rendered: string,
  guardian: Guardian | null,
  patientName: string,
): string {
  if (!guardian) return rendered;
  const clause = representationClause({
    representativeName: guardian.name,
    representativeDocument: guardian.document,
    relationship: guardian.relationship,
    patientName,
  });
  return `${clause}\n\n${rendered}`;
}

/** El documento resuelto, listo para mostrar y sellar. */
export type PreparedConsent = Awaited<ReturnType<typeof prepare>>;

/**
 * DX-243: la misma resolución de plantilla + contexto que la vista previa y la
 * firma en pantalla, para congelar el texto que se envía a firmar a distancia.
 * Lanza los mismos 404/400/409 (paciente, plan, plantilla, sede sin formato).
 */
@Injectable()
export class ConsentDocumentRenderer {
  constructor(
    @Inject(CONSENT_TEMPLATE_REPOSITORY)
    private readonly templates: ConsentTemplateRepository,
    @Inject(PATIENT_CONSENT_REPOSITORY)
    private readonly consents: PatientConsentRepository,
    private readonly documentTypeNames: DocumentTypeNamesReader,
  ) {}

  render(
    patientId: string,
    input: PreviewPatientConsentInput,
    professionalUserId: string,
    now: Date,
  ): Promise<PreparedConsent> {
    return prepare(
      this.templates,
      this.consents,
      this.documentTypeNames,
      now,
      patientId,
      input,
      professionalUserId,
    );
  }
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
    const previewedAt = this.now();
    const { template, context, title, body } = await prepare(
      this.templates,
      this.consents,
      this.documentTypeNames,
      previewedAt,
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
      previewedAt,
    };
  }
}

/**
 * DX-058: el instante con el que se pinta `{{fecha}}` al firmar: el de la
 * vista previa si llega y es reciente (409 `CONSENT_PREVIEW_EXPIRED` si no:
 * hay que volver a leer el texto), o el de la firma para un cliente antiguo.
 */
function renderInstant(previewedAt: string | undefined, signedAt: Date): Date {
  if (previewedAt === undefined) return signedAt;
  const at = new Date(previewedAt);
  const age = signedAt.getTime() - at.getTime();
  if (
    Number.isNaN(age) ||
    age > CONSENT_PREVIEW_MAX_AGE_MS ||
    age < -CONSENT_PREVIEW_CLOCK_SKEW_MS
  ) {
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: 'CONSENT_PREVIEW_EXPIRED',
      message: CONSENT_PREVIEW_EXPIRED_MESSAGE,
    });
  }
  return at;
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
    const signedAt = this.now();
    // DX-058: `{{fecha}}` es la de la vista previa, no la de este instante:
    // pasada la medianoche, el texto firmado seguiría siendo el que se leyó.
    // El tutor (400 si le falta nombre o documento) se valida en `prepare`,
    // antes de tocar la base.
    const { template, context, title, body, document, guardian } =
      await prepare(
        this.templates,
        this.consents,
        this.documentTypeNames,
        renderInstant(input.previewedAt, signedAt),
        patientId,
        input,
        meta.recordedById,
      );
    if (template.version !== input.templateVersion) {
      throw new ConflictException(CONSENT_TEMPLATE_CHANGED_MESSAGE);
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

    // El repositorio repite la comprobación de versión dentro de la
    // transacción del INSERT (DX-058): esta de arriba es el atajo barato.
    return this.consents
      .create({
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
      })
      .catch((error: unknown) => {
        if (error instanceof TemplateVersionChangedError) {
          throw new ConflictException(CONSENT_TEMPLATE_CHANGED_MESSAGE);
        }
        throw error;
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
    // La cabecera es en vivo (R18): el nombre visible de hoy; lo firmado
    // (cuerpo y `signerDocument`) es texto sellado y no se recalcula. La firma
    // del profesional a distancia ya va en `professionalSignature`.
    const { patient, countersignature: _countersignature, ...consent } = doc;
    return {
      ...consent,
      patient: {
        ...patient,
        docTypeName: documentTypeName(
          patient.docType,
          patient.docTypeLabel,
          await this.documentTypeNames.get(),
        ),
      },
      integrityOk: integrityOk(doc),
    };
  }
}

/**
 * ¿Casa lo guardado con sus hashes? En pantalla, el de las dos firmas; a
 * distancia (DX-243), el de la firma del paciente con sus evidencias y, si ya
 * firmó el profesional, el de su firma encadenado al anterior.
 */
function integrityOk(doc: StoredPatientConsentDocument): boolean {
  if (!doc.remote) {
    return (
      doc.professionalSignature !== null &&
      computeConsentHash({
        title: doc.title,
        body: doc.body,
        signerType: doc.signerType,
        signerName: doc.signerName,
        signerDocument: doc.signerDocument,
        professionalName: doc.professionalName,
        patientSignature: doc.patientSignature,
        professionalSignature: doc.professionalSignature,
        signedAt: doc.signedAt,
      }) === doc.contentHash
    );
  }
  const patientSide = computeRemoteConsentHash({
    title: doc.title,
    body: doc.body,
    templateVersion: doc.templateVersion,
    signerType: doc.signerType,
    signerName: doc.signerName,
    signerDocument: doc.signerDocument,
    professionalName: doc.professionalName,
    patientSignature: doc.patientSignature,
    signedAt: doc.signedAt,
    channel: doc.remote.channel,
    destinationMasked: doc.remote.destinationMasked,
    sentAt: doc.remote.sentAt,
    openedAt: doc.remote.openedAt,
    verifiedAt: doc.remote.verifiedAt,
    ipAddress: doc.ipAddress,
    userAgent: doc.userAgent,
  });
  if (patientSide !== doc.contentHash) return false;
  const counter = doc.countersignature;
  return (
    counter === null ||
    computeCountersignatureHash({
      consentHash: doc.contentHash,
      professionalName: counter.professionalName,
      professionalSignature: counter.professionalSignature,
      signedAt: counter.signedAt,
    }) === counter.contentHash
  );
}

export interface CountersignPatientConsentInput {
  professionalSignature: string;
}

/**
 * DX-243: el profesional firma en la app un consentimiento que el paciente
 * firmó a distancia; solo entonces cuenta como completo. Solo el profesional
 * que nombra el texto (quien se eligió al enviarlo). Append-only: un INSERT
 * en su propia tabla, con su hash encadenado al del consentimiento.
 */
@Injectable()
export class CountersignPatientConsentUseCase {
  constructor(
    @Inject(PATIENT_CONSENT_REPOSITORY)
    private readonly consents: PatientConsentRepository,
    @Inject(CONSENT_CLOCK)
    private readonly now: ConsentClock,
    @Inject(SIGNED_CONSENT_PDF_SCHEDULER)
    private readonly pdfs: SignedConsentPdfScheduler,
  ) {}

  async execute(
    patientId: string,
    id: string,
    input: CountersignPatientConsentInput,
    meta: SignPatientConsentMeta,
  ): Promise<PatientConsentSummary> {
    const target = await this.consents.findCountersignTarget(patientId, id);
    if (!target) throw new NotFoundException(CONSENT_NOT_FOUND_MESSAGE);
    if (!target.remote) {
      throw new ConflictException(CONSENT_NOT_REMOTE_MESSAGE);
    }
    if (target.countersigned) {
      throw new ConflictException(CONSENT_ALREADY_COUNTERSIGNED_MESSAGE);
    }
    if (target.remote.professionalUserId !== meta.recordedById) {
      throw new ForbiddenException(
        CONSENT_WRONG_PROFESSIONAL_MESSAGE(target.remote.professionalName),
      );
    }
    const professionalSignature = parseSignature(
      input.professionalSignature,
      'la firma del profesional',
    );
    const signedAt = this.now();
    const professionalName = target.remote.professionalName;
    try {
      return await this.consents.countersign(
        {
          patientId,
          consentId: target.id,
          professionalUserId: meta.recordedById,
          professionalName,
          professionalSignature,
          contentHash: computeCountersignatureHash({
            consentHash: target.contentHash,
            professionalName,
            professionalSignature,
            signedAt,
          }),
          signedAt,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        },
        // DX-422: completo ⇒ PDF firmado en segundo plano (outbox).
        (tx) => this.pdfs.schedule(tx, target.id),
      );
    } catch (error) {
      if (error instanceof AlreadyCountersignedError) {
        throw new ConflictException(CONSENT_ALREADY_COUNTERSIGNED_MESSAGE);
      }
      throw error;
    }
  }
}
