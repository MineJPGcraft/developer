import { config } from '../config';
import { layout } from './layout';

const UI = config.ui;

export function renderConsent(clientName: string, scopes: string[], uid: string) {
    const badges = scopes.filter(Boolean).map(scope => scope.trim()).filter(Boolean);
    const scopeBadges = (badges.length ? badges : ['openid']).map(scope => `
        <div class="scope-item">
            <div class="scope-icon">🔐</div>
            <div class="scope-info">
                <div class="scope-name">${scope}</div>
                <div class="scope-desc">允许应用访问对应的 ${scope} 信息。</div>
            </div>
        </div>
    `).join('');
    return layout(UI.consent.heading, `
        <section class="card">
            <h2 class="section-title">${UI.consent.heading}</h2>
            <p class="section-subtitle">应用 <strong>${clientName}</strong> 请求访问以下权限：</p>
            <div class="scope-list">${scopeBadges}</div>
            <div class="actions">
                <form action="/interaction/${uid}/confirm" method="post">
                    <button type="submit" class="btn btn-primary">${UI.consent.approveButton}</button>
                </form>
                <form action="/interaction/${uid}/abort" method="post">
                    <button type="submit" class="btn btn-secondary">${UI.consent.denyButton}</button>
                </form>
            </div>
        </section>
    `);
}
