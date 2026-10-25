// Standalone check of the LUT engine, no Adobe SDK needed.
//   lutapply <lut.cube> <in.rgba> <out.rgba> <width> <height> [amount=1] [f32]
// in/out are raw 8-bit RGBA. With "f32" the frame goes through the float
// path (as Premiere's BGRA_4444_32f would) and is quantised back to 8-bit.
// Driven by scripts/native-check.ts, which compares against src/core/lut.ts.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <vector>

#include "../src/lut_engine.h"

static std::string slurp(const char* path) {
    std::ifstream f(path, std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// lutapply --embedded <lut.cube> <embedded.txt>: decode the panel's embedded
// text the way the effect gets it from Premiere (UTF-16LE bytes), and compare
// it with the .cube.
static int checkEmbedded(const char* cubePath, const char* textPath) {
    pm::Lut3D cube;
    std::string err;
    if (!pm::parseCube(slurp(cubePath), cube, &err)) {
        std::fprintf(stderr, "parse: %s\n", err.c_str());
        return 1;
    }
    const std::vector<uint8_t> param = pm::toUtf16(slurp(textPath));
    auto lut = pm::embeddedLut(param.data(), param.size(), &err);
    if (!lut || lut->size != cube.size) {
        std::fprintf(stderr, "decode failed: %s\n", err.c_str());
        return 1;
    }
    double maxDiff = 0;
    for (size_t i = 0; i < cube.data.size(); i++) maxDiff = std::max(maxDiff, double(std::fabs(cube.data[i] - lut->data[i])));
    // What the LUT button stores: the effect's own encoding of the .cube, decoded back.
    pm::Lut3D again;
    const std::string mine = pm::toEmbeddedText(cube, 0, lut->name);
    double reDiff = 1;
    if (pm::parseEmbeddedText(mine, again) && again.size == cube.size && again.name == lut->name) {
        reDiff = 0;
        for (size_t i = 0; i < cube.data.size(); i++) reDiff = std::max(reDiff, double(std::fabs(cube.data[i] - again.data[i])));
    }
    // "PMLUT0" is no LUT, "PMLUTP <n>" the calibration pattern, and foreign bytes are rejected.
    const std::vector<uint8_t> none = pm::toUtf16("PMLUT0");
    const bool noneOk = !pm::embeddedLut(none.data(), none.size());
    const std::vector<uint8_t> pat = pm::toUtf16("PMLUTP 17");
    auto probe = pm::embeddedLut(pat.data(), pat.size());
    const bool patternOk = probe && probe->probe == 17 && probe->size == 0;
    const char junk[] = "<Lumetri>not ours</Lumetri>";
    const bool junkOk = !pm::embeddedLut(junk, sizeof(junk) - 1);
    std::printf("{\"size\":%d,\"id\":%ld,\"name\":\"%s\",\"paramBytes\":%zu,\"maxDiff255\":%.5f,\"reencodedDiff255\":%.5f,"
                "\"emptyIsNone\":%s,\"pattern\":%s,\"foreignRejected\":%s}\n",
                lut->size, lut->id, lut->name.c_str(), param.size(), maxDiff * 255, reDiff * 255, noneOk ? "true" : "false",
                patternOk ? "true" : "false", junkOk ? "true" : "false");
    return noneOk && patternOk && junkOk && maxDiff * 255 < 0.01 && reDiff * 255 < 0.01 ? 0 : 1;
}

int main(int argc, char** argv) {
    if (argc == 4 && std::strcmp(argv[1], "--embedded") == 0) return checkEmbedded(argv[2], argv[3]);
    if (argc < 6) {
        std::fprintf(stderr, "usage: lutapply <lut.cube> <in.rgba> <out.rgba> <width> <height> [amount] [f32]\n");
        return 2;
    }
    const int w = std::atoi(argv[4]), h = std::atoi(argv[5]);
    const float amount = argc > 6 ? float(std::atof(argv[6])) : 1.f;
    const bool f32 = argc > 7 && std::strcmp(argv[7], "f32") == 0;

    std::ifstream cf(argv[1], std::ios::binary);
    std::stringstream ss;
    ss << cf.rdbuf();
    pm::Lut3D lut;
    std::string err;
    auto t0 = std::chrono::steady_clock::now();
    if (!pm::parseCube(ss.str(), lut, &err)) {
        std::fprintf(stderr, "parse: %s\n", err.c_str());
        return 1;
    }
    auto t1 = std::chrono::steady_clock::now();

    std::vector<uint8_t> px(size_t(w) * h * 4);
    std::ifstream in(argv[2], std::ios::binary);
    in.read(reinterpret_cast<char*>(px.data()), px.size());
    if (size_t(in.gcount()) != px.size()) {
        std::fprintf(stderr, "input is not %dx%d RGBA\n", w, h);
        return 1;
    }

    double ms;
    if (f32) {
        std::vector<float> f(px.size());
        for (size_t i = 0; i < px.size(); i++) f[i] = px[i] / 255.f;
        pm::ImageF img{f.data(), w, h, long(w) * 16, pm::Layout::RGBA};
        auto a = std::chrono::steady_clock::now();
        pm::applyF(lut, img, img, amount);
        ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - a).count();
        for (size_t i = 0; i < px.size(); i++) {
            float v = f[i] * 255.f + 0.5f;
            px[i] = uint8_t(v <= 0 ? 0 : v >= 255 ? 255 : int(v));
        }
    } else {
        pm::Image8 img{px.data(), w, h, long(w) * 4, pm::Layout::RGBA};
        auto a = std::chrono::steady_clock::now();
        pm::apply8(lut, img, img, amount);
        ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - a).count();
    }
    std::ofstream out(argv[3], std::ios::binary);
    out.write(reinterpret_cast<const char*>(px.data()), px.size());
    std::printf("{\"size\":%d,\"parseMs\":%.1f,\"applyMs\":%.2f}\n", lut.size,
                std::chrono::duration<double, std::milli>(t1 - t0).count(), ms);
    return 0;
}
