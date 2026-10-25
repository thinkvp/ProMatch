// ProMatch GPU filter (Premiere Pro GPU effect API, PrSDKGPUFilter.h).
//
// Premiere calls xGPUFilterEntry when the project renders on the GPU, and
// pairs this filter with the CPU effect in the same plug-in (ProMatch.cpp).
// Initialize() opts in or out per device: if this filter can't run on
// Premiere's framework, Premiere renders the effect on the CPU instead.
//
// Frameworks: CUDA (kernel compiled to PTX at build time, loaded through the
// driver API in nvcuda.dll) and OpenCL (kernel source built at runtime, via
// OpenCL.dll). Both are loaded on demand, so the plug-in has no extra DLL
// dependencies. Kernels: kernels/ProMatchLut.cu and .cl.

// Same order as the SDK's GPU samples: PrGPUFilterModule.h needs the AE
// support header (PF_TransitionSuite) first.
#include "AEConfig.h"
#include "PrSDKTypes.h"
#include "AE_Effect.h"
#include "PrSDKAESupport.h"
#include "PrGPUFilterModule.h"

#include <cmath>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <string>

#include "ProMatch.h"
#include "gpu_api.h"
#include "lut_engine.h"
#include "ProMatchLut_cl.h"  // generated: kProMatchLutCl
#if PM_HAS_CUDA
#include "ProMatchLut_ptx.h"  // generated: kProMatchLutPtx
#endif

