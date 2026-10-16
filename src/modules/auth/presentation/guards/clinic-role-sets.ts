import { ClinicRole } from '@prisma/client';

// Shared `@Roles(...)` sets for the Fase 2C role matrix (owner-decided,
// 2026-07-23 — see docs/plans/2026-07-23-fase2c-role-matrix.md). Each
// controller applies exactly one of these instead of redeclaring its own
// duplicated role list.

// Pacientes (demográficos): todas las rutas, los 4 roles.
export const PATIENT_ROLES: ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.RECEPTION,
  ClinicRole.ADMIN,
];

// Historia clínica / evoluciones / odontograma: todas las rutas (read+write),
// todos MENOS recepción.
export const CLINICAL_ROLES: ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.ADMIN,
];

// Catálogo dental — leer (GET): recepción no registra clínico → no necesita
// catálogo.
export const CATALOG_READ_ROLES: ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.ADMIN,
];

// Catálogo dental — crear/editar (POST/PATCH).
export const CATALOG_WRITE_ROLES: ClinicRole[] = [ClinicRole.ADMIN];

// Plantillas de consentimiento (DX-006) — crear/editar/desactivar: solo
// gestión. Leerlas y firmar consentimientos: CLINICAL_ROLES (recepción no).
export const CONSENT_TEMPLATE_WRITE_ROLES: ClinicRole[] = [ClinicRole.ADMIN];

// Agenda de citas (Fase 3): todas las rutas, los 4 roles — recepción SÍ
// gestiona la agenda (es su trabajo), a diferencia de la historia clínica.
// Mismo array que PATIENT_ROLES (ver docs/plans/2026-07-23-fase3-appointments.md).
export const APPOINTMENT_ROLES: ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.RECEPTION,
  ClinicRole.ADMIN,
];

// Pagos / abonos (facturación): ADMIN (gestión) + RECEPTION (mostrador
// -- registra el abono del paciente), pero NO DENTIST/ASSISTANT (dato
// financiero, no clínico -- ver docs/plans/2026-07-24-payments-pivot.md
// "Global Constraints"). Reemplaza a SALES_ROLES (el módulo de ventas fue
// eliminado en el pivote a Payments, ver PAY-T2).
export const PAYMENT_ROLES: ClinicRole[] = [
  ClinicRole.ADMIN,
  ClinicRole.RECEPTION,
];

// Inventario de insumos: gestión (ADMIN) + quien de hecho maneja el
// stock del día a día (ASSISTANT), pero NO RECEPTION/DENTIST -- ver
// docs/plans/2026-07-24-inventory.md "Global Constraints" (asunción v1
// ajustable).
export const INVENTORY_ROLES: ClinicRole[] = [
  ClinicRole.ADMIN,
  ClinicRole.ASSISTANT,
];

// Dashboard del doctor: agrega pagos/abonos convertidos (dato financiero) +
// bajo stock + próximas citas + # pacientes en una sola vista de gestión ->
// ADMIN solamente, coherente con PAYMENT_ROLES (que ya restringe el
// mismo dato financiero que este endpoint expone) -- ver
// docs/plans/2026-07-24-dashboard.md "Global Constraints" (asunción v1
// ajustable).
export const DASHBOARD_ROLES: ClinicRole[] = [ClinicRole.ADMIN];

// Gestión de personal (crear/editar rol/desactivar): solo gestión.
export const STAFF_WRITE_ROLES: ClinicRole[] = [ClinicRole.ADMIN];

// Autorización de datos Ley 1581 (DX-037): la registran quienes reciben al
// paciente — recepción en el mostrador y el personal clínico en el sillón —,
// y todos necesitan leer el estado vigente y la política vigente.
export const DATA_CONSENT_ROLES: ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.RECEPTION,
  ClinicRole.ADMIN,
];

// Publicar una versión de la política de tratamiento de datos: solo gestión.
export const PRIVACY_POLICY_WRITE_ROLES: ClinicRole[] = [ClinicRole.ADMIN];

// Recetas (DX-013) — EMITIR y ANULAR: quien puede prescribir (odontólogo) y
// gestión (ADMIN, que en la clínica suele ser el odontólogo titular). La
// asistente las LEE (CLINICAL_ROLES) pero no prescribe; recepción, nada.
export const PRESCRIPTION_ISSUE_ROLES: ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ADMIN,
];

// Plantillas de receta — crear/editar/retirar: solo gestión. Leerlas:
// CLINICAL_ROLES.
export const PRESCRIPTION_TEMPLATE_WRITE_ROLES: ClinicRole[] = [
  ClinicRole.ADMIN,
];

// Presupuesto imprimible del plan (DX-012) — LEER: los cuatro roles. Recepción
// lo imprime y lo archiva (es su trabajo en el mostrador) aunque no vea el
// resto del plan clínico. ACEPTARLO con firma sigue las reglas del plan:
// CLINICAL_ROLES.
export const TREATMENT_PLAN_QUOTE_READ_ROLES: ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.RECEPTION,
  ClinicRole.ADMIN,
];

// Registro de auditoría (DX-009) — LEER: solo gestión. Lleva IP y user agent
// de cada acceso, que solo ve ADMIN.
export const AUDIT_READ_ROLES: ClinicRole[] = [ClinicRole.ADMIN];
