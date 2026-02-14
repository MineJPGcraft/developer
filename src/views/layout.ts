import { config } from '../config';

const UI = config.ui;

export function layout(pageTitle: string, body: string) {
    const title = `${UI.siteTitle}｜${pageTitle}`;
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/yumeri-ui@latest/dist/yumeri-ui.css">
    <style>
        body { background: #f4f6fb; color: #1f2933; }
        .app-shell { min-height: 100vh; display: flex; flex-direction: column; }
        header { background: #111827; color: #f9fafb; }
        header .brand { font-weight: 600; font-size: 1.1rem; }
        main { flex: 1; padding: 3rem 1rem; }
        .yui-container { max-width: 960px; margin: 0 auto; }
        footer { padding: 1.5rem 0; text-align: center; color: #64748b; font-size: 0.85rem; }
        .card { background: #fff; border-radius: 16px; padding: 2.5rem; box-shadow: 0 20px 40px rgba(15, 23, 42, 0.1); }
        .actions { display: flex; gap: 1rem; margin-top: 2rem; }
        .actions form { flex: 1; display: inline-flex; }
        .actions button { width: 100%; }
        .section-title { font-size: 1.6rem; margin-bottom: 0.5rem; font-weight: 600; }
        .section-subtitle { margin-bottom: 2rem; color: #475569; }
        label { display: block; font-weight: 500; margin-bottom: 0.5rem; }
        .input { width: 100%; }
        textarea.input { min-height: 120px; resize: vertical; }
        .badge { display: inline-flex; align-items: center; padding: 0.25rem 0.75rem; border-radius: 999px; background: #eff6ff; color: #1d4ed8; font-size: 0.9rem; margin-right: 0.5rem; margin-top: 0.5rem; }
        .credential { background: #0f172a; color: #e2e8f0; padding: 1rem; border-radius: 12px; font-family: 'Fira Code', monospace; word-break: break-all; }
        .scope-list { display: grid; gap: 1rem; margin: 2rem 0; }
        .scope-item { display: flex; gap: 1rem; align-items: flex-start; padding: 1rem 1.25rem; border-radius: 14px; background: #f8fafc; border: 1px solid #e2e8f0; }
        .scope-icon { font-size: 1.5rem; }
        .scope-info { display: flex; flex-direction: column; }
        .scope-name { font-weight: 600; color: #1f2933; }
        .scope-desc { color: #475569; font-size: 0.95rem; margin-top: 0.3rem; }
        .hero { text-align: center; }
        .hero h1 { font-size: 2.4rem; margin-bottom: 0.75rem; }
        .hero p { color: #475569; font-size: 1.1rem; margin-bottom: 2rem; }
        .hero a { display: inline-flex; align-items: center; justify-content: center; padding: 0.85rem 1.8rem; border-radius: 999px; background: linear-gradient(135deg, #2563eb, #6366f1); color: #fff; font-weight: 600; text-decoration: none; box-shadow: 0 15px 30px rgba(99, 102, 241, 0.3); }
        .hero a:hover { transform: translateY(-2px); }
        table { width: 100%; border-collapse: collapse; margin-top: 2rem; }
        th, td { padding: 0.75rem 1rem; border-bottom: 1px solid #e2e8f0; text-align: left; }
        th { color: #475569; font-weight: 600; }
        .table-actions { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center; }
        .inline-form { display: inline-flex; gap: 0.75rem; align-items: flex-start; flex-wrap: wrap; }
        .muted { color: #64748b; font-size: 0.9rem; }
        @media (max-width: 640px) {
            .card { padding: 1.75rem; }
            .actions { flex-direction: column; }
            .table-actions { flex-direction: column; align-items: stretch; }
            .inline-form { width: 100%; }
        }
    </style>
</head>
<body>
    <div class="app-shell">
        <header>
            <div class="yui-container" style="display:flex; align-items:center; justify-content:space-between; padding:1rem 0;">
                <span class="brand">${UI.siteTitle}</span>
                <a href="/" style="color:#e2e8f0; text-decoration:none; font-size:0.95rem;">${UI.home.heading}</a>
            </div>
        </header>
        <main>
            <div class="yui-container">
                ${body}
            </div>
        </main>
        <footer>
            ${UI.siteTitle} · Powered by Yumeri
        </footer>
    </div>
</body>
</html>
`;
}
