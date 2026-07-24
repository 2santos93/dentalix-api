import { ClinicRole } from '@prisma/client';

// Shared `@Roles(...)` sets for the Fase 2C role matrix (owner-decided,
// 2026-07-23 — see docs/plans/2026-07-23-fase2c-role-matrix.md). Each
// controller applies exactly one of these instead of redeclaring its own
// duplicated role list.

// Pacientes (demográficos): todas las rutas, los 5 roles.
export const PATIENT_ROLES: ClinicRole[] = [
  ClinicRole.OWNER,
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.RECEPTION,
  ClinicRole.ADMIN,
];

// Historia clínica / evoluciones / odontograma: todas las rutas (read+write),
// todos MENOS recepción.
export const CLINICAL_ROLES: ClinicRole[] = [
  ClinicRole.OWNER,
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.ADMIN,
];

// Catálogo dental — leer (GET): recepción no registra clínico → no necesita
// catálogo.
export const CATALOG_READ_ROLES: ClinicRole[] = [
  ClinicRole.OWNER,
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.ADMIN,
];

// Catálogo dental — crear/editar (POST/PATCH).
export const CATALOG_WRITE_ROLES: ClinicRole[] = [
  ClinicRole.OWNER,
  ClinicRole.ADMIN,
];

// Agenda de citas (Fase 3): todas las rutas, los 5 roles — recepción SÍ
// gestiona la agenda (es su trabajo), a diferencia de la historia clínica.
// Mismo array que PATIENT_ROLES (ver docs/plans/2026-07-23-fase3-appointments.md).
export const APPOINTMENT_ROLES: ClinicRole[] = [
  ClinicRole.OWNER,
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.RECEPTION,
  ClinicRole.ADMIN,
];

// Pagos / abonos (facturación): OWNER/ADMIN (gestión) + RECEPTION (mostrador
// -- registra el abono del paciente), pero NO DENTIST/ASSISTANT (dato
// financiero, no clínico -- ver docs/plans/2026-07-24-payments-pivot.md
// "Global Constraints"). Reemplaza a SALES_ROLES (el módulo de ventas fue
// eliminado en el pivote a Payments, ver PAY-T2).
export const PAYMENT_ROLES: ClinicRole[] = [
  ClinicRole.OWNER,
  ClinicRole.ADMIN,
  ClinicRole.RECEPTION,
];

// Inventario de insumos: gestión (OWNER/ADMIN) + quien de hecho maneja el
// stock del día a día (ASSISTANT), pero NO RECEPTION/DENTIST -- ver
// docs/plans/2026-07-24-inventory.md "Global Constraints" (asunción v1
// ajustable).
export const INVENTORY_ROLES: ClinicRole[] = [
  ClinicRole.OWNER,
  ClinicRole.ADMIN,
  ClinicRole.ASSISTANT,
];

// Dashboard del doctor: agrega pagos/abonos convertidos (dato financiero) +
// bajo stock + próximas citas + # pacientes en una sola vista de gestión ->
// OWNER/ADMIN solamente, coherente con PAYMENT_ROLES (que ya restringe el
// mismo dato financiero que este endpoint expone) -- ver
// docs/plans/2026-07-24-dashboard.md "Global Constraints" (asunción v1
// ajustable).
export const DASHBOARD_ROLES: ClinicRole[] = [
  ClinicRole.OWNER,
  ClinicRole.ADMIN,
];

// Gestión de personal (crear/editar rol/desactivar): solo gestión.
export const STAFF_WRITE_ROLES: ClinicRole[] = [
  ClinicRole.OWNER,
  ClinicRole.ADMIN,
];
