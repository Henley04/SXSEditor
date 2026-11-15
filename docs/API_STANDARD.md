# SXSEditor 推理 API 标准（API Standard）

**版本 1.0 · 适用于 SXSEditor 2.x「推理系统 = API」及其兼容服务**

本文是 **公开的接入标准**：任何按本规范实现 HTTP 服务的后端，都可以直接在
SXSEditor 的「设置 → 推理与硬件 → API」中作为一个 API Provider 使用；任何第三方
客户端也可以按本规范调用 SXSEditor 内置的免费服务或自建服务。

规范同时定义了**客户端必须遵守的错误呈现要求**——速率限制与鉴权错误不得静默失败。

---

## 1. 术语与范围

| 术语 | 含义 |
|---|---|
| **Base URL** | API 服务根地址，例如 `https://your-api.example.com`。不带尾斜杠、不带查询串、不带片段。 |
| **Provider** | 客户端里保存的一组 `{名称, Base URL, 密钥}`。密钥可选。 |
| **Key / Token** | 用于 `Authorization: Bearer <key>` 的凭据。免鉴权服务可留空。 |
| **合成请求** | `POST {Base URL}/v1/synthesize`，把一组音符合成为一段单声道音频。 |

本规范只约束 HTTP 接口，不约束内部推理实现（ONNX / TensorRT / 自研模型均可）。
SXSEditor 客户端本身不下载、不加载本地模型，所有计算都在服务端完成。

---

## 2. 认证

客户端对每个请求发送：

```http
Authorization: Bearer <key>
Content-Type: application/json
Accept: audio/wav, application/json
```

- **密钥可选**：Provider 未配置密钥时不发送 `Authorization` 头。
- 兼容服务也可接受 `X-Api-Key: <key>`（参考实现同时支持两种）。
- 服务端若要求鉴权而未提供或凭据无效，必须返回 **401**（或 **403**），
  并在响应体中给出可读原因。
- 密钥属于敏感信息。客户端实现应当把它加密存放在系统密钥环中，
  **不得**写入普通设置文件、日志或随工程文件同步；界面只显示「已设置」，不回显明文。

> **Free API By SXSEditor**：客户端内置一个指向 ModelScope 创空间**公开访问域名**
> 的免费服务，**完全免鉴权**——无需任何密钥或 SDK Token，开箱即用。Provider 的
> 「密钥」字段对该服务禁用，客户端也不会发送 `Authorization` 头。免费不等于无限：
> 仍按 IP 限流，见第 7 节。
>
> 说明：ModelScope 另有一个 `*.api-inference.modelscope.net` 的 API 专用网关，
> 它会强制校验调用者自己的 SDK Token（无令牌返回 401）。内置免费服务**不使用**
> 该网关，而使用创空间的公开域名 `*.ms.show`；平台按 `User-Agent` 区分页面访问
> 与程序调用，因此客户端统一带常规浏览器 UA。若把内置服务地址改成专用网关或其他
> 需要鉴权的自建服务，则按上表正常填写密钥。

---

## 3. 端点

| 方法 | 路径 | 是否计入配额 | 说明 |
|---|---|---|---|
| `POST` | `/v1/synthesize` | 是 | 合成推理，返回 WAV 二进制或 JSON |
| `GET` | `/health` | 否 | 健康检查、模型/版本状态；可用 `?strict=1` 要求模型就绪（否则 503） |
| `GET` | `/v1/usage` | 否 | 查询当前 IP 的配额使用情况 |
| `GET` | `/` | 否 | 服务自描述（版本、模型、限流、端点清单、示例） |
| `GET` | `/admin/logs` | 否 | 管理端点，需 `X-Admin-Token`（可选实现） |
| `POST` | `/admin/rate-limit/reset` | 否 | 管理端点，需 `X-Admin-Token`（可选实现） |

`GET /health` 是客户端「测试连接」按钮使用的端点。任何非 2xx 响应都必须把原因
显示给用户（见第 8 节）。

