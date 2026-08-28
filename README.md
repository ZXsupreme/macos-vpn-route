# macOS VPN Route

macOS 下多 VPN 并存时的自动路由管理工具：一个 bash 脚本 + 一个可选的菜单栏 GUI 客户端。

同时连接多个 VPN（如公司 SDP + 另一个 VPN）时，后连的 VPN 会抢占默认路由，导致先连的 VPN 资源不通、或公网中断。本工具按网段自动分流各 VPN 流量，并把默认路由归还给物理网卡，一键恢复全部连通性。

## 两部分组成

| 部分 | 说明 | 适合谁 |
| --- | --- | --- |
| `vpn_route.sh` | 单文件 bash 脚本，CLI 即全部能力 | 习惯终端、想看懂每一行的人 |
| `app/`（VPNRouteBar） | Electron 菜单栏客户端，驱动脚本的 `--json` 模式 | 想要自动化与可视化的日常使用 |

两者共用同一脚本底座：GUI 不重写任何路由逻辑，只负责触发、解析与展示。

## 问题背景

```
连接顺序:  Wi-Fi ──▶ VPN_A(utun) ──▶ VPN_B(utun)
                                    │
                          默认路由被 VPN_B 抢占
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
      VPN_A 资源不通          VPN_B 资源通            公网可能中断
```

## 脚本用法

```bash
git clone https://github.com/ZXsupreme/macos-vpn-route.git
cd macos-vpn-route
cp vpn_route.conf.example ~/.vpn_route.conf
vim ~/.vpn_route.conf          # 填入你自己的 VPN 识别特征与网段

./vpn_route.sh status          # 只读预览（无 sudo，不改动系统）
./vpn_route.sh apply           # 识别 → DNS → 清理 → 分流 → 默认网关 → 测试（需 sudo）
```

| 子命令 | 作用 |
| --- | --- |
| `apply` | 识别网卡 → 设置 DNS → 清理旧路由 → 添加分流路由 → 默认网关归还 Wi-Fi → 连通性测试 |
| `clean` | 仅清理配置中声明的旧路由 |
| `test` | 仅运行连通性测试 |
| `status` | 只读展示网卡识别结果与路由指向 |

选项：`-c FILE` 指定配置；`-h` 帮助。

### `--json` 事件流（GUI / 二次开发接口）

任意子命令加全局标志 `--json`（位置不限），人类可读输出全部静默，stdout 变为纯 JSONL 事件流：

```console
$ ./vpn_route.sh status --json
{"event":"hello","schema":1,"script_version":"2.1"}
{"event":"status","ts":"...","schema":1,"conf":"/home你/.vpn_route.conf",
 "vpns":[{"name":"vpn_a","detected":true,"method":"inet6","interface":"utun4",
          "ipv4":"10.8.1.5","routes":[{"target":"10.20.0.0/24","kind":"net",
          "expected":"utun4","actual":"utun4","ok":true}]}],
 "default_route":{"interface":"en0","gateway":"192.168.1.1"},"all_detected":true}
```

- `status` 输出单行状态对象；`test` / `apply` / `clean` 输出事件流（`test_item` / `phase` / `route` / `summary` 等，见 `app/src/shared/types.ts` 的完整类型定义）
- 首行固定 `hello` 握手（含 schema 与脚本版本）；退出码 `0` 完成 / `2` 配置错误 / `3` apply 因 VPN 未连接中止
- bash 只报事实；综合健康状态由调用方派生（参考 `app/src/main/appState.ts`）

## GUI 客户端（VPNRouteBar）

```bash
cd app
pnpm install
pnpm dev          # 开发：菜单栏图标 + 热重载
pnpm dist         # 打包 dist/*.dmg（apple silicon）
```

功能：

