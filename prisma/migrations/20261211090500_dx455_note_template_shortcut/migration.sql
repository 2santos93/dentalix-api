-- DX-455: atajo opcional de las plantillas de evolución («#resina»).
--
-- Cambios:
--   clinical_note_templates.shortcut  texto tal como lo escribió la clínica
--                                     («#Resina»); NULL = sin atajo.
--   CHECK  "#" + 2 a 30 caracteres sin espacios ni otro "#". El formato fino
--          (letras de cualquier alfabeto, dígitos, "-" y "_") lo valida la
--          API; el CHECK es la red si algo se la saltara.
--   UNIQUE parcial ("tenantId", lower("shortcut")) WHERE "shortcut" IS NOT
--          NULL: dos plantillas de la misma clínica no comparten atajo sin
--          distinguir mayúsculas (#resina = #RESINA); dos clínicas, sí. Incluye
--          las desactivadas: una plantilla desactivada conserva su atajo, así
--          que reactivarla nunca choca. Solo SQL (índice de expresión).
--
-- La regla de prefijos (#re choca con #resina) no cabe en un índice: la
-- aplica el repositorio dentro de la transacción, bajo un candado de asesoría
-- por clínica, y este índice cubre los duplicados exactos.
--
-- Compatible hacia atrás: ADD COLUMN NULL sin default (no reescribe la tabla
-- ni dispara triggers de fila), un CHECK que las filas existentes (todas NULL)
-- cumplen y un índice. La tabla es pequeña (decenas de filas por clínica):
-- CREATE UNIQUE INDEX sin CONCURRENTLY, dentro de la transacción. RLS sin
-- cambios: columna nueva en una tabla que ya la tiene FORCE.
--
-- Grants: no aplica (tabla existente).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "clinical_note_templates" ADD COLUMN "shortcut" TEXT;

ALTER TABLE "clinical_note_templates"
  ADD CONSTRAINT "clinical_note_templates_shortcut_check" CHECK (
    "shortcut" IS NULL OR (
      char_length("shortcut") BETWEEN 3 AND 31
      AND left("shortcut", 1) = '#'
      AND position('#' IN substr("shortcut", 2)) = 0
      AND "shortcut" !~ '[[:space:]]'
    )
  );

CREATE UNIQUE INDEX "clinical_note_templates_tenant_shortcut_key"
  ON "clinical_note_templates" ("tenantId", lower("shortcut"))
  WHERE "shortcut" IS NOT NULL;
