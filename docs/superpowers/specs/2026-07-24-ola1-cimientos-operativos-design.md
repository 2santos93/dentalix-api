# Ola 1 — Cimientos operativos (staff CRUD + dashboard del doctor + agenda semanal)

Date: 2026-07-24
Status: Approved

## Problem

El backend de Dentalix es mucho más amplio que su UI: ventas, inventario, planes de
tratamiento y un **dashboard del doctor (`GET /dashboard`) ya funcionan**, pero el Web solo
expone login, registro, pacientes y agenda. Además la gestión de **personal es de solo
lectura** (`GET /staff`): no hay forma de crear un dentista/recepción ni cambiar roles, lo que
hace que la agenda "multi-profesional" no sea realmente usable (cada clínica arranca con un
único usuario OWNER seleccionable como profesional).

Esta ola cierra esa brecha operativa con tres piezas de bajo riesgo y alto valor, reutilizando
al máximo lo que ya existe.

## Goals

1. **CRUD de personal** (API + Web): crear, editar rol/nombre y desactivar miembros de la
   clínica, con permisos OWNER/ADMIN. Desbloquea la agenda multi-profesional real.
2. **Dashboard del doctor** (Web): materializar el `GET /dashboard` ya existente — ingresos
   día/semana/mes, citas de hoy, # de pacientes y stock bajo — con selector de moneda.
3. **Vista semanal de la agenda** (Web): alternar Día | Semana sobre el mismo endpoint de
   listado por rango.

## Non-goals (van en olas siguientes)

- Drag-and-drop y multi-sillón/box en la agenda.
- Vista mensual.
- Invitación de personal por correo y cambio de contraseña obligado en el primer ingreso
  (dependen de la ola de notificaciones). V1 usa **alta directa con contraseña inicial**.
- Cualquier cambio al contrato del endpoint `GET /dashboard` (se consume tal cual está).
- Notificaciones, portal del paciente, cumplimiento DIAN/RIPS, IA (olas posteriores).

## Decisiones tomadas (con el owner, 2026-07-24)

- **Alta de personal**: alta directa — el OWNER/ADMIN escribe nombre, email, rol y una
  contraseña inicial; el miembro entra de inmediato.
- **Moneda del dashboard**: **selector en la UI** (COP por defecto); reconsulta los totales
  convertidos al cambiarla.

---

## Design — Parte A: CRUD de personal (dentalix-api + dentalix-web)

### A.1 Dominio (`src/modules/staff/domain`)

- **Entidad `StaffMember`**: se agrega `email: string`. (Hoy es `{ userId, fullName, role }`.)
- **Puerto `StaffRepository`** — se amplía con:
  - `create(input: { fullName; email; role; passwordHash }): Promise<StaffMember>`
  - `updateById(userId, patch: { fullName?; role? }): Promise<StaffMember | null>`
  - `deactivateById(userId): Promise<boolean>` — soft-delete de la membresía (`deletedAt`).
  - `findById(userId): Promise<StaffMember | null>`
  - `countActiveOwners(): Promise<number>` — para invariantes.
  - `findUserByEmailGlobal(email): Promise<{ id } | null>` — email es único global en `User`.

### A.2 Casos de uso (`application/use-cases`, TDD — `.spec` primero)

- **`CreateStaffUseCase`** — `{ fullName, email, role, password }`
  - Normaliza email (trim+lowercase); valida `password` ≥ 8, `fullName` ≥ 2, `role ∈ ClinicRole`.
  - Rechaza si el email ya existe en `User` (409, mismo patrón que register).
  - `passwordHash = PasswordService.hash(password)` (reutiliza `shared/crypto/password.service`).
  - Persiste `User` + `ClinicMembership` en **una transacción**, con
    `set_config('app.current_tenant', <tenantId>, true)` antes del insert de la membresía para
    pasar la RLS (idéntico a `PrismaAuthRepository.createClinicWithOwner`).
- **`UpdateStaffUseCase`** — `{ userId, fullName?, role? }`
  - 404 si el usuario no es miembro activo de la clínica.
  - **Invariante**: si el cambio degrada el rol del **último OWNER** activo → 409.
- **`DeactivateStaffUseCase`** — `{ userId, requestingUserId }`
  - 404 si no existe/ya inactivo.
  - **Invariantes**: no desactivar al **último OWNER** (409); no desactivarte **a ti mismo**
    (409) para evitar autobloqueo.

Los tres corren dentro del `TenantContextInterceptor` (RLS activa), como el resto del módulo.

### A.3 Presentación (`presentation/staff.controller.ts`)

- `POST /staff` — body `CreateStaffDto { fullName, email, role, password }` → 201 `StaffMemberDto`.
- `PATCH /staff/:userId` — body `UpdateStaffDto { fullName?, role? }` → 200 `StaffMemberDto`.
- `DELETE /staff/:userId` — 204 (desactiva; soft-delete). `requestingUserId` sale de `req.user.sub`.
- `GET /staff` — **sin cambios** (sigue con `PATIENT_ROLES`, alimenta el selector de agenda).
- **Permisos de escritura**: nuevo set `STAFF_WRITE_ROLES = [OWNER, ADMIN]` en
  `clinic-role-sets.ts`. Las tres rutas de escritura usan `@Roles(...STAFF_WRITE_ROLES)`.
- `StaffMemberDto` gana `email`.

### A.4 Infraestructura (`infrastructure/repositories/prisma-staff.repository.ts`)

