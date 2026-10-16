import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuditEventsController } from './presentation/audit-events.controller';
import { AuditInterceptor } from './presentation/audit.interceptor';
import { RecordAuditEventUseCase } from './application/record-audit-event.use-case';
import {
  AUDIT_CLOCK,
  ListAuditEventsUseCase,
} from './application/list-audit-events.use-case';
import { AUDIT_EVENT_REPOSITORY } from './domain/ports/audit-event-repository.port';
import { PrismaAuditEventRepository } from './infrastructure/prisma-audit-event.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { AuditPartitionMaintenance } from './infrastructure/audit-partition-maintenance';
import {
  AUDIT_PARTITION_CONFIG,
  loadAuditPartitionConfig,
} from './infrastructure/audit-retention-config';

/**
 * Registro de auditoría (DX-009). GLOBAL: `@Audit(...)` pone el
 * AuditInterceptor en controladores de muchos módulos, y Nest lo instancia en
 * cada uno; su dependencia (RecordAuditEventUseCase) tiene que poder
 * resolverse desde todos sin que cada módulo importe este.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuditEventsController],
  providers: [
    RecordAuditEventUseCase,
    ListAuditEventsUseCase,
    AuditInterceptor,
    TokenService,
    TenantContextInterceptor,
    { provide: AUDIT_EVENT_REPOSITORY, useClass: PrismaAuditEventRepository },
    { provide: AUDIT_CLOCK, useValue: () => new Date() },
    {
      provide: AUDIT_PARTITION_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        loadAuditPartitionConfig((key) => config.get<string>(key)),
    },
    AuditPartitionMaintenance,
  ],
  exports: [RecordAuditEventUseCase, AuditInterceptor],
})
export class AuditModule {}
