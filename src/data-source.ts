import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from './config';
import { ClientEntity } from './entities/ClientEntity';
import { UserEntity } from './entities/UserEntity';
import { SubdomainEntity } from './entities/SubdomainEntity';
import { SubdomainRetentionEntity } from './entities/SubdomainRetentionEntity';
import { StaticSpaceEntity } from './entities/StaticSpaceEntity';

let dataSource: DataSource | null = null;

async function createDataSource(): Promise<DataSource> {
    const db = config.database;
    const type = db.type ?? 'sqlite';

    const options = {
        type,
        entities: [ClientEntity, UserEntity, SubdomainEntity, SubdomainRetentionEntity, StaticSpaceEntity],
        synchronize: true,
        logging: false,
    } as any;

    if (type === 'sqlite') {
        options.database = db.path ?? './clients.sqlite';
    } else {
        if (!db.host || !db.database || !db.username) {
            throw new Error('PostgreSQL 配置缺少 host/username/database');
        }
        options.host = db.host;
        options.port = db.port ?? 5432;
        options.username = db.username;
        options.password = db.password;
        options.database = db.database;
        if (db.ssl) {
            options.ssl = { rejectUnauthorized: false };
        }
    }

    return new DataSource(options);
}

export async function getDataSource(): Promise<DataSource> {
    if (dataSource && dataSource.isInitialized) {
        return dataSource;
    }
    dataSource = await createDataSource();
    if (!dataSource.isInitialized) {
        await dataSource.initialize();
    }
    return dataSource;
}
