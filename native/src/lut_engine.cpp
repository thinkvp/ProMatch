#include "lut_engine.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdarg>
#include <ctime>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <thread>

#ifdef _WIN32
#include <sys/stat.h>
#include <sys/types.h>
#include <windows.h>
#include <shlobj.h>
#else
#include <sys/stat.h>
#endif

namespace pm {

// ------------------------------------------------------------------ parsing

static bool startsWith(const char* s, const char* prefix) {
    return std::strncmp(s, prefix, std::strlen(prefix)) == 0;
}

bool parseCube(const std::string& text, Lut3D& out, std::string* error) {
    auto fail = [&](const char* msg) {
        if (error) *error = msg;
        return false;
    };
    out = Lut3D();
    std::vector<float> values;
    const char* p = text.c_str();
    const char* end = p + text.size();
    while (p < end) {
        const char* eol = static_cast<const char*>(std::memchr(p, '\n', end - p));
        if (!eol) eol = end;
        const char* s = p;
        while (s < eol && (*s == ' ' || *s == '\t' || *s == '\r')) s++;
        if (s < eol && *s != '#') {
            if (startsWith(s, "LUT_3D_SIZE")) {
                out.size = std::atoi(s + 11);
                if (out.size < 2 || out.size > 256) return fail("LUT_3D_SIZE out of range");
                values.reserve(size_t(out.size) * out.size * out.size * 3);
            } else if (startsWith(s, "DOMAIN_MIN") || startsWith(s, "DOMAIN_MAX")) {
                float* d = s[7] == 'M' && s[8] == 'I' ? out.domainMin : out.domainMax;
                char* q = const_cast<char*>(s + 10);
                for (int c = 0; c < 3; c++) d[c] = std::strtof(q, &q);
            } else if (startsWith(s, "LUT_1D_SIZE")) {
                return fail("1D LUTs are not supported");
            } else if ((*s >= 'A' && *s <= 'Z') || *s == '_') {
                // TITLE, LUT_3D_INPUT_RANGE and other keywords: ignored.
            } else {
                char* q = const_cast<char*>(s);
                for (int c = 0; c < 3; c++) {
                    char* next = nullptr;
                    float v = std::strtof(q, &next);
                    if (next == q) return fail("malformed data line");
                    values.push_back(v);
                    q = next;
                }
            }
        }
        p = eol + 1;
    }
    if (!out.size) return fail("no LUT_3D_SIZE");
    if (values.size() != size_t(out.size) * out.size * out.size * 3) return fail("wrong number of values");
    for (int c = 0; c < 3; c++)
        if (!(out.domainMax[c] > out.domainMin[c])) return fail("bad DOMAIN_MIN/MAX");
    out.data.swap(values);
    return true;
}

// ------------------------------------------------------------------- lookup

void sampleTetra(const Lut3D& lut, const float in[3], float out[3]) {
    const int s = lut.size;
    const int n = s - 1;
    float f[3];
    int i0[3];
    for (int c = 0; c < 3; c++) {
        float v = (in[c] - lut.domainMin[c]) / (lut.domainMax[c] - lut.domainMin[c]);
        v = v < 0.f ? 0.f : (v > 1.f ? 1.f : v);
        if (!(v == v)) v = 0.f;  // NaN
        float x = v * n;
        int k = int(x);
        if (k > n - 1) k = n - 1;
        i0[c] = k;
        f[c] = x - k;
    }
    const float dr = f[0], dg = f[1], db = f[2];
    const float* d = lut.data.data();
    const size_t sr = 3, sg = size_t(s) * 3, sb = size_t(s) * s * 3;
    const float* c000 = d + i0[2] * sb + i0[1] * sg + i0[0] * sr;
    const float* c111 = c000 + sr + sg + sb;
    const float *a, *b;
    float w0, w1, w2, w3;  // weights of c000, a, b, c111
    if (dr > dg) {
        if (dg > db) {         // r > g > b
            a = c000 + sr; b = c000 + sr + sg;
            w0 = 1 - dr; w1 = dr - dg; w2 = dg - db; w3 = db;
        } else if (dr > db) {  // r > b >= g
            a = c000 + sr; b = c000 + sr + sb;
            w0 = 1 - dr; w1 = dr - db; w2 = db - dg; w3 = dg;
        } else {               // b >= r > g
            a = c000 + sb; b = c000 + sr + sb;
            w0 = 1 - db; w1 = db - dr; w2 = dr - dg; w3 = dg;
        }
    } else {
        if (db > dg) {         // b > g >= r
            a = c000 + sb; b = c000 + sg + sb;
            w0 = 1 - db; w1 = db - dg; w2 = dg - dr; w3 = dr;
        } else if (db > dr) {  // g >= b > r
            a = c000 + sg; b = c000 + sg + sb;
            w0 = 1 - dg; w1 = dg - db; w2 = db - dr; w3 = dr;
        } else {               // g >= r >= b
            a = c000 + sg; b = c000 + sr + sg;
            w0 = 1 - dg; w1 = dg - dr; w2 = dr - db; w3 = db;
        }
    }
    for (int c = 0; c < 3; c++) out[c] = w0 * c000[c] + w1 * a[c] + w2 * b[c] + w3 * c111[c];
}

// -------------------------------------------------------------------- apply

// Byte offsets of R, G, B, A within a pixel, per layout.
struct Offsets { int r, g, b, a; };
static Offsets offsetsOf(Layout l) {
    switch (l) {
        case Layout::BGRA: return {2, 1, 0, 3};
        case Layout::ARGB: return {1, 2, 3, 0};
        default:           return {0, 1, 2, 3};
    }
}

template <typename Fn>
static void parallelRows(int height, Fn fn) {
    unsigned hw = std::thread::hardware_concurrency();
    int threads = int(std::min<unsigned>(hw ? hw : 4, 32));
    threads = std::max(1, std::min(threads, height / 16));
    if (threads == 1) {
        fn(0, height);
        return;
    }
    std::vector<std::thread> pool;
    pool.reserve(threads - 1);
    const int band = (height + threads - 1) / threads;
    for (int t = 1; t < threads; t++) {
        const int y0 = t * band, y1 = std::min(height, y0 + band);
        if (y0 < y1) pool.emplace_back([=] { fn(y0, y1); });
    }
    fn(0, std::min(height, band));
    for (auto& th : pool) th.join();
}

static inline uint8_t to8(float v) {
    v = v * 255.f + 0.5f;
    return uint8_t(v <= 0.f ? 0 : (v >= 255.f ? 255 : int(v)));
}

void apply8(const Lut3D& lut, const Image8& src, const Image8& dst, float amount) {
    const Offsets so = offsetsOf(src.layout), d_o = offsetsOf(dst.layout);
    const float inv = 1.f / 255.f;
    const int width = std::min(src.width, dst.width);
    parallelRows(std::min(src.height, dst.height), [&](int y0, int y1) {
        for (int y = y0; y < y1; y++) {
            const uint8_t* sp = src.data + y * src.rowBytes;
            uint8_t* dp = dst.data + y * dst.rowBytes;
            for (int x = 0; x < width; x++, sp += 4, dp += 4) {
                const float in[3] = {sp[so.r] * inv, sp[so.g] * inv, sp[so.b] * inv};
                const uint8_t a = sp[so.a];
                float o[3];
                sampleTetra(lut, in, o);
                for (int c = 0; c < 3; c++) o[c] = in[c] + (o[c] - in[c]) * amount;
                dp[d_o.r] = to8(o[0]);
                dp[d_o.g] = to8(o[1]);
                dp[d_o.b] = to8(o[2]);
                dp[d_o.a] = a;
            }
        }
    });
}

void applyF(const Lut3D& lut, const ImageF& src, const ImageF& dst, float amount) {
    const Offsets so = offsetsOf(src.layout), d_o = offsetsOf(dst.layout);
    const int width = std::min(src.width, dst.width);
    parallelRows(std::min(src.height, dst.height), [&](int y0, int y1) {
        for (int y = y0; y < y1; y++) {
            const float* sp = reinterpret_cast<const float*>(reinterpret_cast<const char*>(src.data) + y * src.rowBytes);
            float* dp = reinterpret_cast<float*>(reinterpret_cast<char*>(dst.data) + y * dst.rowBytes);
            for (int x = 0; x < width; x++, sp += 4, dp += 4) {
                const float in[3] = {sp[so.r], sp[so.g], sp[so.b]};
                const float a = sp[so.a];
                float o[3];
                sampleTetra(lut, in, o);
                for (int c = 0; c < 3; c++) o[c] = in[c] + (o[c] - in[c]) * amount;
                dp[d_o.r] = o[0];
                dp[d_o.g] = o[1];
                dp[d_o.b] = o[2];
                dp[d_o.a] = a;
            }
        }
    });
}

// --------------------------------------------------------------- names

static std::string percentDecode(const std::string& s) {
    if (s == "-") return std::string();
    std::string out;
    for (size_t i = 0; i < s.size(); i++) {
        if (s[i] == '%' && i + 2 < s.size()) {
            int v = 0;
            if (std::sscanf(s.substr(i + 1, 2).c_str(), "%2x", &v) == 1) {
                out.push_back(char(v));
                i += 2;
                continue;
            }
        }
        out.push_back(s[i]);
    }
    return out;
}

static std::string percentEncode(const std::string& s) {
    if (s.empty()) return "-";
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : s) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            out.push_back(char(c));
        } else {
            out.push_back('%');
            out.push_back(hex[c >> 4]);
            out.push_back(hex[c & 15]);
        }
    }
    return out;
}

