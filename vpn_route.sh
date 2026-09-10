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
JSON_MODE=0                       # --json 时置 1：stdout 只输出 JSONL，人类输出全部静默
SCRIPT_VERSION="2.2"

# --- 工具函数 ---
# JSON 模式下 info/ok/warn/err 与散落的格式化 echo 全部静默，保证 stdout 纯 JSONL
info() { [ "$JSON_MODE" -eq 1 ] && return 0; echo -e "${BLUE}ℹ️  $*${NC}"; }
ok()   { [ "$JSON_MODE" -eq 1 ] && return 0; echo -e "${GREEN}✅ $*${NC}"; }
warn() { [ "$JSON_MODE" -eq 1 ] && return 0; echo -e "${YELLOW}⚠️  $*${NC}"; }
err()  { [ "$JSON_MODE" -eq 1 ] && return 0; echo -e "${RED}❌ $*${NC}"; }
oute() { [ "$JSON_MODE" -eq 1 ] && return 0; echo -e "$1"; }   # 原 echo -e 的静默版

# --- JSON 输出 (bash 3.2 兼容，零外部依赖) ---
# 字符串字面量：参数展开四步替换，不用 sed/awk；UTF-8 中文直接透传 (JSON 规范允许)
# 值域护栏：所有值来自配置单行赋值或命令单行输出解析，无原始换行
json_str() {
    local s=$1
    s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\t'/\\t}; s=${s//$'\r'/\\r}; s=${s//$'\n'/\\n}
    printf '"%s"' "$s"
}
jbool() { [ "$1" -eq 0 ] && printf 'true' || printf 'false'; }
jstr()  { json_str "$1"; }          # 别名，事件拼装时可读性更好
now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# 数组元素拼为 JSON 数组：元素须经 json_str 转义后传入，如 jq_arr_val "$(json_str a)" "$(json_str b)"
json_arr() {
    local out="[" first=1 e
    for e in ${1+"$@"}; do
        [ $first -eq 1 ] && first=0 || out="$out,"
        out="$out$e"
    done
    printf '%s]' "$out"
}
# 输出一行 JSON 事件 (仅 JSON 模式)
emit() { [ "$JSON_MODE" -eq 1 ] || return 0; printf '%s\n' "$1"; }
emit_error() {   # emit_error <code> <message>
    emit "{\"event\":\"error\",\"code\":$(jstr "$1"),\"message\":$(jstr "$2")}"
}
# 字符串数组转 JSON 数组: json_str_array <e1> [e2 ...]
json_str_array() {
    local out="[" first=1 e
    for e in ${1+"$@"}; do
        [ $first -eq 1 ] && first=0 || out="$out,"
        out="$out$(jstr "$e")"
    done
    printf '%s]' "$out"
}
# 测试结果码转 JSON 词: result_word 0 -> "ok" / 1 -> "warn" / 其余 -> "fail"
result_word() { case "$1" in 0) printf '"ok"';; 1) printf '"warn"';; *) printf '"fail"';; esac; }

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
        emit_error "config_missing" "配置文件不存在: $CONF_FILE"
        err "配置文件不存在: $CONF_FILE"
        if [ "$JSON_MODE" -eq 0 ]; then
            echo "  请复制 vpn_route.conf.example 为 ~/.vpn_route.conf 并修改"
        fi
        exit 2
    fi
    # shellcheck disable=SC1090
    source "$CONF_FILE"
    if [ "${#VPN_NAMES[@]}" -eq 0 ]; then
        emit_error "config_empty" "配置文件中 VPN_NAMES 为空"
        err "配置文件中 VPN_NAMES 为空"; exit 2
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

# 检测 VPN 网卡: detect_if <vpn_name>
# 依次尝试 DETECT_INET6 (IPv6 地址前缀，最稳定) / DETECT_SUBNET (IPv4 网段前缀)
# 任一命中即输出 "<method>:<iface>" (method 为 inet6/subnet，供 JSON 事件使用)；两者都未配置时报错
# 输出只被 $(...) 捕获，人类可读输出不受影响
detect_if() {
    local name=$1 subnet marker i
    subnet=$(vpn_var "$name" DETECT_SUBNET)
    marker=$(vpn_var "$name" DETECT_INET6)
    if [ -z "$subnet" ] && [ -z "$marker" ]; then
        echo "detect_if: $name 未配置 DETECT_INET6 / DETECT_SUBNET" >&2
        return 1
    fi
    for i in {0..20}; do
        if [ -n "$marker" ] && ifconfig "utun$i" 2>/dev/null | grep -q "inet6 ${marker}"; then
            echo "inet6:utun$i"; return 0
        fi
        if [ -n "$subnet" ] && ifconfig "utun$i" 2>/dev/null | grep -q "inet ${subnet}\."; then
            echo "subnet:utun$i"; return 0
        fi
    done
    return 1
}

