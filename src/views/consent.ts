import { config } from '../config';
import { layout } from './layout';

const UI = config.ui;

export function renderConsent(clientName: string, scopes: string[], uid: string) {
    const badges = scopes.filter(Boolean).map(scope => scope.trim()).filter(Boolean);
    const toLabel = (scope: string) => {
        switch (scope) {
            case 'openid':
                return '基础身份';
            case 'profile':
                return '个人资料';
            case 'email':
                return '邮箱信息';
            case 'phone':
                return '手机号信息';
            case 'address':
                return '地址信息';
            case 'offline_access':
                return '离线访问（刷新令牌）';
            default:
                return scope;
        }
    };
    const toDesc = (scope: string) => {
        switch (scope) {
            case 'openid':
                return '允许应用识别你的身份（sub）。';
            case 'profile':
                return '允许应用读取你的公开资料。';
            case 'email':
                return '允许应用读取你的邮箱地址与验证状态。';
            case 'phone':
                return '允许应用读取你的手机号与验证状态。';
            case 'address':
                return '允许应用读取你的地址信息。';
            case 'offline_access':
                return '允许应用在你离线时继续访问。';
            default:
                return `允许应用访问 ${scope} 范围的数据。`;
        }
    };
    const scopeBadges = (badges.length ? badges : ['openid']).map(scope => `
        <div class="scope-item">
            <div class="scope-icon">🔐</div>
            <div class="scope-info">
                <div class="scope-name">${toLabel(scope)}</div>
                <div class="scope-desc">${toDesc(scope)}</div>
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
