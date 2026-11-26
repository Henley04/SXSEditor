# 插件市场接口（M6）

> 这一页写给两类人：想自建插件索引的团队，以及之后要把市场页接进插件管理器的人。
> 它描述的是**已经能跑的接口**，不是一个规划中的服务。本项目没有运营中的市场。

## 1. 做了什么、没做什么

| 已落地 | 说明 |
|---|---|
| 索引格式与校验 | `sxs-plugin-index-v1`，纯 JSON，可静态托管在任何 HTTPS 位置 |
| 源管理 | 增/删/列；`https://` 必选，`file://` 需显式开关 |
| 搜索 | 取一次索引后在本地过滤（多词 AND），不逐键发请求 |
| 下载与校验 | 按索引的 `sha256` + `size` 核对；不符直接拒 |
| 下载前预览 | 权限、文件清单、体积、包内**真实**签名、是否可装、降级提示 |
| 安装 | 预览通过后走与「安装本地 .sxsp」完全相同的路径 |
| CLI | `plugin market sources/add/remove/search/preview/install/clear` |
| IPC | 6 条通道，仅插件管理器窗口可用（preload `pluginHost.market*`） |

**没做**：市场后端、评分/下载量、自动更新、增量下载、付费/许可、镜像测速。
插件管理器里也**还没有**市场页 —— M6 这一段只把接口和链路打通。

## 2. 索引格式

```json
{
  "schema": "sxs-plugin-index-v1",
  "name": "Example Plugins",
  "updatedAt": "2026-11-05T00:00:00.000Z",
  "plugins": [
    {
      "id": "example-clock",
      "name": "Example Clock",
      "version": "1.0.0",
      "apiVersion": 2,
      "description": "时钟与倒计时",
      "author": "Example Studio",
      "keywords": ["clock", "timer"],
      "permissionGroups": ["ui", "automation"],
      "file": {
        "url": "example-clock-1.0.0.sxsp",
        "sha256": "6aae24c8…",
        "size": 3216
      },
      "signature": {
        "keyId": "ed25519-13e30833ee4d5500",
        "publisher": "Example Studio",
        "signedAt": "2026-11-05"
      }
    }
  ]
}
```

规则：

- `file.url` 只能是 `https://` 或相对索引地址的路径；相对路径解析后必须仍在同一源、同一目录下。
- `file.sha256` / `file.size` **必填**。没有摘要就无法发现"下载到的东西被换了"。
- `signature` 是**源的自述**，只用于列表页展示。安装判定只认包内 `signature.json`；
  两者不一致会产生 `INDEX_SIGNATURE_MISMATCH` 警告。
- 单个条目坏了只跳过它，整份索引仍然可用；`id` 重复时保留第一条并记 warning。

## 3. 源

```bash
# 加一个源（会立即拉一次索引验证可用性）
sxseditor --cli plugin market add https://plugins.example.com/index.json --name "公司内部"

sxseditor --cli plugin market sources
sxseditor --cli plugin market remove src-358ebd54f0
```

只接受 HTTPS：索引决定"用户能看到哪些插件"，它值得一张证书。

离线/内网镜像可以用 `file://`，但必须显式打开：

```bash
SXSEDITOR_ALLOW_FILE_SOURCES=1 sxseditor --cli plugin market add file:///srv/plugins/index.json
```

默认关闭的原因是：`file://` 源可以由本机任意进程改写，把它当成常规能力会让
"市场里的包"和"磁盘上的包"变成同一件事。

## 4. 搜索与预览

```bash
sxseditor --cli plugin market search clock
sxseditor --cli plugin market preview example-clock
```

预览输出（真实走查结果）：

```
Example: Clock Service 1.0.0（example-clock）
  来源：本地走查源
  签名：已签名且密钥已信任  keyId ed25519-13e30833ee4d5500
  发布者（包自称）：Example Studio
  权限：services(provide), ui(menu), automation(expose)
  文件：2 个，共 4.1 KiB
可安装。
```

未信任的密钥：

```
[拒绝] 签名用的密钥 ed25519-13e30833ee4d5500 不在信任列表里
  若确认这是作者的密钥，先运行：plugin trust add <公钥.pem> --name "Example Studio"
  密钥指纹：ed25519-13e30833ee4d5500
```

### 为什么预览一定要下载整包

索引是一份纯文本，谁都能改。若"已签名"的判断来自索引字段，攻击者只要改
`signature.keyId` 就能让列表显示成任何一位作者。所以预览会：

1. 下载到 `plugins-state/market/`（按 `<id>-<version>.sxsp` 命名）；
2. 核对 `sha256` 与 `size`；
3. 用 **包里的** `signature.json` + 本地信任库验签（与安装同一条代码路径）；
4. 把索引自述与实包结果并排返回，不一致就警告。

预览本身不写插件目录，也不写安装审计。

## 5. 安装

```bash
# 不带 --yes 只打印一遍预览
sxseditor --cli plugin market install example-clock

# 确认后
sxseditor --cli plugin market install example-clock --yes
```

安装走 `PluginInstaller.installFromPackage`：解包到 staging、双向清单校验、验签、
原子替换、写包记录、重载。装完 `plugin list` 的 `sign:` 列会显示 `verified`。

管理器里的 `marketInstall` 走同一个 service 方法，只是把"确认"交给 UI。

## 6. 版本与降级

`versionRelation(entry, installed)` 给出 `new / upgrade / same / downgrade / unknown`。
降级会进 `warnings`（`code: "DOWNGRADE"`），但**默认不阻断**：这是市场层的提示，
不是签名层的判定。签名只说明"谁做的"，不说明"比你现在的新"。

## 7. 边界

- **源可以骗展示，骗不了安装**：源能决定列表文案、图标、甚至自称的签名者；
  装不装由包内签名与信任库决定。
- **没有撤销列表**：包被作者撤回后，索引删掉条目即可，但已经下载到本地的副本仍然能装
  （它是合法签名的）。真正的撤销需要时间戳/透明日志，不在这一版。
- **不做自动更新**：宿主不会后台轮询；每一次下载都由用户动作触发。
- **缓存 5 分钟**：同一进程内索引缓存 5 分钟，`--force` 或 `plugin market clear` 可绕过。
- **单源失败不影响其它源**：搜索会带回 `errors[]`，UI 应当显示"某个源不可用"而不是整页空白。
