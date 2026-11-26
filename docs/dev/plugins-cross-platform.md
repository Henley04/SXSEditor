# 插件包的跨平台约束

> 适用版本：M6 第 4 段（2026-11-05）。讲的是**一个包在哪台机器上打出来、能不能在
> 另一台上装进去**——不是 Electron 的跨平台打包。

## 1. 为什么要专门管这件事

插件包是 zip。zip 规范里条目名就是一个字符串，**没有"路径分隔符"的概念**：

- Windows 上的资源管理器、PowerShell 的 `Compress-Archive` 会把条目名写成 `lib\a.js`；
- Linux/macOS 上的 `zip` 写成 `lib/a.js`；
- 同一个包里可以同时存在 `Main.js` 和 `main.js`——在 Linux 上是两个文件，
  在 Windows 与 macOS（默认 APFS 大小写不敏感）上是同一个文件。

于是出现了最糟的一类 bug：**同一个包，在一台机器上装出 A，在另一台上装出 B，
两边都"校验通过"**。签名验的是清单里的路径与摘要，而清单是打包机生成的——
如果解包时路径含义变了，签名就失去意义。

## 2. 规则（`assertPortableNames`）

`src/shared/pluginZip.js` 在**读写两侧**都执行同一套检查：`readZip` 结束前、
`createZip` 开始后。打包时拦住，是为了让问题出现在打包机上，而不是等用户
在 Windows 上装到一半。

| 规则 | 拒绝的东西 | 不拒绝的后果 |
|---|---|---|
| 分隔符归一 | `a\b.js` → `a/b.js` | 反斜杠在 POSIX 上是一个普通字符，会建出名叫 `lib\a.js` 的文件 |
| 大小写唯一 | `Main.js` + `main.js` | NTFS/APFS 上后者覆盖前者：内容与清单不符，却仍能"装成功" |
| Windows 保留名 | `con`、`nul.json`、`com1`、`lpt9.txt` | 写入的是设备而不是文件，解包失败或静默写空 |
| 非法字符 | `< > : " \| ? *` | NTFS 直接失败；`:` 还会被当成备用数据流 |
| 尾部空格/点 | `a.`、`dir /b.js` | Windows 会静默去掉尾部字符，路径与清单不再一致 |
| 长度上限 180 | 深层嵌套 | Windows `MAX_PATH` 是 260，安装目录已吃掉 60+ |
| 绝对路径 / 盘符 / `..` | `/etc/passwd`、`C:\x`、`../x` | 目录穿越（这条早就有，跟平台无关） |

长度取 180 而不是 260：用户目录名长度不可控，`C:\Users\<很长的名字>\AppData\…`
本身就可能超过 100 字符。留余量比卡在边界上更实际。

## 3. 换行符：两条互不干扰的规则

| 场景 | 规则 | 原因 |
|---|---|---|
| 文件内容（`.js` / `.css` / `.md`） | **按字节参与 sha256，不做任何归一化** | 归一化就意味着"改了文件但摘要不变"，签名会失效 |
| 签名规范文本 | **永远是 `\n`** | 否则 Windows 上生成的签名在 Linux 上验不过 |

第二条在 `pluginSignature.canonicalList` 里是硬编码的 `\n`，不读 `os.EOL`。
`test/pluginPortability.test.js` 会断言产物里没有 `\r`。

由此推出的实践：**仓库里的 `.gitattributes` 不要对 `plugins/**` 做换行转换**。
作者在 Windows 上 `core.autocrlf=true` 克隆，改一个字符再打包，摘要就会变——
这不是 bug，是"内容真的变了"。

## 4. CI 矩阵

`.github/workflows/ci.yml` 的 `plugin-cross-platform` 作业在
**ubuntu / windows / macos** 上跑同一组用例：

```
pluginCore / pluginSignature / pluginMarket / pluginPortability
pluginLifecycle / pluginServices / pluginLongTasks / themeContrast
+ npm run audit:contrast + npm run lint:ipc
+ 打包两个示例插件（顺带跑一遍便携性检查）
```

它不构建 Electron、不装原生 ORT 桥（那是 Windows 专属的 `test` 作业），
所以三份加起来两分钟出头。**这份矩阵补的是"同一份代码在两类文件系统上都成立"**，
单平台测试永远覆盖不到。

## 5. 边界（写在明处）

- **只在 Linux 上真机跑过**：本文的验证环境是 Linux 容器，Windows/macOS 的结论来自
  CI 矩阵定义与规则推导，**没有在这两台机器上实际执行过**。第一次跑矩阵时如果红了，
  先看是不是 `npm ci --ignore-scripts` 让某个用例缺依赖。
- **只覆盖"文件层"**：解包、签名、索引、主题。插件运行时（utilityProcess）、
  菜单、面板这些走 Electron 的部分不在这个矩阵里。
- **不处理 Unicode 归一化**：`é` 的两种编码（NFC/NFD）在 macOS 上是同一个文件名，
  在 Linux 上是两个。这条比大小写更冷门，暂未拦——如果真出问题，应该在
  `assertPortableNames` 里加一条 NFD/NFC 比较。
- **长度上限是经验值**：180 能覆盖绝大多数安装路径，但不是"保证不超 MAX_PATH"的证明。
