# 海报文案修改

传一张海报 → 自动识别图上的文字 → 改成新文案 → 出图。

## 跑起来

```bash
npm install
npm start
```

打开 http://127.0.0.1:8787

文字识别与出图默认都走 **Codex**，复用当前电脑的 Codex 登录态，不需要项目单独保存 OCR 或图像 API Key。
也可以在「设置」页切换到云 OCR、本地合成或独立图片 API。

其他命令：

```bash
npm test                      # 单元测试
node test/e2e.mjs             # 端到端：起服务 → 识别 → 改字 → 出图 → 存到 output/
node test/render-check.mjs    # 本地合成的效果检查（坐标准确时的上限）
node test/ocr-probe.mjs       # 用测试海报打一次真实 OCR，验证密钥与坐标质量
```

## 三种出图方式

| | Codex 生图（默认） | 本地合成 | API 生图 |
|---|---|---|---|
| 需要密钥 | 不需要项目密钥；需已登录 Codex | 否 | 需要图像编辑 API Key |
| 费用 | 消耗 Codex 使用额度 | 无 | 按 API 次数计费 |
| 复杂背景 | 自然 | **可能留下痕迹** | 自然 |
| 典型耗时 | 5–15 分钟 | 数秒 | 取决于供应商 |
| 原理 | 本机 Codex 调用内置 imagegen | 盖掉旧字并重画 | 调用 `/images/edits` |

在「设置 → 出图方式」里切换，代码不用改。

## 目录

```
server/
  index.js        服务入口与路由
  config.js       配置与密钥（落盘到 data/，已 gitignore）
  validate.js     输入校验：MIME、体积、像素数、base64、prompt 长度
  position.js     像素坐标 → 「约在画面上方中间 (参考坐标 x:50%, y:12%)」
  prompt.js       提示词拼装
  queue.js        并发槽位
  task-store.js   任务存储（含归属校验）
  workspace-store.js  草稿、原图和生成记录持久化
  ocr/            codex / aliyun / tencent / baidu / mock
  image/          codex（Codex 生图）/ local（本地合成）/ openai（API 出图）/ codec / probe
.agents/skills/   项目内 poster-text-edit Codex 技能
public/           网页界面
test/             单元测试 + 端到端 + 渲染检查
```

## API

挂在 `/api` 下，契约与来源规格一致：

- `POST /ocr/detect` — `{imageBase64}` → `{elements[], canvas, rawCount}`
- `POST /ocr/generate` — `{imageBase64, changes[]}` → `{taskId, traceId}`
- `GET /ocr/task/:taskId` — `processing` / `completed` / `failed`
- `GET|PUT|DELETE /drafts/...` — 自动保存、恢复和删除当前草稿
- `GET|DELETE /history/...` — 生成记录、前后对比、下载与继续编辑
- `GET|PUT /ocr-text-edit/config`、`POST /ocr-text-edit/config/test`
- `GET|PUT /product-showcase/prompts`

### 与来源规格的差异

1. **`/ocr/generate` 优先收 `changes` 而不是 `prompt`。** 原契约让调用方提交拼好的提示词，
   那样模板会跑到前端、且前端能塞任意提示词。改为前端提交结构化变更、服务端拼提示词。
   只传 `prompt` 的老形式仍然支持（仅 AI 出图可用，本地合成需要坐标）。
2. **多密钥轮换简化为每个服务商一套凭据。** 单机自用够了。
3. **新增 Codex 与本地合成出图。** 本机可复用 Codex 登录态，纯色图也可完全离线本地合成。

### 修掉的来源规格问题

- `TextEditTask` 没有归属字段，却要求「任务查询必须校验用户或租户归属」——数据模型撑不起安全要求。
  现在 `ownerId` 必填，且归属校验下沉到存储层。
- 参考实现只用正则查 data URL 前缀：50 万字的 prompt 照收，`data:image/png;base64,!!!` 也照收。
  现在解码验证 base64、比对魔术字节、限制体积与像素数。
- 伪代码在 `tryAcquire` 与 `taskStore.create` 之间没有兜底，create 抛异常就泄漏并发槽位。
- 提示词构造器把换行压成空格（海报分行信息全丢）、把用户的 `"` 改成中文右引号、
  链式替换导致先插入的内容被二次展开、非法对齐值静默忽略、采集了 `isVertical`/`fontSize` 却从不使用。
- `position`（坐标 → 中文描述）原规格只有一句文字描述、没有实现，是出图准不准的关键。

## 安全

- 密钥只存服务端 `data/config.json`（权限 0600，已 gitignore），界面上只显示后 4 位。
- 默认只监听 `127.0.0.1`。要暴露到局域网，设 `HOST=0.0.0.0` 并**务必**同时设 `ACCESS_TOKEN`。
- 任务按 owner 隔离，查不到别人的任务（不存在与无权都返回 404，不泄露存在性）。
- 错误响应不含密钥、请求头和内部路径。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `ACCESS_TOKEN` | 空 | 设了就要求 `X-Access-Token` 头 |
| `CODEX_BIN` | 自动发现 | Codex 可执行文件的绝对路径；自动发现失败时设置 |

Codex 生图后台最多等待 25 分钟，页面最多等待 27 分钟。复杂的高分辨率商品图可能需要 5–15 分钟；任务完成或失败的耗时与错误会写入 `data/task-events.log`，不记录图片和修改文案。
生成页面会显示已等待时间和预计剩余区间。成功样本不足 3 次时采用保守的 5–15 分钟范围；积累更多本机任务后，会根据最近 200 次 Codex 成功记录自动校准，进度条仅代表时间参考而非模型内部真实进度。

## 自动保存与生成记录

- 识别完成后自动建立草稿；输入文案后约 0.7 秒自动保存，刷新页面会恢复原图、识别框和未生成的修改。
- 在某个文案框输入“消除”“删除”“去除”或“清除”，会清除该识别框内的原文字并补全背景，不会把指令词写进图片。
- 编辑页面会实时显示“本次修改记录”，可查看原文 → 新文案或清除操作，点击记录可定位到对应识别框。
- 每次点击生成都会建立一条记录；成功后可在顶部「修改记录」中查看具体文案变化、前后对比、下载结果或继续编辑。
- 生成完成页面和每条历史修改记录都会单独显示“图片生成耗时”，处理中实时计时，成功或失败后保存最终耗时。
- 生成完成页和修改记录页都提供“修改下一张”，会清除当前草稿并返回上传页；已经生成的历史记录不会删除。
- 修改前、修改后和记录缩略图均可点击放大，按 Esc、点关闭按钮或点黑色背景退出。
- 替换文案时会以原识别框内文字为样式参照，要求保留字体外观、字号、颜色/渐变、字重、描边、阴影、间距、对齐与原位置；新文案过长时仅允许按最小必要幅度缩小。AI 图像编辑仍可能出现少量字体近似，重要成图请在放大预览中复核。
- 草稿和记录保存在 `data/workspace/`，不会上传到 GitHub。生成记录默认最多 50 条并保留 30 天，也可在页面中手动删除。
