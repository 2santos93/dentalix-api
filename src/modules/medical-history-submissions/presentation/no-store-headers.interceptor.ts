import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

/**
 * Cuestionario de salud público (DX-099): el token va en la URL y la respuesta
 * lleva datos del paciente. Ni cachés intermedias ni del navegador, y sin
 * Referer hacia terceros. Se fija ANTES del handler para que lo lleven también
 * las respuestas de error (404, 410, 400), que el filtro escribe sin pasar por
 * `@Header`.
 */
@Injectable()
export class NoStoreHeadersInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = context
      .switchToHttp()
      .getResponse<{ setHeader(name: string, value: string): void }>();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return next.handle();
  }
}
