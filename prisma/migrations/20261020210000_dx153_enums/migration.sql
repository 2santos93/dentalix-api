-- DX-153: tipo de pagador (catálogo de pagadores por clínica).
--
-- Cambios:
--   PayerType   enum nuevo: MUTUA_ES, PREPAGADA_CO, EPS_CO, EMPRESA, OTRO.
--               OTRO («Otro / sin clasificar») es el tipo de los pagadores que
--               nacen del relleno de patients."insurerEps": el relleno no puede
--               inventar un tipo y el ADMIN los reclasifica desde Ajustes.
--
-- Reglas en la BD: ninguna (solo el tipo; la tabla va en la migración siguiente).
--
-- Compatible hacia atrás: solo AÑADE un enum que el código anterior no usa.
-- Va en fichero aparte del CREATE TABLE que lo usa (molde: dx151_enums).
--
-- Grants: no aplica (un tipo no necesita grants).

SET LOCAL lock_timeout = '5s';

CREATE TYPE "PayerType" AS ENUM ('MUTUA_ES', 'PREPAGADA_CO', 'EPS_CO', 'EMPRESA', 'OTRO');
