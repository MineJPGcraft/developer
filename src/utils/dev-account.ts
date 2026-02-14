import type { Session } from 'yumeri';
import { Logger } from 'yumeri';
import * as jose from 'jose';
import { config } from '../config';
import { getPublicJwks } from '../jwks';
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

export async function requireDevAccount(session: Session): Promise<DevAccountDetails> {
    const token = session.cookie[config.devPortal.cookieName];
    if (!token) {
        throw new Error('缺少开发者登录会话');
    }

    const jwks = await getPublicJwks();
    const jwkSet = jose.createLocalJWKSet(jwks);
    const { payload } = await jose.jwtVerify(token, jwkSet, { issuer: config.server.issuer });
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
