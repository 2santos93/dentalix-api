# ADR 0002 · Retención de la historia clínica y supresión parcial (DX-039)

Estado: aceptado · 2026-10-16

## Contexto

La historia clínica (HC) se conserva un plazo mínimo; por defecto, 15 años
desde la última atención (un valor prudente que iguala o supera el de muchas
normativas sanitarias); en casos especiales el plazo se dobla o es permanente
(ver la enmienda DX-330). Un archivado por error, o pedido en un reclamo
de datos del paciente, puede incumplirlo. La HC ya es
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
  no borradas, con `row_security = off` (si el dueño no salta la RLS falla en
  vez de rellenar 0 filas). La fecha tiene tope en el momento actual: `entryDate`
  y `start` los fija el cliente y una evolución inmutable fechada en el futuro
  alargaría la retención sin pasar por el ADMIN.
- **Cálculo puro** (`clinical-record-retention.ts`): día civil UTC de la última
  atención + 15 años (NONE) o 30 (DOUBLE); PERMANENT nunca se libera. Un 29 de
  febrero termina el 28 si el año final no es bisiesto. El último día cuenta.
  Tomar el día en UTC solo puede alargar un día la retención (lado seguro).
- **Archivar** = `DELETE /patients/:id` (borrado blando, `deletedAt`), solo
  ADMIN. Antes no existía ningún flujo de archivo de pacientes. La regla se
  evalúa dentro de la transacción con la fila del paciente bloqueada
  (`FOR UPDATE`), para que una evolución concurrente no se cuele. 409
  `CLINICAL_RECORD_RETENTION` con mensaje en español y `retentionUntil`.
  Tampoco se archiva con citas `SCHEDULED`/`CONFIRMED` vivas (409
  `PATIENT_HAS_PENDING_APPOINTMENTS`): seguirían en la agenda y en los
  recordatorios apuntando a una ficha 404.
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
  append-only, DX-037). **Conserva** la identificación que acompaña a la
  HC: nombres, documento, nacimiento, sexo, país/ciudad, estado
  civil, ocupación, aseguradora, médico tratante y responsable o tutor
  (`guardian*`). Marca `partially_suppressed_at`, deja el motivo en
  `patient_retention_actions` y el evento `PARTIAL_SUPPRESSION` en auditoría.
- **Historias que salen de retención**: `GET /patients/retention/expiring`
  (solo ADMIN), vencidas o que vencen en `withinDays` (≤ 365), página ≤ 50.
  Índice parcial `patients_tenant_last_attention_live_idx`. Solo informa: la
  purga real queda fuera de alcance.

## Consecuencias

- El borrado de pacientes con HC queda bloqueado durante el plazo de conservación; el
  ADMIN tiene una salida documentada (supresión parcial) para los reclamos de
  datos del paciente.
- Un cambio de estado de una cita que vuelve de `COMPLETED` a otro estado no
  retrocede la fecha: la atención ocurrió.

## Enmienda DX-330

El plazo de conservación ya no es una constante de la plataforma sino un
ajuste de cada clínica, y esta enmienda corrige lo que arriba quedó fijado:

- **Plazo de la clínica.** `tenants.clinicalRecordRetentionYears` (entre el
  mínimo de plataforma, 15 por defecto, y 100). Lo cambia solo el ADMIN con
  `PUT /patients/retention/settings`, auditado. `NONE` es ese plazo y `DOUBLE`
  el doble; los «15» y «30 años» de arriba son los valores por defecto, no una
  regla. `PERMANENT` no cambia.
- **Sin «legal».** Dentalix no afirma qué ley rige el plazo: lo pone la clínica
  y la clínica responde de que cumpla la norma de su país. Por eso los textos
  dicen «retención» y no «retención legal», y la causal de un país concreto
  para `PERMANENT` (que citaba este ADR en su contexto) sale de los textos.
- **Reducir no adelanta fechas.** Al reducir el plazo, cada historia que ya
  estaba en retención conserva su fecha de fin (`patients.retention_floor_until`,
  que nunca baja); el plazo nuevo se aplica al resto y a las atenciones
  nuevas. Una reducción pide confirmación expresa. Una subida corregida dentro
  de las 24 h siguientes no deja fechas fijadas.
- Archivar y la supresión parcial evalúan con el plazo vigente de la clínica,
  en la misma transacción que bloquea al paciente (`tenants` `FOR SHARE` y
  luego `patients` `FOR UPDATE`).
