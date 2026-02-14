import { Context, Logger } from 'yumeri';
import type { Session } from 'yumeri';
import type OIDCProvider from 'oidc-provider';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import { URL, URLSearchParams } from 'url';
import { IncomingMessage, ServerResponse } from 'http';
import * as jose from 'jose';
import getOidcProvider from '../../oidc';
import { consentPage } from '../../views';
import {
    createClient,
    findClient,
    listClients,
    updateClient,
    deleteClient,
    upsertUser,
    listAllClients,
    updateClientAdmin,
    deleteClientAdmin,
} from '../../db';
import { config } from '../../config';
import { requireDevAccount } from '../../utils/dev-account';
import { requireAdmin } from '../../utils/admin';
import { getPublicJwks } from '../../jwks';

const logger = new Logger('OIDCRoutes');

function firstHeader(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) {
        return value[0]?.split(',')[0]?.trim();
    }
    return value ? value.split(',')[0].trim() : undefined;
}

function resolveExternalBase(session: Session): URL {
    const cached = (session as any).__externalBase;
    if (cached) {
        return new URL(cached);
    }

    const { req } = session.client;
    const issuerUrl = new URL(config.server.issuer);

    const protocol = (session.protocol
        || firstHeader(req.headers['x-forwarded-proto'])
        || issuerUrl.protocol.replace(':', '')
        || 'http').split(',')[0].trim();

    const host = firstHeader(req.headers['x-forwarded-host'])
        || req.headers.host
        || issuerUrl.host;

    const base = new URL(`${protocol}://${host}`);
    (session as any).__externalBase = base.toString();
    return base;
}

function getQueryParams(session: Session): URLSearchParams {
    const { req } = session.client;
    const base = resolveExternalBase(session);
    const currentUrl = new URL(req.url || '/', base);
    const params = currentUrl.searchParams;
    session.query = Object.fromEntries(params.entries());
    return params;
}

type ProviderCallback = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

async function forwardToProvider(session: Session, handler: ProviderCallback) {
    const { req, res } = session.client;
    session.responseHandled = true;

    await new Promise<void>((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
            res.off('finish', onFinish);
            res.off('close', onFinish);
            res.off('error', onError);
        };

        const onFinish = () => {
            if (!settled) {
                settled = true;
                cleanup();
                resolve();
            }
        };

        const onError = (err: Error) => {
            if (!settled) {
                settled = true;
                cleanup();
                session.responseHandled = false;
                reject(err);
            }
        };

        res.on('finish', onFinish);
        res.on('close', onFinish);
        res.on('error', onError);

        try {
            const maybePromise = handler(req, res);
            if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
                (maybePromise as Promise<unknown>).catch(onError);
            }
        } catch (err) {
            onError(err instanceof Error ? err : new Error(String(err)));
        }
    });
}

type ProviderWithCookie = OIDCProvider & { cookieName(name: string): string };

function ensureInteractionCookie(session: Session, oidc: OIDCProvider, uid: string, setResponseCookie = false) {
    const cookieName = (oidc as ProviderWithCookie).cookieName('interaction');
    const headers = session.client.req.headers || {};
    const existingCookie = headers.cookie || '';
    const cookies = existingCookie
        .split(';')
        .map(part => part.trim())
        .filter(part => part.length > 0);

    const filtered = cookies.filter(part => !part.startsWith(`${cookieName}=`));
    const hasExisting = filtered.length !== cookies.length;
    filtered.push(`${cookieName}=${uid}`);

    const updatedCookieHeader = filtered.join('; ');
    const headerChanged = updatedCookieHeader !== existingCookie;
    if (headerChanged) {
        headers.cookie = updatedCookieHeader;
        session.client.req.headers = headers;
    }

    if (setResponseCookie && (headerChanged || !hasExisting)) {
        session.newCookie[cookieName] = {
            value: uid,
            options: {
                httpOnly: true,
                path: '/',
                sameSite: 'Lax',
            },
        };
    }

    session.cookie[cookieName] = uid;
}

