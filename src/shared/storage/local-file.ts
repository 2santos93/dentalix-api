import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/**
 * DX-259 (OPS-038): las subidas que todavía pasan por la API (avatares, la
 * subida multipart de documentos y la subida directa del disco) las escribe
 * multer en este directorio temporal, no en memoria. El temporal se borra al
 * cerrarse la respuesta (`UploadSlotGuard`).
 */
export const UPLOAD_TEMP_DIR = path.join(tmpdir(), 'dentalix-uploads');

/** SHA-256 y tamaño de un fichero local, leyéndolo en streaming. */
export async function hashLocalFile(
  file: string,
): Promise<{ sha256: Buffer; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest(), size };
}

/** Bytes `[start, end)` de un fichero local (sin leerlo entero). */
export async function readLocalRange(
  file: string,
  start: number,
  end: number,
): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0);
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, end - start, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Borra un temporal; no falla si ya no está. */
export async function removeLocalFile(file: string | undefined): Promise<void> {
  if (!file) return;
  await fs.rm(file, { force: true });
}