# 拆出网卡名: iface_of "inet6:utun5" -> "utun5"
iface_of() { printf '%s' "${1##*:}"; }
# 拆出命中方式: method_of "inet6:utun5" -> "inet6"
method_of() { printf '%s' "${1%%:*}"; }

# TCP 端口测试: check_port <ip> <port> [timeout]
# 优先自带 nc (macOS OpenBSD nc，-w 连接超时)；无 nc 时退化到 /dev/tcp + 后台 kill 计时
# (macOS 无 GNU timeout 命令，不能依赖)
check_port() {
    local ip=$1 port=$2 tmo=${3:-3}
    if command -v nc >/dev/null 2>&1; then
        nc -z -w "$tmo" "$ip" "$port" 2>/dev/null
    else
        ( bash -c "exec 3<>/dev/tcp/$ip/$port" 2>/dev/null ) & local p=$!
        ( sleep "$tmo"; kill "$p" 2>/dev/null ) & local w=$!
        wait "$p" 2>/dev/null; local r=$?
        kill "$w" 2>/dev/null
        return $r
    fi
}

# 拼接路由 JSON 片段 (供 status 事件): append_route_json <已有片段> <kind> <target> <expected> <actual>
# expected 为空表示 VPN 未检测到 (此时 ok 恒 false)；actual 为空表示路由不存在 (JSON null)
append_route_json() {
    local parts=$1 kind=$2 target=$3 expected=$4 actual=$5
    local okf="false" exp_j="null" act_j="null"
    [ -n "$expected" ] && [ "$expected" = "$actual" ] && okf="true"
    [ -n "$expected" ] && exp_j=$(jstr "$expected")
    [ -n "$actual" ] && act_j=$(jstr "$actual")
    local obj="{\"target\":$(jstr "$target"),\"kind\":$(jstr "$kind"),\"expected\":$exp_j,\"actual\":$act_j,\"ok\":$okf}"
    if [ -n "$parts" ]; then printf '%s,%s' "$parts" "$obj"; else printf '%s' "$obj"; fi
}

