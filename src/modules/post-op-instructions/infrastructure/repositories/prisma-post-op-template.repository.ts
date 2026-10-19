import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { CatalogKind, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  CreatePostOpTemplateRepoInput,
  POSTOP_APPOINTMENT_TYPE_INVALID_MESSAGE,
  POSTOP_CATALOG_ITEM_INVALID_MESSAGE,
  POSTOP_TEMPLATE_DUPLICATE_CODE_MESSAGE,
  PostOpTemplateLinksInput,
  PostOpTemplateRepository,
  PostOpTemplateView,
  UpdatePostOpTemplateRepoInput,
} from '../../domain/ports/post-op-template-repository.port';

const WITH_LINKS = {
  links: {
    orderBy: { createdAt: 'asc' },
    include: { appointmentType: { select: { id: true, name: true } } },
  },
} satisfies Prisma.PostOpInstructionTemplateInclude;

type PrismaTemplate = Prisma.PostOpInstructionTemplateGetPayload<{
  include: typeof WITH_LINKS;
}>;

type CatalogLabel = { id: string; code: string; labelEs: string };

/**
 * El único UNIQUE que una escritura de plantillas puede violar es
 * (tenantId, code): los ids de los vínculos llegan ya sin repetir. Se traduce
 * aquí porque, bajo RLS, Prisma no informa `meta.target`.
 */
function rethrowDuplicateCode(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw new ConflictException(POSTOP_TEMPLATE_DUPLICATE_CODE_MESSAGE);
  }
  throw error;
}

function toView(
  row: PrismaTemplate,
  catalog: Map<string, CatalogLabel>,
): PostOpTemplateView {
  const catalogItems = row.links
    .map((link) =>
      link.catalogItemId ? catalog.get(link.catalogItemId) : null,
    )
    .filter((item): item is CatalogLabel => !!item)
    .sort((a, b) => a.labelEs.localeCompare(b.labelEs));
  const appointmentTypes = row.links
    .map((link) => link.appointmentType)
    .filter((type): type is { id: string; name: string } => !!type)
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    title: row.title,
    body: row.body,
    version: row.version,
    active: row.active,
    createdById: row.createdById,
    updatedById: row.updatedById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    links: row.links.map((link) => ({
      id: link.id,
      tenantId: link.tenantId,
      templateId: link.templateId,
      catalogItemId: link.catalogItemId,
      appointmentTypeId: link.appointmentTypeId,
      createdAt: link.createdAt,
    })),
    catalogItems,
    appointmentTypes,
  };
}

