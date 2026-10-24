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
  // URL firmada del adaptador de disco (solo desarrollo; la firma HMAC es la
  // autorización, y con S3 responde 404): loop/informes/DX-084.md.
  'GET /files/signed': PUBLIC,
  // Subida directa del adaptador de disco (solo desarrollo; la firma HMAC del
  // formulario es la autorización, y con S3 responde 404): DX-259.
  'POST /files/uploads': PUBLIC,

  // --- Auth (sesión) -------------------------------------------------------
  // dentalix-docs/docs/plans/2026-07-24-login-drop-subdomain-host-tenant.md,
  // 2026-07-28-logout.md; cookie de refresh: loop/informes/DX-062.md.
  'POST /auth/register': PUBLIC,
  'POST /auth/register/verify': PUBLIC,
  'POST /auth/login': PUBLIC,
  'POST /auth/refresh': PUBLIC,
  'POST /auth/logout': PUBLIC,
  // DX-010: recuperar la contraseña, en el host de la clínica.
  'POST /auth/forgot-password': PUBLIC_TENANT,
  'POST /auth/reset-password/check': PUBLIC_TENANT,
  'POST /auth/reset-password': PUBLIC_TENANT,

  // --- Públicas por host de clínica ---------------------------------------
  // Invitaciones: dentalix-docs/docs/plans/2026-08-01-invitaciones-backend.md;
  // confirmación de cita: loop/informes/DX-005.md.
  'GET /public/tenant/branding': PUBLIC_TENANT,
  'GET /public/invitations/:token': PUBLIC_TENANT,
  'POST /public/invitations/:token/accept': PUBLIC_TENANT,
  'GET /public/appointment-confirmations/:token': PUBLIC_TENANT,
  'POST /public/appointment-confirmations/:token': PUBLIC_TENANT,
  // DX-128: baja de los recordatorios desde el enlace del email (el paciente).
  'GET /public/reminder-opt-outs/:token': PUBLIC_TENANT,
  'POST /public/reminder-opt-outs/:token': PUBLIC_TENANT,
  // DX-222: indicaciones postoperatorias desde el enlace del email/WhatsApp.
  'GET /public/post-op-instructions/:token': PUBLIC_TENANT,
  'POST /public/post-op-instructions/:token/opened': PUBLIC_TENANT,
  // DX-099: cuestionario de anamnesis por enlace (el paciente, sin sesión).
  'GET /public/medical-history/:token': PUBLIC_TENANT,
  'POST /public/medical-history/:token': PUBLIC_TENANT,

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
  // DX-212: CIE-10 del capítulo oral, referencia global sin datos personales.
  'GET /reference/icd10': AUTHENTICATED,

  // --- Plataforma (superadmin, host apex) ----------------------------------
  // dentalix-docs/docs/plans/2026-07-31-platform-superadmin.md.
  'GET /platform/tenants': PLATFORM,
  // Cola de fallidos de los trabajos en segundo plano: loop/informes/DX-085.md.
  'GET /platform/jobs/failed': PLATFORM,
  // Estado de la cola y reencolado de fallidos: loop/informes/DX-220.md.
  'GET /platform/jobs/stats': PLATFORM,
  'POST /platform/jobs/:id/retry': PLATFORM,
  // MFA del superadmin, exigido para el break-glass: loop/informes/SEC-008.md.
  'GET /platform/mfa': PLATFORM,
  'POST /platform/mfa/enrollment': PLATFORM,
  'POST /platform/mfa/enrollment/confirm': PLATFORM,

  // --- Pacientes (demográficos) --------------------------------------------
  // dentalix-docs/docs/plans/2026-07-23-fase2c-role-matrix.md (PATIENT_ROLES).
  'POST /patients': EVERY_ROLE,
  'GET /patients': EVERY_ROLE,
  'GET /patients/:id': EVERY_ROLE,
  'PATCH /patients/:id': EVERY_ROLE,
  // DX-128: bloque «Comunicaciones». Lo ven todos (el profesional en solo
  // lectura); el canal lo cambian recepción y ADMIN.
  'GET /patients/:id/communication': EVERY_ROLE,
  'PATCH /patients/:id/communication': roles('ADMIN', 'RECEPTION'),
  // DX-203: bloque «Responsable y familia» (dato demográfico y de cobro, no
  // clínico): como «Editar» de la ficha, los 4 roles (loop/informes/DX-203).
  'GET /patients/:patientId/responsible-parties': EVERY_ROLE,
  'POST /patients/:patientId/responsible-parties': EVERY_ROLE,
  'PATCH /patients/:patientId/responsible-parties/:partyId': EVERY_ROLE,
  'DELETE /patients/:patientId/responsible-parties/:partyId': EVERY_ROLE,
  // Retención legal de la HC (loop/informes/DX-039.md): archivar, cambiar la
  // retención extendida, supresión parcial e historias que salen de
  // retención, solo gestión.
  'DELETE /patients/:id': ADMIN_ONLY,
  'PATCH /patients/:id/retention': ADMIN_ONLY,
  'POST /patients/:id/partial-suppression': ADMIN_ONLY,
  'GET /patients/retention/expiring': ADMIN_ONLY,

  // --- Clínico: historia, evoluciones, odontograma, periodontograma --------
  // dentalix-docs/docs/plans/2026-07-23-fase2c-role-matrix.md (CLINICAL_ROLES);
  // periodontograma: loop/informes/DX-007.md.
  'GET /patients/:patientId/medical-history': CLINICAL,
  'PUT /patients/:patientId/medical-history': CLINICAL,
  // DX-247: «Sin cambios hoy» es de quien ve la anamnesis; las banderas
  // mínimas, de los roles que ven la agenda (recepción prepara la visita).
  'POST /patients/:patientId/medical-history/no-changes': CLINICAL,
  'GET /patients/:patientId/medical-alerts': EVERY_ROLE,
  'GET /medical-history/settings': EVERY_ROLE,
  'PUT /medical-history/settings': ADMIN_ONLY,
  // DX-099 (loop/informes/DX-099.md): el enlace lo crea, lo ve en la ficha y
  // lo anula cualquiera (recepción lo manda); la bandeja y las respuestas son
  // clínicas; aceptar (crea una versión de la HC) y rechazar, solo el
  // odontólogo y gestión.
  'POST /patients/:patientId/medical-history/requests': EVERY_ROLE,
  'GET /patients/:patientId/medical-history/requests': EVERY_ROLE,
  'GET /medical-history/submissions': CLINICAL,
  'GET /medical-history/submissions/summary': CLINICAL,
  'GET /medical-history/submissions/:id': CLINICAL,
  'POST /medical-history/submissions/:id/accept': roles('ADMIN', 'DENTIST'),
  'POST /medical-history/submissions/:id/reject': roles('ADMIN', 'DENTIST'),
  'POST /medical-history/submissions/:id/revoke': EVERY_ROLE,
  'POST /patients/:patientId/clinical-entries': CLINICAL,
  'GET /patients/:patientId/clinical-entries': CLINICAL,
  // DX-038: adendas; PATCH/PUT/DELETE solo responden 405 (HC inalterable).
  'POST /patients/:patientId/clinical-entries/:entryId/addenda': CLINICAL,
  'GET /patients/:patientId/clinical-entries/:entryId/addenda': CLINICAL,
  'PATCH /patients/:patientId/clinical-entries/:entryId': CLINICAL,
  'PUT /patients/:patientId/clinical-entries/:entryId': CLINICAL,
  'DELETE /patients/:patientId/clinical-entries/:entryId': CLINICAL,
  // DX-212: datos del RDA de una atención (como la historia: sin recepción).
  'GET /clinical-entries/:id/rda-readiness': CLINICAL,
  'GET /patients/:patientId/clinical-entries/rda-readiness': CLINICAL,
  // DX-170: plantillas de evolución. Leerlas, quien documenta (sin recepción);
  // crear, editar, desactivar y cargar las de ejemplo, solo ADMIN.
  'GET /clinical-note-templates': CLINICAL,
  'POST /clinical-note-templates': ADMIN_ONLY,
  'POST /clinical-note-templates/samples': ADMIN_ONLY,
  'PATCH /clinical-note-templates/:id': ADMIN_ONLY,
  // DX-222: plantillas de indicaciones postoperatorias. Leerlas, los cuatro
  // roles (recepción las entrega en el mostrador); crear, editar, desactivar y
  // cargar las de ejemplo, solo ADMIN. loop/informes/DX-222.md.
  'GET /post-op-templates': EVERY_ROLE,
  'POST /post-op-templates': ADMIN_ONLY,
  'POST /post-op-templates/samples': ADMIN_ONLY,
  'PATCH /post-op-templates/:id': ADMIN_ONLY,
  // DX-222: entregas de indicaciones por cita (sugerencias y registro por
  // impresión, email o WhatsApp) e historial en la ficha. Los cuatro roles;
  // sin PATCH ni DELETE (la entrega es inalterable). loop/informes/DX-222.md.
  'GET /appointments/:appointmentId/post-op-instructions': EVERY_ROLE,
  'POST /appointments/:appointmentId/post-op-instructions/deliveries':
    EVERY_ROLE,
  'GET /patients/:patientId/post-op-deliveries': EVERY_ROLE,
  'GET /patients/:patientId/post-op-deliveries/:id': EVERY_ROLE,
  'POST /patients/:patientId/tooth-records': CLINICAL,
  'GET /patients/:patientId/odontogram': CLINICAL,
  'GET /patients/:patientId/teeth/:fdi/history': CLINICAL,
  // DX-120: dentición y anulación (además, autor o ADMIN en el caso de uso).
  'POST /patients/:patientId/tooth-records/:recordId/void': CLINICAL,
  'GET /patients/:patientId/dentition': CLINICAL,
  'POST /patients/:patientId/dentition-events': CLINICAL,
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

  // --- Registro de implantes (DX-191) --------------------------------------
  // loop/informes/DX-191.md. Ver e imprimir la tarjeta: los 4 roles
  // (recepción la entrega); registrar y anular: odontólogo y ADMIN; buscar
  // por lote y exportar: solo ADMIN.
  'GET /patients/:patientId/implants': EVERY_ROLE,
  'POST /patients/:patientId/implants': PRESCRIBERS,
  'GET /patients/:patientId/implant-card': EVERY_ROLE,
  'POST /patients/:patientId/implant-card/print': EVERY_ROLE,
  'GET /implants/catalog': PRESCRIBERS,
  'GET /implants/search': ADMIN_ONLY,
  'GET /implants/search.csv': ADMIN_ONLY,
  'POST /implants/:id/void': PRESCRIBERS,

  // --- Documentos del paciente (DX-151) -------------------------------------
  // dentalix-docs/planning DX-151. Ver, descargar y subir: los 4 roles
  // (recepción escanea remisiones y consentimientos). Anular: la ruta admite
  // los 4, pero solo el autor o un ADMIN (403 del caso de uso).
  'POST /patients/:patientId/documents': EVERY_ROLE,
  // DX-259: subida directa al almacén (autorización y fin de la subida).
  'POST /patients/:patientId/documents/upload-url': EVERY_ROLE,
  'POST /patients/:patientId/documents/:id/complete': EVERY_ROLE,
  'GET /patients/:patientId/documents': EVERY_ROLE,
  'GET /patients/:patientId/documents/:id': EVERY_ROLE,
  'GET /patients/:patientId/documents/:id/url/inline': EVERY_ROLE,
  'GET /patients/:patientId/documents/:id/url/download': EVERY_ROLE,
  'POST /patients/:patientId/documents/:id/void': EVERY_ROLE,

  // --- Importación de pacientes (DX-107) ------------------------------------
  // loop/informes/DX-107.md: solo gestión (escribe miles de fichas y el
  // informe lleva datos de pacientes).
  'GET /patient-imports/template': ADMIN_ONLY,
  'POST /patient-imports/inspect': ADMIN_ONLY,
  'POST /patient-imports': ADMIN_ONLY,
  'GET /patient-imports': ADMIN_ONLY,
  'GET /patient-imports/:id': ADMIN_ONLY,
  'GET /patient-imports/:id/errors.csv': ADMIN_ONLY,
  'POST /patient-imports/:id/confirm': ADMIN_ONLY,
  'POST /patient-imports/:id/undo': ADMIN_ONLY,
  // DX-262: hoja de saldos («Saldo migrado») del lote; solo gestión.
  'GET /patient-imports/balances-template': ADMIN_ONLY,
  'POST /patient-imports/:id/balances': ADMIN_ONLY,
  'POST /patient-imports/:id/balances/undo': ADMIN_ONLY,
  'DELETE /patient-imports/:id/balances': ADMIN_ONLY,
  'GET /patient-imports/:id/balances/errors.csv': ADMIN_ONLY,

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
  // DX-204: «Descuento %» en bloque; el tope por rol lo aplica el caso de uso.
  'POST /treatment-plans/:id/items/bulk-discount': CLINICAL,
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
  'GET /treatment-plans/unscheduled': EVERY_ROLE,
  'GET /treatment-plans/:id/visits': EVERY_ROLE,
  'PATCH /treatment-plans/:id/visits': PLAN_DECIDERS,
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
  // Estado de los recordatorios de la cita (DX-026): quien gestiona la agenda.
  'GET /appointments/:id/reminders': EVERY_ROLE,
  // Política de cancelación (DX-279, loop/informes/DX-279.md): la vista previa
  // del aviso al cancelar y la insignia de asistencia del paciente, quien
  // gestiona la agenda (cada uno con sus sedes, DX-089).
  'GET /appointments/:id/cancellation-preview': EVERY_ROLE,
  'GET /patients/:id/attendance-summary': EVERY_ROLE,
  // Tipos de cita (DX-121, loop/informes/DX-121.md): leerlos, quien agenda;
  // gestionarlos, solo ADMIN.
  'GET /appointment-types': EVERY_ROLE,
  'POST /appointment-types': ADMIN_ONLY,
  'PATCH /appointment-types/:id': ADMIN_ONLY,
  'DELETE /appointment-types/:id': ADMIN_ONLY,
  'GET /payers': EVERY_ROLE,
  'POST /payers': roles('ADMIN', 'RECEPTION'),
  'PATCH /payers/:id': ADMIN_ONLY,
  'DELETE /payers/:id': ADMIN_ONLY,
  // DX-105: listas de precios (leerlas: quien arma el plan; escribirlas: ADMIN).
  'GET /price-lists': CLINICAL,
  'POST /price-lists': ADMIN_ONLY,
  'PATCH /price-lists/:id': ADMIN_ONLY,
  'DELETE /price-lists/:id': ADMIN_ONLY,
  'GET /price-lists/:id/items': CLINICAL,
  'PUT /price-lists/:id/items': ADMIN_ONLY,
  // DX-105: convenios (leerlos: los 4 roles; escribirlos: ADMIN).
  'GET /agreements': EVERY_ROLE,
  'POST /agreements': ADMIN_ONLY,
  'PATCH /agreements/:id': ADMIN_ONLY,
  'DELETE /agreements/:id': ADMIN_ONLY,
  // DX-105: convenio del paciente (PATIENT_ROLES).
  'GET /patients/:patientId/agreement': EVERY_ROLE,
  'PUT /patients/:patientId/agreement': EVERY_ROLE,
  'DELETE /patients/:patientId/agreement': EVERY_ROLE,
  // DX-105: precio resuelto de un ítem nuevo (CLINICAL_ROLES, R15).
  'GET /patients/:patientId/price-quote': CLINICAL,
  // DX-153: coberturas del paciente (PATIENT_ROLES).
  'GET /patients/:patientId/coverages': EVERY_ROLE,
  'POST /patients/:patientId/coverages': EVERY_ROLE,
  'PATCH /patients/:patientId/coverages/:coverageId': EVERY_ROLE,
  'DELETE /patients/:patientId/coverages/:coverageId': EVERY_ROLE,
  // «Buscar hueco», bloqueos y pendientes (DX-122, loop/informes/DX-122.md):
  // leer y agendar, quien agenda; los bloqueos los escriben ADMIN, recepción y
  // el odontólogo (solo su agenda: 403 del caso de uso), no la asistente.
  'GET /appointments/openings': EVERY_ROLE,
  // DX-210 «Ocupar este hueco»: candidatos (el odontólogo, solo de su columna:
  // lo comprueba el caso de uso), ofertas y adelantar una cita marcada.
  // loop/informes/DX-210.md.
  'GET /appointments/openings/:locationId/candidates': roles(
    'ADMIN',
    'DENTIST',
    'RECEPTION',
  ),
  'POST /appointments/openings/:locationId/offers': BILLING,
  'PATCH /appointments/openings/offers/:id': BILLING,
  'PATCH /appointments/:id/opening': BILLING,
  // DX-200 flujo del paciente en la clínica (loop/informes/DX-200.md): el
  // panel «En clínica», quien ve la agenda (el odontólogo, solo sus
  // pacientes: lo filtra el caso de uso); «Deshacer llegada», el mostrador.
  // Los pasos del flujo van por PATCH /appointments/:id (403 del caso de uso).
  'GET /appointments/in-clinic': EVERY_ROLE,
  'POST /appointments/:id/undo-arrival': roles(
    'ADMIN',
    'ASSISTANT',
    'RECEPTION',
  ),
  // DX-273 «Traer a esta cita» (loop/informes/DX-273.md): quien ve la agenda;
  // que la cita esté en la clínica y la sede de la otra cita los mira el caso
  // de uso (409 / 403).
  'POST /appointments/:id/plan-items/:planItemId/claim': EVERY_ROLE,
  'GET /schedule-blocks': EVERY_ROLE,
  'GET /schedule-blocks/affected-appointments': EVERY_ROLE,
  'POST /schedule-blocks': roles('ADMIN', 'DENTIST', 'RECEPTION'),
  'PATCH /schedule-blocks/:id': roles('ADMIN', 'DENTIST', 'RECEPTION'),
  'DELETE /schedule-blocks/:id': roles('ADMIN', 'DENTIST', 'RECEPTION'),
  'GET /waitlist': EVERY_ROLE,
  'POST /waitlist': EVERY_ROLE,
  'POST /waitlist/:id/dismiss': EVERY_ROLE,
  'POST /waitlist/:id/schedule': EVERY_ROLE,

  // --- Facturación: abonos, planes de pago, estado de cuenta ---------------
  // dentalix-docs/docs/plans/2026-07-24-payments-pivot.md (PAYMENT_ROLES),
  // 2026-07-30-payment-plans-cuotas.md; estado de cuenta: loop/informes/DX-011.md;
  // planes cobrables: loop/informes/DX-067.md.
  'GET /payments': BILLING,
  'POST /treatment-plans/:id/payments': BILLING,
  // DX-262: abono contra el saldo migrado (los mismos roles que cobran).
  'POST /opening-balances/:id/payments': BILLING,
  'GET /treatment-plans/:id/payments': BILLING,
  'GET /treatment-plans/:id/balance': BILLING,
  'DELETE /payments/:id': BILLING,
  // Recibo de caja (DX-136): loop/informes/DX-136.md.
  'GET /payments/:id/receipt': BILLING,
  'POST /payments/:id/receipt/print': BILLING,
  'POST /payments/:id/receipt/email': BILLING,
  'POST /treatment-plans/:id/payment-plan': BILLING,
  'GET /treatment-plans/:id/payment-plan': BILLING,
  'DELETE /treatment-plans/:id/payment-plan': BILLING,
  'GET /patients/:patientId/account-statement': BILLING,
  // DX-203: estado de cuenta familiar del pagador, mismos roles.
  'GET /patients/:patientId/family-account-statement': BILLING,
  'GET /patients/:patientId/billable-plans': BILLING,
  // Cartera por antigüedad: loop/informes/DX-145.md. El CSV es un dato
  // personal de muchos pacientes: solo ADMIN.
  'GET /receivables/aging': BILLING,
  'GET /receivables/aging.csv': ADMIN_ONLY,
  // Descuentos (loop/informes/DX-204.md): la política la leen quienes editan
  // ítems de plan y la cambia ADMIN; el informe y su CSV, solo ADMIN.
  'GET /discount-policy': CLINICAL,
  'PUT /discount-policy': ADMIN_ONLY,
  'GET /reports/discounts': ADMIN_ONLY,
  'GET /reports/discounts.csv': ADMIN_ONLY,
  // Reportes (loop/informes/DX-014.md): «Comparar sedes» y su CSV, la mirada
  // del dueño sobre producción, cobros y citas de todas las sedes. Solo ADMIN.
  'GET /reports/locations-comparison': ADMIN_ONLY,
  'GET /reports/locations-comparison.csv': ADMIN_ONLY,
  // DX-150: cobranza (gestiones y compromisos de pago), mismo dato financiero.
  'POST /patients/:id/collection-notes': BILLING,
  'POST /patients/:id/payment-promises': BILLING,
  'GET /patients/:id/collections': BILLING,
  // DX-027: caja por turno (loop/informes/DX-027.md). RECEPTION solo ve, abre
  // y cierra las suyas (lo decide el caso de uso); reabrir, corregir y los
  // ajustes de caja de la clínica, solo ADMIN.
  'GET /cash-sessions/settings': BILLING,
  'PUT /cash-sessions/settings': ADMIN_ONLY,
  'GET /cash-sessions/current': BILLING,
  'POST /cash-sessions/open': BILLING,
  'GET /cash-sessions': BILLING,
  'GET /cash-sessions/:id': BILLING,
  'POST /cash-sessions/:id/close': BILLING,
  'POST /cash-sessions/:id/reopen': ADMIN_ONLY,
  'POST /cash-sessions/:id/adjustments': ADMIN_ONLY,

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
  // Horario de cada profesional por sede (DX-233, loop/informes/DX-233.md):
  // lo leen los 4 roles de agenda (editor, cuadrante, sombreado); lo cambia
  // solo ADMIN, igual que el horario de la sede.
  'GET /providers/:providerId/schedule': EVERY_ROLE,
  'PUT /providers/:providerId/schedule': ADMIN_ONLY,
  'GET /providers/:providerId/schedule-overrides': EVERY_ROLE,
  'POST /providers/:providerId/schedule-overrides': ADMIN_ONLY,
  'DELETE /providers/:providerId/schedule-overrides/:overrideId': ADMIN_ONLY,
  'GET /schedule/roster': EVERY_ROLE,
  'GET /schedule/settings': EVERY_ROLE,
  'PUT /schedule/settings': ADMIN_ONLY,
  // Ajustes → Recordatorios por sede (DX-026): solo ADMIN, también para leer.
  'GET /reminder-settings': ADMIN_ONLY,
  'PUT /reminder-settings/:locationId': ADMIN_ONLY,
  // Ajustes → Sedes → Política de cancelación (DX-279): solo ADMIN, también
  // para leer; guardar crea la versión siguiente.
  'GET /locations/:id/cancellation-policy': ADMIN_ONLY,
  'POST /locations/:id/cancellation-policy': ADMIN_ONLY,

  // --- Personal e invitaciones ---------------------------------------------
  // dentalix-docs/docs/plans/2026-07-23-fase2c-role-matrix.md (STAFF_WRITE_ROLES)
  // y 2026-08-01-invitaciones-backend.md.
  'GET /staff': EVERY_ROLE,
  'GET /staff/directory': ADMIN_ONLY,
  'GET /staff/:userId': ADMIN_ONLY,
  'PATCH /staff/:userId': ADMIN_ONLY,
  'POST /staff/:userId/reactivate': ADMIN_ONLY,
  // DX-048: desbloquear el inicio de sesión de un miembro.
  'POST /staff/:userId/login-unlock': ADMIN_ONLY,
  // DX-089: sedes permitidas de un miembro.
  'GET /staff/:userId/locations': ADMIN_ONLY,
  'PUT /staff/:userId/locations': ADMIN_ONLY,
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
  // SEC-009: eliminar (soft) un dominio propio: loop/informes/SEC-009.md.
  'DELETE /domains/:id': ADMIN_ONLY,

  // --- Accesos de soporte (break-glass) -------------------------------------
  // Lista de accesos de superadmins a la clínica: loop/informes/SEC-008.md.
  'GET /support-accesses': ADMIN_ONLY,
};
