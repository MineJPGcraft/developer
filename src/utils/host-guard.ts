import type { Session } from 'yumeri';

function normalizeHost(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return value.split(',')[0]?.trim().toLowerCase() || undefined;
}

function stripPort(host: string): string {
    return host.split(':')[0];
}

export function getRequestHost(session: Session): string | undefined {
    const headers = session.client.req.headers || {};
    return normalizeHost(String(headers['x-forwarded-host'] || headers.host || ''));
}

export function isAllowedHost(session: Session, allowedHosts: string[]): boolean {
    const requestHost = getRequestHost(session);
    if (!requestHost) return false;
    const requestBare = stripPort(requestHost);
    for (const host of allowedHosts) {
        const normalized = normalizeHost(host);
        if (!normalized) continue;
        if (requestHost === normalized) return true;
        if (requestBare === stripPort(normalized)) return true;
    }
    return false;
}

export function enforceHost(session: Session, allowedHosts: string[]): void {
    if (!isAllowedHost(session, allowedHosts)) {
        session.status = 404;
        session.body = 'Not Found';
        return;
    }
}
