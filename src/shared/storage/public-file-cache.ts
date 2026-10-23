/**
 * DX-259 (OPS-039): caché de los ficheros públicos (avatares).
 *
 * Un avatar con versión en el nombre (`<userId>-<16 hex del contenido>.<ext>`,
 * `set-my-avatar`) nunca cambia de contenido: el navegador lo guarda un año
 * sin volver a preguntar. Uno de antes (`<userId>.<ext>`), 5 minutos y luego
 * revalida con su ETag (304).
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const REVALIDATE_CACHE_CONTROL = 'public, max-age=300';

const VERSIONED_NAME = /-[0-9a-f]{16}\.[a-z]+$/;

/** `Cache-Control` con el que se sirve el avatar `name`. */
export function avatarCacheControl(name: string): string {
  return VERSIONED_NAME.test(name)
    ? IMMUTABLE_CACHE_CONTROL
    : REVALIDATE_CACHE_CONTROL;
}
