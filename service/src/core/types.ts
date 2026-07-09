import type { Connection } from 'mongoose';

export interface LoggerLike {
  info?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
}

export interface SessionDocumentLike {
  contactId?: string | null;
  context?: Record<string, unknown> | null;
  updatedAt: Date;
  save(): Promise<void>;
}

export interface SessionModelLike {
  init?: () => Promise<unknown>;
  create: (...args: any[]) => Promise<any>;
  findById(id: string): { exec(): Promise<SessionDocumentLike | null> };
}

export interface AuthorizerModels {
  Session: SessionModelLike;
  [key: string]: unknown;
}

export interface ClientMeta {
  userAgent?: string;
  chUa?: string;
  chUaPlatform?: string;
  chUaMobile?: string;
  ip?: string;
  [key: string]: unknown;
}

export interface CreateSessionInput {
  visitorId?: string;
  clientMeta?: ClientMeta;
  subject?: string;
}

export interface CreateSessionResult {
  sessionId: string;
  visitorId: string;
  token: string;
  expiresIn: number;
  expiresAt: Date;
}

export interface SignSessionJwtArgs {
  sessionId: string;
  subject?: string;
  expiresInSec: number;
}

export type SignSessionJwtFn = (args: SignSessionJwtArgs) => Promise<{ token: string; exp: number }>;

export interface AuthorizerDependencies {
  getMasterConnection: () => Promise<Connection>;
  makeModels: (connection: Connection) => AuthorizerModels;
  signJwt: SignSessionJwtFn;
  sessionTtlMinutes: number;
  logger?: LoggerLike;
  uuid?: () => string;
  now?: () => Date;
}

export interface UpdateSessionInput {
  sessionId: string;
  contactId?: string;
  cookies?: Record<string, unknown> | null;
}

export interface UpdateSessionResult {
  sessionId: string;
  updated: {
    contactId?: string | null;
    context?: Record<string, unknown> | null;
    updatedAt: Date;
  };
}

export interface Authorizer {
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  updateSession(input: UpdateSessionInput): Promise<UpdateSessionResult>;
}