@Injectable()
export class PrismaPostOpTemplateRepository implements PostOpTemplateRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** El INSERT necesita el tenant explícito (sin default desde la GUC). */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  /**
   * Resuelve código y nombre de los procedimientos vinculados en UNA consulta.
   * Sin filtrar `deletedAt`: un procedimiento retirado sigue saliendo para que
   * ADMIN vea el vínculo y pueda quitarlo.
   */
  private async toViews(
    tx: Prisma.TransactionClient,
    rows: PrismaTemplate[],
  ): Promise<PostOpTemplateView[]> {
    const ids = [
      ...new Set(
        rows.flatMap((row) =>
          row.links.flatMap((link) =>
            link.catalogItemId ? [link.catalogItemId] : [],
          ),
        ),
      ),
    ];
    const items =
      ids.length === 0
        ? []
        : await tx.dentalCatalogItem.findMany({
            where: { id: { in: ids } },
            select: { id: true, code: true, labelEs: true },
          });
    const catalog = new Map(items.map((item) => [item.id, item]));
    return rows.map((row) => toView(row, catalog));
  }

  /**
   * Cada procedimiento debe ser un PROCEDURE vigente del catálogo de esta
   * clínica y cada tipo de cita uno vigente de esta clínica. Bajo RLS un id de
   * otra clínica no se ve, así que cuenta como inexistente.
   */
  private async assertLinkTargets(
    tx: Prisma.TransactionClient,
    tenantId: string,
    links: Partial<PostOpTemplateLinksInput>,
  ): Promise<void> {
    const catalogIds = links.catalogItemIds ?? [];
    if (catalogIds.length > 0) {
      const found = await tx.dentalCatalogItem.count({
        where: {
          tenantId,
          id: { in: catalogIds },
          kind: CatalogKind.PROCEDURE,
          deletedAt: null,
        },
      });
      if (found !== catalogIds.length) {
        throw new BadRequestException(POSTOP_CATALOG_ITEM_INVALID_MESSAGE);
      }
    }
    const typeIds = links.appointmentTypeIds ?? [];
    if (typeIds.length > 0) {
      const found = await tx.appointmentType.count({
        where: { tenantId, id: { in: typeIds }, deletedAt: null },
      });
      if (found !== typeIds.length) {
        throw new BadRequestException(POSTOP_APPOINTMENT_TYPE_INVALID_MESSAGE);
      }
    }
  }

  private async insertLinks(
    tx: Prisma.TransactionClient,
    tenantId: string,
    templateId: string,
    links: Partial<PostOpTemplateLinksInput>,
  ): Promise<void> {
    const data = [
      ...(links.catalogItemIds ?? []).map((catalogItemId) => ({
        tenantId,
        templateId,
        catalogItemId,
      })),
      ...(links.appointmentTypeIds ?? []).map((appointmentTypeId) => ({
        tenantId,
        templateId,
        appointmentTypeId,
      })),
    ];
    if (data.length > 0) {
      await tx.postOpInstructionTemplateLink.createMany({ data });
    }
  }

  private async insertOne(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: CreatePostOpTemplateRepoInput,
  ): Promise<PrismaTemplate> {
    await this.assertLinkTargets(tx, tenantId, input.links);
    const created = await tx.postOpInstructionTemplate.create({
      data: {
        tenantId,
        code: input.code,
        title: input.title,
        body: input.body,
        active: input.active,
        createdById: input.createdById,
        updatedById: input.createdById,
      },
    });
    await this.insertLinks(tx, tenantId, created.id, input.links);
    return tx.postOpInstructionTemplate.findUniqueOrThrow({
      where: { id: created.id },
      include: WITH_LINKS,
    });
  }

  list(params?: { active?: boolean }): Promise<PostOpTemplateView[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.postOpInstructionTemplate.findMany({
        where: params?.active === undefined ? {} : { active: params.active },
        orderBy: [{ title: 'asc' }, { code: 'asc' }],
        include: WITH_LINKS,
      });
      return this.toViews(tx, rows);
    });
  }

  findById(id: string): Promise<PostOpTemplateView | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.postOpInstructionTemplate.findFirst({
        where: { id },
        include: WITH_LINKS,
      });
      return row ? (await this.toViews(tx, [row]))[0] : null;
    });
  }

  create(input: CreatePostOpTemplateRepoInput): Promise<PostOpTemplateView> {
    const tenantId = this.requireTenantId();
    return this.prisma
      .runWithTenant(async (tx) => {
        const row = await this.insertOne(tx, tenantId, input);
        return (await this.toViews(tx, [row]))[0];
      })
      .catch(rethrowDuplicateCode);
  }

  createMany(
    inputs: CreatePostOpTemplateRepoInput[],
  ): Promise<PostOpTemplateView[]> {
    const tenantId = this.requireTenantId();
    return this.prisma
      .runWithTenant(async (tx) => {
        const rows: PrismaTemplate[] = [];
        for (const input of inputs) {
          rows.push(await this.insertOne(tx, tenantId, input));
        }
        return this.toViews(tx, rows);
      })
      .catch(rethrowDuplicateCode);
  }

  /**
   * Por `id` bajo RLS; el use-case ya comprobó que existe en la clínica. Los
   * vínculos de cada tipo que llega se borran y se vuelven a crear en la MISMA
   * transacción: son configuración, nada los referencia (la entrega guarda su
   * propia copia del texto).
   */
  update(
    id: string,
    input: UpdatePostOpTemplateRepoInput,
  ): Promise<PostOpTemplateView> {
    const tenantId = this.requireTenantId();
    return this.prisma
      .runWithTenant(async (tx) => {
        await tx.postOpInstructionTemplate.update({
          where: { id },
          data: {
            title: input.title,
            body: input.body,
            active: input.active,
            updatedById: input.updatedById,
            ...(input.bumpVersion ? { version: { increment: 1 } } : {}),
          },
        });
        if (input.links) {
          await this.assertLinkTargets(tx, tenantId, input.links);
          // Excepción legítima al borrado lógico (HARD_DELETE_ALLOWLIST): los
          // vínculos son configuración, sin datos de pacientes, y nada los
          // referencia; el cambio queda en audit_events.
          if (input.links.catalogItemIds !== undefined) {
            // eslint-disable-next-line no-restricted-syntax
            await tx.postOpInstructionTemplateLink.deleteMany({
              where: { templateId: id, catalogItemId: { not: null } },
            });
          }
          if (input.links.appointmentTypeIds !== undefined) {
            // eslint-disable-next-line no-restricted-syntax
            await tx.postOpInstructionTemplateLink.deleteMany({
              where: { templateId: id, appointmentTypeId: { not: null } },
            });
          }
          await this.insertLinks(tx, tenantId, id, input.links);
        }
        const row = await tx.postOpInstructionTemplate.findUniqueOrThrow({
          where: { id },
          include: WITH_LINKS,
        });
        return (await this.toViews(tx, [row]))[0];
      })
      .catch(rethrowDuplicateCode);
  }
}
