import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  adminUrlFor,
  ownerUrlFor,
  requireOwnerNosuEnv,
} from './owner-nosu-env';

// DX-113: las migraciones de datos no pierden filas en silencio cuando el
// owner NO es superusuario ni tiene BYPASSRLS (Postgres gestionado). Con RLS
// FORCE ese owner está sujeto a la RLS: sin `app.current_tenant` un UPDATE o
// un INSERT … SELECT verían 0 filas y la migración "pasaría" sin hacer nada.
//
// Una BD desechable, propiedad del owner de DIRECT_URL, recibe las
// migraciones por tramos con `prisma migrate deploy` (la herramienta real).
// Antes de cada migración de datos se cargan filas (como admin, saltando la
// RLS) y después se comprueba:
//   - que ninguna tabla tiene menos filas que antes (salvo las que la propia
//     migración retira a propósito), y
//   - que la migración hizo su trabajo sobre esas filas (el backfill está).
// Al final, FORCE sigue activo en toda tabla con RLS y todo es del owner.
//
// Corre en el job «Migraciones con owner sin superusuario» de la CI (ver
// README, «Despliegue: roles de la BD»), no en `test:int`: necesita un rol
// owner sin superusuario y un admin que cree bases.

const ROOT = join(__dirname, '..', '..');

/** psql no acepta el `?schema=public` de las URL de Prisma. */
const psqlUrl = (url: string): string => {
  const u = new URL(url);
  u.search = '';
  return u.toString();
};
const MIGRATIONS = join(ROOT, 'prisma/migrations');

const T_A = '00000000-0000-4000-8000-0000000000a1';
const T_B = '00000000-0000-4000-8000-0000000000b1';
const U_A = '00000000-0000-4000-8000-0000000000a2';
const U_B = '00000000-0000-4000-8000-0000000000b2';
const P_A = '00000000-0000-4000-8000-0000000000a3';
const P_B = '00000000-0000-4000-8000-0000000000b3';
const TP_A = '00000000-0000-4000-8000-0000000000a4';
const TP_B = '00000000-0000-4000-8000-0000000000b4';

/**
 * Esquema de 20260731000000 (antes de la primera migración de datos con
 * filas de clínica): dos clínicas con lo que leen las migraciones de datos.
 * Las fechas son fijas para poder comprobar los backfills.
 */
const FIXTURE_INITIAL = [
  `INSERT INTO "tenants" ("id","name","subdomain","updatedAt") VALUES
     ('${T_A}','Clínica A','mig-a',now()), ('${T_B}','Clínica B','mig-b',now())`,
  `INSERT INTO "users" ("id","email","passwordHash","fullName","updatedAt") VALUES
     ('${U_A}','a@mig.test','x','Ana A',now()), ('${U_B}','b@mig.test','x','Beto B',now())`,
  // OWNER: 20260731170000_remove_owner_role lo pasa a ADMIN.
  `INSERT INTO "clinic_memberships" ("id","tenantId","userId","role","updatedAt") VALUES
     (gen_random_uuid(),'${T_A}','${U_A}','OWNER',now()),
     (gen_random_uuid(),'${T_B}','${U_B}','DENTIST',now())`,
  `INSERT INTO "patients" ("id","tenantId","firstName","lastName","updatedAt") VALUES
     ('${P_A}','${T_A}','Pía','Arias','2026-01-15 10:00'),
     ('${P_B}','${T_B}','Pablo','Bernal','2026-01-15 10:00')`,
  // Texto libre: 20260731120000_structured_clinical_history lo guarda en notes
  // antes de borrar las columnas viejas.
  `INSERT INTO "medical_history_versions" ("id","tenantId","patientId","version","allergies","habits","notes") VALUES
     (gen_random_uuid(),'${T_A}','${P_A}',1,'Penicilina',NULL,'Control anual'),
     (gen_random_uuid(),'${T_B}','${P_B}',1,NULL,'Fuma',NULL)`,
  `INSERT INTO "treatment_plans" ("id","tenantId","patientId","status","currency","updatedAt") VALUES
     ('${TP_A}','${T_A}','${P_A}','ACCEPTED','COP',now()),
     ('${TP_B}','${T_B}','${P_B}','ACCEPTED','COP',now())`,
  // paidAt a medianoche UTC: 20261017113000_payments_civil_day_noon los pasa
  // al mediodía civil. El anulado (deletedAt): 20261016160000 copia voidedAt.
  `INSERT INTO "payments" ("id","tenantId","treatmentPlanId","patientId","amount","currency","paidAt","method","updatedAt","deletedAt") VALUES
     (gen_random_uuid(),'${T_A}','${TP_A}','${P_A}',50000,'COP','2026-03-01 00:00','CASH',now(),NULL),
     (gen_random_uuid(),'${T_A}','${TP_A}','${P_A}',20000,'COP','2026-03-02 00:00','CARD',now(),'2026-03-03 09:30'),
     (gen_random_uuid(),'${T_B}','${TP_B}','${P_B}',80000,'COP','2026-03-05 15:45','TRANSFER',now(),NULL)`,
  // Atenciones: 20261017170000_dx039_clinical_record_retention calcula la última.
  `INSERT INTO "appointments" ("id","tenantId","patientId","providerId","start","end","status","updatedAt") VALUES
     (gen_random_uuid(),'${T_A}','${P_A}','${U_A}','2026-03-10 14:00','2026-03-10 14:30','COMPLETED',now()),
     (gen_random_uuid(),'${T_B}','${P_B}','${U_B}','2026-02-10 14:00','2026-02-10 14:30','CANCELLED',now())`,
  `INSERT INTO "clinical_entries" ("id","tenantId","patientId","entryDate","notes") VALUES
     (gen_random_uuid(),'${T_B}','${P_B}','2026-04-01 16:00','Profilaxis')`,
];

/** Esquema de 20261016160001: consentimiento del booleano legado. */
const FIXTURE_CONSENTS = [
  `UPDATE "patients" SET "dataConsentAccepted" = true,
          "dataConsentAt" = '2026-02-01 12:00', "dataConsentPolicyVersion" = 'v1'
    WHERE "id" = '${P_A}'`,
];

/** Esquema de 20261017113000: eventos que la partición tiene que conservar. */
const FIXTURE_AUDIT = [
  `INSERT INTO "audit_events"
     ("id","tenantId","actorUserId","actorRole","action","resourceType",
      "patientId","requestId","occurredAt","metadata")
   SELECT gen_random_uuid(),
          CASE WHEN g % 2 = 0 THEN '${T_A}'::uuid ELSE '${T_B}'::uuid END,
          '${U_A}', 'ADMIN', 'VIEW', 'PATIENT', '${P_A}', 'req-' || g,
          date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(days => g * 13),
          jsonb_build_object('n', g)
     FROM generate_series(1, 40) AS g`,
];

const U_C = '00000000-0000-4000-8000-0000000000c2';

