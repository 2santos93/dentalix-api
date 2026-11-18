-- DX-560: VALIDATE del CHECK que 20270110140100 dejó NOT VALID. Va en su
-- propia transacción: SHARE UPDATE EXCLUSIVE lee la tabla sin bloquear las
-- escrituras (molde de DX-290 / DX-561). Todas las filas anteriores tienen
-- "budgetPresentation" NULL.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "signature_requests"
  VALIDATE CONSTRAINT "signature_requests_budget_presentation_check";
