import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  TEMPLATE_NOT_FOUND_MESSAGE,
  checkExternalOrderTemplate,
  templateErrorMessage,
  type ExternalOrderTemplate,
  type ExternalOrderTemplateDraft,
} from '../domain/external-order-template';
import type { ExternalOrderKind } from '../domain/external-order-rules';
import {
  EXTERNAL_ORDER_TEMPLATE_REPOSITORY,
  type PrismaExternalOrderTemplateRepository,
} from '../infrastructure/prisma-external-order-template.repository';

export interface ExternalOrderTemplateInput {
  name?: string;
  kind?: ExternalOrderKind;
  recipient?: string | null;
  items?: string[];
  active?: boolean;
}

type TemplateRepo = Pick<
  PrismaExternalOrderTemplateRepository,
  'list' | 'create' | 'update'
>;

function valid(input: {
  name: unknown;
  kind: unknown;
  recipient: unknown;
  items: unknown;
  active: unknown;
}): ExternalOrderTemplateDraft {
  const check = checkExternalOrderTemplate(input);
  if (!check.ok) {
    throw new BadRequestException(templateErrorMessage(check.errors));
  }
  return check.value;
}

/**
 * DX-572 (D7): plantillas de órdenes externas. Leerlas: los roles clínicos
 * (la web las ofrece al emitir y en Ajustes); crear, editar, activar y desactivar:
 * solo ADMIN (lo exige la ruta). No se borran. Versión optimista: `version`
 * obligatoria al editar (409 EXTERNAL_ORDER_TEMPLATE_STALE si cambió).
 */
@Injectable()
export class ExternalOrderTemplatesUseCases {
  constructor(
    @Inject(EXTERNAL_ORDER_TEMPLATE_REPOSITORY)
    private readonly repo: TemplateRepo,
  ) {}

  list(includeInactive: boolean): Promise<ExternalOrderTemplate[]> {
    return this.repo.list({ includeInactive });
  }

  create(
    input: ExternalOrderTemplateInput,
    audit: AuditRequestContext,
  ): Promise<ExternalOrderTemplate> {
    return this.repo.create(
      valid({
        name: input.name,
        kind: input.kind,
        recipient: input.recipient,
        items: input.items,
        active: input.active ?? true,
      }),
      audit,
    );
  }

  async update(
    id: string,
    input: ExternalOrderTemplateInput & { version: number },
    audit: AuditRequestContext,
  ): Promise<ExternalOrderTemplate> {
    const updated = await this.repo.update(
      id,
      input.version,
      (current) =>
        valid({
          name: input.name ?? current.name,
          kind: input.kind ?? current.kind,
          recipient:
            input.recipient === undefined ? current.recipient : input.recipient,
          items: input.items ?? current.items,
          active: input.active ?? current.active,
        }),
      audit,
    );
    if (!updated) throw new NotFoundException(TEMPLATE_NOT_FOUND_MESSAGE);
    return updated;
  }
}