/**
 * Esquema de 20261017231000 (DX-143): U_B (DENTIST, no dueña) inició sesión;
 * U_C no hizo nada. U_A es la dueña registrada con su clínica (FIXTURE_INITIAL).
 */
const FIXTURE_LOGINS = [
  `INSERT INTO "users" ("id","email","passwordHash","fullName","createdAt","updatedAt") VALUES
     ('${U_C}','c@mig.test','x','Ceci C','2025-01-01 00:00',now())`,
  `INSERT INTO "audit_events"
     ("id","tenantId","actorUserId","actorRole","action","resourceType","occurredAt")
   VALUES
     (gen_random_uuid(),'${T_B}','${U_B}','DENTIST','LOGIN','SESSION','2026-05-01 10:00'),
     (gen_random_uuid(),'${T_B}','${U_B}','DENTIST','LOGIN','SESSION','2026-06-01 10:00'),
     (gen_random_uuid(),'${T_B}','${U_C}','DENTIST','LOGIN_FAILED','SESSION','2026-06-01 10:00')`,
];

/**
 * Esquema de 20261017233200 (DX-136): más sedes, con nombres que chocan, para
 * el relleno de la serie de recibos ("receiptPrefix") por orden de alta.
 */
// Después de la "Sede principal" de cada clínica, que add_locations creó con now().
const FIXTURE_LOCATIONS = [
  `INSERT INTO "locations" ("id","tenantId","name","createdAt","updatedAt") VALUES
     (gen_random_uuid(),'${T_A}','Sede Norte',now() + interval '1 day',now()),
     (gen_random_uuid(),'${T_A}','Sede Nórte',now() + interval '2 days',now()),
     (gen_random_uuid(),'${T_B}','Sede Norte',now() + interval '1 day',now())`,
];

/**
 * Esquema de 20261017233300 (DX-128): un móvil escrito a mano, el que usa el
 * botón wa.me manual; la migración no lo toca.
 */
const FIXTURE_CONTACT = [
  `UPDATE "patients" SET "phone" = '310 555 0101' WHERE "id" = '${P_A}'`,
];

/**
 * Esquema de 20261018120000 (DX-203): el acudiente en texto libre de un
 * paciente de cada clínica; la migración lo copia a un contacto responsable.
 */
const FIXTURE_GUARDIAN = [
  `UPDATE "patients" SET "guardianName" = 'Claudia Navarro', "guardianDocNumber" = '52987654' WHERE "id" = '${P_A}'`,
  `UPDATE "patients" SET "guardianName" = 'Óscar Cifuentes' WHERE "id" = '${P_B}'`,
];

/**
 * Esquema de 20261019194000 (SEC-041): un ítem de plan por clínica; el de A
 * con un catálogo con precio (rebajado en el ítem), el de B con un catálogo
 * sin precio (ítem libre). La migración copia el precio de catálogo al ítem.
 */
const FIXTURE_CATALOG_PRICE = [
  `INSERT INTO "dental_catalog_items" ("id","tenantId","code","kind","labelEs","color","defaultPrice","updatedAt") VALUES
     ('00000000-0000-4000-8000-0000000000a5','${T_A}','COR','PROCEDURE','Corona','#111111',1000000,now()),
     ('00000000-0000-4000-8000-0000000000b5','${T_B}','LIB','PROCEDURE','Libre','#111111',NULL,now())`,
  `INSERT INTO "treatment_plan_items" ("id","tenantId","planId","toothNumber","catalogItemId","price","updatedAt") VALUES
     (gen_random_uuid(),'${T_A}','${TP_A}','11','00000000-0000-4000-8000-0000000000a5',500000,now()),
     (gen_random_uuid(),'${T_B}','${TP_B}','11','00000000-0000-4000-8000-0000000000b5',10,now())`,
];

const U_D = '00000000-0000-4000-8000-0000000000d2';

/**
 * Esquema de 20261019224000 (DX-084): avatares con la URL absoluta de antes
 * (dos bases distintas, como tras un cambio de dominio), uno ya con clave y
 * uno irreconocible; la migración deja solo claves y no toca lo que no
 * reconoce.
 */
const FIXTURE_AVATARS = [
  `UPDATE "users" SET "avatarUrl" = 'http://localhost:3000/api/v1/files/avatars/${U_A}.png' WHERE "id" = '${U_A}'`,
  `UPDATE "users" SET "avatarUrl" = 'https://api.viejo.app/api/v1/files/avatars/${U_B}.jpg' WHERE "id" = '${U_B}'`,
  `UPDATE "users" SET "avatarUrl" = 'avatars/${U_C}.webp' WHERE "id" = '${U_C}'`,
  `INSERT INTO "users" ("id","email","passwordHash","fullName","avatarUrl","updatedAt") VALUES
     ('${U_D}','d@mig.test','x','Dani D','https://otro.cdn/foto.png',now())`,
];

/**
 * Esquema de 20261020100000 (DX-225): un implante con blancos y minúsculas
 * en lote y referencia (la clave generada los normaliza al reescribir la
 * tabla) y móviles en pacientes de las dos clínicas para el relleno por
 * lotes de "phoneTail" (con la clínica fijada, sin NO FORCE). El de B, sin
 * dígitos: su clave queda vacía, no NULL.
 */
const FIXTURE_DX225 = [
  `INSERT INTO "patient_implants" ("id","tenantId","locationId","patientId","professionalId","placedOn","toothNumber","kind","manufacturer","reference","lot") 
   SELECT gen_random_uuid(), '${T_A}', l."id", '${P_A}', '${U_A}', '2026-05-01', '36', 'IMPLANT', 'Straumann', ' ref-9 ', ' lot-77 '
     FROM "locations" l WHERE l."tenantId" = '${T_A}' ORDER BY l."createdAt" LIMIT 1`,
  `UPDATE "patients" SET "phone" = 'sin número' WHERE "id" = '${P_B}'`,
  `INSERT INTO "patients" ("id","tenantId","firstName","lastName","phone","updatedAt")
   SELECT gen_random_uuid(), '${T_B}', 'Lote', 'N' || g, '+57 300 ' || lpad(g::text, 7, '0'), now()
     FROM generate_series(1, 4500) AS g`,
];

/**
 * Esquema de 20261024100000 (DX-287): documentos escritos de varias formas
 * en las dos clínicas para el relleno por lotes de "docKey" (con la clínica
 * fijada, sin NO FORCE): 4.500 en B para que haya 3 lotes, uno solo con
 * puntuación (clave vacía, no NULL) y los demás pacientes sin documento.
 */
const FIXTURE_DX287 = [
  `UPDATE "patients" SET "docNumber" = '1.111.111' WHERE "id" = '${P_A}'`,
  `UPDATE "patients" SET "docNumber" = ' ab-12 345 ' WHERE "id" = '${P_B}'`,
  `UPDATE "patients" SET "docNumber" = 'cc-' || "lastName"
    WHERE "tenantId" = '${T_B}' AND "firstName" = 'Lote'`,
  `INSERT INTO "patients" ("id","tenantId","firstName","lastName","docNumber","updatedAt")
   VALUES (gen_random_uuid(), '${T_A}', 'Solo', 'Puntos', '.-.', now())`,
];

