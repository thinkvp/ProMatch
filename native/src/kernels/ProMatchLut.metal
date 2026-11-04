// ProMatch LUT kernel, Metal. Embedded in ProMatch.plugin as source and
// compiled at runtime on Premiere's Metal device (metal_lut.mm), so building
// needs no Metal toolchain. Same maths as pm::sampleTetra
// (native/src/lut_engine.cpp) and the OpenCL and CUDA kernels.
#include <metal_stdlib>
using namespace metal;

// pmgpu::LutKernelArgs (native/src/gpu_args.h), field for field.
struct LutKernelArgs {
    int srcPitch, dstPitch, is16f, width, height, size;
    float dmin[3], dmax[3], amount;
    int probe, probeCols, probeRows;
};

static float pmUnit(float v, float lo, float hi) {
    v = (v - lo) / (hi - lo);
    v = v < 0.f ? 0.f : (v > 1.f ? 1.f : v);
    return isnan(v) ? 0.f : v;
}

// One BGRA pixel of a Premiere GPU frame: 4 floats, or 4 halves when is16f.
// src and dst may be the same buffer. Pitches are in pixels. probe > 0 draws
// the calibration pattern (n = probe, in a probeCols x probeRows grid) instead.
kernel void ProMatchLut(device const uchar* src [[buffer(0)]], device uchar* dst [[buffer(1)]],
                        device const float* lut [[buffer(2)]], constant LutKernelArgs& a [[buffer(3)]],
                        uint2 xy [[thread_position_in_grid]]) {
    const int x = int(xy.x);
    const int y = int(xy.y);
    if (x >= a.width || y >= a.height) return;
    const size_t si = size_t(y) * size_t(a.srcPitch) + size_t(x);
    const size_t di = size_t(y) * size_t(a.dstPitch) + size_t(x);

    // Calibration pattern (pm::probeColour in lut_engine.cpp): replaces the picture.
    if (a.probe > 0) {
        const int n = a.probe;
        const int idx = int(long(y) * a.probeRows / a.height) * a.probeCols + int(long(x) * a.probeCols / a.width);
        const float k = 1.f / float(n - 1);
        float4 q = float4(0.f, 0.f, 0.f, 1.f);
        if (idx < n * n * n) q = float4(float(idx / (n * n)) * k, float(idx / n % n) * k, float(idx % n) * k, 1.f);
        if (a.is16f)
            ((device half4*)dst)[di] = half4(q);
        else
            ((device float4*)dst)[di] = q;
        return;
    }

    const float4 p = a.is16f ? float4(((device const half4*)src)[si]) : ((device const float4*)src)[si];
    const float b = p.x, g = p.y, r = p.z, al = p.w;

    const int n = a.size - 1;
    const float u[3] = {pmUnit(r, a.dmin[0], a.dmax[0]) * n, pmUnit(g, a.dmin[1], a.dmax[1]) * n,
                        pmUnit(b, a.dmin[2], a.dmax[2]) * n};
    int k[3];
    float f[3];
    for (int c = 0; c < 3; c++) {
        int i0 = int(u[c]);
        if (i0 > n - 1) i0 = n - 1;
        k[c] = i0;
        f[c] = u[c] - float(i0);
    }
    const float dr = f[0], dg = f[1], db = f[2];
    const int sr = 3, sg = a.size * 3, sb = a.size * a.size * 3;
    const int o = k[2] * sb + k[1] * sg + k[0] * sr;
    int ia, ib;
    float w0, w1, w2, w3;
    if (dr > dg) {
        if (dg > db)      { ia = sr; ib = sr + sg; w0 = 1 - dr; w1 = dr - dg; w2 = dg - db; w3 = db; }
        else if (dr > db) { ia = sr; ib = sr + sb; w0 = 1 - dr; w1 = dr - db; w2 = db - dg; w3 = dg; }
        else              { ia = sb; ib = sr + sb; w0 = 1 - db; w1 = db - dr; w2 = dr - dg; w3 = dg; }
    } else {
        if (db > dg)      { ia = sb; ib = sg + sb; w0 = 1 - db; w1 = db - dg; w2 = dg - dr; w3 = dr; }
        else if (db > dr) { ia = sg; ib = sg + sb; w0 = 1 - dg; w1 = dg - db; w2 = db - dr; w3 = dr; }
        else              { ia = sg; ib = sr + sg; w0 = 1 - dg; w1 = dg - dr; w2 = dr - db; w3 = db; }
    }
    device const float* c000 = lut + o;
    device const float* c111 = c000 + sr + sg + sb;
    const float in[3] = {r, g, b};
    float out[3];
    for (int c = 0; c < 3; c++) {
        const float v = w0 * c000[c] + w1 * c000[ia + c] + w2 * c000[ib + c] + w3 * c111[c];
        out[c] = in[c] + (v - in[c]) * a.amount;
    }

    const float4 q = float4(out[2], out[1], out[0], al);
    if (a.is16f)
        ((device half4*)dst)[di] = half4(q);
    else
        ((device float4*)dst)[di] = q;
}
