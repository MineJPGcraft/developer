import fetch from 'node-fetch';
import { config } from './config';

interface CloudflareRecord {
    id: string;
    name: string;
    content: string;
    type: string;
    proxied?: boolean;
}

interface CloudflareError {
    message: string;
}

interface CloudflareRecordResponse {
    success: boolean;
    errors?: CloudflareError[];
    result?: CloudflareRecord;
}

interface CloudflareRecordListResponse {
    success: boolean;
    errors?: CloudflareError[];
    result?: CloudflareRecord[];
}

function ensureCloudflareConfig(rootDomain?: string) {
    if (config.cloudflareDomains && config.cloudflareDomains.length) {
        if (rootDomain) {
            const matched = config.cloudflareDomains.find(item => item.rootDomain === rootDomain);
            if (!matched) {
                throw new Error(`未找到匹配的顶级域名配置: ${rootDomain}`);
            }
            return matched;
        }
        const desired = config.cloudflareDefaultDomain
            ? config.cloudflareDomains.find(item => item.rootDomain === config.cloudflareDefaultDomain)
            : undefined;
        return desired || config.cloudflareDomains[0];
    }
    if (!config.cloudflare) {
        throw new Error('未配置 Cloudflare 参数');
    }
    return config.cloudflare;
}

function escapeRegex(input: string) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSubdomainInput(subdomain: string, rootDomain: string): string {
    const value = String(subdomain || '').trim();
    if (!value) return '';
    const trimmed = value
        .replace(/\s+/g, '')
        .replace(/^\.+/, '')
        .replace(/\.+$/, '');
    if (!rootDomain) {
        return trimmed;
    }
    const suffixPattern = new RegExp(`\.${escapeRegex(rootDomain)}$`, 'i');
    if (trimmed.toLowerCase() === rootDomain.toLowerCase()) {
        return '';
    }
    if (suffixPattern.test(trimmed)) {
        return trimmed.replace(suffixPattern, '');
    }
    return trimmed;
}

function buildRecordName(subdomain: string, rootDomain: string): string {
    if (!subdomain) {
        return rootDomain;
    }
    return `${subdomain}.${rootDomain}`;
}

export function normalizeZoneSubdomain(subdomain: string, rootDomain?: string): string {
    const cf = ensureCloudflareConfig(rootDomain);
    return normalizeSubdomainInput(subdomain, cf.rootDomain);
}

function resolveRecordName(subdomain: string, rootDomain?: string) {
    const cf = ensureCloudflareConfig(rootDomain);
    const normalized = normalizeZoneSubdomain(subdomain, cf.rootDomain);
    return buildRecordName(normalized, cf.rootDomain);
}