interface Step {
  /** Se aplican todas las migraciones con nombre < `until`. */
  until: string;
  /** Filas a cargar ANTES del tramo (como admin). */
  fixture?: string[];
  /** Tablas que el tramo retira o vacía a propósito (no cuentan como pérdida). */
  dropped?: string[];
}

/**
 * Esquema de 20261024174000 (DX-319): REPS en las sedes «Sede Norte» de las
 * dos clínicas; la de A ya tiene su nº de registro sanitario, que no se pisa.
 */
const FIXTURE_DX319 = [
  `UPDATE "locations" SET "repsHabilitationCode" = '110010123401'
    WHERE "name" = 'Sede Norte'`,
  `UPDATE "locations" SET "healthRegistrationNumber" = 'NRS-A'
    WHERE "name" = 'Sede Norte' AND "tenantId" = '${T_A}'`,
];

/** GLOBAL-G1 fase 1: moneda, zona y locale por sede (backfill D5). */
const G1 = '20261027120000_g1_location_regional_settings';
const L_POLANCO = '00000000-0000-4000-8000-0000000000a6';

/**
 * Esquema de 20261027120000 (GLOBAL-G1): una sede ES, una CO cuyo horario
 * vivo está en México (conserva esa zona) y una ES retirada. Las «Sede
 * principal» y «Sede Norte» previas son CO sin horario.
 */
const FIXTURE_G1 = [
  `INSERT INTO "locations" ("id","tenantId","name","country","deletedAt","updatedAt") VALUES
     (gen_random_uuid(),'${T_B}','Sede Madrid','ES',NULL,now()),
     ('${L_POLANCO}','${T_A}','Sede Polanco','CO',NULL,now()),
     (gen_random_uuid(),'${T_B}','Sede Cerrada','ES',now(),now())`,
  `INSERT INTO "location_schedules" ("id","tenantId","locationId","timezone","updatedAt") VALUES
     (gen_random_uuid(),'${T_A}','${L_POLANCO}','America/Mexico_City',now())`,
];

/** G1-B fase 1 (DX-350): reloj de la sede (backfill h23). */
const G1B = '20261027140000_g1b_location_hour_cycle';

/**
 * Esquema de 20261027140000 (G1-B): una sede revisada (la revisión no se
 * toca) y una creada por una réplica de G1 sin barrer, con moneda, zona y
 * formato. Las demás vienen del backfill D5 de G1, sin revisar.
 */
const FIXTURE_G1B = [
  `UPDATE "locations" SET "regionalSettingsReviewedAt" = '2026-10-20 10:00:00+00'
    WHERE "id" = '${L_POLANCO}'`,
  `INSERT INTO "locations" ("id","tenantId","name","currency","timeZone","locale","updatedAt") VALUES
     (gen_random_uuid(),'${T_B}','Sede Berlín','EUR','Europe/Berlin','de-DE',now())`,
];

/** DX-328: mayoría de edad por clínica (relleno con la que ya aplicaba). */
const DX328 = '20261028160000_dx328_enums';
const DX328_COLUMN = '20261028160200_dx328_tenant_majority_age';
const T_CO = '00000000-0000-4000-8000-0000000328a1';
const T_ES = '00000000-0000-4000-8000-0000000328b1';
const T_MIX = '00000000-0000-4000-8000-0000000328c1';
const T_NONE = '00000000-0000-4000-8000-0000000328e1';

/**
 * Esquema de G1-B, antes de la columna de DX-328: una clínica con dos sedes
 * CO, una con una sede ES, una mixta y una sin sedes. A tiene solo sedes CO
 * y B es mixta (Madrid y la retirada son ES).
 */
const FIXTURE_DX328 = [
  `INSERT INTO "tenants" ("id","name","subdomain","updatedAt") VALUES
     ('${T_CO}','Clínica CO','mig-co',now()), ('${T_ES}','Clínica ES','mig-es',now()),
     ('${T_MIX}','Clínica mixta','mig-mix',now()), ('${T_NONE}','Clínica sin sedes','mig-none',now())`,
  `INSERT INTO "locations" ("id","tenantId","name","country","currency","timeZone","locale","hourCycle","updatedAt") VALUES
     (gen_random_uuid(),'${T_CO}','Sede 1','CO','EUR','Europe/Berlin','de-DE','h23',now()),
     (gen_random_uuid(),'${T_CO}','Sede 2','CO','EUR','Europe/Berlin','de-DE','h23',now()),
     (gen_random_uuid(),'${T_ES}','Sede 1','ES','EUR','Europe/Berlin','de-DE','h23',now()),
     (gen_random_uuid(),'${T_MIX}','Sede 1','CO','EUR','Europe/Berlin','de-DE','h23',now()),
     (gen_random_uuid(),'${T_MIX}','Sede 2','ES','EUR','Europe/Berlin','de-DE','h23',now())`,
];

/** DX-316: calendario de la sede (backfill de lunes a viernes). */
const DX316_DEFAULT = '20261028170300';
const T_CAL = '00000000-0000-4000-8000-0000000316c1';

/**
 * Esquema de DX-316 con sus tablas y sin el trigger de alta: una clínica
 * nueva con una sede viva y otra retirada (B ya tiene otra retirada). Ninguna
 * sede de la BD tiene aún calendario.
 */
const FIXTURE_DX316 = [
  `INSERT INTO "tenants" ("id","name","subdomain","updatedAt") VALUES
     ('${T_CAL}','Clínica calendario','mig-cal',now())`,
  `INSERT INTO "locations" ("id","tenantId","name","currency","timeZone","locale","hourCycle","deletedAt","updatedAt") VALUES
     (gen_random_uuid(),'${T_CAL}','Sede viva','JPY','Asia/Tokyo','ja-JP','h23',NULL,now()),
     (gen_random_uuid(),'${T_CAL}','Sede retirada','USD','America/New_York','en-US','h12',now(),now())`,
];

/**
 * DX-324: ajustes de receta por clínica (relleno desde las sedes vivas).
 * Sin fixture propio: A (solo CO), B (Madrid ES viva, retirada ES y el resto
 * CO por el default de la columna), mig-cal (la viva es CO por el default),
 * mig-co, mig-es, mig-mix y mig-none ya cubren cada caso.
 */
const DX324 = '20261028180000_dx324_membership_specialty';

