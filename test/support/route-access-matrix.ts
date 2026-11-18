import { ClinicRole, ExtraPermission } from '@prisma/client';

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
  /**
   * JwtAuthGuard + RolesGuard + TenantContextInterceptor + @Roles. DX-090:
   * `permissions`, si la ruta admite además a quien tenga concedido alguno de
   * esos permisos extra (`@AllowPermissions` en el handler).
   */
  | { kind: 'roles'; roles: ClinicRole[]; permissions?: ExtraPermission[] };

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

/**
 * DX-090: el acceso `access` (de roles) más quien tenga concedido alguno de
 * `names` (rol base O permiso extra).
 */
function orPermission(
  access: RouteAccess,
  ...names: (keyof typeof ExtraPermission)[]
): RouteAccess {
  if (access.kind !== 'roles') throw new Error('Solo rutas con @Roles');
  return {
    ...access,
    permissions: Object.values(ExtraPermission).filter((p) =>
      names.includes(p),
    ),
  };
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
// DX-018: honorarios (el DENTIST, solo lo suyo).
const COMMISSION_VIEWERS = roles('ADMIN', 'DENTIST');
// DX-017: envían y reciben trabajos de laboratorio (y recepción cambia la
// fecha prometida y la cita).
const LAB_HANDLERS = roles('ADMIN', 'DENTIST', 'RECEPTION');

export const ROUTE_ACCESS: Record<string, RouteAccess> = {
  // --- Raíz, salud y ficheros estáticos -----------------------------------
  // Avatares: dentalix-docs/docs/specs/2026-07-27-user-profile-design.md.
  'GET /': PUBLIC,
  'GET /health': PUBLIC,
  // Readiness con BD, sin tenant ni rate limit: loop/informes/DX-023.md.
  'GET /health/ready': PUBLIC,
  'GET /files/avatars/:name': PUBLIC,
  // DX-019: logo de la clínica (público por diseño, re-escrito al subirlo).
  'GET /files/logos/:name': PUBLIC,
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
  // ¿Está libre esta dirección web? (registro, mientras se escribe): sin
  // sesión ni clínica; límite propio `subdomain-check` por IP.
  'GET /public/subdomains/:slug/availability': PUBLIC,
  'POST /auth/login': PUBLIC,
  // DX-021: segundo paso del login (se autentica con el token intermedio).
  'POST /auth/login/mfa': PUBLIC,
  'POST /auth/login/mfa/enrollment': PUBLIC,
  'POST /auth/login/mfa/enrollment/confirm': PUBLIC,
  'POST /auth/refresh': PUBLIC,
  'POST /auth/logout': PUBLIC,
  // DX-010: recuperar la contraseña, en el host de la clínica.
  'POST /auth/forgot-password': PUBLIC_TENANT,
  'POST /auth/reset-password/check': PUBLIC_TENANT,
  'POST /auth/reset-password': PUBLIC_TENANT,
  // DX-137: el enlace «No fui yo» del aviso de inicio de sesión nuevo.
  'POST /auth/session-alerts/not-me': PUBLIC_TENANT,
  // GLOBAL-G1 (spec §3.5, R18): monedas para el formulario anónimo de
  // registro; la misma lista global de GET /currencies, con el límite de
  // POST /auth/register.
  'GET /public/currencies': PUBLIC,

  // --- Públicas por host de clínica ---------------------------------------
  // Invitaciones: dentalix-docs/docs/plans/2026-08-01-invitaciones-backend.md;
  // confirmación de cita: loop/informes/DX-005.md.
  'GET /public/tenant/branding': PUBLIC_TENANT,
  // DX-517-ter: la clínica sale del parámetro `host`, nunca del contexto.
  'GET /public/tenant/branding/by-host': PUBLIC,
  'GET /public/invitations/:token': PUBLIC_TENANT,
  'POST /public/invitations/:token/accept': PUBLIC_TENANT,
  'GET /public/appointment-confirmations/:token': PUBLIC_TENANT,
  'POST /public/appointment-confirmations/:token': PUBLIC_TENANT,
  // DX-469: el .ics de la cita del enlace (solo lee).
  'GET /public/appointment-confirmations/:token/calendar.ics': PUBLIC_TENANT,
  // DX-437: el paciente pide (o quita) «Avisarme si se libera un hueco antes» desde el enlace.
  'POST /public/appointment-confirmations/:token/wants-earlier': PUBLIC_TENANT,
  // DX-128: baja de los recordatorios desde el enlace del email (el paciente).
  'GET /public/reminder-opt-outs/:token': PUBLIC_TENANT,
  'POST /public/reminder-opt-outs/:token': PUBLIC_TENANT,
  // DX-568: dejar de recibir el resumen semanal desde el enlace del email
  // (el ADMIN destinatario, sin sesión).
  'GET /public/weekly-digest-unsubscribe/:token': PUBLIC_TENANT,
  'POST /public/weekly-digest-unsubscribe/:token': PUBLIC_TENANT,
  // DX-222: indicaciones postoperatorias desde el enlace del email/WhatsApp.
  'GET /public/post-op-instructions/:token': PUBLIC_TENANT,
  'POST /public/post-op-instructions/:token/opened': PUBLIC_TENANT,
  // DX-099: cuestionario de anamnesis por enlace (el paciente, sin sesión).
  'GET /public/medical-history/:token': PUBLIC_TENANT,
  'POST /public/medical-history/:token': PUBLIC_TENANT,
  'POST /public/medical-history/:token/opened': PUBLIC_TENANT,
  // DX-243: firma a distancia por enlace con código (el paciente, sin sesión).
  'GET /public/sign/:token': PUBLIC_TENANT,
  'POST /public/sign/:token/code': PUBLIC_TENANT,
  'POST /public/sign/:token/verify': PUBLIC_TENANT,
  'GET /public/sign/:token/document': PUBLIC_TENANT,
  'POST /public/sign/:token/sign': PUBLIC_TENANT,
  // DX-435: la oferta de hueco por enlace.
  'GET /public/slot-offers/:token': PUBLIC_TENANT,
  'POST /public/slot-offers/:token/accept': PUBLIC_TENANT,
  'POST /public/slot-offers/:token/decline': PUBLIC_TENANT,
  // DX-443: la copia del PDF firmado por enlace de un solo uso.
  'GET /public/signed-consent-copies/:token': PUBLIC_TENANT,
  'POST /public/signed-consent-copies/:token/download': PUBLIC_TENANT,
  // DX-467: verificar una receta por el código de su QR impreso.
  'GET /public/prescriptions/:code': PUBLIC_TENANT,
  // DX-468: la copia de la receta para el paciente, por enlace caducable.
  'GET /public/prescription-copies/:token': PUBLIC_TENANT,
  'GET /public/certificate-copies/:token': PUBLIC_TENANT,
  'GET /public/certificate-copies/:token/pdf': PUBLIC_TENANT,
  // DX-572: copia de un solo uso de la orden externa (abrir no la gasta).
  'GET /public/external-order-copies/:token': PUBLIC_TENANT,
  'POST /public/external-order-copies/:token/download': PUBLIC_TENANT,
  // DX-569: el enlace de pago del paciente (ver, apertura, comprobante y reporte).
  'GET /public/payment-links/:token': PUBLIC_TENANT,
  'POST /public/payment-links/:token/opened': PUBLIC_TENANT,
  'POST /public/payment-links/:token/proof-upload': PUBLIC_TENANT,
  'POST /public/payment-links/:token/proof-upload/complete': PUBLIC_TENANT,
  'POST /public/payment-links/:token/report': PUBLIC_TENANT,
  // DX-101: el portal del paciente (verificar la fecha y, con la cookie
  // propia del portal, ver, confirmar una cita y salir). Sin JwtAuthGuard.
  'POST /public/patient-access/:token/verify': PUBLIC_TENANT,
  'GET /public/patient-access/me': PUBLIC_TENANT,
  'POST /public/patient-access/me/appointments/:appointmentId/confirm':
    PUBLIC_TENANT,
  // DX-101-bis: aceptar un presupuesto con firma desde el portal (cookie).
  'POST /public/patient-access/me/plans/:planId/accept': PUBLIC_TENANT,
  'POST /public/patient-access/me/logout': PUBLIC_TENANT,
  // DX-464: el enlace de conformidad del profesional (recibo de honorarios).
  'GET /public/commission-receipts/:token': PUBLIC_TENANT,
  'POST /public/commission-receipts/:token/opened': PUBLIC_TENANT,
  'POST /public/commission-receipts/:token/sign': PUBLIC_TENANT,
  'GET /public/commission-receipts/:token/pdf': PUBLIC_TENANT,

  // --- Cualquier sesión (sin rol de clínica) -------------------------------
  // dentalix-docs/docs/plans/2026-07-28-user-profile.md (/me) y
  // 2026-07-24-exchange-service.md (referencia).
  'GET /me': AUTHENTICATED,
  'PATCH /me': AUTHENTICATED,
  'POST /me/password': AUTHENTICATED,
  // DX-021: verificación en dos pasos de la cuenta propia (sesión de clínica).
  'GET /me/mfa': EVERY_ROLE,
  // DX-137: «Mi perfil › Sesiones».
  'GET /me/sessions': EVERY_ROLE,
  'DELETE /me/sessions/:sessionId': EVERY_ROLE,
  'POST /me/sessions/revoke-others': EVERY_ROLE,
  'POST /me/mfa/enrollment': EVERY_ROLE,
  'POST /me/mfa/enrollment/confirm': EVERY_ROLE,
  'POST /me/mfa/disable': EVERY_ROLE,
  'POST /me/mfa/recovery-codes': EVERY_ROLE,
  'GET /me/mfa/trusted-devices': EVERY_ROLE,
  'DELETE /me/mfa/trusted-devices': EVERY_ROLE,
  'DELETE /me/mfa/trusted-devices/:id': EVERY_ROLE,
  'GET /security-policy': ADMIN_ONLY,
  'PUT /security-policy': ADMIN_ONLY,
  'POST /me/avatar': AUTHENTICATED,
  'DELETE /me/avatar': AUTHENTICATED,
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
  'POST /platform/mfa/recovery-codes': PLATFORM,

  // --- Pacientes (demográficos) --------------------------------------------
  // dentalix-docs/docs/plans/2026-07-23-fase2c-role-matrix.md (PATIENT_ROLES).
  'POST /patients': EVERY_ROLE,
  'GET /patients': EVERY_ROLE,
  'GET /patients/:id': EVERY_ROLE,
  // DX-224: «¿Quién llama?» (POST: el número va en el cuerpo, no en la URL).
  'POST /patients/lookup-by-phone': EVERY_ROLE,
  'PATCH /patients/:id': EVERY_ROLE,
  // DX-484: ficha de texto para el software de imagen (radiografía, cámara
  // intraoral): la usa el personal clínico, recepción no.
  'GET /patients/:id/imaging-export.txt': CLINICAL,
  // DX-128: bloque «Comunicaciones». Lo ven todos (el profesional en solo
  // lectura); el canal lo cambian recepción y ADMIN.
  'GET /patients/:id/communication': EVERY_ROLE,
  'GET /patients/:id/communication/opt-out-warnings': roles(
    'ADMIN',
    'RECEPTION',
  ),
  'PATCH /patients/:id/communication': roles('ADMIN', 'RECEPTION'),
  // DX-203: bloque «Responsable y familia» (dato demográfico y de cobro, no
  // clínico): como «Editar» de la ficha, los 4 roles (loop/informes/DX-203).
  'GET /patients/:patientId/responsible-parties': EVERY_ROLE,
  'POST /patients/:patientId/responsible-parties': EVERY_ROLE,
  'PATCH /patients/:patientId/responsible-parties/:partyId': EVERY_ROLE,
  'DELETE /patients/:patientId/responsible-parties/:partyId': EVERY_ROLE,
  // DX-342: paso a la mayoría de edad. Lista y revisión, mostrador (ADMIN +
  // RECEPTION); el estado del aviso de la ficha, los 4 roles.
  'GET /patients/coming-of-age': roles('ADMIN', 'RECEPTION'),
  'GET /patients/:id/majority-review': EVERY_ROLE,
  'POST /patients/:id/majority-review': roles('ADMIN', 'RECEPTION'),
  // Retención de la HC (loop/informes/DX-039.md): archivar, cambiar la
  // retención extendida, supresión parcial e historias que salen de
  // retención, solo gestión.
  'DELETE /patients/:id': ADMIN_ONLY,
  // DX-461: cuántos enlaces públicos vivos anularía archivar.
  'GET /patients/:id/live-public-links': ADMIN_ONLY,
  // DX-266: posibles duplicados y fusión segura: solo gestión.
  'GET /patient-duplicates': ADMIN_ONLY,
  'POST /patient-duplicates/dismissals': ADMIN_ONLY,
  'GET /patient-duplicates/merge-preview': ADMIN_ONLY,
  'POST /patient-duplicates/merge': ADMIN_ONLY,
  'PATCH /patients/:id/retention': ADMIN_ONLY,
  'POST /patients/:id/partial-suppression': ADMIN_ONLY,
  'GET /patients/retention/expiring': ADMIN_ONLY,
  // DX-330: el plazo de conservación lo leen todos; lo cambia gestión.
  'GET /patients/retention/settings': EVERY_ROLE,
  'PUT /patients/retention/settings': ADMIN_ONLY,
  // DX-328: la mayoría de edad de la clínica la leen todos; la cambia gestión.
  'GET /patients/settings': EVERY_ROLE,
  'PUT /patients/settings': ADMIN_ONLY,
  // DX-497: los idiomas de los pacientes los leen todos (el desplegable de la
  // ficha); los cambia gestión.
  'GET /patients/languages': EVERY_ROLE,
  'PUT /patients/languages': ADMIN_ONLY,
  // DX-327: el nombre local de cada tipo de documento lo leen todos (los
  // formularios y la importación lo usan); lo cambia gestión.
  'GET /patients/document-type-names': EVERY_ROLE,
  'PUT /patients/document-type-names': ADMIN_ONLY,

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
  // DX-540: aviso de registro profesional; lo lee quien firma, lo cambia el ADMIN.
  'GET /clinical-entries/signing': CLINICAL,
  'GET /clinical-entries/settings': CLINICAL,
  'PUT /clinical-entries/settings': ADMIN_ONLY,
  // DX-307: anestesia local en la evolución y catálogo de anestésicos.
  'GET /patients/:patientId/anesthesia': CLINICAL,
  'GET /patients/:patientId/clinical-entries/:entryId/anesthesia': CLINICAL,
  'POST /patients/:patientId/clinical-entries/:entryId/anesthesia': PRESCRIBERS,
  'POST /patients/:patientId/clinical-entries/:entryId/anesthesia/check':
    PRESCRIBERS,
  'PATCH /patients/:patientId/clinical-entries/:entryId/anesthesia/:id':
    CLINICAL,
  'PUT /patients/:patientId/clinical-entries/:entryId/anesthesia/:id': CLINICAL,
  'DELETE /patients/:patientId/clinical-entries/:entryId/anesthesia/:id':
    CLINICAL,
  'GET /anesthetics': CLINICAL,
  'POST /anesthetics': ADMIN_ONLY,
  'POST /anesthetics/samples': ADMIN_ONLY,
  'PATCH /anesthetics/:id': ADMIN_ONLY,
  // DX-407: hoja de sedación. Valoración, checklist, fármacos y egreso:
  // odontólogo y gestión; las tomas de constantes, también la asistente.
  'GET /patients/:patientId/sedation': CLINICAL,
  'GET /patients/:patientId/clinical-entries/:entryId/sedation': CLINICAL,
  'POST /patients/:patientId/clinical-entries/:entryId/sedation': PRESCRIBERS,
  'POST /patients/:patientId/clinical-entries/:entryId/sedation/checklist':
    PRESCRIBERS,
  'POST /patients/:patientId/clinical-entries/:entryId/sedation/agents':
    PRESCRIBERS,
  'POST /patients/:patientId/clinical-entries/:entryId/sedation/vitals':
    CLINICAL,
  'POST /patients/:patientId/clinical-entries/:entryId/sedation/discharge':
    PRESCRIBERS,
  'PATCH /patients/:patientId/clinical-entries/:entryId/sedation': CLINICAL,
  'PUT /patients/:patientId/clinical-entries/:entryId/sedation': CLINICAL,
  'DELETE /patients/:patientId/clinical-entries/:entryId/sedation': CLINICAL,
  // DX-170: plantillas de evolución. Leerlas, quien documenta (sin recepción);
  // crear, editar, desactivar y cargar las de ejemplo, solo ADMIN.
  'GET /clinical-note-templates': CLINICAL,
  'POST /clinical-note-templates': ADMIN_ONLY,
  'POST /clinical-note-templates/samples': ADMIN_ONLY,
  'PATCH /clinical-note-templates/:id': ADMIN_ONLY,
  // DX-559: plantillas de plan. Leer, quien arma planes; escribir, solo ADMIN.
  'GET /treatment-plan-templates': CLINICAL,
  'GET /treatment-plan-templates/:id': CLINICAL,
  'POST /treatment-plan-templates': ADMIN_ONLY,
  'PATCH /treatment-plan-templates/:id': ADMIN_ONLY,
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
  // DX-243: firma del profesional de uno firmado a distancia (el que lo envió
  // a firmar; el caso de uso lo comprueba). Enviar a firmar, verlo en la ficha
  // y anularlo: los cuatro roles (recepción lo envía), como la anamnesis.
  'POST /patients/:patientId/consents/:id/countersign': CLINICAL,
  // DX-422: reintentar el PDF firmado que no se pudo generar: los cuatro
  // roles, como el bloque de firma a distancia de la ficha (nada clínico).
  'POST /patients/:patientId/consents/:id/signed-pdf/retry': EVERY_ROLE,
  // DX-443: «Reenviar copia» del PDF firmado, los cuatro roles (nada clínico).
  'POST /patients/:patientId/consents/:id/signed-pdf/copy': EVERY_ROLE,
  'GET /patients/:patientId/signature-requests/options': EVERY_ROLE,
  'GET /patients/:patientId/signature-requests': EVERY_ROLE,
  'POST /patients/:patientId/signature-requests': EVERY_ROLE,
  'POST /patients/:patientId/signature-requests/:id/revoke': EVERY_ROLE,

  // --- Autorización de datos (DX-037) ----------------------------
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
  // DX-300: previsualización de avisos de seguridad (solo quien emite).
  'POST /patients/:patientId/prescriptions/safety-check': PRESCRIBERS,
  'GET /prescriptions/issuer': PRESCRIBERS,
  // DX-374 (loop/informes/DX-374.md): la tasa de un día depende de la
  // fuente de la clínica, así que leerla y convertir son rutas de clínica de
  // los cuatro roles; la fuente y las tasas manuales, solo el ADMIN.
  'GET /exchange/rates': EVERY_ROLE,
  'GET /exchange/convert': EVERY_ROLE,
  'GET /exchange/settings': ADMIN_ONLY,
  'PUT /exchange/settings': ADMIN_ONLY,
  // DX-517: texto propio de cada moneda de la clínica, solo ADMIN.
  'GET /exchange/currency-texts': ADMIN_ONLY,
  'PUT /exchange/currency-texts': ADMIN_ONLY,
  // DX-019: Ajustes › Datos de la clínica.
  'GET /clinic/settings': ADMIN_ONLY,
  'PATCH /clinic/settings': ADMIN_ONLY,
  // DX-091: cierre contable (ajustes y excepciones), solo ADMIN; el vigente
  // en la sede, quien registra abonos (también la asistente con el permiso).
  'GET /clinic/settings/financial-lock': ADMIN_ONLY,
  'PATCH /clinic/settings/financial-lock': ADMIN_ONLY,
  'GET /payments/period-lock': orPermission(BILLING, 'PAYMENT_REGISTER'),
  // DX-018: honorarios. ADMIN configura y cierra; el DENTIST solo ve lo suyo
  // (lo acota el caso de uso).
  'GET /commissions/rules': ADMIN_ONLY,
  'PUT /commissions/rules/:userId': ADMIN_ONLY,
  'GET /commissions/preview': COMMISSION_VIEWERS,
  'POST /commissions/settlements': ADMIN_ONLY,
  'GET /commissions/settlements': COMMISSION_VIEWERS,
  'GET /commissions/settlements/:id': COMMISSION_VIEWERS,
  // DX-464: pagar, anular, PDF y conformidad: solo ADMIN.
  'POST /commissions/settlements/:id/payments': ADMIN_ONLY,
  'POST /commissions/payments/:paymentId/void': ADMIN_ONLY,
  'GET /commissions/settlements/:id/pdf': ADMIN_ONLY,
  'GET /commissions/payments/:paymentId/receipt/pdf': ADMIN_ONLY,
  'POST /commissions/payments/:paymentId/receipt-request': ADMIN_ONLY,
  'POST /clinic/settings/logo': ADMIN_ONLY,
  'DELETE /clinic/settings/logo': ADMIN_ONLY,
  'GET /exchange/manual-rates': ADMIN_ONLY,
  'POST /exchange/manual-rates': ADMIN_ONLY,
  'PUT /exchange/manual-rates/:id': ADMIN_ONLY,
  // DX-324: ajustes de la receta de la clínica; los cambia solo el ADMIN.
  'GET /prescriptions/settings': CLINICAL,
  'PUT /prescriptions/settings': ADMIN_ONLY,
  'GET /prescriptions/:id': CLINICAL,
  'POST /prescriptions/:id/void': PRESCRIBERS,
  // DX-468: «Enviar al paciente», con el mismo acceso que imprimirla.
  'POST /prescriptions/:id/patient-copy': CLINICAL,
  // DX-306: certificados del paciente. Los cuatro roles por la ruta; el
  // reposo (DENTIST/ADMIN) y el diagnóstico los acota el caso de uso.
  'GET /patients/:patientId/certificates': EVERY_ROLE,
  'POST /patients/:patientId/certificates': EVERY_ROLE,
  'GET /patients/:patientId/certificates/appointments': EVERY_ROLE,
  'GET /patients/:patientId/certificates/:id/pdf': EVERY_ROLE,
  'POST /patients/:patientId/certificates/:id/void': EVERY_ROLE,
  'POST /patients/:patientId/certificates/:id/patient-copy': EVERY_ROLE,
  'GET /certificates/issuer': EVERY_ROLE,
  // DX-456: copia de la historia clínica; los mismos roles que la historia.
  'GET /patients/:patientId/clinical-record-copies': CLINICAL,
  'POST /patients/:patientId/clinical-record-copies': CLINICAL,
  'GET /patients/:patientId/clinical-record-copies/:copyId/document': CLINICAL,
  'GET /certificates/settings': EVERY_ROLE,
  'PUT /certificates/settings': ADMIN_ONLY,

  // --- Órdenes de estudios y referencias externas (DX-572) -----------------
  // dentalix-docs/…/DX-572/SPEC.md (D3). Los cuatro roles por la ruta; emitir
  // (DENTIST/ADMIN), anular, la nota clínica y desligar los acota el caso de
  // uso. Plantillas, ajustes y sugerencias: leer los clínicos, escribir ADMIN.
  'GET /patients/:patientId/external-orders': EVERY_ROLE,
  'POST /patients/:patientId/external-orders': EVERY_ROLE,
  'GET /external-orders/pending': EVERY_ROLE,
  'GET /external-orders/recipients': CLINICAL,
  'GET /external-orders/settings': CLINICAL,
  'PUT /external-orders/settings': ADMIN_ONLY,
  'GET /external-orders/:id': EVERY_ROLE,
  'GET /external-orders/:id/pdf': EVERY_ROLE,
  'POST /external-orders/:id/void': EVERY_ROLE,
  'POST /external-orders/:id/result': EVERY_ROLE,
  'POST /external-orders/:id/result/unlink': EVERY_ROLE,
  'POST /external-orders/:id/patient-copy': EVERY_ROLE,
  'GET /external-order-templates': CLINICAL,
  'POST /external-order-templates': ADMIN_ONLY,
  'PATCH /external-order-templates/:id': ADMIN_ONLY,

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

  // --- Ortodoncia (DX-190) ----------------------------------------------------
  // .planning/DX-190. El caso y sus controles son historia clínica: los leen
  // los roles clínicos; abren, editan, cierran y registran controles
  // odontólogo y ADMIN. La lista de seguimiento (para llamar y agendar) y la
  // lectura de los ajustes: los 4 roles. Cambiar los ajustes: solo ADMIN.
  'GET /patients/:patientId/ortho-cases': CLINICAL,
  'POST /patients/:patientId/ortho-cases': PRESCRIBERS,
  'PATCH /patients/:patientId/ortho-cases/:caseId': PRESCRIBERS,
  'POST /patients/:patientId/ortho-cases/:caseId/status': PRESCRIBERS,
  'GET /patients/:patientId/ortho-cases/:caseId/visits': CLINICAL,
  'POST /patients/:patientId/ortho-cases/:caseId/visits': PRESCRIBERS,
  'GET /ortho/settings': EVERY_ROLE,
  'PUT /ortho/settings': ADMIN_ONLY,
  'GET /ortho/follow-up': EVERY_ROLE,
  // DX-285: la cuenta del caso la ven los cuatro roles (recepción cobra); el
  // honorario y los alineadores, como el caso.
  'GET /patients/:patientId/ortho-cases/accounts': EVERY_ROLE,
  'GET /patients/:patientId/ortho-cases/:caseId/account': EVERY_ROLE,
  'PUT /patients/:patientId/ortho-cases/:caseId/fee': PRESCRIBERS,
  'POST /patients/:patientId/ortho-cases/:caseId/fee/accept': PRESCRIBERS,
  'GET /patients/:patientId/ortho-cases/:caseId/aligners': CLINICAL,
  'POST /patients/:patientId/ortho-cases/:caseId/aligner-series': PRESCRIBERS,
  'POST /patients/:patientId/ortho-cases/:caseId/aligner-series/:seriesId/deliveries':
    PRESCRIBERS,

  // --- Laboratorio dental (DX-017) -------------------------------------------
  // .planning/DX-017/CONTRACT.md. Catálogo: lo leen los 4 (selectores) y lo
  // cambia ADMIN. Órdenes: las leen los 4 (recepción sin color, material ni
  // instrucciones); crean y anulan odontólogo y ADMIN; el PATCH admite
  // recepción (el caso de uso le limita los campos a dueOn y cita); envían y
  // reciben odontólogo, recepción y ADMIN; revisan odontólogo y ADMIN; la
  // impresión (prescripción completa), los roles clínicos.
  'GET /dental-labs': EVERY_ROLE,
  'POST /dental-labs': ADMIN_ONLY,
  'PATCH /dental-labs/:labId': ADMIN_ONLY,
  'POST /dental-labs/:labId/services': ADMIN_ONLY,
  'PATCH /dental-labs/:labId/services/:serviceId': ADMIN_ONLY,
  'GET /patients/:patientId/lab-orders': EVERY_ROLE,
  'POST /patients/:patientId/lab-orders': PRESCRIBERS,
  'GET /lab-orders': EVERY_ROLE,
  'GET /lab-orders/due-date-suggestion': EVERY_ROLE,
  'GET /lab-orders/:id': EVERY_ROLE,
  'PATCH /lab-orders/:id': LAB_HANDLERS,
  'POST /lab-orders/:id/send': LAB_HANDLERS,
  'POST /lab-orders/:id/receive': LAB_HANDLERS,
  'POST /lab-orders/:id/check': PRESCRIBERS,
  'POST /lab-orders/:id/cancel': PRESCRIBERS,
  'GET /lab-orders/:id/print': CLINICAL,

  // --- Control postoperatorio (DX-566) ---------------------------------------
  // .planning/DX-566/SPEC.md (D5, D6). La lista del día y su contador, los 4
  // roles (recepción sin procedimiento, intentos ni notas); registrar el
  // desenlace (queda en la historia clínica), los roles clínicos.
  'GET /post-op-checks': EVERY_ROLE,
  'GET /post-op-checks/count': EVERY_ROLE,
  'POST /post-op-checks/:id/attempts': CLINICAL,

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
  // DX-263: hoja de citas futuras del lote; solo gestión.
  'GET /patient-imports/appointments-template': ADMIN_ONLY,
  'POST /patient-imports/:id/appointments': ADMIN_ONLY,
  'DELETE /patient-imports/:id/appointments': ADMIN_ONLY,
  'GET /patient-imports/:id/appointments/errors.csv': ADMIN_ONLY,
  'POST /patient-imports/:id/appointments/undo': ADMIN_ONLY,
  'POST /patient-imports/:id/appointments/reminders': ADMIN_ONLY,

  // --- Catálogo dental -----------------------------------------------------
  // dentalix-docs/docs/plans/2026-07-23-fase2c-role-matrix.md (lectura clínica,
  // escritura solo ADMIN).
  'POST /catalog/items': ADMIN_ONLY,
  'GET /catalog/items': CLINICAL,
  'GET /catalog/items/directory': CLINICAL,
  'PATCH /catalog/items/:id': ADMIN_ONLY,
  // DX-205: «Actualizar precios» en bloque e historial de precios: solo ADMIN.
  'GET /catalog/items/:id/price-history': ADMIN_ONLY,
  'POST /catalog/price-changes/preview': ADMIN_ONLY,
  'POST /catalog/price-changes/apply': ADMIN_ONLY,

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
  // DX-559: aplicar una plantilla, como añadir un ítem.
  'POST /treatment-plans/:id/apply-template/preview': CLINICAL,
  'POST /treatment-plans/:id/apply-template': CLINICAL,
  // DX-204: «Descuento %» en bloque; el tope por rol lo aplica el caso de uso.
  'POST /treatment-plans/:id/items/bulk-discount': CLINICAL,
  'PATCH /treatment-plans/:id/items/:itemId': CLINICAL,
  'DELETE /treatment-plans/:id/items/:itemId': CLINICAL,
  // Presupuesto imprimible y aceptación firmada: loop/informes/DX-012.md.
  // Imprimirlo, los cuatro roles (recepción lo imprime y lo archiva).
  // Aceptarlo con firma: desde DX-040 solo quien decide el plan (ADMIN y
  // DENTIST); la asistente lo ve pero no lo acepta en nombre del doctor.
  'GET /patients/:patientId/treatment-plans/:planId/quote': EVERY_ROLE,
  // DX-379: imprimir (la primera impresión fija la validez): quien lo lee.
  'POST /patients/:patientId/treatment-plans/:planId/quote/issue': EVERY_ROLE,
  'POST /patients/:patientId/treatment-plans/:planId/acceptance': PLAN_DECIDERS,
  // DX-379 (C): la vista previa del presupuesto recotizado para firmarlo
  // vencido: quien lo acepta.
  'POST /patients/:patientId/treatment-plans/:planId/acceptance/reprice-preview':
    PLAN_DECIDERS,
  // DX-417: la vista previa de aceptar en parte: quien lo acepta.
  'POST /patients/:patientId/treatment-plans/:planId/acceptance/partial-preview':
    PLAN_DECIDERS,
  // DX-379 (B): «Actualizar precios» (recotizar): los que editan los ítems
  // del plan (CLINICAL); el tope de descuento por rol lo aplica el caso de uso.
  'POST /patients/:patientId/treatment-plans/:planId/reprice/preview': CLINICAL,
  'POST /patients/:patientId/treatment-plans/:planId/reprice/apply': CLINICAL,
  // DX-379: días de validez del presupuesto. Lo leen los que leen
  // presupuestos; lo cambia solo ADMIN.
  'GET /treatment-plan-settings': EVERY_ROLE,
  'PUT /treatment-plan-settings': ADMIN_ONLY,
  // DX-448: caducidad y antelación de la oferta de hueco por enlace. La
  // leen los roles de la agenda; la cambia solo ADMIN.
  'GET /slot-offer-settings': EVERY_ROLE,
  'PUT /slot-offer-settings': ADMIN_ONLY,
  // DX-016: reserva online. La página pública (clínica por host) y, para el
  // personal, ajustes y tipos (los cambia el ADMIN) y la bandeja.
  'GET /public/booking': PUBLIC_TENANT,
  'GET /public/booking/slots': PUBLIC_TENANT,
  'POST /public/booking/verification': PUBLIC_TENANT,
  'POST /public/booking/verification/:id/verify': PUBLIC_TENANT,
  'POST /public/booking': PUBLIC_TENANT,
  'GET /online-booking/settings': EVERY_ROLE,
  'PUT /online-booking/settings': ADMIN_ONLY,
  'GET /online-booking/types': EVERY_ROLE,
  'PUT /online-booking/types/:appointmentTypeId': ADMIN_ONLY,
  'GET /online-booking/requests': EVERY_ROLE,
  'GET /online-booking/requests/pending-count': EVERY_ROLE,
  'POST /online-booking/requests/:id/accept': EVERY_ROLE,
  'POST /online-booking/requests/:id/decline': EVERY_ROLE,
  // DX-568: resumen semanal por email para el dueño: ajustes, destinatarios
  // y la prueba, solo ADMIN (las cifras son las de Reportes, solo ADMIN).
  'GET /clinic/weekly-digest-settings': ADMIN_ONLY,
  'PUT /clinic/weekly-digest-settings': ADMIN_ONLY,
  'POST /clinic/weekly-digest/send-test': ADMIN_ONLY,
  // Alternativas A/B, presentar, rechazar y presupuestos por seguir:
  // loop/informes/DX-040.md. Crear una alternativa es preparar el plan
  // (CLINICAL); presentarlo, quien lo decide; rechazarlo, además recepción,
  // que llama al paciente desde la lista de seguimiento (ADMIN y recepción).
  'GET /treatment-plans/pending-follow-up': BILLING,
  'GET /treatment-plans/pending-follow-up/count': BILLING,
  'GET /treatment-plans/unscheduled': EVERY_ROLE,
  'GET /treatment-plans/unscheduled/count': EVERY_ROLE,
  'GET /treatment-plans/:id/visits': EVERY_ROLE,
  'PATCH /treatment-plans/:id/visits': PLAN_DECIDERS,
  'POST /treatment-plans/:id/present': PLAN_DECIDERS,
  'POST /treatment-plans/:id/reject': PLAN_REJECTERS,
  // DX-561: pausar o reanudar el seguimiento (los de la lista por seguir).
  'POST /treatment-plans/:id/follow-up/pause': BILLING,
  'POST /treatment-plans/:id/follow-up/resume': BILLING,
  'POST /treatment-plans/:id/alternatives': CLINICAL,

  // --- Agenda --------------------------------------------------------------
  // dentalix-docs/docs/plans/2026-07-23-fase3-appointments.md; enlace de
  // confirmación: loop/informes/DX-005.md.
  'POST /appointments': EVERY_ROLE,
  'GET /appointments': EVERY_ROLE,
  'GET /appointments/:id': EVERY_ROLE,
  // DX-202: la salida del paciente; el saldo solo para los roles de cobro.
  // DX-202-bis: el permiso no abre la ruta; con él la asistente ve el saldo.
  'GET /appointments/:id/checkout-checklist': orPermission(
    EVERY_ROLE,
    'PAYMENT_REGISTER',
  ),
  'PATCH /appointments/:id': EVERY_ROLE,
  'POST /appointments/:id/confirmation-link': EVERY_ROLE,
  // Estado de los recordatorios de la cita (DX-026): quien gestiona la agenda.
  'GET /appointments/:id/reminders': EVERY_ROLE,
  // Política de cancelación (DX-279, loop/informes/DX-279.md): la vista previa
  // del aviso al cancelar y la insignia de asistencia del paciente, quien
  // gestiona la agenda (cada uno con sus sedes, DX-089).
  'GET /appointments/:id/cancellation-preview': EVERY_ROLE,
  'GET /patients/:id/attendance-summary': EVERY_ROLE,
  // Cargo por inasistencia o cancelación tardía (DX-291, loop/informes/
  // DX-291.md): ADMIN y RECEPTION pasan el guard; RECEPTION solo escribe si
  // la política vigente de la sede lo permite (403 del caso de uso).
  'GET /appointments/:id/cancellation-fee': roles('ADMIN', 'RECEPTION'),
  'POST /appointments/:id/cancellation-fee': roles('ADMIN', 'RECEPTION'),
  'POST /appointments/:id/cancellation-fee/waive': roles('ADMIN', 'RECEPTION'),
  // SEC-050: anular un cargo generado, con el mismo permiso que generarlo.
  'POST /appointments/:id/cancellation-fee/void': roles('ADMIN', 'RECEPTION'),
  // Tipos de cita (DX-121, loop/informes/DX-121.md): leerlos, quien agenda;
  // gestionarlos, solo ADMIN.
  'GET /appointment-types': EVERY_ROLE,
  // DX-564: un tipo por id (también retirado), con sus indicaciones previas.
  'GET /appointment-types/:id': EVERY_ROLE,
  'POST /appointment-types': ADMIN_ONLY,
  'PATCH /appointment-types/:id': ADMIN_ONLY,
  // DX-377: medios de pago; leerlos quien cobra, escribirlos solo ADMIN.
  'GET /payment-methods': orPermission(BILLING, 'PAYMENT_REGISTER'),
  'POST /payment-methods': ADMIN_ONLY,
  'PATCH /payment-methods/:id': ADMIN_ONLY,
  // DX-516: ajustes por medio de pago, solo ADMIN.
  'POST /payment-methods/:id/adjustments': ADMIN_ONLY,
  'PATCH /payment-methods/:id/adjustments/:adjustmentId': ADMIN_ONLY,
  // DX-569: datos para pagar de cada medio (leer quien cobra, escribir ADMIN).
  'GET /payment-methods/:id/instructions': BILLING,
  'PUT /payment-methods/:id/instructions': ADMIN_ONLY,
  'DELETE /payment-methods/:id/instructions/:instructionId': ADMIN_ONLY,
  // DX-569: enlace de pago del paciente y la bandeja «Pagos por confirmar».
  // DX-101: enlace de acceso del paciente (expone saldo: quien cobra).
  'POST /patients/:id/access-links': BILLING,
  'GET /patients/:id/access-links': BILLING,
  'DELETE /patients/:id/access-links/:linkId': BILLING,
  'POST /patients/:id/payment-links': BILLING,
  'GET /patients/:id/payment-links': BILLING,
  'GET /payment-reports': BILLING,
  'GET /payment-reports/count': BILLING,
  'GET /payment-reports/:id/proof-url': BILLING,
  'POST /payment-reports/:id/confirm': BILLING,
  'POST /payment-reports/:id/reject': BILLING,
  'DELETE /appointment-types/:id': ADMIN_ONLY,
  // DX-211: sillones de cada sede; leerlos quien agenda, escribirlos ADMIN.
  'GET /chairs': EVERY_ROLE,
  'POST /chairs': ADMIN_ONLY,
  'PUT /chairs/order': ADMIN_ONLY,
  'PATCH /chairs/:id': ADMIN_ONLY,
  'GET /chairs/:id/upcoming-appointments': ADMIN_ONLY,
  'POST /chairs/:id/deactivate': ADMIN_ONLY,
  'POST /chairs/:id/reactivate': ADMIN_ONLY,
  // DX-542: equipos biomédicos por sede y su hoja de vida, solo ADMIN.
  'GET /equipment': ADMIN_ONLY,
  'POST /equipment': ADMIN_ONLY,
  'GET /equipment/maintenance-due': ADMIN_ONLY,
  'GET /equipment/:id': ADMIN_ONLY,
  'PATCH /equipment/:id': ADMIN_ONLY,
  'POST /equipment/:id/retire': ADMIN_ONLY,
  'POST /equipment/:id/maintenances': ADMIN_ONLY,
  'POST /equipment/:id/maintenances/:maintenanceId/void': ADMIN_ONLY,
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
  // SEC-049 (loop/informes/SEC-049.md): verificar el nº de afiliado, solo ADMIN.
  'POST /patients/:patientId/coverages/:coverageId/verification': ADMIN_ONLY,
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
  // DX-470 «Atender sin cita» (loop/informes/DX-470.md): marca la llegada en
  // el mismo paso, así que es del mostrador (como «Llegó»); el alta mínima
  // que lo acompaña es de PATIENT_ROLES, que incluye a los tres.
  'POST /appointments/walk-in': roles('ADMIN', 'ASSISTANT', 'RECEPTION'),
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
  'GET /payments': orPermission(
    BILLING,
    'PAYMENT_REGISTER',
    'FINANCIAL_REPORTS_VIEW',
  ),
  // DX-395: la caja en CSV, mismos roles que la caja.
  'GET /payments.csv': orPermission(
    BILLING,
    'PAYMENT_REGISTER',
    'FINANCIAL_REPORTS_VIEW',
  ),
  'POST /treatment-plans/:id/payments': orPermission(
    BILLING,
    'PAYMENT_REGISTER',
  ),
  // DX-262: abono contra el saldo migrado (los mismos roles que cobran).
  'POST /opening-balances/:id/payments': orPermission(
    BILLING,
    'PAYMENT_REGISTER',
  ),
  // DX-390: cobro dividido (los mismos roles que cobran).
  'POST /treatment-plans/:id/split-payments': orPermission(
    BILLING,
    'PAYMENT_REGISTER',
  ),
  'GET /treatment-plans/:id/payments': orPermission(
    BILLING,
    'PAYMENT_REGISTER',
  ),
  'GET /treatment-plans/:id/balance': orPermission(BILLING, 'PAYMENT_REGISTER'),
  'DELETE /payments/:id': BILLING,
  // DX-389: comprobante del cobro (subida directa y URL firmada).
  'POST /payments/proofs/upload-url': orPermission(BILLING, 'PAYMENT_REGISTER'),
  'GET /payments/:id/proof/url': orPermission(BILLING, 'PAYMENT_REGISTER'),
  // DX-515: el nº de la factura fiscal externa lo ponen los roles de cobro.
  'PUT /payments/:id/external-invoice-number': BILLING,
  // Recibo de caja (DX-136): loop/informes/DX-136.md.
  'GET /payments/:id/receipt': orPermission(BILLING, 'PAYMENT_REGISTER'),
  'POST /payments/:id/receipt/print': orPermission(BILLING, 'PAYMENT_REGISTER'),
  'POST /payments/:id/receipt/email': orPermission(BILLING, 'PAYMENT_REGISTER'),
  // DX-401: resumen de los recibos de un período del paciente.
  'GET /patients/:patientId/payment-receipts/summary': BILLING,
  'POST /patients/:patientId/payment-receipts/summary/print': BILLING,
  'POST /patients/:patientId/payment-receipts/summary/email': BILLING,
  // DX-051: ver la imputación de un abono (ADMIN y recepción) y reasignarla
  // (solo ADMIN, spec R10).
  'GET /payments/:id/allocations': orPermission(BILLING, 'PAYMENT_REGISTER'),
  'PUT /payments/:id/allocations': ADMIN_ONLY,
  // DX-380: aviso de abonos sin tasa de más de 24 h (lleva a la tasa de
  // cambio, que solo cambia el ADMIN).
  'GET /payments/rate-backlog': ADMIN_ONLY,
  // DX-402: cuántos abonos de un día tomarían una tasa manual de respaldo.
  'GET /payments/rate-backlog/day': ADMIN_ONLY,
  'POST /treatment-plans/:id/payment-plan': BILLING,
  'GET /treatment-plans/:id/payment-plan': BILLING,
  // DX-123: los planes de cuotas cancelados (con autor y motivo).
  'GET /treatment-plans/:id/payment-plan/history': BILLING,
  // DX-092: cancelar con motivo. Mismos roles que antes: no saca dinero del
  // saldo (los abonos y lo facturable no cambian), a diferencia de anular un
  // abono, donde RECEPTION solo anula los suyos del día.
  'DELETE /treatment-plans/:id/payment-plan': BILLING,
  // DX-041: simular cuotas del presupuesto: quien lo imprime (el PDF las lleva).
  'POST /treatment-plans/:id/installment-simulation': EVERY_ROLE,
  'GET /patients/:patientId/account-statement': BILLING,
  // DX-203: estado de cuenta familiar del pagador, mismos roles.
  'GET /patients/:patientId/family-account-statement': BILLING,
  // DX-202-bis: elegir el plan del abono, también con PAYMENT_REGISTER.
  'GET /patients/:patientId/billable-plans': orPermission(
    BILLING,
    'PAYMENT_REGISTER',
  ),
  // Cartera por antigüedad: loop/informes/DX-145.md. El CSV es un dato
  // personal de muchos pacientes: solo ADMIN.
  'GET /receivables/aging': BILLING,
  'GET /receivables/aging/summary': BILLING,
  // DX-430: saldo a favor por paciente, mismo dato financiero que la lista.
  'GET /receivables/credit-balances': BILLING,
  // DX-146: «Por avisar hoy» (la misma cartera filtrada por la política) y la
  // política de avisos, que solo cambia ADMIN.
  'GET /receivables/reminders': BILLING,
  'PUT /receivables/reminder-policy': ADMIN_ONLY,
  'GET /receivables/aging.csv': ADMIN_ONLY,
  // DX-399: cobrado sin imputar / a cuenta (lista de abonos de muchos
  // pacientes): ADMIN y recepción, también el CSV (sin teléfonos).
  'GET /reports/unallocated-payments': orPermission(
    BILLING,
    'FINANCIAL_REPORTS_VIEW',
  ),
  'GET /reports/unallocated-payments.csv': orPermission(
    BILLING,
    'FINANCIAL_REPORTS_VIEW',
  ),
  // Descuentos (loop/informes/DX-204.md): la política la leen quienes editan
  // ítems de plan y la cambia ADMIN; el informe y su CSV, solo ADMIN.
  // DX-253: saldo a favor (loop/informes/DX-253.md): financiero, ADMIN y
  // recepción (con tope); el tope solo lo cambia ADMIN.
  'POST /treatment-plans/:id/credit-transfers': BILLING,
  'POST /treatment-plans/:id/credit-refunds': BILLING,
  'GET /credit-refunds/:id': BILLING,
  'GET /patients/:id/credit-movements': BILLING,
  'GET /patient-credit/policy': BILLING,
  'PUT /patient-credit/policy': ADMIN_ONLY,
  'GET /discount-policy': CLINICAL,
  'PUT /discount-policy': ADMIN_ONLY,
  'GET /reports/discounts': ADMIN_ONLY,
  'GET /reports/discounts.csv': ADMIN_ONLY,
  // Reportes (loop/informes/DX-014.md): «Comparar sedes» y su CSV, la mirada
  // del dueño sobre producción, cobros y citas de todas las sedes. Solo ADMIN.
  'GET /reports/locations-comparison': orPermission(
    ADMIN_ONLY,
    'FINANCIAL_REPORTS_VIEW',
  ),
  'GET /reports/locations-comparison.csv': orPermission(
    ADMIN_ONLY,
    'FINANCIAL_REPORTS_VIEW',
  ),
  // DX-423: producción por procedimiento. ADMIN ve todo el equipo; DENTIST,
  // solo lo suyo (lo acota el caso de uso). El detalle lleva pacientes.
  'GET /reports/production-by-procedure': roles('ADMIN', 'DENTIST'),
  'GET /reports/production-by-procedure.csv': roles('ADMIN', 'DENTIST'),
  'GET /reports/production-by-procedure/items': roles('ADMIN', 'DENTIST'),
  // DX-558: embudo de presupuestos. ADMIN y FINANCIAL_REPORTS_VIEW ven la
  // clínica; DENTIST, solo lo que elaboró (lo acota el caso de uso). El
  // detalle lleva pacientes; el CSV, solo ADMIN.
  'GET /reports/quote-funnel': orPermission(
    roles('ADMIN', 'DENTIST'),
    'FINANCIAL_REPORTS_VIEW',
  ),
  'GET /reports/quote-funnel.csv': ADMIN_ONLY,
  // DX-561: efectividad del seguimiento automático, con el alcance del embudo.
  'GET /reports/quote-follow-up': orPermission(
    roles('ADMIN', 'DENTIST'),
    'FINANCIAL_REPORTS_VIEW',
  ),
  'GET /reports/quote-funnel/presentations': orPermission(
    roles('ADMIN', 'DENTIST'),
    'FINANCIAL_REPORTS_VIEW',
  ),
  // DX-567: producción agendada y previsión del mes. ADMIN y
  // FINANCIAL_REPORTS_VIEW ven la clínica; DENTIST, solo lo suyo (lo acota el
  // caso de uso); recepción y asistente, nada. La lista lleva pacientes.
  'GET /reports/scheduled-production': orPermission(
    roles('ADMIN', 'DENTIST'),
    'FINANCIAL_REPORTS_VIEW',
  ),
  'GET /reports/scheduled-production/unlinked': orPermission(
    roles('ADMIN', 'DENTIST'),
    'FINANCIAL_REPORTS_VIEW',
  ),
  // DX-436: «Huecos recuperados» y su CSV (auditado). Solo ADMIN.
  'GET /reports/recovered-slots': ADMIN_ONLY,
  'GET /reports/recovered-slots.csv': ADMIN_ONLY,
  // DX-481: ocupación por sillón (REPORT_ROLES).
  'GET /reports/chair-occupancy': ADMIN_ONLY,
  'GET /reports/chair-occupancy.csv': ADMIN_ONLY,
  // DX-424: enlaces del paciente (REPORT_ROLES).
  'GET /reports/patient-links': ADMIN_ONLY,
  // DX-410: rentabilidad por sede, su CSV y el detalle de cada cifra
  // (PROFITABILITY_REPORT_ROLES).
  'GET /reports/profitability': orPermission(
    ADMIN_ONLY,
    'FINANCIAL_REPORTS_VIEW',
  ),
  'GET /reports/profitability.csv': orPermission(
    ADMIN_ONLY,
    'FINANCIAL_REPORTS_VIEW',
  ),
  'GET /reports/profitability/lines': orPermission(
    ADMIN_ONLY,
    'FINANCIAL_REPORTS_VIEW',
  ),
  // DX-439: «Pendiente de cerrar». ADMIN todo; DENTIST evolución y
  // tratamiento de sus citas; RECEPTION el desenlace (lo acota el caso de uso).
  'GET /closing-queue': roles('ADMIN', 'DENTIST', 'RECEPTION'),
  'GET /closing-queue/count': roles('ADMIN', 'DENTIST', 'RECEPTION'),
  'POST /closing-queue/dismissals': roles('ADMIN', 'DENTIST', 'RECEPTION'),
  // DX-503: «Mi día». Los cuatro roles; qué listas cuenta cada uno lo decide
  // WORK_QUEUE_ROLES, que nunca amplía el @Roles de ninguna lista.
  'GET /work-queues/summary': EVERY_ROLE,
  // DX-339: agenda de contingencia por sede (PDF de hoy y mañana con los
  // teléfonos de los pacientes): recepción y gestión; la sede la acota el
  // caso de uso (DX-089).
  'GET /locations/:locationId/contingency-agenda': roles('ADMIN', 'RECEPTION'),
  'GET /locations/:locationId/contingency-agenda/nightly': roles(
    'ADMIN',
    'RECEPTION',
  ),
  'GET /locations/:locationId/contingency-agenda/nightly/pdf': roles(
    'ADMIN',
    'RECEPTION',
  ),
  // DX-405: la copia sin conexión de la agenda, quien ve la agenda.
  'GET /locations/:locationId/contingency-agenda/offline': EVERY_ROLE,
  // DX-015: recall. La lista de llamada y sus contactos, el mostrador; fijar o
  // pausar el recall de un paciente, el personal clínico; leer el bloque de la
  // ficha (sin datos clínicos), los cuatro roles.
  'GET /recall/due': BILLING,
  'GET /recall/due/count': BILLING,
  'POST /recall/:recallId/contacts': BILLING,
  'GET /patients/:id/recalls': EVERY_ROLE,
  'PUT /patients/:id/recalls/:kind': CLINICAL,
  // DX-015-bis (porción 3): «Sin recall configurado», el mostrador como la
  // lista de vencidos; «Programar recall» con el intervalo por defecto
  // (D15), también recepción, que no puede usar el PUT.
  'GET /recall/unconfigured': BILLING,
  'POST /patients/:id/recalls/default': EVERY_ROLE,
  // DX-015-bis: los tipos de recall de la clínica (sin datos de pacientes),
  // los cuatro roles que ven la ficha.
  'GET /recall-types': EVERY_ROLE,
  // DX-015-bis (porción 2): gestionarlos (Ajustes › Recall), solo ADMIN,
  // como los tipos de cita.
  'POST /recall-types': ADMIN_ONLY,
  'PATCH /recall-types/:id': ADMIN_ONLY,
  'DELETE /recall-types/:id': ADMIN_ONLY,
  'PUT /recall-types/:id/triggers': ADMIN_ONLY,
  // DX-150: cobranza (gestiones y compromisos de pago), mismo dato financiero.
  'POST /patients/:id/collection-notes': BILLING,
  // DX-146: «Marcar avisado» es una gestión de cobranza más.
  'POST /patients/:id/balance-reminders': BILLING,
  'POST /patients/:id/payment-promises': BILLING,
  'GET /patients/:id/collections': BILLING,
  // DX-027: caja por turno (loop/informes/DX-027.md). RECEPTION solo ve, abre
  // y cierra las suyas (lo decide el caso de uso); reabrir, corregir y los
  // ajustes de caja de la clínica, solo ADMIN.
  'GET /cash-sessions/settings': orPermission(
    BILLING,
    'PAYMENT_REGISTER',
    'FINANCIAL_REPORTS_VIEW',
  ),
  'PUT /cash-sessions/settings': ADMIN_ONLY,
  // DX-515: título y leyenda del recibo (clínica y sede), solo ADMIN.
  'GET /payment-receipts/settings': ADMIN_ONLY,
  'PUT /payment-receipts/settings': ADMIN_ONLY,
  'PUT /payment-receipts/settings/locations/:locationId': ADMIN_ONLY,
  'GET /cash-sessions/current': orPermission(
    BILLING,
    'PAYMENT_REGISTER',
    'FINANCIAL_REPORTS_VIEW',
  ),
  'POST /cash-sessions/open': orPermission(BILLING, 'PAYMENT_REGISTER'),
  'GET /cash-sessions': orPermission(
    BILLING,
    'PAYMENT_REGISTER',
    'FINANCIAL_REPORTS_VIEW',
  ),
  'GET /cash-sessions/:id': orPermission(
    BILLING,
    'PAYMENT_REGISTER',
    'FINANCIAL_REPORTS_VIEW',
  ),
  'POST /cash-sessions/:id/close': orPermission(BILLING, 'PAYMENT_REGISTER'),
  'POST /cash-sessions/:id/reopen': ADMIN_ONLY,
  'POST /cash-sessions/:id/adjustments': ADMIN_ONLY,
  // DX-274: salida de caja menor desde la caja abierta de quien llama (vive
  // en el módulo de gastos; RECEPTION solo desde la suya, por construcción).
  'POST /cash-sessions/current/outflows': BILLING,

  // DX-274: gastos de la sede. La gestión es de ADMIN; recepción solo captura
  // (autorización de subida del soporte, sugerencias de proveedor y lectura de
  // las categorías). Las rutas fijas van antes de `:id` en el controlador.
  'POST /expenses/attachments/upload-url': BILLING,
  'GET /expenses/suppliers': BILLING,
  'GET /expenses': ADMIN_ONLY,
  'GET /expenses/summary': ADMIN_ONLY,
  'GET /expenses/summary.csv': ADMIN_ONLY,
  // DX-411: cuentas por pagar por proveedor (mismos roles que los gastos).
  'GET /expenses/payables': ADMIN_ONLY,
  'GET /expenses/payables.csv': ADMIN_ONLY,
  'GET /expenses/payables/expenses': ADMIN_ONLY,
  'GET /expenses.csv': ADMIN_ONLY,
  'POST /expenses': ADMIN_ONLY,
  'GET /expenses/:id': ADMIN_ONLY,
  'PATCH /expenses/:id': ADMIN_ONLY,
  'POST /expenses/:id/void': ADMIN_ONLY,
  'POST /expenses/:id/payments': ADMIN_ONLY,
  'POST /expenses/:id/payments/:paymentId/void': ADMIN_ONLY,
  'POST /expenses/:id/attachment': ADMIN_ONLY,
  'GET /expenses/:id/attachment/url': ADMIN_ONLY,
  'GET /expense-categories': BILLING,
  'POST /expense-categories': ADMIN_ONLY,
  'DELETE /expense-categories/:id': ADMIN_ONLY,

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
  // DX-020: tarjeta «Pon en marcha tu clínica» del panel (ONBOARDING_ROLES).
  'GET /onboarding/status': ADMIN_ONLY,
  'POST /onboarding/dismiss': ADMIN_ONLY,

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
  // DX-561: seguimiento automático de presupuestos por sede.
  'GET /quote-follow-up-settings': ADMIN_ONLY,
  'PUT /quote-follow-up-settings/:locationId': ADMIN_ONLY,
  // Ajustes → Sedes → Política de cancelación (DX-279): solo ADMIN, también
  // para leer; guardar crea la versión siguiente.
  'GET /locations/:id/cancellation-policy': ADMIN_ONLY,
  'POST /locations/:id/cancellation-policy': ADMIN_ONLY,
  // DX-291: vista previa del recordatorio con la política vigente.
  'GET /locations/:id/cancellation-policy/email-preview': ADMIN_ONLY,
  // DX-316: calendario de la sede (días hábiles y festivos), solo ADMIN, también
  // para leer (spec G1.5 §6, R9).
  'GET /locations/:id/calendar': ADMIN_ONLY,
  // DX-358: si un día es festivo, para avisar a quien agenda.
  'GET /locations/:id/holiday': EVERY_ROLE,
  'PUT /locations/:id/calendar/working-weekdays': ADMIN_ONLY,
  'POST /locations/:id/holidays': ADMIN_ONLY,
  'PATCH /locations/:id/holidays/:holidayId': ADMIN_ONLY,
  'DELETE /locations/:id/holidays/:holidayId': ADMIN_ONLY,
  'POST /locations/:id/holidays/import/preview': ADMIN_ONLY,
  'POST /locations/:id/holidays/import': ADMIN_ONLY,

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
  // DX-021-bis: la verificación en dos pasos de otro miembro.
  'GET /staff/:userId/mfa': ADMIN_ONLY,
  'POST /staff/:userId/mfa/reset': ADMIN_ONLY,
  // DX-137: sesiones de un miembro.
  'GET /staff/:userId/sessions': ADMIN_ONLY,
  'DELETE /staff/:userId/sessions/:sessionId': ADMIN_ONLY,
  'POST /staff/:userId/sessions/revoke-all': ADMIN_ONLY,
  // DX-089: sedes permitidas de un miembro.
  // DX-090: permisos extra de un miembro (solo ADMIN; nunca los propios).
  'PUT /staff/:userId/permissions': ADMIN_ONLY,
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