参考实现（v1.3.0 / v3 权重）的 `/health` 返回示例：

```json
{
  "status": "ok",
  "model_status": "ready",
  "model_dir": "/app/models/int8",
  "model_revision": "syxppp/SoulX-Singer-onnx-directml-int8@v3@int8",
  "model_revision_stamp": "syxppp/SoulX-Singer-onnx-directml-int8@v3@int8",
  "model_revision_match": true,
  "model_progress": {
    "status": "ready", "percent": 100, "missing_count": 0,
    "downloaded_mb": 881, "total_mb": 881
  },
  "pipeline": {
    "initialized": true,
    "eps": { "noteTextEncoder": "cpu", "diffStep": "cpu", "vocoder": "cpu" }
  },
  "uptime_seconds": 40,
  "requests": 6,
  "syntheses": 0,
  "rate_limit": { "tracked_ips": 0, "total_blocked": 0 }
}
```

---

## 4. `POST /v1/synthesize`

### 4.1 请求体（JSON）

顶层对象**只允许**下列字段（参考实现 `additionalProperties: false`；多传未知字段返回 400）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `notes` | array（必填，1–256 项） | — | 音符序列，见 4.2 |
| `bpm` | number 20–300 | `120` | 速度；`start` / `duration` 单位为拍（beat） |
| `n_steps` | integer 1–32 | `16` | 扩散采样步数。越大质量越好、耗时越长（32 步约为 8 步的 3–4 倍） |
| `seed` | integer | 随机 | 噪声种子，固定后可复现 |
| `cfg` | number 0–10 | `3` | CFG 强度 |
| `cfg_rescale` | number 0–1 | `0.75` | CFG rescale |
| `sampler` | `euler` \| `heun` \| `extrap` \| `stork2` | `euler` | 采样器 |
| `cfg_schedule` | object | — | `{mode, start, end, keyframes}` CFG 调度 |
| `dynamic_threshold` | object | — | `{enabled, percentile}` 动态阈值 |
| `pitch_control` | `manual` \| `score` | `manual` | **`score` 不提供 F0 条件，音高由 note_pitch 决定，F0 曲线由模型生成**（通常更自然）；`manual` 只提供 F0 条件 |
| `pitch_shift` | number −24…24 | `0` | 手动变调（半音） |
| `auto_shift` | boolean | `false` | 依据参考音频 F0 中位数自动匹配音域 |
| `f0_envelope` | object | — | `{keyframes:[{time,value}]}`，`time` 单位拍、`value` 单位半音 |
| `pitch_curve_f0` | number[] | — | 显式 F0 曲线（Hz 或归一化值） |
| `reference_wav_base64` | string | — | 参考音频 WAV 的 Base64，用于音色克隆 |
| `ref_singer_data` | object | — | 歌手元数据 |
| `ref_midi_notes` | array | — | 参考 MIDI 音符 |
| `ref_f0_data` | array | — | 参考 F0 数据 |
| `ref_note_pitches` | array | — | 参考音高序列 |
| `max_prompt_frames` | integer 0–4000 | — | 参考音频最大提示帧数 |
| `singer_id` | string ≤128 | — | 歌手标识；参与缓存键、不参与推理 |
| `mel_postprocess` | object | — | 频谱后处理参数 |
| `response_format` | `wav` \| `json` | `wav` | 返回二进制 WAV 或 JSON（含 `audio_base64`） |

