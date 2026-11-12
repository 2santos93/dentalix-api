-- DX-015-bis (porción 2): tipo de recurso de auditoría de los tipos de recall
-- (alta, edición, retirada y cambio de disparadores en Ajustes › Recall, D14).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (su índice parcial: 20261213090100).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'RECALL_TYPE';
