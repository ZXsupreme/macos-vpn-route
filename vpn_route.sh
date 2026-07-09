#!/bin/bash
# =============================================================================
# 通用多 VPN 路由管理工具 (macOS)
# 依赖: ifconfig / networksetup / route / host / curl (均为 macOS 自带)
# 兼容: bash 3.2 (macOS 默认)
# =============================================================================
set -uo pipefail

# --- 颜色 ---
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

# --- 默认值 ---
CONF_FILE="${VPN_ROUTE_CONF:-$HOME/.vpn_route.conf}"
WIFI_SERVICE="Wi-Fi"
DNS_SERVERS=(); CLEANUP_NETS=(); CLEANUP_HOSTS=(); VPN_NAMES=(); TESTS=()

# --- 工具函数 ---
info() { echo -e "${BLUE}ℹ️  $*${NC}"; }
ok()   { echo -e "${GREEN}✅ $*${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $*${NC}"; }
err()  { echo -e "${RED}❌ $*${NC}"; }

usage() {
    cat <<EOF
用法: $(basename "$0") <子命令> [选项]

子命令:
  apply    识别VPN网卡 -> 设置DNS -> 清理旧路由 -> 添加新路由 -> 默认网关 -> 测试
  clean    清理所有已配置的旧路由
  test     仅运行连通性测试
  status   显示当前 VPN 网卡与路由状态

选项:
  -c FILE  指定配置文件 (默认 ~/.vpn_route.conf，或环境变量 VPN_ROUTE_CONF)
  -h       显示本帮助

示例:
  $(basename "$0") apply
  $(basename "$0") apply -c ~/my_vpn.conf
  $(basename "$0") test
  $(basename "$0") status
EOF
}

# 加载配置文件
load_config() {
    if [ ! -f "$CONF_FILE" ]; then
        err "配置文件不存在: $CONF_FILE"
        echo "  请复制 vpn_route.conf.example 为 ~/.vpn_route.conf 并修改"
        exit 1
    fi
    # shellcheck disable=SC1090
    source "$CONF_FILE"
    if [ "${#VPN_NAMES[@]}" -eq 0 ]; then
        err "配置文件中 VPN_NAMES 为空"; exit 1
    fi
}

# 大写转换 (bash 3.2 兼容，无 ${var^^})
upper() { echo "$1" | tr '[:lower:]' '[:upper:]'; }

# 读取 VPN 标量配置: vpn_var <name> <SUFFIX>
# 用 eval 而非 ${!var} 间接引用——bash 3.2 + set -u 下后者对未定义目标会报错
vpn_var() {
    local var; var="$(upper "$1")_$2"
    eval "printf '%s' \"\${${var}:-}\""
}

# 读取 VPN 数组配置到标准输出 (元素以空格连接): vpn_arr <name> <SUFFIX>
# eval 展开避免空数组间接引用触发 unbound variable；用 [*] 连接成单行
vpn_arr() {
    local var; var="$(upper "$1")_$2"
    eval "printf '%s' \"\${${var}[*]:-}\""
}

# 检测 VPN 网卡: detect_if <subnet_prefix>
detect_if() {
    local subnet=$1 i
    for i in {0..20}; do
        if ifconfig "utun$i" 2>/dev/null | grep -q "inet ${subnet}\."; then
            echo "utun$i"; return 0
        fi
    done
    return 1
}

# TCP 端口测试: check_port <ip> <port> [timeout]
check_port() {
    local ip=$1 port=$2 timeout=${3:-3}
    timeout "$timeout" bash -c "echo > /dev/tcp/$ip/$port" 2>/dev/null
}