### 4.2 `notes[]` 元素

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pitch` | integer 0–127 | 是 | MIDI 音高；`0` 表示休止 |
| `start` | number ≥0 | 是 | 起始位置（拍） |
| `duration` | number >0 | 是 | 时值（拍） |
| `lyric` | string ≤128 | 否 | 歌词。中文可直接写汉字（整句 G2P 自动转写），也可写音素如 `zh_a1` |
| `note_type` / `type` / `noteType` | integer 0–8 | 否 | 音符类型；三种写法等价 |
| `is_slur` / `isSlur` | boolean | 否 | 连音 |
| `is_continuation` / `isContinuation` | boolean | 否 | 延音 |
| `phoneme_adjustments` / `phonemeAdjustments` | array | 否 | 音素级微调 |

> 中文歌词建议直接用汉字并让服务端做整句 G2P；GTSinger 等数据集的
> `l_zh` 后缀音素与 SXSEditor 的 `zh_*` 词表不兼容，需先转成汉字。

最小示例：

```json
{
  "bpm": 120,
  "n_steps": 32,
  "pitch_control": "score",
  "notes": [
    { "pitch": 60, "start": 0, "duration": 1, "lyric": "我" },
    { "pitch": 62, "start": 1, "duration": 1, "lyric": "没" },
    { "pitch": 64, "start": 2, "duration": 2, "lyric": "有" }
  ]
}
```

### 4.3 成功响应

**`response_format = wav`（默认）**：HTTP `200`，`Content-Type: audio/wav`，
body 为 WAV 二进制。

| 要求 | 值 |
|---|---|
| 容器 | RIFF / WAVE |
| 编码 | IEEE float 32-bit（`format=3`）**或** PCM 16/32-bit（`format=1`），小端 |
| 采样率 | **24000 Hz**（与客户端 `SAMPLE_RATE` 一致；其它采样率客户端会线性重采样） |
| 声道 | 单声道（多声道客户端会下混） |
| 建议响应头 | `X-Inference-Ms`、`X-Audio-Duration-Sec`、`X-Request-Id`、`X-RateLimit-*` |

**`response_format = json`**：HTTP `200`，body：

```json
{
  "request_id": "...",
  "client_ip": "...",
  "sample_rate": 24000,
  "duration_seconds": 3.0,
  "inference_ms": 19807,
  "format": "wav",
  "audio_base64": "UklGR..."
}
```

客户端两种都支持；`audio_base64` 内容仍须是可解析的 WAV。

---

## 5. 错误响应

所有错误都返回统一结构（HTTP 状态码 + JSON body）：

```json
{ "error": "rate_limit_exceeded", "message": "每分钟推理次数已达上限（20 次/分钟），请稍后重试", "request_id": "..." }
```

`error` 为**字符串错误码**，`message` 为可直接展示给人看的说明。部分客户端也兼容
`{"error":{"code":...,"message":...}}` 嵌套形式。

| HTTP | `error` | 含义 | 客户端应如何处理 |
|---|---|---|---|
| 400 | `invalid_request_body` / `bad_request` | 请求体校验失败、未知字段、参数越界 | **显示**具体字段原因 |
| 401 | `invalid_api_key` | 缺少或无效的密钥 | **明确提示检查密钥**；若用内置免费服务则提示检查是否被改成需鉴权的地址 |
| 403 | `ip_denied` / `ip_not_allowed` / `admin_forbidden` | IP 黑白名单或管理权限拒绝 | **显示**原因 |
| 404 | `not_found` | 未知端点 | 检查 Base URL 是否多写了路径 |
| 429 | `rate_limit_exceeded` | 触发每分钟 / 每日限流 | **显示**限流范围与重试时间，见下 |
| 429 | `queue_full` | 推理队列已满 | **显示**，稍后重试 |
| 503 | `service_unavailable` | 模型尚未就绪 / 正在下载 | **显示**进度，稍后重试 |
| 500 | `synthesis_failed` / `internal_error` | 推理内部错误 | **显示**，`request_id` 用于排查 |

429 响应额外字段与响应头：

```json
{
  "error": "rate_limit_exceeded",
  "message": "每分钟推理次数已达上限（20 次/分钟），请稍后重试",
  "scope": "minute",
  "limit": { "per_minute": 20, "per_day": 500 },
  "usage": { "minute_used": 20, "minute_remaining": 0, "day_used": 37 },
  "retry_after_seconds": 42,
  "request_id": "..."
}
```

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
X-RateLimit-Minute-Limit: 20
X-RateLimit-Minute-Remaining: 0
X-RateLimit-Day-Limit: 500
X-RateLimit-Day-Remaining: 463
```

