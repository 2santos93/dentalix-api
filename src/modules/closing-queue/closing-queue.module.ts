import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { ClosingQueueUseCases } from './application/closing-queue.use-cases';
import {
  CLOSING_QUEUE_NOW,
  CLOSING_QUEUE_REPOSITORY,
} from './domain/ports/closing-queue-repository.port';
import { PrismaClosingQueueRepository } from './infrastructure/prisma-closing-queue.repository';
import { ClosingQueueController } from './presentation/closing-queue.controller';

// «Pendiente de cerrar» (DX-439): citas pasadas sin desenlace, atendidas sin
// evolución y tratamiento de la cita sin marcar como hecho.
@Module({
  imports: [JwtModule.register({})],
  controllers: [ClosingQueueController],
  providers: [
    ClosingQueueUseCases,
    TokenService,
    TenantContextInterceptor,
    {
      provide: CLOSING_QUEUE_REPOSITORY,
      useClass: PrismaClosingQueueRepository,
    },
    { provide: CLOSING_QUEUE_NOW, useValue: () => new Date() },
  ],
})
export class ClosingQueueModule {}
