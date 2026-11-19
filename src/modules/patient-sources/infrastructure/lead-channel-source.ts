import type { Prisma } from '@prisma/client';
import { LEAD_CHANNEL_SOURCE_KEY } from '../domain/patient-source';

/**
 * DX-172: la fuente sembrada que corresponde al canal de un prospecto
 * (DX-556), si la clínica la tiene ACTIVA; si no, null (el paciente nace sin
 * fuente y la recepción la fija después). En la transacción de la conversión.
 */
export async function leadChannelSourceInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  channel: string,
): Promise<string | null> {
  const systemKey = LEAD_CHANNEL_SOURCE_KEY[channel] ?? null;
  if (!systemKey) return null;
  await tx.$queryRaw`SELECT public.dx_patient_sources_ensure(${tenantId}::uuid)`;
  const source = await tx.patientSource.findFirst({
    where: { tenantId, systemKey, isActive: true },
    select: { id: true },
  });
  return source?.id ?? null;
}
