import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
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
  assertPostOpCheckFields,
  isValidCatalogKind,
  isValidHexColor,
} from './create-catalog-item.use-case';
import {
  CATALOG_PATIENT_LANGUAGES_READER,
  type CatalogPatientLanguagesReader,
} from '../../domain/ports/catalog-patient-languages-reader.port';
import {
  patientDescriptionMap,
  type PatientDescriptionEntry,
} from '../../domain/patient-description';
import {
  MISSING_PATIENT_LANGUAGES_READER,
  patientDescriptionInput,
} from '../patient-description-input';

export type UpdateCatalogItemInput = Omit<
  UpdateDentalCatalogItemRepoInput,
  'patientDescription'
> & {
  /** DX-560: la lista ENTERA; sin el campo, no se toca. */
  patientDescription?: PatientDescriptionEntry[];
};

@Injectable()
export class UpdateCatalogItemUseCase {
  constructor(
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly repo: DentalCatalogRepository,
    @Inject(CATALOG_NOTE_TEMPLATE_READER)
    private readonly noteTemplates: CatalogNoteTemplateReader,
    @Optional()
    @Inject(CATALOG_PATIENT_LANGUAGES_READER)
    private readonly patientLanguages: CatalogPatientLanguagesReader = MISSING_PATIENT_LANGUAGES_READER,
  ) {}

  /**
   * `actorUserId`: quien edita (del token). Si cambia el precio por defecto,
   * el repositorio deja la fila del historial de precios (DX-205) con él.
   */
  async execute(
    id: string,
    patch: UpdateCatalogItemInput,
    actorUserId: string,
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
        'El color debe ser un valor hexadecimal válido (p. ej., #1A2B3C).',
      );
    }
    if (patch.kind !== undefined && !isValidCatalogKind(patch.kind)) {
      throw new BadRequestException(
        'El tipo debe ser diagnóstico (DIAGNOSIS) o procedimiento (PROCEDURE).',
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

    // DX-566: el control lo pide solo un procedimiento. Uno que pasa a
    // diagnóstico deja de pedirlo (como pierde su plantilla, pero sin 400 si
    // no lo manda: el CHECK de la BD no admite un diagnóstico con control).
    assertPostOpCheckFields(kind, patch);
    const { patientDescription: descriptionEntries, ...rest } = patch;
    const normalizedPatch: UpdateDentalCatalogItemRepoInput = { ...rest };
    // DX-560: un idioma ya retirado de la clínica se conserva si su texto no
    // cambia (la web devuelve lo que leyó).
    const patientDescription = await patientDescriptionInput(
      this.patientLanguages,
      descriptionEntries,
      patientDescriptionMap(existing.patientDescription),
    );
    if (patientDescription !== undefined) {
      normalizedPatch.patientDescription = patientDescription;
    }
    if (
      kind !== CatalogKind.PROCEDURE &&
      patch.requiresPostOpCheck === undefined &&
      existing.requiresPostOpCheck
    ) {
      normalizedPatch.requiresPostOpCheck = false;
    }
    if (normalizedPatch.code !== undefined) {
      normalizedPatch.code = normalizedPatch.code.trim();
    }

    return this.repo.update(id, normalizedPatch, actorUserId);
  }
}