# --- 子命令: status ---
do_status() {
    load_config
    # JSON 收集容器 (bash 3.2 无关联数组，按 VPN_NAMES 索引平行展开)
    local j_hits=() j_ipv4=() j_ipv6=() j_routes=()
    oute "${BLUE}=== VPN 网卡识别 ===${NC}"
    for name in "${VPN_NAMES[@]}"; do
        local subnet ifname ip hit inet6_all v6
        subnet=$(vpn_var "$name" DETECT_SUBNET)
        if hit=$(detect_if "$name"); then
            ifname=$(iface_of "$hit")
            ip=$(ifconfig "$ifname" 2>/dev/null | awk '/inet /{print $2}')
            ok "$name -> $ifname ($ip)"
            inet6_all=$(ifconfig "$ifname" 2>/dev/null | awk '/inet6 /{print $2}')
            v6=$(printf '%s\n' "$inet6_all" | grep -v '^fe80' | head -1)
            [ -z "$v6" ] && v6=$(printf '%s\n' "$inet6_all" | head -1)
            j_hits+=("$hit"); j_ipv4+=("$ip"); j_ipv6+=("$v6")
        else
            warn "$name (网段 $subnet) 未检测到"
            j_hits+=(""); j_ipv4+=(""); j_ipv6+=("")
        fi
        j_routes+=("")
    done

    oute "\n${BLUE}=== 默认路由 ===${NC}"
    if [ "$JSON_MODE" -eq 0 ]; then
        route -n get default 2>/dev/null | grep -E "interface|gateway" || warn "无默认路由"
    fi
    local dr_if="" dr_gw=""
    dr_if=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
    dr_gw=$(route -n get default 2>/dev/null | awk '/gateway:/{print $2}')

    oute "\n${BLUE}=== VPN 相关路由 ===${NC}"
    local idx=0
    for name in "${VPN_NAMES[@]}"; do
        local nets hosts h expected="" rparts=""
        read -ra nets <<<"$(vpn_arr "$name" ROUTE_NETS)" || true
        read -ra hosts <<<"$(vpn_arr "$name" ROUTE_HOSTS)" || true
        [ "$JSON_MODE" -eq 1 ] || echo "[$name]"
        [ -n "${j_hits[$idx]:-}" ] && expected=$(iface_of "${j_hits[$idx]}")
        for net in "${nets[@]:-}"; do
            [ -n "$net" ] || continue
            local iface
            iface=$(route -n get -net "$net" 2>/dev/null | awk '/interface:/{print $2}')
            [ "$JSON_MODE" -eq 1 ] || echo "  $net -> ${iface:-未配置}"
            rparts=$(append_route_json "$rparts" net "$net" "$expected" "$iface")
        done
        for h in "${hosts[@]:-}"; do
            [ -n "$h" ] || continue
            local iface
            iface=$(route -n get -host "$h" 2>/dev/null | awk '/interface:/{print $2}')
            [ "$JSON_MODE" -eq 1 ] || echo "  $h -> ${iface:-未配置}"
            rparts=$(append_route_json "$rparts" host "$h" "$expected" "$iface")
        done
        j_routes[$idx]="$rparts"
        idx=$((idx+1))
    done

    # JSON: 单行 status 事件。bash 只报事实，综合健康状态由客户端派生 (逻辑单源)
    if [ "$JSON_MODE" -eq 1 ]; then
        local vpns="" all_detected=true
        for idx in "${!VPN_NAMES[@]}"; do
            local hit="${j_hits[$idx]:-}" det="false" if_j="null" ip_j="null" v6_j="null" m2j="null"
            if [ -n "$hit" ]; then
                det="true"
                if_j=$(jstr "$(iface_of "$hit")")
                m2j=$(jstr "$(method_of "$hit")")
                [ -n "${j_ipv4[$idx]:-}" ] && ip_j=$(jstr "${j_ipv4[$idx]}")
                [ -n "${j_ipv6[$idx]:-}" ] && v6_j=$(jstr "${j_ipv6[$idx]}")
            else
                all_detected=false
            fi
            local vobj="{\"name\":$(jstr "${VPN_NAMES[$idx]}"),\"detected\":$det,\"method\":$m2j,\"interface\":$if_j,\"ipv4\":$ip_j,\"ipv6\":$v6_j,\"routes\":[${j_routes[$idx]:-}]}"
            if [ -n "$vpns" ]; then vpns="$vpns,$vobj"; else vpns="$vobj"; fi
        done
        local dr_j="null"
        if [ -n "$dr_if$dr_gw" ]; then
            dr_j="{\"interface\":$(jstr "$dr_if"),\"gateway\":$(jstr "$dr_gw")}"
        fi
        emit "{\"event\":\"status\",\"ts\":\"$(now_utc)\",\"schema\":1,\"conf\":$(jstr "$CONF_FILE"),\"vpns\":[$vpns],\"default_route\":$dr_j,\"all_detected\":$all_detected}"
    fi
}

# JSON 事件辅助 (apply/clean 用)
emit_route() {   # emit_route <action> <vpn|""> <kind> <target> <iface|""> <true|false>
    local vpn_j="null" if_j="null"
    [ -n "$2" ] && vpn_j=$(jstr "$2")
    [ -n "$5" ] && if_j=$(jstr "$5")
    emit "{\"event\":\"route\",\"action\":$(jstr "$1"),\"vpn\":$vpn_j,\"kind\":$(jstr "$3"),\"target\":$(jstr "$4"),\"interface\":$if_j,\"ok\":$6}"
}
emit_phase() {   # emit_phase <step> <true|false> <detail>
    emit "{\"event\":\"phase\",\"step\":$(jstr "$1"),\"ok\":$2,\"detail\":$(jstr "$3")}"
}

