import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'subdomains' })
export class SubdomainEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ length: 128 })
    owner!: string;

    @Column({ length: 128 })
    record_id!: string;

    @Column({ length: 256 })
    subdomain!: string;

    @Column({ length: 128, nullable: true })
    root_domain!: string | null;

    @Column({ length: 256 })
    content!: string;

    @Column({ length: 16, default: 'CNAME' })
    type!: string;

    @Column({ length: 64, nullable: true })
    srv_service!: string | null;

    @Column({ length: 16, nullable: true })
    srv_proto!: string | null;

    @Column({ type: 'int', nullable: true })
    srv_port!: number | null;

    @Column({ type: 'int', nullable: true })
    srv_priority!: number | null;

    @Column({ type: 'int', nullable: true })
    srv_weight!: number | null;

    @Column({ default: false })
    proxied!: boolean;

    @CreateDateColumn({})
    created_at!: Date;

    @UpdateDateColumn({})
    updated_at!: Date;
}
