import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  POST_OP_TEMPLATE_REPOSITORY,
  type PostOpTemplateLinksInput,
  type PostOpTemplateRepository,
  type PostOpTemplateView,
} from '../../domain/ports/post-op-template-repository.port';
import { unknownVariables } from '../../domain/render-instructions';
import { SAMPLE_POSTOP_TEMPLATES } from '../../domain/sample-templates';
import {
  normalizeTemplateCode,
  templateCodeError,
  textChanged,
} from '../../domain/template-rules';

export const POSTOP_TEMPLATE_NOT_FOUND_MESSAGE =
  'Plantilla de indicaciones no encontrada';

export interface CreatePostOpTemplateInput {
  code: string;
  title: string;
  body: string;
  catalogItemIds?: string[];
  appointmentTypeIds?: string[];
}

/** `code` no está: no se edita después de crear la plantilla. */
export interface UpdatePostOpTemplateInput {
  title?: string;
  body?: string;
  active?: boolean;
  catalogItemIds?: string[];
  appointmentTypeIds?: string[];
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new BadRequestException(`${field} no puede estar vacío`);
  }
  return trimmed;
}

function assertKnownVariables(body: string): void {
  const unknown = unknownVariables(body);
  if (unknown.length > 0) {
    throw new BadRequestException(
      `Variables no admitidas: ${unknown.map((v) => `{{${v}}}`).join(', ')}`,
    );
  }
}

const unique = (ids: string[] | undefined): string[] | undefined =>
  ids === undefined ? undefined : [...new Set(ids)];

@Injectable()
export class ListPostOpTemplatesUseCase {
  constructor(
    @Inject(POST_OP_TEMPLATE_REPOSITORY)
    private readonly repo: PostOpTemplateRepository,
  ) {}

  execute(params?: { active?: boolean }): Promise<PostOpTemplateView[]> {
    return this.repo.list(params);
  }
}

@Injectable()
export class CreatePostOpTemplateUseCase {
  constructor(
    @Inject(POST_OP_TEMPLATE_REPOSITORY)
    private readonly repo: PostOpTemplateRepository,
  ) {}

  /** Nace activa y en la versión 1; el código se guarda en mayúsculas. */
  async execute(
    input: CreatePostOpTemplateInput,
    createdById?: string,
  ): Promise<PostOpTemplateView> {
    const code = normalizeTemplateCode(input.code);
    const codeError = templateCodeError(code);
    if (codeError) throw new BadRequestException(codeError);
    const title = requireText(input.title, 'El título');
    const body = requireText(input.body, 'El texto');
    assertKnownVariables(body);
    const links: PostOpTemplateLinksInput = {
      catalogItemIds: unique(input.catalogItemIds) ?? [],
      appointmentTypeIds: unique(input.appointmentTypeIds) ?? [],
    };
    return this.repo.create({
      code,
      title,
      body,
      active: true,
      links,
      createdById,
    });
  }
}

@Injectable()
export class UpdatePostOpTemplateUseCase {
  constructor(
    @Inject(POST_OP_TEMPLATE_REPOSITORY)
    private readonly repo: PostOpTemplateRepository,
  ) {}

  /**
   * Cambiar título o texto sube `version` (cada entrega guarda de qué versión
   * salió); activar/desactivar o cambiar vínculos no. Los vínculos de cada
   * tipo que llega se reemplazan completos.
   */
  async execute(
    id: string,
    input: UpdatePostOpTemplateInput,
    updatedById?: string,
  ): Promise<PostOpTemplateView> {
    const current = await this.repo.findById(id);
    if (!current) {
      throw new NotFoundException(POSTOP_TEMPLATE_NOT_FOUND_MESSAGE);
    }
    const title =
      input.title !== undefined
        ? requireText(input.title, 'El título')
        : undefined;
    const body =
      input.body !== undefined
        ? requireText(input.body, 'El texto')
        : undefined;
    if (body !== undefined) assertKnownVariables(body);

    const catalogItemIds = unique(input.catalogItemIds);
    const appointmentTypeIds = unique(input.appointmentTypeIds);
    const links =
      catalogItemIds === undefined && appointmentTypeIds === undefined
        ? undefined
        : { catalogItemIds, appointmentTypeIds };

    return this.repo.update(id, {
      title,
      body,
      active: input.active,
      bumpVersion: textChanged(current, { title, body }),
      links,
      updatedById,
    });
  }
}

@Injectable()
export class LoadSamplePostOpTemplatesUseCase {
  constructor(
    @Inject(POST_OP_TEMPLATE_REPOSITORY)
    private readonly repo: PostOpTemplateRepository,
  ) {}

  /**
   * «Cargar plantillas de ejemplo»: crea las de ejemplo cuyo código la clínica
   * aún no tiene (activas o no) y devuelve las creadas. Repetirlo no duplica
   * nada ni pisa una plantilla propia con el mismo código. La siembra de la
   * demo también lo usa.
   */
  async execute(createdById?: string): Promise<PostOpTemplateView[]> {
    const existing = new Set((await this.repo.list()).map((t) => t.code));
    const missing = SAMPLE_POSTOP_TEMPLATES.filter(
      (t) => !existing.has(t.code),
    );
    if (missing.length === 0) return [];
    return this.repo.createMany(
      missing.map((t) => ({
        code: t.code,
        title: t.title,
        body: t.body,
        active: true,
        links: { catalogItemIds: [], appointmentTypeIds: [] },
        createdById,
      })),
    );
  }
}
