-- DX-231 (BE-034): versión optimista de las plantillas de evolución. Aditiva:
-- las filas existentes quedan en la versión 1.
ALTER TABLE "clinical_note_templates" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
