# GPT-SoVITS 本机部署使用文档（给 AI 开发者的交接文档）

> 适用对象：将要在这台机器上开发/调用 TTS 服务的 AI 助手或人类。
> 所有路径、端口、参数均从本机实测与源码（`api_v2.py`）确认，非通用教程。
> 更新时间：2026-10-05。

---

## 1. 环境事实

| 项 | 值 |
|---|---|
| 运行位置 | WSL2 `Ubuntu-24.04`，仓库在 `/home/miku/GPT-SoVITS` |
| Python | 仓库自带 venv：`/home/miku/GPT-SoVITS/venv`（不要用系统 python3） |
| API 服务 | `api_v2.py`（FastAPI），监听 `0.0.0.0:9880`，Windows 侧访问 `http://127.0.0.1:9880` |
| GPU | RTX 5060 Laptop 8GB，`device: cuda`，`is_half: true` |
| API 文档 | 服务运行时打开 `http://127.0.0.1:9880/docs`（OpenAPI Swagger） |
| NLTK 数据 | 已装在 `~/nltk_data`（cmudict、averaged_perceptron_tagger、averaged_perceptron_tagger_eng）——缺了会合成报错 |
| 当前默认权重 | GPT `GPT_weights_v4/fan_v4-e20.ckpt` + SoVITS `SoVITS_weights_v4/fan_v4_e8_s368_l32.pth`（配置在 `GPT_SoVITS/configs/tts_infer.yaml` 的 `custom` 段，`version: v4`） |

## 2. 启动 / 停止 / 健康检查

```bash
# 在 Windows 侧执行（Git Bash / PowerShell 均可）
wsl bash ~/GPT-SoVITS/start_api.sh     # 启动（脚本自带 pkill 防重复；约 10~20 秒就绪）
```

> **启动后进程会随 WSL 会话一起消失**（实测 2026-10-06）：`start_api.sh` 里是 `nohup … &`，
> 但那次 `wsl bash` 调用一结束，WSL 实例回收，nohup 的子进程也一起没了 —— 表现为
> 脚本打印「API starting...」后 `9880` 永远连不上、`/tmp/tts_api.log` 甚至不存在。
> 可靠起法：让那次 `wsl` 调用一直活着，例如
> `wsl bash -c "bash ~/GPT-SoVITS/start_api.sh; sleep 3600"`（放后台跑），
> 或者在另一个窗口先 `wsl` 进去再执行脚本。

- 健康检查：`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9880/docs` 返回 200 即就绪
- 日志：WSL 内 `tail -f /tmp/tts_api.log`
- 停止：`wsl bash -c "pkill -f api_v2.py"`
- 就绪前发请求会连接拒绝（不是 5xx），轮询 `/docs` 即可

## 3. 核心 API

### 3.1 合成语音 `POST /tts`（也支持 GET，建议 POST）

请求体 JSON。**必填**：`text`、`text_lang`、`ref_audio_path`、`prompt_lang`（缺任一返回 400）。

完整参数（与 `api_v2.py` 的 `TTS_Request` 源码逐字段一致，默认值即源码默认）：

| 参数 | 类型/默认 | 说明 |
|---|---|---|
| `text` | str | 要合成的文本（必填） |
| `text_lang` | str | 合成文本语言（必填，见 3.2 语言表） |
| `ref_audio_path` | str | **参考音频路径（服务端本地路径，决定音色）**（必填） |
| `prompt_text` | str = "" | 参考音频说的话；**准度影响音色相似度** |
| `prompt_lang` | str | 参考音频语言（必填） |
| `aux_ref_audio_paths` | list | 辅助参考音频（补充音色细节，可选） |
| `media_type` | str = "wav" | `wav` / `mp3` / `aac` / `ogg` / `flac` |
| `streaming_mode` | bool = False | true 时分块流式返回（wav 分片拼接） |
| `speed_factor` | float = 1.0 | 语速（0.6~1.65 实际有效范围） |
| `seed` | int = -1 | 随机种子（-1 随机；固定可复现） |
| `top_k` / `top_p` / `temperature` | 15 / 1 / 1 | 采样参数 |
| `repetition_penalty` | float = 1.35 | 重复惩罚 |
| `text_split_method` | str = "cut5" | 长文本切分方式 |
| `batch_size` / `batch_threshold` / `split_bucket` / `fragment_interval` / `parallel_infer` / `sample_steps` / `super_sampling` | 见左默认 | 推理细节，一般不动 |

成功响应：**直接是音频字节流**（`Content-Type: audio/wav` 等），不是 JSON。
失败响应：JSON `{"message":"tts failed","Exception":"<堆栈摘要>"}`（HTTP 仍可能 200，**必须检查 body 开头是否为 `RIFF`/音频字节**）。

curl 示例（中文/日文 JSON 必须走 UTF-8 文件，见 §6 坑 3）：

```bash
curl -s -m 240 -X POST "http://127.0.0.1:9880/tts" \
  -H "Content-Type: application/json" \
  --data-binary "@body.json" -o out.wav
```

### 3.2 语言代码（v4 实际支持集，源码 `dict_language_v2`）

`all_zh` `en` `all_ja` `all_yue` `all_ko` `zh` `ja` `yue` `ko` `auto` `auto_yue`

