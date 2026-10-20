import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PostOpTemplateLink } from '../../domain/entities/post-op-template.entity';
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

const T0 = new Date('2026-10-01T00:00:00.000Z');

/**
 * Repositorio en memoria con estado: los tests afirman sobre `rows` como un
 * e2e lo haría sobre la tabla. `catalog` y `appointmentTypes` hacen de las
 * tablas que la versión Prisma consulta para validar los vínculos.
 */
export class InMemoryPostOpTemplateRepository implements PostOpTemplateRepository {
  readonly rows: PostOpTemplateView[] = [];
  readonly catalog = new Map<string, { code: string; labelEs: string }>();
  readonly appointmentTypes = new Map<string, string>();
  private nextId = 1;

  seed(partial: Partial<PostOpTemplateView> = {}): PostOpTemplateView {
    const row: PostOpTemplateView = {
      id: `tpl-${this.nextId++}`,
      tenantId: 't1',
      code: 'POI-EXO',
      title: 'Exodoncia simple',
      body: 'Hola {{paciente}}.',
      version: 1,
      active: true,
      createdById: null,
      updatedById: null,
      createdAt: T0,
      updatedAt: T0,
      links: [],
      catalogItems: [],
      appointmentTypes: [],
      ...partial,
    };
    this.rows.push(row);
    return row;
  }

  list(params?: { active?: boolean }): Promise<PostOpTemplateView[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (r) => params?.active === undefined || r.active === params.active,
        )
        .sort((a, b) => a.title.localeCompare(b.title)),
    );
  }

  findById(id: string): Promise<PostOpTemplateView | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }

  // Diferido: un error de validación es un rechazo, como en Prisma.
  create(input: CreatePostOpTemplateRepoInput): Promise<PostOpTemplateView> {
    return Promise.resolve().then(() => this.insert(input));
  }

  createMany(
    inputs: CreatePostOpTemplateRepoInput[],
  ): Promise<PostOpTemplateView[]> {
    return Promise.resolve().then(() =>
      inputs.map((input) => this.insert(input)),
    );
  }

  update(
    id: string,
    input: UpdatePostOpTemplateRepoInput,
  ): Promise<PostOpTemplateView> {
    return Promise.resolve().then(() => this.applyUpdate(id, input));
  }

  private applyUpdate(
    id: string,
    input: UpdatePostOpTemplateRepoInput,
  ): PostOpTemplateView {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error('not found');
    // Primero los vínculos: si no valen, la fila no cambia (transacción).
    if (input.links) {
      this.applyLinks(row, {
        catalogItemIds:
          input.links.catalogItemIds ?? row.catalogItems.map((c) => c.id),
        appointmentTypeIds:
          input.links.appointmentTypeIds ??
          row.appointmentTypes.map((t) => t.id),
      });
    }
    if (input.title !== undefined) row.title = input.title;
    if (input.body !== undefined) row.body = input.body;
    if (input.active !== undefined) row.active = input.active;
    if (input.bumpVersion) row.version += 1;
    return { ...row };
  }

  private insert(input: CreatePostOpTemplateRepoInput): PostOpTemplateView {
    if (this.rows.some((r) => r.code === input.code)) {
      throw new ConflictException(POSTOP_TEMPLATE_DUPLICATE_CODE_MESSAGE);
    }
    this.assertLinks(input.links);
    const row = this.seed({
      code: input.code,
      title: input.title,
      body: input.body,
      active: input.active,
      createdById: input.createdById ?? null,
      updatedById: input.createdById ?? null,
    });
    this.applyLinks(row, input.links);
    return { ...row };
  }

  private assertLinks(links: PostOpTemplateLinksInput): void {
    if (links.catalogItemIds.some((id) => !this.catalog.has(id))) {
      throw new BadRequestException(POSTOP_CATALOG_ITEM_INVALID_MESSAGE);
    }
    if (links.appointmentTypeIds.some((id) => !this.appointmentTypes.has(id))) {
      throw new BadRequestException(POSTOP_APPOINTMENT_TYPE_INVALID_MESSAGE);
    }
  }

  private applyLinks(
    row: PostOpTemplateView,
    links: PostOpTemplateLinksInput,
  ): void {
    this.assertLinks(links);
    const link = (
      catalogItemId: string | null,
      appointmentTypeId: string | null,
    ): PostOpTemplateLink => ({
      id: `link-${this.nextId++}`,
      tenantId: row.tenantId,
      templateId: row.id,
      catalogItemId,
      appointmentTypeId,
      createdAt: T0,
    });
    row.links = [
      ...links.catalogItemIds.map((id) => link(id, null)),
      ...links.appointmentTypeIds.map((id) => link(null, id)),
    ];
    row.catalogItems = links.catalogItemIds.map((id) => ({
      id,
      ...this.catalog.get(id)!,
    }));
    row.appointmentTypes = links.appointmentTypeIds.map((id) => ({
      id,
      name: this.appointmentTypes.get(id)!,
    }));
  }
}
