import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { AnesthesiaModule } from '../anesthesia/anesthesia.module';
import { ClinicalEntriesModule } from '../clinical-entries/clinical-entries.module';
import { ConsentsModule } from '../consents/consents.module';
import { DocumentTypeNamesModule } from '../document-type-names/document-type-names.module';
import { OdontogramModule } from '../odontogram/odontogram.module';
import { PrescriptionsModule } from '../prescriptions/prescriptions.module';
import { SedationModule } from '../sedation/sedation.module';
import {
  CLINICAL_RECORD_COPY_CLOCK,
  ClinicalRecordCopiesUseCases,
} from './application/clinical-record-copies.use-cases';
import { CLINICAL_RECORD_COPY_REPOSITORY } from './domain/ports/clinical-record-copy-repository.port';
import { PrismaClinicalRecordCopyRepository } from './infrastructure/prisma-clinical-record-copy.repository';
import { ClinicalRecordCopiesController } from './presentation/clinical-record-copies.controller';

/**
 * DX-456: «Copia de la historia clínica» de un paciente por período y
 * secciones. Lee con los MISMOS casos de uso y repositorios que la ficha
 * (evoluciones, odontograma, anestesia, sedación, consentimientos, recetas):
 * los importa de sus módulos en vez de repetir sus consultas.
 */
@Module({
  imports: [
    JwtModule.register({}),
    DocumentTypeNamesModule,
    ClinicalEntriesModule,
    OdontogramModule,
    AnesthesiaModule,
    SedationModule,
    ConsentsModule,
    PrescriptionsModule,
  ],
  controllers: [ClinicalRecordCopiesController],
  providers: [
    ClinicalRecordCopiesUseCases,
    TokenService,
    TenantContextInterceptor,
    { provide: CLINICAL_RECORD_COPY_CLOCK, useValue: () => new Date() },
    {
      provide: CLINICAL_RECORD_COPY_REPOSITORY,
      useClass: PrismaClinicalRecordCopyRepository,
    },
  ],
})
export class ClinicalRecordCopiesModule {}
