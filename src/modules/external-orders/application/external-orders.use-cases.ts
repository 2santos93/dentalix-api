import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { ClinicRole } from '@prisma/client';
import {
  FILE_STORAGE,
  type FileStoragePort,
} from '../../../shared/storage/file-storage.port';
import { clinicLogoKeyToFreeze } from '../../../shared/storage/clinic-logo-url';
import { loadFrozenLogo } from '../infrastructure/frozen-logo';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { requireLocationTimeZone } from '../../../shared/locations/location-time-zone';
import {
  isHourCycle,
  requireLocationFormat,
} from '../../../shared/locations/location-regional';
import {
  addCivilDays,
  civilDateIn,
  zonedStartOfDay,
} from '../../../shared/time/civil-day';
import { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { ageInYears } from '../../odontogram/domain/dentition';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../patients/application/assert-patient-in-clinic';
import {
  documentText,
  documentTypeName,
} from '../../patients/domain/document-type';
import { DocumentTypeNamesReader } from '../../patients/domain/ports/document-type-names-repository.port';
import { storageKeyFor } from '../../patient-documents/domain/document-rules';
import {
  buildExternalOrderPdfModel,
  externalOrderFileName,
  type ExternalOrder,
  type ExternalOrderSnapshot,
} from '../domain/external-order';
import {
  EXTERNAL_ORDER_MESSAGES,
  PENDING_PAGE_SIZE_DEFAULT,
  PENDING_PAGE_SIZE_MAX,
  RECIPIENT_LOOKBACK_MONTHS,
  RECIPIENT_SUGGESTIONS_LIMIT,
  canIssueExternalOrder,
  canSeeClinicalNote,
  canUnlinkResult,
  canVoidExternalOrder,
  checkExternalOrderContent,
  contentErrorMessage,
  externalOrderAgeDays,
  isOverdue,
  isValidOverdueDays,
  normalizeVoidReason,
  type ExternalOrderKind,
} from '../domain/external-order-rules';
import {
  EXTERNAL_ORDER_REPOSITORY,
  type ArchiveExternalOrderPdf,
  type ExternalOrderIssueContext,
  type ExternalOrderRepository,
  type ExternalOrderSettings,
} from '../domain/ports/external-order-repository.port';
import {
  EXTERNAL_ORDER_PDF_RENDERER,
  type ExternalOrderPdfRenderer,
} from '../infrastructure/external-order-pdf.renderer';

export const EXTERNAL_ORDER_CLOCK = Symbol('EXTERNAL_ORDER_CLOCK');
export type ExternalOrderClock = () => Date;

/** Quien hace la petición (del token, nunca del cuerpo). */
export interface ExternalOrderActor {
  userId: string;
  role: ClinicRole;
}

export interface IssueExternalOrderInput {
  kind: ExternalOrderKind;
  recipient: string;
  items: string[];
  toothNumbers?: string[];
  clinicalNote?: string | null;
  appointmentId?: string | null;
  templateId?: string | null;
}

export interface ExternalOrderPdf {
  pdf: Buffer;
  fileName: string;
}

/** Una fila de «Órdenes sin resultado», ya con su antigüedad. */
export interface PendingExternalOrder {
  order: ExternalOrder;
  patient: { id: string; firstName: string; lastName: string };
  ageDays: number;
  overdue: boolean;
}

export interface PendingExternalOrdersPage {
  overdueDays: number;
  total: number;
  page: number;
  pageSize: number;
  items: PendingExternalOrder[];
}

export interface RecipientSuggestion {
  name: string;
  /** TEMPLATE = destinatario habitual de una plantilla; RECENT = de una orden. */
  source: 'TEMPLATE' | 'RECENT';
}

const pdfName = (o: ExternalOrder): string =>
  externalOrderFileName(o.kind, o.number, o.voidedAt !== null);

/**
 * Genera el PDF SIN la nota (desde la foto) y lo guarda en el almacén;
 * recuerda las claves guardadas para borrarlas si la transacción no confirma.
 */
class PdfArchiver {
  readonly keys: string[] = [];

  constructor(
    private readonly tenantId: string,
    private readonly renderer: ExternalOrderPdfRenderer,
    private readonly storage: FileStoragePort,
  ) {}

  readonly archive: ArchiveExternalOrderPdf = async (order) => {
    // La copia archivada la ven los 4 roles: nunca con la nota clínica.
    const logo = await loadFrozenLogo(this.storage, order.clinicLogoKey);
    const pdf = await this.renderer.render(
      buildExternalOrderPdfModel(order, { withNote: false, logo }),
    );
    const documentId = randomUUID();
    const storageKey = storageKeyFor(
      this.tenantId,
      documentId,
      'application/pdf',
    );
    await this.storage.save(storageKey, pdf, 'application/pdf');
    this.keys.push(storageKey);
    return {
      documentId,
      storageKey,
      sha256: createHash('sha256').update(pdf).digest('hex'),
      sizeBytes: pdf.length,
      originalName: pdfName(order),
    };
  };
}

/**
 * DX-572: órdenes de estudios (imagen, laboratorio) y referencias a
 * especialistas. Emiten DENTIST y ADMIN con registro profesional, desde la
 * ficha o desde una cita del paciente (de una sede permitida). Foto
 * inalterable, número por sede, PDF sin la nota archivado en los documentos
 * del paciente (REFERRAL), anulación con motivo y resultado ligado (un
 * documento del paciente). Recepción lo ve todo salvo la nota clínica.
 */
@Injectable()
export class ExternalOrdersUseCases {
  private readonly logger = new Logger('ExternalOrders');

  constructor(
    @Inject(EXTERNAL_ORDER_REPOSITORY)
    private readonly repo: ExternalOrderRepository,
    @Inject(EXTERNAL_ORDER_PDF_RENDERER)
    private readonly renderer: ExternalOrderPdfRenderer,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
    private readonly tenantContext: TenantContextService,
    private readonly documentTypeNames: DocumentTypeNamesReader,
    @Inject(EXTERNAL_ORDER_CLOCK) private readonly clock: ExternalOrderClock,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('Sin clínica en el contexto');
    return tenantId;
  }

  async issue(
    patientId: string,
    input: IssueExternalOrderInput,
    actor: ExternalOrderActor,
  ): Promise<ExternalOrder> {
    if (!canIssueExternalOrder(actor.role)) {
      throw new ForbiddenException(EXTERNAL_ORDER_MESSAGES.issueForbidden);
    }
    const loaded = await this.repo.loadIssueContext({
      patientId,
      appointmentId: input.appointmentId ?? null,
      templateId: input.templateId ?? null,
      issuerUserId: actor.userId,
    });
    if (loaded.kind === 'PATIENT_NOT_FOUND') {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    if (loaded.kind === 'APPOINTMENT_NOT_FOUND') {
      throw new NotFoundException(EXTERNAL_ORDER_MESSAGES.appointmentNotFound);
    }
    if (loaded.kind === 'TEMPLATE_NOT_FOUND') {
      throw new NotFoundException(EXTERNAL_ORDER_MESSAGES.templateNotFound);
    }
    const ctx = loaded.context;
    // Sede antes que contenido: de otra sede no se dice nada más (403).
    this.tenantContext.assertLocationAllowed(ctx.location.id);
    if (ctx.template && !ctx.template.active) {
      throw new ConflictException(EXTERNAL_ORDER_MESSAGES.templateInactive);
    }
    if (!ctx.issuer) {
      throw new ForbiddenException(EXTERNAL_ORDER_MESSAGES.issuerMissing);
    }
    const check = checkExternalOrderContent(input);
    const errors = check.ok ? [] : [...check.errors];
    if (!ctx.issuer.license) {
      errors.push(
        'falta tu número de registro profesional (lo añade un administrador en Personal)',
      );
    }
    if (!check.ok || errors.length > 0) {
      throw new BadRequestException(contentErrorMessage(errors));
    }
    const timeZone = requireLocationTimeZone(ctx.location);
    // Valida locale y reloj ahora: el PDF los usa (409 si faltan).
    requireLocationFormat(ctx.location);

    const snapshot = await this.snapshot(ctx, timeZone, ctx.issuer);
    const archiver = new PdfArchiver(
      this.tenantId(),
      this.renderer,
      this.storage,
    );
    try {
      return await this.repo.issue(
        {
          patientId,
          locationId: ctx.location.id,
          appointmentId: ctx.appointment?.id ?? null,
          professionalMembershipId: ctx.issuer.membershipId,
          issuedById: actor.userId,
          templateId: ctx.template?.id ?? null,
          content: check.value,
          snapshot,
          clinicLogoKey: clinicLogoKeyToFreeze(ctx.clinic.logoKey),
        },
        archiver.archive,
      );
    } catch (error) {
      await this.discard(archiver.keys);
      throw error;
    }
  }

  private async snapshot(
    ctx: ExternalOrderIssueContext,
    timeZone: string,
    professional: {
      name: string;
      license: string | null;
      specialty: string | null;
    },
  ): Promise<ExternalOrderSnapshot> {
    const names = await this.documentTypeNames.get(ctx.location.id);
    const { patient, location, clinic } = ctx;
    const day = civilDateIn(this.clock(), timeZone);
    return {
      version: 1,
      patient: {
        name: `${patient.firstName} ${patient.lastName}`.trim(),
        document: documentText(
          documentTypeName(patient.docType, patient.docTypeLabel, names),
          patient.docNumber,
        ),
        ageYears: patient.birthDate
          ? Math.max(
              0,
              ageInYears(patient.birthDate.toISOString().slice(0, 10), day),
            )
          : null,
      },
      professional: {
        name: professional.name,
        license: professional.license,
        specialty: professional.specialty,
      },
      location: {
        name: location.name,
        address: location.address?.trim() || null,
        healthRegistrationNumber: location.showHealthRegistrationNumber
          ? location.healthRegistrationNumber?.trim() || null
          : null,
        timeZone,
        // requireLocationFormat ya los exigió.
        locale: location.locale as string,
        hourCycle: isHourCycle(location.hourCycle) ? location.hourCycle : 'h23',
      },
      clinic: {
        name: clinic.name,
        legalName: clinic.legalName?.trim() || null,
        taxIdLabel: clinic.taxIdLabel?.trim() || null,
        taxId: clinic.taxId?.trim() || null,
      },
    };
  }

  /**
   * DX-089: sedes permitidas al usuario (claim `loc`); `undefined` = todas.
   * La ficha enseña las órdenes de todas las sedes a las que el usuario tiene
   * acceso, como sus certificados.
   */
  private allowedLocations(): readonly string[] | undefined {
    const allowed = this.tenantContext.getAllowedLocationIds();
    return allowed === 'ALL' ? undefined : allowed;
  }

  /** Recepción no ve la nota clínica (sale `null` con la bandera). */
  forViewer(order: ExternalOrder, viewer: ExternalOrderActor): ExternalOrder {
    return order.clinicalNote !== null && !canSeeClinicalNote(viewer.role)
      ? { ...order, clinicalNote: null, clinicalNoteHidden: true }
      : order;
  }

  async listForPatient(
    patientId: string,
    viewer: ExternalOrderActor,
  ): Promise<ExternalOrder[]> {
    const orders = await this.repo.listForPatient(
      patientId,
      this.allowedLocations(),
    );
    if (orders === null) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    return orders.map((o) => this.forViewer(o, viewer));
  }

  async get(id: string, viewer: ExternalOrderActor): Promise<ExternalOrder> {
    const order = await this.repo.get(id, this.allowedLocations());
    if (!order) throw new NotFoundException(EXTERNAL_ORDER_MESSAGES.notFound);
    return this.forViewer(order, viewer);
  }

  /**
   * El PDF, generado ahora desde la foto (refleja la anulación). Sin
   * `withNote`, sin la nota (lo que reimprime recepción); con él, solo los
   * roles clínicos (403 a recepción).
   */
  async pdf(
    id: string,
    withNote: boolean,
    viewer: ExternalOrderActor,
  ): Promise<ExternalOrderPdf> {
    const order = await this.repo.get(id, this.allowedLocations());
    if (!order) throw new NotFoundException(EXTERNAL_ORDER_MESSAGES.notFound);
    if (withNote && !canSeeClinicalNote(viewer.role)) {
      throw new ForbiddenException(EXTERNAL_ORDER_MESSAGES.noteForbidden);
    }
    const logo = await loadFrozenLogo(this.storage, order.clinicLogoKey);
    const pdf = await this.renderer.render(
      buildExternalOrderPdfModel(order, { withNote, logo }),
    );
    return { pdf, fileName: pdfName(order) };
  }

  async void(
    id: string,
    reasonInput: unknown,
    actor: ExternalOrderActor,
  ): Promise<ExternalOrder> {
    const reason = normalizeVoidReason(reasonInput);
    if (reason === null) {
      throw new BadRequestException(EXTERNAL_ORDER_MESSAGES.voidReason);
    }
    const archiver = new PdfArchiver(
      this.tenantId(),
      this.renderer,
      this.storage,
    );
    let result;
    try {
      result = await this.repo.voidOrder(
        id,
        this.allowedLocations(),
        { userId: actor.userId, reason },
        (order) => {
          if (!canVoidExternalOrder(actor, order)) {
            throw new ForbiddenException(EXTERNAL_ORDER_MESSAGES.voidForbidden);
          }
        },
        archiver.archive,
      );
    } catch (error) {
      await this.discard(archiver.keys);
      throw error;
    }
    if (result.kind === 'NOT_FOUND') {
      throw new NotFoundException(EXTERNAL_ORDER_MESSAGES.notFound);
    }
    if (result.kind === 'ALREADY_VOIDED') {
      throw new ConflictException(EXTERNAL_ORDER_MESSAGES.alreadyVoided);
    }
    if (result.kind === 'NOT_ISSUED') {
      throw new ConflictException(EXTERNAL_ORDER_MESSAGES.voidNotIssued);
    }
    return this.forViewer(result.order, actor);
  }

  async linkResult(
    id: string,
    documentId: string,
    actor: ExternalOrderActor,
  ): Promise<ExternalOrder> {
    const result = await this.repo.linkResult(
      id,
      this.allowedLocations(),
      documentId,
      actor.userId,
    );
    switch (result.kind) {
      case 'NOT_FOUND':
        throw new NotFoundException(EXTERNAL_ORDER_MESSAGES.notFound);
      case 'VOIDED':
        throw new ConflictException(EXTERNAL_ORDER_MESSAGES.linkVoided);
      case 'NOT_ISSUED':
        throw new ConflictException(EXTERNAL_ORDER_MESSAGES.linkNotIssued);
      case 'DOCUMENT_NOT_FOUND':
        throw new NotFoundException(
          EXTERNAL_ORDER_MESSAGES.resultDocumentNotFound,
        );
      case 'DOCUMENT_VOIDED':
        throw new ConflictException(
          EXTERNAL_ORDER_MESSAGES.resultDocumentVoided,
        );
      case 'LINKED':
        return this.forViewer(result.order, actor);
    }
  }

  async unlinkResult(
    id: string,
    actor: ExternalOrderActor,
  ): Promise<ExternalOrder> {
    const result = await this.repo.unlinkResult(
      id,
      this.allowedLocations(),
      (order) => {
        if (!canUnlinkResult(actor, order)) {
          throw new ForbiddenException(EXTERNAL_ORDER_MESSAGES.unlinkForbidden);
        }
      },
    );
    if (result.kind === 'NOT_FOUND') {
      throw new NotFoundException(EXTERNAL_ORDER_MESSAGES.notFound);
    }
    if (result.kind === 'NOT_RECEIVED') {
      throw new ConflictException(EXTERNAL_ORDER_MESSAGES.unlinkNotReceived);
    }
    return this.forViewer(result.order, actor);
  }

  /**
   * «Órdenes sin resultado» de UNA sede (la pedida o la activa): las ISSUED,
   * la más antigua primero, con los días civiles de la sede desde la emisión
   * y si pasan del plazo de la clínica. `overdueOnly` deja solo las vencidas.
   */
  async pending(
    input: {
      locationId?: string;
      overdueOnly?: boolean;
      page?: number;
      pageSize?: number;
    },
    viewer: ExternalOrderActor,
  ): Promise<PendingExternalOrdersPage> {
    const locationId = input.locationId ?? this.tenantContext.getLocationId();
    if (!locationId) {
      throw new BadRequestException(
        'Indica la sede (locationId) o elige una sede activa.',
      );
    }
    this.tenantContext.assertLocationAllowed(locationId);
    const location = await this.repo.locationTimeZone(locationId);
    if (!location) throw new NotFoundException('Sede no encontrada.');
    const timeZone = requireLocationTimeZone({
      id: locationId,
      timeZone: location.timeZone,
    });
    const { overdueDays } = await this.repo.getSettings();
    const now = this.clock();
    const page = Math.max(1, input.page ?? 1);
    const pageSize = Math.min(
      PENDING_PAGE_SIZE_MAX,
      Math.max(1, input.pageSize ?? PENDING_PAGE_SIZE_DEFAULT),
    );
    // Vencida = más de N días civiles: emitida antes del inicio del día
    // (hoy − N) en la zona de la sede.
    const issuedBefore = input.overdueOnly
      ? zonedStartOfDay(
          addCivilDays(civilDateIn(now, timeZone), -overdueDays),
          timeZone,
        )
      : null;
    const { rows, total } = await this.repo.pending({
      locationId,
      issuedBefore,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      overdueDays,
      total,
      page,
      pageSize,
      items: rows.map((row) => {
        const ageDays = externalOrderAgeDays(row.order.issuedAt, now, timeZone);
        return {
          order: this.forViewer(row.order, viewer),
          patient: row.patient,
          ageDays,
          overdue: isOverdue(ageDays, overdueDays),
        };
      }),
    };
  }

  /**
   * Sugerencias de destinatario: los habituales de las plantillas activas y
   * los distintos de las órdenes de la clínica en los últimos 12 meses (los
   * más usados primero). Como mucho 10, sin repetir (sin mayúsculas).
   */
  async recipients(q: string | undefined): Promise<RecipientSuggestion[]> {
    const query = q?.trim() || null;
    const now = this.clock();
    const since = new Date(now);
    since.setUTCMonth(since.getUTCMonth() - RECIPIENT_LOOKBACK_MONTHS);
    const [fromTemplates, recent] = await Promise.all([
      this.repo.templateRecipients({
        q: query,
        limit: RECIPIENT_SUGGESTIONS_LIMIT,
      }),
      this.repo.recentRecipients({
        since,
        q: query,
        limit: RECIPIENT_SUGGESTIONS_LIMIT,
      }),
    ]);
    const seen = new Set<string>();
    const out: RecipientSuggestion[] = [];
    const push = (name: string, source: RecipientSuggestion['source']) => {
      const key = name.trim().toLocaleLowerCase('es');
      if (key === '' || seen.has(key)) return;
      seen.add(key);
      out.push({ name: name.trim(), source });
    };
    fromTemplates.forEach((n) => push(n, 'TEMPLATE'));
    recent.forEach((n) => push(n, 'RECENT'));
    return out.slice(0, RECIPIENT_SUGGESTIONS_LIMIT);
  }

  /** El objeto sin fila no es alcanzable por la API; borrarlo es higiene. */
  private async discard(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      try {
        // Excepción justificada al borrado blando: borra el OBJETO del almacén
        // de una emisión cuya fila no se confirmó, no una fila de la BD.
        // eslint-disable-next-line no-restricted-syntax
        await this.storage.delete(key);
      } catch (error) {
        this.logger.warn(
          `No se pudo borrar el PDF de una orden fallida (error=${error instanceof Error ? error.name : 'NonError'})`,
        );
      }
    }
  }
}

/**
 * Ajustes de las órdenes de la clínica (leer: los 4 roles; cambiar: ADMIN, lo
 * exige la ruta). Si de verdad cambió, se audita con los campos cambiados
 * (CLINIC_SETTINGS · EXTERNAL_ORDER_SETTINGS).
 */
@Injectable()
export class ExternalOrderSettingsUseCases {
  constructor(
    @Inject(EXTERNAL_ORDER_REPOSITORY)
    private readonly repo: ExternalOrderRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  get(): Promise<ExternalOrderSettings> {
    return this.repo.getSettings();
  }

  async update(
    input: { overdueDays: unknown },
    ctx: AuditRequestContext,
  ): Promise<ExternalOrderSettings> {
    if (!isValidOverdueDays(input.overdueDays)) {
      throw new BadRequestException(EXTERNAL_ORDER_MESSAGES.overdueDays);
    }
    const { before, after } = await this.repo.setSettings({
      overdueDays: input.overdueDays,
    });
    if (before.overdueDays !== after.overdueDays) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        // Ajuste de TODA la clínica, sin la sede activa de quien lo cambia.
        locationId: null,
        actor: {
          kind: 'user',
          userId: ctx.actor.userId,
          role: ctx.actor.role,
        },
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: null,
        patient: null,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: {
          reason: 'EXTERNAL_ORDER_SETTINGS',
          changedFields: ['overdueDays'],
        },
      });
    }
    return after;
  }
}
