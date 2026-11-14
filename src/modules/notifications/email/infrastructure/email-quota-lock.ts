import type { Prisma } from '@prisma/client';
import type { QuotaLockScope } from '../domain/ports/email-outbox-repository.port';

/**
 * DX-149-bis: candados consultivos (hasta el COMMIT) de los topes de email de
 * una clínica (DX-088). Es la ÚNICA definición de sus claves. La clínica sale
 * de `app.current_tenant`, el GUC que fija `runWithTenant` con el tenant del
 * contexto, nunca de lo que mande el cliente; el destinatario, de su HMAC
 * (`toHash`). Si el GUC no está fijado en la transacción, según la conexión
 * `current_setting` falla o devuelve '' (una conexión del pool que ya lo tuvo
 * con `set_config(..., true)`): en ese caso el recuento (`''::uuid`) falla y
 * la RLS rechazaría el insert, así que nunca se inserta sin clínica.
 *
 * Mismo esquema de dos claves que DX-462 / DX-247 (`hashtext('<ns>:' ||
 * clínica)`, `hashtext(<sujeto>)`), con espacios de nombres propios:
 * - `dx149_email_recipient:<clínica>` + `toHash`: tope por destinatario
 *   (enfriamiento y diario).
 * - `dx149_email_tenant:<clínica>` + 0: tope diario de la clínica, que cuenta
 *   todos sus destinatarios.
 *
 * Dos reglas para quien lo use (lo hace `insertInTx` con `guard`):
 * 1. UN insert con tope por transacción. Cada insert toma destinatario y luego
 *    clínica; una transacción con dos (R1, T, R2) y otra con R2, T se
 *    esperarían en ciclo (40P01).
 * 2. Solo en READ COMMITTED: el recuento que sigue al candado necesita una
 *    foto nueva por sentencia. En REPEATABLE READ / SERIALIZABLE contaría con
 *    la foto del principio de la transacción y la carrera volvería. Se
 *    comprueba aquí y, si no, falla sin insertar.
 *
 * DX-149-ter: `scope = 'recipient'` toma SOLO el del destinatario (endpoint
 * público: restablecer la contraseña). El orden sigue siendo un prefijo del
 * de siempre (destinatario, luego clínica), así que no abre ningún ciclo con
 * quien toma los dos. Quien lo usa desde una petición pública fija antes un
 * `lock_timeout` corto en su transacción (SET LOCAL): la espera de este
 * candado no retiene una conexión del pool más que eso.
 */
export async function lockEmailQuota(
  tx: Prisma.TransactionClient,
  toHash: string,
  scope: QuotaLockScope = 'recipient-and-tenant',
): Promise<void> {
  const [{ isolation }] = await tx.$queryRaw<{ isolation: string }[]>`
    SELECT current_setting('transaction_isolation') AS isolation`;
  if (isolation !== 'read committed') {
    throw new Error(
      `lockEmailQuota exige READ COMMITTED (la transacción es ${isolation})`,
    );
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(
    hashtext('dx149_email_recipient:' || current_setting('app.current_tenant')),
    hashtext(${toHash})
  )`;
  if (scope === 'recipient') return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(
    hashtext('dx149_email_tenant:' || current_setting('app.current_tenant')),
    0
  )`;
}