客户端应优先用 `Retry-After` 响应头，回退到 `retry_after_seconds` 字段。

---

## 6. 客户端错误处理要求（规范性）

> 这一节是**标准的一部分**，不是建议。

1. **禁止静默失败**：任何非 2xx、网络错误、超时、非 WAV 响应都必须把原因呈现给用户
   （弹窗 / 状态区），不得只写日志、不得返回空音频、不得静默回退到本地推理。
2. **后台自动推理同样适用**：分片编辑器的后台自动推理默认不打扰用户，但
   鉴权 / 限流 / 网络类错误必须显式弹出，否则用户只会看到「没有声音」。
3. **错误要可操作**：401/403 提示检查密钥；429 提示限流范围与重试等待；
   5xx 附带服务端 `message` 与 `request_id`。
4. **密钥不明文回显**：界面只显示「已设置」，修改时留空表示保持不变。
5. **超时可取消**：长时间请求必须能被用户「停止」操作中止（AbortController）。
6. **连接测试**：Provider 管理界面应提供「测试连接」（`GET /health`），并把结果
   （含错误原因）显示在界面上。

SXSEditor 客户端的错误消息统一带 `[API ...]` 前缀（如 `[API 429]`、
`[API 401/403]`、`[API 网络]`），语言无关，便于自动化识别与排查。

---

## 7. 限流与配额

参考实现按 **客户端 IP** 做滑动窗口双限流：

| 窗口 | 上限 | 作用域 |
|---|---|---|
| 每分钟 | 20 次 | 仅 `POST /v1/synthesize` 计入 |
| 每 24 小时 | 500 次 | 同上 |

- `/health`、`/v1/usage`、`/` 与管理端点**不**计入配额。
- 部署在反向代理 / ModelScope 创空间后需开启 `TRUST_PROXY=1`，否则所有请求会被
  视为同一 IP。
- 服务端可通过 `IP_ALLOWLIST` / `IP_DENYLIST` / `API_KEYS` / `ADMIN_TOKEN` 配置。
- **免费共享服务可能被多用户共享同一出口 IP**，因此 429 更常见；客户端应显示
  `Retry-After` 而不是立即重试。

`GET /v1/usage` 返回：

```json
{
  "client_ip": "...",
  "limits": { "per_minute": 20, "per_day": 500 },
  "usage": {
    "minute_used": 1, "minute_limit": 20, "minute_remaining": 19,
    "day_used": 1, "day_limit": 500, "day_remaining": 499
  },
  "note": "仅 /v1/synthesize 计入推理配额；此接口与 /health 不计入"
}
```

---

## 8. 内置免费服务

| 项 | 值 |
|---|---|
| 名称 | **Free API By SXSEditor** |
| Base URL | `https://syxppp-soulx-singer-free.ms.show` |
| 承载 | ModelScope 创空间（Docker SDK），ONNX Runtime CPU EP，INT8 权重 |
| 模型 | `syxppp/SoulX-Singer-onnx-directml-int8@v3@int8` |
| 采样率 | 24000 Hz |
| 鉴权 | **无**。免密钥、免 SDK Token，客户端不发送 `Authorization` 头；「密钥」字段禁用 |
| 限流 | 20 次/分钟、500 次/24 小时（按 IP） |
| 内置项 | 不可删除；可用「恢复内置默认」还原名称与网址；升级时旧网关地址自动迁移到此公开域名 |

> 访问要点：使用的是创空间**公开访问域名** `*.ms.show`，不是平台的
> `*.api-inference.modelscope.net` API 专用网关（后者强制 SDK Token）。平台按
> `User-Agent` 区分页面访问与程序调用，客户端统一带常规浏览器 UA；带 SDK Token
> 访问公开域名反而会被网关 403 拒绝。Provider 的 Base URL 里**不要**写
> `/v1/synthesize`，客户端会自动拼接。

