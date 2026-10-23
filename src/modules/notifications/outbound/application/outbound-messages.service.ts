import { Injectable, Logger } from '@nestjs/common';
import type {
  OutboundChannel,
  OutboundMessageStatus,
  OutboundRecipientKind,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { describeJobError } from '../../../jobs/domain/backoff';
import { maskRecipient } from '../domain/mask-recipient';

export interface RecordOutboundMessage {
  channel: OutboundChannel;
  /** Código de plantilla (`appointment-reminder`…), no su texto. */
  template: string;
  /** Dirección o número REAL: solo se usa para enmascararlo; no se guarda. */
  recipient: string;
  /** DX-203: al paciente (por defecto) o a su responsable. */
  recipientKind?: OutboundRecipientKind;
  appointmentId?: string;
}

/** Asociación de negocio confirmada en la misma transacción que el mensaje. */
export type AttachOutboundMessage = (
  id: string,
  tx: Prisma.TransactionClient,
) => Promise<void>;

export type OutboundOutcome =
  | { status: 'QUEUED' | 'SENT' | 'CANCELLED' }
  | { status: 'FAILED'; error: unknown };

/**
 * Registro de mensajes salientes al paciente (DX-085), por clínica y bajo
 * RLS: siempre con el tenant del contexto (`runWithTenant(fn)`), que en un
 * trabajo de la cola fija el worker. Guarda y registra en el log SOLO el
 * destinatario enmascarado y, de un fallo, el tipo y el código del error.
 *
 * Para EMAIL el transporte es email_outbox (DX-088): quien envía encola allí
 * con `referenceId` = id de este registro y lo marca QUEUED.
 */
@Injectable()
export class OutboundMessages {
  private readonly logger = new Logger('Outbound');

  constructor(private readonly prisma: PrismaService) {}

  async record(
    input: RecordOutboundMessage,
    attach?: AttachOutboundMessage,
  ): Promise<{ id: string }> {
    const recipientMasked = maskRecipient(input.channel, input.recipient);
    const { id, tenantId } = await this.prisma.runWithTenant(async (tx) => {
      const [recorded] = await tx.$queryRaw<{ id: string; tenantId: string }[]>`
        INSERT INTO "outbound_messages"
          ("id", "tenantId", "channel", "template", "recipientMasked",
           "recipientKind", "appointmentId", "updatedAt")
        VALUES
          (gen_random_uuid(), current_setting('app.current_tenant', true)::uuid,
           ${input.channel}::"OutboundChannel", ${input.template},
           ${recipientMasked},
           ${input.recipientKind ?? 'PATIENT'}::"OutboundRecipientKind",
           ${input.appointmentId ?? null}::uuid,
           CURRENT_TIMESTAMP)
        RETURNING "id", "tenantId"`;
      // Fallar la asociación revierte también el INSERT, en cada intento.
      await attach?.(recorded.id, tx);
      return recorded;
    });
    this.logger.log({
      event: 'outbound.recorded',
      outboundId: id,
      tenantId,
      channel: input.channel,
      template: input.template,
      to: recipientMasked,
      recipientKind: input.recipientKind ?? 'PATIENT',
      appointmentId: input.appointmentId ?? null,
    });
    return { id };
  }

  /**
   * Cambia el estado; false si el mensaje no existe en esta clínica o ya está
   * en un estado final (SENT, FAILED, CANCELLED): solo se sale de PENDING y
   * de QUEUED, y a QUEUED solo desde PENDING (revisión H9).
   */
  async settle(id: string, outcome: OutboundOutcome): Promise<boolean> {
    const from: OutboundMessageStatus[] =
      outcome.status === 'QUEUED' ? ['PENDING'] : ['PENDING', 'QUEUED'];
    const finished = outcome.status === 'SENT' || outcome.status === 'FAILED';
    const lastError =
      outcome.status === 'FAILED' ? describeJobError(outcome.error) : null;
    const { count } = await this.prisma.runWithTenant((tx) =>
      tx.outboundMessage.updateMany({
        where: { id, status: { in: from } },
        data: {
          status: outcome.status,
          ...(finished ? { attempts: { increment: 1 } } : {}),
          ...(outcome.status === 'SENT' ? { sentAt: new Date() } : {}),
          ...(lastError ? { lastError } : {}),
        },
      }),
    );
    if (count > 0) {
      this.logger.log({
        event: `outbound.${outcome.status.toLowerCase()}`,
        outboundId: id,
        ...(lastError ? { error: lastError } : {}),
      });
    }
    return count > 0;
  }
}
