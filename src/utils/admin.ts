import type { Session } from 'yumeri';
import { config } from '../config';
import { requireDevAccount, type DevAccountDetails } from './dev-account';

export function isAdmin(accountId: string): boolean {
    const admins = config.admin?.ids || [];
    return admins.includes(accountId);
}

export async function requireAdmin(session: Session): Promise<DevAccountDetails> {
    const details = await requireDevAccount(session);
    if (!isAdmin(details.accountId)) {
        throw new Error('无管理员权限');
    }
    return details;
}
