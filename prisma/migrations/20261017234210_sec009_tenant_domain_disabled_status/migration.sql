-- SEC-009: estado DISABLED de un dominio personalizado que estuvo verificado y
-- dejó de pasar la re-verificación periódica (su TXT desapareció). ADD VALUE va
-- solo en su fichero: un valor nuevo no se puede usar en la misma transacción
-- que lo crea. Aditivo: el código anterior no lo escribe (solo lo escribe la
-- tarea programada nueva) y el ruteo ya filtra por status = 'VERIFIED'.
ALTER TYPE "TenantDomainStatus" ADD VALUE IF NOT EXISTS 'DISABLED';
