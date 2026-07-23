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
