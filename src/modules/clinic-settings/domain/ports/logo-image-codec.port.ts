import type { LogoContentType, LogoOutputType } from '../logo-image';

export const LOGO_IMAGE_CODEC = Symbol('LOGO_IMAGE_CODEC');

/**
 * DX-019-bis: por qué no salió una imagen. `damaged` = no decodifica (o no es
 * del tipo que dicen sus bytes); `dimensions` = pasa de los topes de lado o de
 * píxeles. Nunca el texto de la librería: el mensaje lo pone el dominio.
 */
export type LogoReencodeResult =
  { ok: true; bytes: Buffer } | { ok: false; reason: 'damaged' | 'dimensions' };

/**
 * DX-019-bis: decodifica el logo y lo vuelve a codificar desde los píxeles
 * (`input` ya viene comprobado por `sniffLogo`; `output` lo decide el
 * dominio). Puede rechazar; no debería lanzar (si lanza, es «dañado»).
 */
export interface LogoImageCodec {
  reencode(
    bytes: Buffer,
    types: { input: LogoContentType; output: LogoOutputType },
  ): Promise<LogoReencodeResult>;
}