function renderTemplate(session: Session, relativePath: string, data: Record<string, unknown>) {
    const templatePath = path.resolve(process.cwd(), relativePath);
    if (!fs.existsSync(templatePath)) {
        throw new Error(`未找到模板文件: ${relativePath}`);
    }
    session.renderFile(templatePath, data);
}

function templateData() {
    return {
        ui: config.ui,
        cloudflareRootDomain: config.cloudflare?.rootDomain || '',
    };
}

function buildDevPortalMetadata(session: Session) {
    const base = resolveExternalBase(session);
    const issuer = base.origin;
    const withIssuer = (pathname: string) => new URL(pathname, issuer).toString();
    return {
        issuer,
        authorization_endpoint: withIssuer('/auth'),
        token_endpoint: withIssuer('/token'),
        userinfo_endpoint: withIssuer('/me'),
        jwks_uri: withIssuer('/.well-known/jwks.json'),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        subject_types_supported: ['public'],
        scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        id_token_signing_alg_values_supported: ['RS256'],
        claims_supported: ['sub', 'name', 'preferred_username', 'given_name', 'family_name', 'email', 'email_verified', 'picture', 'updated_at'],
        code_challenge_methods_supported: ['S256'],
        pushed_authorization_request_endpoint: withIssuer('/par'),
        require_pushed_authorization_requests: false,
        dpop_signing_alg_values_supported: ['ES256', 'EdDSA', 'PS256', 'RS256'],
        dev_portal: {
            siteTitle: config.ui.siteTitle,
            overview: config.ui.overview,
            navigation: config.ui.navigation,
            announcements: config.ui.announcements,
            endpoints: {
                overview: '/dashboard',
                oidc: '/dashboard/oidc',
                subdomains: '/dashboard/subdomains',
                profile: '/api/profile',
                announcements: '/api/announcements',
                subdomainApi: '/api/subdomains',
            },
        },
        updated_at: new Date().toISOString(),
    };
}