# --- 子命令: clean ---
do_clean() {
    load_config
    emit "{\"event\":\"clean_start\"}"
    info "清理旧路由..."
    local n
    for n in "${CLEANUP_NETS[@]:-}"; do
        [ -n "$n" ] || continue
        if sudo route delete -net "$n" 2>/dev/null; then
            ok "删除网段 $n"
            emit_route delete "" net "$n" "" true
        else
            emit_route delete "" net "$n" "" false
        fi
    done
    for n in "${CLEANUP_HOSTS[@]:-}"; do
        [ -n "$n" ] || continue
        if sudo route delete -host "$n" 2>/dev/null; then
            ok "删除主机 $n"
            emit_route delete "" host "$n" "" true
        else
            emit_route delete "" host "$n" "" false
        fi
    done

    # DNS 还原：仅在没有任何 VPN 在线时执行（VPN 客户端常把 Wi-Fi DNS 改成内网 DNS，
    # 全断后若不还原，内网 DNS 失联会连累公网解析）。Empty = 清除手动 DNS，回落 DHCP。
    local any_vpn=0 dname
    for dname in "${VPN_NAMES[@]}"; do
        if detect_if "$dname" >/dev/null 2>&1; then any_vpn=1; break; fi
    done
    if [ "$any_vpn" -eq 0 ] && [ -n "$WIFI_SERVICE" ]; then
        if sudo networksetup -setdnsservers "$WIFI_SERVICE" Empty 2>/dev/null; then
            ok "DNS 已还原为自动获取 (DHCP)"
            emit_phase dns-reset true "已清除手动 DNS -> $WIFI_SERVICE"
        else
            warn "DNS 还原失败"
            emit_phase dns-reset false "networksetup 执行失败"
        fi
    fi

    ok "清理完成"
    emit "{\"event\":\"clean_end\",\"ok\":true}"
}

# --- 子命令: apply ---
do_apply() {
    load_config
    emit "{\"event\":\"apply_start\",\"vpn_count\":${#VPN_NAMES[@]}}"

    # 1. 识别所有 VPN 网卡
    info "识别 VPN 网卡..."
    local missing=0 found_names=() found_ifs=() missing_names=()
    for name in "${VPN_NAMES[@]}"; do
        local subnet ifname hit
        subnet=$(vpn_var "$name" DETECT_SUBNET)
        if [ -z "$subnet" ] && [ -z "$(vpn_var "$name" DETECT_INET6)" ]; then
            err "$name 未配置 DETECT_INET6 / DETECT_SUBNET"; missing=1; missing_names+=("$name")
            emit_error "detect_unconfigured" "$name 未配置 DETECT_INET6 / DETECT_SUBNET"
            emit "{\"event\":\"detect\",\"vpn\":$(jstr "$name"),\"ok\":false,\"method\":null,\"interface\":null}"
            continue
        fi
        if hit=$(detect_if "$name"); then
            ifname=$(iface_of "$hit")
            ok "$name -> $ifname"
            found_names+=("$name"); found_ifs+=("$ifname")
            emit "{\"event\":\"detect\",\"vpn\":$(jstr "$name"),\"ok\":true,\"method\":$(jstr "$(method_of "$hit")"),\"interface\":$(jstr "$ifname")}"
        else
            err "$name (网段 $subnet) 未检测到，请确认 VPN 已连接"
            missing=1; missing_names+=("$name")
            emit "{\"event\":\"detect\",\"vpn\":$(jstr "$name"),\"ok\":false,\"method\":null,\"interface\":null}"
        fi
    done
    if [ $missing -ne 0 ]; then
        emit "{\"event\":\"apply_abort\",\"reason\":\"missing_vpn\",\"missing\":$(json_str_array ${missing_names[@]+"${missing_names[@]}"})}"
        err "部分 VPN 未连接，终止"; exit 3
    fi

    # 2. DNS
    if [ "${#DNS_SERVERS[@]}" -gt 0 ]; then
        info "设置 DNS (${DNS_SERVERS[*]}) -> $WIFI_SERVICE"
        local dns_ok=true
        sudo networksetup -setdnsservers "$WIFI_SERVICE" "${DNS_SERVERS[@]}" || dns_ok=false
        ok "DNS 已设置"
        emit_phase dns "$dns_ok" "(${DNS_SERVERS[*]}) -> $WIFI_SERVICE"
    fi

    # 3. 清理旧路由
    info "清理旧路由..."
    local n
    for n in "${CLEANUP_NETS[@]:-}"; do
        [ -n "$n" ] || continue
        if sudo route delete -net "$n" 2>/dev/null; then emit_route delete "" net "$n" "" true; else emit_route delete "" net "$n" "" false; fi
    done
    for n in "${CLEANUP_HOSTS[@]:-}"; do
        [ -n "$n" ] || continue
        if sudo route delete -host "$n" 2>/dev/null; then emit_route delete "" host "$n" "" true; else emit_route delete "" host "$n" "" false; fi
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
            if sudo route add -net "$item" -interface "$ifname" 2>/dev/null; then
                ok "  $item"
                emit_route add "$name" net "$item" "$ifname" true
            else
                warn "  $item (添加失败)"
                emit_route add "$name" net "$item" "$ifname" false
            fi
        done
        for item in "${hosts[@]:-}"; do
            [ -n "$item" ] || continue
            if sudo route add -host "$item" -interface "$ifname" 2>/dev/null; then
                ok "  $item"
                emit_route add "$name" host "$item" "$ifname" true
            else
                warn "  $item (添加失败)"
                emit_route add "$name" host "$item" "$ifname" false
            fi
        done
    done

    # 5. 默认网关走物理 Wi-Fi
    info "修正默认网关..."
    local wifi_if wifi_gw gw_ok
    wifi_if=$(networksetup -listallhardwareports | awk '/Wi-Fi/{getline; print $2}')
    wifi_gw=$(route -n get default -interface "$wifi_if" 2>/dev/null | awk '/gateway/{print $2}')
    if [ -n "$wifi_gw" ]; then
        sudo route delete default 2>/dev/null || true
        gw_ok=true
        sudo route add default "$wifi_gw" || gw_ok=false
        ok "默认网关 -> $wifi_gw ($wifi_if)"
        emit_phase gateway "$gw_ok" "$wifi_gw ($wifi_if)"
    else
        sudo route delete default 2>/dev/null || true
        gw_ok=true
        sudo route add default -interface "$wifi_if" || gw_ok=false
        ok "默认网关 -> interface $wifi_if"
        emit_phase gateway "$gw_ok" "interface $wifi_if"
    fi

    oute "${GREEN}----------------------------------------${NC}"
    ok "路由配置完成，开始连通性测试"
    oute "${GREEN}----------------------------------------${NC}"
    emit "{\"event\":\"apply_end\",\"ok\":true}"

    # 6. 测试
    run_tests
    emit "{\"event\":\"summary\",\"op\":\"apply\",\"apply_ok\":true,\"passed\":$T_PASSED,\"warned\":$T_WARNED,\"failed\":$T_FAILED,\"ok\":$([ "$T_FAILED" -eq 0 ] && printf true || printf false)}"
}

