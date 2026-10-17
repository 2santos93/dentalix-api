import { HttpException, HttpStatus } from '@nestjs/common';

// Esperas largas (p. ej. la de recuperar la contraseña, 15 min) en minutos, redondeando
// hacia arriba para no invitar a reintentar antes de tiempo.
function humanWait(seconds: number): string {
  if (seconds < 120)
    return `${seconds} ${seconds === 1 ? 'segundo' : 'segundos'}`;
  return `${Math.ceil(seconds / 60)} minutos`;
}

/**
 * 429 con el mismo formato que el resto de errores de la API
 * (`{ statusCode, error, message }`) y el mensaje en español que la web
 * muestra tal cual. El valor exacto en segundos va en `Retry-After`.
 */
export function tooManyRequestsException(
  retryAfterSeconds: number,
): HttpException {
  const status = HttpStatus.TOO_MANY_REQUESTS;
  return new HttpException(
    {
      statusCode: status,
      error: 'Too Many Requests',
      message: `Demasiadas solicitudes. Intenta de nuevo en ${humanWait(retryAfterSeconds)}.`,
    },
    status,
  );
}
