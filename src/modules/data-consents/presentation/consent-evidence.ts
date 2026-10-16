import type { IncomingHttpHeaders } from 'node:http';
import type { ConsentEvidence } from '../domain/entities/data-consent.entity';

export interface EvidenceRequest {
  /** `req.ip` de Express: sale de X-Forwarded-For solo con TRUST_PROXY. */
  ip?: string;
  headers: IncomingHttpHeaders;
}

/** Evidencia técnica de la petición que registra una autorización. */
export function consentEvidenceFrom(req: EvidenceRequest): ConsentEvidence {
  const userAgent = req.headers['user-agent'];
  return {
    ...(req.ip ? { ipAddress: req.ip } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}
