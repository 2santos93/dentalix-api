import { Module } from '@nestjs/common';
import { OutboundMessages } from './application/outbound-messages.service';

/**
 * Registro de mensajes salientes al paciente por canal (DX-085). Lo usan los
 * trabajos que avisan al paciente (recordatorios de DX-026) importando este
 * módulo.
 */
@Module({
  providers: [OutboundMessages],
  exports: [OutboundMessages],
})
export class OutboundMessagesModule {}
