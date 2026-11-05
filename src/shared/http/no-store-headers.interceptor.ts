import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

/**
 * Rutas públicas (DX-099, SEC-064): el token va en la URL y la respuesta puede
 * llevar datos del paciente (o tokens de sesión). Ni cachés intermedias ni del
 * navegador (`Cache-Control: no-store` y `Pragma: no-cache` para los HTTP/1.0),
 * y sin Referer hacia terceros. Se fija ANTES del handler para que lo lleven
 * también las respuestas de error (404, 410, 400), que el filtro escribe sin
 * pasar por `@Header`.
 *
 * Toda ruta pública (sin JwtAuthGuard) debe llevarlo, salvo la raíz, la salud y
 * los ficheros; `src/public-no-store.spec.ts` lo exige recorriendo las rutas
 * reales de AppModule.
 */
@Injectable()
export class NoStoreHeadersInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = context
      .switchToHttp()
      .getResponse<{ setHeader(name: string, value: string): void }>();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return next.handle();
  }
}
