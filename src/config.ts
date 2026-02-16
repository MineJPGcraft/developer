import fs from 'fs';
import path from 'path';

export interface NavigationItem {
    label: string;
    href: string;
}

export interface UIConfig {
    siteTitle: string;
    home: {
        heading: string;
        description: string;
        loginButton: string;
    };
    overview: {
        heading: string;
        description: string;
        quickLinks: Array<{
            badge: string;
            title: string;
            description: string;
            href: string;
        }>;
    };
    dashboard: {
        heading: string;
        description: string;
        createForm: {
            clientNameLabel: string;
            redirectUrisLabel: string;
            submitButton: string;
        };
    };
    consent: {
        heading: string;
        approveButton: string;
        denyButton: string;
    };
    sld: {
        heading: string;
        description: string;
    };
    announcements: Array<{
        id: string;
        title: string;
        summary: string;
        link?: string;
        publishedAt?: string;
    }>;
    navigation: NavigationItem[];
}

export interface DatabaseConfig {
    type: 'sqlite' | 'postgres';
    path?: string;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    database?: string;
    ssl?: boolean;
}

export interface CloudflareConfig {
    apiToken: string;
    zoneId: string;
    rootDomain: string;
    defaultRecordType?: string;
    proxied?: boolean;
}

export interface CloudflareDomainConfig extends CloudflareConfig {
    label?: string;
}

export interface AppConfig {
    server: {
        port: number;
        host: string;
        issuer: string;
        userIssuer: string;
        devIssuer: string;
        userHosts: string[];
        devHosts: string[];
    };
    admin: {
        ids: string[];
    };
    database: DatabaseConfig;
    upstreamOidc: {
        clientId: string;
        clientSecret: string;
        authorization_endpoint: string;
        token_endpoint: string;
    };
    devPortalOidc: {
        issuer?: string;
        clientId: string;
        clientSecret: string;
        authorization_endpoint: string;
        token_endpoint: string;
        jwks_uri?: string;
        userinfo_endpoint?: string;
        scope: string;
        token_endpoint_auth_method: 'client_secret_basic' | 'client_secret_post';
    };
    devPortal: {
        cookieSecret: string;
        cookieName: string;
    };
    ui: UIConfig;
    sld: {
        maxPerUser: number;
        reserved: string[];
        blocked: string[];
    };
    cloudflare?: CloudflareConfig;
    cloudflareDomains?: CloudflareDomainConfig[];
    cloudflareDefaultDomain?: string;
    certificates?: {
        storageDir: string;
        acmeServer: string;
        dnsProvider: 'cloudflare' | 'manual';
        propagationSeconds?: number;
        accountDir?: string;
    };
}

let cachedConfig: AppConfig | null = null;

