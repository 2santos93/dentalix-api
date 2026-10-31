import type { Prisma, SignatureRequestType } from '@prisma/client';
import type { LivePublicLinkCounts } from '../domain/live-public-links';

type Tx = Prisma.TransactionClient;

interface Scope {
  tenantId: string;
  patientId: string;
  now: Date;
}

/**
 * DX-461: qué es un enlace público «vivo» del paciente, en UN sitio para que
 * contar (el aviso del diálogo) y anular (archivar) digan lo mismo. Cada
 * filtro lo sirve un índice que empieza por (tenantId, patientId).
 */
function liveSlotOffers({
  tenantId,
  patientId,
  now,
}: Scope): Prisma.WaitlistOfferWhereInput {
  // Solo las ofertas con enlace (DX-435); las de teléfono no tienen token.
  return {
    tenantId,
    patientId,
    outcome: 'PENDING',
    tokenHash: { not: null },
    expiresAt: { gt: now },
  };
}

function liveSignatures(
  { tenantId, patientId, now }: Scope,
  type: SignatureRequestType,
): Prisma.SignatureRequestWhereInput {
  // Bloqueada (5 códigos fallidos) ya no sirve: no cuenta como viva.
  return {
    tenantId,
    patientId,
    type,
    signedAt: null,
    revokedAt: null,
    lockedAt: null,
    expiresAt: { gt: now },
  };
}

function liveSignedPdfCopies({
  tenantId,
  patientId,
  now,
}: Scope): Prisma.SignedConsentPdfLinkWhereInput {
  return {
    tenantId,
    patientId,
    usedAt: null,
    revokedAt: null,
    expiresAt: { gt: now },
  };
}

function liveAnamnesis({
  tenantId,
  patientId,
  now,
}: Scope): Prisma.MedicalHistorySubmissionWhereInput {
  return {
    tenantId,
    patientId,
    status: 'PENDING_PATIENT',
    revokedAt: null,
    expiresAt: { gt: now },
  };
}

/** Enlaces vivos del paciente por tipo (todas las sedes). */
export async function countLivePublicLinks(
  tx: Tx,
  scope: Scope,
): Promise<LivePublicLinkCounts> {
  const [
    slotOffers,
    consentSignatures,
    budgetSignatures,
    signedPdfCopies,
    anamnesis,
  ] = await Promise.all([
    tx.waitlistOffer.count({ where: liveSlotOffers(scope) }),
    tx.signatureRequest.count({ where: liveSignatures(scope, 'CONSENT') }),
    tx.signatureRequest.count({ where: liveSignatures(scope, 'BUDGET') }),
    tx.signedConsentPdfLink.count({ where: liveSignedPdfCopies(scope) }),
    tx.medicalHistorySubmission.count({ where: liveAnamnesis(scope) }),
  ]);
  return {
    slotOffers,
    consentSignatures,
    budgetSignatures,
    signedPdfCopies,
    anamnesis,
  };
}

/**
 * Anula los enlaces vivos del paciente dentro de `tx` (la de archivar) y
 * devuelve cuántos de cada tipo. Cada anulación es la misma que ya usa su
 * módulo: la oferta pasa a EXPIRED, la solicitud de firma queda anulada por
 * quien archiva (sin código ni sesión vigentes), la copia del PDF invalidada
 * y la anamnesis EXPIRED. Ninguna vuelve atrás: desarchivar no las reactiva.
 */
export async function revokeLivePublicLinks(
  tx: Tx,
  scope: Scope & { actorId: string },
): Promise<LivePublicLinkCounts> {
  const { now, actorId } = scope;
  const slotOffers = await tx.waitlistOffer.updateMany({
    where: liveSlotOffers(scope),
    data: { outcome: 'EXPIRED', outcomeAt: now, outcomeById: actorId },
  });
  const revokedSignature = {
    revokedAt: now,
    revokedById: actorId,
    codeHash: null,
    codeExpiresAt: null,
    sessionHash: null,
    sessionExpiresAt: null,
  };
  const consentSignatures = await tx.signatureRequest.updateMany({
    where: liveSignatures(scope, 'CONSENT'),
    data: revokedSignature,
  });
  const budgetSignatures = await tx.signatureRequest.updateMany({
    where: liveSignatures(scope, 'BUDGET'),
    data: revokedSignature,
  });
  const signedPdfCopies = await tx.signedConsentPdfLink.updateMany({
    where: liveSignedPdfCopies(scope),
    data: { revokedAt: now },
  });
  const anamnesis = await tx.medicalHistorySubmission.updateMany({
    where: liveAnamnesis(scope),
    data: { status: 'EXPIRED', revokedAt: now },
  });
  return {
    slotOffers: slotOffers.count,
    consentSignatures: consentSignatures.count,
    budgetSignatures: budgetSignatures.count,
    signedPdfCopies: signedPdfCopies.count,
    anamnesis: anamnesis.count,
  };
}
