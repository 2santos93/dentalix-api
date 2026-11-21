/**
 * DX-053: qué sale en la exportación de la clínica. Un CSV por entidad, con
 * cabeceras en español y las columnas en orden fijo. Cada fichero es una
 * consulta de SOLO LECTURA sobre una tabla base (alias `t`, con "id" UUID y
 * "tenantId") y sus uniones para dar nombres legibles; el exportador la
 * recorre por páginas (`t."id" > último`, ver `pageQuery`) con el filtro
 * explícito `t."tenantId" = $1` además de la RLS.
 *
 * Reglas (las comprueban export-catalog.spec.ts y clinic-exports.int-spec.ts):
 * - El SQL es CONSTANTE (nada del usuario se interpola): los únicos valores
 *   variables van como parámetros ($1 clínica, $2 último id, $3 tamaño).
 * - Cada unión a una tabla de clínica lleva `"tenantId" = t."tenantId"`.
 * - Nunca un secreto: ni hashes (de contraseña, de tokens, de contenido), ni
 *   tokens, ni claves de MFA, ni claves del almacén, ni firmas (imágenes), ni
 *   IP o navegador. `FORBIDDEN_SQL` lo vigila en cada columna.
 * - Se exporta TODO lo de la clínica, también lo archivado, retirado
 *   ("deletedAt") o anulado, con la fecha en su columna: es su historia y la
 *   necesita entera para llevársela a otro sistema.
 */

/** Cómo se escribe la celda (ver csv-format.ts). */
export type ExportColumnKind =
  /** Texto (también ids y códigos de enumerado), entre comillas y sin fórmulas. */
  | 'text'
  /** Entero, sin comillas. */
  | 'int'
  /** Número decimal exacto (cantidades, mm, %), sin comillas. */
  | 'decimal'
  /** Importe con los decimales de su moneda (`currency`). */
  | 'amount'
  /** «Sí» / «No». */
  | 'bool'
  /** Día civil `AAAA-MM-DD`. */
  | 'date'
  /** Instante ISO 8601 con el desfase de la zona de la sede de la fila (o Z). */
  | 'instant'
  /** Lista (array de Postgres) unida con « | ». */
  | 'list'
  /** Objeto JSON tal cual (antecedentes estructurados, alertas). */
  | 'json';

export interface ExportColumn {
  header: string;
  /** Expresión SQL sobre `t` y las uniones del fichero. */
  sql: string;
  kind: ExportColumnKind;
  /** Solo `amount`: expresión SQL con el código ISO 4217 de la moneda. */
  currency?: string;
}

export interface ExportTable {
  /** Nombre del fichero dentro del ZIP. */
  file: string;
  /** Una línea para el LEEME. */
  description: string;
  /** Tabla base (`t`) y sus uniones, sin WHERE. */
  from: string;
  /** Zona IANA de la fila para los instantes; sin ella, UTC. */
  zone?: string;
  columns: ExportColumn[];
}

const text = (header: string, sql: string): ExportColumn => ({
  header,
  sql,
  kind: 'text',
});
const int = (header: string, sql: string): ExportColumn => ({
  header,
  sql,
  kind: 'int',
});
const decimal = (header: string, sql: string): ExportColumn => ({
  header,
  sql,
  kind: 'decimal',
});
const amount = (
  header: string,
  sql: string,
  currency: string,
): ExportColumn => ({ header, sql, kind: 'amount', currency });
const bool = (header: string, sql: string): ExportColumn => ({
  header,
  sql,
  kind: 'bool',
});
const date = (header: string, sql: string): ExportColumn => ({
  header,
  sql,
  kind: 'date',
});
const instant = (header: string, sql: string): ExportColumn => ({
  header,
  sql,
  kind: 'instant',
});
const list = (header: string, sql: string): ExportColumn => ({
  header,
  sql,
  kind: 'list',
});
const json = (header: string, sql: string): ExportColumn => ({
  header,
  sql,
  kind: 'json',
});

/** Unión al paciente de la fila (código y nombre legibles en cada fichero). */
const PATIENT_JOIN = `LEFT JOIN "patients" p ON p."id" = t."patientId" AND p."tenantId" = t."tenantId"`;
const PATIENT_COLUMNS: ExportColumn[] = [
  text('Paciente (id)', 't."patientId"'),
  int('Código de paciente', 'p."patientCode"'),
  text(
    'Paciente',
    `NULLIF(btrim(concat_ws(' ', p."firstName", p."lastName")), '')`,
  ),
];
/** Unión a la sede de la fila: su nombre y su zona para los instantes. */
const LOCATION_JOIN = `LEFT JOIN "locations" loc ON loc."id" = t."locationId" AND loc."tenantId" = t."tenantId"`;
const LOCATION_ZONE = 'loc."timeZone"';
const LOCATION_COLUMN = text('Sede', 'loc."name"');

/** Nombre de un usuario (personal) por su id; `users` no es de clínica. */
const userName = (column: string): string =>
  `(SELECT u."fullName" FROM "users" u WHERE u."id" = ${column})`;
/** Nombre del usuario de una membresía de la clínica. */
const memberName = (column: string): string =>
  `(SELECT u."fullName" FROM "clinic_memberships" m JOIN "users" u ON u."id" = m."userId" WHERE m."id" = ${column} AND m."tenantId" = t."tenantId")`;
/** Código de otro paciente de la clínica. */
const patientCode = (column: string): string =>
  `(SELECT x."patientCode" FROM "patients" x WHERE x."id" = ${column} AND x."tenantId" = t."tenantId")`;

