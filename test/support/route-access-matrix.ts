import { ClinicRole } from '@prisma/client';

/**
 * Matriz de autorización ESPERADA de la API (DX-068, hallazgo TST-001).
 *
 * Una entrada por cada `MÉTODO /ruta` de los controladores registrados en
 * AppModule (sin el prefijo global `api/v1`). Es la fuente de verdad de dos
 * tests:
 *  - `src/auth-matrix.spec.ts` (unit) recorre los controladores y exige que
 *    los guards y el `@Roles` efectivo de cada ruta coincidan con esta tabla:
 *    una ruta nueva sin entrada, una entrada sin ruta o un `@Roles` distinto
 *    hacen fallar `npm test`.
 *  - `test/role-matrix.e2e-spec.ts` comprueba en HTTP real, con un token de
 *    cada rol, que los no permitidos reciben 403 y los permitidos no.
 *
 * Los roles van escritos uno a uno, NO con los conjuntos de
 * `clinic-role-sets.ts`, a propósito: cambiar un conjunto compartido cambia
 * la autorización de muchas rutas a la vez, y eso también debe obligar a
 * tocar (y revisar) esta tabla.
 */
export type RouteAccess =
  /** Sin JwtAuthGuard: cualquiera, sin sesión. */
  | { kind: 'public'; tenantScoped: boolean }
  /** JwtAuthGuard sin @Roles: cualquier sesión válida, de cualquier rol. */
  | { kind: 'authenticated' }
  /** JwtAuthGuard + PlatformAdminGuard: solo un token de plataforma. */
  | { kind: 'platform' }
  /** JwtAuthGuard + RolesGuard + TenantContextInterceptor + @Roles. */
  | { kind: 'roles'; roles: ClinicRole[] };

type RoleName = keyof typeof ClinicRole;

/** Orden canónico de los 4 roles de clínica (el de la comparación). */
export const ALL_CLINIC_ROLES: ClinicRole[] = [
  ClinicRole.ADMIN,
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.RECEPTION,
];

/** Ordena un conjunto de roles en el orden canónico (para comparar). */
export function sortRoles(roles: readonly ClinicRole[]): ClinicRole[] {
  return ALL_CLINIC_ROLES.filter((role) => roles.includes(role));
}

function roles(...names: RoleName[]): RouteAccess {
  return { kind: 'roles', roles: sortRoles(names.map((n) => ClinicRole[n])) };
}

const PUBLIC: RouteAccess = { kind: 'public', tenantScoped: false };
const PUBLIC_TENANT: RouteAccess = { kind: 'public', tenantScoped: true };
const AUTHENTICATED: RouteAccess = { kind: 'authenticated' };
const PLATFORM: RouteAccess = { kind: 'platform' };

// Conjuntos frecuentes, escritos a mano (ver el comentario de arriba).
const EVERY_ROLE = roles('ADMIN', 'DENTIST', 'ASSISTANT', 'RECEPTION');
const CLINICAL = roles('ADMIN', 'DENTIST', 'ASSISTANT');
const BILLING = roles('ADMIN', 'RECEPTION');
const STOCK = roles('ADMIN', 'ASSISTANT');
const PRESCRIBERS = roles('ADMIN', 'DENTIST');
const ADMIN_ONLY = roles('ADMIN');

