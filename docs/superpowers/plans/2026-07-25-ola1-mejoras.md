# Ola 1 — Mejoras (según análisis de payments + dashboard + agenda)

Fecha: 2026-07-25 · Rama: `ola1-improve` (worktrees aislados)
Base API: 292e514 (incluye staff CRUD + payments). Base Web: 616cbfb (dashboard incomes + agenda inline-patient).

## Estado actual (qué hay)
- **Backend:** staff CRUD (mío, A1–A7), módulo `payments` (record/list/balance/void + roles + e2e), dashboard incomes (`GET /dashboard`), inventario, treatment-plans con currency, odontograma, etc.
- **Web:** login, registro, pacientes, agenda (día, con creación de paciente inline), dashboard (incomes + próximas citas + stock + # pacientes).

## Qué falta / qué mejorar (del análisis)
### Backend hardening (payments/dashboard) — surgical
- IMP-1 `RecordPaymentDto.currency` sin validar → regex ISO (como `DashboardQueryDto`).
- IMP-2 `void` no atómico (TOCTOU double-void) → `updateMany({where:{id,deletedAt:null}})` + count→404.
- IMP-3 `GET /treatment-plans/:id/payments` da 200 [] para plan inexistente, `balance` da 404 → paridad (ListPayments valida plan).
- IMP-4 Dashboard: un pago con moneda inválida tumba TODO (`Promise.all`) + N+1 de conversión → `allSettled`/degradar incomes + memoizar tasas por fecha.
- IMP-5 Índice faltante `payments (tenantId, paidAt) WHERE deletedAt IS NULL` (migración).

### Frontend net-new (sin colisión)
- IMP-6 **UI de gestión de personal** `/staff` (cliente staff-api + StaffView + página + nav). Usa staff backend ya existente.
- IMP-7 **Vista semana/mes** en agenda: `weekRange`/`monthRange` + toggle Día|Semana|Mes + render group-by-day.
- IMP-8 **Error boundary** global (`app/(app)/error.tsx` o raíz) — hoy no hay ninguno.

### Frontend dashboard/agenda (toca archivos de la otra sesión — merge con cuidado)
- IMP-9 "Próximas citas" muestra UUID cortado → resolver nombre paciente+profesional (patrón de `AgendaView`).
- IMP-10 Selector de moneda texto libre → `<select>` desde `GET /exchange/rates` (mata crash `RangeError` + refetch por tecla).
- IMP-11 Guard de rango invertido (from>to) + enlaces en tarjetas (stock→inventario, citas→agenda, pacientes→pacientes).
- IMP-12 Test de creación de paciente inline (feature nueva sin test).
- IMP-13 Búsqueda de pacientes server-side (`listPatients({query})`) en appointment-form (hoy topado en 100 + client-side).

## Orden de ejecución (valor/riesgo)
Wave A (backend hardening, surgical): IMP-1, IMP-2, IMP-3, IMP-4, IMP-5.
Wave B (frontend net-new): IMP-6 (staff UI), IMP-7 (week view), IMP-8 (error boundary).
Wave C (dashboard/agenda, merge-aware): IMP-9, IMP-10, IMP-11, IMP-12, IMP-13.

TDD en todo. Cada tarea revisada antes de la siguiente. Los cambios que tocan archivos de la otra sesión se marcan para coordinación de merge.
