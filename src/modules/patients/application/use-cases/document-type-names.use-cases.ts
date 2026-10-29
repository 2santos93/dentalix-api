import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { DocumentType } from '@prisma/client';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { DOCUMENT_TYPES } from '../../domain/document-type';
import {
  validateDocumentTypeNames,
  type DocumentTypeNames,
} from '../../domain/document-type-names';
import {
  DOCUMENT_TYPE_NAMES_REPOSITORY,
  type DocumentTypeNamesRepository,
} from '../../domain/ports/document-type-names-repository.port';

export interface DocumentTypeNamesSettings {
  names: DocumentTypeNames;
}

@Injectable()
export class GetDocumentTypeNamesUseCase {
  constructor(
    @Inject(DOCUMENT_TYPE_NAMES_REPOSITORY)
    private readonly repo: DocumentTypeNamesRepository,
  ) {}

  async execute(): Promise<DocumentTypeNamesSettings> {
    return { names: await this.repo.get() };
  }
}

/**
 * Sustituye los cinco nombres locales de la clínica (solo ADMIN, lo exige la
 * ruta; DX-327, R16). Una clave ausente es null. Si el conjunto es ambiguo,
 * 400 sin guardar nada. Si de verdad cambió algún nombre, lo audita con los
 * tipos cambiados, nunca con los valores (son texto libre). Cambiar un nombre
 * no toca ningún paciente.
 */
@Injectable()
export class UpdateDocumentTypeNamesUseCase {
  constructor(
    @Inject(DOCUMENT_TYPE_NAMES_REPOSITORY)
    private readonly repo: DocumentTypeNamesRepository,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  async execute(
    input: Readonly<Partial<Record<DocumentType, string | null>>>,
    ctx: AuditRequestContext,
  ): Promise<DocumentTypeNamesSettings> {
    const valid = validateDocumentTypeNames(input);
    if (!valid.ok) throw new BadRequestException(valid.message);
    const { before, after } = await this.repo.set(valid.names);
    const changedFields = DOCUMENT_TYPES.filter(
      (type) => before[type] !== after[type],
    );
    // Como la mayoría de edad: el evento va tras confirmar el cambio y
    // `record` nunca lanza (DX-009).
    if (changedFields.length > 0) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        actor: {
          kind: 'user',
          userId: ctx.actor.userId,
          role: ctx.actor.role,
        },
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: null,
        patient: null,
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: {
          reason: 'DOCUMENT_TYPE_NAMES_SETTINGS',
          changedFields,
        },
      });
    }
    return { names: after };
  }
}