# --- 测试逻辑 ---
# 测试函数不直接打印，改为设置 RESULT_CODE (0=ok/1=warn/2=fail) 与 RESULT_DETAIL 并以
# RESULT_CODE 为返回码；人类输出由 run_tests 统一打印（文案与此处逐字一致，JSON 事件同源）
test_public() {
    local target=$1
    if ping -c 2 -W 2 "$target" >/dev/null 2>&1; then
        RESULT_CODE=0; RESULT_DETAIL="通过"
    elif curl -o /dev/null --silent --head --write-out '%{http_code}\n' -m 3 "https://$target" 2>/dev/null | grep -q '200'; then
        RESULT_CODE=0; RESULT_DETAIL="通过 (ICMP受限但HTTP正常)"
    else
        RESULT_CODE=2; RESULT_DETAIL="失败 (请检查DNS或Wi-Fi网关)"
    fi
    return "$RESULT_CODE"
}

test_tcp() {
    local ip=$1 port=$2
    if check_port "$ip" "$port"; then
        RESULT_CODE=0; RESULT_DETAIL="通过 (TCP $port 通畅)"
    elif ping -c 1 -W 1 "$ip" >/dev/null 2>&1; then
        RESULT_CODE=1; RESULT_DETAIL="ICMP通但端口 $port 不通"
    else
        RESULT_CODE=2; RESULT_DETAIL="失败 (路由不通)"
    fi
    return "$RESULT_CODE"
}

test_domain() {
    local domain=$1 port=$2 ip
    # 解析优先级: dscacheutil (系统解析器，含 /etc/hosts) -> host -> nslookup
    # (host/nslookup 是纯 DNS 工具，会绕过 hosts 文件，内网域名固定会解析失败)
    ip=$(dscacheutil -q host -a name "$domain" 2>/dev/null | awk '/^ip_address:/ && $2 ~ /\./ {print $2; exit}')
    [ -z "$ip" ] && ip=$(host "$domain" 2>/dev/null | awk '/has address/{print $4; exit}')
    [ -z "$ip" ] && ip=$(nslookup "$domain" 2>/dev/null | awk '/^Address: /{print $2}' | tail -1)
    if [ -z "$ip" ]; then
        RESULT_CODE=2; RESULT_DETAIL="解析失败 ($domain)"
        return 2
    fi
    if [[ "$ip" == 10.* || "$ip" == 192.168.* || "$ip" == 172.16.* ]]; then
        if check_port "$ip" "${port:-443}" || check_port "$ip" 80; then
            RESULT_CODE=0; RESULT_DETAIL="解析成功 ($ip) 内网TCP通畅"
        else
            RESULT_CODE=2; RESULT_DETAIL="解析成功 ($ip) 但路由不通"
        fi
    else
        if ping -c 1 -W 2 "$ip" >/dev/null 2>&1 || check_port "$ip" "${port:-443}"; then
            RESULT_CODE=0; RESULT_DETAIL="解析成功 ($ip) 公网通畅"
        else
            RESULT_CODE=2; RESULT_DETAIL="解析成功 ($ip) 但不通"
        fi
    fi
    return "$RESULT_CODE"
}

