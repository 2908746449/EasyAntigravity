/*
 * proxyhook.c — EasyAntigravity macOS no-TUN proxy interposer
 *
 * macOS 上 version.dll(winsock hook) 的严格等价物。
 * 通过 DYLD 注入到 Antigravity 的子进程（主要是 Resources/bin/language_server），
 * 在 libsystem 层拦截 connect() / getaddrinfo()，把出站 TCP 透明重定向到本地
 * SOCKS5 代理，并用远端 DNS（把域名交给代理解析，规避本地污染）。
 *
 * 注入前提（原版二进制带 hardened runtime，会剥离 DYLD_*）：
 *   目标 Mach-O 需重签并带上
 *     com.apple.security.cs.allow-dyld-environment-variables
 *     com.apple.security.cs.disable-library-validation
 *   scripts/apply-dyld.sh 已自动处理。
 *
 * 为什么不用 dlsym(RTLD_NEXT) 取真身：
 *   dyld 默认开启 dlsym interposing，静态插桩后 dlsym(RTLD_NEXT, "connect")
 *   会返回我们自己的实现 → 无限递归 → SIGSEGV。
 *   dlopen + dlsym、DYLD_DISABLE_DLSYM_INTERPOSING 均无效（实测）。
 *   改用 NSLookupSymbolInImage()：在指定镜像内直接查符号，绕开 dlsym。
 *
 * 为什么不用 dyld_dynamic_interpose()：
 *   实测可拿到真身地址，但对已解析的 chained fixup 调用点不重绑，拦截不生效。
 *
 * 配置来源（按优先级）：
 *   $EASYG_PROXY        "host:port"，如 127.0.0.1:7890
 *   $EASYG_CONF         JSON 配置文件路径（读 proxy.host / proxy.port / proxy_rules.bypass）
 *   $EASYG_LOG          日志文件路径（可选）
 *   $EASYG_UDP_BLOCK    "1" 时阻断公网 UDP 443/80（逼 Chromium 从 QUIC 回落 TCP）
 *
 * 设计原则：任何异常都回落到真实系统调用，绝不阻断宿主进程。
 */

#define _DARWIN_C_SOURCE 1

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <sys/types.h>
#include <mach-o/dyld.h>
#include <unistd.h>

/* ------------------------------------------------------------------ */
/* 真身符号解析：绕开 dyld 的 dlsym interposing                        */
/* ------------------------------------------------------------------ */
static void *eag_real_symbol(const char *name) {
    char want[160];
    snprintf(want, sizeof(want), "_%s", name);
    uint32_t n = _dyld_image_count();
    for (uint32_t i = 0; i < n; i++) {
        const char *iname = _dyld_get_image_name(i);
        if (!iname || !strstr(iname, "libsystem")) continue;
        const struct mach_header *mh = _dyld_get_image_header(i);
        if (!mh) continue;
        NSSymbol s = NSLookupSymbolInImage(
            mh, want,
            NSLOOKUPSYMBOLINIMAGE_OPTION_BIND |
                NSLOOKUPSYMBOLINIMAGE_OPTION_RETURN_ON_ERROR);
        if (!s) continue;
        void *addr = NSAddressOfSymbol(s);
        if (addr) return addr;
    }
    return NULL;
}

/* ------------------------------------------------------------------ */
/* 原始函数指针                                                        */
/* ------------------------------------------------------------------ */
static int (*real_connect)(int, const struct sockaddr *, socklen_t) = NULL;
static int (*real_getaddrinfo)(const char *, const char *,
                               const struct addrinfo *,
                               struct addrinfo **) = NULL;

static pthread_once_t g_once = PTHREAD_ONCE_INIT;
static volatile int   g_ready = 0;
/* 初始化期间重入保护：构造函数里若间接触发 connect，直接走真身 */
static __thread int   t_in_init = 0;

