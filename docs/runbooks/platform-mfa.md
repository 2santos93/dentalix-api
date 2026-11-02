# Verificación en dos pasos del superadmin (DX-021-bis)

El apex de plataforma ya no abre sesión solo con contraseña: `POST /auth/login`
responde siempre el paso del segundo factor. Es la única puerta de alta del
superadmin: `POST /platform/mfa/enrollment*` se retiró y `/me/mfa/enrollment*`
responde 403 a un superadmin.

## Alta segura de los superadmin que ya existen

La migración `20261115090100_dx021bis_platform_mfa`, al desplegar:

- sube la `tokenVersion` de todos los superadmin: sus sesiones de plataforma,
  abiertas solo con contraseña, se cierran;
- borra su secreto PENDIENTE: pudo pedirlo cualquiera con la contraseña.

No toca a nadie el MFA ya activo: esas cuentas entran con su código.

Para la seguridad, el orden del despliegue no importa, y no hay ningún paso manual
por ello:

- las sesiones de plataforma llevan el claim `mfa`. La API nueva rechaza cualquier
  token sin él, también los que abra una réplica antigua después de migrar;
- un trigger de la migración impide guardar el secreto pendiente de un superadmin
  fuera de la puerta nueva: las rutas de alta de las réplicas antiguas fallan.

Mientras queden réplicas antiguas, su apex sigue pidiendo solo contraseña, pero
esa sesión muere con ellas.

Para el acceso sí importa: el apex no admite versiones cruzadas en ningún sentido.
La web vieja contra la API nueva no conoce el paso del código, y la web nueva
contra la API vieja recibe la sesión directa y se queda en ese paso. Despliega la
API (migración incluida) y, justo después, la web: hasta que termine, ningún
superadmin entra al apex.

Quien no lo tenga activo:

1. Escribe su contraseña en el apex. Si es correcta, la API envía a su correo un
   código de 8 dígitos **de ese intento**, con una referencia que la pantalla
   muestra. Vive lo que su token (10 min), se deriva de él y no se guarda.
2. Escribe el código. Solo entonces ve el secreto. Quien tiene la contraseña
   pero no el correo no enrola su móvil; el dueño recibe el correo y sabe que su
   contraseña está comprometida. Cada código admite **10 intentos fallidos en total**,
   vengan de la IP que vengan; agotados, queda invalidado y hay que volver a
   entrar. Además hay un contador por cuenta y cliente (IP, /64 en IPv6): 5 fallos
   y espera creciente, como mucho 10 min. Los
   fallos quedan en `platform_audit_events` (`LOGIN_FAILED`,
   `INVALID_EMAIL_CODE`). Un atacante gasta su código, nunca el del titular: cada
   entrada tiene el suyo.
3. Confirma con un código de la app, guarda sus 10 códigos de recuperación y entra.
4. El acceso de soporte a clínicas sigue cerrado durante
   `BREAK_GLASS_MFA_COOLDOWN_MINUTES` (24 h por defecto).

Lo mismo vale si el superadmin entra por primera vez por una clínica de la que
es miembro.

**Antes de desplegar, comprueba que el correo de plataforma sale** (`MAIL_*`):
el alta depende de él y no hay interruptor para saltarlo, a propósito. Con el
correo caído, quien ya tiene MFA entra con normalidad y el alta espera a que se
arregle.

Este correo no pasa por el tope por destinatario de plataforma: si no, quien
conoce la contraseña lo agotaría. Su único tope es uno por minuto por cuenta y
cliente (IP, /64 en IPv6); dentro de ese minuto el login responde 429 con la
espera, no «enviado». No hay tope global a propósito: sería una forma de bloquear
al titular. El coste es que un atacante con la contraseña y muchas IP puede llenar
ese buzón: cada correo le dice al dueño que la contraseña está comprometida.

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
- Activar la verificación: correo al dueño.
- 5 códigos de la app fallidos: espera creciente (máx. 15 min) y un correo al
  dueño por serie. Cambiar la contraseña corta el intento y borra la espera.
- `LOGIN`, `LOGIN_FAILED`, `MFA_ENROLLMENT_STARTED`, `MFA_ENABLED` y
  `MFA_RECOVERY_CODES_REGENERATED` quedan en `platform_audit_events`.
