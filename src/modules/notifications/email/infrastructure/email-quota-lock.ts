import type { Prisma } from '@prisma/client';

/**
 * DX-149-bis: candados consultivos (hasta el COMMIT) de los topes de email de
 * una clínica (DX-088). Es la ÚNICA definición de sus claves. La clínica sale
 * de `app.current_tenant`, el GUC que fija `runWithTenant` con el tenant del
 * contexto (sin él, `current_setting` falla y no se inserta nada), nunca de lo
 * que mande el cliente; el destinatario, de su HMAC (`toHash`).
 *
 * Mismo esquema de dos claves que DX-462 / DX-247 (`hashtext('<ns>:' ||
 * clínica)`, `hashtext(<sujeto>)`), con espacios de nombres propios:
 * - `dx149_email_recipient:<clínica>` + `toHash`: tope por destinatario
 *   (enfriamiento y diario).
 * - `dx149_email_tenant:<clínica>` + 0: tope diario de la clínica, que cuenta
 *   todos sus destinatarios.
 * Siempre en ese orden, así que dos inserts nunca se esperan en ciclo.
 */
export async function lockEmailQuota(
  tx: Prisma.TransactionClient,
  toHash: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(
    hashtext('dx149_email_recipient:' || current_setting('app.current_tenant')),
    hashtext(${toHash})
  )`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(
    hashtext('dx149_email_tenant:' || current_setting('app.current_tenant')),
    0
  )`;
}
