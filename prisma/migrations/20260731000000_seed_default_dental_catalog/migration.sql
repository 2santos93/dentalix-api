-- Backfill del catálogo semilla de procedimientos y diagnósticos odontológicos
-- para los tenants YA existentes. Mismo motivo que 20260727130000_seed_currencies:
-- prod/staging corren `prisma migrate deploy` pero NO `prisma db seed`, así que
-- los datos de arranque se garantizan en una migración, no solo en el seed.
--
-- La lista es la MISMA fuente de verdad que src/shared/catalog/default-dental-catalog.ts
-- (las clínicas NUEVAS reciben el catálogo en el alta, createClinicWithOwner);
-- este archivo solo pone al día a las clínicas creadas antes de esa lógica.
--
-- dental_catalog_items tiene FORCE ROW LEVEL SECURITY: hasta el owner que corre
-- la migración queda sujeto a la policy `tenant_isolation`
-- (WITH CHECK "tenantId" = current_setting('app.current_tenant')). Por eso NO se
-- desactiva la RLS: se recorre cada tenant seteando el GUC de contexto (igual que
-- hace la app) antes de insertar sus filas. set_config(..., true) es local a la
-- transacción de la migración.
--
-- Idempotente: ON CONFLICT sobre el índice único PARCIAL catalog_tenant_code_key
-- (incluye el predicado WHERE "deletedAt" IS NULL) => re-correr no duplica ni pisa.

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT "id" FROM "tenants" WHERE "deletedAt" IS NULL LOOP
    PERFORM set_config('app.current_tenant', t."id"::text, true);

    INSERT INTO "dental_catalog_items"
      ("id", "tenantId", "code", "category", "kind",
       "labelEs", "labelEn", "labelPt", "color", "active", "createdAt", "updatedAt")
    SELECT
      gen_random_uuid(), t."id", v.code, v.category, v.kind::"CatalogKind",
      v."labelEs", v."labelEn", v."labelPt", v.color, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM (VALUES
      ('DX-CARIES', 'Diagnóstico', 'DIAGNOSIS', 'Caries dental', 'Dental caries', 'Cárie dentária', '#BE123C'),
      ('DX-CARIES-INC', 'Diagnóstico', 'DIAGNOSIS', 'Caries incipiente', 'Incipient caries', 'Cárie incipiente', '#F97316'),
      ('DX-REST-DEF', 'Diagnóstico', 'DIAGNOSIS', 'Restauración defectuosa', 'Defective restoration', 'Restauração defeituosa', '#A16207'),
      ('DX-FRACT', 'Diagnóstico', 'DIAGNOSIS', 'Fractura dental', 'Tooth fracture', 'Fratura dentária', '#7C2D12'),
      ('DX-PERIAPICAL', 'Diagnóstico', 'DIAGNOSIS', 'Lesión periapical', 'Periapical lesion', 'Lesão periapical', '#9333EA'),
      ('DX-ABSCESO', 'Diagnóstico', 'DIAGNOSIS', 'Absceso dental', 'Dental abscess', 'Abscesso dentário', '#7E22CE'),
      ('DX-MOVILIDAD', 'Diagnóstico', 'DIAGNOSIS', 'Movilidad dental', 'Tooth mobility', 'Mobilidade dentária', '#DB2777'),
      ('DX-AUSENTE', 'Diagnóstico', 'DIAGNOSIS', 'Diente ausente', 'Missing tooth', 'Dente ausente', '#6B7280'),
      ('DX-RETENIDO', 'Diagnóstico', 'DIAGNOSIS', 'Diente retenido/incluido', 'Impacted tooth', 'Dente retido', '#4B5563'),
      ('DX-RESTO-RAD', 'Diagnóstico', 'DIAGNOSIS', 'Resto radicular', 'Root remnant', 'Resto radicular', '#78716C'),
      ('DX-GINGIVITIS', 'Diagnóstico', 'DIAGNOSIS', 'Gingivitis', 'Gingivitis', 'Gengivite', '#EF4444'),
      ('DX-PERIODONTITIS', 'Diagnóstico', 'DIAGNOSIS', 'Periodontitis', 'Periodontitis', 'Periodontite', '#B91C1C'),
      ('DX-RECESION', 'Diagnóstico', 'DIAGNOSIS', 'Recesión gingival', 'Gingival recession', 'Recessão gengival', '#E11D48'),
      ('DX-CALCULO', 'Diagnóstico', 'DIAGNOSIS', 'Cálculo / sarro', 'Calculus (tartar)', 'Cálculo (tártaro)', '#CA8A04'),
      ('DX-DESGASTE', 'Diagnóstico', 'DIAGNOSIS', 'Desgaste dental', 'Tooth wear', 'Desgaste dentário', '#92400E'),
      ('DX-SENSIBILIDAD', 'Diagnóstico', 'DIAGNOSIS', 'Sensibilidad dentinaria', 'Dentin sensitivity', 'Sensibilidade dentinária', '#0891B2'),
      ('DX-MALOCLUSION', 'Diagnóstico', 'DIAGNOSIS', 'Maloclusión', 'Malocclusion', 'Má oclusão', '#7C3AED'),
      ('DX-PIGMENTACION', 'Diagnóstico', 'DIAGNOSIS', 'Pigmentación dental', 'Tooth discoloration', 'Pigmentação dentária', '#57534E'),
      ('DX-ERUPCION', 'Diagnóstico', 'DIAGNOSIS', 'Diente en erupción', 'Erupting tooth', 'Dente em erupção', '#16A34A'),
      ('IMG-CONSULTA', 'Diagnóstico e imágenes', 'PROCEDURE', 'Consulta y valoración', 'Consultation & exam', 'Consulta e avaliação', '#0E7490'),
      ('IMG-RX-PERIAPICAL', 'Diagnóstico e imágenes', 'PROCEDURE', 'Radiografía periapical', 'Periapical X-ray', 'Radiografia periapical', '#0E7490'),
      ('IMG-RX-PANORAMICA', 'Diagnóstico e imágenes', 'PROCEDURE', 'Radiografía panorámica', 'Panoramic X-ray', 'Radiografia panorâmica', '#0E7490'),
      ('IMG-RX-BITEWING', 'Diagnóstico e imágenes', 'PROCEDURE', 'Radiografía de aleta mordida', 'Bitewing X-ray', 'Radiografia interproximal', '#0E7490'),
      ('IMG-RX-OCLUSAL', 'Diagnóstico e imágenes', 'PROCEDURE', 'Radiografía oclusal', 'Occlusal X-ray', 'Radiografia oclusal', '#0E7490'),
      ('IMG-CBCT', 'Diagnóstico e imágenes', 'PROCEDURE', 'Tomografía (CBCT)', 'CBCT scan', 'Tomografia (TCFC)', '#0E7490'),
      ('IMG-MODELOS', 'Diagnóstico e imágenes', 'PROCEDURE', 'Modelos de estudio', 'Study models', 'Modelos de estudo', '#0E7490'),
      ('IMG-FOTOS', 'Diagnóstico e imágenes', 'PROCEDURE', 'Fotografías clínicas', 'Clinical photographs', 'Fotografias clínicas', '#0E7490'),
      ('PREV-PROFILAXIS', 'Prevención', 'PROCEDURE', 'Profilaxis (limpieza dental)', 'Prophylaxis (cleaning)', 'Profilaxia (limpeza)', '#16A34A'),
      ('PREV-FLUOR', 'Prevención', 'PROCEDURE', 'Aplicación de flúor', 'Fluoride application', 'Aplicação de flúor', '#16A34A'),
      ('PREV-SELLANTE', 'Prevención', 'PROCEDURE', 'Sellante de fosas y fisuras', 'Pit & fissure sealant', 'Selante de fóssulas e fissuras', '#16A34A'),
      ('PREV-HIGIENE', 'Prevención', 'PROCEDURE', 'Instrucción de higiene oral', 'Oral hygiene instruction', 'Instrução de higiene oral', '#16A34A'),
      ('OP-RESINA-1', 'Operatoria', 'PROCEDURE', 'Resina 1 superficie', 'Composite filling (1 surface)', 'Restauração em resina (1 face)', '#2563EB'),
      ('OP-RESINA-2', 'Operatoria', 'PROCEDURE', 'Resina 2 superficies', 'Composite filling (2 surfaces)', 'Resina (2 faces)', '#2563EB'),
      ('OP-RESINA-3', 'Operatoria', 'PROCEDURE', 'Resina 3+ superficies', 'Composite filling (3+ surfaces)', 'Resina (3+ faces)', '#2563EB'),
      ('OP-INCRUSTACION', 'Operatoria', 'PROCEDURE', 'Incrustación (inlay/onlay)', 'Inlay / onlay', 'Incrustação (inlay/onlay)', '#2563EB'),
      ('OP-POSTE', 'Operatoria', 'PROCEDURE', 'Reconstrucción con poste', 'Post & core buildup', 'Reconstrução com pino', '#2563EB'),
      ('OP-RECUB-PULPAR', 'Operatoria', 'PROCEDURE', 'Recubrimiento pulpar', 'Pulp capping', 'Capeamento pulpar', '#2563EB'),
      ('ENDO-UNI', 'Endodoncia', 'PROCEDURE', 'Endodoncia unirradicular', 'Root canal (single canal)', 'Endodontia unirradicular', '#DC2626'),
      ('ENDO-BI', 'Endodoncia', 'PROCEDURE', 'Endodoncia birradicular', 'Root canal (two canals)', 'Endodontia birradicular', '#DC2626'),
      ('ENDO-MULTI', 'Endodoncia', 'PROCEDURE', 'Endodoncia multirradicular (molar)', 'Root canal (molar)', 'Endodontia multirradicular', '#DC2626'),
      ('ENDO-RETRAT', 'Endodoncia', 'PROCEDURE', 'Retratamiento endodóntico', 'Endodontic retreatment', 'Retratamento endodôntico', '#DC2626'),
      ('ENDO-PULPOTOMIA', 'Endodoncia', 'PROCEDURE', 'Pulpotomía', 'Pulpotomy', 'Pulpotomia', '#DC2626'),
      ('ENDO-PULPECTOMIA', 'Endodoncia', 'PROCEDURE', 'Pulpectomía', 'Pulpectomy', 'Pulpectomia', '#DC2626'),
      ('ENDO-BLANQ-INT', 'Endodoncia', 'PROCEDURE', 'Blanqueamiento interno', 'Internal bleaching', 'Clareamento interno', '#DC2626'),
      ('PERIO-RASPADO', 'Periodoncia', 'PROCEDURE', 'Raspado y alisado radicular (por cuadrante)', 'Scaling & root planing (per quadrant)', 'Raspagem e alisamento radicular (por quadrante)', '#DB2777'),
      ('PERIO-CURETAJE', 'Periodoncia', 'PROCEDURE', 'Curetaje periodontal', 'Periodontal curettage', 'Curetagem periodontal', '#DB2777'),
      ('PERIO-COLGAJO', 'Periodoncia', 'PROCEDURE', 'Cirugía de colgajo periodontal', 'Periodontal flap surgery', 'Cirurgia de retalho periodontal', '#DB2777'),
      ('PERIO-GINGIVECTOMIA', 'Periodoncia', 'PROCEDURE', 'Gingivectomía', 'Gingivectomy', 'Gengivectomia', '#DB2777'),
      ('PERIO-INJERTO-GING', 'Periodoncia', 'PROCEDURE', 'Injerto gingival', 'Gingival graft', 'Enxerto gengival', '#DB2777'),
      ('PERIO-ALARGAMIENTO', 'Periodoncia', 'PROCEDURE', 'Alargamiento de corona', 'Crown lengthening', 'Aumento de coroa clínica', '#DB2777'),
      ('PERIO-MANTENIMIENTO', 'Periodoncia', 'PROCEDURE', 'Mantenimiento periodontal', 'Periodontal maintenance', 'Manutenção periodontal', '#DB2777'),
      ('CX-EXO-SIMPLE', 'Cirugía oral', 'PROCEDURE', 'Exodoncia simple', 'Simple extraction', 'Exodontia simples', '#7C3AED'),
      ('CX-EXO-QUIRURGICA', 'Cirugía oral', 'PROCEDURE', 'Exodoncia quirúrgica', 'Surgical extraction', 'Exodontia cirúrgica', '#7C3AED'),
      ('CX-CORDAL-ERUP', 'Cirugía oral', 'PROCEDURE', 'Extracción de cordal erupcionado', 'Erupted third molar extraction', 'Extração de siso irrompido', '#7C3AED'),
      ('CX-CORDAL-INCL', 'Cirugía oral', 'PROCEDURE', 'Extracción de cordal incluido', 'Impacted third molar extraction', 'Extração de siso incluso', '#7C3AED'),
      ('CX-FRENILLECTOMIA', 'Cirugía oral', 'PROCEDURE', 'Frenillectomía', 'Frenectomy', 'Frenectomia', '#7C3AED'),
      ('CX-BIOPSIA', 'Cirugía oral', 'PROCEDURE', 'Biopsia oral', 'Oral biopsy', 'Biópsia oral', '#7C3AED'),
      ('CX-DRENAJE', 'Cirugía oral', 'PROCEDURE', 'Drenaje de absceso', 'Abscess drainage', 'Drenagem de abscesso', '#7C3AED'),
      ('CX-ALVEOLOPLASTIA', 'Cirugía oral', 'PROCEDURE', 'Alveoloplastia', 'Alveoloplasty', 'Alveoloplastia', '#7C3AED'),
      ('CX-APICECTOMIA', 'Cirugía oral', 'PROCEDURE', 'Apicectomía', 'Apicoectomy', 'Apicectomia', '#7C3AED'),
      ('PROT-CORONA-MP', 'Prótesis', 'PROCEDURE', 'Corona metal-porcelana', 'Porcelain-fused-to-metal crown', 'Coroa metalocerâmica', '#CA8A04'),
      ('PROT-CORONA-LM', 'Prótesis', 'PROCEDURE', 'Corona libre de metal', 'All-ceramic crown', 'Coroa livre de metal', '#CA8A04'),
      ('PROT-CORONA-PROV', 'Prótesis', 'PROCEDURE', 'Corona provisional', 'Provisional crown', 'Coroa provisória', '#CA8A04'),
      ('PROT-PPR-ACRILICA', 'Prótesis', 'PROCEDURE', 'Prótesis parcial removible acrílica', 'Acrylic removable partial denture', 'Prótese parcial removível acrílica', '#CA8A04'),
      ('PROT-PPR-METALICA', 'Prótesis', 'PROCEDURE', 'Prótesis parcial removible metálica', 'Cast metal partial denture', 'Prótese parcial removível metálica', '#CA8A04'),
      ('PROT-TOTAL', 'Prótesis', 'PROCEDURE', 'Prótesis total (dentadura completa)', 'Complete denture', 'Prótese total', '#CA8A04'),
      ('PROT-PUENTE', 'Prótesis', 'PROCEDURE', 'Puente fijo (por unidad)', 'Fixed bridge (per unit)', 'Ponte fixa (por elemento)', '#CA8A04'),
      ('PROT-POSTE-MUNON', 'Prótesis', 'PROCEDURE', 'Poste y muñón', 'Post & core', 'Núcleo (pino e coto)', '#CA8A04'),
      ('PROT-REPARACION', 'Prótesis', 'PROCEDURE', 'Reparación de prótesis', 'Denture repair', 'Reparo de prótese', '#CA8A04'),
      ('PROT-REBASE', 'Prótesis', 'PROCEDURE', 'Rebase de prótesis', 'Denture reline', 'Reembasamento de prótese', '#CA8A04'),
      ('IMPL-IMPLANTE', 'Implantología', 'PROCEDURE', 'Implante dental', 'Dental implant placement', 'Implante dentário', '#0D9488'),
      ('IMPL-CORONA', 'Implantología', 'PROCEDURE', 'Corona sobre implante', 'Implant-supported crown', 'Coroa sobre implante', '#0D9488'),
      ('IMPL-INJERTO-OSEO', 'Implantología', 'PROCEDURE', 'Injerto óseo', 'Bone graft', 'Enxerto ósseo', '#0D9488'),
      ('IMPL-ELEV-SENO', 'Implantología', 'PROCEDURE', 'Elevación de seno maxilar', 'Sinus lift', 'Levantamento de seio maxilar', '#0D9488'),
      ('IMPL-PILAR', 'Implantología', 'PROCEDURE', 'Pilar / aditamento', 'Implant abutment', 'Pilar (abutment)', '#0D9488'),
      ('ORTO-VALORACION', 'Ortodoncia', 'PROCEDURE', 'Valoración ortodóntica', 'Orthodontic assessment', 'Avaliação ortodôntica', '#9333EA'),
      ('ORTO-BRACKETS-MET', 'Ortodoncia', 'PROCEDURE', 'Ortodoncia con brackets metálicos', 'Metal braces', 'Aparelho fixo metálico', '#9333EA'),
      ('ORTO-BRACKETS-EST', 'Ortodoncia', 'PROCEDURE', 'Ortodoncia con brackets estéticos', 'Ceramic braces', 'Aparelho estético', '#9333EA'),
      ('ORTO-ALINEADORES', 'Ortodoncia', 'PROCEDURE', 'Ortodoncia con alineadores', 'Clear aligners', 'Alinhadores', '#9333EA'),
      ('ORTO-CONTROL', 'Ortodoncia', 'PROCEDURE', 'Control / ajuste mensual', 'Monthly adjustment', 'Ajuste mensal', '#9333EA'),
      ('ORTO-RETENEDOR', 'Ortodoncia', 'PROCEDURE', 'Retenedores', 'Retainers', 'Contenções', '#9333EA'),
      ('ORTO-ORTOPEDIA', 'Ortodoncia', 'PROCEDURE', 'Aparatología ortopédica funcional', 'Functional/orthopedic appliance', 'Aparelho ortopédico funcional', '#9333EA'),
      ('PED-CONSULTA', 'Odontopediatría', 'PROCEDURE', 'Consulta odontopediátrica', 'Pediatric consultation', 'Consulta odontopediátrica', '#F59E0B'),
      ('PED-PROFILAXIS', 'Odontopediatría', 'PROCEDURE', 'Profilaxis pediátrica', 'Pediatric prophylaxis', 'Profilaxia pediátrica', '#F59E0B'),
      ('PED-FLUOR', 'Odontopediatría', 'PROCEDURE', 'Aplicación de flúor pediátrico', 'Pediatric fluoride', 'Flúor pediátrico', '#F59E0B'),
      ('PED-SELLANTE', 'Odontopediatría', 'PROCEDURE', 'Sellante pediátrico', 'Pediatric sealant', 'Selante pediátrico', '#F59E0B'),
      ('PED-CORONA-ACERO', 'Odontopediatría', 'PROCEDURE', 'Corona de acero pediátrica', 'Stainless steel crown', 'Coroa de aço pediátrica', '#F59E0B'),
      ('PED-PULPOTOMIA', 'Odontopediatría', 'PROCEDURE', 'Pulpotomía pediátrica', 'Pediatric pulpotomy', 'Pulpotomia pediátrica', '#F59E0B'),
      ('PED-MANTENEDOR', 'Odontopediatría', 'PROCEDURE', 'Mantenedor de espacio', 'Space maintainer', 'Mantenedor de espaço', '#F59E0B'),
      ('EST-BLANQ-CONSULTORIO', 'Estética', 'PROCEDURE', 'Blanqueamiento en consultorio', 'In-office whitening', 'Clareamento em consultório', '#06B6D4'),
      ('EST-BLANQ-CASA', 'Estética', 'PROCEDURE', 'Blanqueamiento ambulatorio (casa)', 'Take-home whitening', 'Clareamento caseiro', '#06B6D4'),
      ('EST-CARILLA-RESINA', 'Estética', 'PROCEDURE', 'Carilla de resina', 'Composite veneer', 'Faceta em resina', '#06B6D4'),
      ('EST-CARILLA-PORCELANA', 'Estética', 'PROCEDURE', 'Carilla de porcelana', 'Porcelain veneer', 'Faceta de porcelana', '#06B6D4'),
      ('EST-DISENO-SONRISA', 'Estética', 'PROCEDURE', 'Diseño de sonrisa', 'Smile design', 'Planejamento de sorriso', '#06B6D4'),
      ('URG-CONSULTA', 'Urgencias', 'PROCEDURE', 'Consulta de urgencia', 'Emergency visit', 'Consulta de urgência', '#EA580C'),
      ('URG-DOLOR', 'Urgencias', 'PROCEDURE', 'Manejo del dolor', 'Pain management', 'Controle da dor', '#EA580C'),
      ('URG-RECEMENTADO', 'Urgencias', 'PROCEDURE', 'Recementado de corona/puente', 'Crown/bridge re-cementation', 'Recimentação de coroa/ponte', '#EA580C')
    ) AS v(code, category, kind, "labelEs", "labelEn", "labelPt", color)
    ON CONFLICT ("tenantId", "code") WHERE "deletedAt" IS NULL DO NOTHING;
  END LOOP;
END $$;
