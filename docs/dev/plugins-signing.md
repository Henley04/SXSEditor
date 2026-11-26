# 插件签名与信任

> 面向插件作者与分发者。回答三个问题：**怎么签**、**用户怎么信任**、**哪些东西签名保证不了**。
>
> 相关实现：`src/shared/pluginSignature.js`（纯计算）、`src/main/plugins/PluginTrustStore.js`（信任库）、
> `src/main/plugins/PluginInstaller.js`（安装期校验）。

## 1. 签名解决的问题

`.sxsp` 是一个 zip。没有签名时，宿主只能回答"包里的文件彼此一致吗"（`checksums.json`），
不能回答"这个包是谁做的、我下载到的和作者上传的是不是同一份"。

签名把两件事连起来：

```
文件内容 --sha256--> checksums.json --Ed25519--> signature.json
```

安装器验签的顺序是**先验签、再解包**：验不过的包不会在磁盘上留下任何东西。

## 2. 生成密钥

```bash
node scripts/package-plugin.js --gen-key keys/
```

产物：

| 文件 | 权限 | 用途 |
|---|---|---|
| `keys/plugin-signing.key` | `0600` | 私钥。**不要提交到版本库、不要发给任何人** |
| `keys/plugin-signing.pub` | `0644` | 公钥。随插件一起分发，或贴在你的发布页上 |

输出的 `keyId` 形如 `ed25519-609b519f690e7f02`，后 16 位是公钥 DER 的 sha256 前缀。
**用户核对的就是这 16 位**，所以它必须出现在你的发布说明里。

只支持 Ed25519：密钥短、签名确定性、Node 内置。用 RSA 会在打包时直接报错，而不是"签了但验不过"。

## 3. 打包并签名

```bash
node scripts/package-plugin.js plugins/my-plugin \
  --key keys/plugin-signing.key \
  --publisher "Example Studio"
```

产物里会多一个 `signature.json`：

```json
{
  "format": 1,
  "algorithm": "ed25519",
  "keyId": "ed25519-609b519f690e7f02",
  "publisher": "Example Studio",
  "signedAt": "2026-11-05T04:33:55.702Z",
  "digest": "d3d3037fb487fa12…",
  "publicKey": "-----BEGIN PUBLIC KEY-----\n…",
  "signature": "base64…"
}
```

几个字段的用意：

- `publisher` 只是**展示用**。它由包里自称，不参与任何判定——所以管理器把指纹显示得比名字更显眼。
- `publicKey` 放在签名文件里，是为了让"信任这把密钥"不必再由用户去找你要 PEM。
- `digest` 是被签名的那段清单文本的 sha256，便于人眼核对与排障。

### 被签名的到底是什么

不是文件，而是由 `checksums.json` 重建的一段**规范文本**：

```
sxsp-signature-v1
<sha256>  manifest.json
<sha256>  main.js
```

规则只有三条：路径按字典序、哈希小写、每行 `hash + 两个空格 + 路径`、最后一行也带 `\n`。
任何语言都能用十行代码复现——这是"签名失效时能自己查"的前提。

`signature.json` 与 `checksums.json` 自身不参与清单（否则会递归）。

## 4. 用户如何信任

首次安装一个用新密钥签的包，安装会**被拒绝**，管理器的列表上方出现一条横幅：

```
Example Studio 签名了这个插件，但这台机器还不信任它的密钥
密钥指纹 ed25519-609b519f690e7f02 · my-plugin-1.0.0.sxsp。核对指纹无误后再信任。
                                    [ 信任并安装 ]  [ 取消 ]
```

- 系统**不会**自动信任：信任一把密钥等于放行这一类安装包。
- 用户核对指纹（对照你的发布页）后点「信任并安装」，宿主记住公钥并立刻重试这次安装。
- 也可以手动管理：管理器 →「签名与信任」页，或命令行：

```bash
sxseditor --cli plugin trust list
sxseditor --cli plugin trust add keys/plugin-signing.pub --name "Example Studio"
sxseditor --cli plugin trust remove ed25519-609b519f690e7f02
```

移除密钥**不会**卸载已装的插件：安装时的校验是历史事实。它只影响"以后还能不能装用它签的包"。

## 5. 官方内置密钥

SXSEditor 随应用内置一把署名 `SXSEditor Official` 的 Ed25519 公钥，
定义在 `src/shared/officialKeys.js`：

| 项 | 值 |
|---|---|
| keyId | `ed25519-a9e0599774865c81` |
| 发布者（展示用） | `SXSEditor Official` |
| 来源标记 | `source: "builtin"`、`official: true` |
| 私钥位置 | 仓库之外：`D:\Document\electron\SXSEditor-official-keys\plugin-signing.key`（**不提交**） |