export function apply(ctx: Context) {
    const oidcPromise = getOidcProvider();
    const oidcCallbackPromise = oidcPromise.then(provider => provider.callback());

    const redirect = (session: Session, location: string) => {
        session.status = 302;
        session.head['Location'] = location;
    };

    // --- Developer Portal Routes ---
    ctx.route('/')
        .action(async (session) => {
            try {
                renderTemplate(session, 'static/home.ejs', templateData());
            } catch (err) {
                session.status = 500;
                session.body = '未找到首页模板资源。';
            }
        });

    ctx.route('/dashboard/login')
        .action(async (session) => {
            const oidc = await oidcPromise;
            const authUrl = new URL(`${oidc.issuer}/auth`);
            authUrl.searchParams.append('client_id', 'dev-portal');
            authUrl.searchParams.append('scope', 'openid profile email');
            authUrl.searchParams.append('redirect_uri', `${config.server.issuer}/dashboard/callback`);
            authUrl.searchParams.append('response_type', 'code');
            authUrl.searchParams.append('prompt', 'login consent');
            authUrl.searchParams.append('nonce', Date.now().toString(36));
            authUrl.searchParams.append('state', Date.now().toString(36));

            redirect(session, authUrl.toString());
        });

    ctx.route('/dev/login').action((session) => redirect(session, '/dashboard/login'));
    ctx.route('/dev').action((session) => redirect(session, '/dashboard'));

    ctx.route('/dashboard')
        .action(async (session) => {
            try {
                await requireDevAccount(session);
                renderTemplate(session, 'static/overview.ejs', templateData());
            } catch (err) {
                logger.warn('Overview dashboard unavailable:', err);
                redirect(session, '/');
            }
        });

    ctx.route('/dev/overview').action((session) => redirect(session, '/dashboard'));

    ctx.route('/dashboard/callback')
        .action(async (session) => {
            try {
                const params = getQueryParams(session);
                const code = params.get('code') || '';
                if (!code) {
                    throw new Error('Missing authorization code in developer callback.');
                }

                const oidc = await oidcPromise;
                const devPortalClient = await findClient('dev-portal');
                if (!devPortalClient) throw new Error('Built-in dev-portal client not found in database.');

                const authMethod = devPortalClient.token_endpoint_auth_method || 'client_secret_basic';
                const tokenHeaders: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
                const tokenBody = new URLSearchParams({
                    code,
                    redirect_uri: `${config.server.issuer}/dashboard/callback`,
                    grant_type: 'authorization_code',
                });

                if (authMethod === 'client_secret_basic') {
                    const authHeader = Buffer.from(`${devPortalClient.client_id}:${devPortalClient.client_secret}`, 'utf-8').toString('base64');
                    tokenHeaders['Authorization'] = `Basic ${authHeader}`;
                } else if (authMethod === 'client_secret_post') {
                    tokenBody.set('client_id', devPortalClient.client_id);
                    tokenBody.set('client_secret', devPortalClient.client_secret);
                } else {
                    throw new Error(`Unsupported token endpoint auth method: ${authMethod}`);
                }

                const tokenResponse = await fetch(`${oidc.issuer}/token`, {
                    method: 'POST',
                    headers: tokenHeaders,
                    body: tokenBody,
                });

                const tokens = await tokenResponse.json() as any;
                if (tokens.error) throw new Error(`Token exchange failed: ${tokens.error_description || tokens.error}`);

                session.newCookie[config.devPortal.cookieName] = { value: tokens.id_token, options: { httpOnly: true, path: '/' } };

                redirect(session, '/dashboard');
            } catch (err) {
                logger.error('Error in dev callback:', err);
                session.status = 500;
                session.body = 'An error occurred during developer login.';
            }
        });

    ctx.route('/dev/callback').action((session) => redirect(session, '/dashboard/callback'));

    ctx.route('/dashboard/oidc')
        .action(async (session) => {
            try {
                await requireDevAccount(session);
                renderTemplate(session, 'static/dashboard.ejs', templateData());
            } catch (err) {
                logger.warn('Dev dashboard access denied or file missing:', err);
                session.newCookie[config.devPortal.cookieName] = { value: '', options: { path: '/', expires: new Date(0) } };
                redirect(session, '/');
            }
        });

    ctx.route('/dev/dashboard').action((session) => redirect(session, '/dashboard/oidc'));

    ctx.route('/admin')
        .action(async (session) => {
            try {
                await requireAdmin(session);
                renderTemplate(session, 'static/admin.ejs', templateData());
            } catch (err) {
                logger.warn('Admin access denied:', err);
                redirect(session, '/');
            }
        });

    // --- API routes ---
    const apiUiRoute = ctx.route('/api/ui-config');
    apiUiRoute.action(async (session) => {
        try {
            await requireDevAccount(session);
            const domains = (config.cloudflareDomains && config.cloudflareDomains.length)
                ? config.cloudflareDomains.map(item => ({
                    rootDomain: item.rootDomain,
                    label: item.label || item.rootDomain,
                }))
                : (config.cloudflare ? [{
                    rootDomain: config.cloudflare.rootDomain,
                    label: config.cloudflare.rootDomain,
                }] : []);
            const defaultDomain = config.cloudflareDefaultDomain
                || config.cloudflare?.rootDomain
                || domains[0]?.rootDomain
                || '';
            session.setMime('json');
            session.body = JSON.stringify({
                success: true,
                cloudflareRootDomain: defaultDomain,
                cloudflareDomains: domains,
                defaultDomain,
            });
        } catch (error) {
            session.status = 401;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: (error as Error).message });
        }
    });

    const adminClientsRoute = ctx.route('/api/admin/clients').methods('GET', 'POST');
    adminClientsRoute.action(async (session) => {
        const method = session.client.req.method?.toUpperCase();
        try {
            await requireAdmin(session);
            if (method === 'GET') {
                const clients = await listAllClients();
                session.setMime('json');
                session.body = JSON.stringify({ success: true, data: clients });
                return;
            }
            if (method === 'POST') {
                const body = await session.parseRequestBody();
                const owner = String(body?.owner ?? '').trim();
                const clientName = String(body?.client_name ?? '').trim();
                const clientId = body?.client_id ? String(body.client_id).trim() : undefined;
                const redirectUrisInput = body?.redirect_uris;
                const redirectUris = Array.isArray(redirectUrisInput)
                    ? redirectUrisInput.map((uri: string) => String(uri || '').trim()).filter(Boolean)
                    : String(redirectUrisInput || '')
                        .split(/\r?\n|\s+/)
                        .map((uri: string) => uri.trim())
                        .filter(Boolean);
                if (!owner || !clientName || redirectUris.length === 0) {
                    throw new Error('owner、client_name、redirect_uris 为必填');
                }
                const created = await createClient({ client_name: clientName, redirect_uris: redirectUris }, owner, clientId);
                session.setMime('json');
                session.body = JSON.stringify({ success: true, data: created });
                return;
            }
            session.status = 405;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: 'Method Not Allowed' });
        } catch (error) {
            session.status = 400;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: (error as Error).message });
        }
    });

    const adminClientDetail = ctx.route('/api/admin/clients/:clientId').methods('PUT', 'DELETE');
    adminClientDetail.action(async (session, _params, clientId) => {
        const method = session.client.req.method?.toUpperCase();
        try {
            await requireAdmin(session);
            if (clientId === 'dev-portal') {
                throw new Error('内置客户端不可修改或删除');
            }
            if (method === 'PUT') {
                const body = await session.parseRequestBody();
                const clientName = String(body?.client_name ?? '').trim();
                const redirectUrisInput = body?.redirect_uris;
                const redirectUris = Array.isArray(redirectUrisInput)
                    ? redirectUrisInput.map((uri: string) => String(uri || '').trim()).filter(Boolean)
                    : String(redirectUrisInput || '')
                        .split(/\r?\n|\s+/)
                        .map((uri: string) => uri.trim())
                        .filter(Boolean);
                if (!clientName || redirectUris.length === 0) {
                    throw new Error('client_name、redirect_uris 为必填');
                }
                await updateClientAdmin(clientId, { client_name: clientName, redirect_uris: redirectUris });
                session.setMime('json');
                session.body = JSON.stringify({ success: true });
                return;
            }
            if (method === 'DELETE') {
                await deleteClientAdmin(clientId);
                session.setMime('json');
                session.body = JSON.stringify({ success: true });
                return;
            }
            session.status = 405;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: 'Method Not Allowed' });
        } catch (error) {
            session.status = 400;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: (error as Error).message });
        }
    });

    const apiProfileRoute = ctx.route('/api/profile');
    apiProfileRoute.action(async (session) => {
        try {
            const { accountId, profile } = await requireDevAccount(session);
            session.setMime('json');
            session.body = JSON.stringify({
                success: true,
                data: {
                    accountId,
                    name: profile.name,
                    email: profile.email ?? null,
                    username: profile.username ?? null,
                    claims: profile.claims,
                },
            });
        } catch (error) {
            session.status = 401;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: (error as Error).message });
        }
    });

    const apiAnnouncementsRoute = ctx.route('/api/announcements');
    apiAnnouncementsRoute.action(async (session) => {
        try {
            await requireDevAccount(session);
            session.setMime('json');
            session.body = JSON.stringify({
                success: true,
                data: config.ui.announcements,
            });
        } catch (error) {
            session.status = 401;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: (error as Error).message });
        }
    });

    const apiClientsRoute = ctx.route('/api/clients').methods('GET', 'POST');
    apiClientsRoute.action(async (session) => {
        const method = session.client.req.method?.toUpperCase();
        try {
            const { accountId } = await requireDevAccount(session);

            if (method === 'GET') {
                const clients = await listClients(accountId);
                session.setMime('json');
                session.body = JSON.stringify({
                    success: true,
                    data: clients.map(client => ({
                        clientId: client.client_id,
                        clientName: client.client_name,
                        redirectUris: client.redirect_uris,
                        isSystem: client.owner === 'system',
                    })),
                });
                return;
            }

            if (method === 'POST') {
                const body = await session.parseRequestBody();
                const clientName = String(body.client_name || '').trim();
                const redirectUrisInput = body.redirect_uris;
                const redirectUris = Array.isArray(redirectUrisInput)
                    ? redirectUrisInput.map((uri: string) => String(uri || '').trim()).filter(Boolean)
                    : String(redirectUrisInput || '')
                        .split(/\r?\n|\s+/)
                        .map((uri: string) => uri.trim())
                        .filter(Boolean);

                if (!clientName || redirectUris.length === 0) {
                    session.status = 400;
                    session.setMime('json');
                    session.body = JSON.stringify({ success: false, message: '客户端名称和回调地址均为必填。' });
                    return;
                }

                const newClient = await createClient({ client_name: clientName, redirect_uris: redirectUris }, accountId);
                session.setMime('json');
                session.body = JSON.stringify({
                    success: true,
                    data: {
                        clientId: newClient.client_id,
                        clientSecret: newClient.client_secret,
                        clientName: newClient.client_name,
                        redirectUris: newClient.redirect_uris,
                    },
                });
                return;
            }

            session.status = 405;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: 'Method Not Allowed' });
        } catch (error) {
            const status = method === 'GET' ? 401 : 400;
            session.status = status;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: (error as Error).message });
        }
    });

    const apiClientDetailRoute = ctx.route('/api/clients/:clientId').methods('PUT', 'DELETE');
    apiClientDetailRoute.action(async (session, _params, clientId) => {
        const method = session.client.req.method?.toUpperCase();
        try {
            if (clientId === 'dev-portal') {
                throw new Error('内置客户端不可修改或删除。');
            }
            const { accountId } = await requireDevAccount(session);

            if (method === 'PUT') {
                const body = await session.parseRequestBody();
                const clientName = String(body.client_name || '').trim();
                const redirectUrisInput = body.redirect_uris;
                const redirectUris = Array.isArray(redirectUrisInput)
                    ? redirectUrisInput.map((uri: string) => String(uri || '').trim()).filter(Boolean)
                    : String(redirectUrisInput || '')
                        .split(/\r?\n/)
                        .map((uri: string) => uri.trim())
                        .filter(Boolean);
                if (!clientName || redirectUris.length === 0) {
                    throw new Error('客户端名称和回调地址均为必填。');
                }
                await updateClient(clientId, accountId, { client_name: clientName, redirect_uris: redirectUris });
                session.setMime('json');
                session.body = JSON.stringify({ success: true });
                return;
            }

            if (method === 'DELETE') {
                await deleteClient(clientId, accountId);
                session.setMime('json');
                session.body = JSON.stringify({ success: true });
                return;
            }

            session.status = 405;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: 'Method Not Allowed' });
        } catch (error) {
            session.status = 400;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: (error as Error).message });
        }
    });

    // --- OIDC Interaction Routes ---
    ctx.route('/interaction/callback')
        .action(async (session) => {
            try {
                const query = getQueryParams(session);
                const code = query.get('code');
                const state = query.get('state');
                if (!code || !state) throw new Error('Missing code or state from upstream provider');

                const oidc = await oidcPromise;
                const { interaction_uid } = JSON.parse(Buffer.from(state, 'base64url').toString('utf-8'));
                ensureInteractionCookie(session, oidc, String(interaction_uid), true);

                const tokenResponse = await fetch(config.upstreamOidc.token_endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        code,
                        client_id: config.upstreamOidc.clientId,
                        client_secret: config.upstreamOidc.clientSecret,
                        redirect_uri: `${config.server.issuer}/interaction/callback`,
                        grant_type: 'authorization_code',
                    }),
                });

                const tokens = await tokenResponse.json() as any;
                if (tokens.error) throw new Error(`Upstream token error: ${tokens.error_description}`);

                const claims = jose.decodeJwt(tokens.id_token);
                if (!claims.sub) throw new Error('Upstream token is missing "sub" claim.');

                await upsertUser(claims.sub, claims);

                const result = { login: { accountId: claims.sub } };
                await oidc.interactionFinished(session.client.req, session.client.res, result, { mergeWithLastSubmission: false });
                session.responseHandled = true;

            } catch (err) {
                logger.error('Error in upstream callback:', err);
                session.status = 500;
                session.body = 'An error occurred during upstream authentication.';
            }
        });

    ctx.route('/interaction/:uid')
        .action(async (session, _params, uid) => {
            try {
                const oidc = await oidcPromise;
                const details = await oidc.interactionDetails(session.client.req, session.client.res);
                const { prompt, params } = details;

                if (prompt.name === 'login') {
                    const statePayload = { downstream_client_id: params.client_id, interaction_uid: uid };
                    const state = Buffer.from(JSON.stringify(statePayload)).toString('base64url');

                    const redirectUrl = new URL(config.upstreamOidc.authorization_endpoint);
                    redirectUrl.searchParams.append('client_id', config.upstreamOidc.clientId);
                    redirectUrl.searchParams.append('response_type', 'code');
                    redirectUrl.searchParams.append('scope', 'openid email profile');
                    redirectUrl.searchParams.append('redirect_uri', `${config.server.issuer}/interaction/callback`);
                    redirectUrl.searchParams.append('state', state);

                    session.status = 302;
                    session.head['Location'] = redirectUrl.toString();

                } else if (prompt.name === 'consent') {
                    const clientId = String(params.client_id || '');
                    const client = await oidc.Client.find(clientId);
                    if (!client) { throw new Error('Client not found'); }

                    session.setMime('html');
                    session.body = consentPage(String(client.clientName || clientId), String(params.scope).split(' '), String(uid));
                }
            } catch (err) {
                logger.error('Error in interaction route:', err);
                session.body = 'An error occurred during interaction.';
                session.status = 500;
            }
        });

    ctx.route('/interaction/:uid/confirm').methods('POST')
        .action(async (session, _, uid) => {
            try {
                const oidc = await oidcPromise;
                const details = await oidc.interactionDetails(session.client.req, session.client.res);

                const { params, prompt, session: interactionSession } = details as any;
                let { grantId } = details as any;
                let grant: any;

                if (grantId) {
                    grant = await oidc.Grant.find(grantId);
                }

                if (!grant) {
                    grant = new oidc.Grant({
                        accountId: interactionSession?.accountId,
                        clientId: params.client_id,
                    });
                }

                const requestedScope = typeof params.scope === 'string' ? params.scope : '';
                if (requestedScope) {
                    grant.addOIDCScope(requestedScope);
                }

                const missingScope: string[] = prompt?.details?.missingOIDCScope || [];
                if (missingScope.length) {
                    grant.addOIDCScope(missingScope.join(' '));
                }

                const missingClaims: string[] = prompt?.details?.missingOIDCClaims || [];
                if (missingClaims.length) {
                    grant.addOIDCClaims(missingClaims);
                }

                const missingResourceScopes = prompt?.details?.missingResourceScopes || {};
                for (const resource in missingResourceScopes) {
                    const scopes = missingResourceScopes[resource];
                    grant.addResourceScope(resource, scopes.join(' '));
                }

                const savedGrantId = await grant.save();
                grantId = grantId || savedGrantId || grant.jti;

                const result = { consent: { grantId } };
                await oidc.interactionFinished(session.client.req, session.client.res, result, { mergeWithLastSubmission: true });
                session.responseHandled = true;
                return;
            } catch (err) {
                logger.error('Error confirming consent:', err);
                session.status = 500;
                session.body = 'Failed to confirm consent.';
            }
        });

    ctx.route('/interaction/:uid/abort').methods('POST')
        .action(async (session, _, uid) => {
            try {
                const oidc = await oidcPromise;
                const result = { error: 'access_denied', error_description: 'End-User aborted interaction' };
                await oidc.interactionFinished(session.client.req, session.client.res, result, { mergeWithLastSubmission: false });
                session.responseHandled = true;
            } catch (err) {
                logger.error('Error aborting consent:', err);
                session.status = 500;
                session.body = 'Failed to abort consent.';
            }
        });

    // --- OIDC Catch-all Route ---
    ctx.route('root')
        .action(async (session) => {
            try {
                const oidcCallback = await oidcCallbackPromise;
                await forwardToProvider(session, oidcCallback);
            } catch (error) {
                logger.error('OIDC provider error:', error);
                session.status = 500;
                session.body = 'OIDC provider encountered an unexpected error.';
            }
        });

    ctx.route('/.well-known/openid-configuration')
        .action(async (session) => {
            try {
                const base = resolveExternalBase(session);
                session.protocol = base.protocol.replace(':', '');
                session.client.req.headers = {
                    ...session.client.req.headers,
                    'x-forwarded-proto': base.protocol.replace(':', ''),
                    'x-forwarded-host': base.host,
                };

                const oidcCallback = await oidcCallbackPromise;
                await forwardToProvider(session, oidcCallback);

                if (session.body && typeof session.body === 'string') {
                    try {
                        const json = JSON.parse(session.body) as Record<string, unknown>;
                        const currentHost = base.host;
                        const toHttps = (value: unknown) => {
                            if (typeof value === 'string') {
                                const url = new URL(value);
                                if (url.host === currentHost && url.protocol === 'http:') {
                                    url.protocol = 'https:';
                                    return url.toString();
                                }
                            }
                            return value;
                        };

                        for (const key of Object.keys(json)) {
                            const value = json[key];
                            if (typeof value === 'string') {
                                json[key] = toHttps(value);
                            } else if (Array.isArray(value)) {
                                json[key] = value.map(item => toHttps(item));
                            }
                        }

                        session.body = JSON.stringify(json);
                    } catch (err) {
                        logger.warn('Failed to post-process discovery document:', err);
                    }
                }
            } catch (error) {
                logger.error('Failed to serve OIDC discovery document:', error);
                session.status = 500;
                session.setMime('json');
                session.body = JSON.stringify({ error: 'discovery_failed' });
            }
        });

    ctx.route('/.well-known/jwks.json')
        .action(async (session) => {
            try {
                const jwks = await getPublicJwks();
                session.setMime('json');
                session.body = JSON.stringify(jwks);
            } catch (error) {
                logger.error('Failed to serve JWKS document:', error);
                session.status = 500;
                session.setMime('json');
                session.body = JSON.stringify({ error: 'jwks_failed' });
            }
        });

    const devPortalWellKnownRoute = (session: Session) => {
        session.setMime('json');
        session.body = JSON.stringify(buildDevPortalMetadata(session));
    };

    ctx.route('/.well-known/dev-portal').action(devPortalWellKnownRoute);
    ctx.route('/.well-known/dev-portal.json').action(devPortalWellKnownRoute);

    const registerProviderEndpoint = (pathname: string, methods: string[]) => {
        const route = ctx.route(pathname).methods(...methods);
        route.action(async (session) => {
            try {
                const oidcCallback = await oidcCallbackPromise;
                await forwardToProvider(session, oidcCallback);
            } catch (error) {
                logger.error(`Provider endpoint error on ${pathname}:`, error);
                session.status = 500;
                session.setMime('json');
                session.body = JSON.stringify({ error: 'provider_unavailable' });
            }
        });
    };

    registerProviderEndpoint('/auth', ['GET', 'POST']);
    registerProviderEndpoint('/token', ['POST']);
    registerProviderEndpoint('/par', ['POST']);
    registerProviderEndpoint('/me', ['GET']);
    registerProviderEndpoint('/token/revocation', ['POST']);
    registerProviderEndpoint('/token/introspection', ['POST']);
}