export const EXPORT_CATALOG: readonly ExportTable[] = [
  // -------------------------------------------------------------------------
  // Clínica
  // -------------------------------------------------------------------------
  {
    file: 'sedes.csv',
    description: 'Sedes de la clínica.',
    from: '"locations" t',
    zone: 't."timeZone"',
    columns: [
      text('Id', 't."id"'),
      text('Nombre', 't."name"'),
      text('Dirección', 't."address"'),
      text('Teléfono', 't."phone"'),
      text('País', 't."countryCode"'),
      text('Moneda', 't."currency"'),
      text('Zona horaria', 't."timeZone"'),
      text('Formato regional', 't."locale"'),
      text('Registro sanitario', 't."healthRegistrationNumber"'),
      bool('Activa', 't."isActive"'),
      instant('Creada el', 't."createdAt"'),
      instant('Retirada el', 't."deletedAt"'),
    ],
  },
  {
    file: 'personal.csv',
    description:
      'Personal de la clínica: rol, permisos, colegiatura y sedes asignadas (sin contraseñas ni MFA).',
    from: '"clinic_memberships" t JOIN "users" u ON u."id" = t."userId"',
    columns: [
      text('Id', 't."id"'),
      text('Usuario (id)', 't."userId"'),
      text('Nombre', 'u."fullName"'),
      text('Email', 'u."email"'),
      text('Rol', 't."role"::text'),
      list('Permisos adicionales', 't."extraPermissions"::text[]'),
      text('Colegiatura', 't."professionalLicense"'),
      text('Especialidad', 't."professionalSpecialty"'),
      list(
        'Sedes asignadas',
        `ARRAY(SELECT l."name" FROM "membership_locations" ml JOIN "locations" l ON l."id" = ml."locationId" AND l."tenantId" = ml."tenantId" WHERE ml."membershipId" = t."id" AND ml."tenantId" = t."tenantId" ORDER BY l."name")`,
      ),
      instant('Alta el', 't."createdAt"'),
      instant('Baja el', 't."deletedAt"'),
    ],
  },
  {
    file: 'catalogo.csv',
    description:
      'Catálogo de tratamientos con su precio por defecto (en la moneda del catálogo).',
    from: '"dental_catalog_items" t JOIN "tenants" tn ON tn."id" = t."tenantId"',
    columns: [
      text('Id', 't."id"'),
      text('Código', 't."code"'),
      text('Categoría', 't."category"'),
      text('Tipo', 't."kind"::text'),
      text('Nombre', 't."labelEs"'),
      text('Nombre (inglés)', 't."labelEn"'),
      text('Nombre (portugués)', 't."labelPt"'),
      amount('Precio por defecto', 't."defaultPrice"', 'tn."catalogCurrency"'),
      text('Moneda', 'tn."catalogCurrency"'),
      bool('Activo', 't."active"'),
      bool('Admite descuento', 't."allowDiscount"'),
      instant('Creado el', 't."createdAt"'),
      instant('Retirado el', 't."deletedAt"'),
    ],
  },
  // -------------------------------------------------------------------------
  // Pacientes y captación
  // -------------------------------------------------------------------------
  {
    file: 'pacientes.csv',
    description:
      'Pacientes, también los archivados y los fusionados (con el código del que se conservó), con su fuente y referente.',
    from: `"patients" t
      LEFT JOIN "cities" ci ON ci."id" = t."cityId"
      LEFT JOIN "patient_sources" src ON src."id" = t."sourceId" AND src."tenantId" = t."tenantId"`,
    columns: [
      text('Id', 't."id"'),
      int('Código', 't."patientCode"'),
      text('Nombre', 't."firstName"'),
      text('Apellidos', 't."lastName"'),
      text('Tipo de documento', 't."documentType"::text'),
      text('Nombre del tipo de documento', 't."docTypeLabel"'),
      text('Número de documento', 't."docNumber"'),
      date('Fecha de nacimiento', 't."birthDate"'),
      text('Sexo', 't."sex"::text'),
      text('Teléfono', 't."phone"'),
      text('Teléfono (E.164)', 't."phoneE164"'),
      text('Email', 't."email"'),
      text('Dirección', 't."address"'),
      text('País', 't."countryCode"'),
      text('Ciudad', 'ci."name"'),
      text('Estado civil', 't."maritalStatus"'),
      text('Ocupación', 't."occupation"'),
      text('Idioma preferido', 't."preferredLanguage"'),
      text('Canal de contacto', 't."contactChannel"::text'),
      text('Médico de cabecera', 't."physicianName"'),
      text('Teléfono del médico', 't."physicianPhone"'),
      text('Contacto de emergencia', 't."emergencyContactName"'),
      text('Parentesco del contacto', 't."emergencyContactRelationship"'),
      text('Teléfono de emergencia', 't."emergencyContactPhone"'),
      text('Tutor', 't."guardianName"'),
      text('Documento del tutor', 't."guardianDocNumber"'),
      text('Aseguradora (anterior)', 't."legacyInsurerName"'),
      text('Fuente', 'src."name"'),
      int(
        'Referido por (código de paciente)',
        patientCode('t."referredByPatientId"'),
      ),
      text('Referido por (externo)', 't."referredByName"'),
      bool('Consentimiento de datos', 't."dataConsentAccepted"'),
      instant('Consentimiento de datos el', 't."dataConsentAt"'),
      instant('WhatsApp autorizado el', 't."whatsappOptInAt"'),
      instant('Baja de recordatorios el', 't."reminderOptOutAt"'),
      text('Notas', 't."notes"'),
      instant('Última atención', 't."last_attention_at"'),
      instant('Alta el', 't."createdAt"'),
      instant('Archivado el', 't."deletedAt"'),
      int('Fusionado en (código de paciente)', patientCode('t."mergedIntoId"')),
      instant('Supresión parcial el', 't."partially_suppressed_at"'),
    ],
  },
  {
    file: 'responsables.csv',
    description: 'Responsables y pagadores de cada paciente.',
    from: `"patient_responsible_parties" t ${PATIENT_JOIN}`,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      text('Nombre', 't."fullName"'),
      int(
        'Responsable (código de paciente)',
        patientCode('t."responsiblePatientId"'),
      ),
      text('Parentesco', 't."relationship"::text'),
      text('Tipo de documento', 't."documentType"::text'),
      text('Número de documento', 't."docNumber"'),
      text('Email', 't."email"'),
      text('Teléfono', 't."phone"'),
      bool('Paga', 't."isPayer"'),
      bool('Recibe avisos', 't."receivesNotices"'),
      instant('Alta el', 't."createdAt"'),
      instant('Retirado el', 't."deletedAt"'),
    ],
  },
  {
    file: 'coberturas.csv',
    description: 'Seguros y convenios de cada paciente.',
    from: `"patient_coverages" t ${PATIENT_JOIN}
      LEFT JOIN "payers" py ON py."id" = t."payerId" AND py."tenantId" = t."tenantId"`,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      text('Pagador', 'py."name"'),
      text('Tipo de pagador', 'py."type"::text'),
      text('Plan', 't."planName"'),
      text('Número de afiliado', 't."memberNumber"'),
      text('Titular', 't."policyHolderName"'),
      date('Vigente desde', 't."validFrom"'),
      date('Vigente hasta', 't."validTo"'),
      bool('Principal', 't."isPrimary"'),
      instant('Verificada el', 't."verifiedAt"'),
      text('Notas', 't."notes"'),
      instant('Alta el', 't."createdAt"'),
      instant('Retirada el', 't."deletedAt"'),
    ],
  },
  {
    file: 'fuentes.csv',
    description: '«¿Cómo nos conoció?»: fuentes de captación de pacientes.',
    from: '"patient_sources" t',
    columns: [
      text('Id', 't."id"'),
      text('Nombre', 't."name"'),
      text('Tipo', 't."kind"::text'),
      bool('Activa', 't."isActive"'),
      int('Orden', 't."sortOrder"'),
      instant('Creada el', 't."createdAt"'),
    ],
  },
  {
    file: 'prospectos.csv',
    description:
      'Prospectos (personas interesadas aún no pacientes) y su embudo.',
    from: `"leads" t ${LOCATION_JOIN}
      LEFT JOIN "patients" p ON p."id" = t."patientId" AND p."tenantId" = t."tenantId"`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      LOCATION_COLUMN,
      text('Nombre', 't."fullName"'),
      text('Teléfono', 't."phone"'),
      text('Canal', 't."channel"::text'),
      text('Motivo de interés', 't."interestReason"'),
      text('Etapa', 't."stage"::text'),
      text('Motivo de pérdida', 't."lostReason"'),
      text('Responsable', userName('t."ownerId"')),
      instant('Próxima acción el', 't."nextActionAt"'),
      text('Próxima acción', 't."nextActionNote"'),
      instant('Último contacto el', 't."lastContactAt"'),
      instant('Agendado el', 't."scheduledAt"'),
      instant('Asistió el', 't."attendedAt"'),
      instant('Perdido el', 't."lostAt"'),
      int('Paciente (código)', 'p."patientCode"'),
      instant('Convertido el', 't."convertedAt"'),
      instant('Anonimizado el', 't."anonymizedAt"'),
      instant('Creado el', 't."createdAt"'),
    ],
  },
  // -------------------------------------------------------------------------
  // Historia clínica
  // -------------------------------------------------------------------------
  {
    file: 'antecedentes.csv',
    description:
      'Antecedentes médicos (anamnesis): una fila por versión; los bloques estructurados van en JSON.',
    from: `"medical_history_versions" t ${PATIENT_JOIN}`,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      int('Versión', 't."version"'),
      text('Origen', 't."source"::text'),
      bool('Alerta crítica', 't."hasCriticalAlert"'),
      text('Embarazo', 't."pregnancy"::text'),
      json('Condiciones', 't."conditions"'),
      json('Alergias', 't."allergies"'),
      json('Medicamentos', 't."medications"'),
      json('Hábitos', 't."habits"'),
      json('Cirugías', 't."surgeries"'),
      json('Antecedentes dentales', 't."dentalHistory"'),
      json('Signos vitales', 't."vitalSigns"'),
      json('Alertas de seguridad', 't."safetyFlags"'),
      text('Antecedentes familiares', 't."familyHistory"'),
      text('Notas', 't."notes"'),
      text('Registrado por', userName('t."createdById"')),
      instant('Registrado el', 't."createdAt"'),
      instant('Retirado el', 't."deletedAt"'),
    ],
  },
  {
    file: 'evoluciones.csv',
    description: 'Evoluciones (notas clínicas de cada atención).',
    from: `"clinical_entries" t ${PATIENT_JOIN} ${LOCATION_JOIN}`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      LOCATION_COLUMN,
      instant('Fecha', 't."entryDate"'),
      text('Motivo', 't."reason"'),
      text('Notas', 't."notes"'),
      text('Profesional', userName('t."performedById"')),
      text('Colegiatura', 't."authorProfessionalLicense"'),
      text('Cita (id)', 't."appointmentId"'),
      instant('Creada el', 't."createdAt"'),
      instant('Retirada el', 't."deletedAt"'),
    ],
  },
  {
    file: 'adendas.csv',
    description:
      'Adendas a las evoluciones (correcciones firmadas, nunca se edita la original).',
    from: `"clinical_entry_addenda" t ${PATIENT_JOIN}
      LEFT JOIN "clinical_entries" ce ON ce."id" = t."clinicalEntryId" AND ce."tenantId" = t."tenantId"
      LEFT JOIN "locations" loc ON loc."id" = ce."locationId" AND loc."tenantId" = t."tenantId"`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      text('Evolución (id)', 't."clinicalEntryId"'),
      ...PATIENT_COLUMNS,
      text('Motivo', 't."reason"'),
      text('Texto', 't."text"'),
      text('Autor', userName('t."authorId"')),
      instant('Creada el', 't."createdAt"'),
    ],
  },
  {
    file: 'diagnosticos.csv',
    description: 'Diagnósticos CIE-10 de cada evolución.',
    from: `"clinical_entry_diagnoses" t ${PATIENT_JOIN}`,
    columns: [
      text('Id', 't."id"'),
      text('Evolución (id)', 't."clinicalEntryId"'),
      ...PATIENT_COLUMNS,
      text('CIE-10', 't."icd10Code"'),
      text('Descripción', 't."labelEs"'),
      text('Tipo', 't."kind"::text'),
      text('Diente', 't."toothFdi"'),
      int('Posición', 't."position"'),
      instant('Creado el', 't."createdAt"'),
    ],
  },
  {
    file: 'odontograma.csv',
    description:
      'Odontograma: cada hallazgo o tratamiento por diente y superficie, con su origen y anulaciones.',
    from: `"tooth_records" t ${PATIENT_JOIN}
      LEFT JOIN "dental_catalog_items" cat ON cat."id" = t."catalogItemId" AND cat."tenantId" = t."tenantId"`,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      text('Diente', 't."toothNumber"'),
      list('Superficies', 't."surfaces"::text[]'),
      text('Tipo', 't."kind"::text'),
      text('Código de catálogo', 'cat."code"'),
      text('Descripción', 'cat."labelEs"'),
      text('Estado', 't."status"::text'),
      text('Origen', 't."origin"::text'),
      text('Notas', 't."notes"'),
      text('Evolución (id)', 't."clinicalEntryId"'),
      text('Ítem de plan (id)', 't."sourcePlanItemId"'),
      text('Anula el registro (id)', 't."voidsRecordId"'),
      text('Motivo de anulación', 't."voidReason"'),
      text('Profesional', userName('t."performedById"')),
      instant('Registrado el', 't."recordedAt"'),
      instant('Retirado el', 't."deletedAt"'),
    ],
  },
  {
    file: 'denticion.csv',
    description: 'Cambios de dentición (temporal/permanente) por posición.',
    from: `"patient_dentition_events" t ${PATIENT_JOIN}`,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      text('Posición', 't."position"'),
      text('Dentición', 't."dentition"::text'),
      text('Motivo', 't."reason"::text'),
      text('Profesional', userName('t."performedById"')),
      instant('Registrado el', 't."recordedAt"'),
    ],
  },
  {
    file: 'periodontogramas.csv',
    description: 'Periodontogramas (cabecera de cada examen).',
    from: `"perio_exams" t ${PATIENT_JOIN}`,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      date('Fecha', 't."examDate"'),
      text('Profesional', userName('t."providerId"')),
      text('Estado', 't."status"::text'),
      text('Notas', 't."notes"'),
      instant('Finalizado el', 't."finalizedAt"'),
      instant('Creado el', 't."createdAt"'),
      instant('Retirado el', 't."deletedAt"'),
    ],
  },
  {
    file: 'periodontograma-mediciones.csv',
    description: 'Mediciones de cada periodontograma por diente y sitio.',
    from: '"perio_site_measures" t',
    columns: [
      text('Id', 't."id"'),
      text('Periodontograma (id)', 't."examId"'),
      int('Diente', 't."toothFdi"'),
      text('Sitio', 't."site"::text'),
      int('Sondaje (mm)', 't."probingMm"'),
      int('Recesión (mm)', 't."recessionMm"'),
      int('Furca', 't."furcation"'),
      int('Marcas', 't."flags"'),
    ],
  },
  {
    file: 'consentimientos.csv',
    description:
      'Consentimientos informados firmados: texto, firmante y fecha (las imágenes de las firmas no se incluyen).',
    from: `"patient_consents" t ${PATIENT_JOIN}`,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      text('Título', 't."title"'),
      int('Versión de la plantilla', 't."templateVersion"'),
      text('Plan (id)', 't."treatmentPlanId"'),
      text('Firmante', 't."signerType"::text'),
      text('Nombre del firmante', 't."signerName"'),
      text('Documento del firmante', 't."signerDocument"'),
      text('Profesional', 't."professionalName"'),
      bool('Firmado por el paciente', 't."patientSignature" IS NOT NULL'),
      bool(
        'Firmado por el profesional',
        't."professionalSignature" IS NOT NULL',
      ),
      instant('Firmado el', 't."signedAt"'),
      text('Canal a distancia', 't."remoteChannel"::text'),
      text('Texto', 't."body"'),
      text('Registrado por', userName('t."recordedById"')),
      instant('Creado el', 't."createdAt"'),
    ],
  },
  {
    file: 'consentimientos-datos.csv',
    description: 'Consentimientos de tratamiento de datos personales.',
    from: `"data_processing_consents" t ${PATIENT_JOIN}
      LEFT JOIN "privacy_policy_versions" pv ON pv."id" = t."policyVersionId" AND pv."tenantId" = t."tenantId"`,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      text('Alcance', 't."scope"::text'),
      bool('Otorgado', 't."granted"'),
      text('Canal', 't."channel"::text'),
      text(
        'Versión de la política',
        `COALESCE(pv."version"::text, t."legacyPolicyVersion")`,
      ),
      text('Registrado por', userName('t."recordedById"')),
      instant('Registrado el', 't."recordedAt"'),
    ],
  },
  {
    file: 'recetas.csv',
    description:
      'Recetas emitidas (cabecera); los medicamentos van en recetas-medicamentos.csv.',
    from: `"prescriptions" t ${PATIENT_JOIN} ${LOCATION_JOIN}`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      LOCATION_COLUMN,
      text('Profesional', 't."professionalName"'),
      text('Colegiatura', 't."professionalLicense"'),
      text('Especialidad', 't."professionalSpecialty"'),
      text('Estado', 't."status"::text'),
      instant('Emitida el', 't."issuedAt"'),
      date('Dispensar desde', 't."dispensationDate"'),
      date('Válida hasta', 't."validUntil"'),
      text('Notas', 't."notes"'),
      text('Motivo de la excepción de seguridad', 't."safetyOverrideReason"'),
      instant('Anulada el', 't."voidedAt"'),
      text('Motivo de anulación', 't."voidReason"'),
      instant('Creada el', 't."createdAt"'),
    ],
  },
  {
    file: 'recetas-medicamentos.csv',
    description: 'Medicamentos de cada receta.',
    from: '"prescription_items" t',
    columns: [
      text('Id', 't."id"'),
      text('Receta (id)', 't."prescriptionId"'),
      int('Posición', 't."position"'),
      text('Principio activo', 't."activeIngredient"'),
      text('Marca', 't."brandName"'),
      text('Concentración', 't."concentration"'),
      text('Forma farmacéutica', 't."pharmaceuticalForm"'),
      text('Vía', 't."route"'),
      text('Dosis', 't."dose"'),
      text('Frecuencia', 't."frequency"'),
      int('Días', 't."durationDays"'),
      int('Cantidad total', 't."totalQuantity"'),
      text('Unidad', 't."quantityUnit"'),
      text('Instrucciones', 't."instructions"'),
    ],
  },
  {
    file: 'anestesia.csv',
    description: 'Anestesia local administrada (dosis, lote y técnica).',
    from: `"anesthesia_administrations" t ${PATIENT_JOIN} ${LOCATION_JOIN}`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      LOCATION_COLUMN,
      text('Evolución (id)', 't."clinicalEntryId"'),
      text('Anestésico', 't."anestheticName"'),
      text('Principio activo', 't."activeIngredient"'),
      decimal('Concentración (%)', 't."concentrationPct"'),
      text('Vasoconstrictor', 't."vasoconstrictor"'),
      decimal('Carpules', 't."carpules"'),
      decimal('Dosis (mg)', 't."doseMg"'),
      text('Técnica', 't."technique"::text'),
      text('Sitio', 't."site"'),
      text('Lote', 't."lot"'),
      decimal('Peso (kg)', 't."weightKg"'),
      text('Motivo de la excepción de seguridad', 't."overrideReason"'),
      text('Autor', userName('t."authorId"')),
      instant('Administrada el', 't."administeredAt"'),
    ],
  },
  {
    file: 'entregas-postoperatorio.csv',
    description:
      'Instrucciones postoperatorias entregadas al paciente (el texto entregado).',
    from: `"post_op_instruction_deliveries" t ${PATIENT_JOIN} ${LOCATION_JOIN}`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      LOCATION_COLUMN,
      text('Cita (id)', 't."appointmentId"'),
      text('Código de la plantilla', 't."templateCode"'),
      text('Título', 't."templateTitle"'),
      int('Versión', 't."templateVersion"'),
      text('Canal', 't."channel"::text'),
      text('Destinatario', 't."recipientMasked"'),
      bool('Al responsable', 't."sentToResponsible"'),
      text('Entregado por', 't."deliveredByName"'),
      instant('Entregado el', 't."deliveredAt"'),
      instant('Abierto el', 't."firstOpenedAt"'),
      text('Texto', 't."renderedText"'),
    ],
  },
  {
    file: 'implantes.csv',
    description: 'Implantes colocados: fabricante, referencia, lote y tarjeta.',
    from: `"patient_implants" t ${PATIENT_JOIN} ${LOCATION_JOIN}`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      LOCATION_COLUMN,
      text('Profesional', userName('t."professionalId"')),
      date('Colocado el', 't."placedOn"'),
      text('Diente', 't."toothNumber"'),
      text('Tipo', 't."kind"::text'),
      text('Fabricante', 't."manufacturer"'),
      text('Sistema', 't."system"'),
      text('Referencia', 't."reference"'),
      text('Lote', 't."lot"'),
      text('UDI', 't."udi"'),
      decimal('Diámetro (mm)', 't."diameterMm"'),
      decimal('Longitud (mm)', 't."lengthMm"'),
      text('Registro sanitario', 't."sanitaryRegistration"'),
      text('Notas', 't."notes"'),
      instant('Tarjeta entregada el', 't."cardDeliveredAt"'),
      instant('Anulado el', 't."voidedAt"'),
      text('Motivo de anulación', 't."voidReason"'),
      instant('Creado el', 't."createdAt"'),
    ],
  },
  {
    file: 'ortodoncia-casos.csv',
    description: 'Casos de ortodoncia con su técnica, estado y honorarios.',
    from: `"ortho_cases" t ${PATIENT_JOIN} ${LOCATION_JOIN}`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      LOCATION_COLUMN,
      text('Profesional', userName('t."providerId"')),
      text('Plan (id)', 't."treatmentPlanId"'),
      text('Técnica', 't."technique"::text'),
      text('Estado', 't."status"::text'),
      text('Motivo del estado', 't."statusReason"'),
      date('Inicio', 't."startDate"'),
      int('Meses estimados', 't."estimatedMonths"'),
      int('Visitas previstas', 't."plannedVisits"'),
      date('Cementado el', 't."bondedOn"'),
      date('Retirado el', 't."debondedOn"'),
      amount('Honorario total', 't."feeTotal"', 't."feeCurrency"'),
      amount('Cuota inicial', 't."feeInitial"', 't."feeCurrency"'),
      amount('Por visita', 't."feePerVisit"', 't."feeCurrency"'),
      amount('Retención', 't."feeRetention"', 't."feeCurrency"'),
      text('Moneda', 't."feeCurrency"'),
      instant('Creado el', 't."createdAt"'),
    ],
  },
  {
    file: 'ortodoncia-visitas.csv',
    description: 'Controles de ortodoncia (arcos, elásticos, incidencias).',
    from: `"ortho_visits" t ${PATIENT_JOIN}`,
    columns: [
      text('Id', 't."id"'),
      text('Caso (id)', 't."caseId"'),
      ...PATIENT_COLUMNS,
      date('Fecha', 't."visitDate"'),
      text('Arco superior', 't."upperWireMaterial"::text'),
      text('Calibre superior', 't."upperWireGauge"'),
      text('Arco inferior', 't."lowerWireMaterial"::text'),
      text('Calibre inferior', 't."lowerWireGauge"'),
      text('Elásticos', 't."elasticsType"::text'),
      text('Uso de elásticos', 't."elasticsWear"::text'),
      text('Cambios de aparatología', 't."applianceChanges"'),
      list('Incidencias', 't."incidents"::text[]'),
      int('Índice de higiene', 't."hygieneIndex"'),
      date('Próxima visita propuesta', 't."nextVisitProposedOn"'),
      text('Evolución (id)', 't."clinicalEntryId"'),
      text('Autor', userName('t."authorId"')),
      instant('Creada el', 't."createdAt"'),
    ],
  },
  {
    file: 'certificados.csv',
    description: 'Constancias y certificados de asistencia o reposo emitidos.',
    from: `"patient_certificates" t ${PATIENT_JOIN} ${LOCATION_JOIN}`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      int('Número', 't."number"'),
      ...PATIENT_COLUMNS,
      LOCATION_COLUMN,
      text('Tipo', 't."kind"::text'),
      text('Profesional', memberName('t."professionalMembershipId"')),
      instant('Emitido el', 't."issuedAt"'),
      instant('Atendido desde', 't."attendedFrom"'),
      instant('Atendido hasta', 't."attendedUntil"'),
      int('Días de reposo', 't."restDays"'),
      date('Reposo desde', 't."restStartDate"'),
      date('Reposo hasta', 't."restEndDate"'),
      text('Diagnóstico', 't."diagnosis"'),
      instant('Anulado el', 't."voidedAt"'),
      text('Motivo de anulación', 't."voidReason"'),
    ],
  },
  {
    file: 'ordenes-externas.csv',
    description:
      'Órdenes a terceros (radiología, laboratorio clínico, interconsultas).',
    from: `"external_orders" t ${PATIENT_JOIN} ${LOCATION_JOIN}`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      int('Número', 't."number"'),
      ...PATIENT_COLUMNS,
      LOCATION_COLUMN,
      text('Tipo', 't."kind"::text'),
      text('Estado', 't."status"::text'),
      text('Profesional', memberName('t."professionalMembershipId"')),
      text('Destinatario', 't."recipient"'),
      list('Pruebas', 't."items"'),
      list('Dientes', 't."toothNumbers"'),
      text('Nota clínica', 't."clinicalNote"'),
      instant('Emitida el', 't."issuedAt"'),
      instant('Resultado vinculado el', 't."resultLinkedAt"'),
      instant('Anulada el', 't."voidedAt"'),
      text('Motivo de anulación', 't."voidReason"'),
    ],
  },
  {
    file: 'ordenes-laboratorio.csv',
    description: 'Órdenes al laboratorio dental: trabajo, fechas y coste.',
    from: `"dental_lab_orders" t ${PATIENT_JOIN} ${LOCATION_JOIN}
      LEFT JOIN "dental_labs" lab ON lab."id" = t."labId" AND lab."tenantId" = t."tenantId"
      LEFT JOIN "dental_lab_services" svc ON svc."id" = t."serviceId" AND svc."tenantId" = t."tenantId"`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      int('Número', 't."number"'),
      ...PATIENT_COLUMNS,
      LOCATION_COLUMN,
      text('Laboratorio', 'lab."name"'),
      text('Servicio', 'svc."name"'),
      text('Profesional', memberName('t."professionalMembershipId"')),
      text('Descripción', 't."description"'),
      list('Dientes', 't."toothNumbers"'),
      text('Color', 't."shade"'),
      text('Material', 't."material"'),
      text('Instrucciones', 't."instructions"'),
      date('Entrega prevista', 't."dueOn"'),
      instant('Enviada el', 't."sentAt"'),
      instant('Recibida el', 't."receivedAt"'),
      instant('Revisada el', 't."checkedAt"'),
      instant('Cancelada el', 't."cancelledAt"'),
      text('Motivo de cancelación', 't."cancelReason"'),
      amount('Coste', 't."cost"', 't."costCurrency"'),
      text('Moneda', 't."costCurrency"'),
      text('Ítem de plan (id)', 't."treatmentPlanItemId"'),
      text('Cita (id)', 't."appointmentId"'),
      instant('Creada el', 't."createdAt"'),
    ],
  },
  {
    file: 'documentos.csv',
    description:
      'Índice de documentos y radiografías del paciente (los ficheros no van en este ZIP).',
    from: `"patient_documents" t ${PATIENT_JOIN} ${LOCATION_JOIN}`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      LOCATION_COLUMN,
      text('Categoría', 't."category"::text'),
      text('Nombre del fichero', 't."originalName"'),
      text('Tipo', 't."mimeType"'),
      int('Tamaño (bytes)', 't."sizeBytes"'),
      date('Fecha clínica', 't."clinicalDate"'),
      list('Dientes', 't."toothNumbers"'),
      text('Notas', 't."notes"'),
      text('Subido por', userName('t."uploadedById"')),
      instant('Subido el', 't."uploadedAt"'),
      instant('Anulado el', 't."voidedAt"'),
      text('Motivo de anulación', 't."voidReason"'),
    ],
  },
  // -------------------------------------------------------------------------
  // Agenda
  // -------------------------------------------------------------------------
  {
    file: 'citas.csv',
    description:
      'Citas: horario en la zona de su sede, estado, llegada y cancelación.',
    from: `"appointments" t ${PATIENT_JOIN} ${LOCATION_JOIN}
      LEFT JOIN "appointment_types" aty ON aty."id" = t."appointmentTypeId" AND aty."tenantId" = t."tenantId"
      LEFT JOIN "chairs" ch ON ch."id" = t."chairId" AND ch."tenantId" = t."tenantId"`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      LOCATION_COLUMN,
      text('Profesional', userName('t."providerId"')),
      text('Tipo de cita', 'aty."name"'),
      text('Sillón', 'ch."name"'),
      instant('Inicio', 't."start"'),
      instant('Fin', 't."end"'),
      text('Estado', 't."status"::text'),
      text('Motivo', 't."reason"'),
      text('Notas', 't."notes"'),
      text('Origen', 't."origin"::text'),
      bool('Sin cita previa', 't."walkIn"'),
      bool('Sobrecupo', 't."overbooked"'),
      int('Turno', 't."turnNumber"'),
      instant('Llegó el', 't."arrivedAt"'),
      instant('Pasó a consulta el', 't."seatedAt"'),
      instant('Lista para cobrar el', 't."readyForCheckoutAt"'),
      instant('Completada el', 't."completedAt"'),
      instant('Cancelada el', 't."cancelledAt"'),
      text('Cancelada por', 't."cancelledByKind"::text'),
      text('Motivo de cancelación', 't."cancelReasonCode"::text'),
      text('Detalle de la cancelación', 't."cancelReasonText"'),
      bool('Cancelación tardía', 't."lateCancellation"'),
      instant('Inasistencia marcada el', 't."noShowMarkedAt"'),
      text('Serie (id)', 't."seriesId"'),
      instant('Creada el', 't."createdAt"'),
      instant('Retirada el', 't."deletedAt"'),
    ],
  },
  {
    file: 'recall.csv',
    description: 'Recall: próximas revisiones periódicas de cada paciente.',
    from: `"patient_recalls" t ${PATIENT_JOIN} ${LOCATION_JOIN}
      LEFT JOIN "recall_types" rt ON rt."id" = t."recallTypeId" AND rt."tenantId" = t."tenantId"`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      LOCATION_COLUMN,
      text('Tipo', `COALESCE(rt."name", t."kind"::text)`),
      int('Intervalo (meses)', 't."intervalMonths"'),
      date('Última vez', 't."lastDoneAt"'),
      date('Vence', 't."dueAt"'),
      bool('Activo', 't."active"'),
      date('Pausado hasta', 't."disabledUntil"'),
      text('Motivo de la pausa', 't."disabledReason"'),
      int('Intentos de contacto', 't."attemptCount"'),
      instant('Último intento el', 't."lastAttemptAt"'),
      date('Volver a llamar el', 't."callbackOn"'),
      instant('Excluido el', 't."excludedAt"'),
      instant('Creado el', 't."createdAt"'),
    ],
  },
  // -------------------------------------------------------------------------
  // Planes y presupuestos
  // -------------------------------------------------------------------------
  {
    file: 'planes.csv',
    description:
      'Planes de tratamiento y presupuestos: estado, opción y fechas.',
    from: `"treatment_plans" t ${PATIENT_JOIN}`,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      text('Estado', 't."status"::text'),
      text('Moneda', 't."currency"'),
      text('Opción', 't."optionLabel"'),
      text('Grupo de opciones (id)', 't."optionGroupId"'),
      date('Presupuesto emitido el', 't."quoteIssuedOn"'),
      date('Presupuesto válido hasta', 't."quoteValidUntil"'),
      instant('Presentado el', 't."presentedAt"'),
      instant('Aceptado el', 't."acceptedAt"'),
      instant('Rechazado el', 't."rejectedAt"'),
      text('Motivo de rechazo', 't."rejectionReason"::text'),
      text('Nota del rechazo', 't."rejectionNote"'),
      text('Dividido del plan (id)', 't."splitFromPlanId"'),
      text('Notas', 't."notes"'),
      text('Creado por', userName('t."createdById"')),
      instant('Creado el', 't."createdAt"'),
      instant('Retirado el', 't."deletedAt"'),
    ],
  },
  {
    file: 'plan-items.csv',
    description:
      'Ítems de cada plan: tratamiento, diente, precio y descuento en la moneda del plan, y quién lo realizó.',
    from: `"treatment_plan_items" t
      JOIN "treatment_plans" tp ON tp."id" = t."planId" AND tp."tenantId" = t."tenantId"
      LEFT JOIN "patients" p ON p."id" = tp."patientId" AND p."tenantId" = t."tenantId"
      LEFT JOIN "dental_catalog_items" cat ON cat."id" = t."catalogItemId" AND cat."tenantId" = t."tenantId"
      LEFT JOIN "locations" loc ON loc."id" = t."performedLocationId" AND loc."tenantId" = t."tenantId"`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      text('Plan (id)', 't."planId"'),
      text('Paciente (id)', 'tp."patientId"'),
      int('Código de paciente', 'p."patientCode"'),
      text(
        'Paciente',
        `NULLIF(btrim(concat_ws(' ', p."firstName", p."lastName")), '')`,
      ),
      text('Código de catálogo', 'cat."code"'),
      text('Tratamiento', 'cat."labelEs"'),
      text('Diente', 't."toothNumber"'),
      list('Superficies', 't."surfaces"::text[]'),
      int('Visita', 't."visit"'),
      text('Etiqueta de la visita', 't."visitLabel"'),
      text('Estado', 't."status"::text'),
      amount('Precio', 't."price"', 'tp."currency"'),
      amount('Descuento', 't."discount"', 'tp."currency"'),
      text('Moneda', 'tp."currency"'),
      text('Motivo del descuento', 't."discountReason"::text'),
      text('Nota del descuento', 't."discountReasonNote"'),
      text('Origen del precio', 't."priceSource"::text'),
      text('Convenio', 't."agreementName"'),
      text('Realizado por', userName('t."performedById"')),
      text('Sede de realización', 'loc."name"'),
      instant('Completado el', 't."completedAt"'),
      text('Notas', 't."notes"'),
      instant('Creado el', 't."createdAt"'),
      instant('Retirado el', 't."deletedAt"'),
    ],
  },
  // -------------------------------------------------------------------------
  // Cobros
  // -------------------------------------------------------------------------
  {
    file: 'pagos.csv',
    description:
      'Abonos: importe y moneda, medio de pago, referencia, vuelto, tasa de cambio y anulación.',
    from: `"payments" t ${PATIENT_JOIN} ${LOCATION_JOIN}
      LEFT JOIN "payment_methods" pm ON pm."id" = t."paymentMethodId" AND pm."tenantId" = t."tenantId"`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      LOCATION_COLUMN,
      text('Plan (id)', 't."treatmentPlanId"'),
      instant('Fecha', 't."paidAt"'),
      amount('Importe', 't."amount"', 't."currency"'),
      text('Moneda', 't."currency"'),
      text('Método', 't."method"::text'),
      text('Medio de pago', 'pm."name"'),
      text('Referencia', 't."reference"'),
      text('Factura externa', 't."externalInvoiceNumber"'),
      amount('Entregado', 't."tenderedAmount"', 't."currency"'),
      amount('Vuelto', 't."changeRemainder"', 't."currency"'),
      text('Moneda de la tasa', 't."exchangeRateCurrency"'),
      decimal('Tasa: unidades de origen', 't."exchangeRateFrom"'),
      decimal('Tasa: unidades de destino', 't."exchangeRateTo"'),
      text('Fuente de la tasa', 't."exchangeRateSource"::text'),
      date('Fecha de la tasa', 't."exchangeRateDate"'),
      text('Caja (id)', 't."cashSessionId"'),
      text('Pago dividido (id)', 't."splitId"'),
      text('Saldo inicial (id)', 't."openingBalanceId"'),
      text('Notas', 't."notes"'),
      text('Registrado por', userName('t."createdById"')),
      instant('Registrado el', 't."createdAt"'),
      instant('Anulado el', 't."voidedAt"'),
      text('Anulado por', userName('t."voidedById"')),
      text('Motivo de anulación', 't."voidReason"'),
      instant('Retirado el', 't."deletedAt"'),
    ],
  },
  {
    file: 'pagos-ajustes.csv',
    description:
      'Recargos y descuentos por medio de pago aplicados a cada abono.',
    from: '"payment_adjustments" t',
    columns: [
      text('Id', 't."id"'),
      text('Pago (id)', 't."paymentId"'),
      int('Posición', 't."position"'),
      text('Tipo', 't."type"::text'),
      text('Concepto', 't."label"'),
      text('Cálculo', 't."calculation"::text'),
      decimal('Porcentaje', 't."percent"'),
      amount('Importe fijo', 't."fixedAmount"', 't."currency"'),
      amount('Base', 't."base"', 't."currency"'),
      amount('Importe', 't."amount"', 't."currency"'),
      text('Moneda', 't."currency"'),
      instant('Creado el', 't."createdAt"'),
    ],
  },
  {
    file: 'imputaciones.csv',
    description: 'Reparto de cada abono entre planes e ítems.',
    from: `"payment_allocations" t
      JOIN "payments" pay ON pay."id" = t."paymentId" AND pay."tenantId" = t."tenantId"`,
    columns: [
      text('Id', 't."id"'),
      text('Pago (id)', 't."paymentId"'),
      text('Plan (id)', 't."treatmentPlanId"'),
      text('Ítem de plan (id)', 't."treatmentPlanItemId"'),
      amount('Importe', 't."amount"', 'pay."currency"'),
      text('Moneda', 'pay."currency"'),
      text('Origen', 't."source"::text'),
      instant('Creada el', 't."createdAt"'),
    ],
  },
  {
    file: 'financiaciones.csv',
    description:
      'Planes de pago (financiación en cuotas) de cada plan de tratamiento.',
    from: `"payment_plans" t ${PATIENT_JOIN}`,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      text('Plan de tratamiento (id)', 't."treatmentPlanId"'),
      amount('A financiar', 't."totalToFinance"', 't."currency"'),
      amount('Inicial', 't."downPayment"', 't."currency"'),
      text('Moneda', 't."currency"'),
      int('Número de cuotas', 't."installmentsCount"'),
      text('Periodicidad', 't."periodicity"::text'),
      date('Primera cuota', 't."startDate"'),
      text('Estado', 't."status"::text'),
      text('Notas', 't."notes"'),
      instant('Cancelado el', 't."cancelledAt"'),
      text('Motivo de cancelación', 't."cancelReason"'),
      instant('Creado el', 't."createdAt"'),
      instant('Retirado el', 't."deletedAt"'),
    ],
  },
  {
    file: 'cuotas.csv',
    description: 'Cuotas de cada plan de pago.',
    from: `"installments" t
      JOIN "payment_plans" pp ON pp."id" = t."paymentPlanId" AND pp."tenantId" = t."tenantId"`,
    columns: [
      text('Id', 't."id"'),
      text('Plan de pago (id)', 't."paymentPlanId"'),
      int('Número', 't."sequence"'),
      date('Vence', 't."dueDate"'),
      amount('Importe', 't."amount"', 'pp."currency"'),
      text('Moneda', 'pp."currency"'),
      instant('Creada el', 't."createdAt"'),
    ],
  },
  {
    file: 'saldo-a-favor.csv',
    description: 'Movimientos del saldo a favor de cada paciente.',
    from: `"patient_credit_entries" t ${PATIENT_JOIN}`,
    columns: [
      text('Id', 't."id"'),
      ...PATIENT_COLUMNS,
      text('Plan (id)', 't."treatmentPlanId"'),
      text('Tipo', 't."kind"::text'),
      amount('Importe', 't."amount"', 't."currency"'),
      text('Moneda', 't."currency"'),
      text('Traspaso (id)', 't."transferId"'),
      text('Devolución (id)', 't."refundId"'),
      instant('Creado el', 't."createdAt"'),
    ],
  },
  {
    file: 'cajas.csv',
    description: 'Sesiones de caja por sede.',
    from: `"cash_sessions" t ${LOCATION_JOIN}`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      LOCATION_COLUMN,
      text('Estado', 't."status"::text'),
      text('Abierta por', userName('t."openedById"')),
      instant('Abierta el', 't."openedAt"'),
      text('Cerrada por', userName('t."closedById"')),
      instant('Cerrada el', 't."closedAt"'),
      int('Reaperturas', 't."reopenCount"'),
      text('Notas', 't."notes"'),
    ],
  },
  {
    file: 'movimientos-bancarios.csv',
    description:
      'Movimientos de los extractos bancarios importados para conciliar.',
    from: `"bank_movements" t
      LEFT JOIN "bank_accounts" ba ON ba."id" = t."bankAccountId" AND ba."tenantId" = t."tenantId"`,
    columns: [
      text('Id', 't."id"'),
      text('Cuenta', 'ba."name"'),
      date('Fecha', 't."bookedOn"'),
      text('Referencia', 't."reference"'),
      text('Descripción', 't."description"'),
      amount('Importe', 't."amount"', 't."currency"'),
      text('Moneda', 't."currency"'),
      instant('Importado el', 't."createdAt"'),
    ],
  },
  {
    file: 'conciliaciones.csv',
    description: 'Conciliación bancaria: qué abono casa con qué movimiento.',
    from: '"bank_reconciliation_matches" t',
    columns: [
      text('Id', 't."id"'),
      text('Movimiento (id)', 't."movementId"'),
      text('Pago (id)', 't."paymentId"'),
      text('Tipo', 't."kind"::text'),
      text('Conciliado por', userName('t."matchedById"')),
      instant('Conciliado el', 't."createdAt"'),
      instant('Deshecho el', 't."endedAt"'),
      text('Motivo', 't."endReason"::text'),
    ],
  },
  // -------------------------------------------------------------------------
  // Gastos y honorarios
  // -------------------------------------------------------------------------
  {
    file: 'gastos.csv',
    description: 'Gastos de la clínica por sede.',
    from: `"expenses" t ${LOCATION_JOIN}`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      LOCATION_COLUMN,
      text('Categoría', 't."category"'),
      text('Proveedor', 't."supplier"'),
      text('Descripción', 't."description"'),
      amount('Importe', 't."amount"', 't."currency"'),
      text('Moneda', 't."currency"'),
      date('Fecha de la factura', 't."invoiceDate"'),
      date('Vence', 't."dueDate"'),
      text('Adjunto', 't."attachmentName"'),
      text('Creado por', userName('t."createdById"')),
      instant('Creado el', 't."createdAt"'),
      instant('Anulado el', 't."voidedAt"'),
      text('Motivo de anulación', 't."voidReason"'),
    ],
  },
  {
    file: 'honorarios-liquidaciones.csv',
    description:
      'Liquidaciones de honorarios cerradas por profesional y período.',
    from: '"commission_settlements" t',
    columns: [
      text('Id', 't."id"'),
      text('Profesional', userName('t."userId"')),
      date('Desde', 't."periodFrom"'),
      date('Hasta', 't."periodTo"'),
      text('Base', 't."basis"::text'),
      text('Liberación', 't."releaseMode"::text'),
      decimal('Porcentaje', 't."percent"'),
      bool('Descuenta laboratorio', 't."deductLabCost"'),
      bool('Descuenta comisión de tarjeta', 't."deductCardFee"'),
      text('Cerrada por', userName('t."closedById"')),
      instant('Cerrada el', 't."closedAt"'),
    ],
  },
  {
    file: 'honorarios-lineas.csv',
    description: 'Detalle de cada liquidación de honorarios.',
    from: '"commission_settlement_lines" t',
    columns: [
      text('Id', 't."id"'),
      text('Liquidación (id)', 't."settlementId"'),
      text('Profesional', userName('t."userId"')),
      text('Tipo', 't."kind"::text'),
      text('Ajusta la línea (id)', 't."adjustsLineId"'),
      text('Ítem de plan (id)', 't."treatmentPlanItemId"'),
      text('Pago (id)', 't."paymentId"'),
      text('Código de catálogo', 't."catalogCode"'),
      text('Tratamiento', 't."catalogLabel"'),
      text('Diente', 't."toothNumber"'),
      instant('Completado el', 't."completedAt"'),
      amount('Base', 't."base"', 't."currency"'),
      decimal('Porcentaje', 't."percent"'),
      amount(
        'Coste de laboratorio descontado',
        't."labCostDeducted"',
        't."currency"',
      ),
      amount(
        'Comisión de tarjeta descontada',
        't."cardFeeDeducted"',
        't."currency"',
      ),
      amount('Honorario', 't."amount"', 't."currency"'),
      text('Moneda', 't."currency"'),
    ],
  },
  {
    file: 'honorarios-pagos.csv',
    description: 'Pagos de honorarios a los profesionales.',
    from: `"commission_payments" t ${LOCATION_JOIN}`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      text('Liquidación (id)', 't."settlementId"'),
      text('Profesional', userName('t."userId"')),
      LOCATION_COLUMN,
      date('Pagado el', 't."paidOn"'),
      amount('Importe', 't."amount"', 't."currency"'),
      text('Moneda', 't."currency"'),
      text('Método', 't."method"::text'),
      text('Referencia', 't."reference"'),
      instant('Anulado el', 't."voidedAt"'),
      text('Motivo de anulación', 't."voidReason"'),
    ],
  },
  // -------------------------------------------------------------------------
  // Inventario
  // -------------------------------------------------------------------------
  {
    file: 'inventario.csv',
    description: 'Artículos del inventario por sede, con su existencia mínima.',
    from: `"inventory_items" t ${LOCATION_JOIN}`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      LOCATION_COLUMN,
      text('Nombre', 't."name"'),
      text('SKU', 't."sku"'),
      text('Unidad', 't."unit"'),
      decimal('Existencia mínima', 't."minStock"'),
      text('Notas', 't."notes"'),
      instant('Creado el', 't."createdAt"'),
      instant('Retirado el', 't."deletedAt"'),
    ],
  },
  {
    file: 'inventario-movimientos.csv',
    description: 'Entradas, salidas y ajustes de inventario.',
    from: `"inventory_movements" t ${LOCATION_JOIN}
      LEFT JOIN "inventory_items" it ON it."id" = t."itemId" AND it."tenantId" = t."tenantId"`,
    zone: LOCATION_ZONE,
    columns: [
      text('Id', 't."id"'),
      text('Artículo (id)', 't."itemId"'),
      text('Artículo', 'it."name"'),
      LOCATION_COLUMN,
      text('Tipo', 't."type"::text'),
      decimal('Cantidad', 't."quantity"'),
      text('Motivo', 't."reason"'),
      instant('Fecha', 't."occurredAt"'),
      text('Registrado por', userName('t."createdById"')),
      instant('Creado el', 't."createdAt"'),
    ],
  },
];

