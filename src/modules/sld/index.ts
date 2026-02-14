import { Context, Session, Logger, Config as ModuleConfig } from 'yumeri';
import path from 'path';
import fs from 'fs';
import { config as appConfig } from '../../config';
import { requireDevAccount } from '../../utils/dev-account';
import { requireAdmin } from '../../utils/admin';
import {
    listSubdomains,
    createSubdomainRecord,
    updateSubdomainRecord,
    deleteSubdomainRecord,
    findSubdomain,
    findSubdomainByName,
    countSubdomainsByOwner,
    listAllSubdomains,
    findSubdomainById,
    updateSubdomainRecordById,
    deleteSubdomainRecordById,
} from '../../db';
import { createDnsRecord, updateDnsRecord, deleteDnsRecord, listDnsRecordsByName, normalizeZoneSubdomain } from '../../cloudflare';

interface ModuleSettings {
    maxPerUser: number;
    reserved: Set<string>;
    blocked: Set<string>;
}

const logger = new Logger('sld');
const allowedRecordTypes = new Set(['A', 'AAAA', 'CNAME', 'SRV']);
const SUBDOMAIN_LOCK_MS = 30000;
const subdomainLocks = new Map<string, NodeJS.Timeout>();

function getSubdomainLockKey(subdomain: string, rootDomain: string) {
    return `${rootDomain}::${subdomain}`;
}

function acquireSubdomainLock(key: string): boolean {
    if (subdomainLocks.has(key)) {
        return false;
    }
    const timer = setTimeout(() => {
        subdomainLocks.delete(key);
    }, SUBDOMAIN_LOCK_MS);
    subdomainLocks.set(key, timer);
    return true;
}

function releaseSubdomainLock(key: string) {
    const timer = subdomainLocks.get(key);
    if (timer) {
        clearTimeout(timer);
        subdomainLocks.delete(key);
    }
}

function ensureStatic(session: Session, relativePath: string) {
    const absolute = path.resolve(process.cwd(), relativePath);
    if (!fs.existsSync(absolute)) {
        throw new Error(`模板文件未找到: ${relativePath}`);
    }
    session.renderFile(absolute, {
        ui: appConfig.ui,
        cloudflareRootDomain: appConfig.cloudflare?.rootDomain || '',
    });
}

function normalizeSubdomain(input: string, rootDomain?: string): string {
    let value = String(input || '').trim().toLowerCase();
    if (!value) return '';
    if (rootDomain) {
        const suffix = `.${rootDomain.toLowerCase()}`;
        if (value.endsWith(suffix)) {
            value = value.slice(0, -suffix.length);
        }
    }
    value = value.replace(/\.+$/, '');
    return value;
}

function validateSubdomain(value: string, settings: ModuleSettings): string | null {
    if (!value) {
        return '子域名不能为空';
    }
    if (value.length < 3 || value.length > 63) {
        return '子域名长度需介于 3 至 63 个字符之间';
    }
    if (!/^[a-z0-9-]+$/.test(value)) {
        return '子域名仅支持小写字母、数字和中划线';
    }
    if (value.startsWith('-') || value.endsWith('-')) {
        return '子域名不能以中划线开头或结尾';
    }
    if (settings.reserved.has(value)) {
        return '该子域名已被保留无法使用';
    }
    if (settings.blocked.has(value)) {
        return '该子域名不可用';
    }
    return null;
}

function withRootDomain(subdomain: string, rootDomain?: string) {
    if (!rootDomain) return subdomain;
    return `${subdomain}.${rootDomain}`;
}



