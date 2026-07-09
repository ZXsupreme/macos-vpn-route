# macOS VPN Route

macOS 下多 VPN 并存时的自动路由管理工具。

同时连接多个 VPN（如公司 SDP + 飞连）时，后连的 VPN 会抢占默认路由，导致先连的 VPN 资源不通、或公网中断。本工具按网段自动分流各 VPN 流量，并把默认路由归还给物理 Wi-Fi，一键恢复全部连通性。

## 问题背景

macOS 连接多个 utun 接口 VPN 时常见冲突：

```
连接顺序:  Wi-Fi ──▶ VPN_A(utun) ──▶ VPN_B(utun)
                                    │
                          默认路由被 VPN_B 抢占
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
      VPN_A 资源不通          VPN_B 资源通            公网可能中断
      (路由被覆盖)            (默认走它)            (DNS/网关混乱)
```

## 工作原理

```
                    ┌─────────────────────────┐
                    │   vpn_route.sh apply    │
                    └────────────┬────────────┘
                                 ▼
         ┌──────────────────────────────────────────────┐
         │ 1. 按 DETECT_SUBNET 自动识别各 VPN 网卡      │
         │    (10.8.* → utun5, 10.9.* → utun4, ...)     │
         ├──────────────────────────────────────────────┤
         │ 2. 重置 DNS (先公网后内网，防内网 DNS 挂掉)    │
         ├──────────────────────────────────────────────┤
         │ 3. 清理上次残留路由                          │
         ├──────────────────────────────────────────────┤
         │ 4. 按配置把各网段/主机指向对应 VPN 网卡       │
         │    10.20.0.0/24 ──▶ utun5 (VPN_A)            │
         │    10.30.0.0/24 ──▶ utun4 (VPN_B)            │
         ├──────────────────────────────────────────────┤
         │ 5. 默认路由归还物理 Wi-Fi 网关                │
         ├──────────────────────────────────────────────┤
         │ 6. 连通性测试 (公网/VPN资源/域名解析)         │
         └──────────────────────────────────────────────┘
                                 ▼
              ✅ 公网 + 各 VPN 资源同时可达
```

## 功能特性

- **多 VPN 共存**：支持任意数量 VPN 按网段分流，互不干扰
- **自动识别网卡**：通过网段特征自动匹配 utun 接口，无需硬编码网卡名
- **默认路由修复**：把默认网关归还 Wi-Fi，避免 VPN 抢占导致公网中断
- **DNS 重置**：按"公网优先"顺序配置，内网 DNS 故障不影响上网
- **连通性测试**：apply 后自动测试公网、VPN 资源、域名解析是否正常
- **配置驱动**：所有网段/IP/域名写在配置文件，换环境只改配置不改脚本
- **bash 3.2 兼容**：无需升级 macOS 自带 bash，开箱即用

## 快速开始

```bash
# 1. 克隆
git clone https://github.com/<your-name>/macos-vpn-route.git
cd macos-vpn-route

# 2. 创建你的配置 (从脱敏模板复制)
cp vpn_route.conf.example ~/.vpn_route.conf
vim ~/.vpn_route.conf   # 填入你自己的 VPN 网段/IP/域名

# 3. 先只读检查识别结果 (不改动系统)
./vpn_route.sh status

# 4. 确认无误后执行路由修复 (需 sudo)
./vpn_route.sh apply
```

## 子命令

| 子命令   | 作用                                                         |
| -------- | ------------------------------------------------------------ |
| `apply`  | 识别网卡 → 设置 DNS → 清理旧路由 → 添加新路由 → 默认网关 → 测试 |
| `clean`  | 仅清理配置中声明的旧路由                                     |
| `test`   | 仅运行连通性测试                                             |
| `status` | 只读展示当前 VPN 网卡识别结果和路由指向，**无副作用**        |

选项：

- `-c FILE` 指定配置文件（默认 `~/.vpn_route.conf`，或环境变量 `VPN_ROUTE_CONF`）
- `-h` 显示帮助

```bash
./vpn_route.sh apply -c ~/work_vpn.conf   # 用指定配置
./vpn_route.sh test                        # 单独跑测试
./vpn_route.sh status                      # 随时查看状态
```

## 配置说明

配置文件查找顺序：`-c` 参数 > `VPN_ROUTE_CONF` 环境变量 > `~/.vpn_route.conf`。

核心字段：

```bash
# 物理网络接口 (macOS 网络服务名)
WIFI_SERVICE="Wi-Fi"

# DNS (顺序敏感：先公网后内网)
DNS_SERVERS=("8.8.8.8" "8.8.4.4" "10.20.0.53")

# apply 前清理的旧路由 (填所有被各 VPN 接管的网段/主机)
CLEANUP_NETS=("10.20.0.0/24" "10.30.0.0/24")
CLEANUP_HOSTS=("10.20.1.10" "10.20.1.11")

# VPN 列表
VPN_NAMES=("vpn_a" "vpn_b")

# 每个 VPN 名 N 对应三组变量 (脚本内部转大写):
#   N_DETECT_SUBNET  网卡 IP 网段前缀，用于自动识别 utun 接口
#   N_ROUTE_NETS     走该 VPN 的网段 (CIDR)
#   N_ROUTE_HOSTS    走该 VPN 的单机 IP (不在网段内的主机)
VPN_A_DETECT_SUBNET="10.8"
VPN_A_ROUTE_NETS=("10.20.0.0/24")
VPN_A_ROUTE_HOSTS=("10.20.1.10" "10.20.1.11")

# 连通性测试项: "描述|目标|类型|端口"
# 类型: public / tcp / domain
TESTS=(
    "公网访问|example.com|public|0"
    "VPN_A资源|10.20.0.5|tcp|80"
    "内网域名|intranet.example.com|domain|443"
)
```

**如何找到你的 `DETECT_SUBNET`**：连接 VPN 后执行 `ifconfig utunN`（N 从 0 试起），看 `inet` 行的 IP，取前两段。例如 `inet 10.8.1.5` 则 `DETECT_SUBNET="10.8"`。

**新增 VPN**：在 `VPN_NAMES` 追加名称，再定义对应的 `XXX_DETECT_SUBNET` / `XXX_ROUTE_NETS` / `XXX_ROUTE_HOSTS` 三组变量即可。

## 兼容性

- **平台**：仅 macOS（依赖 `ifconfig` / `networksetup` / `route`）
- **Shell**：兼容 macOS 自带 bash 3.2，无需安装新版 bash
- **权限**：`apply` / `clean` 需 `sudo`（修改路由和 DNS）；`status` / `test` 无需 sudo

## 注意事项

- 连接顺序建议：**先连会抢占默认路由的 VPN，再连另一个**，最后执行 `apply`
- `apply` 会修改路由表和 DNS，重启或重连 VPN 后路由可能失效，需重新执行
- 配置文件含内网信息，`~/.vpn_route.conf` 已被 `.gitignore` 忽略，不会误提交
- 仅供个人合法使用 VPN 管理网络路由，请遵守你所在组织的安全策略

## License

[MIT](LICENSE)
