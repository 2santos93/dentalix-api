import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CatalogKind } from '@prisma/client';
import { DENTAL_CATALOG_REPOSITORY } from '../../domain/ports/dental-catalog-repository.port';
import type {
  DentalCatalogRepository,
  UpdateDentalCatalogItemRepoInput,
} from '../../domain/ports/dental-catalog-repository.port';
import { DentalCatalogItem } from '../../domain/entities/dental-catalog-item.entity';
import {
  CATALOG_NOTE_TEMPLATE_READER,
  type CatalogNoteTemplateReader,
} from '../../domain/ports/catalog-note-template-reader.port';
import {
  assertLinkableNoteTemplate,
  LINK_TEMPLATE_DIAGNOSIS_MESSAGE,
} from '../note-template-link';
import {
  isValidCatalogKind,
  isValidHexColor,
} from './create-catalog-item.use-case';

export type UpdateCatalogItemInput = UpdateDentalCatalogItemRepoInput;

@Injectable()
export class UpdateCatalogItemUseCase {
  constructor(
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly repo: DentalCatalogRepository,
    @Inject(CATALOG_NOTE_TEMPLATE_READER)
    private readonly noteTemplates: CatalogNoteTemplateReader,
  ) {}

  async execute(
    id: string,
    patch: UpdateCatalogItemInput,
  ): Promise<DentalCatalogItem> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      // Same rationale as patients: a missing row and a row that belongs to
      // another tenant are indistinguishable here (RLS makes cross-tenant
      // rows invisible), so both surface as NotFound.
      throw new NotFoundException(
        'Prestación no encontrada en el catálogo de esta clínica.',
      );
    }

    if (patch.color !== undefined && !isValidHexColor(patch.color)) {
      throw new BadRequestException(
        'color must be a valid hex value (e.g. #1A2B3C)',
      );
    }
    if (patch.kind !== undefined && !isValidCatalogKind(patch.kind)) {
      throw new BadRequestException(
        'kind must be one of: DIAGNOSIS, PROCEDURE',
      );
    }

    // DX-455: el vínculo se comprueba contra el tipo que TENDRÁ el ítem. Un
    // procedimiento que pasa a diagnóstico con su plantilla ligada: 400.
    const kind = patch.kind ?? existing.kind;
    await assertLinkableNoteTemplate(
      this.noteTemplates,
      patch.clinicalNoteTemplateId,
      kind,
    );
    const keepsLink =
      patch.clinicalNoteTemplateId === undefined &&
      existing.clinicalNoteTemplateId !== null;
    if (keepsLink && kind !== CatalogKind.PROCEDURE) {
      throw new BadRequestException(LINK_TEMPLATE_DIAGNOSIS_MESSAGE);
    }

    const normalizedPatch: UpdateDentalCatalogItemRepoInput = { ...patch };
    if (normalizedPatch.code !== undefined) {
      normalizedPatch.code = normalizedPatch.code.trim();
    }

    return this.repo.update(id, normalizedPatch);
  }
}
