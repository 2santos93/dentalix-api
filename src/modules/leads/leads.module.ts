import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { JobsModule } from '../jobs/jobs.module';
import { LeadRetention } from './application/lead-retention';
import { LeadsUseCases } from './application/leads.use-cases';
import {
  LEAD_REPOSITORY,
  LEAD_RETENTION_REPOSITORY,
} from './domain/lead-repository.port';
import { PrismaLeadRetentionRepository } from './infrastructure/prisma-lead-retention.repository';
import { PrismaLeadRepository } from './infrastructure/prisma-lead.repository';
import { LeadReasonsController } from './presentation/lead-reasons.controller';
import { LeadsController } from './presentation/leads.controller';

/**
 * Prospectos (DX-556): la bandeja de interesados antes de ser paciente, el
 * catálogo de motivos, el informe de conversión y la retención de los
 * perdidos. La cita mueve al prospecto desde la transacción de la cita
 * (`infrastructure/lead-from-appointment.ts`, que importa el repositorio de
 * citas); este módulo no importa el de citas. «Mi día» y «¿Quién llama?»
 * usan los casos de uso exportados.
 */
@Module({
  imports: [JwtModule.register({}), JobsModule],
  controllers: [LeadsController, LeadReasonsController],
  providers: [
    LeadsUseCases,
    LeadRetention,
    TokenService,
    TenantContextInterceptor,
    { provide: LEAD_REPOSITORY, useClass: PrismaLeadRepository },
    {
      provide: LEAD_RETENTION_REPOSITORY,
      useClass: PrismaLeadRetentionRepository,
    },
  ],
  exports: [LeadsUseCases, LEAD_REPOSITORY],
})
export class LeadsModule {}
