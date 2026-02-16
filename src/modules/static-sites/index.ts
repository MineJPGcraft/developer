import { Context, Logger } from 'yumeri';
import type { Session } from 'yumeri';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import Busboy from 'busboy';
import { Readable } from 'stream';
import { lookup as lookupMime } from 'mime-types';
import archiver from 'archiver';
import unzipper from 'unzipper';
import { config } from '../../config';
import { requireDevAccount } from '../../utils/dev-account';
import { enforceHost } from '../../utils/host-guard';
import {
    createStaticSpace,
    deleteStaticSpace,
    findStaticSpaceByIdAndOwner,
    listAllStaticSpaces,
    listStaticSpacesByOwner,
    updateStaticSpaceDomains,
    updateStaticSpaceUsage,
} from '../../db';
import crypto from 'crypto';

const logger = new Logger('StaticSites');

type DomainBinding = {
    spaceId: string;
    owner: string;
    domain: string;
};

type SpaceCache = {
    bindings: DomainBinding[];
    loadedAt: number;
};

let cache: SpaceCache | null = null;
const CACHE_TTL_MS = 60_000;
const tasks = new Map<string, {
    id: string;
    owner: string;
    status: 'running' | 'done' | 'failed';
    progress: number | null;
    message?: string;
    updatedAt: number;
}>();

function createTask(owner: string) {
    const id = crypto.randomBytes(12).toString('hex');
    const task = { id, owner, status: 'running' as const, progress: 0, updatedAt: Date.now() };
    tasks.set(id, task);
    return task;
}

function updateTask(id: string, patch: Partial<{ status: 'running' | 'done' | 'failed'; progress: number | null; message: string }>) {
    const task = tasks.get(id);
    if (!task) return;
    Object.assign(task, patch);
    task.updatedAt = Date.now();
}

function getTask(id: string, owner: string) {
    const task = tasks.get(id);
    if (!task || task.owner !== owner) return undefined;
    return task;
}

function normalizeDomain(input: string): string {
    return String(input || '').trim().toLowerCase();
}

function parseDomain(input: string) {
    const domain = normalizeDomain(input);
    if (!domain) {
        throw new Error('域名不能为空');
    }
    if (domain.includes('/')) {
        throw new Error('域名格式不合法');
    }
    if (domain.startsWith('*.')) {
        const base = domain.slice(2);
        if (!base || base.includes('*')) {
            throw new Error('通配符域名格式不合法');
        }
        return { domain, wildcard: true, base };
    }
    if (domain.includes('*')) {
        throw new Error('仅支持 *.example.com 形式的通配符');
    }
    return { domain, wildcard: false, base: domain };
}

function wildcardIntersects(baseA: string, baseB: string) {
    if (baseA === baseB) return true;
    if (baseA.endsWith(`.${baseB}`)) return true;
    if (baseB.endsWith(`.${baseA}`)) return true;
    return false;
}

function domainIntersects(a: string, b: string): boolean {
    const pa = parseDomain(a);
    const pb = parseDomain(b);
    if (!pa.wildcard && !pb.wildcard) {
        return pa.base === pb.base;
    }
    if (pa.wildcard && pb.wildcard) {
        return wildcardIntersects(pa.base, pb.base);
    }
    const wildcard = pa.wildcard ? pa : pb;
    const exact = pa.wildcard ? pb : pa;
    if (exact.base === wildcard.base) return false;
    return exact.base.endsWith(`.${wildcard.base}`);
}

function matchesDomain(host: string, domain: string): boolean {
    const parsed = parseDomain(domain);
    if (!parsed.wildcard) {
        return host === parsed.base;
    }
    if (host === parsed.base) return false;
    return host.endsWith(`.${parsed.base}`);
}

function stripPort(host: string): string {
    return host.split(':')[0].toLowerCase();
}

async function ensureSpaceRoot(spaceId: string): Promise<string> {
    const root = path.resolve(config.staticSites.rootDir, spaceId);
    await fsp.mkdir(root, { recursive: true });
    return root;
}

function safeResolve(spaceRoot: string, requestPath: string): string {
    const normalized = requestPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const target = path.resolve(spaceRoot, normalized);
    if (!target.startsWith(spaceRoot)) {
        throw new Error('非法路径');
    }
    return target;
}

