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
 *
 * Cada sección cita el documento de decisión del que sale. `dentalix-docs/…`
 * y `loop/informes/…` están en el repo dentalix-docs.
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
const PLAN_DECIDERS = roles('ADMIN', 'DENTIST');
const PLAN_REJECTERS = roles('ADMIN', 'DENTIST', 'RECEPTION');
const ADMIN_ONLY = roles('ADMIN');

export const ROUTE_ACCESS: Record<string, RouteAccess> = {
  // --- Raíz, salud y ficheros estáticos -----------------------------------
  // Avatares: dentalix-docs/docs/specs/2026-07-27-user-profile-design.md.
  'GET /': PUBLIC,
  'GET /health': PUBLIC,
  // Readiness con BD, sin tenant ni rate limit: loop/informes/DX-023.md.
  'GET /health/ready': PUBLIC,
  'GET /files/avatars/:name': PUBLIC,

  // --- Auth (sesión) -------------------------------------------------------
  // dentalix-docs/docs/plans/2026-07-24-login-drop-subdomain-host-tenant.md,
  // 2026-07-28-logout.md; cookie de refresh: loop/informes/DX-062.md.
  'POST /auth/register': PUBLIC,
  'POST /auth/login': PUBLIC,
  'POST /auth/refresh': PUBLIC,
  'POST /auth/logout': PUBLIC,

  // --- Públicas por host de clínica ---------------------------------------
  // Invitaciones: dentalix-docs/docs/plans/2026-08-01-invitaciones-backend.md;
  // confirmación de cita: loop/informes/DX-005.md.
  'GET /public/tenant/branding': PUBLIC_TENANT,
  'GET /public/invitations/:token': PUBLIC_TENANT,
  'POST /public/invitations/:token/accept': PUBLIC_TENANT,
  'GET /public/appointment-confirmations/:token': PUBLIC_TENANT,
  'POST /public/appointment-confirmations/:token': PUBLIC_TENANT,

  // --- Cualquier sesión (sin rol de clínica) -------------------------------
  // dentalix-docs/docs/plans/2026-07-28-user-profile.md (/me) y
  // 2026-07-24-exchange-service.md (/exchange y referencia).
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
  // dentalix-docs/docs/plans/2026-07-31-platform-superadmin.md.
  'GET /platform/tenants': PLATFORM,

  // --- Pacientes (demográficos) --------------------------------------------
  // dentalix-docs/docs/plans/2026-07-23-fase2c-role-matrix.md (PATIENT_ROLES).
  'POST /patients': EVERY_ROLE,
  'GET /patients': EVERY_ROLE,
  'GET /patients/:id': EVERY_ROLE,
  'PATCH /patients/:id': EVERY_ROLE,

  // --- Clínico: historia, evoluciones, odontograma, periodontograma --------
  // dentalix-docs/docs/plans/2026-07-23-fase2c-role-matrix.md (CLINICAL_ROLES);
  // periodontograma: loop/informes/DX-007.md.
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
  // loop/informes/DX-006.md.
  'GET /consent-templates': CLINICAL,
  'POST /consent-templates': ADMIN_ONLY,
  'PATCH /consent-templates/:id': ADMIN_ONLY,
  'GET /patients/:patientId/consents': CLINICAL,
  'GET /patients/:patientId/consents/preview': CLINICAL,
  'POST /patients/:patientId/consents': CLINICAL,
  'GET /patients/:patientId/consents/:id': CLINICAL,

  // --- Autorización de datos, Ley 1581 (DX-037) ----------------------------
  // loop/informes/DX-037.md.
  'GET /patients/:patientId/data-consents': EVERY_ROLE,
  'POST /patients/:patientId/data-consents': EVERY_ROLE,
  'GET /privacy-policies': EVERY_ROLE,
  'POST /privacy-policies': ADMIN_ONLY,

  // --- Recetas (DX-013) ----------------------------------------------------
  // loop/informes/DX-013.md.
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
  // dentalix-docs/docs/plans/2026-07-23-fase2c-role-matrix.md (lectura clínica,
  // escritura solo ADMIN).
  'POST /catalog/items': ADMIN_ONLY,
  'GET /catalog/items': CLINICAL,
  'GET /catalog/items/directory': CLINICAL,
  'PATCH /catalog/items/:id': ADMIN_ONLY,

  // --- Planes de tratamiento -----------------------------------------------
  // dentalix-docs/docs/plans/2026-07-24-treatment-plans.md (CLINICAL_ROLES).
  'POST /patients/:patientId/treatment-plans': CLINICAL,
  'GET /patients/:patientId/treatment-plans': CLINICAL,
  'GET /treatment-plans/:id': CLINICAL,
  // BE-002 (decisión de producto pendiente): con CLINICAL los roles clínicos,
  // que NO ven los pagos (BILLING), cambian la moneda del plan y los precios
  // de sus ítems aunque haya abonos o cuotas. La tabla fija el comportamiento
  // ACTUAL; si se decide restringirlo a ADMIN, cambia aquí y en el controlador.
  // El estado sigue la máquina de DX-040 y pasar a ACCEPTED es solo de ADMIN y
  // DENTIST: eso lo comprueba el caso de uso (403), no la ruta.
  'PATCH /treatment-plans/:id': CLINICAL,
  'POST /treatment-plans/:id/items': CLINICAL,
  'PATCH /treatment-plans/:id/items/:itemId': CLINICAL,
  'DELETE /treatment-plans/:id/items/:itemId': CLINICAL,
  // Presupuesto imprimible y aceptación firmada: loop/informes/DX-012.md.
  // Imprimirlo, los cuatro roles (recepción lo imprime y lo archiva).
  // Aceptarlo con firma: desde DX-040 solo quien decide el plan (ADMIN y
  // DENTIST); la asistente lo ve pero no lo acepta en nombre del doctor.
  'GET /patients/:patientId/treatment-plans/:planId/quote': EVERY_ROLE,
  'POST /patients/:patientId/treatment-plans/:planId/acceptance': PLAN_DECIDERS,
  // Alternativas A/B, presentar, rechazar y presupuestos por seguir:
  // loop/informes/DX-040.md. Crear una alternativa es preparar el plan
  // (CLINICAL); presentarlo, quien lo decide; rechazarlo, además recepción,
  // que llama al paciente desde la lista de seguimiento (ADMIN y recepción).
  'GET /treatment-plans/pending-follow-up': BILLING,
  'POST /treatment-plans/:id/present': PLAN_DECIDERS,
  'POST /treatment-plans/:id/reject': PLAN_REJECTERS,
  'POST /treatment-plans/:id/alternatives': CLINICAL,

  // --- Agenda --------------------------------------------------------------
  // dentalix-docs/docs/plans/2026-07-23-fase3-appointments.md; enlace de
  // confirmación: loop/informes/DX-005.md.
  'POST /appointments': EVERY_ROLE,
  'GET /appointments': EVERY_ROLE,
  'GET /appointments/:id': EVERY_ROLE,
  'PATCH /appointments/:id': EVERY_ROLE,
  'POST /appointments/:id/confirmation-link': EVERY_ROLE,

  // --- Facturación: abonos, planes de pago, estado de cuenta ---------------
  // dentalix-docs/docs/plans/2026-07-24-payments-pivot.md (PAYMENT_ROLES),
  // 2026-07-30-payment-plans-cuotas.md; estado de cuenta: loop/informes/DX-011.md;
  // planes cobrables: loop/informes/DX-067.md.
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
  // dentalix-docs/docs/plans/2026-07-24-inventory.md (INVENTORY_ROLES).
  'POST /inventory/items': STOCK,
  'GET /inventory/items': STOCK,
  'GET /inventory/items/:id': STOCK,
  'PATCH /inventory/items/:id': STOCK,
  'DELETE /inventory/items/:id': STOCK,
  'POST /inventory/items/:id/movements': STOCK,
  'GET /inventory/items/:id/movements': STOCK,

  // --- Auditoría (DX-009) --------------------------------------------------
  // loop/informes/DX-009.md: solo ADMIN (lleva IP y user agent de cada acceso).
  'GET /audit-events': ADMIN_ONLY,

  // --- Dashboard -----------------------------------------------------------
  // dentalix-docs/docs/plans/2026-07-24-dashboard.md (DASHBOARD_ROLES).
  'GET /dashboard': ADMIN_ONLY,

  // --- Sedes y horario de atención -----------------------------------------
  // dentalix-docs/docs/plans/2026-08-01-multi-sede.md y
  // dentalix-docs/docs/specs/2026-07-31-clinic-business-hours-design.md.
  'GET /locations': EVERY_ROLE,
  'POST /locations': ADMIN_ONLY,
  'PATCH /locations/:id': ADMIN_ONLY,
  'GET /locations/schedule': EVERY_ROLE,
  'PUT /locations/schedule': ADMIN_ONLY,

  // --- Personal e invitaciones ---------------------------------------------
  // dentalix-docs/docs/plans/2026-07-23-fase2c-role-matrix.md (STAFF_WRITE_ROLES)
  // y 2026-08-01-invitaciones-backend.md.
  'GET /staff': EVERY_ROLE,
  'GET /staff/directory': ADMIN_ONLY,
  'GET /staff/:userId': ADMIN_ONLY,
  'PATCH /staff/:userId': ADMIN_ONLY,
  'POST /staff/:userId/reactivate': ADMIN_ONLY,
  'DELETE /staff/:userId': ADMIN_ONLY,
  'POST /staff/invitations': ADMIN_ONLY,
  'GET /staff/invitations': ADMIN_ONLY,
  'DELETE /staff/invitations/:id': ADMIN_ONLY,
  // Reenviar invitación (DX-088): loop/informes/DX-088.md.
  'POST /staff/invitations/:id/resend': ADMIN_ONLY,

  // --- Dominios propios ----------------------------------------------------
  // docs/superpowers/specs/2026-07-23-tenant-host-resolution-design.md (este repo).
  'POST /domains': ADMIN_ONLY,
  'GET /domains': ADMIN_ONLY,
  'POST /domains/:id/verify': ADMIN_ONLY,
};
