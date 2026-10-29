import { Module } from '@nestjs/common';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { TenantContextModule } from '../../shared/tenancy/tenant-context.module';
import {
  DOCUMENT_TYPE_NAMES_REPOSITORY,
  DocumentTypeNamesReader,
} from '../patients/domain/ports/document-type-names-repository.port';
import { PrismaDocumentTypeNamesRepository } from '../patients/infrastructure/repositories/prisma-document-type-names.repository';

/**
 * DX-327 (R16, pre-flight M6): nombres locales de los tipos de documento de
 * la clínica. Módulo hoja: solo Prisma y el contexto de clínica, ningún
 * módulo de negocio, así que quien componga el nombre visible (pacientes,
 * impresos, importación) puede importarlo sin crear un ciclo.
 * `DocumentTypeNamesReader` es para ellos; el repositorio, para el caso de
 * uso de Ajustes.
 */
@Module({
  imports: [PrismaModule, TenantContextModule],
  providers: [
    PrismaDocumentTypeNamesRepository,
    {
      provide: DOCUMENT_TYPE_NAMES_REPOSITORY,
      useExisting: PrismaDocumentTypeNamesRepository,
    },
    {
      provide: DocumentTypeNamesReader,
      useExisting: PrismaDocumentTypeNamesRepository,
    },
  ],
  exports: [DOCUMENT_TYPE_NAMES_REPOSITORY, DocumentTypeNamesReader],
})
export class DocumentTypeNamesModule {}
