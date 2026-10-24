// ProMatch LUT kernel, OpenCL. Embedded in ProMatch.aex as a string and built
// at runtime on Premiere's OpenCL device. Same maths as pm::sampleTetra
// (native/src/lut_engine.cpp) and the CUDA kernel (ProMatchLut.cu).

float pmUnit(float v, float lo, float hi) {
    v = (v - lo) / (hi - lo);
    v = v < 0.f ? 0.f : (v > 1.f ? 1.f : v);
    return isnan(v) ? 0.f : v;
}

// One BGRA pixel of a Premiere GPU frame: 4 floats, or 4 halves when is16f.
// src and dst may be the same frame. Pitches are in pixels.
__kernel void ProMatchLut(__global const void* src, int srcPitch, __global void* dst, int dstPitch, int is16f,
                          int width, int height, __global const float* lut, int size, float dminR, float dminG,
                          float dminB, float dmaxR, float dmaxG, float dmaxB, float amount) {
    const int x = get_global_id(0);
    const int y = get_global_id(1);
    if (x >= width || y >= height) return;
    const size_t si = (size_t)y * srcPitch + x;
    const size_t di = (size_t)y * dstPitch + x;

    const float4 p = is16f ? vload_half4(si, (__global const half*)src) : ((__global const float4*)src)[si];
    const float b = p.x, g = p.y, r = p.z, a = p.w;

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
    __global const float* c000 = lut + o;
    __global const float* c111 = c000 + sr + sg + sb;
    const float in[3] = {r, g, b};
    float out[3];
    for (int c = 0; c < 3; c++) {
        const float v = w0 * c000[c] + w1 * c000[ia + c] + w2 * c000[ib + c] + w3 * c111[c];
        out[c] = in[c] + (v - in[c]) * amount;
    }

    const float4 q = (float4)(out[2], out[1], out[0], a);
    if (is16f)
        vstore_half4_rte(q, di, (__global half*)dst);
    else
        ((__global float4*)dst)[di] = q;
}
