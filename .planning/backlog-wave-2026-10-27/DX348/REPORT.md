# DX348 — HTTP e2e IPv4

Base: e4068c56955cefc107e33393c8df4ee8eeeaed98. Branch: loop/DX-348-http-ipv4-20261027.

## Diagnóstico y cambio

En macOS 27.0.1, Node v24.1.0 (engines >=22), reproducción real: `http.createServer().listen(0)` obtiene `::`, y otro servidor consigue escuchar `127.0.0.1` en el MISMO puerto (observado 51753). Supertest instalado llama `app.listen(0)` cuando `address()` es null y construye siempre una URL `127.0.0.1`. Esto demuestra la colisión posible; no prueba que todos los fallos anteriores procedieran de IPv6.

Los dos helpers (`test/support/create-e2e-app.ts` y `test/support/e2e-fixtures.ts`) conservan su configuración y `await app.init()`, y añaden `await app.listen(0, '127.0.0.1')`. Nest evita reinicializar cuando ya está initialized, espera listening y conserva su cierre normal. Supertest encuentra un servidor ya abierto y deja de arrancarlo/cerrarlo en cada petición. No hay cambios a runtime de producto.

El tercer helper `test/support/listening-app.ts` ya hacía listen IPv4 para su agente HTTP acotado. Sus consumidores login-lockout y patient-imports-load reciben ahora una app escuchando: se reutiliza el listener existente (`server.listening`) y se conserva el arranque IPv4 cuando no escucha. Una segunda regresión falló en ambas fábricas con «Listen method has been called more than once without closing» antes de esta compatibilidad; después pasa y comprueba HTTP/puerto estable/cierre del agente y Nest.

Regresión `test/http-listener.e2e-spec.ts`: ambas fábricas reales, listener ya abierto con IPv4, competidor real rechazado con EADDRINUSE, dos peticiones HTTP health correctas al mismo listener y cierre Nest que libera listener. Antes del cambio: dos fallos esperados `server.listening === false`; después: 2/2 pasan. No se sustituyen Nest, HTTP o Supertest por mocks.

## Cobertura y límites

Alcance inicial: análisis AST de imports createE2eApp (sin contar otras fixtures): 58 specs usan helper configureApp, 27 helper fixtures, dos usan ambos (break-glass y regresión); unión 83. Los otros 42 crean Nest directamente. Tras fallos aislados de apps directas en ejecuciones conservadas (401 prescriptions, 404 health de rate-limit), root autorizó cerrar la misma frontera de routing en las 42 fábricas directas, sin atribuir retrospectivamente cada error a IPv6. Todas tenían exactamente un init y cierre existente. Se añade únicamente `await app.listen(0, '127.0.0.1')` inmediatamente después de init (42 líneas); configuración, expectativas y negocio intactos. La factory de rate-limit sigue siendo local y conserva sus overrides. AST antes/después en direct-lifecycle-{before,after}.json verifica 42/42 init+listen+close. Cobertura final: 125/125 specs e2e sobre IPv4 explícito (83 por fábricas compartidas, 42 directos).

Revisión de todos los calls listen: `patient-imports-limits` tenía un listen adicional ahora duplicado; eliminado para reutilizar el de la fábrica. Detectado por revisión root y reproducido en full intermedio; antesAll fallaba antes de inicializar plazas y generaba además errores de teardown. El helper listening-app conserva su agente acotado y cierre; no cambia el solape de concurrencia.

Los helpers también son usados por tests int y se benefician del binding; la suite int no se ejecutó (no es criterio de esta tarea).

## Infraestructura exclusiva

PostgreSQL16 `dx348-pg-20261027`, 127.0.0.1:55520; comprobado puerto libre antes de crear. DB dentalix_test, owner dentalix para migración/seed, app dentalix_app NOSUPERUSER/NOBYPASSRLS, 121 relaciones con RLS después de migrar. MinIO exclusivo `dx348-minio-20261027`, 127.0.0.1:59012, bucket dx348-test; REQUIRE_S3_TESTS=1. No cambios a 55521, Claude G1, demos, ni MinIO compartido. `.env.test` local ignorado, no se publica. Ningún push ni llamada ClickUp.

## Verificación

