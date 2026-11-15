import { ValidationPipe } from '@nestjs/common';
import { validationExceptionFactory } from './validation-exception.factory';

/**
 * DX-111: qué hace la API con un campo que el DTO no declara.
 *
 * - `strip` (por defecto): lo descarta en silencio (`whitelist`), como hasta
 *   ahora. Varios DTO cuentan con ello para clientes antiguos (p. ej. el texto
 *   libre de aseguradora o `guardianName` del paciente).
 * - `reject`: 400 `VALIDATION_FAILED` con `whitelistValidation` en el campo
 *   (`forbidNonWhitelisted`). Se activa con `VALIDATION_UNKNOWN_FIELDS=reject`
 *   cuando se haya comprobado que ningún cliente manda campos de más (ver el
 *   informe de DX-111).
 */
export type UnknownFieldsMode = 'strip' | 'reject';

export function unknownFieldsMode(
  env: Record<string, string | undefined> = process.env,
): UnknownFieldsMode {
  const raw = env.VALIDATION_UNKNOWN_FIELDS?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'strip') return 'strip';
  if (raw === 'reject') return 'reject';
  throw new Error(
    `VALIDATION_UNKNOWN_FIELDS debe ser «strip» o «reject» (llegó «${raw}»).`,
  );
}

/**
 * La ValidationPipe global de la API (main.ts vía configureApp, y los e2e):
 * `whitelist` + `transform` y el 400 en español con código por campo.
 */
export function createAppValidationPipe(
  mode: UnknownFieldsMode = unknownFieldsMode(),
): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: mode === 'reject',
    transform: true,
    exceptionFactory: validationExceptionFactory,
  });
}