/* 前置声明：构造函数里需要取地址 */
static int eag_connect(int fd, const struct sockaddr *addr, socklen_t len);
static int eag_getaddrinfo(const char *node, const char *service,
                           const struct addrinfo *hints,
                           struct addrinfo **res);

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */
typedef struct {
    int   enabled;
    char  proxy_host[64];
    int   proxy_port;
    int   log_enabled;
    char  log_path[512];
    int   udp_block;
    int   dns_remote;      /* 1 = 把域名交给代理解析 */
    int   timeout_ms;
} eag_conf_t;

static eag_conf_t g_cfg;
static int        g_proxy_in  = 0;   /* 预解析的代理 IPv4 */
static int        g_proxy_in6 = 0;   /* 预解析的代理 IPv6 */

/* ------------------------------------------------------------------ */
/* 日志（无锁原子追加，失败即静默）                                    */
/* ------------------------------------------------------------------ */
static void eag_log(const char *fmt, ...) {
    if (!g_cfg.log_enabled) return;
    int fd = open(g_cfg.log_path, O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd < 0) return;
    char buf[1024];
    struct timeval tv;
    gettimeofday(&tv, NULL);
    struct tm tm;
    time_t sec = tv.tv_sec;
    localtime_r(&sec, &tm);
    int n = snprintf(buf, sizeof(buf), "[%02d:%02d:%02d.%03d][pid %d] ",
                     tm.tm_hour, tm.tm_min, tm.tm_sec, (int)(tv.tv_usec / 1000),
                     (int)getpid());
    va_list ap;
    va_start(ap, fmt);
    int m = vsnprintf(buf + n, sizeof(buf) - n - 2, fmt, ap);
    va_end(ap);
    if (m > 0) n += m;
    if (n < (int)sizeof(buf) - 1) buf[n++] = '\n';
    ssize_t ignored = write(fd, buf, (size_t)n);
    (void)ignored;
    close(fd);
}

/* ------------------------------------------------------------------ */
/* 极简 JSON 取值（只为读自己的配置文件，不做通用解析）                 */
/* ------------------------------------------------------------------ */
static int json_find(const char *s, const char *key, char *out, size_t cap) {
    char pat[128];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(s, pat);
    if (!p) return 0;
    p = strchr(p + strlen(pat), ':');
    if (!p) return 0;
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p == '"') {
        p++;
        const char *e = strchr(p, '"');
        if (!e) return 0;
        size_t l = (size_t)(e - p);
        if (l >= cap) l = cap - 1;
        memcpy(out, p, l);
        out[l] = 0;
        return 1;
    }
    const char *e = p;
    while (*e && *e != ',' && *e != '}' && *e != '\n') e++;
    size_t l = (size_t)(e - p);
    while (l > 0 && (p[l - 1] == ' ' || p[l - 1] == '\r')) l--;
    if (l >= cap) l = cap - 1;
    memcpy(out, p, l);
    out[l] = 0;
    return 1;
}

