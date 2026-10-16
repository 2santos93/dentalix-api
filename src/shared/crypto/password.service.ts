import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Hash argon2id CONSTANTE de una contraseña aleatoria que nadie conoce (se
 * generó una vez y se descartó). Sirve solo para igualar tiempos (SEC-017):
 * cuando el login no encuentra usuario o membresía, verifica contra este hash
 * en vez de responder al instante, así el tiempo de respuesta no delata qué
 * emails existen. Tiene los MISMOS parámetros de coste (m/t/p) que `hash()`;
 * si estos cambian, hay que regenerarlo (lo vigila password.service.spec.ts).
 * No es un secreto: no protege nada, nunca valida ninguna contraseña real.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$eMFhdMNM//zU/ke5Ogjtvg$ZytgjH0a0p11pQH/ytTxhjtlad1BSjCnK4PtZAnZE84';

@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  async verify(plain: string, hash: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }
}
