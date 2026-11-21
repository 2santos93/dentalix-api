-- DX-585: fuente de tasa «BCV oficial». Con BCV, VES y EUR salen de la tasa
-- que publica el Banco Central de Venezuela (tabla bcv_rate_snapshots, en la
-- migración siguiente) y el resto de monedas, del proveedor automático.
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Ningún CHECK enumera las fuentes: tenants_manual_exchange_rates_since_check
-- ata "manualExchangeRatesSince" solo a MANUAL (con BCV va NULL, como con
-- AUTOMATIC), y las columnas de tasa congelada de payments, payment_change_lines,
-- treatment_plan_items y treatment_plan_repricings son del tipo enum, sin CHECK
-- de valores. No hay nada que redefinir.
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.
-- Vuelta atrás: no hace falta (un valor de enum sin usar no molesta).

SET LOCAL lock_timeout = '5s';

ALTER TYPE "ExchangeRateSource" ADD VALUE IF NOT EXISTS 'BCV';
