import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { TreatmentPlanStatus } from '@prisma/client';

/**
 * Errores de las plantillas de plan (DX-559). Cada 4xx lleva `code` para que
 * la web reaccione sin leer el texto, y el mensaje en español. Cuando el
 * problema es de una línea, el cuerpo lleva su `lineId`.
 */

export const PLAN_TEMPLATE_STALE = 'PLAN_TEMPLATE_STALE';
export const PLAN_TEMPLATE_INACTIVE = 'PLAN_TEMPLATE_INACTIVE';
export const PLAN_TEMPLATE_PLAN_NOT_EDITABLE =
  'PLAN_TEMPLATE_PLAN_NOT_EDITABLE';
export const PLAN_TEMPLATE_NOTHING_TO_APPLY = 'PLAN_TEMPLATE_NOTHING_TO_APPLY';
export const PLAN_TEMPLATE_TOOTH_REQUIRED = 'PLAN_TEMPLATE_TOOTH_REQUIRED';
export const PLAN_TEMPLATE_PRICE_MISSING = 'PLAN_TEMPLATE_PRICE_MISSING';
export const PLAN_TEMPLATE_VISIT_OVERFLOW = 'PLAN_TEMPLATE_VISIT_OVERFLOW';
/** Nombre repetido en la clínica (409). */
export const PLAN_TEMPLATE_DUPLICATE_NAME = 'PLAN_TEMPLATE_DUPLICATE_NAME';
/** El procedimiento de una línea no existe en el catálogo de la clínica (404). */
export const PLAN_TEMPLATE_CATALOG_ITEM_NOT_FOUND =
  'PLAN_TEMPLATE_CATALOG_ITEM_NOT_FOUND';
/** El ítem del catálogo de una línea es un diagnóstico, no un procedimiento (422). */
export const PLAN_TEMPLATE_NOT_A_PROCEDURE = 'PLAN_TEMPLATE_NOT_A_PROCEDURE';
/** Un `lines[].lineId` del cuerpo de aplicar no es de la plantilla (400). */
export const PLAN_TEMPLATE_UNKNOWN_LINE = 'PLAN_TEMPLATE_UNKNOWN_LINE';

export const PLAN_TEMPLATE_NOT_FOUND_MESSAGE =
  'Plantilla de plan no encontrada en esta clínica.';
export const PLAN_NOT_FOUND_MESSAGE = 'Plan de tratamiento no encontrado';
export const PLAN_TEMPLATE_DUPLICATE_MESSAGE =
  'Ya existe una plantilla de plan con ese nombre.';
export const PLAN_TEMPLATE_STALE_MESSAGE =
  'La plantilla cambió mientras la editabas: recárgala.';
export const PLAN_TEMPLATE_INACTIVE_MESSAGE =
  'La plantilla está desactivada: actívala en Ajustes › Plantillas de plan o elige otra.';
export const PLAN_TEMPLATE_NOTHING_TO_APPLY_MESSAGE =
  'Ningún procedimiento de la plantilla está activo en el catálogo: no hay nada que añadir.';
export const PLAN_TEMPLATE_VISIT_OVERFLOW_MESSAGE =
  'El plan ya tiene demasiadas visitas: con esta plantilla pasaría de la visita 1000.';

const PLAN_STATUS_NAMES: Readonly<Record<TreatmentPlanStatus, string>> = {
  DRAFT: 'en borrador',
  PRESENTED: 'presentado',
  ACCEPTED: 'aceptado',
  REJECTED: 'rechazado',
  COMPLETED: 'completado',
  CANCELLED: 'cancelado',
};

export function staleTemplate(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: PLAN_TEMPLATE_STALE,
    message: PLAN_TEMPLATE_STALE_MESSAGE,
  });
}

export function duplicateTemplateName(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: PLAN_TEMPLATE_DUPLICATE_NAME,
    message: PLAN_TEMPLATE_DUPLICATE_MESSAGE,
  });
}

export function inactiveTemplate(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: PLAN_TEMPLATE_INACTIVE,
    message: PLAN_TEMPLATE_INACTIVE_MESSAGE,
  });
}

/**
 * D7: solo un plan en borrador o presentado y sin firma admite una plantilla.
 * El mensaje nombra el estado (o la firma).
 */
export function planNotEditable(
  status: TreatmentPlanStatus,
  signed: boolean,
): ConflictException {
  const message = signed
    ? 'El plan está aceptado y firmado: no se le pueden añadir procedimientos desde una plantilla.'
    : `El plan está ${PLAN_STATUS_NAMES[status]}: solo se pueden añadir procedimientos desde una plantilla a un plan en borrador o presentado.`;
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: PLAN_TEMPLATE_PLAN_NOT_EDITABLE,
    message,
    status,
  });
}

export function nothingToApply(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    code: PLAN_TEMPLATE_NOTHING_TO_APPLY,
    message: PLAN_TEMPLATE_NOTHING_TO_APPLY_MESSAGE,
  });
}

export function toothRequired(
  lineId: string,
  label: string,
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: PLAN_TEMPLATE_TOOTH_REQUIRED,
    message: `Falta el diente de «${label}»: indica un diente para todas las líneas o uno para esta.`,
    lineId,
  });
}

export function priceMissing(
  lineId: string,
  label: string,
  currency: string,
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    code: PLAN_TEMPLATE_PRICE_MISSING,
    message: `«${label}» no tiene precio en ${currency} para este paciente (ni convenio, ni lista de la sede, ni precio de catálogo): ponle precio en el catálogo o en una lista de precios.`,
    lineId,
  });
}

export function visitOverflow(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: PLAN_TEMPLATE_VISIT_OVERFLOW,
    message: PLAN_TEMPLATE_VISIT_OVERFLOW_MESSAGE,
  });
}

export function catalogItemNotFound(position: number): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    error: 'Not Found',
    code: PLAN_TEMPLATE_CATALOG_ITEM_NOT_FOUND,
    message: `El procedimiento de la línea ${position + 1} no existe en el catálogo de esta clínica.`,
    position,
  });
}

export function notAProcedure(
  position: number,
  label: string,
): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    code: PLAN_TEMPLATE_NOT_A_PROCEDURE,
    message: `«${label}» (línea ${position + 1}) es un diagnóstico, no un procedimiento: una plantilla de plan solo lleva procedimientos.`,
    position,
  });
}

export function unknownLine(lineId: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: PLAN_TEMPLATE_UNKNOWN_LINE,
    message:
      'Una de las líneas indicadas no es de esta plantilla: recarga la vista previa.',
    lineId,
  });
}
