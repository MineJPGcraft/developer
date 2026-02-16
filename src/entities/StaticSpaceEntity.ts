import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'static_spaces' })
export class StaticSpaceEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'varchar', length: 128 })
    owner!: string;

    @Column({ type: 'varchar', length: 128 })
    name!: string;

    @Column({ type: 'text', nullable: false })
    domains_raw!: string;

    @Column({ type: 'bigint', default: 0 })
    used_bytes!: string;

    @CreateDateColumn({ type: 'timestamp' })
    created_at!: Date;

    @UpdateDateColumn({ type: 'timestamp' })
    updated_at!: Date;
}
