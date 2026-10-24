// GPU kernel check without Premiere: runs ProMatch's LUT kernel on this PC's
// GPU (OpenCL, and CUDA when built with nvcc) on a real frame and compares it
// with the CPU engine (pm::applyF), in 32-bit and 16-bit float.
//   gputest <lut.cube> <in.rgba> <width> <height> [amount=1]
// in.rgba: raw 8-bit RGBA (scripts/native-check.ts writes one).
#include <immintrin.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "gpu_api.h"
#include "lut_engine.h"
#include "ProMatchLut_cl.h"
#if PM_HAS_CUDA
#include "ProMatchLut_ptx.h"
#endif

using namespace pmgpu;

static std::string slurp(const char* path) {
    std::ifstream f(path, std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// F16C, round to nearest even (what the kernels use).
static uint16_t toHalf(float v) { return uint16_t(_mm_extract_epi16(_mm_cvtps_ph(_mm_set_ss(v), 0), 0)); }
static float fromHalf(uint16_t h) { return _mm_cvtss_f32(_mm_cvtph_ps(_mm_cvtsi32_si128(h))); }

struct Frame {
    int width, height;
    std::vector<float> bgra;  // 32f BGRA, what Premiere hands a GPU effect
};

// max |a-b| over colour channels, in 1/255 units; and share above 0.5/255.
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

// CPU reference, on the same (possibly half-rounded) input.
static std::vector<float> cpuRef(const pm::Lut3D& lut, std::vector<float> px, int w, int h, float amount, bool half) {
    if (half)
        for (auto& v : px) v = fromHalf(toHalf(v));
    pm::ImageF img{px.data(), w, h, long(w) * 16, pm::Layout::BGRA};
    pm::applyF(lut, img, img, amount);
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

static std::vector<float> unpack(const std::vector<uint8_t>& b, bool half) {
    std::vector<float> px(b.size() / (half ? 2 : 4));
    for (size_t i = 0; i < px.size(); i++) {
        if (half) {
            uint16_t h;
            std::memcpy(&h, &b[2 * i], 2);
            px[i] = fromHalf(h);
        } else {
            std::memcpy(&px[i], &b[4 * i], 4);
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

static int runOpenCl(const pm::Lut3D& lut, const Frame& f, float amount) {
    const OpenClApi& cl = OpenCl();
    if (!cl.ok || !cl.GetPlatformIDs) {
        std::printf("{\"run\":\"opencl\",\"error\":\"OpenCL.dll not usable\"}\n");
        return 1;
    }
    cl_platform_id platforms[8];
    cl_uint np = 0;
    cl.GetPlatformIDs(8, platforms, &np);
    cl_device_id device = nullptr;
    for (cl_uint i = 0; i < np && !device; i++) cl.GetDeviceIDs(platforms[i], CL_DEVICE_TYPE_GPU, 1, &device, nullptr);
    if (!device) {
        std::printf("{\"run\":\"opencl\",\"error\":\"no GPU device\"}\n");
        return 1;
    }
    cl_int r = 0;
    cl_context ctx = cl.CreateContext(nullptr, 1, &device, nullptr, nullptr, &r);
    cl_command_queue q = cl.CreateCommandQueue(ctx, device, 0, &r);
    const char* src = kProMatchLutCl;
    cl_program prog = cl.CreateProgramWithSource(ctx, 1, &src, nullptr, &r);
    r = cl.BuildProgram(prog, 1, &device, "-cl-single-precision-constant", nullptr, nullptr);
    if (r != CL_SUCCESS) {
        char log[4096] = {};
        cl.GetProgramBuildInfo(prog, device, CL_PROGRAM_BUILD_LOG, sizeof(log) - 1, log, nullptr);
        std::printf("{\"run\":\"opencl\",\"error\":\"build %d\"}\n%s\n", r, log);
        return 1;
    }
    cl_kernel k = cl.CreateKernel(prog, "ProMatchLut", &r);
    cl_mem lutBuf = cl.CreateBuffer(ctx, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR, lut.data.size() * 4,
                                    const_cast<float*>(lut.data.data()), &r);
    for (int half = 0; half < 2; half++) {
        std::vector<uint8_t> in = pack(f.bgra, half);
        // 32f in place (src == dst); 16f into a separate frame, as Premiere may do either.
        cl_mem a = cl.CreateBuffer(ctx, CL_MEM_READ_WRITE | CL_MEM_COPY_HOST_PTR, in.size(), in.data(), &r);
        cl_mem b = half ? cl.CreateBuffer(ctx, CL_MEM_READ_WRITE, in.size(), nullptr, &r) : a;
        SetClArgs(cl, k, a, b, lutBuf, argsFor(lut, f.width, f.height, half, amount));
        const size_t block[2] = {16, 16};
        const size_t grid[2] = {size_t((f.width + 15) / 16 * 16), size_t((f.height + 15) / 16 * 16)};
        cl.EnqueueNDRangeKernel(q, k, 2, nullptr, grid, block, 0, nullptr, nullptr);  // warm-up
        cl.Finish(q);
        if (!half) {  // in place: start again from the input
            cl.ReleaseMemObject(a);
            a = b = cl.CreateBuffer(ctx, CL_MEM_READ_WRITE | CL_MEM_COPY_HOST_PTR, in.size(), in.data(), &r);
            // Amount 0 in place leaves the frame as it is but makes the driver upload it, so the
            // timed launch below measures the kernel, not the transfer.
            SetClArgs(cl, k, a, b, lutBuf, argsFor(lut, f.width, f.height, half, 0.f));
            cl.EnqueueNDRangeKernel(q, k, 2, nullptr, grid, block, 0, nullptr, nullptr);
            cl.Finish(q);
            SetClArgs(cl, k, a, b, lutBuf, argsFor(lut, f.width, f.height, half, amount));
        }
        auto t0 = std::chrono::steady_clock::now();
        r = cl.EnqueueNDRangeKernel(q, k, 2, nullptr, grid, block, 0, nullptr, nullptr);
        cl.Finish(q);
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        std::vector<uint8_t> out(in.size());
        cl.EnqueueReadBuffer(q, b, 1, 0, out.size(), out.data(), 0, nullptr, nullptr);
        report(half ? "opencl 16f src->dst" : "opencl 32f in-place", unpack(out, half),
               cpuRef(lut, f.bgra, f.width, f.height, amount, half), ms);
        if (b != a) cl.ReleaseMemObject(b);
        cl.ReleaseMemObject(a);
    }
    return 0;
}

#if PM_HAS_CUDA
static int runCuda(const pm::Lut3D& lut, const Frame& f, float amount) {
    const CudaApi& cu = Cuda();
    if (!cu.ok || !cu.Init || cu.Init(0) != 0) {
        std::printf("{\"run\":\"cuda\",\"error\":\"nvcuda.dll not usable\"}\n");
        return 1;
    }
    CUdevice dev;
    CUcontext ctx;
    cu.DeviceGet(&dev, 0);
    cu.CtxCreate(&ctx, 0, dev);
    CUmodule mod;
    CUfunction fn;
    CUresult r = cu.ModuleLoadData(&mod, kProMatchLutPtx);
    if (r == 0) r = cu.ModuleGetFunction(&fn, mod, "ProMatchLut");
    if (r != 0) {
        std::printf("{\"run\":\"cuda\",\"error\":\"module %d\"}\n", r);
        return 1;
    }
    CUdeviceptr lutBuf;
    cu.MemAlloc(&lutBuf, lut.data.size() * 4);
    cu.MemcpyHtoD(lutBuf, lut.data.data(), lut.data.size() * 4);
    for (int half = 0; half < 2; half++) {
        std::vector<uint8_t> in = pack(f.bgra, half);
        CUdeviceptr a, b;
        cu.MemAlloc(&a, in.size());
        b = a;
        if (half) cu.MemAlloc(&b, in.size());
        cu.MemcpyHtoD(a, in.data(), in.size());
        LaunchCuda(cu, fn, nullptr, a, b, lutBuf, argsFor(lut, f.width, f.height, half, amount));  // warm-up
        cu.CtxSynchronize();
        cu.MemcpyHtoD(a, in.data(), in.size());
        auto t0 = std::chrono::steady_clock::now();
        r = LaunchCuda(cu, fn, nullptr, a, b, lutBuf, argsFor(lut, f.width, f.height, half, amount));
        cu.CtxSynchronize();
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        std::vector<uint8_t> out(in.size());
        cu.MemcpyDtoH(out.data(), b, out.size());
        report(half ? "cuda 16f src->dst" : "cuda 32f in-place", unpack(out, half),
               cpuRef(lut, f.bgra, f.width, f.height, amount, half), ms);
        if (b != a) cu.MemFree(b);
        cu.MemFree(a);
    }
    cu.MemFree(lutBuf);
    cu.CtxDestroy(ctx);
    return 0;
}
#endif

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
    Frame f{std::atoi(argv[3]), std::atoi(argv[4]), {}};
    const std::string raw = slurp(argv[2]);
    if (raw.size() != size_t(f.width) * f.height * 4) {
        std::fprintf(stderr, "input is not %dx%d RGBA\n", f.width, f.height);
        return 1;
    }
    f.bgra.resize(raw.size());
    for (size_t i = 0; i < raw.size(); i += 4) {
        f.bgra[i + 0] = uint8_t(raw[i + 2]) / 255.f;
        f.bgra[i + 1] = uint8_t(raw[i + 1]) / 255.f;
        f.bgra[i + 2] = uint8_t(raw[i + 0]) / 255.f;
        f.bgra[i + 3] = uint8_t(raw[i + 3]) / 255.f;
    }
    const float amount = argc > 5 ? float(std::atof(argv[5])) : 1.f;
    int rc = runOpenCl(lut, f, amount);
#if PM_HAS_CUDA
    rc |= runCuda(lut, f, amount);
#else
    std::printf("{\"run\":\"cuda\",\"skipped\":\"built without nvcc\"}\n");
#endif
    return rc;
}