// ------------------------------------------------------ calibration pattern

void probeGrid(int n, int width, int height, int* cols, int* rows) {
    const int count = n * n * n;
    const double aspect = height > 0 ? double(width) / height : 1.0;
    *cols = std::max(1, int(std::ceil(std::sqrt(count * aspect))));
    *rows = (count + *cols - 1) / *cols;
}

void probeColour(int n, int cols, int rows, int width, int height, int x, int y, float out[3]) {
    const int col = int((long long)x * cols / width);
    const int row = int((long long)y * rows / height);
    const int idx = row * cols + col;
    if (idx >= n * n * n) {
        out[0] = out[1] = out[2] = 0.f;
        return;
    }
    const float k = 1.f / float(n - 1);
    out[0] = float(idx % n) * k;
    out[1] = float(idx / n % n) * k;
    out[2] = float(idx / (n * n)) * k;
}

void fillProbe8(int n, const Image8& dst) {
    int cols, rows;
    probeGrid(n, dst.width, dst.height, &cols, &rows);
    const Offsets d_o = offsetsOf(dst.layout);
    parallelRows(dst.height, [&](int y0, int y1) {
        for (int y = y0; y < y1; y++) {
            uint8_t* dp = dst.data + y * dst.rowBytes;
            for (int x = 0; x < dst.width; x++, dp += 4) {
                float c[3];
                probeColour(n, cols, rows, dst.width, dst.height, x, y, c);
                dp[d_o.r] = to8(c[0]);
                dp[d_o.g] = to8(c[1]);
                dp[d_o.b] = to8(c[2]);
                dp[d_o.a] = 255;
            }
        }
    });
}

