import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { ReportSeeder } from './reports-fixtures';

/**
 * DX-424: siembra de enlaces del paciente (firma, anamnesis, confirmación de
 * cita e indicaciones) como owner (`raw`, DIRECT_URL) con los triggers
 * apagados (session_replication_role = replica), para poder fijar en el
 * pasado las horas de envío, apertura y firma que los triggers ponen con la
 * hora del servidor. Cada enlace lleva su propio paciente (un solo enlace
 * vivo por paciente y documento). Sin teléfonos ni emails reales.
 */
const HOUR = 60 * 60 * 1000;
export const hex64 = () =>
  createHash('sha256').update(randomUUID()).digest('hex');

/** Lo que la siembra necesita de una clínica. */
export interface LinkClinic {
  tenantId: string;
  userId: string;
  seed: ReportSeeder;
  templateId: string;
  postOpTemplateId: string;
}

/** Las plantillas (consentimiento e indicaciones) de una clínica. */
export async function linkTemplates(
  raw: PrismaClient,
  tenantId: string,
): Promise<{ templateId: string; postOpTemplateId: string }> {
  const template = await raw.consentTemplate.create({
    data: { tenantId, title: 'Exodoncia', body: 'Texto' },
    select: { id: true },
  });
  const postOp = await raw.postOpInstructionTemplate.create({
    data: {
      tenantId,
      code: 'POI-EXO',
      title: 'Exodoncia simple',
      body: 'No enjuagar en 24 h',
    },
    select: { id: true },
  });
  return { templateId: template.id, postOpTemplateId: postOp.id };
}

export function patientLinkSeeding(raw: PrismaClient) {
  /** Siembra como owner con los triggers apagados (horas del pasado). */
  function seedWithoutTriggers(
    fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<unknown> {
    return raw.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          'SET LOCAL session_replication_role = replica',
        );
        return fn(tx);
      },
      { timeout: 120_000 },
    );
  }

  /** Un enlace de firma (cada uno con su paciente: un solo enlace vivo). */
  async function signature(
    c: LinkClinic,
    input: {
      locationId: string;
      type?: 'CONSENT' | 'BUDGET';
      createdAt: Date;
      expiresAt: Date;
      openedAt?: Date;
      signedAt?: Date;
      revokedAt?: Date;
    },
  ): Promise<void> {
    const patientId = await c.seed.patient(`firma-${randomUUID()}`);
    const type = input.type ?? 'CONSENT';
    const budget =
      type === 'BUDGET'
        ? {
            treatmentPlanId: await c.seed.plan({
              patientId,
              currency: 'USD',
              price: 120,
            }),
            budgetContent: { total: '120.00', currency: 'USD' },
            budgetContentHash: hex64(),
          }
        : {};
    await seedWithoutTriggers((tx) =>
      tx.signatureRequest.create({
        data: {
          tenantId: c.tenantId,
          locationId: input.locationId,
          patientId,
          type,
          channel: 'EMAIL',
          ...(type === 'CONSENT'
            ? { templateId: c.templateId, templateVersion: 1 }
            : {}),
          ...budget,
          title: 'Documento',
          body: 'Texto del documento',
          professionalUserId: c.userId,
          professionalName: 'Dra. Reportes',
          signerType: 'PATIENT',
          signerName: 'Paciente',
          destination: 'paciente@example.com',
          destinationMasked: 'pa***@example.com',
          tokenHash: hex64(),
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
          openedAt: input.openedAt ?? input.signedAt ?? null,
          verifiedAt: input.signedAt ?? null,
          signedAt: input.signedAt ?? null,
          revokedAt: input.revokedAt ?? null,
          revokedById: input.revokedAt ? c.userId : null,
          createdById: c.userId,
        },
      }),
    );
  }

  async function anamnesis(
    c: LinkClinic,
    input: {
      locationId: string;
      createdAt: Date;
      expiresAt: Date;
      openedAt?: Date;
      submittedAt?: Date;
      revokedAt?: Date;
      /** Para abrirlo por HTTP: el hash de un token conocido. */
      tokenHash?: string;
    },
  ): Promise<void> {
    const patientId = await c.seed.patient(`anamnesis-${randomUUID()}`);
    await seedWithoutTriggers((tx) =>
      tx.medicalHistorySubmission.create({
        data: {
          tenantId: c.tenantId,
          patientId,
          locationId: input.locationId,
          tokenHash: input.tokenHash ?? hex64(),
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
          openedAt: input.openedAt ?? null,
          status: input.submittedAt
            ? 'SUBMITTED'
            : input.revokedAt
              ? 'EXPIRED'
              : 'PENDING_PATIENT',
          answers: input.submittedAt ? {} : Prisma.DbNull,
          submittedAt: input.submittedAt ?? null,
          revokedAt: input.revokedAt ?? null,
          questionnaireVersion: '2026-10',
          createdById: c.userId,
        },
      }),
    );
  }

  let appointmentHour = 0;
  async function appointment(c: LinkClinic, locationId: string) {
    const patientId = await c.seed.patient(`cita-${randomUUID()}`);
    const start = new Date(Date.UTC(2026, 9, 1, 12) + appointmentHour++ * HOUR);
    return raw.appointment.create({
      data: {
        tenantId: c.tenantId,
        locationId,
        patientId,
        providerId: c.userId,
        start,
        end: new Date(start.getTime() + HOUR / 2),
      },
      select: { id: true, patientId: true, start: true },
    });
  }

  async function confirmation(
    c: LinkClinic,
    input: { locationId: string; createdAt: Date; respondedAt?: Date },
  ): Promise<void> {
    const a = await appointment(c, input.locationId);
    await seedWithoutTriggers((tx) =>
      tx.appointmentConfirmation.create({
        data: {
          tenantId: c.tenantId,
          appointmentId: a.id,
          tokenHash: hex64(),
          createdAt: input.createdAt,
          expiresAt: a.start,
          appointmentStart: a.start,
          appointmentStatus: 'SCHEDULED',
          respondedAt: input.respondedAt ?? null,
          response: input.respondedAt ? 'CONFIRM' : null,
        },
      }),
    );
  }

  async function postOp(
    c: LinkClinic,
    input: {
      locationId: string;
      deliveredAt: Date;
      channel: 'PRINT' | 'EMAIL' | 'WHATSAPP_LINK';
      tokenExpiresAt?: Date;
      firstOpenedAt?: Date;
    },
  ): Promise<void> {
    const a = await appointment(c, input.locationId);
    const link = input.channel !== 'PRINT';
    await seedWithoutTriggers((tx) =>
      tx.postOpInstructionDelivery.create({
        data: {
          tenantId: c.tenantId,
          patientId: a.patientId,
          appointmentId: a.id,
          locationId: input.locationId,
          templateId: c.postOpTemplateId,
          templateCode: 'POI-EXO',
          templateTitle: 'Exodoncia simple',
          templateVersion: 1,
          channel: input.channel,
          renderedText: 'No enjuagar en 24 h',
          deliveredById: c.userId,
          deliveredByName: 'Dra. Reportes',
          deliveredAt: input.deliveredAt,
          createdAt: input.deliveredAt,
          tokenHash: link ? hex64() : null,
          tokenExpiresAt: link ? (input.tokenExpiresAt ?? null) : null,
          firstOpenedAt: input.firstOpenedAt ?? null,
        },
      }),
    );
  }

  return {
    seedWithoutTriggers,
    signature,
    anamnesis,
    appointment,
    confirmation,
    postOp,
  };
}