- `all_*` = 整句按该语言处理；无前缀 = 中/日/粤/韩英混合切分识别；`auto` = 多语种自动
- 大小写不敏感；传不支持的值返回 400 `text_lang: xxx is not supported`

### 3.3 热切换音色权重（不重启服务）

```bash
# GPT（文本→语义）与 SoVITS（语义→音色）是一对，换音色通常两个都要换
curl "http://127.0.0.1:9880/set_gpt_weights?weights_path=/home/miku/GPT-SoVITS/GPT_weights_v4/fan_v4-e20.ckpt"
curl "http://127.0.0.1:9880/set_sovits_weights?weights_path=/home/miku/GPT-SoVITS/SoVITS_weights_v4/fan_v4_e8_s368_l32.pth"
# 均返回 {"message":"success"}；只影响运行中的服务，重启后回落到 tts_infer.yaml
```

### 3.4 其他端点

| 端点 | 说明 |
|---|---|
| `GET /control?command=restart` | 重启推理（另有 `exit` 等，见源码 `handle_control`） |
| `GET /docs` | Swagger UI，也是健康检查 |
| `GET /set_refer_audio` | 已弃用路径（源码中 POST 已注释） |

## 4. 本机音色资产（忍野扇 = 训练名 "fan"）

**只有一次训练**（2026-08-31，v4 架构），留了逐 epoch 检查点；GPT 和 SoVITS 按同名 epoch 配对使用：

| GPT（`GPT_weights_v4/`） | SoVITS（`SoVITS_weights_v4/`） | 说明 |
|---|---|---|
| `fan_v4-e2.ckpt` | `fan_v4_e1_s46_l32.pth` | 最早版 |
| `fan_v4-e4/e6/e8/e10/e12/e14/e16/e18.ckpt` | `fan_v4_e2..e9_*.pth` | 中间各版 |
| `fan_v4-e20.ckpt` | `fan_v4_e10_s460_l32.pth` | 最新版；**e20+e10 是原默认** |

**当前默认 = GPT e20 + SoVITS e8**（用户 A/B 试听后选定；已写入 `tts_infer.yaml`）。
中间版实测样本（GPT 固定 e20）：`Windows 侧 D:\Desktop\GLM-d4\production\voice-samples\` 下三个 wav。

**参考音频（扇的音色锚点，合成必带）**：

```
ref_audio_path: /home/miku/GPT-SoVITS/GPT_SoVITS/output/切片/vocal_扇_原声.wav_20.wav_0000020800_0000234240.wav
prompt_text:    しかしそれはともかくとして、あららぎ先輩、仲間を頼るのは悪いことではありませんが
prompt_lang:    ja
```

更多切片在同目录 `output/切片/`（无声源在 `GPT_SoVITS/input/扇_原声.wav`）；**没有训练标注 .list 文件**，换参考音频需要自己配 prompt_text。

## 5. Himuro 的集成点（在 Himuro 上开发时需要知道）

- Himuro（`D:\Desktop\DSH-d4\Himuro`，Next.js，http://localhost:3000）通过**服务端代理** `POST /api/tts {text, characterId?}` 调本服务，浏览器不直连 9880（绕 CORS、不暴露内网地址）
- 供应商配置存 Himuro 的 SQLite `settings` 表（`ttsProvider=ttsBaseUrl/ttsLang/ttsRefAudio/ttsPromptText/ttsPromptLang`），设置页可视化编辑
- `characterId` 给定时优先用该角色自己的参考音频（`characters` 表 `ttsRefAudio` 等四字段），空字段逐项回退全局 → **换音色 = 在角色卡里填另一个参考音频路径**
- Himuro 侧代码：`lib/tts.ts`（客户端）、`app/api/tts/route.ts`（代理）、`lib/settings.ts`
- 冒烟测试 `npm run smoke` 含 TTS 用例；GPT-SoVITS 未启动时自动跳过

## 6. 已踩过的坑（重要）

1. **NLTK 数据缺失** → 报 `tts failed, Resource 'cmudict' not found`（处理中文/英文都要）。已装到 `~/nltk_data`；若环境重建需重装 `cmudict`、`averaged_perceptron_tagger`、`averaged_perceptron_tagger_eng`。WSL 内 `nltk.download` 被安全策略拦（DNS 指向 127.0.0.1 的 SSRF 拦截），**需 Windows 侧下载 zip 后拷入**
2. **Windows curl 传中文/日文 JSON**：直接 `-d '中文'` 会因编码变 JSON 解析失败（`There was an error parsing the body`）。**必须**把 body 写成 UTF-8 文件后 `--data-binary "@file"`
3. **失败响应也可能是 200**：判断成功要看响应体是不是音频（`RIFF` 头 / `file` 命令），不能只看状态码
4. **响应最大时长**：单次合成冷启动 + 长文本可能 30~120s，客户端超时建议 ≥240s
5. **参考音频质量**：必须是干净人声切片（3~10 秒）；`prompt_text` 与参考音频实际内容不符会明显降低相似度
6. **改默认权重**：`/set_*_weights` 只影响运行中服务；要持久化必须改 `GPT_SoVITS/configs/tts_infer.yaml` 的 `custom` 段后重启
7. **clone 仓库 ≠ 可用**：venv、pretrained_models、NLTK 数据三者齐才算部署完成；缺失时先看 `/tmp/tts_api.log`
