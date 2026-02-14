import { randomBytes } from 'crypto';
import { Logger } from '@yumerijs/core';
import { config } from './config';
import { getDataSource } from './data-source';
import { ClientEntity } from './entities/ClientEntity';
import { UserEntity } from './entities/UserEntity';
import { SubdomainEntity } from './entities/SubdomainEntity';
import { SubdomainRetentionEntity } from './entities/SubdomainRetentionEntity';

export interface Client {
    client_id: string;
    client_secret: string;
    client_name: string;
    redirect_uris: string[];
    grant_types: string[];
    response_types: string[];
    token_endpoint_auth_method: string;
    owner: string;
}

export interface User {
    id: string;
    claims: string;
}

export interface Subdomain {
    id: string;
    owner: string;
    recordId: string;
    subdomain: string;
    rootDomain?: string | null;
    content: string;
    type: string;
    srvService?: string | null;
    srvProto?: string | null;
    srvPort?: number | null;
    srvPriority?: number | null;
    srvWeight?: number | null;
    proxied: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export interface Certificate {
    id: string;
    owner: string;
    domain: string;
    status: 'pending' | 'issued' | 'failed';
    message: string | null;
    acmeServer: string;
    certificatePath: string | null;
    privateKeyPath: string | null;
    fullchainPath: string | null;
    subdomainId: string | null;
    createdAt: Date;
    updatedAt: Date;
}

const SUBDOMAIN_RETENTION_DAYS = 90;

const logger = new Logger('Database');

function parseJsonArray(raw: string): string[] {
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed.map(item => String(item));
        }
    } catch (err) {
        // fallthrough
    }
    return [];
}

function toClient(entity: ClientEntity): Client {
    return {
        client_id: entity.client_id,
        client_secret: entity.client_secret,
        client_name: entity.client_name,
        redirect_uris: parseJsonArray(entity.redirect_uris_raw),
        grant_types: parseJsonArray(entity.grant_types_raw),
        response_types: parseJsonArray(entity.response_types_raw),
        token_endpoint_auth_method: entity.token_endpoint_auth_method,
        owner: entity.owner,
    };
}

async function clientRepository() {
    const ds = await getDataSource();
    return ds.getRepository(ClientEntity);
}

async function userRepository() {
    const ds = await getDataSource();
    return ds.getRepository(UserEntity);
}

async function subdomainRepository() {
    const ds = await getDataSource();
    return ds.getRepository(SubdomainEntity);
}

async function retentionRepository() {
    const ds = await getDataSource();
    return ds.getRepository(SubdomainRetentionEntity);
}

export const findClient = async (id: string): Promise<Client | undefined> => {
    const repo = await clientRepository();
    const entity = await repo.findOne({ where: { client_id: id } });
    return entity ? toClient(entity) : undefined;
};

export const createClient = async (
    { client_name, redirect_uris }: { client_name: string; redirect_uris: string[] },
    owner: string,
    clientId?: string
): Promise<Client> => {
    const repo = await clientRepository();
    const entity = repo.create({
        client_id: clientId || randomBytes(16).toString('hex'),
        client_secret: randomBytes(32).toString('hex'),
        client_name,
        redirect_uris_raw: JSON.stringify(redirect_uris),
        grant_types_raw: JSON.stringify(['authorization_code']),
        response_types_raw: JSON.stringify(['code']),
        token_endpoint_auth_method: 'client_secret_basic',
        owner,
    });
    await repo.save(entity);
    logger.info(`Client created: ${entity.client_name} (${entity.client_id})`);
    return toClient(entity);
};

export const listClients = async (owner: string, includeSystem = false): Promise<Client[]> => {
    const repo = await clientRepository();
    const where = includeSystem ? [{ owner }, { owner: 'system' }] : [{ owner }];
    const entities = await repo.find({ where, order: { client_name: 'ASC' } });
    return entities.map(toClient);
};

export const updateClient = async (
    clientId: string,
    owner: string,
    { client_name, redirect_uris }: { client_name: string; redirect_uris: string[] }
) => {
    const repo = await clientRepository();
    const entity = await repo.findOne({ where: { client_id: clientId } });
    if (!entity) {
        throw new Error('客户端不存在');
    }
    if (entity.owner !== owner) {
        throw new Error('无权修改该客户端');
    }
    entity.client_name = client_name;
    entity.redirect_uris_raw = JSON.stringify(redirect_uris);
    await repo.save(entity);
    logger.info(`Client updated: ${clientId}`);
};

