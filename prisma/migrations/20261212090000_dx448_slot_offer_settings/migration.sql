-- DX-448: la caducidad anticipada de la oferta de hueco por enlace (DX-435)
-- y la antelación mínima para ofrecerlo los elige cada clínica.
--
--   tenants."slotOfferExpiryLeadMinutes"  INTEGER NULL, 0..240
--   tenants."slotOfferMinLeadMinutes"     INTEGER NOT NULL DEFAULT 20, 5..240
--
-- Hasta ahora la caducidad anticipada era una variable de la instalación
-- (WAITLIST_LINK_OFFER_EXPIRY_LEAD_MINUTES) y la antelación mínima, 20 minutos
-- fijos en el código. Desde DX-448 la variable es solo el valor por defecto:
-- NULL = «lo de la instalación», así que las clínicas existentes siguen igual.
-- El 20 de la antelación mínima nace como DEFAULT (lo de siempre).
--
-- `waitlist_offers."expiresAt"` ya se calcula y se guarda al crear la oferta:
-- cambiar el ajuste no toca las ofertas ya enviadas. Sin relleno.
--
-- Expand puro: una columna NULL sin default y otra NOT NULL con DEFAULT
-- constante (PG 16: solo catálogo), con sus CHECK en la misma sentencia (una
-- fila por clínica, milisegundos), como DX-379 ("quoteValidityDays"). Una
-- réplica anterior no nombra las columnas: sigue con la variable y los 20
-- minutos.
--
-- Vuelta atrás (solo si hay que retirar DX-448):
--   1. Primero se despliega la versión anterior de la API, que no lee estas
--      columnas.
--   2. Después, en una transacción con el mismo lock_timeout:
--        ALTER TABLE "tenants"
--          DROP CONSTRAINT "tenants_slot_offer_expiry_lead_minutes_check",
--          DROP CONSTRAINT "tenants_slot_offer_min_lead_minutes_check",
--          DROP COLUMN "slotOfferExpiryLeadMinutes",
--          DROP COLUMN "slotOfferMinLeadMinutes";
--      y se borra de `_prisma_migrations` la fila de esta migración.
--   Se PIERDEN los minutos elegidos por cada clínica (vuelven la variable y
--   los 20 minutos). Las ofertas enviadas conservan su "expiresAt".
--
-- lock_timeout 5 s, como el resto de ALTER de `tenants` (toda petición la lee
-- al resolver la clínica). Si falla, se reintenta el deploy. Grants y RLS:
-- las columnas heredan los de su tabla.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants"
  ADD COLUMN "slotOfferExpiryLeadMinutes" INTEGER,
  ADD COLUMN "slotOfferMinLeadMinutes" INTEGER NOT NULL DEFAULT 20,
  ADD CONSTRAINT "tenants_slot_offer_expiry_lead_minutes_check"
    CHECK ("slotOfferExpiryLeadMinutes" BETWEEN 0 AND 240),
  ADD CONSTRAINT "tenants_slot_offer_min_lead_minutes_check"
    CHECK ("slotOfferMinLeadMinutes" BETWEEN 5 AND 240);
