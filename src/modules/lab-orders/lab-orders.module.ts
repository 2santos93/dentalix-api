import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { DocumentTypeNamesModule } from '../document-type-names/document-type-names.module';
import { PatientsModule } from '../patients/patients.module';
import { LabCatalogUseCases } from './application/lab-catalog.use-cases';
import { LabOrderUseCases } from './application/lab-orders.use-cases';
import { LAB_CLOCK, LAB_REPOSITORY } from './domain/ports/lab-repository.port';
import { PrismaLabRepository } from './infrastructure/prisma-lab.repository';
import { DentalLabsController } from './presentation/dental-labs.controller';
import {
  LabOrdersController,
  PatientLabOrdersController,
} from './presentation/lab-orders.controller';

/**
 * Laboratorio dental (DX-017): catálogo de laboratorios de la clínica con sus
 * servicios (plazo en días hábiles) y órdenes de laboratorio (la prescripción
 * escrita del producto a medida): alta desde la ficha o el plan, envío,
 * recepción, revisión, anulación con motivo, lista de la sede con atrasadas e
 * impresión. NO es external-orders (DX-572: imagen, análisis, especialistas).
 */
@Module({
  imports: [JwtModule.register({}), PatientsModule, DocumentTypeNamesModule],
  controllers: [
    DentalLabsController,
    PatientLabOrdersController,
    LabOrdersController,
  ],
  providers: [
    LabCatalogUseCases,
    LabOrderUseCases,
    TokenService,
    TenantContextInterceptor,
    { provide: LAB_CLOCK, useValue: () => new Date() },
    { provide: LAB_REPOSITORY, useClass: PrismaLabRepository },
  ],
})
export class LabOrdersModule {}
