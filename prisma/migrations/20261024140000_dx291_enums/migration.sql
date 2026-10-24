-- DX-291 (porción 2 de DX-279): estado del cargo por inasistencia o
-- cancelación tardía de una cita.
--
--   CancellationFeeStatus  CHARGED: se generó el cargo (ítem DONE en el plan
--                          «Cargos administrativos»); WAIVED: se condonó con
--                          motivo y ya no se cobrará.
--
-- Compatible hacia atrás: solo AÑADE un tipo que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "CancellationFeeStatus" AS ENUM ('CHARGED', 'WAIVED');
