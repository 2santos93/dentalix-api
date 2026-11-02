# Verificación en dos pasos del superadmin (DX-021-bis)

El apex de plataforma ya no abre sesión solo con contraseña: `POST /auth/login`
responde siempre el paso del segundo factor. Es la única puerta de alta; las
rutas `POST /platform/mfa/enrollment*` se retiraron.

## Alta segura de los superadmin que ya existen

La migración `20261115090100_dx021bis_platform_mfa`, al desplegar:

- sube la `tokenVersion` de todos los superadmin: sus sesiones de plataforma,
  abiertas solo con contraseña, se cierran;
- borra su secreto PENDIENTE: pudo pedirlo cualquiera con la contraseña.

No toca a nadie el MFA ya activo: esas cuentas entran con su código.

Quien no lo tenga activo:

1. Escribe su contraseña en el apex. Si es correcta, la API envía a su correo un
   código de 8 dígitos (vive entre 10 y 20 min, se deriva de la cuenta y no se
   guarda). Volver a escribir la contraseña en ese rato da el mismo código.
2. Escribe el código. Solo entonces ve el secreto. Quien tiene la contraseña
   pero no el correo no enrola su móvil; el dueño recibe el correo y sabe que su
   contraseña está comprometida. Los fallos cuentan en el contador del MFA.
3. Confirma con un código de la app, guarda sus 10 códigos de recuperación y entra.
4. El acceso de soporte a clínicas sigue cerrado durante
   `BREAK_GLASS_MFA_COOLDOWN_MINUTES` (24 h por defecto).

Lo mismo vale si el superadmin entra por primera vez por una clínica de la que
es miembro.

**Antes de desplegar, comprueba que el correo de plataforma sale** (`MAIL_*`):
el alta depende de él y no hay interruptor para saltarlo, a propósito. Con el
correo caído, quien ya tiene MFA entra con normalidad y el alta espera a que se
arregle. El tope `MAIL_PLATFORM_RECIPIENT_COOLDOWN_SECONDS` (600 s) no deja salir
un segundo correo enseguida: vale el código del primero.

Quien activó el MFA antes de esta versión no tiene códigos de recuperación:
`/admin` se lo avisa y los genera ahí (contraseña + código).

## Móvil y códigos perdidos

Nadie lo resetea desde la aplicación: un ADMIN de clínica no puede tocar una
cuenta de soporte. Es una intervención manual en la BD, con dos personas:

1. Verifica la identidad por un canal distinto del correo de la cuenta.
2. Con `DIRECT_URL`, en una transacción:

   ```sql
   DELETE FROM user_mfa_recovery_codes WHERE "userId" = '<id>';
   UPDATE users SET "mfaTotpSecretEnc" = NULL, "mfaTotpPendingSecretEnc" = NULL,
          "mfaEnabledAt" = NULL, "mfaLastUsedStep" = NULL,
          "tokenVersion" = "tokenVersion" + 1
    WHERE id = '<id>' AND "isPlatformAdmin" = true;
   ```

3. Deja constancia en el registro de incidentes (quién, por qué, cuándo). La
   persona repite el alta de arriba, con su espera del acceso de soporte.

## Avisos

- Usar un código de recuperación: correo al dueño.
- 5 códigos fallidos: espera creciente (máx. 15 min) y correo al dueño. Cambiar
  la contraseña corta el intento y borra la espera.
- `LOGIN`, `LOGIN_FAILED`, `MFA_ENROLLMENT_STARTED`, `MFA_ENABLED` y
  `MFA_RECOVERY_CODES_REGENERATED` quedan en `platform_audit_events`.