/* 从 config.json 里找 proxy 段内的 host/port */
static void json_read_proxy(const char *s, char *host, size_t hcap, int *port) {
    const char *p = strstr(s, "\"proxy\"");
    if (!p) return;
    const char *end = strchr(p, '}');
    if (!end) return;
    size_t span = (size_t)(end - p);
    char sub[1024];
    if (span >= sizeof(sub)) span = sizeof(sub) - 1;
    memcpy(sub, p, span);
    sub[span] = 0;

    char tmp[64];
    if (json_find(sub, "host", tmp, sizeof(tmp))) {
        snprintf(host, hcap, "%s", tmp);
    }
    if (json_find(sub, "port", tmp, sizeof(tmp))) {
        int v = atoi(tmp);
        if (v > 0 && v < 65536) *port = v;
    }
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */
static void parse_endpoint(const char *spec) {
    const char *colon = strrchr(spec, ':');
    if (!colon) return;
    size_t hl = (size_t)(colon - spec);
    if (hl == 0 || hl >= sizeof(g_cfg.proxy_host)) return;
    memcpy(g_cfg.proxy_host, spec, hl);
    g_cfg.proxy_host[hl] = 0;
    int v = atoi(colon + 1);
    if (v > 0 && v < 65536) g_cfg.proxy_port = v;
}

static void eag_init(void) {
    t_in_init = 1;
    memset(&g_cfg, 0, sizeof(g_cfg));
    g_cfg.enabled    = 1;
    g_cfg.dns_remote = 1;
    g_cfg.udp_block  = 1;
    g_cfg.timeout_ms = 5000;
    snprintf(g_cfg.proxy_host, sizeof(g_cfg.proxy_host), "127.0.0.1");
    g_cfg.proxy_port = 7890;

    const char *conf = getenv("EASYG_CONF");
    if (conf && *conf) {
        int fd = open(conf, O_RDONLY);
        if (fd >= 0) {
            char *buf = (char *)malloc(65536);
            if (buf) {
                ssize_t n = read(fd, buf, 65535);
                if (n > 0) {
                    buf[n] = 0;
                    json_read_proxy(buf, g_cfg.proxy_host,
                                    sizeof(g_cfg.proxy_host), &g_cfg.proxy_port);
                    char tmp[32];
                    if (json_find(buf, "dns_mode", tmp, sizeof(tmp))) {
                        g_cfg.dns_remote = (strcmp(tmp, "remote") == 0);
                    }
                    if (json_find(buf, "udp_mode", tmp, sizeof(tmp))) {
                        g_cfg.udp_block = (strcmp(tmp, "block") == 0);
                    }
                    if (json_find(buf, "log_level", tmp, sizeof(tmp))) {
                        g_cfg.log_enabled = (strcmp(tmp, "off") != 0 &&
                                             strcmp(tmp, "silent") != 0);
                    }
                }
                free(buf);
            }
            close(fd);
        }
    }

    const char *spec = getenv("EASYG_PROXY");
    if (spec && *spec) parse_endpoint(spec);

    const char *lp = getenv("EASYG_LOG");
    if (lp && *lp) {
        snprintf(g_cfg.log_path, sizeof(g_cfg.log_path), "%s", lp);
        g_cfg.log_enabled = 1;
    }
    const char *ub = getenv("EASYG_UDP_BLOCK");
    if (ub && *ub) g_cfg.udp_block = (ub[0] == '1');
    const char *dis = getenv("EASYG_DISABLE");
    if (dis && dis[0] == '1') g_cfg.enabled = 0;

    struct in_addr a4;
    if (inet_pton(AF_INET, g_cfg.proxy_host, &a4) == 1) {
        g_proxy_in = (int)a4.s_addr;
    }
    struct in6_addr a6;
    if (inet_pton(AF_INET6, g_cfg.proxy_host, &a6) == 1) {
        memcpy(&g_proxy_in6, &a6, sizeof(g_proxy_in6));
    }

    /* 取真身：必须用 NSLookupSymbolInImage，dlsym 会被 interposing 打回自身 */
    real_connect     = (int (*)(int, const struct sockaddr *, socklen_t))
                           eag_real_symbol("connect");
    real_getaddrinfo = (int (*)(const char *, const char *,
                                const struct addrinfo *, struct addrinfo **))
                           eag_real_symbol("getaddrinfo");

    g_ready = 1;
    eag_log("init proxy=%s:%d dns_remote=%d udp_block=%d conf=%s real_connect=%p real_gai=%p",
            g_cfg.proxy_host, g_cfg.proxy_port,
            g_cfg.dns_remote, g_cfg.udp_block, conf ? conf : "(none)",
            (void *)real_connect, (void *)real_getaddrinfo);
    t_in_init = 0;
}

static inline void eag_ensure(void) {
    if (g_ready) return;
    pthread_once(&g_once, eag_init);
}

/* ------------------------------------------------------------------ */
/* getaddrinfo → IP 映射缓存（用于把域名回传给代理解析）               */
/* ------------------------------------------------------------------ */
#define HC_BUCKETS 512
#define HC_KEYLEN  46
#define HC_NAMELEN 256

typedef struct hc_entry {
    struct hc_entry *next;
    char ip[HC_KEYLEN];
    char name[HC_NAMELEN];
} hc_entry_t;

static hc_entry_t *g_hc[HC_BUCKETS];
static pthread_mutex_t g_hc_lock = PTHREAD_MUTEX_INITIALIZER;

static unsigned hc_hash(const char *s) {
    unsigned h = 5381;
    while (*s) h = h * 33u + (unsigned char)*s++;
    return h % HC_BUCKETS;
}

static void hc_put(const char *ip, const char *name) {
    if (!ip || !name || !*ip || !*name) return;
    if (strlen(ip) >= HC_KEYLEN || strlen(name) >= HC_NAMELEN) return;
    /* 纯 IP 字面量没有映射价值 */
    struct in_addr t4;
    struct in6_addr t6;
    if (inet_pton(AF_INET, name, &t4) == 1) return;
    if (inet_pton(AF_INET6, name, &t6) == 1) return;

    pthread_mutex_lock(&g_hc_lock);
    unsigned b = hc_hash(ip);
    for (hc_entry_t *e = g_hc[b]; e; e = e->next) {
        if (strcmp(e->ip, ip) == 0) {
            if (strcmp(e->name, name) != 0) {
                snprintf(e->name, HC_NAMELEN, "%s", name);
            }
            pthread_mutex_unlock(&g_hc_lock);
            return;
        }
    }
    hc_entry_t *e = (hc_entry_t *)calloc(1, sizeof(hc_entry_t));
    if (e) {
        snprintf(e->ip, HC_KEYLEN, "%s", ip);
        snprintf(e->name, HC_NAMELEN, "%s", name);
        e->next = g_hc[b];
        g_hc[b] = e;
    }
    pthread_mutex_unlock(&g_hc_lock);
}

static int hc_get(const char *ip, char *out, size_t cap) {
    int found = 0;
    pthread_mutex_lock(&g_hc_lock);
    for (hc_entry_t *e = g_hc[hc_hash(ip)]; e; e = e->next) {
        if (strcmp(e->ip, ip) == 0) {
            snprintf(out, cap, "%s", e->name);
            found = 1;
            break;
        }
    }
    pthread_mutex_unlock(&g_hc_lock);
    return found;
}

/* ------------------------------------------------------------------ */
/* 地址判定                                                            */
/* ------------------------------------------------------------------ */
static int addr_is_bypass(const struct sockaddr *sa) {
    if (!sa) return 1;
    if (sa->sa_family == AF_INET) {
        const struct sockaddr_in *v4 = (const struct sockaddr_in *)sa;
        unsigned int ip = ntohl(v4->sin_addr.s_addr);
        if (g_proxy_in && (int)v4->sin_addr.s_addr == g_proxy_in) return 1;
        if ((ip >> 24) == 127) return 1;                       /* 127/8   */
        if ((ip >> 24) == 10)  return 1;                       /* 10/8    */
        if ((ip >> 20) == 0xAC1) return 1;                     /* 172.16/12 */
        if ((ip >> 16) == 0xC0A8) return 1;                    /* 192.168/16 */
        if ((ip >> 16) == 0xA9FE) return 1;                    /* 169.254/16 */
        if ((ip >> 24) == 0) return 1;                         /* 0/8     */
        if ((ip >> 28) == 0xE) return 1;                       /* 224/4 组播 */
        if (ip == 0xFFFFFFFFu) return 1;
        return 0;
    }
    if (sa->sa_family == AF_INET6) {
        const struct sockaddr_in6 *v6 = (const struct sockaddr_in6 *)sa;
        const unsigned char *b = v6->sin6_addr.s6_addr;
        if (g_proxy_in6 && memcmp(b, &g_proxy_in6, 16) == 0) return 1;
        if (IN6_IS_ADDR_LOOPBACK(&v6->sin6_addr)) return 1;
        if (IN6_IS_ADDR_LINKLOCAL(&v6->sin6_addr)) return 1;
        if (IN6_IS_ADDR_MULTICAST(&v6->sin6_addr)) return 1;
        if ((b[0] & 0xFE) == 0xFC) return 1;                   /* fc00::/7 */
        if (b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0 &&
            b[4] == 0 && b[5] == 0 && b[6] == 0 && b[7] == 0 &&
            b[8] == 0 && b[9] == 0 && b[10] == 0 && b[11] == 0 &&
            b[12] == 0 && b[13] == 0 && b[14] == 0 && b[15] == 0) return 1;
        return 0;
    }
    return 1;   /* AF_UNIX 等一律放行 */
}

static int sock_is_stream(int fd) {
    int type = 0;
    socklen_t l = sizeof(type);
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &l) != 0) return -1;
    return type == SOCK_STREAM;
}

