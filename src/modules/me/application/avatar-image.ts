/**
 * DX-084: tipo REAL de una imagen de avatar por su cabecera (no por la
 * etiqueta que manda el cliente en el multipart). null si no es PNG, JPEG ni
 * WebP. Así un HTML o un SVG subido como `image/png` no llega al almacén.
 */
export type AvatarImageType = 'image/png' | 'image/jpeg' | 'image/webp';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

export function sniffAvatarImage(bytes: Buffer): AvatarImageType | null {
  if (bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return 'image/png';
  }
  if (bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
