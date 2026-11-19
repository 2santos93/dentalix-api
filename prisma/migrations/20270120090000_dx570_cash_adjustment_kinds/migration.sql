-- DX-570: dos clases nuevas de ajuste de caja para el vuelto de un abono en
-- efectivo (ver 20270120090100_dx570_payment_change):
--   CHANGE_LATE  el vuelto de un abono tardío (fecha de un día cuya caja ya
--                cerró): resta en la caja donde entra su LATE_PAYMENT.
--   CHANGE_VOID  la anulación, con la caja ya cerrada, de un abono que dio
--                vuelto: devuelve ese vuelto (suma) en la caja donde entra su
--                VOID (DX-345).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Compatible hacia atrás: solo AÑADE valores que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "CashAdjustmentKind" ADD VALUE IF NOT EXISTS 'CHANGE_LATE';
ALTER TYPE "CashAdjustmentKind" ADD VALUE IF NOT EXISTS 'CHANGE_VOID';