namespace {

using namespace pmgpu;

// ------------------------------------------------------ per-device state

// Kernel and the uploaded LUT for one Premiere GPU device. Render calls for a
// device are serialised (OpenCL kernel arguments are not thread-safe).
struct Device {
    std::mutex mu;
    PrGPUDeviceFramework framework = PrGPUDeviceFramework_CUDA;
    bool ready = false;
    bool declined = false;  // this device can't run the filter (logged once)
    // CUDA
    CUmodule module = nullptr;
    CUfunction function = nullptr;
    CUdeviceptr cudaLut = 0;
    // OpenCL
    cl_kernel kernel = nullptr;
    cl_mem clLut = nullptr;
    // The LUT on the device (the engine's cached object, so identity = content).
    std::shared_ptr<const pm::Lut3D> lut;
};

std::mutex gDevicesMu;
std::map<csSDK_uint32, std::unique_ptr<Device>> gDevices;

Device& DeviceFor(csSDK_uint32 index) {
    std::lock_guard<std::mutex> lock(gDevicesMu);
    auto& d = gDevices[index];
    if (!d) d.reset(new Device());
    return *d;
}

const char* FrameworkName(PrGPUDeviceFramework f) {
    switch (f) {
        case PrGPUDeviceFramework_CUDA: return "CUDA";
        case PrGPUDeviceFramework_OpenCL: return "OpenCL";
        case PrGPUDeviceFramework_Metal: return "Metal";
        case PrGPUDeviceFramework_DirectX: return "DirectX";
        default: return "?";
    }
}

// Build the kernel for this device (once). Caller holds d.mu.
bool PrepareDevice(Device& d, const PrGPUDeviceInfo& info) {
    if (d.ready) return true;
    if (d.declined) return false;  // already tried and logged why
    d.declined = true;
    d.framework = info.outDeviceFramework;
    if (info.outDeviceFramework == PrGPUDeviceFramework_CUDA) {
#if PM_HAS_CUDA
        const CudaApi& cu = Cuda();
        if (!cu.ok) {
            pm::logLine("GPU: nvcuda.dll not usable");
            return false;
        }
        CUcontext ctx = (CUcontext)info.outContextHandle;
        cu.CtxPushCurrent(ctx);
        CUresult r = cu.ModuleLoadData(&d.module, kProMatchLutPtx);
        if (r == 0) r = cu.ModuleGetFunction(&d.function, d.module, "ProMatchLut");
        CUcontext popped;
        cu.CtxPopCurrent(&popped);
        if (r != 0) {
            pm::logLine("GPU: CUDA module load failed (%d)", r);
            return false;
        }
        d.ready = true;
        d.declined = false;
        return true;
#else
        pm::logLine("GPU: built without CUDA (no nvcc at build time); CPU render");
        return false;
#endif
    }
    if (info.outDeviceFramework == PrGPUDeviceFramework_OpenCL) {
        const OpenClApi& cl = OpenCl();
        if (!cl.ok) {
            pm::logLine("GPU: OpenCL.dll not usable");
            return false;
        }
        cl_context context = (cl_context)info.outContextHandle;
        cl_device_id device = (cl_device_id)info.outDeviceHandle;
        cl_int r = CL_SUCCESS;
        const char* src = kProMatchLutCl;
        cl_program program = cl.CreateProgramWithSource(context, 1, &src, nullptr, &r);
        if (r == CL_SUCCESS) r = cl.BuildProgram(program, 1, &device, "-cl-single-precision-constant", nullptr, nullptr);
        if (r != CL_SUCCESS) {
            char log[2048] = {};
            if (program) cl.GetProgramBuildInfo(program, device, CL_PROGRAM_BUILD_LOG, sizeof(log) - 1, log, nullptr);
            pm::logLine("GPU: OpenCL build failed (%d): %s", r, log);
            return false;
        }
        d.kernel = cl.CreateKernel(program, "ProMatchLut", &r);
        if (r != CL_SUCCESS) {
            pm::logLine("GPU: OpenCL kernel failed (%d)", r);
            return false;
        }
        d.ready = true;
        d.declined = false;
        return true;
    }
    pm::logLine("GPU: framework %s not supported; CPU render", FrameworkName(info.outDeviceFramework));
    return false;
}

// Make `lut` the device's LUT, uploading it if it changed. Caller holds d.mu.
bool UploadLut(Device& d, const PrGPUDeviceInfo& info, const std::shared_ptr<const pm::Lut3D>& lut) {
    if (d.lut == lut) return true;
    const size_t bytes = lut->data.size() * sizeof(float);
    if (d.framework == PrGPUDeviceFramework_CUDA) {
        const CudaApi& cu = Cuda();
        CUcontext ctx = (CUcontext)info.outContextHandle;
        cu.CtxPushCurrent(ctx);
        // Earlier launches may still read the old LUT.
        cu.StreamSynchronize((CUstream)info.outCommandQueueHandle);
        if (d.cudaLut) cu.MemFree(d.cudaLut);
        d.cudaLut = 0;
        CUresult r = cu.MemAlloc(&d.cudaLut, bytes);
        if (r == 0) r = cu.MemcpyHtoD(d.cudaLut, lut->data.data(), bytes);
        CUcontext popped;
        cu.CtxPopCurrent(&popped);
        if (r != 0) {
            pm::logLine("GPU: CUDA LUT upload failed (%d)", r);
            d.lut.reset();
            return false;
        }
    } else {
        const OpenClApi& cl = OpenCl();
        cl.Finish((cl_command_queue)info.outCommandQueueHandle);
        if (d.clLut) cl.ReleaseMemObject(d.clLut);
        cl_int r = CL_SUCCESS;
        d.clLut = cl.CreateBuffer((cl_context)info.outContextHandle, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR, bytes,
                                  const_cast<float*>(lut->data.data()), &r);
        if (r != CL_SUCCESS) {
            pm::logLine("GPU: OpenCL LUT upload failed (%d)", r);
            d.clLut = nullptr;
            d.lut.reset();
            return false;
        }
    }
    d.lut = lut;
    return true;
}

// ------------------------------------------------------------- the filter

class ProMatchGPU : public PrGPUFilterBase {
public:
    prSuiteError Initialize(PrGPUFilterInstance* ioInstanceData) override {
        PrGPUFilterBase::Initialize(ioInstanceData);
        if (!mDeviceInfo.outMeetsMinimumRequirementsForAcceleration) {
            pm::logLine("GPU: device %u below minimum requirements; CPU render", mDeviceIndex);
            return suiteError_Fail;
        }
        // Read the LUT now (it can't vary over time): Render then has it, and
        // the parameter probe runs even when this device is declined below.
        ReadLut(0);
        Device& d = DeviceFor(mDeviceIndex);
        std::lock_guard<std::mutex> lock(d.mu);
        if (!PrepareDevice(d, mDeviceInfo)) return suiteError_Fail;
        static bool logged = false;
        if (!logged) {
            logged = true;
            pm::logLine("GPU: filter ready on device %u (%s)", mDeviceIndex, FrameworkName(mDeviceInfo.outDeviceFramework));
        }
        return suiteError_NoError;
    }

