import type {
  ExternalOrderCopySent,
  PublicExternalOrderCopyView,
} from '../application/external-order-copies.use-cases';
import type { PendingExternalOrdersPage } from '../application/external-orders.use-cases';
import type { ExternalOrder } from '../domain/external-order';
import { formatExternalOrderNumber } from '../domain/external-order-rules';
import type { ExternalOrderTemplate } from '../domain/external-order-template';
import type {
  ExternalOrderCopySentDto,
  ExternalOrderDto,
  ExternalOrderTemplateDto,
  PendingExternalOrdersPageDto,
  PublicExternalOrderCopyDto,
} from './dto/external-order.dto';

export function presentExternalOrder(o: ExternalOrder): ExternalOrderDto {
  const { version: _version, ...snapshot } = o.snapshot;
  return {
    id: o.id,
    patientId: o.patientId,
    locationId: o.locationId,
    appointmentId: o.appointmentId,
    kind: o.kind,
    status: o.status,
    number: o.number,
    numberLabel: formatExternalOrderNumber(o.number),
    issuedAt: o.issuedAt.toISOString(),
    issuedById: o.issuedById,
    issuedByName: o.issuedByName,
    recipient: o.recipient,
    items: o.items,
    toothNumbers: o.toothNumbers,
    clinicalNote: o.clinicalNote,
    hasClinicalNote: o.clinicalNote !== null || o.clinicalNoteHidden === true,
    templateId: o.templateId,
    snapshot,
    documentId: o.documentId,
    resultDocumentId: o.resultDocumentId,
    resultLinkedAt: o.resultLinkedAt?.toISOString() ?? null,
    resultLinkedById: o.resultLinkedById,
    resultLinkedByName: o.resultLinkedByName,
    voidedAt: o.voidedAt?.toISOString() ?? null,
    voidedByName: o.voidedByName,
    voidReason: o.voidReason,
    voidedDocumentId: o.voidedDocumentId,
  };
}

export function presentPending(
  page: PendingExternalOrdersPage,
): PendingExternalOrdersPageDto {
  return {
    overdueDays: page.overdueDays,
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    items: page.items.map((item) => ({
      order: presentExternalOrder(item.order),
      patient: item.patient,
      ageDays: item.ageDays,
      overdue: item.overdue,
    })),
  };
}

export function presentCopySent(
  sent: ExternalOrderCopySent,
): ExternalOrderCopySentDto {
  return {
    channel: sent.channel,
    sentAt: sent.sentAt.toISOString(),
    expiresAt: sent.expiresAt.toISOString(),
    destinationMasked: sent.destinationMasked,
    recipientKind: sent.recipientKind,
    whatsapp: sent.whatsapp,
  };
}

export function presentTemplate(
  t: ExternalOrderTemplate,
): ExternalOrderTemplateDto {
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    recipient: t.recipient,
    items: t.items,
    active: t.active,
    version: t.version,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** Datos mínimos de la página pública: clínica, número, tipo y fecha. */
export function presentPublicCopy(
  view: PublicExternalOrderCopyView,
): PublicExternalOrderCopyDto {
  const { timeZone, locale, hourCycle } = view.order.snapshot.location;
  return {
    status: view.status,
    clinic: view.clinic,
    numberLabel: formatExternalOrderNumber(view.order.number),
    kind: view.order.kind,
    issuedAt: view.order.issuedAt.toISOString(),
    expiresAt: view.expiresAt.toISOString(),
    format: { timeZone, locale, hourCycle },
  };
}
