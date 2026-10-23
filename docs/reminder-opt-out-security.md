# Baja de recordatorios (DX-214)
Los enlaces expiran por defecto 60d desde su emisión. REMINDER_OPT_OUT_LINK_TTL_DAYS configura nuevas emisiones; el backfill conserva createdAt+60d y el default SQL es now()+60d. Los tokens usados/expirados/invalidados/ajenos devuelven el mismo404 público.
Reactivar desde comunicaciones invalida todos los enlaces no usados en la misma transacción. Emisión, consumo y reactivación bloquean primero la fila paciente; un consumo vuelve a comprobar enlace bajo ese bloqueo. Un enlace emitido después funciona.
La cola DX-085 ejecuta reminders.purge-opt-out-links diariamente 04:23 UTC. Elimina solo cuando expiresAt O usedAt son estrictamente anteriores a now()-90d; conserva vencidos recientes. Lee clínicas activas y purga cada una bajo runWithTenant/FORCE RLS. Logs contienen event, tenantId y purged.
Más de REMINDER_OPT_OUT_MESSAGE_MAX_MATCHES=5 coincidencias E164: cero bajas y aviso reminders.opt_out_match_limit con tenantId, matches y limit, sin nombres/teléfonos.
## Condición previa DX-126
El webhook debe verificar la firma del proveedor antes de invocar OptOutByMessageUseCase y resolver tenantId desde el número receptor validado/configurado. Nunca aceptar clínica del cuerpo del webhook. El adaptador fake de tests no es un webhook de producción.
