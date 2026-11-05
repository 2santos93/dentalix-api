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
import {
  DUPLICATE_NOTE_TEMPLATE_MESSAGE,
  staleNoteTemplate,
} from '../../application/note-template-errors';

/** Posiciones de paso (CHECK 0..49; las definitivas son 0..19). */
const PARKING_POSITION = 20;

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
    version: row.version,
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

  /**
   * Por `id` bajo RLS; el use-case ya comprobó que existe en la clínica.
   *
   * DX-231: la versión se comprueba y sube con UN `updateMany ... WHERE
   * version = esperada` al principio de la transacción: si otro PATCH ganó, no
   * hay fila que tocar y se lanza 409 sin haber escrito nada (el UPDATE además
   * toma el bloqueo de la fila hasta el commit, así dos PATCH simultáneos con
   * la misma versión se serializan y el segundo ve la versión nueva).
   */
  async update(
    id: string,
    input: UpdateNoteTemplateRepoInput,
  ): Promise<ClinicalNoteTemplate> {
    const tenantId = this.requireTenantId();
    const row = await this.prisma
      .runWithTenant(async (tx) => {
        const claimed = await tx.clinicalNoteTemplate.updateMany({
          where: {
            id,
            ...(input.expectedVersion !== undefined
              ? { version: input.expectedVersion }
              : {}),
          },
          data: { version: { increment: 1 } },
        });
        if (claimed.count === 0) {
          throw staleNoteTemplate();
        }
        if (input.prompts !== undefined) {
          await this.syncPrompts(tx, tenantId, id, input.prompts);
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

  /**
   * DX-231 (BE-034): upsert por id. Las preguntas que ya eran de la plantilla
   * conservan su id (una composición en curso con ese id sigue guardándose);
   * las nuevas se crean y las que ya no vienen se quitan. Un id ajeno o
   * inexistente cuenta como pregunta nueva. La posición es UNIQUE por
   * plantilla y el CHECK la limita a 0..49 (como mucho 20 preguntas), así que
   * las que se quedan pasan primero a 20..39 y luego a la definitiva.
   */
  private async syncPrompts(
    tx: Prisma.TransactionClient,
    tenantId: string,
    templateId: string,
    prompts: NoteTemplateDraft['prompts'],
  ): Promise<void> {
    const existing = await tx.clinicalNoteTemplatePrompt.findMany({
      where: { templateId },
      select: { id: true },
    });
    const own = new Set(existing.map((p) => p.id));
    const rows = this.promptRows(prompts).map((row, i) => {
      const keep = prompts[i].id;
      return {
        ...row,
        keepId: keep !== undefined && own.has(keep) ? keep : null,
      };
    });
    const keptIds = rows.flatMap((r) => (r.keepId ? [r.keepId] : []));
    // Excepción legítima al borrado lógico: las preguntas son la configuración
    // de la plantilla, sin datos de pacientes, y nada las referencia (la
    // evolución guarda su texto compuesto, no las respuestas). El cambio queda
    // en audit_events.
    // eslint-disable-next-line no-restricted-syntax
    await tx.clinicalNoteTemplatePrompt.deleteMany({
      where: { templateId, id: { notIn: keptIds } },
    });
    for (const [i, row] of rows.entries()) {
      if (row.keepId) {
        await tx.clinicalNoteTemplatePrompt.update({
          where: { id: row.keepId },
          data: { position: PARKING_POSITION + i },
        });
      }
    }
    for (const row of rows) {
      const { keepId, ...data } = row;
      if (keepId) {
        await tx.clinicalNoteTemplatePrompt.update({
          where: { id: keepId },
          data,
        });
      } else {
        await tx.clinicalNoteTemplatePrompt.create({
          data: { ...data, tenantId, templateId },
        });
      }
    }
  }
}