void fillProbeF(int n, const ImageF& dst) {
    int cols, rows;
    probeGrid(n, dst.width, dst.height, &cols, &rows);
    const Offsets d_o = offsetsOf(dst.layout);
    parallelRows(dst.height, [&](int y0, int y1) {
        for (int y = y0; y < y1; y++) {
            float* dp = reinterpret_cast<float*>(reinterpret_cast<char*>(dst.data) + y * dst.rowBytes);
            for (int x = 0; x < dst.width; x++, dp += 4) {
                float c[3];
                probeColour(n, cols, rows, dst.width, dst.height, x, y, c);
                dp[d_o.r] = c[0];
                dp[d_o.g] = c[1];
                dp[d_o.b] = c[2];
                dp[d_o.a] = 1.f;
            }
        }
    });
}

// ------------------------------------------------------------ embedded LUTs

std::string embeddedText(const void* bytes, size_t len) {
    const uint8_t* b = static_cast<const uint8_t*>(bytes);
    if (!b || len < 6) return std::string();
    if (std::memcmp(b, "PMLUT", 5) == 0) return std::string(reinterpret_cast<const char*>(b), len);
    static const uint8_t kUtf16[] = {'P', 0, 'M', 0, 'L', 0, 'U', 0, 'T', 0};
    if (len < sizeof(kUtf16) || std::memcmp(b, kUtf16, sizeof(kUtf16)) != 0) return std::string();
    std::string ascii(len / 2, '\0');
    for (size_t i = 0; i < ascii.size(); i++) {
        if (b[2 * i + 1] != 0) return std::string();  // not ASCII: not ours
        ascii[i] = char(b[2 * i]);
    }
    return ascii;
}

std::vector<uint8_t> toUtf16(const std::string& ascii) {
    std::vector<uint8_t> out(ascii.size() * 2, 0);
    for (size_t i = 0; i < ascii.size(); i++) out[2 * i] = uint8_t(ascii[i]);
    return out;
}