function ensureSafeArchivePath(entryPath: string) {
    const normalized = entryPath.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.includes('..')) {
        throw new Error('压缩包内包含非法路径');
    }
    return normalized;
}

function ensureEditableFile(filePath: string) {
    const ext = path.extname(filePath).toLowerCase();
    const allowed = new Set(['.html', '.htm', '.css', '.js', '.json', '.txt', '.md']);
    if (!allowed.has(ext)) {
        throw new Error('该文件类型不支持在线编辑');
    }
}

async function getDirectorySize(target: string): Promise<number> {
    const stat = await fsp.stat(target);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    const entries = await fsp.readdir(target);
    let total = 0;
    for (const entry of entries) {
        total += await getDirectorySize(path.join(target, entry));
    }
    return total;
}

async function collectPaths(root: string, relative: string): Promise<string[]> {
    const target = safeResolve(root, relative);
    const stat = await fsp.stat(target);
    if (stat.isFile()) return [relative];
    if (!stat.isDirectory()) return [];
    const entries = await fsp.readdir(target);
    const results: string[] = [];
    for (const entry of entries) {
        const child = path.posix.join(relative, entry);
        results.push(...await collectPaths(root, child));
    }
    return results;
}

async function refreshBindings(): Promise<DomainBinding[]> {
    const spaces = await listAllStaticSpaces();
    const bindings: DomainBinding[] = [];
    for (const space of spaces) {
        for (const domain of space.domains) {
            bindings.push({ spaceId: space.id, owner: space.owner, domain });
        }
    }
    cache = { bindings, loadedAt: Date.now() };
    return bindings;
}

async function getBindings(): Promise<DomainBinding[]> {
    if (cache && (Date.now() - cache.loadedAt) < CACHE_TTL_MS) {
        return cache.bindings;
    }
    return await refreshBindings();
}

async function resolveSpaceByHost(host: string): Promise<DomainBinding | undefined> {
    const bindings = await getBindings();
    let best: DomainBinding | undefined;
    let bestScore = -1;
    for (const binding of bindings) {
        if (matchesDomain(host, binding.domain)) {
            const score = binding.domain.length;
            if (score > bestScore) {
                best = binding;
                bestScore = score;
            }
        }
    }
    return best;
}

async function buildListing(root: string, subPath: string) {
    const target = safeResolve(root, subPath);
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) {
        throw new Error('路径不是目录');
    }
    const entries = await fsp.readdir(target, { withFileTypes: true });
    return await Promise.all(entries.map(async entry => {
        const full = path.join(target, entry.name);
        const info = await fsp.stat(full);
        return {
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : 'file',
            size: entry.isDirectory() ? 0 : info.size,
            updatedAt: info.mtime.toISOString(),
        };
    }));
}

async function getUserUsage(owner: string): Promise<number> {
    const spaces = await listStaticSpacesByOwner(owner);
    return spaces.reduce((sum, space) => sum + (space.usedBytes || 0), 0);
}

function ensureWithinLimits(sizeDelta: number, spaceUsed: number, userUsed: number) {
    const maxSpace = config.staticSites.maxSpaceBytes;
    const maxTotal = config.staticSites.maxTotalBytes;
    if (spaceUsed + sizeDelta > maxSpace) {
        throw new Error('空间容量不足');
    }
    if (userUsed + sizeDelta > maxTotal) {
        throw new Error('总容量不足');
    }
}

function ensureValidSpaceName(name: string) {
    const value = String(name || '').trim();
    if (!value) throw new Error('空间名称不能为空');
    if (value.length > 64) throw new Error('空间名称过长');
    return value;
}

async function streamToFileWithLimit(
    target: string,
    stream: Readable,
    onProgress: (bytes: number) => void
) {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(target);
        let total = 0;
        let aborted = false;

        const abort = (err: Error) => {
            if (aborted) return;
            aborted = true;
            output.destroy(err);
            stream.destroy(err);
        };

        stream.on('data', chunk => {
            if (aborted) return;
            total += chunk.length;
            try {
                onProgress(total);
            } catch (err) {
                abort(err instanceof Error ? err : new Error(String(err)));
            }
        });
        stream.on('error', reject);
        output.on('error', reject);
        output.on('finish', () => resolve());
        stream.pipe(output);
    });
}

