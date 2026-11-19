import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { EmailModule } from '../notifications/email/email.module';
import {
  ListMessageTemplatesUseCase,
  MessageTemplateReader,
  PreviewMessageTemplateUseCase,
  ResetMessageTemplateUseCase,
  SaveMessageTemplateUseCase,
  SendMessageTemplateTestUseCase,
} from './application/message-templates.use-cases';
import { MESSAGE_TEMPLATE_REPOSITORY } from './domain/ports/message-template-repository.port';
import { PrismaMessageTemplateRepository } from './infrastructure/prisma-message-template.repository';
import { MessageTemplatesController } from './presentation/message-templates.controller';

// Ajustes › Mensajes (DX-565): los textos de los mensajes al paciente que la
// clínica reescribe. El email los lee el outbox al encolar (su repositorio);
// los de WhatsApp, quien crea el enlace (MessageTemplateReader).
@Module({
  imports: [JwtModule.register({}), EmailModule],
  controllers: [MessageTemplatesController],
  providers: [
    ListMessageTemplatesUseCase,
    SaveMessageTemplateUseCase,
    ResetMessageTemplateUseCase,
    PreviewMessageTemplateUseCase,
    SendMessageTemplateTestUseCase,
    MessageTemplateReader,
    TokenService,
    TenantContextInterceptor,
    {
      provide: MESSAGE_TEMPLATE_REPOSITORY,
      useClass: PrismaMessageTemplateRepository,
    },
  ],
  exports: [MessageTemplateReader],
})
export class MessageTemplatesModule {}
