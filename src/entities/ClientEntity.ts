import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'clients' })
export class ClientEntity {
    @PrimaryColumn({ length: 128 })
    client_id!: string;

    @Column({ length: 256 })
    client_secret!: string;

    @Column({ length: 256 })
    client_name!: string;

    @Column({ name: 'redirect_uris', type: 'text' })
    redirect_uris_raw!: string;

    @Column({ name: 'grant_types', type: 'text' })
    grant_types_raw!: string;

    @Column({ name: 'response_types', type: 'text' })
    response_types_raw!: string;

    @Column({ length: 128 })
    token_endpoint_auth_method!: string;

    @Column({ length: 128 })
    owner!: string;

    @CreateDateColumn({})
    created_at!: Date;

    @UpdateDateColumn({})
    updated_at!: Date;
}