export const deleteClient = async (clientId: string, owner: string) => {
    const repo = await clientRepository();
    const entity = await repo.findOne({ where: { client_id: clientId } });
    if (!entity) {
        throw new Error('客户端不存在');
    }
    if (entity.owner !== owner) {
        throw new Error('无权删除该客户端');
    }
    await repo.remove(entity);
    logger.info(`Client deleted: ${clientId}`);
};

export const findUser = async (id: string): Promise<User | undefined> => {
    const repo = await userRepository();
    const entity = await repo.findOne({ where: { id } });
    return entity ? { id: entity.id, claims: entity.claims } : undefined;
};

export const upsertUser = async (id: string, claims: object) => {
    const repo = await userRepository();
    const existing = await repo.findOne({ where: { id } });
    if (existing) {
        existing.claims = JSON.stringify(claims);
        await repo.save(existing);
        logger.info(`User updated: ${id}`);
    } else {
        const entity = repo.create({ id, claims: JSON.stringify(claims) });
        await repo.save(entity);
        logger.info(`User created: ${id}`);
    }
};

export const listSubdomains = async (owner: string): Promise<Subdomain[]> => {
    const repo = await subdomainRepository();
    const records = await repo.find({ where: { owner }, order: { created_at: 'DESC' } });
    return records.map(record => ({
        id: record.id,
        owner: record.owner,
        recordId: record.record_id,
        subdomain: record.subdomain,
        rootDomain: record.root_domain ?? null,
        content: record.content,
        type: record.type,
        srvService: record.srv_service ?? null,
        srvProto: record.srv_proto ?? null,
        srvPort: record.srv_port ?? null,
        srvPriority: record.srv_priority ?? null,
        srvWeight: record.srv_weight ?? null,
        proxied: record.proxied,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
    }));
};

export const listAllSubdomains = async (): Promise<Subdomain[]> => {
    const repo = await subdomainRepository();
    const records = await repo.find({ order: { created_at: 'DESC' } });
    return records.map(record => ({
        id: record.id,
        owner: record.owner,
        recordId: record.record_id,
        subdomain: record.subdomain,
        rootDomain: record.root_domain ?? null,
        content: record.content,
        type: record.type,
        srvService: record.srv_service ?? null,
        srvProto: record.srv_proto ?? null,
        srvPort: record.srv_port ?? null,
        srvPriority: record.srv_priority ?? null,
        srvWeight: record.srv_weight ?? null,
        proxied: record.proxied,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
    }));
};

export const findSubdomain = async (id: string, owner: string): Promise<Subdomain | undefined> => {
    const repo = await subdomainRepository();
    const record = await repo.findOne({ where: { id, owner } });
    if (!record) return undefined;
    return {
        id: record.id,
        owner: record.owner,
        recordId: record.record_id,
        subdomain: record.subdomain,
        rootDomain: record.root_domain ?? null,
        content: record.content,
        type: record.type,
        srvService: record.srv_service ?? null,
        srvProto: record.srv_proto ?? null,
        srvPort: record.srv_port ?? null,
        srvPriority: record.srv_priority ?? null,
        srvWeight: record.srv_weight ?? null,
        proxied: record.proxied,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
    };
};

export const findSubdomainByName = async (subdomain: string, rootDomain?: string, includeNull = false): Promise<Subdomain | undefined> => {
    const repo = await subdomainRepository();
    const where = rootDomain
        ? includeNull
            ? [{ subdomain, root_domain: rootDomain }, { subdomain, root_domain: null }]
            : [{ subdomain, root_domain: rootDomain }]
        : [{ subdomain }];
    const record = await repo.findOne({ where });
    if (!record) return undefined;
    return {
        id: record.id,
        owner: record.owner,
        recordId: record.record_id,
        subdomain: record.subdomain,
        rootDomain: record.root_domain ?? null,
        content: record.content,
        type: record.type,
        srvService: record.srv_service ?? null,
        srvProto: record.srv_proto ?? null,
        srvPort: record.srv_port ?? null,
        srvPriority: record.srv_priority ?? null,
        srvWeight: record.srv_weight ?? null,
        proxied: record.proxied,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
    };
};