# --- 子命令: status ---
do_status() {
    load_config
    echo -e "${BLUE}=== VPN 网卡识别 ===${NC}"
    for name in "${VPN_NAMES[@]}"; do
        local subnet ifname ip
        subnet=$(vpn_var "$name" DETECT_SUBNET)
        if ifname=$(detect_if "$subnet"); then
            ip=$(ifconfig "$ifname" 2>/dev/null | awk '/inet /{print $2}')
            ok "$name -> $ifname ($ip)"
        else
            warn "$name (网段 $subnet) 未检测到"
        fi
    done

    echo -e "\n${BLUE}=== 默认路由 ===${NC}"
    route -n get default 2>/dev/null | grep -E "interface|gateway" || warn "无默认路由"

    echo -e "\n${BLUE}=== VPN 相关路由 ===${NC}"
    for name in "${VPN_NAMES[@]}"; do
        local nets hosts h
        read -ra nets <<<"$(vpn_arr "$name" ROUTE_NETS)" || true
        read -ra hosts <<<"$(vpn_arr "$name" ROUTE_HOSTS)" || true
        echo "[$name]"
        for net in "${nets[@]:-}"; do
            [ -n "$net" ] || continue
            local iface
            iface=$(route -n get -net "$net" 2>/dev/null | awk '/interface:/{print $2}')
            echo "  $net -> ${iface:-未配置}"
        done
        for h in "${hosts[@]:-}"; do
            [ -n "$h" ] || continue
            local iface
            iface=$(route -n get -host "$h" 2>/dev/null | awk '/interface:/{print $2}')
            echo "  $h -> ${iface:-未配置}"
        done
    done
}

# --- 子命令: clean ---
do_clean() {
    load_config
    info "清理旧路由..."
    local n
    for n in "${CLEANUP_NETS[@]:-}"; do
        [ -n "$n" ] || continue
        sudo route delete -net "$n" 2>/dev/null && ok "删除网段 $n" || true
    done
    for n in "${CLEANUP_HOSTS[@]:-}"; do
        [ -n "$n" ] || continue
        sudo route delete -host "$n" 2>/dev/null && ok "删除主机 $n" || true
    done
    ok "清理完成"
}

# --- 子命令: apply ---
do_apply() {
    load_config

    # 1. 识别所有 VPN 网卡
    info "识别 VPN 网卡..."
    local missing=0 found_names=() found_ifs=()
    for name in "${VPN_NAMES[@]}"; do
        local subnet ifname
        subnet=$(vpn_var "$name" DETECT_SUBNET)
        if [ -z "$subnet" ]; then
            err "$name 未配置 DETECT_SUBNET"; missing=1; continue
        fi
        if ifname=$(detect_if "$subnet"); then
            ok "$name -> $ifname"
            found_names+=("$name"); found_ifs+=("$ifname")
        else
            err "$name (网段 $subnet) 未检测到，请确认 VPN 已连接"
            missing=1
        fi
    done
    [ $missing -ne 0 ] && { err "部分 VPN 未连接，终止"; exit 1; }

    # 2. DNS
    if [ "${#DNS_SERVERS[@]}" -gt 0 ]; then
        info "设置 DNS (${DNS_SERVERS[*]}) -> $WIFI_SERVICE"
        sudo networksetup -setdnsservers "$WIFI_SERVICE" "${DNS_SERVERS[@]}"
        ok "DNS 已设置"
    fi

    # 3. 清理旧路由
    info "清理旧路由..."
    local n
    for n in "${CLEANUP_NETS[@]:-}"; do
        [ -n "$n" ] || continue
        sudo route delete -net "$n" 2>/dev/null || true
    done
    for n in "${CLEANUP_HOSTS[@]:-}"; do
        [ -n "$n" ] || continue
        sudo route delete -host "$n" 2>/dev/null || true
    done
    ok "旧路由已清理"

    # 4. 添加路由
    local idx
    for idx in "${!found_names[@]}"; do
        local name="${found_names[$idx]}" ifname="${found_ifs[$idx]}"
        local nets hosts
        read -ra nets <<<"$(vpn_arr "$name" ROUTE_NETS)" || true
        read -ra hosts <<<"$(vpn_arr "$name" ROUTE_HOSTS)" || true
        info "添加 $name 路由 -> $ifname"
        local item
        for item in "${nets[@]:-}"; do
            [ -n "$item" ] || continue
            sudo route add -net "$item" -interface "$ifname" 2>/dev/null && ok "  $item" || warn "  $item (添加失败)"
        done
        for item in "${hosts[@]:-}"; do
            [ -n "$item" ] || continue
            sudo route add -host "$item" -interface "$ifname" 2>/dev/null && ok "  $item" || warn "  $item (添加失败)"
        done
    done

    # 5. 默认网关走物理 Wi-Fi
    info "修正默认网关..."
    local wifi_if wifi_gw
    wifi_if=$(networksetup -listallhardwareports | awk '/Wi-Fi/{getline; print $2}')
    wifi_gw=$(route -n get default -interface "$wifi_if" 2>/dev/null | awk '/gateway/{print $2}')
    if [ -n "$wifi_gw" ]; then
        sudo route delete default 2>/dev/null || true
        sudo route add default "$wifi_gw"
        ok "默认网关 -> $wifi_gw ($wifi_if)"
    else
        sudo route delete default 2>/dev/null || true
        sudo route add default -interface "$wifi_if"
        ok "默认网关 -> interface $wifi_if"
    fi

    echo -e "${GREEN}----------------------------------------${NC}"
    ok "路由配置完成，开始连通性测试"
    echo -e "${GREEN}----------------------------------------${NC}"

    # 6. 测试
    run_tests
}

