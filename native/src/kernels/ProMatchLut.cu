// ProMatch LUT kernel, CUDA. Compiled to PTX at build time (nvcc -ptx) and
// embedded in ProMatch.aex; the driver JIT-compiles it for the GPU it runs on.
// Same maths as pm::sampleTetra (native/src/lut_engine.cpp) and the OpenCL
// kernel (ProMatchLut.cl): keep the three in step.
#include <cuda_fp16.h>

__device__ __forceinline__ float pmUnit(float v, float lo, float hi) {
    v = (v - lo) / (hi - lo);
    v = v < 0.f ? 0.f : (v > 1.f ? 1.f : v);
    return v == v ? v : 0.f;  // NaN
}

// One BGRA pixel of a Premiere GPU frame: 4 floats, or 4 halves when is16f.
// src and dst may be the same frame. Pitches are in pixels. probe > 0 draws
// the calibration pattern (n = probe, in a probeCols x probeRows grid) instead.
extern "C" __global__ void ProMatchLut(const void* src, int srcPitch, void* dst, int dstPitch, int is16f, int width,
                                       int height, const float* __restrict__ lut, int size, float dminR, float dminG,
                                       float dminB, float dmaxR, float dmaxG, float dmaxB, float amount,
                                       int probe, int probeCols, int probeRows) {
    const int x = blockIdx.x * blockDim.x + threadIdx.x;
    const int y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x >= width || y >= height) return;
    const size_t si = (size_t)y * srcPitch + x;
    const size_t di = (size_t)y * dstPitch + x;

    // Calibration pattern (pm::probeColour in lut_engine.cpp): replaces the picture.
    if (probe > 0) {
        const int idx = (int)((long long)y * probeRows / height) * probeCols + (int)((long long)x * probeCols / width);
        const float k = 1.f / (float)(probe - 1);
        float pr = 0.f, pg = 0.f, pb = 0.f;
        if (idx < probe * probe * probe) {
            pr = (float)(idx % probe) * k;
            pg = (float)(idx / probe % probe) * k;
            pb = (float)(idx / (probe * probe)) * k;
        }
        if (is16f) {
            ushort4 h;
            h.x = __half_as_ushort(__float2half_rn(pb));
            h.y = __half_as_ushort(__float2half_rn(pg));
            h.z = __half_as_ushort(__float2half_rn(pr));
            h.w = __half_as_ushort(__float2half_rn(1.f));
            ((ushort4*)dst)[di] = h;
        } else {
            ((float4*)dst)[di] = make_float4(pb, pg, pr, 1.f);
        }
        return;
    }

    float b, g, r, a;
    if (is16f) {
        const ushort4 h = ((const ushort4*)src)[si];
        b = __half2float(__ushort_as_half(h.x));
        g = __half2float(__ushort_as_half(h.y));
        r = __half2float(__ushort_as_half(h.z));
        a = __half2float(__ushort_as_half(h.w));
    } else {
        const float4 p = ((const float4*)src)[si];
        b = p.x;
        g = p.y;
        r = p.z;
        a = p.w;
    }

    const int n = size - 1;
    const float u[3] = {pmUnit(r, dminR, dmaxR) * n, pmUnit(g, dminG, dmaxG) * n, pmUnit(b, dminB, dmaxB) * n};
    int k[3];
    float f[3];
    for (int c = 0; c < 3; c++) {
        int i0 = (int)u[c];
        if (i0 > n - 1) i0 = n - 1;
        k[c] = i0;
        f[c] = u[c] - i0;
    }
    const float dr = f[0], dg = f[1], db = f[2];
    const int sr = 3, sg = size * 3, sb = size * size * 3;
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
    const float* c000 = lut + o;
    const float* c111 = c000 + sr + sg + sb;
    const float in[3] = {r, g, b};
    float out[3];
    for (int c = 0; c < 3; c++) {
        const float v = w0 * c000[c] + w1 * c000[ia + c] + w2 * c000[ib + c] + w3 * c111[c];
        out[c] = in[c] + (v - in[c]) * amount;
    }

    if (is16f) {
        ushort4 h;
        h.x = __half_as_ushort(__float2half_rn(out[2]));
        h.y = __half_as_ushort(__float2half_rn(out[1]));
        h.z = __half_as_ushort(__float2half_rn(out[0]));
        h.w = __half_as_ushort(__float2half_rn(a));
        ((ushort4*)dst)[di] = h;
    } else {
        ((float4*)dst)[di] = make_float4(out[2], out[1], out[0], a);
    }
}
