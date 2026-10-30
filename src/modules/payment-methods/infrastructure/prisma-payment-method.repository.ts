import { ConflictException, Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { ClinicPaymentMethodEntity } from '../domain/payment-method.entity';
import type {
  PaymentMethodRepository,
  PaymentMethodWriteInput,
} from '../domain/ports/payment-method-repository.port';
import {
  DUPLICATE_PAYMENT_METHOD_NAME_MESSAGE,
  INITIAL_PAYMENT_METHODS,
} from '../domain/payment-method-rules';

type PrismaPaymentMethod = Prisma.ClinicPaymentMethodGetPayload<
  Record<string, never>
>;

function mapToEntity(row: PrismaPaymentMethod): ClinicPaymentMethodEntity {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    kind: row.kind,
    active: row.active,
    requiresReference: row.requiresReference,
    legacyMethod: row.legacyMethod,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Dos altas a la vez con el mismo nombre: el único (tenantId, name) decide. */
function rethrowDuplicateName(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw new ConflictException(DUPLICATE_PAYMENT_METHOD_NAME_MESSAGE);
  }
  throw error;
}

/**
 * Los 4 medios iniciales de una clínica recién creada (DX-377), en la
 * transacción del alta y con el GUC de tenant ya fijado (RLS WITH CHECK).
 */
export async function seedInitialPaymentMethods(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  await tx.clinicPaymentMethod.createMany({
    data: INITIAL_PAYMENT_METHODS.map((m) => ({ ...m, tenantId })),
    skipDuplicates: true,
  });
}

@Injectable()
export class PrismaPaymentMethodRepository implements PaymentMethodRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  list(params: {
    includeInactive: boolean;
  }): Promise<ClinicPaymentMethodEntity[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.clinicPaymentMethod.findMany({
        where: params.includeInactive ? {} : { active: true },
        orderBy: { name: 'asc' },
      });
      return rows.map(mapToEntity);
    });
  }

  findById(id: string): Promise<ClinicPaymentMethodEntity | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.clinicPaymentMethod.findFirst({ where: { id } });
      return row ? mapToEntity(row) : null;
    });
  }

  findByLegacyMethod(
    method: PaymentMethod,
  ): Promise<ClinicPaymentMethodEntity | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.clinicPaymentMethod.findFirst({
        where: { legacyMethod: method },
      });
      return row ? mapToEntity(row) : null;
    });
  }

  nameTaken(name: string, exceptId?: string): Promise<boolean> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.clinicPaymentMethod.findFirst({
        where: {
          name: { equals: name, mode: 'insensitive' },
          ...(exceptId ? { NOT: { id: exceptId } } : {}),
        },
        select: { id: true },
      });
      return row !== null;
    });
  }

  async create(
    input: Required<PaymentMethodWriteInput>,
    userId: string,
  ): Promise<ClinicPaymentMethodEntity> {
    const tenantId = this.requireTenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) =>
        mapToEntity(
          await tx.clinicPaymentMethod.create({
            data: {
              ...input,
              tenantId,
              createdById: userId,
              updatedById: userId,
            },
          }),
        ),
      );
    } catch (error) {
      rethrowDuplicateName(error);
    }
  }

  async update(
    id: string,
    input: PaymentMethodWriteInput,
    userId: string,
  ): Promise<ClinicPaymentMethodEntity | null> {
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        const result = await tx.clinicPaymentMethod.updateMany({
          where: { id },
          data: { ...input, updatedById: userId },
        });
        if (result.count === 0) return null;
        const row = await tx.clinicPaymentMethod.findFirst({ where: { id } });
        return row ? mapToEntity(row) : null;
      });
    } catch (error) {
      rethrowDuplicateName(error);
    }
  }
}
