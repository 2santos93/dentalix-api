import type { Prisma } from '@prisma/client';
import {
  dailyRefundWindow,
  type DailyRefundWindow,
} from '../domain/patient-credit';

type Tx = Prisma.TransactionClient;

/**
 * DX-462: bloqueo consultivo (hasta el COMMIT) de (clínica, sede, usuario, día
 * civil de la sede). Es la ÚNICA definición de la clave: producción y pruebas
 * la usan desde aquí.
 */
export async function lockDailyRefundCap(
  tx: Tx,
  scope: {
    tenantId: string;
    locationId: string;
    userId: string;
    day: string;
  },
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(
    hashtext('dx462_refund_cap:' || ${scope.tenantId} || ':' || ${scope.locationId}),
    hashtext(${scope.userId} || ':' || ${scope.day})
  )`;
}

/**
 * Toma el bloqueo del día de la sede y devuelve la ventana de ese día según el
 * reloj inyectado. El reloj se vuelve a leer TRAS esperar el bloqueo: si la
 * espera cruzó la medianoche de la sede, se toma también el bloqueo del día
 * nuevo y manda ese día.
 *
 * Reloj único del tope: el de la aplicación (inyectado) decide el día. El
 * `createdAt` de la devolución lo fija un trigger del servidor (DX-226) con el
 * `now()` de la BD al abrir la transacción y no se puede pasar; en producción
 * ambos relojes coinciden salvo desfase de reloj entre app y BD o una espera
 * de bloqueo que cruce la medianoche de la sede, y en ese caso la devolución
 * puede contar para el día anterior (el lado indulgente, de unos segundos).
 */
export async function lockDailyRefundDay(
  tx: Tx,
  scope: { tenantId: string; locationId: string; userId: string },
  timeZone: string,
  clock: () => Date,
): Promise<{ window: DailyRefundWindow }> {
  let window = dailyRefundWindow(clock(), timeZone);
  for (;;) {
    await lockDailyRefundCap(tx, { ...scope, day: window.day });
    const next = dailyRefundWindow(clock(), timeZone);
    if (next.day === window.day) return { window: next };
    window = next;
  }
}
