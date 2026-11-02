# Recuperar el acceso de un miembro sin móvil ni códigos (DX-021-bis)

Orden de preferencia:

1. **Sus códigos de recuperación.** Son la salida normal.
2. **Otro ADMIN de la clínica**: perfil del miembro → «Restablecer». Exige
   contraseña y código de ese ADMIN, audita y avisa por correo.
3. **Este procedimiento**, solo si no hay nadie más: la clínica tiene una sola
   ADMIN, o la cuenta da acceso a otra clínica (la aplicación rechaza el reseteo
   con 409 para que una clínica no toque una cuenta compartida).

No hay ruta en la API ni botón de soporte, a propósito: una puerta así sería la
más atacada del sistema. Exige acceso a la BD de producción, que solo tiene la
operación.

## Procedimiento

Dos personas de Dentalix: quien verifica y quien ejecuta. No las mismas.

1. **Abre un ticket** con quién pide, qué clínica y por qué. Nunca por el correo
   de la cuenta afectada ni por un chat que quien la robó pudiera tener.
2. **Verifica la identidad, los tres puntos:**
   - llamada al teléfono que consta en el contrato de la clínica, marcando tú
     (no al número que da quien pide);
   - documento de identidad que coincide con el titular o representante del
     contrato;
   - un dato que solo la clínica conoce: últimos pagos a Dentalix.

   Si la petición mete prisa o falla algo, no sigue. Una cuenta con acceso a
   varias clínicas se verifica con la titular de cada una.
3. **Ejecuta** con `DIRECT_URL`:

   ```bash
   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -v email='persona@clinica.example' \
     -f docs/runbooks/mfa-support-reset.sql
   ```

   Borra secreto y códigos, revoca dispositivos, cierra sesiones y deja
   `MFA_RESET_BY_SUPPORT` en la auditoría de cada clínica, en la misma transacción.
   Rechaza superadmins, cuentas sin MFA y cuentas sin clínica.
4. **Cierra**: anota en el ticket quién verificó, quién ejecutó y cuándo.
5. **Avisa** a la persona por el teléfono verificado: que pida «¿Olvidaste tu
   contraseña?» **antes** de entrar. Si la clínica exige la verificación, el
   siguiente login pasa por el alta forzada, y esa alta solo pide contraseña; una
   contraseña nueva evita que quien tuviera la vieja se adelante.

Superadmin: `platform-mfa.md`.