bool parseEmbeddedText(const std::string& text, Lut3D& out, std::string* error) {
    auto fail = [&](const char* msg) {
        if (error) *error = msg;
        return false;
    };
    out = Lut3D();
    if (text.compare(0, 6, "PMLUT0") == 0) return true;
    const std::string head = text.substr(0, 96);
    if (text.compare(0, 6, "PMLUTP") == 0) {
        int n = 0;
        if (std::sscanf(head.c_str(), "PMLUTP %d", &n) != 1 || n < 2 || n > 64) return fail("bad calibration pattern size");
        out.probe = n;
        return true;
    }
    int size = 0;
    float lo = 0, hi = 0;
    long id = 0;
    int consumed = 0;
    if (text.compare(0, 6, "PMLUT3") == 0) {
        char name[400] = {};
        if (std::sscanf(head.c_str(), "PMLUT3 %ld %399s %d %f %f %n", &id, name, &size, &lo, &hi, &consumed) != 5 || consumed <= 0) {
            // The name can be long: parse from the full header line.
            const std::string line = text.substr(0, std::min<size_t>(text.size(), 1200));
            if (std::sscanf(line.c_str(), "PMLUT3 %ld %399s %d %f %f %n", &id, name, &size, &lo, &hi, &consumed) != 5 || consumed <= 0)
                return fail("not a ProMatch LUT (expected PMLUT3 <id> <name> <size> <lo> <hi> <data>)");
        }
        out.name = percentDecode(name);
    } else if (text.compare(0, 6, "PMLUT2") == 0) {
        if (std::sscanf(head.c_str(), "PMLUT2 %ld %d %f %f %n", &id, &size, &lo, &hi, &consumed) != 4 || consumed <= 0)
            return fail("not a ProMatch LUT (expected PMLUT2 <id> <size> <lo> <hi> <data>)");
    } else if (std::sscanf(head.c_str(), "PMLUT1 %d %f %f %n", &size, &lo, &hi, &consumed) != 3 || consumed <= 0) {
        return fail("not a ProMatch LUT (expected PMLUT2 <id> <size> <lo> <hi> <data>)");
    }
    out.id = id;
    if (size < 2 || size > 129) return fail("LUT size out of range");
    const size_t values = size_t(size) * size * size * 3;
    int dec[256];
    for (int i = 0; i < 256; i++) dec[i] = -1;
    static const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (int i = 0; i < 64; i++) dec[(uint8_t)kB64[i]] = i;
    out.size = size;
    out.data.resize(values);
    const float scale = (hi - lo) / 65535.f;
    size_t v = 0;
    uint32_t acc = 0, word = 0;
    int bits = 0, half = 0;
    for (size_t i = size_t(consumed); i < text.size() && v < values; i++) {
        const int d = dec[(uint8_t)text[i]];
        if (d < 0) {
            if (text[i] == '=') break;
            continue;  // whitespace
        }
        acc = (acc << 6) | uint32_t(d);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            const uint32_t byte = (acc >> bits) & 0xFF;
            if (half == 0) {
                word = byte;
                half = 1;
            } else {
                out.data[v++] = lo + float(word | (byte << 8)) * scale;
                half = 0;
            }
        }
    }
    if (v != values) return fail("LUT data is truncated");
    return true;
}

std::string toEmbeddedText(const Lut3D& lut, long id, const std::string& name) {
    float lo = 0, hi = 1;
    if (!lut.data.empty()) {
        lo = *std::min_element(lut.data.begin(), lut.data.end());
        hi = *std::max_element(lut.data.begin(), lut.data.end());
    }
    if (!(hi > lo)) hi = lo + 1;
    std::vector<uint8_t> bytes(lut.data.size() * 2);
    const double scale = 65535.0 / (double(hi) - double(lo));
    for (size_t i = 0; i < lut.data.size(); i++) {
        const long q = std::lround((double(lut.data[i]) - lo) * scale);
        const uint16_t v = uint16_t(q < 0 ? 0 : (q > 65535 ? 65535 : q));
        bytes[2 * i] = uint8_t(v & 255);
        bytes[2 * i + 1] = uint8_t(v >> 8);
    }
    static const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string b64;
    b64.reserve((bytes.size() + 2) / 3 * 4);
    for (size_t i = 0; i < bytes.size(); i += 3) {
        const uint32_t n = (uint32_t(bytes[i]) << 16) | (i + 1 < bytes.size() ? uint32_t(bytes[i + 1]) << 8 : 0) |
                           (i + 2 < bytes.size() ? uint32_t(bytes[i + 2]) : 0);
        b64.push_back(kB64[(n >> 18) & 63]);
        b64.push_back(kB64[(n >> 12) & 63]);
        b64.push_back(i + 1 < bytes.size() ? kB64[(n >> 6) & 63] : '=');
        b64.push_back(i + 2 < bytes.size() ? kB64[n & 63] : '=');
    }
    char head[96];
    std::snprintf(head, sizeof(head), " %d %.9g %.9g ", lut.size, double(lo), double(hi));
    return "PMLUT3 " + std::to_string(id) + " " + percentEncode(name) + head + b64;
}

