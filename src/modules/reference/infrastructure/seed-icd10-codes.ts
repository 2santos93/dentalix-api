import type { PrismaClient } from '@prisma/client';
import { ICD10_ORAL_CODES } from '../domain/icd10-oral-codes';

/**
 * Siembra la tabla global `icd10_codes` (DX-212). Idempotente: upsert por
 * código (conserva las etiquetas existentes, DX-236) y nunca borra: los diagnósticos
 * guardados la referencian con RESTRICT. Corre con el owner (DIRECT_URL) desde
 * `prisma db seed`; la tabla no tiene tenant ni RLS.
 * No consulta usos bajo RLS FORCE: un owner sin tenant no vería todos. Por
 * seguridad conserva también códigos aún no usados. Corregir etiquetas de
 * catálogo existentes exige una migración explícita; las nuevas sí se crean.
 */
export async function seedIcd10Codes(prisma: PrismaClient): Promise<number> {
  for (const { code, labelEs } of ICD10_ORAL_CODES) {
    await prisma.icd10Code.upsert({
      where: { code },
      update: {},
      create: { code, labelEs },
    });
  }
  return ICD10_ORAL_CODES.length;
}
