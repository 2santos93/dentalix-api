import * as argon2 from 'argon2';
import {
  DUMMY_PASSWORD_HASH,
  PasswordService,
} from '../crypto/password.service';

/**
 * DX-209 (TST-024): argon2id con el coste MÍNIMO que admite el algoritmo
 * (RFC 9106: memoria ≥ 8·p KiB, una pasada, un hilo). Es argon2id de verdad
 * (mismo formato PHC, lo verifica `PasswordService`), pero cuesta ~0,5 ms en
 * vez de ~100 ms y casi nada de memoria: con la máquina cargada, el coste de
 * producción (64 MiB, t=3, p=4) en cada test de login o registro hacía saltar
 * el timeout de Jest. Los parámetros de producción los fija un único spec,
 * `shared/crypto/password.service.spec.ts`.
 */
export const TEST_ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 8,
  timeCost: 1,
  parallelism: 1,
} as const;

/**
 * El hash ficticio de SEC-017 rehecho con `TEST_ARGON2_OPTIONS`: también de
 * una contraseña aleatoria descartada, así que tampoco valida ninguna.
 */
export const TEST_DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=8,p=1,t=1$drI3fkH9j7kLujAvAMmpcA$yN7RSwEid1B7MnN+I/16Xe+5CkarvuZzsxQMnp1qgeE';

/**
 * `PasswordService` para los unit: hashea con `TEST_ARGON2_OPTIONS` y, al
 * verificar contra `DUMMY_PASSWORD_HASH` (coste de producción), lo hace contra
 * su gemelo barato. Quien espía `verify` sigue viendo el hash ficticio real.
 * Solo para `*.spec.ts`: ningún módulo de producción lo importa (lo comprueba
 * test-password-hasher.spec.ts).
 */
export class TestPasswordHasher extends PasswordService {
  override hash(plain: string): Promise<string> {
    return argon2.hash(plain, TEST_ARGON2_OPTIONS);
  }

  override verify(plain: string, hash: string): Promise<boolean> {
    return super.verify(
      plain,
      hash === DUMMY_PASSWORD_HASH ? TEST_DUMMY_PASSWORD_HASH : hash,
    );
  }
}
