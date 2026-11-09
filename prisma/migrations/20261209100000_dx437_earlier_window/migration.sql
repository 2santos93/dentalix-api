-- DX-437: el paciente pide adelantar su cita desde el enlace de confirmación.
--
--   appointments."earlierWindow"       enum NULL   MORNING | AFTERNOON | ANY:
--                                                  la franja en la que quiere
--                                                  el hueco (solo con
--                                                  "wantsEarlier")
--   appointments."earlierRequestedAt"  TIMESTAMP   cuándo lo pidió EL PACIENTE
--                                      NULL        desde el enlace; NULL = lo
--                                                  marcó el personal (DX-210)
--
-- Aditiva: columnas NULL sin relleno; se limpian al quitar la marca o al
-- adelantar la cita. La regla de candidatos (DX-210) filtra por la franja.
CREATE TYPE "EarlierWindow" AS ENUM ('MORNING', 'AFTERNOON', 'ANY');

ALTER TABLE "appointments"
  ADD COLUMN "earlierWindow" "EarlierWindow",
  ADD COLUMN "earlierRequestedAt" TIMESTAMP(3);