function parseYaml(content: string): Record<string, any> {
    const lines = content.split(/\r?\n/);
    const root: Record<string, any> = {};

    type StackEntry = {
        indent: number;
        type: 'object' | 'array';
        value: Record<string, any> | any[];
    };

    const stack: StackEntry[] = [{ indent: 0, type: 'object', value: root }];

    const parseScalar = (value: string) => {
        let parsed: any = value;
        if ((parsed.startsWith('"') && parsed.endsWith('"')) || (parsed.startsWith("'") && parsed.endsWith("'"))) {
            parsed = parsed.slice(1, -1);
        }
        const lower = parsed.toLowerCase();
        if (lower === 'true') {
            return true;
        }
        if (lower === 'false') {
            return false;
        }
        if (parsed !== '' && !Number.isNaN(Number(parsed))) {
            return Number(parsed);
        }
        return parsed;
    };

    const findNextMeaningfulLine = (startIndex: number) => {
        for (let i = startIndex; i < lines.length; i++) {
            const candidate = lines[i];
            if (!candidate.trim() || candidate.trimStart().startsWith('#')) {
                continue;
            }
            const indent = candidate.match(/^\s*/)?.[0].length ?? 0;
            return { indent, trimmed: candidate.trim() };
        }
        return null;
    };

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.trim() || line.trimStart().startsWith('#')) {
            continue;
        }

        const indent = line.match(/^\s*/)?.[0].length ?? 0;
        if (indent % 2 !== 0) {
            throw new Error('Only even indentation is supported in config.yaml');
        }

        while (indent < stack[stack.length - 1].indent) {
            stack.pop();
        }

        if (indent > stack[stack.length - 1].indent && indent - stack[stack.length - 1].indent !== 2) {
            throw new Error('Indentation must increase by two spaces');
        }

        const currentEntry = stack[stack.length - 1];
        const current = currentEntry.value;
        const trimmed = line.trim();

        if (trimmed.startsWith('- ')) {
            if (currentEntry.type !== 'array') {
                throw new Error('Unexpected list item without array context in config.yaml');
            }
            const arr = current as any[];
            const afterDash = trimmed.slice(1).trim();

            if (!afterDash) {
                const obj: Record<string, any> = {};
                arr.push(obj);
                stack.push({ indent: indent + 2, type: 'object', value: obj });
                continue;
            }

            const parts = afterDash.split(':');
            if (parts.length === 1) {
                arr.push(parseScalar(parts[0].trim()));
                continue;
            }

            const itemKey = parts[0].trim();
            const valuePart = parts.slice(1).join(':').trim();
            const obj: Record<string, any> = {};
            arr.push(obj);

            if (valuePart) {
                obj[itemKey] = parseScalar(valuePart);
                stack.push({ indent: indent + 2, type: 'object', value: obj });
            } else {
                const nested: Record<string, any> = {};
                obj[itemKey] = nested;
                stack.push({ indent: indent + 2, type: 'object', value: nested });
            }
            continue;
        }

        if (currentEntry.type !== 'object') {
            throw new Error('Unexpected key-value pair inside array in config.yaml');
        }

        const [rawKey, ...rest] = trimmed.split(':');
        const key = rawKey.trim();
        const valuePart = rest.join(':').trim();

        if (!valuePart) {
            const next = findNextMeaningfulLine(index + 1);
            if (next && next.indent > indent && next.trimmed.startsWith('- ')) {
                const arr: any[] = [];
                (current as Record<string, any>)[key] = arr;
                stack.push({ indent: indent + 2, type: 'array', value: arr });
            } else {
                const nested: Record<string, any> = {};
                (current as Record<string, any>)[key] = nested;
                stack.push({ indent: indent + 2, type: 'object', value: nested });
            }
            continue;
        }

        (current as Record<string, any>)[key] = parseScalar(valuePart);
    }

    return root;
}

