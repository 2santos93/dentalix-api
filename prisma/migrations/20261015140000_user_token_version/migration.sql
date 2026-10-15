-- SEC-002: versión de sesión por usuario. Se incrementa al cambiar la
-- contraseña y /auth/refresh rechaza los tokens con una versión distinta.
-- Compatible hacia atrás: NOT NULL con DEFAULT 0 (en Postgres 11+ es un cambio
-- solo de catálogo, sin reescribir la tabla), y los tokens emitidos antes de
-- este cambio no traen el claim y se tratan como versión 0.
ALTER TABLE "users" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
