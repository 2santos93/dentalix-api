import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { DOCUMENT_TYPES } from '../../domain/document-type';
import {
  DOC_TYPE_NAME_FIELD,
  type DocTypeNameField,
  type DocumentTypeNames,
} from '../../domain/document-type-names';
import type { DocumentTypeNamesRepository } from '../../domain/ports/document-type-names-repository.port';

type NameColumns = Record<DocTypeNameField, string | null>;

const SELECT = {
  docTypeNameNationalId: true,
  docTypeNamePassport: true,
  docTypeNameResidencePermit: true,
  docTypeNameTaxId: true,
  docTypeNameOther: true,
} as const satisfies Record<DocTypeNameField, true>;

function fromColumns(row: NameColumns): DocumentTypeNames {
  const names = {} as DocumentTypeNames;
  for (const type of DOCUMENT_TYPES) {
    names[type] = Object.hasOwn(DOC_TYPE_NAME_FIELD, type)
      ? row[DOC_TYPE_NAME_FIELD[type]]
      : null;
  }
  return names;
}

/**
 * Los nombres de una clínica leídos con el cliente o la transacción de quien
 * llama: el recibo los congela dentro de la transacción del abono (spec
 * §4.6), sin otro constructor para el repositorio de pagos.
 */
export async function readDocumentTypeNames(
  db: Prisma.TransactionClient,
  tenantId: string,
): Promise<DocumentTypeNames> {
  return fromColumns(
    await db.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: SELECT,
    }),
  );
}

function toColumns(names: DocumentTypeNames): NameColumns {
  const row = {} as NameColumns;
  for (const type of DOCUMENT_TYPES) {
    if (Object.hasOwn(DOC_TYPE_NAME_FIELD, type)) {
      row[DOC_TYPE_NAME_FIELD[type]] = names[type];
    }
  }
  return row;
}

@Injectable()
export class PrismaDocumentTypeNamesRepository implements DocumentTypeNamesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async get(): Promise<DocumentTypeNames> {
    // `tenants` es global (sin RLS): siempre por el id del contexto, sin
    // runWithTenant, como `getMajorityAge`.
    return readDocumentTypeNames(this.prisma, this.tenantId());
  }

  async set(
    names: DocumentTypeNames,
  ): Promise<{ before: DocumentTypeNames; after: DocumentTypeNames }> {
    const id = this.tenantId();
    // Lectura con la fila bloqueada y escritura en la misma transacción.
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "tenants" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const before = await tx.tenant.findUniqueOrThrow({
        where: { id },
        select: SELECT,
      });
      const after = await tx.tenant.update({
        where: { id },
        data: toColumns(names),
        select: SELECT,
      });
      return { before: fromColumns(before), after: fromColumns(after) };
    });
  }
}
