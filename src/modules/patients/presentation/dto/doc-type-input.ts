import type { DocumentType } from '@prisma/client';
import { DOC_TYPE_LABEL_MAX, DOCUMENT_TYPES } from '../../domain/document-type';

/** DX-327: el tipo que llega en un cuerpo, uno de los cinco genéricos. */
export type DocTypeInput = DocumentType;

export const DOC_TYPE_INPUTS: readonly DocTypeInput[] = DOCUMENT_TYPES;

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