export const findSubdomainById = async (id: string): Promise<Subdomain | undefined> => {
    const repo = await subdomainRepository();
    const record = await repo.findOne({ where: { id } });
    if (!record) return undefined;
    return {
        id: record.id,
        owner: record.owner,
        recordId: record.record_id,
        subdomain: record.subdomain,
        rootDomain: record.root_domain ?? null,
        content: record.content,
        type: record.type,
        srvService: record.srv_service ?? null,
        srvProto: record.srv_proto ?? null,
        srvPort: record.srv_port ?? null,
        srvPriority: record.srv_priority ?? null,
        srvWeight: record.srv_weight ?? null,
        proxied: record.proxied,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
    };
};

export const countSubdomainsByOwner = async (owner: string): Promise<number> => {
    const repo = await subdomainRepository();
    return repo.count({ where: { owner } });
};

export const addSubdomainRetention = async (subdomain: string, owner: string) => {
    const repo = await retentionRepository();
    const entity = repo.create({ subdomain, owner });
    await repo.save(entity);
};

export const clearSubdomainRetentionForOwner = async (subdomain: string, owner: string) => {
    const repo = await retentionRepository();
    await repo.delete({ subdomain, owner });
};

export const isSubdomainRestricted = async (subdomain: string, owner: string): Promise<boolean> => {
    const repo = await retentionRepository();
    const cutoff = new Date(Date.now() - SUBDOMAIN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const record = await repo.findOne({ where: { subdomain }, order: { deletedAt: 'DESC' } });
    if (!record) return false;
    if (record.deletedAt < cutoff) {
        await repo.delete({ id: record.id });
        return false;
    }
    if (record.owner === owner) {
        return false;
    }
    return true;
};

export const createSubdomainRecord = async (params: {
    owner: string;
    recordId?: string;
    subdomain: string;
    rootDomain?: string | null;
    content: string;
    type: string;
    srvService?: string | null;
    srvProto?: string | null;
    srvPort?: number | null;
    srvPriority?: number | null;
    srvWeight?: number | null;
    proxied: boolean;
}): Promise<Subdomain> => {
    if (await isSubdomainRestricted(params.subdomain, params.owner)) {
        throw new Error('该子域名处于保护期，暂时无法注册');
    }
    const repo = await subdomainRepository();
    const entity = repo.create({
        owner: params.owner,
        record_id: params.recordId,
        subdomain: params.subdomain,
        root_domain: params.rootDomain ?? null,
        content: params.content,
        type: params.type,
        srv_service: params.srvService ?? null,
        srv_proto: params.srvProto ?? null,
        srv_port: params.srvPort ?? null,
        srv_priority: params.srvPriority ?? null,
        srv_weight: params.srvWeight ?? null,
        proxied: params.proxied,
    });
    await repo.save(entity);
    await clearSubdomainRetentionForOwner(params.subdomain, params.owner);
    return {
        id: entity.id,
        owner: entity.owner,
        recordId: entity.record_id,
        subdomain: entity.subdomain,
        rootDomain: entity.root_domain ?? null,
        content: entity.content,
        type: entity.type,
        srvService: entity.srv_service ?? null,
        srvProto: entity.srv_proto ?? null,
        srvPort: entity.srv_port ?? null,
        srvPriority: entity.srv_priority ?? null,
        srvWeight: entity.srv_weight ?? null,
        proxied: entity.proxied,
        createdAt: entity.created_at,
        updatedAt: entity.updated_at,
    };
};

export const deleteSubdomainRecord = async (id: string, owner: string): Promise<string> => {
    const repo = await subdomainRepository();
    const entity = await repo.findOne({ where: { id, owner } });
    if (!entity) {
        throw new Error('记录不存在或无权删除');
    }
    const subdomain = entity.subdomain;
    await repo.remove(entity);
    await addSubdomainRetention(subdomain, owner);
    return subdomain;
};

export const updateSubdomainRecord = async (id: string, owner: string, updates: {
    subdomain: string;
    rootDomain?: string | null;
    content: string;
    type: string;
    proxied: boolean;
    recordId?: string;
    srvService?: string | null;
    srvProto?: string | null;
    srvPort?: number | null;
    srvPriority?: number | null;
    srvWeight?: number | null;
}) => {
    const repo = await subdomainRepository();
    const entity = await repo.findOne({ where: { id, owner } });
    if (!entity) {
        throw new Error('记录不存在或无权修改');
    }
    entity.subdomain = updates.subdomain;
    entity.root_domain = updates.rootDomain ?? entity.root_domain ?? null;
    entity.content = updates.content;
    entity.type = updates.type;
    entity.proxied = updates.proxied;
    entity.srv_service = updates.srvService ?? null;
    entity.srv_proto = updates.srvProto ?? null;
    entity.srv_port = updates.srvPort ?? null;
    entity.srv_priority = updates.srvPriority ?? null;
    entity.srv_weight = updates.srvWeight ?? null;
    if (updates.recordId) {
        entity.record_id = updates.recordId;
    }
    await repo.save(entity);
};

export const updateSubdomainRecordById = async (id: string, updates: {
    subdomain: string;
    rootDomain?: string | null;
    content: string;
    type: string;
    proxied: boolean;
    recordId?: string;
    srvService?: string | null;
    srvProto?: string | null;
    srvPort?: number | null;
    srvPriority?: number | null;
    srvWeight?: number | null;
}) => {
    const repo = await subdomainRepository();
    const entity = await repo.findOne({ where: { id } });
    if (!entity) {
        throw new Error('记录不存在或无权修改');
    }
    entity.subdomain = updates.subdomain;
    entity.root_domain = updates.rootDomain ?? entity.root_domain ?? null;
    entity.content = updates.content;
    entity.type = updates.type;
    entity.proxied = updates.proxied;
    entity.srv_service = updates.srvService ?? null;
    entity.srv_proto = updates.srvProto ?? null;
    entity.srv_port = updates.srvPort ?? null;
    entity.srv_priority = updates.srvPriority ?? null;
    entity.srv_weight = updates.srvWeight ?? null;
    if (updates.recordId) {
        entity.record_id = updates.recordId;
    }
    await repo.save(entity);
};

export const deleteSubdomainRecordById = async (id: string): Promise<string> => {
    const repo = await subdomainRepository();
    const entity = await repo.findOne({ where: { id } });
    if (!entity) {
        throw new Error('记录不存在或无权删除');
    }
    const subdomain = entity.subdomain;
    await repo.remove(entity);
    return subdomain;
};

export const listAllClients = async (): Promise<Client[]> => {
    const repo = await clientRepository();
    const entities = await repo.find({ order: { client_name: 'ASC' } });
    return entities.map(toClient);
};

export const updateClientAdmin = async (
    clientId: string,
    { client_name, redirect_uris }: { client_name: string; redirect_uris: string[] }
) => {
    const repo = await clientRepository();
    const entity = await repo.findOne({ where: { client_id: clientId } });
    if (!entity) {
        throw new Error('客户端不存在');
    }
    entity.client_name = client_name;
    entity.redirect_uris_raw = JSON.stringify(redirect_uris);
    await repo.save(entity);
};

export const deleteClientAdmin = async (clientId: string) => {
    const repo = await clientRepository();
    const entity = await repo.findOne({ where: { client_id: clientId } });
    if (!entity) {
        throw new Error('客户端不存在');
    }
    await repo.remove(entity);
};

async function ensureDevPortalClient() {
    const repo = await clientRepository();
    const devPortalId = 'dev-portal';
    const expectedRedirects = [`${config.server.issuer}/dashboard/callback`];
    let entity = await repo.findOne({ where: { client_id: devPortalId } });
    if (!entity) {
        entity = repo.create({
            client_id: devPortalId,
            client_secret: randomBytes(32).toString('hex'),
            client_name: 'Developer Portal',
            redirect_uris_raw: JSON.stringify(expectedRedirects),
            grant_types_raw: JSON.stringify(['authorization_code']),
            response_types_raw: JSON.stringify(['code']),
            token_endpoint_auth_method: 'client_secret_basic',
            owner: 'system',
        });
        await repo.save(entity);
        logger.info('Created default developer portal client');
        return;
    }

    const currentRedirects = parseJsonArray(entity.redirect_uris_raw);
    const expected = JSON.stringify(expectedRedirects);
    if (JSON.stringify(currentRedirects) !== expected) {
        entity.redirect_uris_raw = JSON.stringify(expectedRedirects);
        await repo.save(entity);
        logger.info('Updated developer portal redirect URIs');
    }
}

(async () => {
    try {
        await getDataSource();
        await ensureDevPortalClient();
        logger.info('Database initialized.');
    } catch (err) {
        logger.error('Failed to initialize database:', err);
        process.exit(1);
    }
})();