const STEPS: Step[] = [
  { until: '20260731115959', fixture: [] },
  // 20260731120000_structured_clinical_history y _remove_owner_role.
  { until: '20260801150000', fixture: FIXTURE_INITIAL },
  // 20260801150000_add_locations: ver el test de abajo.
  { until: '20260801150001' },
  // tenant_composite_fks, domain_checks, currency_fks, payment_void_audit.
  { until: '20261016170000' },
  // data_processing_consents (editada: FORCE fuera durante la copia).
  { until: '20261017113000', fixture: FIXTURE_CONSENTS },
  // payments_civil_day_noon (editada: FORCE fuera durante el backfill).
  { until: '20261017130000', fixture: FIXTURE_AUDIT },
  // audit_events_partitioned (DX-102) y dx039_clinical_record_retention.
  { until: '20261017231100', dropped: ['audit_events_dx009'] },
  // dx143_verify_active_accounts (FORCE fuera de audit_events y
  // clinic_memberships durante el backfill), dx144 y dx145.
  { until: '20261017233000', fixture: FIXTURE_LOGINS },
  // dx155_patient_ledgers (FORCE fuera de las tablas que lee y escribe
  // durante el backfill).
  { until: '20261017233050' },
  // dx136_receipt_enums, dx136_audit_events_receipt_idx y
  // dx136_payment_receipts (FORCE fuera de locations durante el relleno).
  { until: '20261017233300', fixture: FIXTURE_LOCATIONS },
  // dx128_contact_channel (FORCE fuera de patients durante el backfill del
  // canal por defecto de la clínica) y las siguientes hasta DX-203.
  { until: '20261018150100', fixture: FIXTURE_CONTACT },
  // dx203_guardian_to_responsible (FORCE fuera de patients y de
  // patient_responsible_parties durante la copia) y las siguientes hasta
  // SEC-041.
  { until: '20261019194000', fixture: FIXTURE_GUARDIAN },
  // sec041_plan_item_catalog_price (FORCE fuera de treatment_plan_items y de
  // dental_catalog_items durante el backfill) y las siguientes hasta DX-084.
  { until: '20261019224000', fixture: FIXTURE_CATALOG_PRICE },
  // dx084_avatar_keys (users es global, sin RLS) y las siguientes hasta DX-225.
  { until: '20261020100000', fixture: FIXTURE_AVATARS },
  // dx225: claves generadas de implantes, "phoneTail" con su trigger, relleno
  // por lotes con la clínica fijada (sin NO FORCE) e índice CONCURRENTLY.
  { until: '20261021120000', fixture: FIXTURE_DX225 },
  // dx236 (etiqueta del diagnóstico) y las siguientes hasta DX-287.
  {
    until: '20261024100000',
    fixture: [
      `INSERT INTO icd10_codes (code, label_es) VALUES ('K02.1', 'Texto anterior al backfill')`,
      `WITH e AS (
       INSERT INTO clinical_entries (id, "tenantId", "patientId", "entryDate", notes, "performedById")
       VALUES (gen_random_uuid(), '${T_A}', '${P_A}', now(), 'DX236 A', '${U_A}'),
              (gen_random_uuid(), '${T_B}', '${P_B}', now(), 'DX236 B', '${U_B}')
       RETURNING id, "tenantId", "patientId"
     ) INSERT INTO clinical_entry_diagnoses (id, "tenantId", "patientId", "clinicalEntryId", "icd10Code", kind, position)
       SELECT gen_random_uuid(), "tenantId", "patientId", id, 'K02.1', 'PRINCIPAL', 0 FROM e`,
    ],
  },
  // dx287: "docKey" con su trigger, relleno por lotes con la clínica fijada
  // (sin NO FORCE), índice CONCURRENTLY y ANALYZE; y las siguientes hasta
  // DX-319.
  { until: '20261024174100', fixture: FIXTURE_DX287 },
  // dx319_drop_location_reps (FORCE fuera de locations durante la copia del
  // REPS al nº de registro sanitario) y las siguientes hasta GLOBAL-G1.
  { until: G1, fixture: FIXTURE_DX319 },
  // g1_location_regional_settings (FORCE fuera de locations y de
  // location_schedules durante el backfill D5) y las siguientes hasta G1-B.
  { until: G1B, fixture: FIXTURE_G1 },
  // g1b_location_hour_cycle (FORCE fuera de locations durante el backfill del
  // reloj) y las siguientes hasta DX-328.
  { until: DX328, fixture: FIXTURE_G1B },
  // dx328_enums y dx328_audit_events_idx: las clínicas se siembran antes de
  // la columna.
  { until: DX328_COLUMN, fixture: FIXTURE_DX328 },
  // dx328_tenant_majority_age, su relleno (FORCE fuera de locations) y las
  // siguientes hasta el backfill de DX-316 (sus enums, el índice de
  // auditoría y las tablas del calendario, aún sin trigger).
  { until: DX316_DEFAULT },
  // dx316_location_calendar_default (FORCE fuera de locations y de
  // location_working_calendars durante el backfill) y las siguientes hasta
  // DX-324.
  { until: DX324, fixture: FIXTURE_DX316 },
  // dx324: especialidad del miembro, receta única, ajustes de receta de la
  // clínica y su relleno (FORCE fuera de locations), y las siguientes.
  { until: '99999999999999' },
];