    prSuiteError Render(const PrGPUFilterRenderParams* inRenderParams, const PPixHand* inFrames,
                        csSDK_size_t inFrameCount, PPixHand* outFrame) override {
        if (!inFrameCount || !outFrame || !*outFrame) return suiteError_Fail;
        const PrTime t = inRenderParams->inClipTime;
        const float amount = Float(GetParam(PM_PARAM_AMOUNT, t)) / 100.f;
        if (!mLutRead) ReadLut(t);

        void* srcData = nullptr;
        void* dstData = nullptr;
        mGPUDeviceSuite->GetGPUPPixData(inFrames[0], &srcData);
        mGPUDeviceSuite->GetGPUPPixData(*outFrame, &dstData);
        PrPixelFormat format = PrPixelFormat_Invalid;
        mPPixSuite->GetPixelFormat(*outFrame, &format);
        prRect bounds = {};
        mPPixSuite->GetBounds(*outFrame, &bounds);
        csSDK_int32 srcRowBytes = 0, dstRowBytes = 0;
        mPPixSuite->GetRowBytes(inFrames[0], &srcRowBytes);
        mPPixSuite->GetRowBytes(*outFrame, &dstRowBytes);
        const int width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
        const int bpp = GetGPUBytesPerPixel(format);

        LogSetup(format, width, height, srcData == dstData, amount);
        // The calibration pattern replaces the frame whatever Amount says.
        // Otherwise nothing to do in place; for separate frames, an identity
        // LUT at Amount 0 copies exactly.
        const int probe = mLut ? mLut->probe : 0;
        const bool active = mLut && !probe && amount > 0.f;
        if (!active && !probe && srcData == dstData) return suiteError_NoError;
        const std::shared_ptr<const pm::Lut3D> use = active ? mLut : Identity();

        Device& d = DeviceFor(mDeviceIndex);
        std::lock_guard<std::mutex> lock(d.mu);
        if (!UploadLut(d, mDeviceInfo, use)) return suiteError_Fail;
        const pm::Lut3D& lut = *use;
        LutKernelArgs args;
        args.srcPitch = srcRowBytes / bpp;
        args.dstPitch = dstRowBytes / bpp;
        args.is16f = format != PrPixelFormat_GPU_BGRA_4444_32f;
        args.width = width;
        args.height = height;
        args.size = lut.size;
        for (int c = 0; c < 3; c++) {
            args.dmin[c] = lut.domainMin[c];
            args.dmax[c] = lut.domainMax[c];
        }
        args.amount = active ? amount : 0.f;
        args.probe = probe;
        if (probe) pm::probeGrid(probe, width, height, &args.probeCols, &args.probeRows);

        if (d.framework == PrGPUDeviceFramework_CUDA) {
            const CudaApi& cu = Cuda();
            cu.CtxPushCurrent((CUcontext)mDeviceInfo.outContextHandle);
            const CUresult r = LaunchCuda(cu, d.function, (CUstream)mDeviceInfo.outCommandQueueHandle,
                                          (CUdeviceptr)srcData, (CUdeviceptr)dstData, d.cudaLut, args);
            CUcontext popped;
            cu.CtxPopCurrent(&popped);
            if (r != 0) pm::logLine("GPU: CUDA launch failed (%d)", r);
            return r == 0 ? suiteError_NoError : suiteError_Fail;
        }

        const OpenClApi& cl = OpenCl();
        SetClArgs(cl, d.kernel, (cl_mem)srcData, (cl_mem)dstData, d.clLut, args);
        const size_t block[2] = {16, 16};
        const size_t grid[2] = {RoundUp(width, 16), RoundUp(height, 16)};
        const cl_int r = cl.EnqueueNDRangeKernel((cl_command_queue)mDeviceInfo.outCommandQueueHandle, d.kernel, 2,
                                                 nullptr, grid, block, 0, nullptr, nullptr);
        if (r != CL_SUCCESS) pm::logLine("GPU: OpenCL launch failed (%d)", r);
        return r == CL_SUCCESS ? suiteError_NoError : suiteError_Fail;
    }

private:
    static std::shared_ptr<const pm::Lut3D> Identity() {
        static const std::shared_ptr<const pm::Lut3D> id = [] {
            auto l = std::make_shared<pm::Lut3D>();
            l->size = 2;
            for (int b = 0; b < 2; b++)
                for (int g = 0; g < 2; g++)
                    for (int r = 0; r < 2; r++) l->data.insert(l->data.end(), {float(r), float(g), float(b)});
            return l;
        }();
        return id;
    }