/* ------------------------------------------------------------------ */
/* 阻塞/非阻塞控制                                                     */
/* ------------------------------------------------------------------ */
static int set_blocking(int fd, int blocking) {
    int fl = fcntl(fd, F_GETFL, 0);
    if (fl < 0) return -1;
    int nf = blocking ? (fl & ~O_NONBLOCK) : (fl | O_NONBLOCK);
    if (nf == fl) return fl;
    return fcntl(fd, F_SETFL, nf);
}

static int wait_writable(int fd, int timeout_ms) {
    fd_set wf;
    FD_ZERO(&wf);
    FD_SET(fd, &wf);
    struct timeval tv;
    tv.tv_sec  = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
    return select(fd + 1, NULL, &wf, NULL, &tv);
}

static int wait_readable(int fd, int timeout_ms) {
    fd_set rf;
    FD_ZERO(&rf);
    FD_SET(fd, &rf);
    struct timeval tv;
    tv.tv_sec  = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
    return select(fd + 1, &rf, NULL, NULL, &tv);
}

static int write_all(int fd, const void *buf, size_t len) {
    const unsigned char *p = (const unsigned char *)buf;
    size_t off = 0;
    while (off < len) {
        ssize_t n = write(fd, p + off, len - off);
        if (n > 0) { off += (size_t)n; continue; }
        if (n < 0 && (errno == EINTR)) continue;
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            if (wait_writable(fd, g_cfg.timeout_ms) > 0) continue;
        }
        return -1;
    }
    return 0;
}

