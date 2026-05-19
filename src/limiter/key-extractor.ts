import type { FastifyRequest } from 'fastify';
import type { KeyExtractor } from '../types/index.js';

export function extractClientKey(req: FastifyRequest, extractor: KeyExtractor, headerName?: string): string {
  switch (extractor) {
    case 'ip':
      return req.ip ?? '0.0.0.0';

    case 'api_key_header': {
      const header = headerName ?? 'x-api-key';
      const value = req.headers[header.toLowerCase()];
      if (Array.isArray(value)) return value[0] ?? 'unknown';
      return value ?? 'unknown';
    }

    case 'jwt_sub': {
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Bearer ')) return 'unknown';
      try {
        const payload = auth.split('.')[1];
        if (!payload) return 'unknown';
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub?: string };
        return decoded.sub ?? 'unknown';
      } catch {
        return 'unknown';
      }
    }

    case 'composite':
      return `${req.ip ?? '0.0.0.0'}:${req.headers['x-api-key'] ?? ''}`;
  }
}