    static float Float(const PrParam& p) {
        if (p.mType == kPrParamType_Float64) return float(p.mFloat64);
        if (p.mType == kPrParamType_Float32) return p.mFloat32;
        if (p.mType == kPrParamType_Int32) return float(p.mInt32);
        return 0.f;
    }

    // The LUT, once per instance (Premiere makes a new instance when a
    // parameter changes, and the LUT can't vary over time).
    void ReadLut(PrTime t) {
        mLutRead = true;
        // An arbitrary-data param arrives as a memory block (the UTF-16 PMLUT
        // text), a fresh copy on every read, so it is ours to dispose (P10).
        const PrParam p = GetParam(PM_PARAM_LUT, t);
        if (p.mType == kPrParamType_PrMemoryPtr && p.mMemoryPtr) {
            const size_t len = mMemoryManagerSuite->GetPtrSize(p.mMemoryPtr);
            std::string err;
            mLut = pm::embeddedLut(p.mMemoryPtr, len, &err);
            if (!mLut && !err.empty()) pm::logLine("GPU: embedded LUT: %s", err.c_str());
            mMemoryManagerSuite->PrDisposePtr(p.mMemoryPtr);
        } else if (p.mType != 0) {
            static int logged = 0;
            if (logged++ < 3) pm::logLine("GPU: LUT param type %d (expected a memory block)", (int)p.mType);
        }
    }

    void LogSetup(PrPixelFormat format, int width, int height, bool inPlace, float amount) {
        static std::mutex mu;
        static std::string last;
        char key[200];
        std::snprintf(key, sizeof(key), "GPU Render %s fmt=%s %dx%d %s amount=%.3f lut=%d%s",
                      FrameworkName(mDeviceInfo.outDeviceFramework),
                      format == PrPixelFormat_GPU_BGRA_4444_32f ? "32f" : "16f", width, height,
                      inPlace ? "in-place" : "src->dst", amount, mLut ? (mLut->probe ? mLut->probe : mLut->size) : 0,
                      mLut && mLut->probe ? " pattern" : "");
        std::lock_guard<std::mutex> lock(mu);
        if (last != key) {
            last = key;
            pm::logLine("%s", key);
        }
    }

    bool mLutRead = false;
    std::shared_ptr<const pm::Lut3D> mLut;
};

}  // namespace

DECLARE_GPUFILTER_ENTRY(PrGPUFilterModule<ProMatchGPU>)
