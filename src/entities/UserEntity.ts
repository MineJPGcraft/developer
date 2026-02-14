import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'users' })
export class UserEntity {
    @PrimaryColumn({ length: 128 })
    id!: string;

    @Column({ type: 'text' })
    claims!: string;

    @UpdateDateColumn({})
    updated_at!: Date;
}