# --- 测试逻辑 ---
test_public() {
    local target=$1
    if ping -c 2 -W 2 "$target" >/dev/null 2>&1; then
        ok "通过"
    elif curl -o /dev/null --silent --head --write-out '%{http_code}\n' -m 3 "https://$target" 2>/dev/null | grep -q '200'; then
        ok "通过 (ICMP受限但HTTP正常)"
    else
        err "失败 (请检查DNS或Wi-Fi网关)"
    fi
}

test_tcp() {
    local ip=$1 port=$2
    if check_port "$ip" "$port"; then
        ok "通过 (TCP $port 通畅)"
    elif ping -c 1 -W 1 "$ip" >/dev/null 2>&1; then
        warn "ICMP通但端口 $port 不通"
    else
        err "失败 (路由不通)"
    fi
}

test_domain() {
    local domain=$1 port=$2 ip
    ip=$(host "$domain" 2>/dev/null | awk '/has address/{print $4; exit}')
    [ -z "$ip" ] && ip=$(nslookup "$domain" 2>/dev/null | awk '/^Address: /{print $2}' | tail -1)
    if [ -z "$ip" ]; then
        err "解析失败 ($domain)"; return
    fi
    if [[ "$ip" == 10.* || "$ip" == 192.168.* || "$ip" == 172.16.* ]]; then
        if check_port "$ip" "${port:-443}" || check_port "$ip" 80; then
            ok "解析成功 ($ip) 内网TCP通畅"
        else
            err "解析成功 ($ip) 但路由不通"
        fi
    else
        if ping -c 1 -W 2 "$ip" >/dev/null 2>&1 || check_port "$ip" "${port:-443}"; then
            ok "解析成功 ($ip) 公网通畅"
        else
            err "解析成功 ($ip) 但不通"
        fi
    fi
}

run_tests() {
    if [ "${#TESTS[@]}" -eq 0 ]; then
        info "无测试项，跳过"; return
    fi
    info "连通性测试..."
    local i=1 t desc target kind port
    for t in "${TESTS[@]}"; do
        IFS='|' read -r desc target kind port <<<"$t"
        printf "%d. %-12s (%s): " "$i" "$desc" "$target"
        case "$kind" in
            public) test_public "$target" ;;
            tcp)    test_tcp "$target" "${port:-0}" ;;
            domain) test_domain "$target" "${port:-0}" ;;
            *)      err "未知测试类型: $kind" ;;
        esac
        i=$((i+1))
    done
    echo -e "${GREEN}----------------------------------------${NC}"
    ok "测试结束"
}

# --- 入口 ---
main() {
    local cmd="${1:-}"
    [ -z "$cmd" ] && { usage; exit 1; }
    case "$cmd" in
        -h|--help) usage; exit 0 ;;
        apply|clean|test|status) ;;
        *) err "未知子命令: $cmd"; usage; exit 1 ;;
    esac
    shift
    while getopts ":c:h" opt; do
        case $opt in
            c) CONF_FILE="$OPTARG" ;;
            h) usage; exit 0 ;;
            *) err "未知选项: -$OPTARG"; usage; exit 1 ;;
        esac
    done
    case "$cmd" in
        apply)  do_apply ;;
        clean)  do_clean ;;
        test)   load_config; run_tests ;;
        status) do_status ;;
    esac
}

main "$@"
