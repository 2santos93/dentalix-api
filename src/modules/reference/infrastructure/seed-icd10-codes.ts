import type { PrismaClient } from '@prisma/client';
import { ICD10_ORAL_CODES } from '../domain/icd10-oral-codes';

/**
 * Siembra la tabla global `icd10_codes` (DX-212). Idempotente: upsert por
 * código (actualiza el texto si cambió) y nunca borra, porque los diagnósticos
 * guardados la referencian con RESTRICT. Corre con el owner (DIRECT_URL) desde
 * `prisma db seed`; la tabla no tiene tenant ni RLS.
 */
export async function seedIcd10Codes(prisma: PrismaClient): Promise<number> {
  for (const { code, labelEs } of ICD10_ORAL_CODES) {
    await prisma.icd10Code.upsert({
      where: { code },
      update: { labelEs },
      create: { code, labelEs },
    });
  }
  return ICD10_ORAL_CODES.length;
}
