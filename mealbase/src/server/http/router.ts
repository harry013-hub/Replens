/**
 * Minimal HTTP routing on top of node:http. Kept dependency-free so the module
 * can be mounted inside another Node server (see createRequestHandler).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiErrorCode } from '../../shared/types/api';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface AuthContext {
  profileId: string;
  via: 'local' | 'session' | 'service';
  sessionTokenHash?: string;
}

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  cookies: Record<string, string>;
  auth: AuthContext | null;
  /** Set cookies on the response. */
  setCookie(cookie: string): void;
}

export interface HandlerResult {
  status?: number;
  body?: unknown;
  /** Raw (non-JSON) response, e.g. CSV download. */
  raw?: { contentType: string; data: string; filename?: string };
  headers?: Record<string, string>;
}

export type Handler = (ctx: RequestContext & { auth: AuthContext }) => HandlerResult | Promise<HandlerResult>;
export type PublicHandler = (ctx: RequestContext) => HandlerResult | Promise<HandlerResult>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler | PublicHandler;
  requiresAuth: boolean;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, opts?: { public?: false }): void;
  add(method: string, pattern: string, handler: PublicHandler, opts: { public: true }): void;
  add(method: string, pattern: string, handler: Handler | PublicHandler, opts: { public?: boolean } = {}): void {
    this.routes.push({ method, segments: split(pattern), handler, requiresAuth: !opts.public });
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | 'method-not-allowed' | null {
    const parts = split(path);
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    return pathMatched ? 'method-not-allowed' : null;
  }
}

function split(p: string): string[] {
  return p.split('/').filter(Boolean);
}

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i].startsWith(':')) {
      try {
        params[pattern[i].slice(1)] = decodeURIComponent(parts[i]);
      } catch {
        return null;
      }
    } else if (pattern[i] !== parts[i]) return null;
  }
  return params;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export async function readJsonBody(req: IncomingMessage, limitBytes = 2_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new HttpError(413, 'VALIDATION_ERROR', 'Request body is too large.');
    chunks.push(chunk as Buffer);
  }
  if (!size) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] ?? '';
  if (!type.includes('application/json')) {
    throw new HttpError(415, 'VALIDATION_ERROR', 'Send JSON with Content-Type: application/json.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Request body is not valid JSON.');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

export function sendError(res: ServerResponse, err: HttpError): void {
  sendJson(res, err.status, { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } }, err.headers);
}