export function createPublicStaticMiddleware() {
    return async (session: Session, next: () => Promise<void>) => {
        try {
            const hostHeader = session.client.req.headers.host || '';
            const host = stripPort(String(hostHeader));
            if (!host) {
                await next();
                return;
            }

            const binding = await resolveSpaceByHost(host);
            if (!binding) {
                await next();
                return;
            }

            const req = session.client.req;
            const method = (req.method || 'GET').toUpperCase();
            if (!['GET', 'HEAD'].includes(method)) {
                session.status = 405;
                session.body = 'Method Not Allowed';
                return;
            }

            const spaceRoot = await ensureSpaceRoot(binding.spaceId);
            const base = new URL(`http://${host}`);
            const url = new URL(req.url || '/', base);
            let pathname = decodeURIComponent(url.pathname || '/');
            if (pathname.endsWith('/')) {
                pathname = `${pathname}index.html`;
            }
            const target = safeResolve(spaceRoot, pathname);
            let stat: fs.Stats;
            try {
                stat = await fsp.stat(target);
            } catch {
                session.status = 404;
                session.body = 'Not Found';
                return;
            }
            if (!stat.isFile()) {
                session.status = 404;
                session.body = 'Not Found';
                return;
            }
            const mime = lookupMime(target) || 'application/octet-stream';
            session.setMime(String(mime));
            session.responseHandled = true;
            const stream = fs.createReadStream(target);
            stream.pipe(session.client.res);
        } catch (err) {
            logger.error('Static host error:', err);
            session.status = 500;
            session.body = 'Static host error';
        }
    };
}