function loadConfig(): AppConfig {
    if (cachedConfig) {
        return cachedConfig;
    }

    const configPath = process.env.CONFIG_PATH || path.resolve(__dirname, '..', 'config.yaml');
    if (!fs.existsSync(configPath)) {
        throw new Error(`配置文件未找到: ${configPath}`);
    }

    const rawContent = fs.readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(rawContent);

    const server = parsed.server || {};
    const upstream = parsed.upstreamOidc || {};
    const devPortalOidc = parsed.devPortalOidc || {};
    const database = parsed.database || {};
    const devPortal = parsed.devPortal || {};
    const ui = parsed.ui || {};
    const admin = parsed.admin || {};
    const sld = parsed.sld || {};
    const certificates = parsed.certificates || {};
    const navigationRaw = (ui.navigation && typeof ui.navigation === 'object') ? ui.navigation : {};
    const announcementsRaw = Array.isArray(ui.announcements) ? ui.announcements : [];
    const cloudflare = parsed.cloudflare || {};
    const cloudflareDomainsRaw = Array.isArray(cloudflare.domains) ? cloudflare.domains : [];

    const defaultIssuer = String(server.issuer ?? `http://localhost:${server.port ?? 8080}`);
    const userIssuer = String(server.userIssuer ?? defaultIssuer);
    const devIssuer = String(server.devIssuer ?? defaultIssuer);
    const parseHosts = (value: unknown): string[] => {
        if (Array.isArray(value)) {
            return value.map(item => String(item).trim()).filter(Boolean);
        }
        if (typeof value === 'string' && value.trim()) {
            return [value.trim()];
        }
        return [];
    };
    const deriveHost = (issuer: string) => {
        try {
            return new URL(issuer).host;
        } catch {
            return '';
        }
    };
    const userHosts = parseHosts(server.userHosts);
    const devHosts = parseHosts(server.devHosts);

    const config: AppConfig = {
        server: {
            port: Number(server.port ?? 8080),
            host: String(server.host ?? '0.0.0.0'),
            issuer: defaultIssuer,
            userIssuer,
            devIssuer,
            userHosts: userHosts.length ? userHosts : [deriveHost(userIssuer)].filter(Boolean),
            devHosts: devHosts.length ? devHosts : [deriveHost(devIssuer)].filter(Boolean),
        },
        admin: {
            ids: Array.isArray(admin.ids)
                ? admin.ids.map((item: any) => String(item)).filter(item => item.length > 0)
                : [],
        },
        database: {
            type: (database.type ?? 'sqlite') === 'postgres' ? 'postgres' : 'sqlite',
            path: database.path ? String(database.path) : './clients.sqlite',
            host: database.host ? String(database.host) : undefined,
            port: database.port !== undefined ? Number(database.port) : undefined,
            username: database.username ? String(database.username) : undefined,
            password: database.password ? String(database.password) : undefined,
            database: database.database ? String(database.database) : undefined,
            ssl: database.ssl !== undefined ? Boolean(database.ssl) : undefined,
        },
        upstreamOidc: {
            clientId: process.env.UPSTREAM_OIDC_CLIENT_ID || String(upstream.clientId ?? ''),
            clientSecret: process.env.UPSTREAM_OIDC_CLIENT_SECRET || String(upstream.clientSecret ?? ''),
            authorization_endpoint: String(upstream.authorizationEndpoint ?? upstream.authorization_endpoint ?? ''),
            token_endpoint: String(upstream.tokenEndpoint ?? upstream.token_endpoint ?? ''),
        },
        devPortalOidc: (() => {
            const rawAuthorization = devPortalOidc.authorizationEndpoint ?? devPortalOidc.authorization_endpoint ?? '';
            const rawTokenEndpoint = devPortalOidc.tokenEndpoint ?? devPortalOidc.token_endpoint ?? '';
            return {
                issuer: devPortalOidc.issuer ? String(devPortalOidc.issuer) : undefined,
                clientId: process.env.DEV_PORTAL_OIDC_CLIENT_ID || String(devPortalOidc.clientId ?? ''),
                clientSecret: process.env.DEV_PORTAL_OIDC_CLIENT_SECRET || String(devPortalOidc.clientSecret ?? ''),
                authorization_endpoint: String(rawAuthorization),
                token_endpoint: String(rawTokenEndpoint),
                jwks_uri: devPortalOidc.jwksUri
                    ? String(devPortalOidc.jwksUri)
                    : (devPortalOidc.jwks_uri ? String(devPortalOidc.jwks_uri) : undefined),
                userinfo_endpoint: devPortalOidc.userinfoEndpoint
                    ? String(devPortalOidc.userinfoEndpoint)
                    : (devPortalOidc.userinfo_endpoint ? String(devPortalOidc.userinfo_endpoint) : undefined),
                scope: String(devPortalOidc.scope ?? 'openid profile email'),
                token_endpoint_auth_method: (devPortalOidc.tokenEndpointAuthMethod ?? devPortalOidc.token_endpoint_auth_method) === 'client_secret_post'
                    ? 'client_secret_post'
                    : 'client_secret_basic',
            };
        })(),
        devPortal: {
            cookieSecret: process.env.DEV_PORTAL_COOKIE_SECRET || String(devPortal.cookieSecret ?? ''),
            cookieName: String(devPortal.cookieName ?? 'dev_session'),
        },
        ui: {
            siteTitle: String(ui.siteTitle ?? 'OIDC 身份代理'),
            home: {
                heading: String(ui.home?.heading ?? '开发者门户'),
                description: String(ui.home?.description ?? '使用本门户创建客户端并连接到上游身份提供方。'),
                loginButton: String(ui.home?.loginButton ?? '进入开发者控制台'),
            },
            overview: {
                heading: String(ui.overview?.heading ?? '开发者总览'),
                description: String(ui.overview?.description ?? '查看公告、快速入口和最新动态。'),
                quickLinks: Array.isArray(ui.overview?.quickLinks)
                    ? ui.overview.quickLinks.map((item: any) => ({
                        badge: String(item?.badge ?? '入口'),
                        title: String(item?.title ?? ''),
                        description: String(item?.description ?? ''),
                        href: String(item?.href ?? '#'),
                    })).filter((item: any) => item.title && item.href)
                    : [
                        {
                            badge: 'OIDC',
                            title: '客户端管理',
                            description: '创建、编辑与管理你的 OIDC 客户端。',
                            href: '/dashboard/oidc',
                        },
                        {
                            badge: '域名',
                            title: '三级域名管理',
                            description: '申请并维护 {rootDomain} 下的三级域名解析。',
                            href: '/dashboard/subdomains',
                        },
                    ],
            },
            dashboard: {
                heading: String(ui.dashboard?.heading ?? '客户端管理'),
                description: String(ui.dashboard?.description ?? '在这里创建新的应用并管理回调地址。'),
                createForm: {
                    clientNameLabel: String(ui.dashboard?.createForm?.clientNameLabel ?? '客户端名称'),
                    redirectUrisLabel: String(ui.dashboard?.createForm?.redirectUrisLabel ?? '回调地址（每行一个）'),
                    submitButton: String(ui.dashboard?.createForm?.submitButton ?? '创建客户端'),
                },
            },
            consent: {
                heading: String(ui.consent?.heading ?? '授权请求'),
                approveButton: String(ui.consent?.approveButton ?? '同意'),
                denyButton: String(ui.consent?.denyButton ?? '拒绝'),
            },
            navigation: Object.entries(navigationRaw).map(([label, href]) => ({
                label: String(label),
                href: String(href),
            })),
            sld: {
                heading: String(ui.sld?.heading ?? '三级域名服务中心'),
                description: String(ui.sld?.description ?? '在二级域名下申请专属三级域名，为项目提供稳定入口。'),
            },
            announcements: announcementsRaw.map((item: any, index: number) => ({
                id: String(item?.id ?? `announcement-${index}`),
                title: String(item?.title ?? '系统公告'),
                summary: String(item?.summary ?? ''),
                link: item?.link ? String(item.link) : undefined,
                publishedAt: item?.publishedAt ? String(item.publishedAt) : undefined,
            })),
        },
        sld: {
            maxPerUser: Number.isFinite(Number(sld.maxPerUser)) && Number(sld.maxPerUser) > 0
                ? Number(sld.maxPerUser)
                : 5,
            reserved: Array.isArray(sld.reserved)
                ? sld.reserved.map((item: any) => String(item)).filter(item => item.length > 0)
                : [],
            blocked: Array.isArray(sld.blocked)
                ? sld.blocked.map((item: any) => String(item)).filter(item => item.length > 0)
                : [],
        },
        cloudflare: cloudflare.apiToken && cloudflare.zoneId && cloudflare.rootDomain ? {
            apiToken: String(cloudflare.apiToken),
            zoneId: String(cloudflare.zoneId),
            rootDomain: String(cloudflare.rootDomain),
            defaultRecordType: cloudflare.defaultRecordType ? String(cloudflare.defaultRecordType) : 'CNAME',
            proxied: cloudflare.proxied !== undefined ? Boolean(cloudflare.proxied) : false,
        } : undefined,
        cloudflareDomains: cloudflareDomainsRaw.length
            ? cloudflareDomainsRaw
                .filter((item: any) => item && item.apiToken && item.zoneId && item.rootDomain)
                .map((item: any) => ({
                    apiToken: String(item.apiToken),
                    zoneId: String(item.zoneId),
                    rootDomain: String(item.rootDomain),
                    label: item.label ? String(item.label) : undefined,
                    defaultRecordType: item.defaultRecordType ? String(item.defaultRecordType) : 'CNAME',
                    proxied: item.proxied !== undefined ? Boolean(item.proxied) : false,
                }))
            : undefined,
        cloudflareDefaultDomain: cloudflare.defaultDomain ? String(cloudflare.defaultDomain) : undefined,
        certificates: {
            storageDir: certificates.storageDir ? String(certificates.storageDir) : './certificates',
            acmeServer: certificates.acmeServer ? String(certificates.acmeServer) : 'https://dv.acme-v02.api.pki.goog/directory',
            dnsProvider: certificates.dnsProvider === 'manual' ? 'manual' : 'cloudflare',
            propagationSeconds: certificates.propagationSeconds !== undefined ? Number(certificates.propagationSeconds) : undefined,
            accountDir: certificates.accountDir ? String(certificates.accountDir) : './certaccounts',
        },
    };

    if (config.ui.navigation.length === 0) {
        config.ui.navigation = [
            { label: '总览', href: '/dashboard' },
            { label: 'OIDC 客户端', href: '/dashboard/oidc' },
            { label: '三级域名管理', href: '/dashboard/subdomains' },
            { label: '证书申请', href: '/dashboard/certificates' },
        ];
    }

    if (config.cloudflareDomains && config.cloudflareDomains.length) {
        const fallback = config.cloudflareDomains[0];
        const desired = config.cloudflareDefaultDomain
            ? config.cloudflareDomains.find(item => item.rootDomain === config.cloudflareDefaultDomain)
            : undefined;
        const selected = desired || fallback;
        config.cloudflare = {
            apiToken: selected.apiToken,
            zoneId: selected.zoneId,
            rootDomain: selected.rootDomain,
            defaultRecordType: selected.defaultRecordType,
            proxied: selected.proxied,
        };
    }

    cachedConfig = config;
    return config;
}

export const config = loadConfig();
