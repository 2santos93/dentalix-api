import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConsentTemplate } from '../../domain/entities/consent-template.entity';
import {
  CONSENT_TEMPLATE_REPOSITORY,
  type ConsentTemplateRepository,
} from '../../domain/ports/consent-template-repository.port';
import { findUnknownVariables } from '../../domain/render-consent';

export const CONSENT_TEMPLATE_NOT_FOUND_MESSAGE = 'Plantilla no encontrada';

export interface ConsentTemplateInput {
  title: string;
  body: string;
  active?: boolean;
}

function requireText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new BadRequestException(`${field} no puede estar vacío`);
  }
  return trimmed;
}

function assertKnownVariables(body: string): void {
  const unknown = findUnknownVariables(body);
  if (unknown.length > 0) {
    throw new BadRequestException(
      `Variables desconocidas en el texto: ${unknown.map((v) => `{{${v}}}`).join(', ')}`,
    );
  }
}

@Injectable()
export class ListConsentTemplatesUseCase {
  constructor(
    @Inject(CONSENT_TEMPLATE_REPOSITORY)
    private readonly repo: ConsentTemplateRepository,
  ) {}

  execute(params?: { active?: boolean }): Promise<ConsentTemplate[]> {
    return this.repo.list(params);
  }
}

@Injectable()
export class CreateConsentTemplateUseCase {
  constructor(
    @Inject(CONSENT_TEMPLATE_REPOSITORY)
    private readonly repo: ConsentTemplateRepository,
  ) {}

  async execute(
    input: ConsentTemplateInput,
    createdById?: string,
  ): Promise<ConsentTemplate> {
    const title = requireText(input.title, 'El título');
    const body = requireText(input.body, 'El texto');
    assertKnownVariables(body);
    return this.repo.create({
      title,
      body,
      active: input.active ?? true,
      createdById,
    });
  }
}

@Injectable()
export class UpdateConsentTemplateUseCase {
  constructor(
    @Inject(CONSENT_TEMPLATE_REPOSITORY)
    private readonly repo: ConsentTemplateRepository,
  ) {}

  /**
   * Editar la plantilla NUNCA toca los consentimientos ya firmados: cada uno
   * guarda su propia foto del texto. Cambiar título o texto sube `version`
   * (así un consentimiento sabe de qué versión salió y la firma rechaza una
   * vista previa vieja); activar/desactivar no.
   */
  async execute(
    id: string,
    input: Partial<ConsentTemplateInput>,
    updatedById?: string,
  ): Promise<ConsentTemplate> {
    const current = await this.repo.findById(id);
    if (!current) {
      throw new NotFoundException(CONSENT_TEMPLATE_NOT_FOUND_MESSAGE);
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

    const textChanged =
      (title !== undefined && title !== current.title) ||
      (body !== undefined && body !== current.body);

    return this.repo.update(id, {
      title,
      body,
      active: input.active,
      bumpVersion: textChanged,
      updatedById,
    });
  }
}