export const ROUTE_ACCESS: Record<string, RouteAccess> = {
  // --- Raíz, salud y ficheros estáticos -----------------------------------
  'GET /': PUBLIC,
  'GET /health': PUBLIC,
  'GET /files/avatars/:name': PUBLIC,

  // --- Auth (sesión) -------------------------------------------------------
  'POST /auth/register': PUBLIC,
  'POST /auth/login': PUBLIC,
  'POST /auth/refresh': PUBLIC,
  'POST /auth/logout': PUBLIC,

  // --- Públicas por host de clínica ---------------------------------------
  'GET /public/tenant/branding': PUBLIC_TENANT,
  'GET /public/invitations/:token': PUBLIC_TENANT,
  'POST /public/invitations/:token/accept': PUBLIC_TENANT,
  'GET /public/appointment-confirmations/:token': PUBLIC_TENANT,
  'POST /public/appointment-confirmations/:token': PUBLIC_TENANT,

  // --- Cualquier sesión (sin rol de clínica) -------------------------------
  'GET /me': AUTHENTICATED,
  'PATCH /me': AUTHENTICATED,
  'POST /me/password': AUTHENTICATED,
  'POST /me/avatar': AUTHENTICATED,
  'DELETE /me/avatar': AUTHENTICATED,
  'GET /exchange/rates': AUTHENTICATED,
  'GET /exchange/convert': AUTHENTICATED,
  'GET /currencies': AUTHENTICATED,
  'GET /countries': AUTHENTICATED,
  'GET /cities': AUTHENTICATED,

  // --- Plataforma (superadmin, host apex) ----------------------------------
  'GET /platform/tenants': PLATFORM,

  // --- Pacientes (demográficos) --------------------------------------------
  'POST /patients': EVERY_ROLE,
  'GET /patients': EVERY_ROLE,
  'GET /patients/:id': EVERY_ROLE,
  'PATCH /patients/:id': EVERY_ROLE,

  // --- Clínico: historia, evoluciones, odontograma, periodontograma --------
  'GET /patients/:patientId/medical-history': CLINICAL,
  'PUT /patients/:patientId/medical-history': CLINICAL,
  'POST /patients/:patientId/clinical-entries': CLINICAL,
  'GET /patients/:patientId/clinical-entries': CLINICAL,
  'POST /patients/:patientId/tooth-records': CLINICAL,
  'GET /patients/:patientId/odontogram': CLINICAL,
  'GET /patients/:patientId/teeth/:fdi/history': CLINICAL,
  'GET /patients/:patientId/perio-exams': CLINICAL,
  'POST /patients/:patientId/perio-exams': CLINICAL,
  'GET /patients/:patientId/perio-exams/:id': CLINICAL,
  'PUT /patients/:patientId/perio-exams/:id/measures': CLINICAL,
  'POST /patients/:patientId/perio-exams/:id/finalize': CLINICAL,
  'DELETE /patients/:patientId/perio-exams/:id': CLINICAL,

  // --- Consentimientos informados (DX-006) ---------------------------------
  'GET /consent-templates': CLINICAL,
  'POST /consent-templates': ADMIN_ONLY,
  'PATCH /consent-templates/:id': ADMIN_ONLY,
  'GET /patients/:patientId/consents': CLINICAL,
  'GET /patients/:patientId/consents/preview': CLINICAL,
  'POST /patients/:patientId/consents': CLINICAL,
  'GET /patients/:patientId/consents/:id': CLINICAL,

  // --- Autorización de datos, Ley 1581 (DX-037) ----------------------------
  'GET /patients/:patientId/data-consents': EVERY_ROLE,
  'POST /patients/:patientId/data-consents': EVERY_ROLE,
  'GET /privacy-policies': EVERY_ROLE,
  'POST /privacy-policies': ADMIN_ONLY,

  // --- Recetas (DX-013) ----------------------------------------------------
  'GET /prescription-templates': CLINICAL,
  'POST /prescription-templates': ADMIN_ONLY,
  'PATCH /prescription-templates/:id': ADMIN_ONLY,
  'DELETE /prescription-templates/:id': ADMIN_ONLY,
  'GET /patients/:patientId/prescriptions': CLINICAL,
  'POST /patients/:patientId/prescriptions': PRESCRIBERS,
  'GET /prescriptions/issuer': PRESCRIBERS,
  'GET /prescriptions/:id': CLINICAL,
  'POST /prescriptions/:id/void': PRESCRIBERS,

  // --- Catálogo dental -----------------------------------------------------
  'POST /catalog/items': ADMIN_ONLY,
  'GET /catalog/items': CLINICAL,
  'GET /catalog/items/directory': CLINICAL,
  'PATCH /catalog/items/:id': ADMIN_ONLY,

  // --- Planes de tratamiento -----------------------------------------------
  'POST /patients/:patientId/treatment-plans': CLINICAL,
  'GET /patients/:patientId/treatment-plans': CLINICAL,
  'GET /treatment-plans/:id': CLINICAL,
  'PATCH /treatment-plans/:id': CLINICAL,
  'POST /treatment-plans/:id/items': CLINICAL,
  'PATCH /treatment-plans/:id/items/:itemId': CLINICAL,
  'DELETE /treatment-plans/:id/items/:itemId': CLINICAL,

  // --- Agenda --------------------------------------------------------------
  'POST /appointments': EVERY_ROLE,
  'GET /appointments': EVERY_ROLE,
  'GET /appointments/:id': EVERY_ROLE,
  'PATCH /appointments/:id': EVERY_ROLE,
  'POST /appointments/:id/confirmation-link': EVERY_ROLE,

  // --- Facturación: abonos, planes de pago, estado de cuenta ---------------
  'GET /payments': BILLING,
  'POST /treatment-plans/:id/payments': BILLING,
  'GET /treatment-plans/:id/payments': BILLING,
  'GET /treatment-plans/:id/balance': BILLING,
  'DELETE /payments/:id': BILLING,
  'POST /treatment-plans/:id/payment-plan': BILLING,
  'GET /treatment-plans/:id/payment-plan': BILLING,
  'DELETE /treatment-plans/:id/payment-plan': BILLING,
  'GET /patients/:patientId/account-statement': BILLING,
  'GET /patients/:patientId/billable-plans': BILLING,

  // --- Inventario ----------------------------------------------------------
  'POST /inventory/items': STOCK,
  'GET /inventory/items': STOCK,
  'GET /inventory/items/:id': STOCK,
  'PATCH /inventory/items/:id': STOCK,
  'DELETE /inventory/items/:id': STOCK,
  'POST /inventory/items/:id/movements': STOCK,
  'GET /inventory/items/:id/movements': STOCK,

  // --- Dashboard -----------------------------------------------------------
  'GET /dashboard': ADMIN_ONLY,

  // --- Sedes y horario de atención -----------------------------------------
  'GET /locations': EVERY_ROLE,
  'POST /locations': ADMIN_ONLY,
  'PATCH /locations/:id': ADMIN_ONLY,
  'GET /locations/schedule': EVERY_ROLE,
  'PUT /locations/schedule': ADMIN_ONLY,

  // --- Personal e invitaciones ---------------------------------------------
  'GET /staff': EVERY_ROLE,
  'GET /staff/directory': ADMIN_ONLY,
  'GET /staff/:userId': ADMIN_ONLY,
  'PATCH /staff/:userId': ADMIN_ONLY,
  'POST /staff/:userId/reactivate': ADMIN_ONLY,
  'DELETE /staff/:userId': ADMIN_ONLY,
  'POST /staff/invitations': ADMIN_ONLY,
  'GET /staff/invitations': ADMIN_ONLY,
  'DELETE /staff/invitations/:id': ADMIN_ONLY,

  // --- Dominios propios ----------------------------------------------------
  'POST /domains': ADMIN_ONLY,
  'GET /domains': ADMIN_ONLY,
  'POST /domains/:id/verify': ADMIN_ONLY,
};
