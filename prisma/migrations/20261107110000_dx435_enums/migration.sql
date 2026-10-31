-- DX-435: valores de enum nuevos de la oferta de hueco por enlace.
--
-- Cambios:
--   WaitlistOfferChannel  LINK_WA_ME y LINK_EMAIL (la oferta lleva un enlace
--                         público que el paciente acepta solo).
--   WaitlistOfferOutcome  EXPIRED (el enlace caducó sin respuesta) y
--                         TAKEN_BY_OTHER (otro paciente aceptó antes).
--   EmailTemplate         slot-offer (el email con el enlace).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea (los usan los CHECK de 20261107110100).
--
-- Fecha: posterior a la última migración existente (20261107100100, DX-361).
--
-- Compatible hacia atrás: solo AÑADE valores que el código anterior no conoce
-- ni usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "WaitlistOfferChannel" ADD VALUE IF NOT EXISTS 'LINK_WA_ME';
ALTER TYPE "WaitlistOfferChannel" ADD VALUE IF NOT EXISTS 'LINK_EMAIL';
ALTER TYPE "WaitlistOfferOutcome" ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE "WaitlistOfferOutcome" ADD VALUE IF NOT EXISTS 'TAKEN_BY_OTHER';
ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'slot-offer';
