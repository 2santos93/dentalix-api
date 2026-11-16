-- DX-572: VALIDATE del CHECK de los días de vencimiento de las órdenes
-- externas de la clínica (añadido NOT VALID en 20261229090200). Va aparte
-- para no sostener el candado de la tabla tenants mientras se recorre:
-- VALIDATE solo toma SHARE UPDATE EXCLUSIVE (no bloquea lecturas ni
-- escrituras). Todas las filas tienen el DEFAULT 15: no puede fallar.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_external_order_overdue_days_check";
