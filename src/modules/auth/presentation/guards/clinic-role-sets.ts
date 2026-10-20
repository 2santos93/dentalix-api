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

// Tipos de cita (DX-121) — crear/editar/desactivar/retirar: solo gestión.
// Leerlos (selector del formulario de cita): APPOINTMENT_ROLES.
export const APPOINTMENT_TYPE_WRITE_ROLES: ClinicRole[] = [ClinicRole.ADMIN];

// Plantillas de evolución (DX-170) — crear, editar, desactivar y cargar las de
// ejemplo: solo gestión. Leerlas (selector de «Nueva evolución»):
// CLINICAL_ROLES; recepción no documenta evoluciones.
export const CLINICAL_NOTE_TEMPLATE_WRITE_ROLES: ClinicRole[] = [
  ClinicRole.ADMIN,
];

// Bloqueos de agenda (DX-122) — crear/cambiar/retirar: recepción y ADMIN, que
// gestionan la agenda de todos, y el odontólogo, solo la SUYA (lo comprueba el
// caso de uso: 403 si toca otra agenda o la de toda la sede). La asistente los
// ve en la agenda (APPOINTMENT_ROLES) pero no los crea.
export const SCHEDULE_BLOCK_WRITE_ROLES: ClinicRole[] = [
  ClinicRole.ADMIN,
  ClinicRole.RECEPTION,
  ClinicRole.DENTIST,
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
// Decidir el plan (DX-040) — PRESENTARLO al paciente y ACEPTARLO (también con
// firma, DX-012): odontólogo y ADMIN. La asistente lo ve y lo prepara
// (CLINICAL_ROLES), pero no lo acepta en nombre del doctor; recepción, nada.
// Mismo conjunto que `PLAN_DECISION_ROLES` del dominio, que lo aplica al PATCH
// de estado (abierto a CLINICAL_ROLES).
export const TREATMENT_PLAN_DECISION_ROLES: ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ADMIN,
];

// Marcar un plan presentado como RECHAZADO con su motivo (DX-040): quien decide
// el plan y, además, recepción, que llama al paciente desde «Presupuestos por
// seguir» y anota por qué no siguió. La asistente, no.
export const TREATMENT_PLAN_REJECT_ROLES: ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.RECEPTION,
  ClinicRole.ADMIN,
];

// Presupuestos por seguir (DX-040): la lista de llamadas de recepción y de la
// administración, con montos y teléfonos. Mismo criterio que PAYMENT_ROLES.
export const TREATMENT_PLAN_FOLLOW_UP_ROLES: ClinicRole[] = [
  ClinicRole.ADMIN,
  ClinicRole.RECEPTION,
];

// Retención legal de la HC (DX-039): archivar un paciente, cambiar su
// retención extendida, la supresión parcial y la lista de historias que salen
// de retención. Solo gestión: quien responde ante la Res. 839/2017 es el
// titular de la clínica.
export const PATIENT_RETENTION_ROLES: ClinicRole[] = [ClinicRole.ADMIN];

// Cartera por antigüedad (DX-145): la lista de cobro con importes y teléfonos
// de muchos pacientes. Mismo dato financiero que PAYMENT_ROLES: la ven y la
// trabajan la administración y recepción; DENTIST/ASSISTANT, no.
export const RECEIVABLES_ROLES: ClinicRole[] = [
  ClinicRole.ADMIN,
  ClinicRole.RECEPTION,
];

// Exportar la cartera a CSV (DX-145): un dato personal de muchos pacientes
// fuera del sistema. Solo gestión, y queda auditado.
export const RECEIVABLES_EXPORT_ROLES: ClinicRole[] = [ClinicRole.ADMIN];

// Registro de implantes (DX-191) — VER la sección de la ficha e IMPRIMIR la
// tarjeta de implante: los cuatro roles. Recepción entrega la tarjeta en el
// mostrador (como el presupuesto, DX-012), aunque no registre clínica.
export const IMPLANT_READ_ROLES: ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.RECEPTION,
  ClinicRole.ADMIN,
];

// REGISTRAR y ANULAR un implante (y el autocompletar de fabricantes): quien lo
// coloca (odontólogo) y gestión. Anular, además, solo el autor o un ADMIN (lo
// comprueba el caso de uso). Asistente y recepción, no.
export const IMPLANT_WRITE_ROLES: ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ADMIN,
];

// «¿Quién recibió este lote?» y su CSV (DX-191): datos personales de muchos
// pacientes para una retirada de lote. Solo gestión, y queda auditado.
export const IMPLANT_LOT_SEARCH_ROLES: ClinicRole[] = [ClinicRole.ADMIN];

// Cobranza (DX-150): registrar gestiones y compromisos de pago y leerlos en la
// ficha. Mismo dato financiero que la cartera: ADMIN y RECEPTION. DENTIST y
// ASSISTANT solo ven la marca «Saldo vencido» (sin importe) en la agenda y en
// la cabecera de la ficha.
export const COLLECTION_ROLES: ClinicRole[] = [
  ClinicRole.ADMIN,
  ClinicRole.RECEPTION,
];

// Política de descuentos (DX-204) — LEERLA: quienes editan ítems de plan
// (CLINICAL_ROLES), para que el formulario avise del tope y del motivo antes de
// enviar; la frontera es el servidor. CAMBIARLA: solo gestión.
export const DISCOUNT_POLICY_READ_ROLES: ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.ADMIN,
];
export const DISCOUNT_POLICY_WRITE_ROLES: ClinicRole[] = [ClinicRole.ADMIN];

// Informe «Descuentos» y su CSV (DX-204): lo que se regala, por profesional y
// sede, con nombres de pacientes. Solo gestión, y queda auditado.
export const DISCOUNT_REPORT_ROLES: ClinicRole[] = [ClinicRole.ADMIN];
// Caja por turno (DX-027): abrir, cerrar y consultar las cajas es del
// mostrador y de la gestión (mismo dato financiero que PAYMENT_ROLES). ADMIN
// ve todas; RECEPTION solo abre, cierra y ve las suyas (lo aplica el caso de
// uso). Reabrir un cierre, corregirlo con un ajuste y cambiar los ajustes de
// caja de la clínica: solo ADMIN.
export const CASH_SESSION_ROLES: ClinicRole[] = [
  ClinicRole.ADMIN,
  ClinicRole.RECEPTION,
];
export const CASH_SESSION_ADMIN_ROLES: ClinicRole[] = [ClinicRole.ADMIN];

// Indicaciones postoperatorias (DX-222) — LEER las plantillas y ENTREGARLAS:
// los cuatro roles; recepción entrega las indicaciones en el mostrador, como
// el presupuesto y la tarjeta de implante. Crear, editar, desactivar y cargar
// las plantillas de ejemplo: solo gestión.
export const POSTOP_ROLES: ClinicRole[] = [
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.RECEPTION,
  ClinicRole.ADMIN,
];
export const POSTOP_TEMPLATE_WRITE_ROLES: ClinicRole[] = [ClinicRole.ADMIN];
