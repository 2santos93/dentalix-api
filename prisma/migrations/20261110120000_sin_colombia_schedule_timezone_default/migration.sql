-- DX-323/DX-325 (producto sin país): la columna LEGADA
-- `location_schedules.timezone` (G1 fase 1; la zona real es
-- `locations."timeZone"`) ya no tiene por defecto la zona de un país. El
-- código siempre la escribe (doble escritura, R20), así que el valor por
-- defecto solo cubriría un INSERT que la omita: pasa a 'UTC', neutro.
-- Solo cambia el DEFAULT; ninguna fila existente se toca.
ALTER TABLE "location_schedules" ALTER COLUMN "timezone" SET DEFAULT 'UTC';