export function apply(ctx: Context, moduleConfig: ModuleConfig) {
    const reservedRaw = moduleConfig.reserved || [];
    const availableDomains = appConfig.cloudflareDomains && appConfig.cloudflareDomains.length
        ? appConfig.cloudflareDomains.map(item => item.rootDomain)
        : (appConfig.cloudflare?.rootDomain ? [appConfig.cloudflare.rootDomain] : []);
    const defaultRootDomain = appConfig.cloudflareDefaultDomain
        || appConfig.cloudflare?.rootDomain
        || availableDomains[0]
        || '';
    const settings: ModuleSettings = {
        maxPerUser: moduleConfig.maxPerUser || 5,
        reserved: new Set(Array.isArray(reservedRaw) ? reservedRaw.map(item => String(item).toLowerCase()) : []),
        blocked: new Set(Array.isArray((moduleConfig as any).blocked) ? (moduleConfig as any).blocked.map((item: any) => String(item).toLowerCase()) : []),
    };

    ctx.route('/sld')
        .action((session) => {
            try {
                ensureStatic(session, 'static/sld/index.ejs');
            } catch (err) {
                logger.warn('SLD landing page unavailable: %s', err instanceof Error ? err.message : String(err));
                session.status = 404;
                session.body = '页面不存在';
            }
        });

    const guardDashboard = async (session: Session) => {
        try {
            await requireDevAccount(session);
            ensureStatic(session, 'static/subdomains.ejs');
        } catch (err) {
            logger.warn('访问二级域名控制台失败: %s', err instanceof Error ? err.message : String(err));
            session.status = 302;
            session.head['Location'] = '/';
        }
    };

    ctx.route('/dashboard/subdomains').action(guardDashboard);
    ctx.route('/dev/subdomains').action((session) => {
        session.status = 302;
        session.head['Location'] = '/dashboard/subdomains';
    });
    ctx.route('/sld/dashboard').action((session) => {
        session.status = 302;
        session.head['Location'] = '/dashboard/subdomains';
    });

    const apiRoute = ctx.route('/api/subdomains').methods('GET', 'POST');
    apiRoute.action(async (session) => {
        const method = session.client.req.method?.toUpperCase();
        try {
            const { accountId, profile } = await requireDevAccount(session);
            const rootDomain = defaultRootDomain; // Replaced from cf.rootDomain

            if (method === 'GET') {
                const records = await listSubdomains(accountId);
                session.setMime('json');
                session.body = JSON.stringify({
                    success: true,
                    data: records.map(record => ({
                        id: record.id,
                        subdomain: record.subdomain,
                        fullDomain: withRootDomain(record.subdomain, record.rootDomain || rootDomain),
                        target: record.content,
                        type: record.type,
                        rootDomain: record.rootDomain || rootDomain,
                        srvService: record.srvService ?? null,
                        srvProto: record.srvProto ?? null,
                        srvPort: record.srvPort ?? null,
                        srvPriority: record.srvPriority ?? null,
                        srvWeight: record.srvWeight ?? null,
                        proxied: record.proxied,
                        updatedAt: record.updatedAt,
                    })),
                    meta: {
                        user: profile,
                        limits: {
                            maxPerUser: settings.maxPerUser,
                            remaining: Math.max(settings.maxPerUser - records.length, 0),
                            reserved: Array.from(settings.reserved),
                        },
                    },
                });
                return;
            }

            if (method === 'POST') {
                const currentCount = await countSubdomainsByOwner(accountId);
                if (currentCount >= settings.maxPerUser) {
                    throw new Error(`最多只能创建 ${settings.maxPerUser} 个子域名`);
                }

                const body = await session.parseRequestBody();
                const subdomainInput = String(body?.subdomain ?? '').trim();
                const requestedRootDomain = String(body?.rootDomain ?? '').trim() || defaultRootDomain;
                const target = String(body?.target ?? '').trim();
                const type = String((body?.type ?? 'CNAME')).toUpperCase(); // Removed cf.defaultRecordType
                const srvService = String(body?.srvService ?? '').trim();
                const srvProto = String(body?.srvProto ?? '').trim();
                const srvPort = Number(body?.srvPort ?? 0);
                const srvPriority = Number(body?.srvPriority ?? 0);
                const srvWeight = Number(body?.srvWeight ?? 0);
                const proxied = type === 'SRV' ? false : Boolean(body.proxied); // SRV 不支持代理

                if (!requestedRootDomain || !availableDomains.includes(requestedRootDomain)) {
                    throw new Error('请选择有效的顶级域名');
                }

                const normalized = normalizeSubdomain(subdomainInput, requestedRootDomain);
                const validationError = validateSubdomain(normalized, settings);
                if (validationError) {
                    throw new Error(validationError);
                }
                if (!target) {
                    throw new Error('目标地址不能为空');
                }
                if (!allowedRecordTypes.has(type)) {
                    throw new Error('仅支持 A、AAAA、CNAME、SRV 类型的记录');
                }
                if (type === 'SRV') {
                    if (!srvService || !srvProto || !Number.isFinite(srvPort) || srvPort <= 0) {
                        throw new Error('SRV 记录需要服务名称、协议和端口号');
                    }
                }

                const lockKey = getSubdomainLockKey(normalized, requestedRootDomain);
                if (!acquireSubdomainLock(lockKey)) {
                    throw new Error('该子域名正在处理中，请稍后重试');
                }
                try {
                    const includeNullRoot = requestedRootDomain === defaultRootDomain;
                    const conflict = await findSubdomainByName(normalized, requestedRootDomain, includeNullRoot);
                    if (conflict) {
                        throw new Error('该子域名已被占用');
                    }

                    const dnsRecord = await createDnsRecord({
                        subdomain: normalized,
                        content: target,
                        type,
                        proxied,
                        rootDomain: requestedRootDomain,
                        srv: type === 'SRV'
                            ? {
                                service: srvService,
                                proto: srvProto,
                                port: srvPort,
                                priority: srvPriority,
                                weight: srvWeight,
                                target,
                            }
                            : undefined,
                    });

                    const stored = await createSubdomainRecord({
                        owner: accountId,
                        recordId: dnsRecord.id,
                        subdomain: normalized,
                        rootDomain: requestedRootDomain,
                        content: target,
                        type,
                        srvService: type === 'SRV' ? srvService : null,
                        srvProto: type === 'SRV' ? srvProto : null,
                        srvPort: type === 'SRV' ? srvPort : null,
                        srvPriority: type === 'SRV' ? srvPriority : null,
                        srvWeight: type === 'SRV' ? srvWeight : null,
                        proxied,
                    });

                    session.setMime('json');
                    session.body = JSON.stringify({
                        success: true,
                        data: {
                            id: stored.id,
                            subdomain: stored.subdomain,
                            fullDomain: withRootDomain(stored.subdomain, stored.rootDomain || requestedRootDomain),
                            target: stored.content,
                            type: stored.type,
                            rootDomain: stored.rootDomain || requestedRootDomain,
                            srvService: stored.srvService ?? null,
                            srvProto: stored.srvProto ?? null,
                            srvPort: stored.srvPort ?? null,
                            srvPriority: stored.srvPriority ?? null,
                            srvWeight: stored.srvWeight ?? null,
                            proxied: stored.proxied,
                        },
                    });
                    return;
                } finally {
                    releaseSubdomainLock(lockKey);
                }
            }

            session.status = 405;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: 'Method Not Allowed' });
        } catch (err) {
            session.status = 400;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: err instanceof Error ? err.message : String(err) });
        }
    });

    const adminSubdomainsRoute = ctx.route('/api/admin/subdomains').methods('GET', 'POST');
    adminSubdomainsRoute.action(async (session) => {
        const method = session.client.req.method?.toUpperCase();
        try {
            await requireAdmin(session);
            if (method === 'GET') {
                const records = await listAllSubdomains();
                session.setMime('json');
                session.body = JSON.stringify({ success: true, data: records });
                return;
            }
            if (method === 'POST') {
                const body = await session.parseRequestBody();
                const owner = String(body?.owner ?? '').trim();
                const rootDomain = String(body?.rootDomain ?? '').trim() || defaultRootDomain;
                const subdomain = String(body?.subdomain ?? '').trim();
                const target = String(body?.target ?? '').trim();
                const type = String((body?.type ?? 'CNAME')).toUpperCase();
                const srvService = String(body?.srvService ?? '').trim();
                const srvProto = String(body?.srvProto ?? '').trim();
                const srvPort = Number(body?.srvPort ?? 0);
                const srvPriority = Number(body?.srvPriority ?? 0);
                const srvWeight = Number(body?.srvWeight ?? 0);
                const proxied = type === 'SRV' ? false : Boolean(body?.proxied);

                if (!owner || !subdomain || !target) {
                    throw new Error('owner、subdomain、target 为必填');
                }
                if (!rootDomain || !availableDomains.includes(rootDomain)) {
                    throw new Error('请选择有效的顶级域名');
                }
                if (type === 'SRV' && (!srvService || !srvProto || !Number.isFinite(srvPort) || srvPort <= 0)) {
                    throw new Error('SRV 记录需要服务名称、协议和端口号');
                }

                const normalized = normalizeSubdomain(subdomain, rootDomain);
                const lockKey = getSubdomainLockKey(normalized, rootDomain);
                if (!acquireSubdomainLock(lockKey)) {
                    throw new Error('该子域名正在处理中，请稍后重试');
                }
                try {
                    const dnsRecord = await createDnsRecord({
                        subdomain: normalized,
                        content: target,
                        type,
                        proxied,
                        rootDomain,
                        srv: type === 'SRV'
                            ? {
                                service: srvService,
                                proto: srvProto,
                                port: srvPort,
                                priority: srvPriority,
                                weight: srvWeight,
                                target,
                            }
                            : undefined,
                    });

                    const stored = await createSubdomainRecord({
                        owner,
                        recordId: dnsRecord.id,
                        subdomain: normalized,
                        rootDomain,
                        content: target,
                        type,
                        srvService: type === 'SRV' ? srvService : null,
                        srvProto: type === 'SRV' ? srvProto : null,
                        srvPort: type === 'SRV' ? srvPort : null,
                        srvPriority: type === 'SRV' ? srvPriority : null,
                        srvWeight: type === 'SRV' ? srvWeight : null,
                        proxied,
                    });

                    session.setMime('json');
                    session.body = JSON.stringify({ success: true, data: stored });
                    return;
                } finally {
                    releaseSubdomainLock(lockKey);
                }
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

    const adminSubdomainDetail = ctx.route('/api/admin/subdomains/:id').methods('PUT', 'DELETE');
    adminSubdomainDetail.action(async (session, _params, id) => {
        const method = session.client.req.method?.toUpperCase();
        try {
            await requireAdmin(session);
            const existing = await findSubdomainById(id);
            if (!existing) {
                throw new Error('记录不存在');
            }
            const rootDomain = existing.rootDomain || defaultRootDomain;
            if (method === 'DELETE') {
                const reqUrl = session.client.req.url || '';
                const force = new URL(reqUrl, 'http://localhost').searchParams.get('force');
                if (force === '1' || force === 'true') {
                    await deleteSubdomainRecordById(id);
                } else {
                    await deleteDnsRecord(existing.recordId, rootDomain);
                    await deleteSubdomainRecordById(id);
                }
                session.setMime('json');
                session.body = JSON.stringify({ success: true });
                return;
            }
            if (method === 'PUT') {
                const body = await session.parseRequestBody();
                const subdomain = String(body?.subdomain ?? existing.subdomain).trim();
                const target = String(body?.target ?? '').trim();
                const type = String((body?.type ?? existing.type ?? 'CNAME')).toUpperCase();
                const srvService = String(body?.srvService ?? existing.srvService ?? '').trim();
                const srvProto = String(body?.srvProto ?? existing.srvProto ?? '').trim();
                const srvPort = Number(body?.srvPort ?? existing.srvPort ?? 0);
                const srvPriority = Number(body?.srvPriority ?? existing.srvPriority ?? 0);
                const srvWeight = Number(body?.srvWeight ?? existing.srvWeight ?? 0);
                const proxied = type === 'SRV' ? false : (body?.proxied !== undefined ? Boolean(body.proxied) : existing.proxied);

                if (!subdomain || !target) {
                    throw new Error('subdomain、target 为必填');
                }
                if (type === 'SRV' && (!srvService || !srvProto || !Number.isFinite(srvPort) || srvPort <= 0)) {
                    throw new Error('SRV 记录需要服务名称、协议和端口号');
                }

                let updateLockKey: string | null = null;
                const normalized = normalizeSubdomain(subdomain, rootDomain);
                if (normalized !== existing.subdomain) {
                    updateLockKey = getSubdomainLockKey(normalized, rootDomain);
                    if (!acquireSubdomainLock(updateLockKey)) {
                        throw new Error('该子域名正在处理中，请稍后重试');
                    }
                }

                try {
                    await updateDnsRecord(existing.recordId, {
                        subdomain: normalized,
                        content: target,
                        type,
                        proxied,
                        rootDomain,
                        srv: type === 'SRV'
                            ? {
                                service: srvService,
                                proto: srvProto,
                                port: srvPort,
                                priority: srvPriority,
                                weight: srvWeight,
                                target,
                            }
                            : undefined,
                    });

                    await updateSubdomainRecordById(id, {
                        subdomain: normalized,
                        rootDomain,
                        content: target,
                        type,
                        proxied,
                        srvService: type === 'SRV' ? srvService : null,
                        srvProto: type === 'SRV' ? srvProto : null,
                        srvPort: type === 'SRV' ? srvPort : null,
                        srvPriority: type === 'SRV' ? srvPriority : null,
                        srvWeight: type === 'SRV' ? srvWeight : null,
                    });

                    session.setMime('json');
                    session.body = JSON.stringify({ success: true });
                    return;
                } finally {
                    if (updateLockKey) {
                        releaseSubdomainLock(updateLockKey);
                    }
                }
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

    const detailRoute = ctx.route('/api/subdomains/:id').methods('PUT', 'DELETE');
    detailRoute.action(async (session, _params, id) => {
        const method = session.client.req.method?.toUpperCase();
        try {
            const { accountId } = await requireDevAccount(session);
            const rootDomain = defaultRootDomain;
            const existing = await findSubdomain(id, accountId);
            if (!existing) {
                throw new Error('记录不存在或无权访问');
            }

            if (method === 'DELETE') {
                await deleteSubdomainRecord(id, accountId);
                session.setMime('json');
                session.body = JSON.stringify({ success: true });
                return;
            }

            if (method === 'PUT') {
                const body = await session.parseRequestBody();
                const subdomainInput = String(body?.subdomain ?? existing.subdomain).trim();
                const target = String(body?.target ?? '').trim();
                const type = String((body?.type ?? existing.type ?? 'CNAME')).toUpperCase();
                const srvService = String(body?.srvService ?? existing.srvService ?? '').trim();
                const srvProto = String(body?.srvProto ?? existing.srvProto ?? '').trim();
                const srvPort = Number(body?.srvPort ?? existing.srvPort ?? 0);
                const srvPriority = Number(body?.srvPriority ?? existing.srvPriority ?? 0);
                const srvWeight = Number(body?.srvWeight ?? existing.srvWeight ?? 0);
                const proxied = type === 'SRV' ? false : (body?.proxied !== undefined ? Boolean(body.proxied) : existing.proxied);

                const normalized = normalizeSubdomain(subdomainInput, existing.rootDomain || rootDomain);
                const validationError = validateSubdomain(normalized, settings);
                if (validationError) {
                    throw new Error(validationError);
                }
                if (!target) {
                    throw new Error('目标地址不能为空');
                }
                if (!allowedRecordTypes.has(type)) {
                    throw new Error('仅支持 A、AAAA、CNAME、SRV 类型的记录');
                }
                if (type === 'SRV') {
                    if (!srvService || !srvProto || !Number.isFinite(srvPort) || srvPort <= 0) {
                        throw new Error('SRV 记录需要服务名称、协议和端口号');
                    }
                }

                let updateLockKey: string | null = null;
                if (normalized !== existing.subdomain) {
                    const targetRoot = existing.rootDomain || rootDomain;
                    updateLockKey = getSubdomainLockKey(normalized, targetRoot);
                    if (!acquireSubdomainLock(updateLockKey)) {
                        throw new Error('该子域名正在处理中，请稍后重试');
                    }
                    const includeNullRoot = targetRoot === defaultRootDomain;
                    const conflict = await findSubdomainByName(normalized, targetRoot, includeNullRoot);
                    if (conflict && conflict.id !== existing.id) {
                        throw new Error('该子域名已被占用');
                    }
                }

                try {
                    const updated = await updateDnsRecord(existing.recordId, {
                        subdomain: normalized,
                        content: target,
                        type,
                        proxied,
                        rootDomain: existing.rootDomain || rootDomain,
                        srv: type === 'SRV'
                            ? {
                                service: srvService,
                                proto: srvProto,
                                port: srvPort,
                                priority: srvPriority,
                                weight: srvWeight,
                                target,
                            }
                            : undefined,
                    });

                    await updateSubdomainRecord(existing.id, accountId, {
                        subdomain: normalized,
                        rootDomain: existing.rootDomain || rootDomain,
                        content: target,
                        type,
                        proxied,
                        srvService: type === 'SRV' ? srvService : null,
                        srvProto: type === 'SRV' ? srvProto : null,
                        srvPort: type === 'SRV' ? srvPort : null,
                        srvPriority: type === 'SRV' ? srvPriority : null,
                        srvWeight: type === 'SRV' ? srvWeight : null,
                    });

                    session.setMime('json');
                    session.body = JSON.stringify({
                        success: true,
                        data: {
                            id: existing.id,
                            subdomain: normalized,
                            fullDomain: withRootDomain(normalized, existing.rootDomain || rootDomain),
                            target: updated.content ?? target,
                            type: updated.type,
                            rootDomain: existing.rootDomain || rootDomain,
                            srvService: type === 'SRV' ? srvService : null,
                            srvProto: type === 'SRV' ? srvProto : null,
                            srvPort: type === 'SRV' ? srvPort : null,
                            srvPriority: type === 'SRV' ? srvPriority : null,
                            srvWeight: type === 'SRV' ? srvWeight : null,
                            proxied: updated.proxied ?? proxied,
                        },
                    });
                    return;
                } finally {
                    if (updateLockKey) {
                        releaseSubdomainLock(updateLockKey);
                    }
                }

            }

            session.status = 405;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: 'Method Not Allowed' });
        } catch (err) {
            session.status = 400;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: err instanceof Error ? err.message : String(err) });
        }
    });
}
