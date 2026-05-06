/**
 * MuckRock API client for Edge Functions (webhook + tier refresh).
 *
 * Ports the relevant paths from
 *   cojournalist/backend/app/services/muckrock_client.py
 *
 * Uses client-credentials token (falls back to raw client secret as Bearer for
 * server-to-server — matches the Python client's lenient behaviour).
 *
 * Token is cached in-memory for the Edge Function's lifetime.
 */

const BASE = Deno.env.get("MUCKROCK_BASE_URL") ??
  "https://accounts.muckrock.com";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export interface MuckrockEntitlement {
  name: string;
  slug?: string;
  resources?: { monthly_credits?: number } & Record<string, unknown>;
  update_on?: string;
}

export interface MuckrockOrg {
  uuid: string;
  name?: string;
  individual?: boolean;
  entitlements?: MuckrockEntitlement[];
  max_users?: number;
}

export interface MuckrockUserInfo {
  uuid: string;
  email?: string;
  preferred_username?: string;
  organizations?: MuckrockOrg[];
}

export class MuckrockClient {
  private clientId: string;
  private clientSecret: string;
  private tokenCache: CachedToken | null = null;

  constructor(clientId?: string, clientSecret?: string) {
    this.clientId = clientId ?? Deno.env.get("MUCKROCK_CLIENT_ID") ?? "";
    this.clientSecret = clientSecret ??
      Deno.env.get("MUCKROCK_CLIENT_SECRET") ?? "";
    if (!this.clientId || !this.clientSecret) {
      throw new Error(
        "MuckrockClient: MUCKROCK_CLIENT_ID / MUCKROCK_CLIENT_SECRET not set",
      );
    }
  }

  private async authHeaders(): Promise<Record<string, string>> {
    try {
      const token = await this.getToken();
      return { Authorization: `Bearer ${token}` };
    } catch {
      // Fallback: use raw client_secret as Bearer for server-to-server auth
      return { Authorization: `Bearer ${this.clientSecret}` };
    }
  }

  private async getToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60) {
      return this.tokenCache.accessToken;
    }
    const resp = await fetch(`${BASE}/openid/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: "read_user read_organization",
      }),
    });
    if (!resp.ok) {
      throw new Error(`MuckRock token exchange failed: ${resp.status}`);
    }
    const data = (await resp.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.tokenCache = {
      accessToken: data.access_token,
      expiresAt: now + data.expires_in,
    };
    return data.access_token;
  }

  /** Fetch userinfo (full record with organizations + entitlements) by UUID. */
  async fetchUserData(uuid: string): Promise<MuckrockUserInfo> {
    const headers = await this.authHeaders();
    const resp = await fetch(`${BASE}/api/users/${encodeURIComponent(uuid)}/`, {
      headers,
    });
    if (!resp.ok) {
      throw new Error(`fetch_user_data failed: ${resp.status}`);
    }
    return (await resp.json()) as MuckrockUserInfo;
  }

  /** Fetch organization by UUID (webhook processing). */
  async fetchOrgData(uuid: string): Promise<MuckrockOrg> {
    const headers = await this.authHeaders();
    const resp = await fetch(
      `${BASE}/api/organizations/${encodeURIComponent(uuid)}/`,
      { headers },
    );
    if (!resp.ok) {
      throw new Error(`fetch_org_data failed: ${resp.status}`);
    }
    return (await resp.json()) as MuckrockOrg;
  }
}
