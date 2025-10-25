export interface CoreAuthClientOptions {
  baseUrl: string;
  apiKey?: string;
  defaultTenantId?: string;
  fetchImpl?: typeof fetch;
  defaultHeaders?: Record<string, string>;
  defaultClientId?: string;
  defaultClientSecret?: string;
}

export interface CreateSessionParams {
  tenantId?: string;
  visitorId?: string;
  subject?: string;
  clientMeta?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface CreateSessionResponse {
  sessionId: string;
  token: string;
  expiresIn: number;
  expiresAt: string;
  visitorId: string;
}

export interface UpdateSessionParams {
  sessionId: string;
  contactId?: string;
  cookies?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface UpdateSessionResponse {
  sessionId: string;
  updated: {
    contactId?: string | null;
    context?: Record<string, unknown> | null;
    updatedAt: string;
  };
}

export interface ClientCredentialsParams {
  clientId?: string;
  clientSecret?: string;
  scope?: string[];
  headers?: Record<string, string>;
}

export interface ClientCredentialsResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string[];
}

interface RequestOptions {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  skipDefaultAuth?: boolean;
}

export class CoreAuthClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly defaultTenantId?: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly defaultClientId?: string;
  private readonly defaultClientSecret?: string;

  constructor(options: CoreAuthClientOptions) {
    if (!options?.baseUrl) {
      throw new Error('baseUrl is required');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.defaultTenantId = options.defaultTenantId;
    this.fetchImpl = options.fetchImpl;
    this.defaultHeaders = options.defaultHeaders ? { ...options.defaultHeaders } : {};
    this.defaultClientId = options.defaultClientId;
    this.defaultClientSecret = options.defaultClientSecret;
  }

  async createSession(params: CreateSessionParams): Promise<CreateSessionResponse> {
    const tenantId = params.tenantId ?? this.defaultTenantId;
    if (!tenantId) {
      throw new Error('tenantId is required when creating a session');
    }

    const url = `${this.baseUrl}/v1/tenants/${encodeURIComponent(tenantId)}/sessions`;
    const payload: Record<string, unknown> = {};
    if (params.visitorId) payload.visitorId = params.visitorId;
    if (params.subject) payload.subject = params.subject;
    if (params.clientMeta) payload.clientMeta = params.clientMeta;

    const response = await this.request<CreateSessionResponse>(url, {
      method: 'POST',
      headers: params.headers,
      body: JSON.stringify(payload)
    });

    return response;
  }

  async updateSession(params: UpdateSessionParams): Promise<UpdateSessionResponse> {
    if (!params.sessionId) {
      throw new Error('sessionId is required when updating a session');
    }

    const url = `${this.baseUrl}/v1/sessions/${encodeURIComponent(params.sessionId)}`;
    const payload: Record<string, unknown> = { sessionId: params.sessionId };
    if (params.contactId) payload.contactId = params.contactId;
    if (params.cookies) payload.cookies = params.cookies;

    const response = await this.request<UpdateSessionResponse>(url, {
      method: 'PATCH',
      headers: params.headers,
      body: JSON.stringify(payload)
    });

    return response;
  }

  async requestClientCredentialsToken(params: ClientCredentialsParams = {}): Promise<ClientCredentialsResponse> {
    const clientId = params.clientId ?? this.defaultClientId;
    const clientSecret = params.clientSecret ?? this.defaultClientSecret;
    if (!clientId || !clientSecret) {
      throw new Error('clientId and clientSecret are required to request client credentials tokens');
    }

    const url = `${this.baseUrl}/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials'
    });
    if (params.scope?.length) {
      body.set('scope', params.scope.join(' '));
    }

    const headers: Record<string, string> = {
      ...params.headers,
      'Content-Type': 'application/x-www-form-urlencoded'
    };

    if (!headers.Authorization && !headers.authorization) {
      const bufferCtor = (globalThis as any)?.Buffer;
      if (bufferCtor?.from) {
        headers.Authorization = `Basic ${bufferCtor.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      } else {
        body.set('client_id', clientId);
        body.set('client_secret', clientSecret);
      }
    } else {
      body.set('client_id', clientId);
    }

    const response = await this.request<any>(url, {
      method: 'POST',
      headers,
      body: body.toString(),
      skipDefaultAuth: true
    });

    return {
      accessToken: response.access_token,
      tokenType: response.token_type,
      expiresIn: response.expires_in,
      scope: typeof response.scope === 'string' && response.scope.trim()
        ? response.scope.trim().split(/\s+/)
        : []
    };
  }

  private async request<T>(url: string, init: RequestOptions & { skipDefaultAuth?: boolean }): Promise<T> {
    const fetcher = await this.resolveFetch();
    const headers = this.buildHeaders(init.headers, init.skipDefaultAuth);
    const response = await fetcher(url, {
      method: init.method,
      body: init.body,
      headers
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message = data?.message ?? response.statusText;
      const error = new Error(message);
      (error as any).status = response.status;
      (error as any).details = data;
      throw error;
    }
    return data as T;
  }

  private buildHeaders(headers?: Record<string, string>, skipDefaultAuth?: boolean) {
    const result: Record<string, string> = {
      ...this.defaultHeaders,
      ...(headers ?? {})
    };
    if (!result['Content-Type'] && !result['content-type']) {
      result['Content-Type'] = 'application/json';
    }
    if (!skipDefaultAuth && this.apiKey && !result.Authorization && !result.authorization) {
      result.Authorization = `Bearer ${this.apiKey}`;
    }
    return result;
  }

  private async resolveFetch(): Promise<typeof fetch> {
    if (this.fetchImpl) {
      return this.fetchImpl;
    }
    if (typeof fetch === 'function') {
      return fetch;
    }
    throw new Error('No fetch implementation available. Supply fetchImpl option or polyfill global fetch.');
  }
}

export default CoreAuthClient;