describe('DX-113 · migraciones de datos con un owner sin superusuario (owner-nosu)', () => {
  const env = requireOwnerNosuEnv();
  const db = `dx113_mig_${process.pid}_${Date.now()}`;
  const dir = mkdtempSync(join(tmpdir(), 'dx113-'));
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: adminUrlFor(env, 'postgres') } },
  });
  let target: PrismaClient;
  let applied = new Set<string>();

  /** Prisma CLI como el owner; si falla, el error lleva su salida. */
  function prisma(args: string[]): void {
    try {
      execFileSync(
        join(ROOT, 'node_modules/.bin/prisma'),
        [...args, '--schema', join(dir, 'schema.prisma')],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            DATABASE_URL: ownerUrlFor(env, db),
            DIRECT_URL: ownerUrlFor(env, db),
          },
          stdio: 'pipe',
        },
      );
    } catch (err) {
      const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(
        `prisma ${args.join(' ')} falló:\n${String(stdout ?? '')}${String(stderr ?? '')}`,
      );
    }
  }

  function deploy(until: string): void {
    for (const name of readdirSync(MIGRATIONS)) {
      if (name.endsWith('.toml') || name >= until || applied.has(name)) {
        continue;
      }
      cpSync(join(MIGRATIONS, name), join(dir, 'migrations', name), {
        recursive: true,
      });
    }
    prisma(['migrate', 'deploy']);
    applied = new Set(readdirSync(join(dir, 'migrations')));
  }

  /** Filas por tabla de public (vistas por el admin, sin RLS). */
  async function counts(): Promise<Record<string, number>> {
    const rows = await target.$queryRaw<{ table: string; n: number }[]>`
      SELECT c.relname AS table,
             (xpath('/row/n/text()', query_to_xml(
                format('SELECT count(*) AS n FROM public.%I', c.relname),
                false, true, '')))[1]::text::int AS n
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND NOT c.relispartition AND c.relname <> '_prisma_migrations'`;
    return Object.fromEntries(rows.map((r) => [r.table, r.n]));
  }

  async function run(step: Step): Promise<void> {
    for (const sql of step.fixture ?? []) {
      await target.$executeRawUnsafe(sql);
    }
    const before = await counts();
    deploy(step.until);
    const after = await counts();
    const lost = Object.entries(before)
      .filter(([t]) => !(step.dropped ?? []).includes(t))
      .filter(([t, n]) => (after[t] ?? 0) < n)
      .map(([t, n]) => `${t}: ${n} → ${after[t] ?? 'sin tabla'}`);
    expect(lost).toEqual([]);
  }

  async function scalar<T>(sql: string): Promise<T> {
    const rows = await target.$queryRawUnsafe<{ v: T }[]>(sql);
    return rows[0]?.v;
  }

  beforeAll(async () => {
    const [role] = await admin.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${env.owner}`;
    // Si el owner saltara la RLS, este spec no probaría nada.
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${db}" OWNER "${env.owner}"`,
    );
    cpSync(join(ROOT, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(
      join(MIGRATIONS, 'migration_lock.toml'),
      join(dir, 'migrations', 'migration_lock.toml'),
    );
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: adminUrlFor(env, db) } },
    });
  });

  afterAll(async () => {
    await target?.$disconnect();
    await admin.$executeRawUnsafe(`ALTER ROLE "${env.owner}" NOBYPASSRLS`);
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    await admin.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('historia clínica estructurada y rol OWNER: el texto libre pasa a notes y OWNER a ADMIN', async () => {
    await run(STEPS[0]);
    await run(STEPS[1]);
    expect(
      await scalar<string>(
        `SELECT string_agg("notes", ' | ' ORDER BY "tenantId") AS v FROM "medical_history_versions"`,
      ),
    ).toBe('Control anual\n[Alergias] Penicilina | [Hábitos] Fuma');
    expect(
      await scalar<string>(
        `SELECT string_agg("role"::text, ',' ORDER BY "tenantId") AS v FROM "clinic_memberships"`,
      ),
    ).toBe('ADMIN,DENTIST');
  }, 180_000);

  it('add_locations con clínicas previas falla de forma RUIDOSA y sin tocar nada (no hay pérdida silenciosa)', async () => {
    // Inserta la sede por defecto en una tabla recién creada con FORCE: con
    // este owner la WITH CHECK de la política la rechaza. Solo puede pasar en
    // una BD con datos migrada así; un despliegue nuevo la aplica vacía.
    const before = await counts();
    expect(() => deploy('20260801150001')).toThrow(
      /row-level security policy for table "locations"/,
    );
    expect(await counts()).toEqual(before);
    // Recuperación documentada (README): repetirla una vez con BYPASSRLS
    // temporal. Aquí sirve para seguir probando las migraciones siguientes.
    prisma([
      'migrate',
      'resolve',
      '--rolled-back',
      '20260801150000_add_locations',
    ]);
    await admin.$executeRawUnsafe(`ALTER ROLE "${env.owner}" BYPASSRLS`);
    try {
      await run(STEPS[2]);
    } finally {
      await admin.$executeRawUnsafe(`ALTER ROLE "${env.owner}" NOBYPASSRLS`);
    }
    expect(
      await scalar<number>(
        `SELECT count(*)::int AS v FROM "appointments" WHERE "locationId" IS NULL`,
      ),
    ).toBe(0);
  }, 180_000);

  it('FK compuestas, reglas de dominio y anulaciones: pasan y el abono anulado conserva su fecha de anulación', async () => {
    await run(STEPS[3]);
    expect(
      await scalar<string>(
        `SELECT to_char("voidedAt", 'YYYY-MM-DD HH24:MI') AS v FROM "payments" WHERE "deletedAt" IS NOT NULL`,
      ),
    ).toBe('2026-03-03 09:30');
  }, 180_000);

  it('consentimientos: el booleano legado pasa a una fila LEGACY', async () => {
    await run(STEPS[4]);
    expect(
      await scalar<string>(
        `SELECT string_agg("patientId"::text || ':' || "granted" || ':' || "channel", ',') AS v
           FROM "data_processing_consents"`,
      ),
    ).toBe(`${P_A}:true:LEGACY`);
  }, 180_000);

  it('día civil de los abonos: las medianoches UTC pasan al mediodía de Bogotá y quedan registradas', async () => {
    await run(STEPS[5]);
    expect(
      await scalar<string>(
        `SELECT string_agg(to_char("paidAt", 'MM-DD HH24:MI'), ',' ORDER BY "paidAt") AS v FROM "payments"`,
      ),
    ).toBe('03-01 17:00,03-02 17:00,03-05 15:45');
    expect(
      await scalar<number>(
        `SELECT count(*)::int AS v FROM "payments_paidat_backfill_dx097"`,
      ),
    ).toBe(2);
  }, 180_000);

  it('auditoría particionada y retención: se conservan los eventos y se calcula la última atención', async () => {
    const events = await scalar<number>(
      `SELECT count(*)::int AS v FROM "audit_events"`,
    );
    expect(events).toBe(40);
    await run(STEPS[6]);
    expect(
      await scalar<number>(`SELECT count(*)::int AS v FROM "audit_events"`),
    ).toBe(events);
    expect(
      await scalar<string>(
        `SELECT string_agg(to_char("last_attention_at", 'YYYY-MM-DD HH24:MI'), ',' ORDER BY "tenantId") AS v FROM "patients"`,
      ),
    ).toBe('2026-03-10 14:00,2026-04-01 16:00');
  }, 180_000);

  it('emailVerifiedAt (DX-143): verifica a quien inició sesión y a la dueña del registro, no al resto, y es idempotente', async () => {
    await run(STEPS[7]);
    const verified = (): Promise<string> =>
      scalar<string>(
        `SELECT string_agg("email" || ':' || coalesce(to_char("emailVerifiedAt", 'YYYY-MM-DD HH24:MI'), '-'), ',' ORDER BY "email") AS v FROM "users"`,
      );
    const createdA = await scalar<string>(
      `SELECT to_char("createdAt", 'YYYY-MM-DD HH24:MI') AS v FROM "users" WHERE "id" = '${U_A}'`,
    );
    const expected = `a@mig.test:${createdA},b@mig.test:2026-05-01 10:00,c@mig.test:-`;
    expect(await verified()).toBe(expected);
    // Idempotente: repetirla (como hace el owner al reintentar) no cambia nada.
    const sql = readFileSync(
      join(
        MIGRATIONS,
        '20261017231100_dx143_verify_active_accounts/migration.sql',
      ),
      'utf8',
    );
    execFileSync(
      'psql',
      [
        psqlUrl(ownerUrlFor(env, db)),
        '-X',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '-1',
        '-c',
        sql,
      ],
      {
        stdio: 'pipe',
      },
    );
    expect(await verified()).toBe(expected);
  }, 180_000);

  it('resumen de la cartera (DX-155): el backfill ve las filas de las dos clínicas', async () => {
    await run(STEPS[8]);
    // A: abonó 50.000 vivos (el de 20.000 está anulado) a un plan sin ítems,
    // atendido en su sede; B: abonó 80.000, sin citas atendidas (la sede es
    // la del abono). Ninguno debe (facturable 0).
    expect(
      await scalar<string>(
        `SELECT string_agg("patientId"::text || ':' || "owing" || ':' ||
                           ("ledger" -> 'plans' -> 0 ->> 6) || ':' ||
                           ("locationId" IS NOT NULL), ',' ORDER BY "tenantId") AS v
           FROM "patient_ledgers"`,
      ),
    ).toBe(`${P_A}:false:50000.00:true,${P_B}:false:80000.00:true`);
  }, 180_000);

  it('serie de recibos (DX-136): cada sede previa recibe la suya, desambiguada dentro de su clínica', async () => {
    await run(STEPS[9]);
    expect(
      await scalar<string>(
        `SELECT string_agg("tenantId"::text || ':' || "receiptPrefix", ',' ORDER BY "tenantId", "createdAt") AS v
           FROM "locations"`,
      ),
    ).toBe(`${T_A}:PRI,${T_A}:NOR,${T_A}:NOR2,${T_B}:PRI,${T_B}:NOR`);
  }, 180_000);

  it('canal de contacto (DX-128): los pacientes quedan con el canal de su clínica, sin opt-in ni baja, y el móvil intacto', async () => {
    const events = await scalar<number>(
      `SELECT count(*)::int AS v FROM "audit_events"`,
    );
    await run(STEPS[10]);
    expect(
      await scalar<string>(
        `SELECT string_agg("contactChannel"::text || ':' || coalesce("phone", '-') || ':' ||
                (("whatsappOptInAt" IS NULL) AND ("reminderOptOutAt" IS NULL))::text,
                ',' ORDER BY "tenantId") AS v FROM "patients"`,
      ),
    ).toBe('EMAIL:310 555 0101:true,EMAIL:-:true');
    expect(
      await scalar<number>(`SELECT count(*)::int AS v FROM "audit_events"`),
    ).toBe(events);
    expect(
      await scalar<boolean>(
        `SELECT convalidated AS v FROM pg_constraint
          WHERE conname = 'audit_events_actor_check'
            AND conrelid = 'public.audit_events'::regclass`,
      ),
    ).toBe(true);
  }, 180_000);

  it('acudiente (DX-203): cada guardianName pasa a un contacto responsable, una vez, y los campos antiguos quedan', async () => {
    await run(STEPS[11]);
    expect(
      await scalar<string>(
        `SELECT string_agg(r."tenantId"::text || ':' || r."fullName" || ':' ||
                coalesce(r."docNumber", '-') || ':' || r."relationship"::text || ':' ||
                r."migratedFromGuardian"::text, ',' ORDER BY r."tenantId") AS v
           FROM "patient_responsible_parties" r`,
      ),
    ).toBe(
      `${T_A}:Claudia Navarro:52987654:LEGAL_GUARDIAN:true,${T_B}:Óscar Cifuentes:-:LEGAL_GUARDIAN:true`,
    );
    expect(
      await scalar<string>(
        `SELECT string_agg(coalesce("guardianName", '-'), ',' ORDER BY "tenantId") AS v FROM "patients"`,
      ),
    ).toBe('Claudia Navarro,Óscar Cifuentes');
  }, 180_000);

  it('precio de catálogo en el ítem (SEC-041): el backfill ve los ítems de las dos clínicas y deja NULL el ítem libre', async () => {
    await run(STEPS[12]);
    expect(
      await scalar<string>(
        `SELECT string_agg("tenantId"::text || ':' || coalesce("catalogPrice"::text, '-'), ',' ORDER BY "tenantId") AS v
           FROM "treatment_plan_items"`,
      ),
    ).toBe(`${T_A}:1000000.00,${T_B}:-`);
  }, 180_000);

  it('avatares (DX-084): las URL absolutas pasan a clave; lo ya convertido o irreconocible no cambia', async () => {
    await run(STEPS[13]);
    expect(
      await scalar<string>(
        `SELECT string_agg("email" || '=' || coalesce("avatarUrl", '-'), ',' ORDER BY "email") AS v FROM "users"`,
      ),
    ).toBe(
      [
        `a@mig.test=avatars/${U_A}.png`,
        `b@mig.test=avatars/${U_B}.jpg`,
        `c@mig.test=avatars/${U_C}.webp`,
        'd@mig.test=https://otro.cdn/foto.png',
      ].join(','),
    );
  }, 180_000);

  it('claves de búsqueda (DX-225): el implante previo queda con su clave y el relleno por lotes ve los pacientes de las dos clínicas', async () => {
    await run(STEPS[14]);
    expect(
      await scalar<string>(
        `SELECT "lotKey" || ':' || "referenceKey" AS v FROM "patient_implants"`,
      ),
    ).toBe('LOT-77:REF-9');
    expect(
      await scalar<string>(
        `SELECT count(*) FILTER (WHERE "phone" IS NOT NULL) || ':' ||
                count(*) FILTER (WHERE "phone" IS NOT NULL AND "phoneTail" IS NULL) || ':' ||
                count(*) FILTER (WHERE "phoneTail" <> pg_catalog.right(pg_catalog.regexp_replace("phone", '[^0-9]', '', 'g'), 8)) AS v
           FROM "patients"`,
      ),
    ).toBe('4502:0:0');
    expect(
      await scalar<string>(
        `SELECT string_agg(coalesce("phoneTail", '-'), ',' ORDER BY "tenantId") AS v
           FROM "patients" WHERE "id" IN ('${P_A}', '${P_B}')`,
      ),
    ).toBe('05550101,');
    expect(
      await scalar<boolean>(
        `SELECT indisvalid AS v FROM pg_index
          WHERE indexrelid = 'public.patients_tenant_phone_tail_idx'::regclass`,
      ),
    ).toBe(true);
    expect(
      await scalar<number>(
        `SELECT count(*)::int AS v FROM pg_class
          WHERE relname = 'patients_tenant_phone_tail_live_idx'`,
      ),
    ).toBe(0);
  }, 180_000);

  it('DX-236: backfill copia las etiquetas de las dos clínicas con owner sin superusuario', async () => {
    await run(STEPS[15]);
    expect(
      await scalar<string>(
        `SELECT string_agg("tenantId"::text || ':' || "labelEs", ',' ORDER BY "tenantId") AS v FROM clinical_entry_diagnoses`,
      ),
    ).toBe(
      `${T_A}:Texto anterior al backfill,${T_B}:Texto anterior al backfill`,
    );
    expect(
      await scalar<boolean>(
        `SELECT attnotnull AS v FROM pg_attribute WHERE attrelid = 'clinical_entry_diagnoses'::regclass AND attname = 'labelEs'`,
      ),
    ).toBe(true);
    expect(
      await scalar<string>(
        `SELECT tgenabled::text AS v FROM pg_trigger WHERE tgrelid = 'clinical_entry_diagnoses'::regclass AND tgname = 'clinical_entry_diagnoses_immutable'`,
      ),
    ).toBe('O');
    expect(
      await scalar<boolean>(
        `SELECT has_table_privilege('dentalix_app', 'icd10_codes', 'UPDATE') AS v`,
      ),
    ).toBe(false);
  }, 180_000);

  it('clave de documento (DX-287): el relleno por lotes ve los pacientes de las dos clínicas y da la regla de docKey()', async () => {
    await run(STEPS[16]);
    expect(
      await scalar<string>(
        `SELECT count(*) FILTER (WHERE "docNumber" IS NOT NULL) || ':' ||
                count(*) FILTER (WHERE "docNumber" IS NOT NULL AND "docKey" IS NULL) || ':' ||
                count(*) FILTER (WHERE "docNumber" IS NULL AND "docKey" IS NOT NULL) || ':' ||
                count(*) FILTER (WHERE "docKey" <> pg_catalog.upper(pg_catalog.regexp_replace("docNumber", '[^0-9A-Za-z]', '', 'g'))) AS v
           FROM "patients"`,
      ),
    ).toBe('4503:0:0:0');
    expect(
      await scalar<string>(
        `SELECT string_agg("docKey", ',' ORDER BY "tenantId") AS v
           FROM "patients" WHERE "id" IN ('${P_A}', '${P_B}')`,
      ),
    ).toBe('1111111,AB12345');
    expect(
      await scalar<string>(
        `SELECT "docKey" AS v FROM "patients" WHERE "docNumber" = '.-.'`,
      ),
    ).toBe('');
    expect(
      await scalar<string>(
        `SELECT "docKey" AS v FROM "patients"
          WHERE "tenantId" = '${T_B}' AND "lastName" = 'N4500'`,
      ),
    ).toBe('CCN4500');
    expect(
      await scalar<boolean>(
        `SELECT indisvalid AS v FROM pg_index
          WHERE indexrelid = 'public.patients_tenant_doc_key_live_idx'::regclass`,
      ),
    ).toBe(true);
    // Las altas posteriores las calcula el trigger.
    await target.$executeRawUnsafe(
      `INSERT INTO "patients" ("id","tenantId","firstName","lastName","docNumber","updatedAt")
       VALUES (gen_random_uuid(), '${T_A}', 'Nuevo', 'Trigger', 'x-9.9', now())`,
    );
    expect(
      await scalar<string>(
        `SELECT "docKey" AS v FROM "patients" WHERE "docNumber" = 'x-9.9'`,
      ),
    ).toBe('X99');
  }, 180_000);

  it('nº de registro sanitario (DX-319): el REPS de las dos clínicas se copia donde no hay nº y la columna se borra', async () => {
    await run(STEPS[17]);
    expect(
      await scalar<string>(
        `SELECT string_agg("tenantId" || '=' || "healthRegistrationNumber", ','
                ORDER BY "tenantId") AS v
           FROM "locations" WHERE "name" = 'Sede Norte'`,
      ),
    ).toBe(`${T_A}=NRS-A,${T_B}=110010123401`);
    expect(
      await scalar<number>(
        `SELECT count(*)::int AS v FROM information_schema.columns
          WHERE table_name = 'locations' AND column_name = 'repsHabilitationCode'`,
      ),
    ).toBe(0);
  }, 180_000);

  it('owner-nosu backfill fills every location and restores FORCE', async () => {
    await run(STEPS[18]);
    expect(
      await scalar<string>(
        `SELECT string_agg(
                  "name" || ':' || coalesce("currency", '-') || ':' ||
                  coalesce("timeZone", '-') || ':' || coalesce("locale", '-') || ':' ||
                  ("regionalSettingsReviewedAt" IS NULL)::text,
                  ',' ORDER BY "tenantId", "name" COLLATE "C") AS v
           FROM "locations"`,
      ),
    ).toBe(
      [
        'Sede Norte:COP:America/Bogota:es-CO:true',
        'Sede Nórte:COP:America/Bogota:es-CO:true',
        'Sede Polanco:COP:America/Mexico_City:es-CO:true',
        'Sede principal:COP:America/Bogota:es-CO:true',
        'Sede Cerrada:EUR:Europe/Madrid:es-ES:true',
        'Sede Madrid:EUR:Europe/Madrid:es-ES:true',
        'Sede Norte:COP:America/Bogota:es-CO:true',
        'Sede principal:COP:America/Bogota:es-CO:true',
      ].join(','),
    );
    expect(
      await scalar<string>(
        `SELECT string_agg(relname || '=' || relforcerowsecurity::text, ',' ORDER BY relname) AS v
           FROM pg_class
          WHERE oid IN ('public.locations'::regclass, 'public.location_schedules'::regclass)`,
      ),
    ).toBe('location_schedules=true,locations=true');
  }, 180_000);

  it('owner-nosu hour cycle backfill fills every location and restores FORCE', async () => {
    await run(STEPS[19]);
    expect(
      await scalar<string>(
        `SELECT string_agg(
                  "name" || ':' || coalesce("hourCycle", '-') || ':' ||
                  coalesce(to_char("regionalSettingsReviewedAt" AT TIME ZONE 'UTC',
                                   'YYYY-MM-DD HH24:MI'), '-'),
                  ',' ORDER BY "tenantId", "name" COLLATE "C") AS v
           FROM "locations"`,
      ),
    ).toBe(
      [
        'Sede Norte:h23:-',
        'Sede Nórte:h23:-',
        'Sede Polanco:h23:2026-10-20 10:00',
        'Sede principal:h23:-',
        'Sede Berlín:h23:-',
        'Sede Cerrada:h23:-',
        'Sede Madrid:h23:-',
        'Sede Norte:h23:-',
        'Sede principal:h23:-',
      ].join(','),
    );
    expect(
      await scalar<boolean>(
        `SELECT relforcerowsecurity AS v FROM pg_class
          WHERE oid = 'public.locations'::regclass`,
      ),
    ).toBe(true);
  }, 180_000);

  it('owner-nosu majority age backfill sees every location and restores FORCE on locations', async () => {
    await run(STEPS[20]);
    expect(
      await scalar<number>(
        `SELECT count(*)::int AS v FROM information_schema.columns
          WHERE table_name = 'tenants' AND column_name = 'majorityAge'`,
      ),
    ).toBe(0);
    await run(STEPS[21]);
    // Todas las clínicas de la BD, también las de etapas anteriores: A solo
    // tiene sedes CO; B es mixta (Madrid y la retirada son ES). Con el owner
    // sujeto a la RLS, un relleno que no viera las sedes dejaría la ES en 18.
    expect(
      await scalar<string>(
        `SELECT string_agg("subdomain" || '=' || "majorityAge", ','
                ORDER BY "subdomain") AS v FROM "tenants"`,
      ),
    ).toBe(
      [
        'mig-a=18',
        'mig-b=18',
        'mig-co=18',
        'mig-es=16',
        'mig-mix=18',
        'mig-none=18',
      ].join(','),
    );
    // Ninguna clínica con sedes se queda sin relleno: su edad es la mayor de
    // las de sus sedes.
    expect(
      await scalar<number>(
        `SELECT count(*)::int AS v FROM "tenants" t
          WHERE t."majorityAge" IS DISTINCT FROM coalesce(
            (SELECT max(CASE l."country"::text WHEN 'CO' THEN 18 WHEN 'ES' THEN 16 END)
               FROM "locations" l WHERE l."tenantId" = t."id"), 18)`,
      ),
    ).toBe(0);
    expect(
      await scalar<boolean>(
        `SELECT relforcerowsecurity AS v FROM pg_class
          WHERE oid = 'public.locations'::regclass`,
      ),
    ).toBe(true);
  }, 180_000);

  it('owner-nosu calendar backfill covers every location and restores FORCE', async () => {
    // Antes del tramo, ninguna sede tiene calendario: lo hace el backfill.
    expect(
      await scalar<number>(
        `SELECT count(*)::int AS v FROM "locations" l
          WHERE NOT EXISTS (SELECT 1 FROM "location_working_calendars" c
                             WHERE c."tenantId" = l."tenantId" AND c."locationId" = l."id")`,
      ),
    ).toBeGreaterThan(0);
    await run(STEPS[22]);
    // Toda sede de la BD, viva o retirada y de toda clínica: con el owner
    // sujeto a la RLS, un backfill que no viera las sedes no haría nada.
    expect(
      await scalar<number>(
        `SELECT count(*)::int AS v FROM "locations" l
          WHERE NOT EXISTS (SELECT 1 FROM "location_working_calendars" c
                             WHERE c."tenantId" = l."tenantId" AND c."locationId" = l."id"
                               AND c."workingWeekdays" = '{1,2,3,4,5}'::smallint[])`,
      ),
    ).toBe(0);
    expect(
      await scalar<number>(
        `SELECT count(*)::int AS v FROM "location_working_calendars"`,
      ),
    ).toBe(await scalar<number>(`SELECT count(*)::int AS v FROM "locations"`));
    expect(
      await scalar<string>(
        `SELECT string_agg(l."name" || ':' || c."workingWeekdays"::text, ','
                ORDER BY l."name" COLLATE "C") AS v
           FROM "locations" l
           JOIN "location_working_calendars" c
             ON c."tenantId" = l."tenantId" AND c."locationId" = l."id"
          WHERE l."tenantId" = '${T_CAL}'`,
      ),
    ).toBe('Sede retirada:{1,2,3,4,5},Sede viva:{1,2,3,4,5}');
    expect(
      await scalar<number>(
        `SELECT count(*)::int AS v FROM "location_holidays"`,
      ),
    ).toBe(0);
    expect(
      await scalar<string>(
        `SELECT string_agg(relname || '=' || relforcerowsecurity::text, ',' ORDER BY relname) AS v
           FROM pg_class
          WHERE oid IN ('public.locations'::regclass,
                        'public.location_working_calendars'::regclass,
                        'public.location_holidays'::regclass)`,
      ),
    ).toBe(
      'location_holidays=true,location_working_calendars=true,locations=true',
    );
  }, 180_000);

  it('owner-nosu prescription settings backfill sees every location and restores FORCE', async () => {
    expect(
      await scalar<number>(
        `SELECT count(*)::int AS v FROM information_schema.columns
          WHERE table_name = 'tenants'
            AND column_name IN ('prescriptionPrintQuantityInWords',
                                'prescriptionRequireClinicalRecordNumber',
                                'prescriptionValidityDays')`,
      ),
    ).toBe(0);
    await run(STEPS[23]);
    // Letras/HC/validez. Con el owner sujeto a la RLS, un relleno que no
    // viera las sedes dejaría a todas en false/false/30.
    expect(
      await scalar<string>(
        `SELECT string_agg("subdomain" || '=' || "prescriptionPrintQuantityInWords"
                  || '/' || "prescriptionRequireClinicalRecordNumber"
                  || '/' || "prescriptionValidityDays", ','
                ORDER BY "subdomain") AS v
           FROM "tenants"
          WHERE "subdomain" IN ('mig-a','mig-b','mig-cal','mig-co','mig-es','mig-mix','mig-none')`,
      ),
    ).toBe(
      [
        'mig-a=true/true/30',
        'mig-b=true/true/10',
        'mig-cal=true/true/30',
        'mig-co=true/true/30',
        'mig-es=true/false/10',
        'mig-mix=true/true/10',
        'mig-none=false/false/30',
      ].join(','),
    );
    // Toda clínica de la BD tiene lo que dictan sus sedes vivas (sin sedes
    // vivas, los valores de plataforma).
    expect(
      await scalar<number>(
        `SELECT count(*)::int AS v
           FROM "tenants" t
           JOIN (
             SELECT t2."id",
                    coalesce(bool_or(l."country"::text = 'CO'), false) AS hc,
                    count(l."id") > 0 AS words,
                    coalesce(min(CASE l."country"::text WHEN 'CO' THEN 30 WHEN 'ES' THEN 10 END), 30) AS days
               FROM "tenants" t2
               LEFT JOIN "locations" l
                 ON l."tenantId" = t2."id" AND l."deletedAt" IS NULL
              GROUP BY t2."id"
           ) e ON e."id" = t."id"
          WHERE t."prescriptionRequireClinicalRecordNumber" IS DISTINCT FROM e.hc
             OR t."prescriptionPrintQuantityInWords" IS DISTINCT FROM e.words
             OR t."prescriptionValidityDays" IS DISTINCT FROM e.days`,
      ),
    ).toBe(0);
    expect(
      await scalar<boolean>(
        `SELECT relforcerowsecurity AS v FROM pg_class
          WHERE oid = 'public.locations'::regclass`,
      ),
    ).toBe(true);
  }, 180_000);

  it('al terminar: FORCE en toda tabla con RLS y todo es del owner', async () => {
    const rows = await target.$queryRaw<
      { table: string; force: boolean; owner: string }[]
    >`
      SELECT c.relname AS table, c.relforcerowsecurity AS force,
             pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
         AND (c.relrowsecurity OR pg_get_userbyid(c.relowner) <> ${env.owner})`;
    expect(
      rows
        .filter((r) => !r.force || r.owner !== env.owner)
        .map((r) => `${r.table} (force=${r.force}, owner=${r.owner})`),
    ).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(50);
  });
});
