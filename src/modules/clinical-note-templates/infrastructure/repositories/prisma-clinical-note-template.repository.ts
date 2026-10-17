import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { ClinicalNoteTemplate } from '../../domain/entities/clinical-note-template.entity';
import type {
  ClinicalNoteTemplateRepository,
  CreateNoteTemplateRepoInput,
  UpdateNoteTemplateRepoInput,
} from '../../domain/ports/clinical-note-template-repository.port';
import type { NoteTemplateDraft } from '../../domain/note-template-rules';
import { DUPLICATE_NOTE_TEMPLATE_MESSAGE } from '../../application/note-template-errors';

const WITH_PROMPTS = {
  prompts: { orderBy: { position: 'asc' } },
} as const satisfies Prisma.ClinicalNoteTemplateInclude;

type PrismaTemplate = Prisma.ClinicalNoteTemplateGetPayload<{
  include: typeof WITH_PROMPTS;
}>;

function mapToEntity(row: PrismaTemplate): ClinicalNoteTemplate {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    category: row.category,
    body: row.body,
    active: row.active,
    prompts: row.prompts.map((p) => ({
      id: p.id,
      label: p.label,
      type: p.type,
      options: p.options,
      defaultValue: p.defaultValue,
      position: p.position,
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * El único UNIQUE que una escritura puede violar es (tenantId, name). Se
 * traduce aquí porque, bajo RLS, Prisma no informa `meta.target`.
 */
function rethrowDuplicateName(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw new ConflictException(DUPLICATE_NOTE_TEMPLATE_MESSAGE);
  }
  throw error;
}

@Injectable()
export class PrismaClinicalNoteTemplateRepository implements ClinicalNoteTemplateRepository {
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

  /** Filas de las preguntas en su orden (posición = índice). */
  private promptRows(prompts: NoteTemplateDraft['prompts']) {
    return prompts.map((p, position) => ({
      label: p.label,
      type: p.type,
      options: p.options,
      defaultValue: p.defaultValue,
      position,
    }));
  }

  list(params: { includeInactive: boolean }): Promise<ClinicalNoteTemplate[]> {
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.clinicalNoteTemplate.findMany({
        where: params.includeInactive ? {} : { active: true },
        // Las plantillas sin carpeta van al final del selector.
        orderBy: [
          { category: { sort: 'asc', nulls: 'last' } },
          { name: 'asc' },
        ],
        include: WITH_PROMPTS,
      });
      return rows.map(mapToEntity);
    });
  }

  findById(id: string): Promise<ClinicalNoteTemplate | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.clinicalNoteTemplate.findFirst({
        where: { id },
        include: WITH_PROMPTS,
      });
      return row ? mapToEntity(row) : null;
    });
  }

  async createMany(
    inputs: CreateNoteTemplateRepoInput[],
  ): Promise<ClinicalNoteTemplate[]> {
    const tenantId = this.requireTenantId();
    const rows = await this.prisma
      .runWithTenant(async (tx) => {
        const created: PrismaTemplate[] = [];
        for (const input of inputs) {
          created.push(
            await tx.clinicalNoteTemplate.create({
              data: {
                tenantId,
                name: input.name,
                category: input.category,
                body: input.body,
                active: input.active,
                createdById: input.createdById,
                updatedById: input.createdById,
                // Anidada: tenantId y templateId salen de la plantilla (FK
                // compuesta), nunca del cliente.
                prompts: {
                  createMany: { data: this.promptRows(input.prompts) },
                },
              },
              include: WITH_PROMPTS,
            }),
          );
        }
        return created;
      })
      .catch(rethrowDuplicateName);
    return rows.map(mapToEntity);
  }

  /** Por `id` bajo RLS; el use-case ya comprobó que existe en la clínica. */
  async update(
    id: string,
    input: UpdateNoteTemplateRepoInput,
  ): Promise<ClinicalNoteTemplate> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma
      .runWithTenant(async (tx) => {
        if (input.prompts !== undefined) {
          // Excepción legítima al borrado lógico: las preguntas son la
          // configuración de la plantilla, sin datos de pacientes, y nada las
          // referencia (la evolución guarda su texto compuesto, no las
          // respuestas). Editar la plantilla las sustituye en la MISMA
          // transacción; el cambio queda en audit_events.
          // eslint-disable-next-line no-restricted-syntax
          await tx.clinicalNoteTemplatePrompt.deleteMany({
            where: { templateId: id },
          });
          await tx.clinicalNoteTemplatePrompt.createMany({
            data: this.promptRows(input.prompts).map((p) => ({
              ...p,
              tenantId,
              templateId: id,
            })),
          });
        }
        return tx.clinicalNoteTemplate.update({
          where: { id },
          data: {
            name: input.name,
            category: input.category,
            body: input.body,
            active: input.active,
            updatedById: input.updatedById,
          },
          include: WITH_PROMPTS,
        });
      })
      .catch(rethrowDuplicateName);
    return mapToEntity(row);
  }
}