- npm ci: exit 0 (log local /tmp/dx348-npm-ci.log; avisos de audit de dependencias existentes).
- npx prisma generate y npm run db:test:setup: exit 0.
- Regresión RED: exit 1, 2 fallos esperados (/tmp/dx348-red.log).
- Regresión GREEN inicial: exit 0, 2/2 (/tmp/dx348-green.log).
- Compatibilidad agente RED: exit 1, 2 fallos esperados y 2 pasos (/tmp/dx348-agent-red.log).
- Diagnóstico con Node22.16.0 (.nvmrc): exit 0, 3 suites y 39 tests: regresión final 4/4, login-lockout y patient-consents (/tmp/dx348-diagnostic-22.log).
- npx tsc --noEmit: exit 0 (/tmp/dx348-types.log).
- npm test -- --runInBand: exit 0, 401 suites y 4805 tests (/tmp/dx348-unit.log).
- Primer lint: exit 1, únicamente prettier en nueva regresión; corregido con prettier, sin cambios semánticos (/tmp/dx348-lint.log).
- Lint inicial corregido: exit 0 (/tmp/dx348-lint-2.log). Tras segunda regresión apareció 1 warning no-unsafe-argument; se tipó INestApplication<App>. Tipos y lint finales: exit 0 y cero warnings (/tmp/dx348-types-final-2.log y /tmp/dx348-lint-final-2.log).
- Primer intento completo Node24: interrumpido mediante SIGINT tras fallar login-lockout por doble listen y patient-consents con socket hang up. Jest devolvió exit 0 SIN resumen: NO es una ejecución pasada. Conservado íntegro /tmp/dx348-e2e-full-1.log. El segundo fallo no se atribuye a IPv6: no reprodujo en diagnóstico Node22; el primero está reproducido y corregido por regresión.
- Segundo intento full Node22/RUN_SLOW1: INTERRUPTED/INVALID, sin resumen aunque SIGINT devolvió0. Conservado /tmp/dx348-e2e-final-22.log. Fallos visibles: prescriptions (401 en un safety-check esperado200), rate-limit (health404 esperado200), patient-imports-limits (doble listen + plazas undefined en teardown). No se afirma causalidad retrospectiva individual del401/404. El riesgo compartido IPv6→IPv4 está reproducido independientemente; ampliación mecánica autorizada por root. No se rebajan expectativas ni se reintenta ciegamente: entre intentos se corrigieron fronteras identificadas.
- Full FINAL sobre fuentes congeladas: Node22.16.0, RUN_SLOW_TESTS=1, REQUIRE_S3_TESTS=1, npm run test:e2e (--runInBand). Wrapper con timeout1500s y validación obligatoria de resumen Jest: EXIT1 CON RESUMEN VÁLIDO. 124 suites pasan, 1 falla, 125 total; 3372 tests pasan, 1 falla, 3373 total; ningún salto; duración1000.42s (/tmp/dx348-e2e-frozen-22.log, .exit=1, .valid=True). Cero cambios a archivos fuente durante la ejecución, hashes verificados de nuevo al acabar (/tmp/dx348-frozen-sources.sha256).
- Único fallo final: `patient-imports-load`, caso20clínicas, RSS crecimiento975MB frente a300; base317MB/pico1292MB; 2 respuestas200 y18 respuestas503; duración32485ms; latencia víctima P50=2873/max3187ms. Caso1clínica pasa: crecimiento135MB (base276/pico412), 1respuesta200/19respuestas503, duración22102ms. No se reduce umbral, omite ni reintenta para obtener verde. Los otros124specs pasan, incluidas regresiones4/4,42directas y patient-imports-limits. RESULTADO GLOBAL ROJO por carga, no se declara completo el gate e2e.
- Diagnóstico lectura carga: agentmaxSockets22 y concurrencia intactos; antes ya tenía listenerIPv4 por listenOnEphemeralPort, ahora lo reutiliza. `global.gc?.()` en medición no es obligatorio; npm normal no expone gc. CI corre este spec en un paso separado (.github/workflows/ci.yml290-297), mientras la corrida exigida aquí lo incluyó con todos los demás. Esto no acredita causa de la subidaRSS.
- git diff --check: exit 0.

Freeze SHA: se proporciona en el reporte externo task-2-report.md tras el commit final para evitar autorreferencia del commit. Recursos: contenedores exclusivos conservados para revisión; no se destruyeron servicios ajenos.

## Comprobación final según composición de CI · root

La lectura de `.github/workflows/ci.yml` confirma que CI ejecuta la carga en un proceso separado. Root ejecutó una única comprobación aislada con el mismo comando, Node22.16.0, RUN_SLOW_TESTS=1 y REQUIRE_S3_TESTS=1, sin exponer GC ni modificar límites, parámetros, expectativas o producto: **1 suite / 2 tests PASS, exit0**, 9.92s. Caso una clínica: RSS +46MB,1×200/19×503, víctima máx57ms; caso veinte clínicas: RSS +65MB,2×200/18×503, víctima máx77ms. Ambos bajo los límites existentes.

Esta evidencia no transforma el barrido conjunto en verde: aquel conserva124/125suites y3372/3373tests, con falloRSS975MB. Tampoco prueba la causa exacta de esa subida. El conjunto de cobertura queda completo combinando los124specs aprobados y la carga aislada según el diseño de CI. No se registra fallo de puertos en el barrido final. El coste del proceso agregado queda explícito para no confundir una ejecución compuesta con una corrida ininterrumpida verde.

Root verificó todos los hashes de test capturados antes del barrido final después de la carga aislada; sin cambios de fuente. La revisión final debe valorar estos resultados y el alcance de tests; no hay cambios de código de producto.

Modern Web Guidance: no aplica a esta tarea exclusivamente de infraestructura backend.