export async function createDnsRecord({
    subdomain,
    content,
    type,
    proxied,
    srv,
    rootDomain,
}: {
    subdomain: string;
    content: string;
    type?: string;
    proxied?: boolean;
    rootDomain?: string;
    srv?: {
        service: string;
        proto: string;
        port: number;
        target: string;
        priority?: number;
        weight?: number;
    };
}) {
    const cf = ensureCloudflareConfig(rootDomain);
    const normalized = normalizeZoneSubdomain(subdomain, cf.rootDomain);
    const recordType = (type || cf.defaultRecordType || 'CNAME').toUpperCase();
    const body: Record<string, unknown> = { type: recordType };

    if (recordType === 'SRV') {
        const service = normalizeSrvLabel(srv?.service || '');
        const proto = normalizeSrvLabel(srv?.proto || '');
        const port = Number(srv?.port);
        const target = String(srv?.target || '').trim();
        if (!service || !proto || !Number.isFinite(port) || port <= 0 || !target) {
            throw new Error('SRV 记录需要 service、proto、port、target');
        }
        const baseName = resolveRecordName(normalized, cf.rootDomain);
        const recordName = `${service}.${proto}.${baseName}`;
        body.name = recordName;
        body.data = {
            service,
            proto,
            name: baseName,
            priority: Number.isFinite(Number(srv?.priority)) ? Number(srv?.priority) : 0,
            weight: Number.isFinite(Number(srv?.weight)) ? Number(srv?.weight) : 0,
            port,
            target,
        };
    } else {
        const name = resolveRecordName(normalized, cf.rootDomain);
        body.name = name;
        body.content = content;
        if (recordType !== 'TXT') {
            body.proxied = proxied ?? cf.proxied ?? false;
        }
    }

    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${cf.zoneId}/dns_records`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${cf.apiToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const data = await res.json() as CloudflareRecordResponse;
    if (!data.success || !data.result) {
        const message = data.errors?.map(err => err.message).join('; ') || '未知错误';
        throw new Error(`Cloudflare 创建记录失败: ${message}`);
    }
    return data.result;
}

export async function updateDnsRecord(recordId: string, { subdomain, content, type, proxied, srv, rootDomain }: {
    subdomain: string;
    content: string;
    type?: string;
    proxied?: boolean;
    srv?: {
        service: string;
        proto: string;
        port: number;
        target: string;
        priority?: number;
        weight?: number;
    };
    rootDomain?: string;
}) {
    const cf = ensureCloudflareConfig(rootDomain);
    const normalized = normalizeZoneSubdomain(subdomain, cf.rootDomain);
    const recordType = (type || cf.defaultRecordType || 'CNAME').toUpperCase();
    const body: Record<string, unknown> = { type: recordType };

    if (recordType === 'SRV') {
        const service = normalizeSrvLabel(srv?.service || '');
        const proto = normalizeSrvLabel(srv?.proto || '');
        const port = Number(srv?.port);
        const target = String(srv?.target || '').trim();
        if (!service || !proto || !Number.isFinite(port) || port <= 0 || !target) {
            throw new Error('SRV 记录需要 service、proto、port、target');
        }
        const baseName = resolveRecordName(normalized, cf.rootDomain);
        const recordName = `${service}.${proto}.${baseName}`;
        body.name = recordName;
        body.data = {
            service,
            proto,
            name: baseName,
            priority: Number.isFinite(Number(srv?.priority)) ? Number(srv?.priority) : 0,
            weight: Number.isFinite(Number(srv?.weight)) ? Number(srv?.weight) : 0,
            port,
            target,
        };
    } else {
        const name = resolveRecordName(normalized, cf.rootDomain);
        body.name = name;
        body.content = content;
        if (recordType !== 'TXT') {
            body.proxied = proxied ?? cf.proxied ?? false;
        }
    }

    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${cf.zoneId}/dns_records/${recordId}`, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${cf.apiToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    const data = await res.json() as CloudflareRecordResponse;
    if (!data.success || !data.result) {
        const message = data.errors?.map(err => err.message).join('; ') || '未知错误';
        throw new Error(`Cloudflare 更新记录失败: ${message}`);
    }
    return data.result;
}

export async function deleteDnsRecord(recordId: string, rootDomain?: string) {
    const cf = ensureCloudflareConfig(rootDomain);
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${cf.zoneId}/dns_records/${recordId}`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${cf.apiToken}`,
            'Content-Type': 'application/json',
        },
    });
    const data = await res.json() as CloudflareRecordResponse;
    if (!data.success) {
        const message = data.errors?.map(err => err.message).join('; ') || '未知错误';
        throw new Error(`Cloudflare 删除记录失败: ${message}`);
    }
}

export async function listDnsRecordsByName(subdomain: string, options?: { type?: string; rootDomain?: string }) {
    const cf = ensureCloudflareConfig(options?.rootDomain);
    const name = resolveRecordName(subdomain, cf.rootDomain);
    const url = new URL(`https://api.cloudflare.com/client/v4/zones/${cf.zoneId}/dns_records`);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('name', name);
    if (options?.type) {
        url.searchParams.set('type', options.type);
    }

    const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${cf.apiToken}`,
            'Content-Type': 'application/json',
        },
    });
    const data = await res.json() as CloudflareRecordListResponse;
    if (!data.success || !data.result) {
        const message = data.errors?.map(err => err.message).join('; ') || '未知错误';
        throw new Error(`Cloudflare 查询记录失败: ${message}`);
    }
    return data.result;
}

export type { CloudflareRecord };

function normalizeSrvLabel(value: string) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    return trimmed.startsWith('_') ? trimmed : `_${trimmed}`;
}
