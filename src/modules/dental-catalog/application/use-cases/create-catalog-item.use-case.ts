import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { CatalogKind } from '@prisma/client';
import { DENTAL_CATALOG_REPOSITORY } from '../../domain/ports/dental-catalog-repository.port';
import type { DentalCatalogRepository } from '../../domain/ports/dental-catalog-repository.port';
import { DentalCatalogItem } from '../../domain/entities/dental-catalog-item.entity';
import {
  CATALOG_NOTE_TEMPLATE_READER,
  type CatalogNoteTemplateReader,
} from '../../domain/ports/catalog-note-template-reader.port';
import { assertLinkableNoteTemplate } from '../note-template-link';
import {
  CATALOG_PATIENT_LANGUAGES_READER,
  type CatalogPatientLanguagesReader,
} from '../../domain/ports/catalog-patient-languages-reader.port';
import type { PatientDescriptionEntry } from '../../domain/patient-description';
import {
  MISSING_PATIENT_LANGUAGES_READER,
  patientDescriptionInput,
} from '../patient-description-input';

// Valid CSS hex color lengths are 3, 4, 6 or 8 hex digits after the `#`
// (5 and 7 digits are not valid CSS hex colors and must be rejected).
export const HEX_COLOR_PATTERN =
  /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function isValidHexColor(color: unknown): color is string {
  return typeof color === 'string' && HEX_COLOR_PATTERN.test(color);
}

export function isValidCatalogKind(kind: unknown): kind is CatalogKind {
  return kind === CatalogKind.DIAGNOSIS || kind === CatalogKind.PROCEDURE;
}

/** DX-566: el control postoperatorio solo lo pide un procedimiento. */
export const POST_OP_CHECK_DIAGNOSIS_MESSAGE =
  'Solo un procedimiento puede pedir control postoperatorio.';
/** DX-566: tope de los días del control (también en el DTO y en el CHECK). */
export const POST_OP_CHECK_AFTER_DAYS_MIN = 1;
export const POST_OP_CHECK_AFTER_DAYS_MAX = 30;
export const POST_OP_CHECK_AFTER_DAYS_MESSAGE = `Los días del control postoperatorio van de ${POST_OP_CHECK_AFTER_DAYS_MIN} a ${POST_OP_CHECK_AFTER_DAYS_MAX}.`;

/**
 * DX-566: «Pide control postoperatorio» solo en un PROCEDURE (400 en un
 * diagnóstico) y los días, enteros de 1 a 30 (el DTO ya lo valida; aquí es la
 * red del caso de uso, como el CHECK de la BD).
 */
export function assertPostOpCheckFields(
  kind: CatalogKind,
  fields: { requiresPostOpCheck?: boolean; postOpCheckAfterDays?: number },
): void {
  if (fields.requiresPostOpCheck === true && kind !== CatalogKind.PROCEDURE) {
    throw new BadRequestException(POST_OP_CHECK_DIAGNOSIS_MESSAGE);
  }
  const days = fields.postOpCheckAfterDays;
  if (
    days !== undefined &&
    (!Number.isInteger(days) ||
      days < POST_OP_CHECK_AFTER_DAYS_MIN ||
      days > POST_OP_CHECK_AFTER_DAYS_MAX)
  ) {
    throw new BadRequestException(POST_OP_CHECK_AFTER_DAYS_MESSAGE);
  }
}

// NOTE: deliberately NO `tenantId` field — the tenant comes from the guarded
// request context, never from the client (same convention as patients).
export interface CreateCatalogItemInput {
  code: string;
  category?: string;
  kind: CatalogKind;
  labelEs: string;
  labelEn?: string;
  labelPt?: string;
  color: string;
  defaultPrice?: number;
  /** DX-105: por defecto true. */
  allowDiscount?: boolean;
  /** DX-566: pide control postoperatorio; solo PROCEDURE (400 si no). */
  requiresPostOpCheck?: boolean;
  /** DX-566: días hábiles tras el procedimiento (1–30, por defecto 1). */
  postOpCheckAfterDays?: number;
  /** DX-560: la lista entera (vacía o sin el campo = sin descripción). */
  patientDescription?: PatientDescriptionEntry[];
  active?: boolean;
  /** DX-455: plantilla sugerida al marcarlo hecho (de esta clínica, activa). */
  clinicalNoteTemplateId?: string | null;
}

@Injectable()
export class CreateCatalogItemUseCase {
  constructor(
    @Inject(DENTAL_CATALOG_REPOSITORY)
    private readonly repo: DentalCatalogRepository,
    @Inject(CATALOG_NOTE_TEMPLATE_READER)
    private readonly noteTemplates: CatalogNoteTemplateReader,
    @Optional()
    @Inject(CATALOG_PATIENT_LANGUAGES_READER)
    private readonly patientLanguages: CatalogPatientLanguagesReader = MISSING_PATIENT_LANGUAGES_READER,
  ) {}

  async execute(input: CreateCatalogItemInput): Promise<DentalCatalogItem> {
    if (!isValidHexColor(input.color)) {
      throw new BadRequestException(
        'El color debe ser un valor hexadecimal válido (p. ej., #1A2B3C).',
      );
    }
    if (!isValidCatalogKind(input.kind)) {
      throw new BadRequestException(
        'El tipo debe ser diagnóstico (DIAGNOSIS) o procedimiento (PROCEDURE).',
      );
    }

    assertPostOpCheckFields(input.kind, input);

    const code = input.code.trim();
    if (code === '') {
      throw new BadRequestException('El código es obligatorio.');
    }
    await assertLinkableNoteTemplate(
      this.noteTemplates,
      input.clinicalNoteTemplateId,
      input.kind,
    );
    const patientDescription = await patientDescriptionInput(
      this.patientLanguages,
      input.patientDescription,
      {},
    );

    return this.repo.create({
      code,
      category: input.category,
      kind: input.kind,
      labelEs: input.labelEs,
      labelEn: input.labelEn,
      labelPt: input.labelPt,
      color: input.color,
      defaultPrice: input.defaultPrice,
      allowDiscount: input.allowDiscount,
      requiresPostOpCheck: input.requiresPostOpCheck,
      postOpCheckAfterDays: input.postOpCheckAfterDays,
      patientDescription,
      active: input.active,
      clinicalNoteTemplateId: input.clinicalNoteTemplateId ?? undefined,
    });
  }
}