```bash
node scripts/package-plugin.js plugins/official-project-import \
  -o dist-plugins \
  --key "D:\Document\electron\SXSEditor-official-keys\plugin-signing.key" \
  --publisher "SXSEditor Official"
```

信任库的行为：

- `PluginTrustStore.list()` 把官方密钥排在最前，管理器显示「官方内置」，没有移除按钮；
- `PluginTrustStore.addKey()` 对官方 keyId 直接返回 `official: true`，不写用户信任库；
- `PluginTrustStore.removeKey()` 拒绝移除内置密钥；
- `PluginTrustStore.keyMap()` 永远把官方公钥并进验签映射，所以官方包**默认受信任**，
  安装时直接得到 `verified`，不会出现 `unknown-key` 的信任横幅。

**内置公钥不等于"信任任意插件"。** 验签仍然要求两件事同时成立：

1. 包里 `signature.json` 的 `publicKey` 重新算出的 keyId 与它自称的 `keyId` 一致；
2. 用该公钥验签通过，且这个 keyId 在信任映射里。

因此攻击者可以照抄 `keyId` 或照抄官方公钥，但只要签名不是用官方私钥做的，
验签就会失败并落到 `invalid`；用陌生人自己的密钥签名则得到 `unknown-key`，
需要用户显式确认。这一点在 `test/pluginSignature.test.js` 里有对应用例。

**轮换**：生成新密钥后，把新公钥追加进 `src/shared/officialKeys.js` 的 `PUBLIC_KEYS`
（数组可以同时保留旧公钥，已发布的旧包仍可验证）；确认旧签名包都已重签后再删除旧项。
私钥丢失只能换钥重签，无法“找回”。

## 6. 策略：只允许已签名的包

管理器「签名与信任」页的勾选框，或：

```bash
sxseditor --cli plugin policy require   # 只允许已签名
sxseditor --cli plugin policy allow     # 默认：允许未签名，但标注
```

一条硬规则与开关无关：**签名无效的包永远拒绝**。

把"签名坏了"降级成"未签名"是最常见的错误做法——那样攻击者只要随便塞一个 `signature.json`，
就能让一个被篡改过的包落进"未签名也能装"的宽松通道。所以只有"完全没有签名"才受策略影响。

## 7. 安装器会怎么判定

| 状态 | 含义 | 能装吗 |
|---|---|---|
| `verified` | 验签通过且密钥已信任 | ✓ |
| `unsigned` | 没有 `signature.json` | 取决于策略（默认 ✓） |
| `required` | 没签名，而策略要求签名 | ✗ |
| `unknown-key` | 签名有效，但密钥不在这台机器上 | ✗（可一键信任后重试） |
| `invalid` | 内容/清单/字段与签名不符 | ✗（永远） |

`unknown-key` 与 `invalid` 的区别很重要：前者是"我不认识你"，后者是"你说的和做的不一致"。
前者可以靠一次人工确认解决，后者只能重做包。

## 8. 装完之后：按需重验

安装时会把文件清单与签名记到 `plugins-state/packages/<id>.json`。之后可以随时核对：

```bash
sxseditor --cli plugin verify my-plugin
# my-plugin: 安装目录已被改动
#   内容不同：main.js
```

管理器卡片上也有「重新校验」按钮。

**不做启动自检**，原因有两条：

1. 插件可能带几百 MB 模型，每次冷启动全量哈希会让启动明显变慢；
2. 能改这个目录的人，通常也能改信任库本身——启动自检挡不住这类攻击者，
   它真正的价值是发现"同步盘/备份还原/手工改文件"造成的漂移。

## 9. 签名保证不了什么

| 不保证 | 说明 |
|---|---|
| 插件不含恶意代码 | 签名只说明"是谁做的"，不说明"它是安全的"。权限清单与安装弹窗仍然是主要防线 |
| 发布者身份可信 | 指纹只能证明一致性，不能证明这是你以为的那个组织。首次信任时要真的核对 |
| 安装后的完整性 | 见第 8 节。装了之后有人改文件，只有主动重验才发现 |
| 密钥不被盗 | 私钥泄露后，攻击者可以用同一把密钥发布新包。届时只能靠 `trust remove` + 通告 |
| 回滚保护 | 签名包可以重放旧版本（旧版本也是合法签名的）。版本降级检测属于市场层的事 |

## 10. 面向 CI

签名可以在 CI 里做，把私钥放进 secret、写成临时文件再删：

```yaml
- run: |
    printf '%s' "$PLUGIN_SIGNING_KEY" > /tmp/signing.key
    node scripts/package-plugin.js plugins/my-plugin --key /tmp/signing.key --publisher "Example Studio"
    rm -f /tmp/signing.key
```

私钥一旦落在构建产物或日志里就等于公开了：不要 `cat` 它，不要把它写进 `env` 之外的输出。
