import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

interface HeaderSink {
  setHeader(name: string, value: string): void;
}

/**
 * DX-101: cabeceras de TODA respuesta del portal del paciente (datos de
 * salud y financieros): sin caché, sin Referer y sin indexar. El guard las
 * fija también (corre antes que los interceptores).
 */
export function setPatientAccessHeaders(res: HeaderSink): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

@Injectable()
export class PatientAccessHeadersInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    setPatientAccessHeaders(context.switchToHttp().getResponse<HeaderSink>());
    return next.handle();
  }
}