- **菜单栏状态图标**：绿（全通）/ 黄（部分异常）/ 红（测试失败）/ 蓝（操作中）/ 灰（未检查）；深浅色主题跟随系统或手动切换
- **状态面板**：VPN 网卡识别、路由指向核对、测试结果、事件流水；全局快捷键 `⌥⌘V` 呼出
- **一键 Apply / Clean**；**自动 Apply**（监听网络变化 → 5s 防抖 → 路由确实失配才动手，120s 冷却）
- **定时巡检 + 系统通知**（失败变化沿去重，不轰炸）
- **网络学习**：扫描当前在线的 utun，自动生成识别特征与分流网段写进配置——换新 VPN 组合零手写
- **配置编辑器**：表单 / 原始文本双模式，保存前 `bash -n` + 语义双重校验，自动备份
- **多环境 Profile**：`~/.vpn_route_home.conf`、`~/.vpn_route_work.conf`… 面板一键切换

### 免密授权（sudoers）与安全设计

GUI 的"免密授权"按钮会（一次密码授权）：

1. 把脚本以 root 存放于 `/Library/Application Support/VPNRouteBar/vpn_route.sh`（用户可写目录下的脚本绝不进 sudoers）
2. 写入 `/etc/sudoers.d/vpnroutebar`：**仅 apply/clean 两条精确命令**（参数钉死、无通配符、`-c` 钉死配置绝对路径以防 sudo 重置 HOME）

未安装时：手动 Apply 每次走 macOS 密码框；自动 Apply 自动禁用。

> ⚠️ root 运行的脚本会 source 用户可写的 bash 配置文件，等同于本机用户可执行 root 代码——与单用户笔记本上你已持有 sudo 密码的信任级相同。**切勿在多人共用的机器上安装免密授权。**

## 配置说明

```bash
# 物理网卡（macOS 网络服务名）
WIFI_SERVICE="Wi-Fi"

# DNS（顺序敏感：先公网后内网）
DNS_SERVERS=("8.8.8.8" "8.8.4.4" "10.20.0.53")

# apply 前清理的旧路由
CLEANUP_NETS=("10.20.0.0/24")
CLEANUP_HOSTS=("10.20.1.10")

VPN_NAMES=("vpn_a" "vpn_b")

# 每个 VPN 名 N 大写化后对应以下变量：
#   N_DETECT_INET6   IPv6 地址前缀识别（最稳定，推荐）
#   N_DETECT_SUBNET  IPv4 网段前缀识别
#   N_ROUTE_NETS     走该 VPN 的网段（CIDR）
#   N_ROUTE_HOSTS    走该 VPN 的单机 IP
VPN_A_DETECT_INET6="fd00:abcd"
VPN_A_DETECT_SUBNET="10.8"
VPN_A_ROUTE_NETS=("10.20.0.0/24")
VPN_A_ROUTE_HOSTS=("10.20.1.10")

# 连通性测试: "描述|目标|类型|端口"，类型 public / tcp / domain
TESTS=(
    "公网访问|example.com|public|0"
    "VPN_A资源|10.20.0.5|tcp|80"
)
```

找识别特征：连上 VPN 后 `ifconfig utunN`，IPv6 地址取前 3 段（如 `fd00:abcd:1234`）作 `DETECT_INET6`；或 IPv4 取前两段作 `DETECT_SUBNET`。IPv4 网段会变的客户端务必用 IPv6 特征。

## 兼容性

- 平台：仅 macOS（依赖自带 `ifconfig` / `networksetup` / `route` / `host` / `curl` / `ping` / `nc`）
- Shell：bash 3.2 兼容（macOS 自带），无需安装新版
- 客户端：Node ≥ 20 + pnpm；Electron 打包仅验证 apple silicon
- 权限：`status` / `test` 无需 sudo；`apply` / `clean` 需 sudo

## 注意事项

- `apply` 修改路由表与 DNS，重连 VPN 后可能失效（GUI 的自动 Apply 会处理；CLI 用户重跑即可）
- 连接顺序建议先连会抢占默认路由的 VPN，再连另一个
- 配置文件含内网信息，`vpn_route.conf` 已被 `.gitignore` 忽略，勿提交
- 请遵守你所在组织的安全策略

## License

[MIT](LICENSE)
