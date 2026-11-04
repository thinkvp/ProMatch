// GPU kernel check without Premiere, macOS: runs ProMatch's Metal LUT kernel
// (through metal_lut.mm, as the effect does) on this Mac's GPU on a real frame
// and compares it with the CPU engine (pm::applyF), in 32-bit float in place
// and 16-bit float src->dst, plus the calibration pattern. The Windows
// counterpart (CUDA, OpenCL) is gputest.cpp.
//   gputest <lut.cube> <in.rgba> <width> <height> [amount=1]
// in.rgba: raw 8-bit RGBA (scripts/native-check.ts writes one).
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "lut_engine.h"
#include "metal_lut.h"

using pmgpu::LutKernelArgs;

static std::string slurp(const char* path) {
    std::ifstream f(path, std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// IEEE half, round to nearest even (what Metal's half4(float4) does).
static uint16_t toHalf(float v) {
    const __fp16 h = (__fp16)v;
    uint16_t u;
    std::memcpy(&u, &h, 2);
    return u;
}
static float fromHalf(uint16_t u) {
    __fp16 h;
    std::memcpy(&h, &u, 2);
    return float(h);
}

static void report(const char* label, const std::vector<float>& got, const std::vector<float>& want, double ms) {
    double maxd = 0, sum = 0;
    size_t over = 0, n = 0;
    for (size_t i = 0; i < got.size(); i++) {
        if (i % 4 == 3) continue;
        const double d = std::fabs(double(got[i]) - double(want[i])) * 255.0;
        maxd = std::max(maxd, d);
        sum += d;
        over += d > 0.5;
        n++;
    }
    std::printf("{\"run\":\"%s\",\"mean255\":%.5f,\"max255\":%.4f,\"over0.5Pct\":%.4f,\"kernelMs\":%.3f}\n", label, sum / n,
                maxd, 100.0 * over / n, ms);
}

static std::vector<float> cpuRef(const pm::Lut3D& lut, std::vector<float> px, int w, int h, float amount, bool half) {
    if (half)
        for (auto& v : px) v = fromHalf(toHalf(v));
    pm::ImageF img{px.data(), w, h, long(w) * 16, pm::Layout::BGRA};
    pm::applyF(lut, img, img, amount);
    if (half)
        for (auto& v : px) v = fromHalf(toHalf(v));
    return px;
}

static const int kProbe = 17;
static std::vector<float> probeRef(int w, int h, bool half) {
    std::vector<float> px(size_t(w) * h * 4);
    pm::fillProbeF(kProbe, pm::ImageF{px.data(), w, h, long(w) * 16, pm::Layout::BGRA});
    if (half)
        for (auto& v : px) v = fromHalf(toHalf(v));
    return px;
}

static std::vector<uint8_t> pack(const std::vector<float>& px, bool half) {
    std::vector<uint8_t> out(px.size() * (half ? 2 : 4));
    for (size_t i = 0; i < px.size(); i++) {
        if (half) {
            const uint16_t h = toHalf(px[i]);
            std::memcpy(&out[2 * i], &h, 2);
        } else {
            std::memcpy(&out[4 * i], &px[i], 4);
        }
    }
    return out;
}

static std::vector<float> unpack(const void* b, size_t count, bool half) {
    std::vector<float> px(count);
    for (size_t i = 0; i < count; i++) {
        if (half) {
            uint16_t h;
            std::memcpy(&h, (const uint8_t*)b + 2 * i, 2);
            px[i] = fromHalf(h);
        } else {
            std::memcpy(&px[i], (const uint8_t*)b + 4 * i, 4);
        }
    }
    return px;
}

static LutKernelArgs argsFor(const pm::Lut3D& lut, int w, int h, bool half, float amount) {
    LutKernelArgs a;
    a.srcPitch = a.dstPitch = w;
    a.is16f = half ? 1 : 0;
    a.width = w;
    a.height = h;
    a.size = lut.size;
    for (int c = 0; c < 3; c++) {
        a.dmin[c] = lut.domainMin[c];
        a.dmax[c] = lut.domainMax[c];
    }
    a.amount = amount;
    return a;
}

int main(int argc, char** argv) {
    if (argc < 5) {
        std::fprintf(stderr, "usage: gputest <lut.cube> <in.rgba> <width> <height> [amount]\n");
        return 2;
    }
    pm::Lut3D lut;
    std::string err;
    if (!pm::parseCube(slurp(argv[1]), lut, &err)) {
        std::fprintf(stderr, "parse: %s\n", err.c_str());
        return 1;
    }
    const int w = std::atoi(argv[3]), h = std::atoi(argv[4]);
    const std::string raw = slurp(argv[2]);
    if (raw.size() != size_t(w) * h * 4) {
        std::fprintf(stderr, "input is not %dx%d RGBA\n", w, h);
        return 1;
    }
    std::vector<float> bgra(raw.size());
    for (size_t i = 0; i < raw.size(); i += 4) {
        bgra[i + 0] = uint8_t(raw[i + 2]) / 255.f;
        bgra[i + 1] = uint8_t(raw[i + 1]) / 255.f;
        bgra[i + 2] = uint8_t(raw[i + 0]) / 255.f;
        bgra[i + 3] = uint8_t(raw[i + 3]) / 255.f;
    }
    const float amount = argc > 5 ? float(std::atof(argv[5])) : 1.f;

    void* device = pmmetal::DefaultDevice();
    if (!device) {
        std::printf("{\"run\":\"metal\",\"error\":\"no Metal device\"}\n");
        return 1;
    }
    std::printf("{\"device\":\"%s\"}\n", pmmetal::DeviceName(device).c_str());
    void* queue = pmmetal::NewQueue(device);
    void* pipeline = pmmetal::CreatePipeline(device, &err);
    if (!pipeline) {
        std::printf("{\"run\":\"metal\",\"error\":\"%s\"}\n", err.c_str());
        return 1;
    }
    void* lutBuf = pmmetal::NewBuffer(device, lut.data.data(), lut.data.size() * 4);
    int rc = 0;
    for (int half = 0; half < 2; half++) {
        const std::vector<uint8_t> in = pack(bgra, half);
        // 32f in place (src == dst); 16f into a separate frame, as Premiere may do either.
        void* a = pmmetal::NewBuffer(device, in.data(), in.size());
        void* b = half ? pmmetal::NewBuffer(device, in.data(), in.size()) : a;
        double ms = 0;
        // Warm-up on a scratch copy, then the timed run on fresh input.
        void* warm = pmmetal::NewBuffer(device, in.data(), in.size());
        pmmetal::Launch(queue, pipeline, warm, warm, lutBuf, argsFor(lut, w, h, half, amount), true, &err);
        pmmetal::Release(warm);
        if (!pmmetal::Launch(queue, pipeline, a, b, lutBuf, argsFor(lut, w, h, half, amount), true, &err, &ms)) {
            std::printf("{\"run\":\"metal\",\"error\":\"%s\"}\n", err.c_str());
            rc = 1;
        }
        report(half ? "metal 16f src->dst" : "metal 32f in-place", unpack(pmmetal::Contents(b), bgra.size(), half),
               cpuRef(lut, bgra, w, h, amount, half), ms);
        LutKernelArgs pa = argsFor(lut, w, h, half, amount);
        pa.probe = kProbe;
        pm::probeGrid(kProbe, w, h, &pa.probeCols, &pa.probeRows);
        pmmetal::Launch(queue, pipeline, a, b, lutBuf, pa, true, &err);
        report(half ? "metal 16f pattern" : "metal 32f pattern", unpack(pmmetal::Contents(b), bgra.size(), half),
               probeRef(w, h, half), 0);
        if (b != a) pmmetal::Release(b);
        pmmetal::Release(a);
    }
    pmmetal::Release(lutBuf);
    pmmetal::Release(pipeline);
    pmmetal::Release(queue);
    pmmetal::Release(device);
    return rc;
}
