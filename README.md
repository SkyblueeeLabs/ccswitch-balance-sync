# CC Switch Balance Sync

在 CC Switch 中自动显示多家供应商大模型余额的一体化工具。

> ⚠️ **本项目仅供学习与研究使用**，与小米、美团、CC Switch 官方无关。使用本项目产生的一切后果由使用者自行承担。

> ## ⭐ 这是推荐使用的版本
>
> 另有早期拆分的两个单供应商项目，**均已归档、不再维护**：
>
> | 项目 | 状态 |
> |---|---|
> | [ccswitch-mimo-balance](https://github.com/SkyblueeeLabs/ccswitch-mimo-balance) | 📦 已归档，仅 MiMo |
> | [ccswitch-longcat-balance](https://github.com/SkyblueeeLabs/ccswitch-longcat-balance) | 📦 已归档，仅 LongCat |
> | **本项目** | ✅ **持续维护** |
>
> 归档版代码仍可正常使用，但新增供应商需要改代码、且每家要单独建一个计划任务。
> **本项目只需编辑 `config.json` 即可添加供应商，一个任务管全部。**

## 支持的供应商

| 供应商 | 余额接口 | 认证方式 |
|--------|----------|----------|
| MiMo（小米） | `GET /api/v1/balance` | Cookie |
| LongCat（美团） | `POST /api/pay/quota/metering/api-usage/summary` | Cookie |

## 工作原理

```
登录一次所有供应商 → 保存浏览器状态（state.json）
                            ↓
        每次同步时自动加载状态 → 查询所有供应商余额 → 写入 CC Switch
                            ↓
              Cookie 过期时 → 自动弹出浏览器重新登录
```

### 核心特性

- **多供应商支持**：一个项目管理多家供应商余额
- **全自动维护**：Windows 任务计划程序每 6 小时自动刷新
- **一键同步**：双击 `3-sync.bat` 立即同步所有供应商
- **自动重启**：写入后自动重启 cc-switch，代码区和余额都正常显示

## 前置条件

| 条件 | 说明 |
|------|------|
| ✅ CC Switch 已安装 | 版本 3.0 以上 |
| ✅ 供应商已配置 | 在 CC Switch 里添加供应商，填入有效的 API Key |
| ✅ API 可正常调用 | 能用模型正常对话/推理 |
| ✅ Node.js 已安装 | 版本 18 以上 |
| ✅ Windows 10/11 | 用于任务计划程序 |

## 安装

### 第一步：安装依赖

双击运行 `1-install.bat`

### 第二步：登录所有供应商

双击运行 `2-login.bat`

会依次弹出浏览器窗口，登录每个供应商后回到命令行按 **Enter**。

### 第 2.5 步（首次必须）：设置自定义模板

**打开 CC Switch → 供应商卡片 → 配置用量查询**

对每个供应商：
1. 启用"用量查询"开关
2. 模板选择**"自定义"**
3. 点击**"保存"**

> ⚠️ **这一步只需要做一次**。如果不设置成"自定义"模板，脚本写入的代码会被 cc-switch 覆盖。
> 官方模板、Token Plan 等内置模板都不支持自定义代码。

### 第三步：同步余额

双击运行 `3-sync.bat`

自动查询所有供应商余额并写入 CC Switch，写入后自动重启 cc-switch。

### 第四步（可选）：设置自动刷新

**右键 `4-setup-task.bat` → 以管理员身份运行**

任务创建后每 6 小时自动刷新一次余额，输出写入 `auto-sync.log`。

| 项目 | 值 |
|------|-----|
| 任务名 | `CCSwitchBalanceSync` |
| 频率 | 每 6 小时 |
| 运行账户 | 当前登录用户（交互式，无需密码） |
| 日志 | `auto-sync.log` |

创建后可以立即手动触发一次验证：

```bat
schtasks /Run /TN "CCSwitchBalanceSync"
```

> 💡 自动刷新使用 Node 内置 `fetch` 直接请求余额接口，**不启动浏览器**，因此不会弹窗。
> 只有在 Cookie 过期需要重新登录时才会打开浏览器 —— 而计划任务无人值守，
> 此时脚本会记录提示并退出，需要你手动双击 `2-login.bat` 重新登录。

> ⚠️ **从旧版单独项目升级上来的话**：旧版各自创建过独立任务
> （`MiMoCookieAutoRefresh` / `LongCatCookieAutoRefresh`），它们仍然每 6 小时运行、
> 并会往同一个 cc-switch 数据库写入**旧版脚本**，覆盖本合并版的结果。
> 请先删掉旧任务，只保留 `CCSwitchBalanceSync`：
>
> ```powershell
> schtasks /Delete /TN "MiMoCookieAutoRefresh" /F
> schtasks /Delete /TN "LongCatCookieAutoRefresh" /F
> ```
>
> 检查当前有哪些任务：`schtasks /Query /FO TABLE | findstr /I "ccswitch balance"`

## 升级 / 卸载

| 操作 | 命令 |
|------|------|
| 查看本项目的任务 | `schtasks /Query /TN "CCSwitchBalanceSync" /V /FO LIST` |
| 删除本项目任务 | `schtasks /Delete /TN "CCSwitchBalanceSync" /F` |
| 立即运行一次 | `schtasks /Run /TN "CCSwitchBalanceSync"` |

## 使用

| 操作 | 方式 |
|------|------|
| 手动同步所有供应商 | 双击 `3-sync.bat` |
| 重新登录 | 双击 `2-login.bat` |
| 自动刷新 | 任务计划程序每 6 小时自动运行 |

## 添加新供应商

编辑 `config.json`，在 `providers` 数组中添加新条目：

```json
{
  "name": "供应商显示名称",
  "matchName": "供应商名称匹配关键词",
  "loginUrl": "登录页面 URL",
  "homeUrl": "首页 URL",
  "apiUrl": "余额查询接口 URL",
  "method": "GET 或 POST",
  "cookieDomain": "Cookie 域名",
  "cookieNames": ["关键 Cookie 名称"],
  "balancePath": "余额字段路径，如 data.balance",
  "currencyPath": "币种字段路径，如 data.currency",
  "successCheck": "code"
}
```

> ⚠️ **路径要写全**：`balancePath` 必须包含 `data.` 前缀（如 `data.paygoBalance.primary.amount`）。
> CC Switch 传给 extractor 的是接口原始响应体，`data` 不会被自动解包。
> 写成 `balance` 之类去掉 `data.` 的路径会导致 QuickJS 报「执行 extractor 失败」。

**如何获取这些参数：**
1. 登录供应商控制台，打开余额页面
2. F12 → Network → Fetch/XHR
3. 找到返回余额的请求，记录 URL、Method、Cookie
4. 查看 Response，找到余额字段的路径

## 文件说明

| 文件 | 用途 |
|------|------|
| `config.json` | 供应商配置（接口、字段映射） |
| `1-install.bat` | 安装 Playwright 和 Chromium |
| `2-login.bat` | 登录所有供应商 |
| `3-sync.bat` | 手动同步所有供应商余额 |
| `4-setup-task.bat` | 创建自动刷新任务（需管理员权限） |
| `setup-task.ps1` | 任务创建脚本 |
| `playwright-login.mjs` | 登录脚本 |
| `playwright-cookie.mjs` | 余额同步脚本 |
| `playwright-auto.mjs` | 自动维护脚本 |
| `auto-sync.log` | 计划任务运行日志（自动生成） |
| `state.json` | 浏览器登录状态（每台机器不同，不打包） |
| `cc-switch.backup-*.db` | CC Switch 数据库备份（自动生成） |

## 安全提示

- **Cookie 是账号级登录态**：获取 Cookie 后可以操作你的账号，风险高于普通 API Key
- **不要分享 `state.json`**：该文件包含你的完整登录状态
- **谨慎使用云同步**：如果 CC Switch 开启了 WebDAV 自动同步，Cookie 会被上传到云端

### 上传到 GitHub 前

本项目**没有硬编码任何密钥**，`config.json` 里只有接口地址和字段路径，可以安全提交。

`.gitignore` 已排除以下内容：

| 被排除 | 原因 |
|--------|------|
| `state.json` | **含真实登录 Cookie，泄露等于账号被接管** |
| `cc-switch.backup-*.db` | 数据库备份，含写入的 Cookie |
| `*.db` | 同上的兜底规则 |
| `*.log` | 日志可能含 debug 信息 |

上传前建议自查一遍：

```bash
git status                      # 确认 state.json 不在列表里
git ls-files | findstr state    # 应无输出
```

> ⚠️ 如果 `state.json` **曾经**被提交过，仅仅加 `.gitignore` 是没用的 ——
> 它仍留在历史里。需要 `git rm --cached state.json` 后用
> [git-filter-repo](https://github.com/newren/git-filter-repo) 清理历史，
> 并**立即到供应商控制台重新登录**使旧 Cookie 失效。

## 常见问题

**Q: 同步失败怎么办？**
A: 先运行 `2-login.bat` 重新登录，再运行 `3-sync.bat`。

**Q: 余额不显示？**
A: 确认供应商的用量查询已设置成"自定义"模板并保存。

**Q: 自动刷新不工作？**
A: 检查任务是否存在：`schtasks /Query /TN "CCSwitchBalanceSync"`，并查看 `auto-sync.log` 了解每轮结果。手动触发测试：`schtasks /Run /TN "CCSwitchBalanceSync"`。

**Q: 自动刷新时会不会弹浏览器窗口？**
A: 不会。常规刷新走纯 HTTP 请求。只有 Cookie 过期需要重新登录时才会用到浏览器，而计划任务是无人值守的，此时只记录日志，不会弹窗卡住。

**Q: 余额显示的数字过一会儿又变回去了 / 修复的问题反复出现？**
A: 大概率是有**旧的独立任务还在运行**，往同一个数据库写旧脚本。检查并删除旧任务：

```powershell
schtasks /Query /FO TABLE | findstr /I "ccswitch balance mimo longcat"
schtasks /Delete /TN "MiMoCookieAutoRefresh" /F
schtasks /Delete /TN "LongCatCookieAutoRefresh" /F
```

只保留 `CCSwitchBalanceSync` 一个任务。

**Q: 支持哪些供应商？**
A: 理论上支持所有有余额查询接口的供应商。只需在 `config.json` 中添加配置即可。

**Q: 为什么需要管理员权限创建任务？**
A: Windows 任务计划程序需要管理员权限才能创建任务。创建一次后，后续运行不需要。

**Q: 提示「执行 extractor 失败: Exception generated by QuickJS」？**
A: 说明写入 CC Switch 的脚本取值路径错了。关键点：**extractor 收到的 `response` 是接口原始响应体，`data` 不会被解包**，因此路径要写完整的 `data.balance`，不能简写成 `balance`。这类错误在 QuickJS 里表现为变量未定义的异常。重新运行一次 `3-sync.bat` 会覆盖修正。

## 免责声明

1. 本项目仅供学习与研究用途，不得用于任何商业或非法目的
2. 使用本项目所产生的一切后果由使用者自行承担，包括但不限于账号封禁、数据泄露等
3. 本项目与小米、美团、CC Switch 官方无任何关联
4. 请遵守各供应商的服务条款
5. 本项目按"原样"提供，不提供任何明示或暗示的担保

## 许可

本项目代码基于 MIT 许可证开源。使用本项目即表示你同意上述免责声明。
