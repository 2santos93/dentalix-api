import { Injectable } from '@nestjs/common';
import sharp, { type Metadata, type SharpOptions } from 'sharp';
import {
  LOGO_MAX_PIXELS,
  LOGO_MAX_SIDE,
  LOGO_OUTPUT_MAX_SIDE,
  type LogoContentType,
  type LogoOutputType,
} from '../domain/logo-image';
import type {
  LogoImageCodec,
  LogoReencodeResult,
} from '../domain/ports/logo-image-codec.port';

/** El formato que libvips tiene que reconocer para cada tipo que dio el sniff. */
const SNIFFED_FORMAT: Record<LogoContentType, Metadata['format']> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};

/**
 * Decodificación estricta: cualquier aviso de libvips (truncado, CRC, cuerpo
 * corrupto) aborta; tope de píxeles por si la cabecera miente; solo el primer
 * fotograma (APNG/WebP animado quedan estáticos); la orientación EXIF se
 * aplica al decodificar.
 */
const DECODE: SharpOptions = {
  failOn: 'warning',
  limitInputPixels: LOGO_MAX_PIXELS,
  animated: false,
  autoOrient: true,
};

const DAMAGED: LogoReencodeResult = { ok: false, reason: 'damaged' };
const DIMENSIONS: LogoReencodeResult = { ok: false, reason: 'dimensions' };

/**
 * DX-019-bis: el logo pasa por libvips (sharp) de verdad. Primero solo la
 * cabecera (`metadata()`, sin decodificar píxeles): el formato tiene que ser el
 * del sniff y el lado ≤ 4096; después se decodifica, se pasa a sRGB, se
 * reduce a ≤ 1024 px sin agrandar y se vuelve a codificar SIN metadatos
 * (sharp no copia EXIF, XMP, ICC ni comentarios salvo que se le pida).
 */
@Injectable()
export class SharpLogoImageCodec implements LogoImageCodec {
  constructor() {
    // Logos pequeños y pocos: sin caché de operaciones (no retiene píxeles
    // entre subidas) y un hilo de libvips por imagen.
    sharp.cache(false);
    sharp.concurrency(1);
  }

  async reencode(
    bytes: Buffer,
    types: { input: LogoContentType; output: LogoOutputType },
  ): Promise<LogoReencodeResult> {
    let meta: Metadata;
    try {
      // Sin tope de píxeles aquí: solo se lee la cabecera, y así una bomba
      // sale como «demasiado grande», no como «dañado».
      meta = await sharp(bytes, {
        ...DECODE,
        limitInputPixels: false,
      }).metadata();
    } catch {
      return DAMAGED;
    }
    if (meta.format !== SNIFFED_FORMAT[types.input]) return DAMAGED;
    const { width, height } = meta;
    if (!width || !height || width < 1 || height < 1) return DAMAGED;
    if (
      width > LOGO_MAX_SIDE ||
      height > LOGO_MAX_SIDE ||
      width * height > LOGO_MAX_PIXELS
    ) {
      return DIMENSIONS;
    }

    try {
      const image = sharp(bytes, DECODE).toColourspace('srgb').resize({
        width: LOGO_OUTPUT_MAX_SIDE,
        height: LOGO_OUTPUT_MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      });
      const encoded =
        types.output === 'image/png'
          ? image.png({ compressionLevel: 9, adaptiveFiltering: true })
          : image.jpeg({ quality: 90, mozjpeg: true });
      return { ok: true, bytes: await encoded.toBuffer() };
    } catch {
      return DAMAGED;
    }
  }
}
