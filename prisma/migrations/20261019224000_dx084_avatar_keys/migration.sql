-- DX-084: "users"."avatarUrl" guarda la CLAVE del fichero en el almacén
-- (`avatars/<userId>.<ext>`), no la URL absoluta. La API calcula la URL
-- pública al responder con la FILES_PUBLIC_BASE_URL vigente, así que cambiar
-- de dominio ya no rompe los avatares.
--
-- Convierte las URL absolutas de antes (`http(s)://…/avatars/<nombre>`) a su
-- clave. Lo que ya es una clave o no se reconoce queda igual (sin pérdida de
-- datos); la API reduce a clave cualquier URL de avatar que una réplica
-- antigua escriba durante un despliegue escalonado (avatar-url.util.ts).
--
-- "users" es una tabla global (sin RLS): el owner sin superusuario la ve
-- entera. Idempotente: una segunda pasada no encuentra URL que convertir.
UPDATE "users"
   SET "avatarUrl" = substring("avatarUrl" from '^https?://[^?#]*/(avatars/[A-Za-z0-9_-][A-Za-z0-9._-]*)$')
 WHERE "avatarUrl" ~ '^https?://[^?#]*/avatars/[A-Za-z0-9_-][A-Za-z0-9._-]*$'
   AND "avatarUrl" !~ '\.\.';
