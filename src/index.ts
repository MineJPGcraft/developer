import { Core, Context, Logger } from 'yumeri';
import path from 'path';
import { URL } from 'url';
import { config } from './config';
import Ejsrenderer from '@yumerijs/ejs-renderer'
Logger.setLevel('warn');

const logger = new Logger('OIDCServer');

function firstHeader(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) {
        return value[0]?.split(',')[0]?.trim();
    }
    return value ? value.split(',')[0].trim() : undefined;
}

async function main() {
    process.env.HTTP_PROXY = "http://192.168.1.131:7890";
    process.env.HTTPS_PROXY = "https://192.168.1.131:7890";
    const serverconfig = {
        port: config.server.port,
        host: config.server.host,
        staticDir: path.join(__dirname, 'static'),
        enableCors: null,
        enableWs: null,
        lang: ['zh', 'en']
    };

    const core = new Core(null, serverconfig);
    const ctx = new Context(core, 'oidc');
    ctx.renderer = new Ejsrenderer()

    core.use('proxy-normalizer', async (session, next) => {
        try {
            const issuerUrl = new URL(config.server.userIssuer);
            const req = session.client.req;

            const forwardedProto = firstHeader(req.headers['x-forwarded-proto'])
                || session.protocol
                || issuerUrl.protocol.replace(':', '')
                || 'http';
            const forwardedHost = firstHeader(req.headers['x-forwarded-host'])
                || req.headers.host
                || issuerUrl.host;
            const forwardedPort = firstHeader(req.headers['x-forwarded-port'])
                || (forwardedHost?.includes(':') ? forwardedHost.split(':')[1] : issuerUrl.port)
                || (forwardedProto === 'https' ? '443' : '80');

            session.protocol = forwardedProto;
            req.headers['x-forwarded-proto'] = forwardedProto;
            req.headers['x-forwarded-host'] = forwardedHost;
            req.headers['x-forwarded-port'] = forwardedPort;
            req.headers.host = forwardedHost;

            const externalBase = `${forwardedProto}://${forwardedHost}`;
            (session as any).__externalBase = externalBase;
        } catch (err) {
            logger.warn('Failed to normalize proxy headers:', err);
        }

        await next();
    });

    // Load plugin
    const sldModule = await import('./modules/sld');
    const oidcModule = await import('./modules/oidc');
    const staticModule = await import('./modules/static-sites');
    const sldConfig = {
        maxPerUser: config.sld.maxPerUser,
        reserved: config.sld.reserved,
        blocked: config.sld.blocked,
    };
    const sldctx = ctx.fork('sld');
    sldctx.renderer = ctx.renderer;
    const oidcctx = ctx.fork('oidc');
    oidcctx.renderer = ctx.renderer;
    const staticctx = ctx.fork('static');
    staticctx.renderer = ctx.renderer;
    core.use('static-host', staticModule.createPublicStaticMiddleware());
    core.plugin(sldModule as any, sldctx, sldConfig);
    core.plugin(oidcModule as any, oidcctx, {});
    core.plugin(staticModule as any, staticctx, {});

    // Start the server
    core.runCore();
    logger.info(`OIDC provider and Yumeri server starting on http://localhost:${config.server.port}`);
}

main().catch(err => {
    logger.error('Failed to start application:', err);
    process.exit(1);
});
