import type { Request } from 'express';

export function extractClientMeta(req: Request) {
  const headers = req.headers ?? {};
  const userAgent = (headers['user-agent'] ?? headers['User-Agent'] ?? '') as string;
  const chUa = (headers['sec-ch-ua'] ?? headers['Sec-CH-UA'] ?? '') as string;
  const chUaPlatform = (headers['sec-ch-ua-platform'] ?? headers['Sec-CH-UA-Platform'] ?? '') as string;
  const chUaMobile = (headers['sec-ch-ua-mobile'] ?? headers['Sec-CH-UA-Mobile'] ?? '') as string;
  const forwarded = (headers['x-forwarded-for'] ?? headers['X-Forwarded-For'] ?? '') as string | string[];
  const ipCandidate = Array.isArray(forwarded) ? forwarded[0] : forwarded || '';
  const ip = ipCandidate.split(',')[0].trim() || (req.ip ?? '');

  return { userAgent, chUa, chUaPlatform, chUaMobile, ip };
}