static int read_all(int fd, void *buf, size_t len) {
    unsigned char *p = (unsigned char *)buf;
    size_t off = 0;
    while (off < len) {
        ssize_t n = read(fd, p + off, len - off);
        if (n > 0) { off += (size_t)n; continue; }
        if (n == 0) return -1;
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            if (wait_readable(fd, g_cfg.timeout_ms) > 0) continue;
        }
        return -1;
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* SOCKS5 握手                                                         */
/* ------------------------------------------------------------------ */
static int socks5_handshake(int fd, const struct sockaddr *dst, socklen_t dlen) {
    unsigned char buf[512];
    char host[HC_NAMELEN];
    host[0] = 0;

    int atyp = 0;
    const unsigned char *raw = NULL;
    unsigned short port = 0;

    if (dst->sa_family == AF_INET) {
        const struct sockaddr_in *v4 = (const struct sockaddr_in *)dst;
        char ip[HC_KEYLEN];
        if (!inet_ntop(AF_INET, &v4->sin_addr, ip, sizeof(ip))) return -1;
        port = ntohs(v4->sin_port);
        if (g_cfg.dns_remote && hc_get(ip, host, sizeof(host))) {
            atyp = 3;
        } else {
            atyp = 1;
            raw  = (const unsigned char *)&v4->sin_addr;
        }
    } else if (dst->sa_family == AF_INET6) {
        const struct sockaddr_in6 *v6 = (const struct sockaddr_in6 *)dst;
        char ip[HC_KEYLEN];
        if (!inet_ntop(AF_INET6, &v6->sin6_addr, ip, sizeof(ip))) return -1;
        port = ntohs(v6->sin6_port);
        /* IPv4-mapped IPv6 走 v4 路径，兼容性更好 */
        if (IN6_IS_ADDR_V4MAPPED(&v6->sin6_addr)) {
            if (g_cfg.dns_remote && hc_get(ip, host, sizeof(host))) {
                atyp = 3;
            } else {
                atyp = 1;
                raw  = ((const unsigned char *)&v6->sin6_addr) + 12;
            }
        } else {
            if (g_cfg.dns_remote && hc_get(ip, host, sizeof(host))) {
                atyp = 3;
            } else {
                atyp = 4;
                raw  = (const unsigned char *)&v6->sin6_addr;
            }
        }
    } else {
        return -1;
    }
    (void)dlen;

    /* 1) 方法协商 */
    buf[0] = 0x05; buf[1] = 0x01; buf[2] = 0x00;
    if (write_all(fd, buf, 3) != 0) return -1;
    if (read_all(fd, buf, 2) != 0) return -1;
    if (buf[0] != 0x05 || buf[1] != 0x00) return -1;

    /* 2) 请求 */
    size_t n = 0;
    buf[n++] = 0x05;
    buf[n++] = 0x01;   /* CONNECT */
    buf[n++] = 0x00;
    buf[n++] = (unsigned char)atyp;
    if (atyp == 1) {
        memcpy(buf + n, raw, 4); n += 4;
    } else if (atyp == 4) {
        memcpy(buf + n, raw, 16); n += 16;
    } else {
        size_t hl = strlen(host);
        if (hl == 0 || hl > 255) return -1;
        buf[n++] = (unsigned char)hl;
        memcpy(buf + n, host, hl); n += hl;
    }
    buf[n++] = (unsigned char)((port >> 8) & 0xFF);
    buf[n++] = (unsigned char)(port & 0xFF);
    if (write_all(fd, buf, n) != 0) return -1;

    /* 3) 应答 */
    if (read_all(fd, buf, 4) != 0) return -1;
    if (buf[1] != 0x00) return -1;      /* 非成功 */
    size_t skip = 0;
    if (buf[3] == 0x01)      skip = 4 + 2;
    else if (buf[3] == 0x04) skip = 16 + 2;
    else if (buf[3] == 0x03) {
        if (read_all(fd, buf, 1) != 0) return -1;
        skip = (size_t)buf[0] + 2;
    } else return -1;
    if (skip) {
        if (read_all(fd, buf, skip) != 0) return -1;
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* 被拦截的 connect                                                    */
/* ------------------------------------------------------------------ */
static int eag_connect(int fd, const struct sockaddr *addr, socklen_t len) {
    eag_ensure();
    if (!real_connect) return (int)syscall(SYS_connect, fd, addr, len);
    if (t_in_init) return real_connect(fd, addr, len);

    if (!g_cfg.enabled || !addr) return real_connect(fd, addr, len);
    if (addr->sa_family != AF_INET && addr->sa_family != AF_INET6)
        return real_connect(fd, addr, len);
    if (addr_is_bypass(addr)) return real_connect(fd, addr, len);

    int st = sock_is_stream(fd);

    /* UDP：阻断公网 80/443，逼 QUIC 回落 TCP（等价 udp_mode=block） */
    if (st == SOCK_DGRAM) {
        unsigned short p = 0;
        if (addr->sa_family == AF_INET)
            p = ntohs(((const struct sockaddr_in *)addr)->sin_port);
        else
            p = ntohs(((const struct sockaddr_in6 *)addr)->sin6_port);
        if (g_cfg.udp_block && (p == 443 || p == 80)) {
            errno = ENETUNREACH;
            return -1;
        }
        return real_connect(fd, addr, len);
    }
    if (st != SOCK_STREAM) return real_connect(fd, addr, len);

    /* 连到代理自身：直连 */
    struct sockaddr_storage ps;
    memset(&ps, 0, sizeof(ps));
    socklen_t plen = 0;
    if (addr->sa_family == AF_INET) {
        struct sockaddr_in *v4 = (struct sockaddr_in *)&ps;
        v4->sin_family = AF_INET;
        v4->sin_port = htons((unsigned short)g_cfg.proxy_port);
        inet_pton(AF_INET, g_cfg.proxy_host, &v4->sin_addr);
        plen = sizeof(*v4);
    } else {
        struct sockaddr_in6 *v6 = (struct sockaddr_in6 *)&ps;
        v6->sin6_family = AF_INET6;
        v6->sin6_port = htons((unsigned short)g_cfg.proxy_port);
        inet_pton(AF_INET6, g_cfg.proxy_host, &v6->sin6_addr);
        plen = sizeof(*v6);
    }

    int was_blocking = set_blocking(fd, 0);

    int rc = real_connect(fd, (const struct sockaddr *)&ps, plen);
    if (rc != 0 && errno != EINPROGRESS && errno != EALREADY) {
        int se = errno;
        set_blocking(fd, was_blocking >= 0);
        eag_log("proxy connect failed: %s", strerror(se));
        errno = se;
        return -1;
    }
    if (rc != 0) {
        int w = wait_writable(fd, g_cfg.timeout_ms);
        if (w <= 0) {
            set_blocking(fd, was_blocking >= 0);
            errno = ETIMEDOUT;
            eag_log("proxy connect timeout");
            return -1;
        }
        int soerr = 0;
        socklen_t sl = sizeof(soerr);
        if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &soerr, &sl) != 0 || soerr != 0) {
            set_blocking(fd, was_blocking >= 0);
            errno = soerr ? soerr : ECONNREFUSED;
            eag_log("proxy connect refused: %s", strerror(errno));
            return -1;
        }
    }

    if (socks5_handshake(fd, addr, len) != 0) {
        set_blocking(fd, was_blocking >= 0);
        errno = ECONNREFUSED;
        eag_log("socks5 handshake failed");
        return -1;
    }

    set_blocking(fd, was_blocking >= 0);
    return 0;
}

/* ------------------------------------------------------------------ */
/* 被拦截的 getaddrinfo（记录域名，供 SOCKS5 远端解析）                */
/* ------------------------------------------------------------------ */
static int eag_getaddrinfo(const char *node, const char *service,
                           const struct addrinfo *hints,
                           struct addrinfo **res) {
    eag_ensure();
    if (!real_getaddrinfo) { errno = ENOSYS; return EAI_FAIL; }

    int rc = real_getaddrinfo(node, service, hints, res);
    if (rc != 0 || !res || !*res) return rc;
    if (!g_cfg.enabled || !g_cfg.dns_remote) return rc;
    if (!node || !*node) return rc;
    if (hints && (hints->ai_flags & AI_NUMERICHOST)) return rc;

    char ip[HC_KEYLEN];
    for (struct addrinfo *ai = *res; ai; ai = ai->ai_next) {
        if (!ai->ai_addr) continue;
        if (ai->ai_family == AF_INET) {
            if (inet_ntop(AF_INET, &((struct sockaddr_in *)ai->ai_addr)->sin_addr,
                          ip, sizeof(ip))) hc_put(ip, node);
        } else if (ai->ai_family == AF_INET6) {
            if (inet_ntop(AF_INET6, &((struct sockaddr_in6 *)ai->ai_addr)->sin6_addr,
                          ip, sizeof(ip))) hc_put(ip, node);
        }
    }
    return rc;
}

/* ------------------------------------------------------------------ */
/* 构造函数 + 静态插桩                                                 */
/*                                                                     */
/* 段名必须是 __DATA,__interpose（不能落到 __DATA_CONST，dyld 不认）。 */
/* 真身由 eag_real_symbol() 在构造函数里取好，replacement 内部只走      */
/* 函数指针，不会二次进入本文件，故无递归风险。                         */
/* ------------------------------------------------------------------ */
__attribute__((constructor))
static void eag_ctor(void) {
    eag_ensure();
}

#define EAG_INTERPOSE(replacement, replacee)                                   \
    __attribute__((used)) static struct {                                      \
        const void *replacement;                                               \
        const void *replacee;                                                  \
    } _eag_interpose_##replacee                                                \
        __attribute__((section("__DATA,__interpose"))) = {                     \
            (const void *)(unsigned long)&replacement,                         \
            (const void *)(unsigned long)&replacee};

EAG_INTERPOSE(eag_connect, connect)
EAG_INTERPOSE(eag_getaddrinfo, getaddrinfo)
