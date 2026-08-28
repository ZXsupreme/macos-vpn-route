# VPNRouteBar

macOS 多 VPN 路由管理菜单栏客户端。基于 [`vpn_route.sh`](../vpn_route.sh)（`--json` 事件流模式）驱动，Electron + React + TypeScript 实现。

## 功能

- **菜单栏状态图标**：绿（全通）/ 黄（部分异常）/ 红（测试失败）/ 蓝（操作中）/ 灰（未检查）
- **状态面板**：VPN 网卡识别（IPv6 前缀优先）、路由指向核对、连通性测试结果、事件流水
- **一键 Apply / Clean**：未装免密授权时走 osascript 系统密码框；装了走 sudo NOPASSWD 无弹窗
- **自动 Apply**：3s 轮询 utun 接口/默认路由 → 5s 静默防抖 → 路由失配才动手（120s 冷却防拉锯）
- **定时巡检 + 系统通知**：默认 60s；失败变化沿告警（新失败/恢复各一次，持续失败 30 分钟一次）
- **配置 GUI 编辑器**（托盘右键 → 编辑配置…）：表单/原始文本双模式，保存前过 `bash -n` + 语义预检，自动备份 5 份

## 开发

```bash
cd app
pnpm install
pnpm dev          # 菜单栏出现图标
pnpm typecheck
pnpm dist         # 打包 dmg（dist/）
```

设置持久化于 `~/.vpn_route_bar/settings.json`；配置文件默认 `~/.vpn_route.conf`。

## 免密授权（sudoers）说明

应用内"设置 → 免密授权 → 安装"会（一次系统密码授权）：

1. 把 `vpn_route.sh` 以 root 存放于 `/Library/Application Support/VPNRouteBar/vpn_route.sh`（用户可写目录的脚本绝不进 sudoers）
2. 写入 `/etc/sudoers.d/vpnroutebar`：**仅两条精确命令**（参数钉死、无通配符）

```
<user> ALL=(root) NOPASSWD: .../vpn_route.sh apply -c <conf> --json
<user> ALL=(root) NOPASSWD: .../vpn_route.sh clean -c <conf> --json
```

风险声明：root 脚本会 `source` 用户可写的 bash 配置文件（等同本机用户可执行 root 代码），与单用户笔记本用户已持有 sudo 密码的信任级相同。**切勿用于多人共用机器。**

未安装时：手动 Apply/Clean 每次弹系统密码框；自动 Apply 禁用。

## 打包产物

- 未签名（ad-hoc），个人本机使用无碍；分发需接收者右键打开
- `vpn_route.sh` 打包在 extraResources；脚本源码更新后在设置里"重装脚本"或重新安装授权
