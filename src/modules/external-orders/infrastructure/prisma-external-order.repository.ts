import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { lockLivePatientOrConflict } from '../../../shared/patients/lock-live-patient';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { EXTERNAL_ORDER_MESSAGES } from '../domain/external-order-rules';
import {
  readExternalOrderSnapshot,
  type ExternalOrder,
} from '../domain/external-order';
import type {
  ArchiveExternalOrderPdf,
  ArchivedExternalOrderPdf,
  ExternalOrderIssueContextResult,
  ExternalOrderProfessional,
  ExternalOrderRepository,
  ExternalOrderSettings,
  LinkResultOutcome,
  NewExternalOrderInput,
  PendingExternalOrderRow,
  PendingExternalOrdersQuery,
  UnlinkResultOutcome,
  VoidExternalOrderResult,
} from '../domain/ports/external-order-repository.port';

/** Lo que se lee de cada orden (con los nombres de quien emitió/anuló/ligó). */
const ORDER_INCLUDE = {
  issuedBy: { select: { fullName: true } },
  voidedBy: { select: { fullName: true } },
  resultLinkedBy: { select: { fullName: true } },
} satisfies Prisma.ExternalOrderInclude;

type OrderRow = Prisma.ExternalOrderGetPayload<{
  include: typeof ORDER_INCLUDE;
}>;

export function toExternalOrder(row: OrderRow): ExternalOrder {
  return {
    id: row.id,
    patientId: row.patientId,
    locationId: row.locationId,
    appointmentId: row.appointmentId,
    professionalMembershipId: row.professionalMembershipId,
    issuedById: row.issuedById,
    issuedByName: row.issuedBy?.fullName ?? null,
    kind: row.kind,
    number: row.number,
    issuedAt: row.issuedAt,
    status: row.status,
    recipient: row.recipient,
    items: row.items,
    toothNumbers: row.toothNumbers,
    clinicalNote: row.clinicalNote,
    templateId: row.templateId,
    snapshot: readExternalOrderSnapshot(row.snapshot),
    clinicLogoKey: row.clinicLogoKey,
    documentId: row.documentId,
    resultDocumentId: row.resultDocumentId,
    resultLinkedAt: row.resultLinkedAt,
    resultLinkedById: row.resultLinkedById,
    resultLinkedByName: row.resultLinkedBy?.fullName ?? null,
    voidedAt: row.voidedAt,
    voidedById: row.voidedById,
    voidedByName: row.voidedBy?.fullName ?? null,
    voidReason: row.voidReason,
    voidedDocumentId: row.voidedDocumentId,
  };
}

/** Filtro por las sedes permitidas; `undefined` = todas. */
function locationFilter(locationIds: readonly string[] | undefined): {
  locationId?: { in: string[] };
} {
  return locationIds ? { locationId: { in: [...locationIds] } } : {};
}

/** Motivo con el que se anula el documento archivado (CHECK 1..500). */
function documentVoidReason(reason: string): string {
  const text = `Orden anulada: ${reason}`;
  return Array.from(text).slice(0, 500).join('');
}

/**
 * DX-572: órdenes externas en Postgres, todo bajo `runWithTenant` (RLS FORCE):
 * un paciente, una cita, un documento o una orden de otra clínica no existen.
 * `tenants` no tiene RLS: se acota por el tenant del contexto.
 */
