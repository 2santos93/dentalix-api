-- Siembra la whitelist curada de monedas directamente en la migración. La
-- tabla "currencies" es de solo-lectura para plan-create y record-payment:
-- ambos validan la moneda contra esta tabla y rechazan con 400 "Unknown
-- currency" si el código no existe. Un entorno que corre `prisma migrate
-- deploy` (p. ej. prod/staging) SIN correr `prisma db seed` quedaría con la
-- tabla vacía y tumbaría TODO plan/pago -- por eso la whitelist se garantiza
-- aquí, no solo en prisma/seed.ts. ON CONFLICT DO NOTHING la hace segura de
-- re-correr y no pisa filas ya sembradas (p. ej. por el seed).
INSERT INTO "currencies" ("code", "name", "symbol") VALUES
    ('USD', 'Dólar estadounidense', '$'),
    ('COP', 'Peso colombiano', '$'),
    ('EUR', 'Euro', '€'),
    ('MXN', 'Peso mexicano', '$'),
    ('ARS', 'Peso argentino', '$'),
    ('PEN', 'Sol peruano', 'S/'),
    ('CLP', 'Peso chileno', '$'),
    ('BRL', 'Real brasileño', 'R$'),
    ('GBP', 'Libra esterlina', '£'),
    ('CAD', 'Dólar canadiense', '$')
ON CONFLICT ("code") DO NOTHING;
