import type { Session } from 'yumeri';
import { Logger } from 'yumeri';
import * as jose from 'jose';
import fetch from 'node-fetch';
import { config } from '../config';
import { findUser } from '../db';

export interface DevAccountProfile {
    id: string;
    name: string;
    email?: string;
    username?: string;
    claims: Record<string, unknown>;
}

export interface DevAccountDetails {
    accountId: string;
    payload: jose.JWTPayload & Record<string, unknown>;
    user?: {
        id: string;
        claims: Record<string, unknown>;
    };
    profile: DevAccountProfile;
}

const logger = new Logger('DevAccount');

type DiscoveryCache = {
    jwksUri?: string;
    fetchedAt: number;
};

let discoveryCache: DiscoveryCache | null = null;
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

async function resolveDevPortalJwksUri(): Promise<string | undefined> {
    if (config.devPortalOidc.jwks_uri) {
        return config.devPortalOidc.jwks_uri;
    }
    const issuer = config.devPortalOidc.issuer;
    if (!issuer) {
        return undefined;
    }
    if (discoveryCache && (Date.now() - discoveryCache.fetchedAt) < DISCOVERY_TTL_MS) {
        return discoveryCache.jwksUri;
    }
    const discoveryUrl = new URL('/.well-known/openid-configuration', issuer).toString();
    const response = await fetch(discoveryUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch OIDC discovery document: ${response.status}`);
    }
    const json = await response.json() as { jwks_uri?: string };
    discoveryCache = { jwksUri: json.jwks_uri, fetchedAt: Date.now() };
    return json.jwks_uri;
}

async function verifyDevPortalToken(token: string) {
    const jwksUri = await resolveDevPortalJwksUri();
    if (!jwksUri) {
        throw new Error('devPortalOidc 未配置 jwks_uri 或 issuer，无法验证登录令牌。');
    }
    const jwkSet = jose.createRemoteJWKSet(new URL(jwksUri));
    const verifyOptions: jose.JWTVerifyOptions = {};
    if (config.devPortalOidc.issuer) {
        verifyOptions.issuer = config.devPortalOidc.issuer;
    }
    return await jose.jwtVerify(token, jwkSet, verifyOptions);
}

export async function requireDevAccount(session: Session): Promise<DevAccountDetails> {
    const token = session.cookie[config.devPortal.cookieName];
    if (!token) {
        throw new Error('缺少开发者登录会话');
    }

    let payload: jose.JWTPayload & Record<string, unknown>;
    const result = await verifyDevPortalToken(token);
    payload = result.payload as jose.JWTPayload & Record<string, unknown>;
    const accountId = payload.sub;
    if (typeof accountId !== 'string' || !accountId) {
        throw new Error('ID Token 缺少 sub 信息');
    }

    let userClaims: Record<string, unknown> | undefined;
    try {
        const user = await findUser(accountId);
        if (user?.claims) {
            userClaims = JSON.parse(user.claims);
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to load user claims for account ${accountId}: ${message}`);
    }

    const claims: Record<string, unknown> = userClaims || (payload as Record<string, unknown>);
    const pick = (key: string) => {
        const val = claims[key];
        return typeof val === 'string' ? val : undefined;
    };

    const profile: DevAccountProfile = {
        id: accountId,
        name: pick('name') || pick('preferred_username') || pick('email') || accountId,
        email: pick('email'),
        username: pick('preferred_username'),
        claims,
    };

    return {
        accountId,
        payload: payload as jose.JWTPayload & Record<string, unknown>,
        user: userClaims ? { id: accountId, claims: userClaims } : undefined,
        profile,
    };
}