/**
 * Lo que una columna nunca puede leer (revisado por export-catalog.spec.ts):
 * secretos, hashes, tokens, claves del almacén, firmas e IP/navegador.
 */
export const FORBIDDEN_SQL =
  /hash|token|secret|password|mfa|recovery|signature"(?!\s+IS\s+(NOT\s+)?NULL)|storagekey|attachmentkey|logokey|"sha256"|attachmentsha256|ipaddress|useragent|idempotency|verificationcode|naturalkey|columnmapping/i;

/** SQL de una página: el keyset por `t."id"`, filtro de clínica y tamaño. */
export function pageQuery(table: ExportTable): string {
  const select = table.columns.map((c, i) => {
    const expr = sqlFor(c);
    const currency =
      c.kind === 'amount' ? `, (${c.currency})::text AS "m${i}"` : '';
    return `${expr} AS "c${i}"${currency}`;
  });
  const zone = table.zone ? `${table.zone}` : 'NULL::text';
  return `SELECT t."id"::text AS "k", ${zone} AS "z", ${select.join(', ')}
FROM ${table.from}
WHERE t."tenantId" = $1::uuid AND ($2::uuid IS NULL OR t."id" > $2::uuid)
ORDER BY t."id"
LIMIT $3`;
}

/** La expresión de cada tipo, ya en el formato que el escritor espera. */
function sqlFor(c: ExportColumn): string {
  switch (c.kind) {
    case 'text':
      return `(${c.sql})::text`;
    case 'int':
      return `(${c.sql})::bigint::text`;
    case 'decimal':
    case 'amount':
      return `(${c.sql})::numeric::text`;
    case 'bool':
      return `(${c.sql})::boolean`;
    case 'date':
      return `to_char((${c.sql})::date, 'YYYY-MM-DD')`;
    case 'instant':
      // Columnas TIMESTAMP(3) en UTC (Prisma): se leen como UTC.
      return `to_char((${c.sql}), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
    case 'list':
      return `(${c.sql})::text[]`;
    case 'json':
      return `(${c.sql})::text`;
  }
}
