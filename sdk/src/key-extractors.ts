export type KeyExtractorType = 'ip' | 'api-key-header' | 'jwt-sub' | 'composite';

export interface RequestLike {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

export function extractKey(req: RequestLike, type: KeyExtractorType, headerName?: string): string {
  switch (type) {
    case 'ip':
      return req.ip ?? req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ?? '0.0.0.0';

    case 'api-key-header': {
      const h = headerName ?? 'x-api-key';
      const val = req.headers[h.toLowerCase()];
      return (Array.isArray(val) ? val[0] : val) ?? 'unknown';
    }

    case 'jwt-sub': {
      const auth = req.headers['authorization'];
      const token = (Array.isArray(auth) ? auth[0] : auth) ?? '';
      if (!token.startsWith('Bearer ')) return 'unknown';
      try {
        const payload = token.split('.')[1];
        if (!payload) return 'unknown';
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub?: string };
        return decoded.sub ?? 'unknown';
      } catch {
        return 'unknown';
      }
    }

    case 'composite': {
      const ip = req.ip ?? '0.0.0.0';
      const key = req.headers['x-api-key'];
      return `${ip}:${(Array.isArray(key) ? key[0] : key) ?? ''}`;
    }
  }
}
