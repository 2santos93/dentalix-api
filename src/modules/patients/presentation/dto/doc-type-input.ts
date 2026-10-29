import type { DocumentType } from '@prisma/client';
import { DOC_TYPE_LABEL_MAX, DOCUMENT_TYPES } from '../../domain/document-type';
import { LEGACY_CODES, type LegacyDocType } from '../../domain/legacy-doc-type';

/**
 * DX-327 (R9, fase 1): el tipo que llega en un cuerpo. Además de los cinco
 * genéricos, los códigos anteriores (web anterior) pasan la validación; el
 * controlador los traduce con `resolveDocTypeInput` antes del caso de uso, que
 * solo acepta `DocumentType`. OpenAPI publica solo los genéricos. La fase 2
 * retira los anteriores.
 */
export type DocTypeInput = DocumentType | LegacyDocType;

export const DOC_TYPE_INPUTS: readonly DocTypeInput[] = [
  ...DOCUMENT_TYPES,
  ...LEGACY_CODES,
];

export const DOC_TYPE_MESSAGE = `El tipo de documento debe ser uno de: ${DOCUMENT_TYPES.join(', ')}.`;

/** OpenAPI del nombre libre (R7); el dominio lo valida tras recortar. */
export const DOC_TYPE_LABEL_PROPERTY = {
  type: String,
  nullable: true,
  maxLength: DOC_TYPE_LABEL_MAX,
  description:
    'Nombre libre del documento que escribe la clínica (hasta ' +
    `${DOC_TYPE_LABEL_MAX} caracteres). Null = sin nombre propio.`,
} as const;

/** OpenAPI del nombre visible (R17), que resuelve la API. */
export const DOC_TYPE_NAME_DESCRIPTION =
  'Nombre visible del tipo de documento: el nombre libre, si no el nombre ' +
  'local de la clínica para ese tipo, si no el genérico.';
