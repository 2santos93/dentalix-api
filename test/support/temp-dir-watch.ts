import { mkdirSync, watch } from 'node:fs';
import { UPLOAD_TEMP_DIR } from '../../src/shared/storage/local-file';

/**
 * DX-259: apunta cada fichero que aparece en el directorio temporal de las
 * subidas mientras corre `fn` (para comprobar que una subida rechazada no
 * llega a escribir nada en disco).
 */
export async function tempFilesCreatedDuring(
  fn: () => Promise<unknown>,
): Promise<string[]> {
  mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
  const created: string[] = [];
  const watcher = watch(UPLOAD_TEMP_DIR, (_event, name) => {
    if (name) created.push(name);
  });
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    watcher.close();
  }
  return created;
}
