# ADR 0002 · Retención legal de la historia clínica y supresión parcial (DX-039)

Estado: aceptado · 2026-10-16

## Contexto

La Res. 839/2017 obliga a conservar la historia clínica (HC) al menos 15 años
desde la última atención; en casos especiales el plazo se dobla o es
permanente (víctimas de violaciones de DD. HH./DIH). Un archivado por error, o
pedido en un reclamo de datos (Ley 1581), puede incumplirla. La HC ya es
inalterable en la BD (DX-038).

## Decisión

- **`patients.last_attention_at`** la mantiene la BD con triggers AFTER
  (`dx_bump_patient_last_attention`): al insertar una evolución
  (`clinical_entries.entryDate`) o al dejar una cita en `COMPLETED`
  (`appointments.start`). Usa «solo adelanta» (`< attended_at`), así que nunca
  retrocede. Va en la BD y no en los casos de uso para que ningún camino de
  escritura (ni un INSERT por SQL) se la salte. SECURITY INVOKER: el UPDATE
  corre bajo la RLS del rol de la app. Backfill en la migración con el máximo
  de evoluciones (también las archivadas: siguen siendo HC) y citas atendidas
  no borradas.
- **Cálculo puro** (`clinical-record-retention.ts`): día civil UTC de la última
  atención + 15 años (NONE) o 30 (DOUBLE); PERMANENT nunca se libera. Un 29 de
  febrero termina el 28 si el año final no es bisiesto. El último día cuenta.
  Tomar el día en UTC solo puede alargar un día la retención (lado seguro).
- **Archivar** = `DELETE /patients/:id` (borrado blando, `deletedAt`), solo
  ADMIN. Antes no existía ningún flujo de archivo de pacientes. La regla se
  evalúa dentro de la transacción con la fila del paciente bloqueada
  (`FOR UPDATE`), para que una evolución concurrente no se cuele. 409
  `CLINICAL_RECORD_RETENTION` con mensaje en español y `retentionUntil`.
- **Entradas clínicas**: no tienen endpoint de borrado ni de archivo y la BD
  rechaza su UPDATE/DELETE (DX-038); por eso la regla solo hace falta en el
  paciente. Si algún día se añade, debe llamar a `assertNotUnderRetention`.
- **Retención extendida** (`retention_extended`), solo ADMIN, con motivo
  obligatorio. El motivo es texto libre y `audit_events` solo admite códigos,
  así que va a `patient_retention_actions` (append-only, RLS forzada, fecha del
  servidor); `audit_events` guarda quién y cuándo con
  `metadata.reason = RETENTION_EXTENSION_CHANGED`.
- **Supresión parcial** (solo ADMIN, solo con la HC en retención; si no, 409
  `NOT_UNDER_RETENTION`: se archiva). Vacía lo que no forma parte de la HC:
  `phone`, `email`, `address`, `notes` (administrativas) y el contacto de
  emergencia (`emergencyContact*`); retira la autorización de MARKETING vigente
  con una fila nueva `granted=false` (historia de consentimientos
  append-only, DX-037). **Conserva** la identificación que la Res. 1995/1999
  exige en la HC: nombres, documento, nacimiento, sexo, país/ciudad, estado
  civil, ocupación, aseguradora, médico tratante y responsable/acudiente
  (`guardian*`). Marca `partially_suppressed_at`, deja el motivo en
  `patient_retention_actions` y el evento `PARTIAL_SUPPRESSION` en auditoría.
- **Historias que salen de retención**: `GET /patients/retention/expiring`
  (solo ADMIN), vencidas o que vencen en `withinDays` (≤ 365), página ≤ 50.
  Índice parcial `patients_tenant_last_attention_live_idx`. Solo informa: la
  purga real queda fuera de alcance.

## Consecuencias

- El borrado de pacientes con HC queda bloqueado durante el plazo legal; el
  ADMIN tiene una salida documentada (supresión parcial) para los reclamos de
  Ley 1581.
- Un cambio de estado de una cita que vuelve de `COMPLETED` a otro estado no
  retrocede la fecha: la atención ocurrió.