// Fast content hash for the cache (64-bit words, multiply-xorshift).
static uint64_t contentHash(const uint8_t* p, size_t n) {
    uint64_t h = 0x9E3779B97F4A7C15ull ^ n;
    size_t i = 0;
    for (; i + 8 <= n; i += 8) {
        uint64_t w;
        std::memcpy(&w, p + i, 8);
        h = (h ^ w) * 0xFF51AFD7ED558CCDull;
        h ^= h >> 32;
    }
    for (; i < n; i++) h = (h ^ p[i]) * 0x100000001B3ull;
    return h;
}

std::shared_ptr<const Lut3D> embeddedLut(const void* bytes, size_t len, std::string* error) {
    if (!bytes || len < 6) return nullptr;
    const uint64_t key = contentHash(static_cast<const uint8_t*>(bytes), len);
    static std::mutex mu;
    static std::vector<std::pair<uint64_t, std::shared_ptr<const Lut3D>>> recent;  // newest last
    {
        std::lock_guard<std::mutex> lock(mu);
        for (auto& e : recent)
            if (e.first == key) return e.second;  // may be nullptr: "none" or bad, decided once
    }
    const std::string text = embeddedText(bytes, len);
    std::shared_ptr<Lut3D> lut;
    if (text.empty()) {
        if (error) *error = "parameter does not hold PMLUT text";
    } else {
        lut = std::make_shared<Lut3D>();
        if (!parseEmbeddedText(text, *lut, error) || (lut->size == 0 && lut->probe == 0)) lut.reset();
    }
    std::lock_guard<std::mutex> lock(mu);
    recent.emplace_back(key, lut);
    if (recent.size() > 8) recent.erase(recent.begin());
    return lut;
}

// --------------------------------------------------------------------- files

#ifdef _WIN32
static const wchar_t kSep = L'\\';
#else
static const wchar_t kSep = L'/';
#endif

std::wstring dataPath(const std::wstring& rel) {
    std::wstring base;
#ifdef _WIN32
    PWSTR roaming = nullptr;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, nullptr, &roaming))) base = roaming;
    CoTaskMemFree(roaming);
#else
    const char* home = std::getenv("HOME");
    std::string p = std::string(home ? home : "") + "/Library/Application Support";
    base.assign(p.begin(), p.end());
#endif
    return base + kSep + L"ProMatch" + kSep + rel;
}

std::wstring lutFolder() {
#ifdef _WIN32
    FILE* f = _wfopen(dataPath(L"lut-folder.txt").c_str(), L"rb");
    if (f) {
        char buf[2048] = {};
        const size_t n = std::fread(buf, 1, sizeof(buf) - 1, f);
        std::fclose(f);
        std::string utf8(buf, n);
        while (!utf8.empty() && (utf8.back() == '\n' || utf8.back() == '\r' || utf8.back() == ' ')) utf8.pop_back();
        if (!utf8.empty()) {
            const int len = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), int(utf8.size()), nullptr, 0);
            std::wstring w(size_t(len), L'\0');
            MultiByteToWideChar(CP_UTF8, 0, utf8.data(), int(utf8.size()), &w[0], len);
            if (GetFileAttributesW(w.c_str()) != INVALID_FILE_ATTRIBUTES) return w;
        }
    }
    PWSTR docs = nullptr;
    std::wstring out;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Documents, 0, nullptr, &docs))) out = std::wstring(docs) + L"\\ProMatch LUTs";
    CoTaskMemFree(docs);
    return out;
#else
    return std::wstring();
#endif
}

void logLine(const char* fmt, ...) {
    static std::mutex mu;
    char msg[1024];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(msg, sizeof(msg), fmt, ap);
    va_end(ap);
    std::time_t now = std::time(nullptr);
    char stamp[32];
    std::strftime(stamp, sizeof(stamp), "%Y-%m-%d %H:%M:%S", std::localtime(&now));
    std::lock_guard<std::mutex> lock(mu);
    const std::wstring path = dataPath(L"effect.log");
#ifdef _WIN32
    FILE* f = _wfopen(path.c_str(), L"a");
#else
    FILE* f = std::fopen(std::string(path.begin(), path.end()).c_str(), "a");
#endif
    if (!f) return;
    std::fprintf(f, "%s  %s\n", stamp, msg);
    std::fclose(f);
}

}  // namespace pm
