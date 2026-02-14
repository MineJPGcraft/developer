import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'subdomain_retention' })
export class SubdomainRetentionEntity {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ length: 128 })
    owner!: string;

    @Column({ length: 256 })
    subdomain!: string;

    @CreateDateColumn({ name: 'deleted_at' })
    deletedAt!: Date;
}