run_tests() {
    T_PASSED=0; T_WARNED=0; T_FAILED=0
    if [ "${#TESTS[@]}" -eq 0 ]; then
        info "无测试项，跳过"
        emit "{\"event\":\"test_start\",\"count\":0}"
        emit "{\"event\":\"test_end\",\"passed\":0,\"warned\":0,\"failed\":0,\"ok\":true}"
        return
    fi
    info "连通性测试..."
    emit "{\"event\":\"test_start\",\"count\":${#TESTS[@]}}"
    local i=1 t desc target kind port t0 secs rc pnum
    for t in "${TESTS[@]}"; do
        IFS='|' read -r desc target kind port <<<"$t"
        [ "$JSON_MODE" -eq 1 ] || printf "%d. %-12s (%s): " "$i" "$desc" "$target"
        t0=$SECONDS
        case "$kind" in
            public) test_public "$target"; rc=$? ;;
            tcp)    test_tcp "$target" "${port:-0}"; rc=$? ;;
            domain) test_domain "$target" "${port:-0}"; rc=$? ;;
            *)      RESULT_CODE=2; RESULT_DETAIL="未知测试类型: $kind"; rc=2 ;;
        esac
        secs=$((SECONDS - t0))
        case "$rc" in
            0) ok "$RESULT_DETAIL"; T_PASSED=$((T_PASSED+1)) ;;
            1) warn "$RESULT_DETAIL"; T_WARNED=$((T_WARNED+1)) ;;
            *) err "$RESULT_DETAIL"; T_FAILED=$((T_FAILED+1)) ;;
        esac
        pnum="${port:-0}"
        case "$pnum" in ''|*[!0-9]*) pnum=0 ;; esac   # 端口非法/为空时置 0，保证 JSON 数字合法
        emit "{\"event\":\"test_item\",\"index\":$i,\"desc\":$(jstr "$desc"),\"target\":$(jstr "$target"),\"kind\":$(jstr "$kind"),\"port\":$pnum,\"result\":$(result_word "$rc"),\"detail\":$(jstr "$RESULT_DETAIL"),\"seconds\":$secs}"
        i=$((i+1))
    done
    oute "${GREEN}----------------------------------------${NC}"
    ok "测试结束"
    emit "{\"event\":\"test_end\",\"passed\":$T_PASSED,\"warned\":$T_WARNED,\"failed\":$T_FAILED,\"ok\":$([ "$T_FAILED" -eq 0 ] && printf true || printf false)}"
}

# --- 入口 ---
main() {
    # 全局 --json 标志：位置不限，先扫描剔除再解析子命令
    # (bash 3.2 + set -u 下空数组展开须用 ${arr[@]+"${arr[@]}"} 防御)
    local newargs=() a
    for a in "$@"; do
        if [ "$a" = "--json" ]; then JSON_MODE=1; else newargs+=("$a"); fi
    done
    set -- ${newargs[@]+"${newargs[@]}"}

    local cmd="${1:-}"
    [ -z "$cmd" ] && { usage; exit 1; }
    case "$cmd" in
        -h|--help) usage; exit 0 ;;
        apply|clean|test|status) ;;
        *) err "未知子命令: $cmd"; usage; exit 1 ;;
    esac
    emit "{\"event\":\"hello\",\"schema\":1,\"script_version\":$(jstr "$SCRIPT_VERSION")}"
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
        test)
            load_config; run_tests
            if [ "$JSON_MODE" -eq 1 ]; then
                emit "{\"event\":\"summary\",\"op\":\"test\",\"apply_ok\":null,\"passed\":$T_PASSED,\"warned\":$T_WARNED,\"failed\":$T_FAILED,\"ok\":$([ "$T_FAILED" -eq 0 ] && printf true || printf false)}"
            fi ;;
        status) do_status ;;
    esac
}

main "$@"