export function apply(ctx: Context) {
    const devHosts = config.server.devHosts;
    const guard = <T extends any[]>(handler: (session: Session, ...args: T) => void | Promise<void>) => {
        return async (session: Session, ...args: T): Promise<void> => {
            enforceHost(session, devHosts);
            if (session.status === 404) return;
            await handler(session, ...args);
        };
    };
    const jsonGuard = <T extends any[]>(handler: (session: Session, ...args: T) => void | Promise<void>) => {
        return guard(async (session: Session, ...args: T) => {
            try {
                await handler(session, ...args);
            } catch (err) {
                session.status = 400;
                session.setMime('json');
                session.body = JSON.stringify({ success: false, message: err instanceof Error ? err.message : String(err) });
            }
        });
    };

    ctx.route('/dashboard/static')
        .action(guard(async (session) => {
            await requireDevAccount(session);
            session.renderFile(path.resolve(process.cwd(), 'static/static-sites.ejs'), { ui: config.ui, cnameTarget: config.staticSites.cnameTarget });
        }));

    ctx.route('/api/static/config')
        .action(jsonGuard(async (session) => {
            await requireDevAccount(session);
            session.setMime('json');
            session.body = JSON.stringify({
                success: true,
                data: {
                    maxSpaceBytes: config.staticSites.maxSpaceBytes,
                    maxTotalBytes: config.staticSites.maxTotalBytes,
                    maxSpacesPerUser: config.staticSites.maxSpacesPerUser,
                    cnameTarget: config.staticSites.cnameTarget,
                },
            });
        }));

    ctx.route('/api/static/spaces').methods('GET', 'POST')
        .action(jsonGuard(async (session) => {
            const method = session.client.req.method?.toUpperCase();
            const { accountId } = await requireDevAccount(session);
            if (method === 'GET') {
                const spaces = await listStaticSpacesByOwner(accountId);
                session.setMime('json');
                session.body = JSON.stringify({ success: true, data: spaces });
                return;
            }
            if (method === 'POST') {
                const body = await session.parseRequestBody();
                const rawName = Array.isArray(body?.name) ? body.name[0] : body?.name;
                const name = ensureValidSpaceName(rawName);
                const spaces = await listStaticSpacesByOwner(accountId);
                if (spaces.length >= config.staticSites.maxSpacesPerUser) {
                    throw new Error('已达到空间数量上限');
                }
                const space = await createStaticSpace(accountId, name);
                await ensureSpaceRoot(space.id);
                session.setMime('json');
                session.body = JSON.stringify({ success: true, data: space });
                await refreshBindings();
                return;
            }
            session.status = 405;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: 'Method Not Allowed' });
        }));

    ctx.route('/api/static/spaces/:spaceId').methods('DELETE')
        .action(jsonGuard(async (session, _params, spaceId) => {
            const { accountId } = await requireDevAccount(session);
            const space = await findStaticSpaceByIdAndOwner(spaceId, accountId);
            if (!space) throw new Error('空间不存在');
            await deleteStaticSpace(spaceId, accountId);
            const root = path.resolve(config.staticSites.rootDir, spaceId);
            await fsp.rm(root, { recursive: true, force: true });
            await refreshBindings();
            session.setMime('json');
            session.body = JSON.stringify({ success: true });
        }));

    ctx.route('/api/static/spaces/:spaceId/domains').methods('POST', 'DELETE')
        .action(jsonGuard(async (session, _params, spaceId) => {
            const method = session.client.req.method?.toUpperCase();
            const { accountId } = await requireDevAccount(session);
            const space = await findStaticSpaceByIdAndOwner(spaceId, accountId);
            if (!space) throw new Error('空间不存在');
            const body = await session.parseRequestBody();
            const domainInput = Array.isArray(body?.domain) ? body.domain[0] : body?.domain;
            const parsed = parseDomain(domainInput);
            const domain = parsed.domain;
            const existingAll = await listAllStaticSpaces();
            const reservedHosts = [...config.server.userHosts, ...config.server.devHosts].map(item => item.toLowerCase());
            for (const reserved of reservedHosts) {
                if (domainIntersects(domain, reserved)) {
                    throw new Error('域名不可与系统域名冲突');
                }
            }
            if (method === 'POST') {
                for (const other of existingAll) {
                    if (other.id === space.id) continue;
                    for (const otherDomain of other.domains) {
                        if (domainIntersects(domain, otherDomain)) {
                            throw new Error('域名已被占用或与通配符冲突');
                        }
                    }
                }
                const updated = Array.from(new Set([...space.domains, domain]));
                await updateStaticSpaceDomains(space.id, updated);
                await refreshBindings();
                session.setMime('json');
                session.body = JSON.stringify({ success: true, data: updated });
                return;
            }
            if (method === 'DELETE') {
                const updated = space.domains.filter(item => item !== domain);
                await updateStaticSpaceDomains(space.id, updated);
                await refreshBindings();
                session.setMime('json');
                session.body = JSON.stringify({ success: true, data: updated });
                return;
            }
            session.status = 405;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: 'Method Not Allowed' });
        }));

    ctx.route('/api/static/spaces/:spaceId/tree').methods('GET')
        .action(jsonGuard(async (session, _params, spaceId) => {
            const { accountId } = await requireDevAccount(session);
            const space = await findStaticSpaceByIdAndOwner(spaceId, accountId);
            if (!space) throw new Error('空间不存在');
            const query = new URL(session.client.req.url || '/', 'http://localhost').searchParams;
            const dir = query.get('path') || '';
    const root = await ensureSpaceRoot(space.id);
    const entries = await buildListing(root, dir);
    session.setMime('json');
    session.body = JSON.stringify({ success: true, data: entries });
        }));

    ctx.route('/api/static/spaces/:spaceId/folder').methods('POST')
        .action(jsonGuard(async (session, _params, spaceId) => {
            const { accountId } = await requireDevAccount(session);
            const space = await findStaticSpaceByIdAndOwner(spaceId, accountId);
            if (!space) throw new Error('空间不存在');
            const body = await session.parseRequestBody();
            const parent = String(body?.path ?? '');
            const name = String(body?.name ?? '').trim();
            if (!name) throw new Error('目录名称不能为空');
            const root = await ensureSpaceRoot(space.id);
            const target = safeResolve(root, path.posix.join(parent, name));
            await fsp.mkdir(target, { recursive: true });
            session.setMime('json');
            session.body = JSON.stringify({ success: true });
        }));

    ctx.route('/api/static/spaces/:spaceId/rename').methods('POST')
        .action(jsonGuard(async (session, _params, spaceId) => {
            const { accountId } = await requireDevAccount(session);
            const space = await findStaticSpaceByIdAndOwner(spaceId, accountId);
            if (!space) throw new Error('空间不存在');
            const body = await session.parseRequestBody();
            const currentPath = String(body?.path ?? '');
            const newName = String(body?.newName ?? '').trim();
            if (!newName) throw new Error('新名称不能为空');
            const root = await ensureSpaceRoot(space.id);
            const source = safeResolve(root, currentPath);
            const target = safeResolve(root, path.posix.join(path.posix.dirname(currentPath), newName));
            await fsp.rename(source, target);
            session.setMime('json');
            session.body = JSON.stringify({ success: true });
        }));

    ctx.route('/api/static/spaces/:spaceId/item').methods('DELETE')
        .action(jsonGuard(async (session, _params, spaceId) => {
            const { accountId } = await requireDevAccount(session);
            const space = await findStaticSpaceByIdAndOwner(spaceId, accountId);
            if (!space) throw new Error('空间不存在');
            const query = new URL(session.client.req.url || '/', 'http://localhost').searchParams;
            const targetPath = query.get('path') || '';
            const root = await ensureSpaceRoot(space.id);
            const target = safeResolve(root, targetPath);
            const size = await getDirectorySize(target);
            await fsp.rm(target, { recursive: true, force: true });
            await updateStaticSpaceUsage(space.id, Math.max(0, space.usedBytes - size));
            session.setMime('json');
            session.body = JSON.stringify({ success: true });
        }));

    ctx.route('/api/static/spaces/:spaceId/file').methods('GET', 'POST')
        .action(jsonGuard(async (session, _params, spaceId) => {
            const method = session.client.req.method?.toUpperCase();
            const { accountId } = await requireDevAccount(session);
            const space = await findStaticSpaceByIdAndOwner(spaceId, accountId);
            if (!space) throw new Error('空间不存在');
            const root = await ensureSpaceRoot(space.id);

            if (method === 'GET') {
                const query = new URL(session.client.req.url || '/', 'http://localhost').searchParams;
                const targetPath = String(query.get('path') || '');
                const target = safeResolve(root, targetPath);
                ensureEditableFile(targetPath);
                const stat = await fsp.stat(target);
                if (!stat.isFile()) {
                    throw new Error('仅支持编辑文件');
                }
                const content = await fsp.readFile(target, 'utf-8');
                session.setMime('json');
                session.body = JSON.stringify({ success: true, data: { path: targetPath, content } });
                return;
            }

            if (method === 'POST') {
                const body = await session.parseRequestBody();
                const rawPath = Array.isArray(body?.path) ? body.path[0] : body?.path;
                const content = Array.isArray(body?.content) ? body.content[0] : body?.content;
                const targetPath = String(rawPath || '').trim();
                if (!targetPath) throw new Error('文件路径不能为空');
                ensureEditableFile(targetPath);
                const target = safeResolve(root, targetPath);

                let oldSize = 0;
                try {
                    const stat = await fsp.stat(target);
                    if (stat.isDirectory()) throw new Error('目标为目录');
                    oldSize = stat.size;
                } catch (err) {
                    if (err instanceof Error && err.message === '目标为目录') {
                        throw err;
                    }
                }

                const data = String(content ?? '');
                const newSize = Buffer.byteLength(data, 'utf-8');
                const userUsed = await getUserUsage(accountId);
                ensureWithinLimits(newSize - oldSize, space.usedBytes, userUsed);
                await fsp.mkdir(path.dirname(target), { recursive: true });
                await fsp.writeFile(target, data, 'utf-8');
                await updateStaticSpaceUsage(space.id, Math.max(0, space.usedBytes + (newSize - oldSize)));
                session.setMime('json');
                session.body = JSON.stringify({ success: true });
                return;
            }

            session.status = 405;
            session.setMime('json');
            session.body = JSON.stringify({ success: false, message: 'Method Not Allowed' });
        }));

    ctx.route('/api/static/tasks/:taskId').methods('GET')
        .action(jsonGuard(async (session, _params, taskId) => {
            const { accountId } = await requireDevAccount(session);
            const task = getTask(taskId, accountId);
            if (!task) throw new Error('任务不存在');
            session.setMime('json');
            session.body = JSON.stringify({ success: true, data: task });
        }));

    ctx.route('/api/static/spaces/:spaceId/zip').methods('POST')
        .action(jsonGuard(async (session, _params, spaceId) => {
            const { accountId } = await requireDevAccount(session);
            const space = await findStaticSpaceByIdAndOwner(spaceId, accountId);
            if (!space) throw new Error('空间不存在');
            const body = await session.parseRequestBody();
            const rawPaths = body?.paths;
            const outputNameRaw = Array.isArray(body?.outputName) ? body.outputName[0] : body?.outputName;
            const outputName = String(outputNameRaw || '').trim() || 'archive.zip';
            const paths = Array.isArray(rawPaths) ? rawPaths.map(String) : [];
            if (!paths.length) throw new Error('请选择要压缩的文件或目录');
            const root = await ensureSpaceRoot(space.id);

            const task = createTask(accountId);
            session.setMime('json');
            session.body = JSON.stringify({ success: true, data: { taskId: task.id } });

            (async () => {
                try {
                    const outputPath = safeResolve(root, outputName.endsWith('.zip') ? outputName : `${outputName}.zip`);
                    const files = new Set<string>();
                    for (const rel of paths) {
                        const cleaned = String(rel || '').replace(/^\/+/, '');
                        const collected = await collectPaths(root, cleaned);
                        collected.forEach(item => files.add(item));
                    }
                    if (!files.size) throw new Error('无可压缩文件');

                    const output = fs.createWriteStream(outputPath);
                    const archive = archiver('zip', { zlib: { level: 9 } });
                    archive.on('progress', data => {
                        const total = data.fs.totalBytes;
                        const processed = data.fs.processedBytes;
                        const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
                        updateTask(task.id, { progress: percent });
                    });
                    archive.on('error', err => {
                        updateTask(task.id, { status: 'failed', message: err.message });
                    });
                    archive.pipe(output);
                    for (const rel of files) {
                        const abs = safeResolve(root, rel);
                        archive.file(abs, { name: rel });
                    }
                    await archive.finalize();
                    await new Promise<void>(resolve => output.on('close', () => resolve()));

                    const stat = await fsp.stat(outputPath);
                    const delta = stat.size;
                    const userUsed = await getUserUsage(accountId);
                    ensureWithinLimits(delta, space.usedBytes, userUsed);
                    await updateStaticSpaceUsage(space.id, space.usedBytes + delta);
                    updateTask(task.id, { status: 'done', progress: 100 });
                } catch (err) {
                    updateTask(task.id, { status: 'failed', message: err instanceof Error ? err.message : String(err) });
                }
            })();
        }));

    ctx.route('/api/static/spaces/:spaceId/unzip').methods('POST')
        .action(jsonGuard(async (session, _params, spaceId) => {
            const { accountId } = await requireDevAccount(session);
            const space = await findStaticSpaceByIdAndOwner(spaceId, accountId);
            if (!space) throw new Error('空间不存在');
            const body = await session.parseRequestBody();
            const rawPath = Array.isArray(body?.path) ? body.path[0] : body?.path;
            const rawTarget = Array.isArray(body?.targetDir) ? body.targetDir[0] : body?.targetDir;
            const zipPath = String(rawPath || '').trim();
            if (!zipPath) throw new Error('压缩包路径不能为空');
            const targetDir = String(rawTarget || '').trim();
            const root = await ensureSpaceRoot(space.id);
            const absZip = safeResolve(root, zipPath);

            const task = createTask(accountId);
            session.setMime('json');
            session.body = JSON.stringify({ success: true, data: { taskId: task.id } });

            (async () => {
                try {
                    const dir = await unzipper.Open.file(absZip);
                    let totalSize = 0;
                    let existingSize = 0;
                    for (const entry of dir.files) {
                        if (entry.type !== 'File') continue;
                        totalSize += entry.uncompressedSize || 0;
                        const entryPath = ensureSafeArchivePath(entry.path);
                        const target = safeResolve(root, path.posix.join(targetDir, entryPath));
                        try {
                            const stat = await fsp.stat(target);
                            if (stat.isFile()) existingSize += stat.size;
                        } catch {
                            // ignore
                        }
                    }
                    const delta = totalSize - existingSize;
                    const userUsed = await getUserUsage(accountId);
                    ensureWithinLimits(delta, space.usedBytes, userUsed);

                    let processed = 0;
                    for (const entry of dir.files) {
                        const entryPath = ensureSafeArchivePath(entry.path);
                        const target = safeResolve(root, path.posix.join(targetDir, entryPath));
                        if (entry.type === 'Directory') {
                            await fsp.mkdir(target, { recursive: true });
                            continue;
                        }
                        await fsp.mkdir(path.dirname(target), { recursive: true });
                        await new Promise<void>((resolve, reject) => {
                            entry.stream()
                                .on('data', (chunk: Buffer) => {
                                    processed += chunk.length;
                                    const percent = totalSize > 0 ? Math.min(100, Math.round((processed / totalSize) * 100)) : 0;
                                    updateTask(task.id, { progress: percent });
                                })
                                .on('error', reject)
                                .pipe(fs.createWriteStream(target))
                                .on('finish', resolve)
                                .on('error', reject);
                        });
                    }

                    await updateStaticSpaceUsage(space.id, space.usedBytes + delta);
                    updateTask(task.id, { status: 'done', progress: 100 });
                } catch (err) {
                    updateTask(task.id, { status: 'failed', message: err instanceof Error ? err.message : String(err) });
                }
            })();
        }));

    ctx.route('/api/static/spaces/:spaceId/upload').methods('POST')
        .action(jsonGuard(async (session, _params, spaceId) => {
            const { accountId } = await requireDevAccount(session);
            const space = await findStaticSpaceByIdAndOwner(spaceId, accountId);
            if (!space) throw new Error('空间不存在');
            const query = new URL(session.client.req.url || '/', 'http://localhost').searchParams;
            const uploadPath = query.get('path') || '';
            const root = await ensureSpaceRoot(space.id);
            const userUsed = await getUserUsage(accountId);

            const req = session.client.req;
            const busboy = Busboy({ headers: req.headers, limits: { files: 1 } });
            let uploadError: Error | null = null;
            let uploadedBytes = 0;
            let writtenFile: string | null = null;
            let oldSize = 0;
            let fileSeen = false;

            busboy.on('file', async (_name, file, info) => {
                if (uploadError) {
                    file.resume();
                    return;
                }
                fileSeen = true;
                const filename = info.filename;
                if (!filename) {
                    uploadError = new Error('文件名不能为空');
                    file.resume();
                    return;
                }
                const target = safeResolve(root, path.posix.join(uploadPath, filename));
                try {
                    const stat = await fsp.stat(target);
                    if (stat.isFile()) {
                        oldSize = stat.size;
                    }
                } catch {
                    // ignore
                }

                try {
                    await streamToFileWithLimit(target, file, (bytes) => {
                        uploadedBytes = bytes;
                        ensureWithinLimits(uploadedBytes - oldSize, space.usedBytes, userUsed);
                    });
                    writtenFile = target;
                } catch (err) {
                    uploadError = err as Error;
                }
            });
            busboy.on('filesLimit', () => {
                uploadError = new Error('一次只能上传一个文件');
            });

            busboy.on('finish', async () => {
                if (!fileSeen) {
                    session.status = 400;
                    session.setMime('json');
                    session.body = JSON.stringify({ success: false, message: '未检测到上传文件' });
                    return;
                }
                if (uploadError) {
                    if (writtenFile) {
                        await fsp.rm(writtenFile, { force: true });
                    }
                    session.status = 400;
                    session.setMime('json');
                    session.body = JSON.stringify({ success: false, message: uploadError.message });
                    return;
                }
                const delta = uploadedBytes - oldSize;
                const newUsed = Math.max(0, space.usedBytes + delta);
                await updateStaticSpaceUsage(space.id, newUsed);
                session.setMime('json');
                session.body = JSON.stringify({ success: true });
            });

            req.pipe(busboy);
        }));
}