@Injectable()
export class PrismaExternalOrderRepository implements ExternalOrderRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  private async professional(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<ExternalOrderProfessional | null> {
    const membership = await tx.clinicMembership.findFirst({
      where: { userId, deletedAt: null },
      select: {
        id: true,
        professionalLicense: true,
        professionalSpecialty: true,
        user: { select: { fullName: true } },
      },
    });
    if (!membership) return null;
    return {
      membershipId: membership.id,
      name: membership.user.fullName,
      license: membership.professionalLicense?.trim() || null,
      specialty: membership.professionalSpecialty?.trim() || null,
    };
  }

  loadIssueContext(input: {
    patientId: string;
    appointmentId: string | null;
    templateId: string | null;
    issuerUserId: string;
  }): Promise<ExternalOrderIssueContextResult> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: input.patientId, deletedAt: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          birthDate: true,
          documentType: true,
          docTypeLabel: true,
          docNumber: true,
        },
      });
      if (!patient) return { kind: 'PATIENT_NOT_FOUND' };
      let appointment: { id: string; locationId: string } | null = null;
      if (input.appointmentId) {
        appointment = await tx.appointment.findFirst({
          where: {
            id: input.appointmentId,
            patientId: input.patientId,
            deletedAt: null,
          },
          select: { id: true, locationId: true },
        });
        if (!appointment) return { kind: 'APPOINTMENT_NOT_FOUND' };
      }
      let template: { id: string; active: boolean } | null = null;
      if (input.templateId) {
        template = await tx.externalOrderTemplate.findFirst({
          where: { id: input.templateId },
          select: { id: true, active: true },
        });
        if (!template) return { kind: 'TEMPLATE_NOT_FOUND' };
      }
      // Sin cita: la sede activa (cabecera, o la primera permitida).
      const locationId =
        appointment?.locationId ??
        (await this.tenantContext.writeLocationId(tx));
      const [location, tenant, issuer] = await Promise.all([
        tx.location.findFirstOrThrow({
          where: { id: locationId },
          select: {
            id: true,
            name: true,
            address: true,
            healthRegistrationNumber: true,
            showHealthRegistrationNumber: true,
            timeZone: true,
            locale: true,
            hourCycle: true,
          },
        }),
        tx.tenant.findFirstOrThrow({
          where: { id: tenantId },
          select: {
            name: true,
            legalName: true,
            taxIdLabel: true,
            taxId: true,
            logoKey: true,
          },
        }),
        this.professional(tx, input.issuerUserId),
      ]);
      const { documentType, ...rest } = patient;
      return {
        kind: 'OK',
        context: {
          patient: { ...rest, docType: documentType },
          appointment,
          location,
          clinic: tenant,
          issuer,
          template,
        },
      };
    });
  }

  async issue(
    input: NewExternalOrderInput,
    archive: ArchiveExternalOrderPdf,
  ): Promise<ExternalOrder> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Primer candado: el paciente vivo (el orden de archivar y fusionar,
      // paciente → lo suyo). Archivado entre la lectura y aquí: 409.
      try {
        await lockLivePatientOrConflict(tx, input.patientId);
      } catch (error) {
        if (error instanceof ConflictException) {
          throw new ConflictException(EXTERNAL_ORDER_MESSAGES.patientArchived);
        }
        throw error;
      }
      const created = await tx.externalOrder.create({
        data: {
          tenantId,
          patientId: input.patientId,
          locationId: input.locationId,
          appointmentId: input.appointmentId,
          professionalMembershipId: input.professionalMembershipId,
          issuedById: input.issuedById,
          templateId: input.templateId,
          kind: input.content.kind,
          // Lo sustituye el trigger por el siguiente de la sede.
          number: 0,
          recipient: input.content.recipient,
          items: input.content.items,
          toothNumbers: input.content.toothNumbers,
          clinicalNote: input.content.clinicalNote,
          snapshot: input.snapshot as unknown as Prisma.InputJsonValue,
          clinicLogoKey: input.clinicLogoKey,
        },
        include: ORDER_INCLUDE,
      });
      const order = toExternalOrder(created);
      const pdf = await archive(order);
      await this.createDocument(tx, tenantId, order, pdf, input.issuedById);
      const linked = await tx.externalOrder.update({
        where: { id: order.id },
        data: { documentId: pdf.documentId },
        include: ORDER_INCLUDE,
      });
      return toExternalOrder(linked);
    });
  }

  private async createDocument(
    tx: Prisma.TransactionClient,
    tenantId: string,
    order: ExternalOrder,
    pdf: ArchivedExternalOrderPdf,
    uploadedById: string,
  ): Promise<void> {
    await tx.patientDocument.create({
      data: {
        id: pdf.documentId,
        tenantId,
        patientId: order.patientId,
        locationId: order.locationId,
        category: 'REFERRAL',
        originalName: pdf.originalName,
        mimeType: 'application/pdf',
        sizeBytes: pdf.sizeBytes,
        sha256: pdf.sha256,
        storageKey: pdf.storageKey,
        toothNumbers: [],
        uploadedById,
      },
    });
  }

  listForPatient(
    patientId: string,
    locationIds?: readonly string[],
  ): Promise<ExternalOrder[] | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: patientId },
        select: { id: true },
      });
      if (!patient) return null;
      const rows = await tx.externalOrder.findMany({
        where: { patientId, ...locationFilter(locationIds) },
        orderBy: [{ issuedAt: 'desc' }, { number: 'desc' }],
        include: ORDER_INCLUDE,
      });
      return rows.map(toExternalOrder);
    });
  }

  get(
    id: string,
    locationIds?: readonly string[],
  ): Promise<ExternalOrder | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.externalOrder.findFirst({
        where: { id, ...locationFilter(locationIds) },
        include: ORDER_INCLUDE,
      });
      return row ? toExternalOrder(row) : null;
    });
  }

  /** Candado de la fila y la orden, si es de una sede permitida. */
  private async lockOrder(
    tx: Prisma.TransactionClient,
    id: string,
    locationIds: readonly string[] | undefined,
  ): Promise<ExternalOrder | null> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "external_orders" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) return null;
    // DX-089: de una sede no permitida, como si no existiera.
    const row = await tx.externalOrder.findFirst({
      where: { id, ...locationFilter(locationIds) },
      include: ORDER_INCLUDE,
    });
    return row ? toExternalOrder(row) : null;
  }

  voidOrder(
    id: string,
    locationIds: readonly string[] | undefined,
    actor: { userId: string; reason: string },
    authorize: (order: ExternalOrder) => void,
    archive: ArchiveExternalOrderPdf,
  ): Promise<VoidExternalOrderResult> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Candados en el orden de archivar y fusionar (lock-live-patient.ts):
      // primero el paciente, luego la orden y sus enlaces. Al revés, anular
      // (orden → enlaces → paciente por la FK del documento) y archivar
      // (paciente → enlaces) se interbloqueaban.
      const owner = await tx.externalOrder.findFirst({
        where: { id },
        select: { patientId: true },
      });
      if (!owner) return { kind: 'NOT_FOUND' };
      await lockLivePatientOrConflict(tx, owner.patientId);
      const current = await this.lockOrder(tx, id, locationIds);
      if (!current) return { kind: 'NOT_FOUND' };
      authorize(current);
      if (current.status === 'VOIDED') return { kind: 'ALREADY_VOIDED' };
      if (current.status !== 'ISSUED') return { kind: 'NOT_ISSUED' };
      const now = new Date();
      const voided = toExternalOrder(
        await tx.externalOrder.update({
          where: { id },
          data: {
            status: 'VOIDED',
            voidedAt: now,
            voidedById: actor.userId,
            voidReason: actor.reason,
          },
          include: ORDER_INCLUDE,
        }),
      );
      // El PDF archivado al emitir queda anulado en la ficha (con el motivo)
      // y en su lugar se archiva el PDF con «ANULADA».
      if (current.documentId) {
        await tx.patientDocument.updateMany({
          where: { id: current.documentId, voidedAt: null },
          data: {
            voidedAt: now,
            voidedById: actor.userId,
            voidReason: documentVoidReason(actor.reason),
          },
        });
      }
      // Una copia enviada deja de servir: la orden ya no vale.
      await tx.externalOrderCopyLink.updateMany({
        where: { orderId: id, revokedAt: null, usedAt: null },
        data: { revokedAt: now },
      });
      const pdf = await archive(voided);
      await this.createDocument(tx, tenantId, voided, pdf, actor.userId);
      const linked = await tx.externalOrder.update({
        where: { id },
        data: { voidedDocumentId: pdf.documentId },
        include: ORDER_INCLUDE,
      });
      return { kind: 'VOIDED', order: toExternalOrder(linked) };
    });
  }

  linkResult(
    id: string,
    locationIds: readonly string[] | undefined,
    documentId: string,
    actorUserId: string,
  ): Promise<LinkResultOutcome> {
    return this.prisma.runWithTenant(async (tx) => {
      const current = await this.lockOrder(tx, id, locationIds);
      if (!current) return { kind: 'NOT_FOUND' };
      if (current.status === 'VOIDED') return { kind: 'VOIDED' };
      if (current.status !== 'ISSUED') return { kind: 'NOT_ISSUED' };
      const document = await tx.patientDocument.findFirst({
        where: { id: documentId, patientId: current.patientId },
        select: { voidedAt: true },
      });
      if (!document) return { kind: 'DOCUMENT_NOT_FOUND' };
      if (document.voidedAt !== null) return { kind: 'DOCUMENT_VOIDED' };
      // Un PDF que generó la clínica (de una orden o de un certificado, vivo
      // o anulado) no es el estudio que llegó.
      const [generated] = await tx.$queryRaw<{ found: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM "external_orders"
           WHERE "documentId" = ${documentId}::uuid
              OR "voidedDocumentId" = ${documentId}::uuid
        ) OR EXISTS (
          SELECT 1 FROM "patient_certificates"
           WHERE "documentId" = ${documentId}::uuid
              OR "voidedDocumentId" = ${documentId}::uuid
        ) AS "found"`;
      if (generated?.found) return { kind: 'DOCUMENT_GENERATED' };
      const row = await tx.externalOrder.update({
        where: { id },
        data: {
          status: 'RESULT_RECEIVED',
          resultDocumentId: documentId,
          resultLinkedAt: new Date(),
          resultLinkedById: actorUserId,
        },
        include: ORDER_INCLUDE,
      });
      return { kind: 'LINKED', order: toExternalOrder(row) };
    });
  }

  unlinkResult(
    id: string,
    locationIds: readonly string[] | undefined,
    authorize: (order: ExternalOrder) => void,
  ): Promise<UnlinkResultOutcome> {
    return this.prisma.runWithTenant(async (tx) => {
      const current = await this.lockOrder(tx, id, locationIds);
      if (!current) return { kind: 'NOT_FOUND' };
      if (current.status !== 'RESULT_RECEIVED') {
        return { kind: 'NOT_RECEIVED' };
      }
      authorize(current);
      const row = await tx.externalOrder.update({
        where: { id },
        data: {
          status: 'ISSUED',
          resultDocumentId: null,
          resultLinkedAt: null,
          resultLinkedById: null,
        },
        include: ORDER_INCLUDE,
      });
      return { kind: 'UNLINKED', order: toExternalOrder(row) };
    });
  }

  pending(
    query: PendingExternalOrdersQuery,
  ): Promise<{ rows: PendingExternalOrderRow[]; total: number }> {
    return this.prisma.runWithTenant(async (tx) => {
      const where: Prisma.ExternalOrderWhereInput = {
        locationId: query.locationId,
        status: 'ISSUED',
        // Un paciente archivado no tiene nada pendiente que hacer aquí.
        patient: { deletedAt: null },
        ...(query.issuedBefore ? { issuedAt: { lt: query.issuedBefore } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.externalOrder.findMany({
          where,
          orderBy: [{ issuedAt: 'asc' }, { number: 'asc' }],
          skip: query.skip,
          take: query.take,
          include: {
            ...ORDER_INCLUDE,
            patient: { select: { id: true, firstName: true, lastName: true } },
          },
        }),
        tx.externalOrder.count({ where }),
      ]);
      return {
        rows: rows.map((row) => ({
          order: toExternalOrder(row),
          patient: row.patient,
        })),
        total,
      };
    });
  }

  locationTimeZone(
    locationId: string,
  ): Promise<{ timeZone: string | null } | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.location.findFirst({
        where: { id: locationId },
        select: { timeZone: true },
      }),
    );
  }

  recentRecipients(input: {
    since: Date;
    q: string | null;
    limit: number;
  }): Promise<string[]> {
    const pattern = input.q ? `%${escapeLike(input.q)}%` : '%';
    return this.prisma.runWithTenant(async (tx) => {
      // El más usado primero; entre iguales, el más reciente. Sin
      // distinguir mayúsculas ni espacios de los bordes.
      const rows = await tx.$queryRaw<{ recipient: string }[]>`
        SELECT (array_agg(btrim("recipient") ORDER BY "issuedAt" DESC))[1] AS "recipient"
          FROM "external_orders"
         WHERE "issuedAt" >= ${input.since}
           AND "status" <> 'VOIDED'
           AND "recipient" ILIKE ${pattern}
         GROUP BY lower(btrim("recipient"))
         ORDER BY count(*) DESC, max("issuedAt") DESC
         LIMIT ${input.limit}`;
      return rows.map((r) => r.recipient);
    });
  }

  templateRecipients(input: {
    q: string | null;
    limit: number;
  }): Promise<string[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.externalOrderTemplate.findMany({
        where: {
          active: true,
          recipient: input.q
            ? { contains: input.q, mode: 'insensitive' }
            : { not: null },
        },
        orderBy: [{ name: 'asc' }],
        select: { recipient: true },
        take: input.limit,
      });
      return rows.flatMap((r) => (r.recipient ? [r.recipient] : []));
    });
  }

  getSettings(): Promise<ExternalOrderSettings> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.tenant.findFirstOrThrow({
        where: { id: tenantId },
        select: { externalOrderOverdueDays: true },
      });
      return { overdueDays: row.externalOrderOverdueDays };
    });
  }

  setSettings(
    next: ExternalOrderSettings,
  ): Promise<{ before: ExternalOrderSettings; after: ExternalOrderSettings }> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const [row] = await tx.$queryRaw<{ externalOrderOverdueDays: number }[]>`
        SELECT "externalOrderOverdueDays" FROM "tenants"
         WHERE "id" = ${tenantId}::uuid FOR UPDATE`;
      const before = { overdueDays: row.externalOrderOverdueDays };
      await tx.tenant.update({
        where: { id: tenantId },
        data: { externalOrderOverdueDays: next.overdueDays },
      });
      return { before, after: next };
    });
  }
}

/** Escapa los comodines de LIKE (el texto de la búsqueda es literal). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