---

## 9. 调用示例

### curl（免鉴权服务）

```bash
curl -sS -X POST "https://your-api.example.com/v1/synthesize" \
  -H "Content-Type: application/json" \
  -H "Accept: audio/wav" \
  -d '{"bpm":120,"n_steps":32,"pitch_control":"score","notes":[{"pitch":60,"start":0,"duration":1,"lyric":"我"}]}' \
  -o out.wav
```

### curl（带密钥 + 查看配额）

```bash
curl -sS "https://your-api.example.com/v1/usage" -H "Authorization: Bearer $TOKEN"
curl -sS "https://your-api.example.com/health?strict=1" -H "Authorization: Bearer $TOKEN"
```

### JavaScript（Node 18+，含错误呈现）

```js
const res = await fetch(`${baseUrl}/v1/synthesize`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'audio/wav, application/json',
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  },
  body: JSON.stringify({ notes, bpm: 120, n_steps: 16, response_format: 'wav' }),
});
if (!res.ok) {
  const e = await res.json().catch(() => ({}));
  // 必须展示给用户，不要 console.log 了事
  const retry = res.headers.get('retry-after');
  throw new Error(`[API ${res.status}] ${e.message || '请求失败'}${retry ? `，请 ${retry}s 后重试` : ''}`);
}
const wav = Buffer.from(await res.arrayBuffer());
```

### Python

```python
import requests
r = requests.post(f"{base}/v1/synthesize",
                  headers={"Authorization": f"Bearer {token}"} if token else {},
                  json={"bpm": 120, "n_steps": 32,
                        "notes": [{"pitch": 60, "start": 0, "duration": 1, "lyric": "我"}]},
                  timeout=600)
if r.status_code == 429:
    raise RuntimeError(f"限流：{r.json().get('message')}，{r.headers.get('Retry-After')}s 后重试")
r.raise_for_status()
open("out.wav", "wb").write(r.content)
```

---

## 10. 兼容性与版本

- 本规范版本 **1.0**，对应 SXSEditor 2.x 与参考 API 服务 v1.3.0。
- 服务端**可以**增加可选请求字段，但不得删除或改变已有字段语义；未知顶层字段
  在参考实现中会触发 400，因此客户端只发送本规范列出的字段。
- 客户端在 `GET /` 与 `GET /health` 中读取 `model_revision` 等信息用于展示，
  不依赖它们做功能分流。
- 音频采样率若不是 24000 Hz，客户端会做线性重采样到 24000 Hz；为保证音质，
  服务端仍应输出 24000 Hz。

---

## 11. 安全清单

- 密钥加密存储于系统密钥环（Windows DPAPI / macOS Keychain / Linux libsecret），
  与普通设置文件分离；不可用时必须明确告知用户「密钥以明文存储」。
- 桌面客户端的 HTTP 请求一律在**主进程**发起：渲染层 CSP 的 `connect-src`
  默认不允许任意外部地址，且密钥不下发到渲染层。
- Base URL 只接受 `http://` / `https://` 绝对地址，不含内嵌凭据、查询串或片段。
- 日志中记录状态码、`request_id`、耗时，但**不记录密钥明文**。
- 生产环境应使用 HTTPS；`http://` 仅用于本机 / 内网自建服务。

---

## 相关文件

- 客户端 Provider 管理：`src/main/apiProviderStore.js`、`src/main/apiIpc.js`
- 客户端远程推理：`src/main/apiInference.js`（含 WAV 解码、错误分类、取消）
- 接入点：`src/main/svsIpc.js`、`src/settings.html` / `settings.js` / `settings.css`
- 参考服务端：`sxseditor-inference-api`（Fastify + ONNX Runtime CPU / INT8）