Implementa los nuevos métodos con `runWithTenant`. `create` usa `$transaction` + `set_config`
como el repo de auth. `deactivateById` marca `deletedAt` en la membresía (no borra el `User`,
que es global y podría pertenecer a otras clínicas en el futuro). `countActiveOwners` cuenta
membresías activas con `role = OWNER`.

### A.5 Web

- Cliente `src/lib/staff/staff-api.ts`: `createStaff`, `updateStaff`, `deactivateStaff` (+ se
  reutiliza el `StaffMember`/`listStaff` ya existente en `src/lib/appointments/staff-api.ts`;
  se le agrega `email` al tipo).
- Página **`/staff`** (grupo `(app)`), componente cliente `StaffView`:
  - Tabla: nombre, email, rol, acciones (editar rol / desactivar con confirmación).
  - Alta **inline** (sección revelada, sin modal — convención existente de la app).
  - Estados loading/error/empty y `role="alert"` como en `AgendaView`.
- Ítem de menú **"Personal"** en `app-shell.tsx` (visible para OWNER/ADMIN).
- Copy en constantes `es` (i18n-ready), como el resto.

---

## Design — Parte B: Dashboard del doctor (dentalix-web, backend ya existe)

- Página **`/dashboard`** (grupo `(app)`), componente `DashboardView`. Acceso OWNER/ADMIN
  (el backend ya lo exige vía `DASHBOARD_ROLES`; para otros roles se oculta el ítem de menú y
  la página muestra un aviso de no-autorizado si se navega directo).
- Clientes API nuevos:
  - `src/lib/dashboard/dashboard-api.ts` → `getDashboard(token, { from, to, currency })`.
  - `src/lib/sales/sales-api.ts` → `getSalesTotals(token, { from, to, currency })` para las
    tres tarjetas de ingresos (día/semana/mes) sin recomputar el resto tres veces.
- Contenido:
  - **Tarjetas de ingresos** día / semana / mes (rangos calculados en cliente, hora local).
  - **Selector de moneda** con opciones **COP y USD** en v1 (COP por defecto). Cambiarla
    reconsulta los totales convertidos. (Si `exchange` no soporta la conversión, el endpoint
    devuelve 400 y se muestra el error; no se amplía el catálogo de monedas en esta ola.)
  - **Citas de hoy**: `listAppointments({ from, to })` del día (todas las agendas), resolviendo
    nombres de paciente (`listPatients`) y de profesional (`listStaff`) — patrón ya usado en
    `AgendaView`.
  - **# de pacientes** y **stock bajo** desde `getDashboard`.
- Ítem de menú **"Panel"** en `app-shell.tsx`.

Nota de contrato: `getDashboard` requiere `currency`, `from`, `to`. Para "# pacientes" y "stock
bajo" el rango es indiferente; se pasa el rango del mes. Las tarjetas de ingresos usan
`getSalesTotals` por rango.

---

## Design — Parte C: Vista semanal de la agenda (dentalix-web)

- `AgendaView` gana un interruptor **Día | Semana** (`viewMode` en estado).
- Helper `weekRange(dateStr)` en `src/lib/appointments/day-range.ts`: devuelve `{ from, to }`
  de lunes 00:00 a domingo 23:59:59 local que contiene la fecha.
- Modo semana: `listAppointments({ from, to, providerId })` del rango, render en
  `WeekAgenda` — grilla de 7 columnas (una por día) con las citas (hora, paciente, estado).
  Click en un día → cambia a modo Día con esa fecha (donde ya se edita el estado). Sin
  drag-and-drop ni edición de estado inline en la vista semanal (acota el alcance).
- Reutiliza `patientNames` y el estilo de `DayAgenda`.

---

## Testing

**API (Jest, unit + e2e):**
- `CreateStaffUseCase`: éxito (crea user+membership); email duplicado → 409; password corta →
  400; rol inválido → 400.
- `UpdateStaffUseCase`: cambia rol/nombre; usuario inexistente → 404; degradar último OWNER → 409.
- `DeactivateStaffUseCase`: desactiva; último OWNER → 409; auto-desactivación → 409; inexistente → 404.
- Repo: `create` respeta RLS (set_config); `deactivateById` soft-delete; `countActiveOwners`.
- e2e `staff`: OWNER crea DENTIST → aparece en `GET /staff` y puede loguear; ADMIN edita rol;
  rol sin permiso (DENTIST) recibe 403 al crear; no se puede desactivar el último OWNER.

**Web (Jest + Testing Library):**
- `StaffView`: renderiza la tabla desde `GET /staff`; alta llama `createStaff` con el payload
  correcto; desactivar pide confirmación y llama `deactivateStaff`; errores muestran `alert`.
- `DashboardView`: pinta tarjetas de ingresos desde `getSalesTotals`; cambiar moneda reconsulta;
  lista citas de hoy con nombres resueltos; muestra # pacientes y stock bajo.
- `AgendaView`/`WeekAgenda`: el interruptor cambia a semana y consulta el rango semanal; click
  en un día vuelve a Día con esa fecha. `weekRange` unit-test (lunes–domingo, borde de fin de mes).

## Rollout notes

- Migración de datos: ninguna (no cambia el esquema Prisma; `email` ya existe en `User`).
- `AGENTS.md`: leer `node_modules/next/dist/docs` antes de escribir código del Web.
- Seguir TDD: specs de use-case primero (API), tests de componente (Web).
- Orden sugerido de implementación: A (staff API) → A (staff Web) → C (semana) → B (dashboard),
  para que el dashboard ya pueda mostrar citas de varias agendas creadas con el nuevo personal.
