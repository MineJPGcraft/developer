import OIDCProvider, {
    Configuration,
    ResponseType,
    ClientAuthMethod,
    Adapter,
    AdapterPayload,
} from 'oidc-provider';
import MemoryAdapter from 'oidc-provider/lib/adapters/memory_adapter.js';
import { findClient, findUser } from './db';
import { Logger } from '@yumerijs/core';
import { getJwks } from './jwks';
import { config } from './config';
import { createHash } from 'crypto';

const logger = new Logger('OIDCProvider');

let oidc: OIDCProvider;

class ClientAdapter implements Adapter {
    async upsert(): Promise<void> {
        // Dynamic client registration is not supported in this implementation.
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
        const client = await findClient(id);
        if (!client) {
            return undefined;
        }

        return {
            client_id: client.client_id,
            client_secret: client.client_secret,
            client_secret_expires_at: 0,
            client_name: client.client_name,
            redirect_uris: client.redirect_uris,
            grant_types: client.grant_types,
            response_types: client.response_types as ResponseType[],
            token_endpoint_auth_method: client.token_endpoint_auth_method as ClientAuthMethod,
        };
    }

    async findByUserCode(): Promise<AdapterPayload | undefined> {
        return undefined;
    }

    async findByUid(): Promise<AdapterPayload | undefined> {
        return undefined;
    }

    async consume(): Promise<void> {
        // Not applicable for clients.
    }

    async destroy(): Promise<void> {
        // Client removal is handled through the application, not the adapter.
    }

    async revokeByGrantId(): Promise<void> {
        // Not applicable for clients.
    }
}

async function initializeOidcProvider() {
    if (oidc) {
        return oidc;
    }

    const jwks = await getJwks();
    logger.info('JWKS generated/loaded.');

    const dpopNonceSecret = createHash('sha256')
        .update(config.devPortal.cookieSecret || 'dev-portal')
        .digest();

    const configuration: Configuration = {
        adapter: (name: string): Adapter => {
            if (name === 'Client') {
                return new ClientAdapter();
            }
            return new MemoryAdapter(name);
        },
        jwks, // Provide the generated JWKS
        responseTypes: ['code'],
        clientAuthMethods: ['client_secret_basic', 'client_secret_post'],
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        claims: {
            openid: ['sub'],
            profile: ['name', 'preferred_username', 'given_name', 'family_name', 'picture', 'updated_at'],
            email: ['email', 'email_verified'],
        },
        pkce: {
            required: () => false,
        },
        findAccount: async (ctx, id) => {
            logger.info(`findAccount for accountId: ${id}`);
            const user = await findUser(id);
            if (!user) {
                logger.warn(`User not found in our database: ${id}`);
                return undefined;
            }
            
            return {
                accountId: id,
                async claims() {
                    return JSON.parse(user.claims);
                },
            };
        },
        features: {
            devInteractions: { enabled: false },
            revocation: { enabled: true },
            introspection: { enabled: true },
            pushedAuthorizationRequests: {
                enabled: true,
                requirePushedAuthorizationRequests: false,
            },
            dPoP: {
                enabled: true,
                nonceSecret: dpopNonceSecret,
            },
        },
        interactions: {
            url(ctx, interaction) {
                return `/interaction/${interaction.uid}`;
            },
        },
        routes: {
            authorization: '/auth',
            token: '/token',
            userinfo: '/me',
            jwks: '/jwks',
            pushed_authorization_request: '/par',
            revocation: '/token/revocation',
            introspection: '/token/introspection',
        },
    };

    const ISSUER = config.server.issuer;
    oidc = new OIDCProvider(ISSUER, configuration);
    oidc.proxy = true;
    logger.info('OIDC Provider configured.');
    return oidc;
}

// Export a function that ensures the provider is initialized before returning it.
export default async function getOidcProvider() {
    if (!oidc) {
        return await initializeOidcProvider();
    }
    return oidc;
}
