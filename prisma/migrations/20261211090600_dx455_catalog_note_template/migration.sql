-- DX-455: plantilla de evolución sugerida por procedimiento del catálogo.
--
-- Cambios:
--   dental_catalog_items.clinicalNoteTemplateId  plantilla que la web sugiere
--       al marcar hecho el procedimiento; NULL = ninguna.
--   FK COMPUESTA ("tenantId", "clinicalNoteTemplateId") →
--       clinical_note_templates ("tenantId", "id") (SEC-004/DX-050): la
--       plantilla es de la MISMA clínica. Destino: el UNIQUE
--       clinical_note_templates_tenant_id_key (DX-170). MATCH SIMPLE: con la
--       columna NULL no se comprueba. ON DELETE RESTRICT: las plantillas no se
--       borran, se desactivan (y desactivarla deja el vínculo, que la API deja
--       de sugerir).
--   Índice del lado hijo ("tenantId", "clinicalNoteTemplateId").
--
-- Quitar el vínculo nunca toca las evoluciones guardadas: llevan su texto
-- compuesto en "notes" (DX-038) y su "templateId" propio.
--
-- Compatible hacia atrás: ADD COLUMN NULL sin default, FK que las filas
-- existentes (todas NULL) cumplen, índice. RLS sin cambios.
--
-- FK sobre tablas con RLS FORCE (DX-134): se quita FORCE de la hija y de la
-- referenciada mientras se añade y valida la FK y se repone después, en esta
-- misma transacción. Tablas pequeñas: índice sin CONCURRENTLY.
--
-- Grants: no aplica (tablas existentes).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "dental_catalog_items" ADD COLUMN "clinicalNoteTemplateId" UUID;

ALTER TABLE "dental_catalog_items" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "clinical_note_templates" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "dental_catalog_items" ADD CONSTRAINT "dental_catalog_items_note_template_fkey"
  FOREIGN KEY ("tenantId", "clinicalNoteTemplateId")
  REFERENCES "clinical_note_templates"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "dental_catalog_items" VALIDATE CONSTRAINT "dental_catalog_items_note_template_fkey";

ALTER TABLE "clinical_note_templates" FORCE ROW LEVEL SECURITY;
ALTER TABLE "dental_catalog_items" FORCE ROW LEVEL SECURITY;

CREATE INDEX "dental_catalog_items_tenant_note_template_idx"
  ON "dental_catalog_items"("tenantId", "clinicalNoteTemplateId");
