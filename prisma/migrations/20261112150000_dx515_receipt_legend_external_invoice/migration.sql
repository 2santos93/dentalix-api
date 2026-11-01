-- DX-515: recibo NO fiscal. Dentalix emite recibos de caja (DX-136), no
-- facturas; la factura válida la emite la clínica fuera de Dentalix. Tres
-- datos nuevos, todos opcionales y sin formato por país:
--
--   tenants."receiptTitle"        título del recibo. NULL = el de siempre
--                                 («Recibo de caja», lo pone la web).
--   tenants."receiptLegend"       leyenda del recibo de la clínica. NULL = no
--                                 se imprime nada (el recibo queda igual que
--                                 antes, byte a byte).
--   locations."receiptLegendOverride" + locations."receiptLegend"
--                                 la sede usa SU leyenda en vez de la de la
--                                 clínica (false = hereda). Con la marca y la
--                                 leyenda a NULL, la sede no imprime ninguna.
--                                 Sin la marca, la leyenda es NULL (CHECK).
--   payments."externalInvoiceNumber"
--                                 nº de la factura fiscal emitida fuera, texto
--                                 libre. Se edita después de emitir el recibo
--                                 (auditado con antes y después); el recibo
--                                 emitido NO cambia (su foto es inmutable).
--
-- Título y leyenda se CONGELAN en la foto del recibo al emitirlo (solo si
-- están configurados): reimprimir un recibo antiguo no añade la leyenda.
--
-- Textos: sin espacios en los extremos, sin caracteres de control (una
-- línea), 1..60 el título, 1..250 la leyenda (cabe entera en el antes y el
-- después de la auditoría, cuyo tope es 255) y 1..64 el nº externo. La API
-- responde antes con 400 en español; esto es la red.
--
-- Expand puro: columnas NULL (o NOT NULL con DEFAULT constante, que en PG 16
-- solo toca el catálogo). Los CHECK se validan en la misma sentencia: con
-- todas las filas a NULL/false no hay nada que leer más allá de un barrido
-- trivial; `payments` es la única tabla grande: su CHECK va NOT VALID aquí
-- y se valida en la migración siguiente (20261112150100), sola, con SHARE
-- UPDATE EXCLUSIVE, que no bloquea lecturas ni escrituras. Una réplica anterior que inserta sin nombrar las columnas
-- recibe NULL/false, que es «sin configurar». Sin trigger UTC (DX-226): no
-- hay fechas. Grants: columnas nuevas de tablas ya concedidas a dentalix_app.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants"
  ADD COLUMN "receiptTitle" TEXT,
  ADD COLUMN "receiptLegend" TEXT,
  ADD CONSTRAINT "tenants_receipt_title_check" CHECK (
    "receiptTitle" IS NULL OR (
      char_length("receiptTitle") BETWEEN 1 AND 60
      AND "receiptTitle" = btrim("receiptTitle")
      AND "receiptTitle" !~ '[[:cntrl:]]'
    )
  ),
  ADD CONSTRAINT "tenants_receipt_legend_check" CHECK (
    "receiptLegend" IS NULL OR (
      char_length("receiptLegend") BETWEEN 1 AND 250
      AND "receiptLegend" = btrim("receiptLegend")
      AND "receiptLegend" !~ '[[:cntrl:]]'
    )
  );

ALTER TABLE "locations"
  ADD COLUMN "receiptLegendOverride" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "receiptLegend" TEXT,
  ADD CONSTRAINT "locations_receipt_legend_check" CHECK (
    ("receiptLegendOverride" OR "receiptLegend" IS NULL)
    AND (
      "receiptLegend" IS NULL OR (
        char_length("receiptLegend") BETWEEN 1 AND 250
        AND "receiptLegend" = btrim("receiptLegend")
        AND "receiptLegend" !~ '[[:cntrl:]]'
      )
    )
  );

ALTER TABLE "payments"
  ADD COLUMN "externalInvoiceNumber" TEXT,
  ADD CONSTRAINT "payments_external_invoice_number_check" CHECK (
    "externalInvoiceNumber" IS NULL OR (
      char_length("externalInvoiceNumber") BETWEEN 1 AND 64
      AND "externalInvoiceNumber" = btrim("externalInvoiceNumber")
      AND "externalInvoiceNumber" !~ '[[:cntrl:]]'
    )
  ) NOT VALID;
