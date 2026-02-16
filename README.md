
# MCJPG Developer

## 配置文件（config.yaml）

应用读取配置文件路径：

- 默认：`./config.yaml`
- 可通过环境变量覆盖：`CONFIG_PATH=/data/config.yaml`

建议将配置文件挂载到 `/data/config.yaml`（容器内路径），便于部署与持久化。

### 完整示例

```yaml
server:
  port: 8081
  host: 0.0.0.0
  issuer: https://developer.mcjpg.org
  userIssuer: https://login.mcjpg.org
  devIssuer: https://developer.mcjpg.org
  # 可选：当反向代理传入的 Host 与 issuer 不一致时，用这些白名单匹配
  # userHosts:
  #   - login.mcjpg.org
  # devHosts:
  #   - developer.mcjpg.org

admin:
  ids:
    - "your-admin-sub"

ui:
  siteTitle: MCJPG 开发者中心
  home:
    heading: MCJPG 开发者中心
    description: 一站式管理 OIDC 客户端与三级域名
    loginButton: 进入开发者仪表盘
  overview:
    heading: 开发者总览
    description: 查看平台公告与常用入口。
  dashboard:
    heading: 客户端管理
    description: 在这里创建新的应用并管理回调地址
    createForm:
      clientNameLabel: 客户端名称
      redirectUrisLabel: 回调地址（每行一个）
      submitButton: 创建客户端
  consent:
    heading: 授权请求
    approveButton: 同意
    denyButton: 拒绝
  sld:
    heading: MCJPG 三级域名
    description: 快速申请和管理属于你的 mcjpg.org 三级域名
  announcements:
    - id: release-2024-01
      title: 新版二级域名模块上线
      summary: 现在支持自定义子域名数量限制与保留名单，请前往控制台查看详情。
      link: https://developer.mcjpg.org/docs/release-notes
      publishedAt: 2024-05-31T08:00:00+08:00
  navigation:
    总览: /dashboard
    OIDC 客户端: /dashboard/oidc
    三级域名管理: /dashboard/subdomains

upstreamOidc:
  clientId: your-upstream-client-id
  clientSecret: your-upstream-client-secret
  authorizationEndpoint: https://sso.example.org/login/oauth/authorize
  tokenEndpoint: https://sso.example.org/api/login/oauth/access_token

devPortalOidc:
  issuer: https://sso.example.org
  clientId: your-dev-portal-client-id
  clientSecret: your-dev-portal-client-secret
  authorizationEndpoint: https://sso.example.org/oauth/authorize
  tokenEndpoint: https://sso.example.org/oauth/token
  jwksUri: https://sso.example.org/.well-known/jwks
  scope: openid profile email
  tokenEndpointAuthMethod: client_secret_basic

database:
  type: postgres
  host: 127.0.0.1
  port: 5432
  username: developer
  password: your-password
  database: developer
  ssl: false

devPortal:
  cookieSecret: replace-with-secret
  cookieName: dev_session

cloudflare:
  defaultDomain: mcjpg.org
  domains:
    - rootDomain: mcjpg.org
      zoneId: "zone-id-1"
      apiToken: "token-1"
      defaultRecordType: CNAME
      proxied: false
    - rootDomain: minecraft.mobi
      zoneId: "zone-id-2"
      apiToken: "token-2"

sld:
  maxPerUser: 5
  reserved:
    - www
    - mail
    - api
  blocked:
    - admin
    - root
    - system

certificates:
  storageDir: ./certificates
  acmeServer: https://dv.acme-v02.api.pki.goog/directory
  dnsProvider: cloudflare
  propagationSeconds: 180
```

### 关键说明

- `admin.ids`: 管理员用户的 `sub` 列表，用于访问 `/admin` 管理面板。
- `devPortalOidc`: 开发者门户登录的上游 OIDC 配置。
- `server.userIssuer` / `server.devIssuer`: 分别用于“标准用户登录域名”和“开发者仪表盘域名”，两者可不同；服务会强制按域名分流路由。
- `server.userHosts` / `server.devHosts`: 可选域名白名单；不配置时会从对应 issuer 自动推导。
- `cloudflare.domains`: 可选二级域名列表，每个域名可以使用独立的 Cloudflare Token。
- `cloudflare.defaultDomain`: 默认选中的二级域名。
- `sld.reserved`: 保留前缀（不可注册）。
- `sld.blocked`: 黑名单前缀（不可注册）。

### 回调地址说明

- 开发者仪表盘登录回调：`${server.devIssuer}/dashboard/callback`
- 普通 OIDC 登录交互回调：`${server.userIssuer}/interaction/callback`
