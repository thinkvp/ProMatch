// Just enough of the CUDA driver API and OpenCL to launch ProMatch's LUT
// kernel, loaded at runtime from nvcuda.dll / OpenCL.dll (both ship with the
// GPU driver), so neither toolkit's headers or import libraries are needed.
// Used by the GPU filter (ProMatch_GPU.cpp) and the GPU test (test/gputest.cpp).
#pragma once

#include <windows.h>

#include <cstddef>
#include <mutex>

namespace pmgpu {

// ------------------------------------------------------------ CUDA driver

typedef int CUresult;
typedef int CUdevice;
typedef struct CUctx_st* CUcontext;
typedef struct CUmod_st* CUmodule;
typedef struct CUfunc_st* CUfunction;
typedef struct CUstream_st* CUstream;
typedef unsigned long long CUdeviceptr;

struct CudaApi {
    bool ok = false;  // everything the filter needs
    CUresult(__stdcall* ModuleLoadData)(CUmodule*, const void*) = nullptr;
    CUresult(__stdcall* ModuleGetFunction)(CUfunction*, CUmodule, const char*) = nullptr;
    CUresult(__stdcall* MemAlloc)(CUdeviceptr*, size_t) = nullptr;
    CUresult(__stdcall* MemFree)(CUdeviceptr) = nullptr;
    CUresult(__stdcall* MemcpyHtoD)(CUdeviceptr, const void*, size_t) = nullptr;
    CUresult(__stdcall* LaunchKernel)(CUfunction, unsigned, unsigned, unsigned, unsigned, unsigned, unsigned,
                                      unsigned, CUstream, void**, void**) = nullptr;
    CUresult(__stdcall* CtxPushCurrent)(CUcontext) = nullptr;
    CUresult(__stdcall* CtxPopCurrent)(CUcontext*) = nullptr;
    CUresult(__stdcall* StreamSynchronize)(CUstream) = nullptr;
    // Test only: own context, read back.
    CUresult(__stdcall* Init)(unsigned) = nullptr;
    CUresult(__stdcall* DeviceGet)(CUdevice*, int) = nullptr;
    CUresult(__stdcall* CtxCreate)(CUcontext*, unsigned, CUdevice) = nullptr;
    CUresult(__stdcall* CtxDestroy)(CUcontext) = nullptr;
    CUresult(__stdcall* MemcpyDtoH)(void*, CUdeviceptr, size_t) = nullptr;
    CUresult(__stdcall* CtxSynchronize)() = nullptr;
};

inline const CudaApi& Cuda() {
    static CudaApi api;
    static std::once_flag once;
    std::call_once(once, [] {
        HMODULE m = LoadLibraryW(L"nvcuda.dll");
        if (!m) return;
        auto get = [&](void* fn, const char* name) { *(void**)fn = reinterpret_cast<void*>(GetProcAddress(m, name)); };
        get(&api.ModuleLoadData, "cuModuleLoadData");
        get(&api.ModuleGetFunction, "cuModuleGetFunction");
        get(&api.MemAlloc, "cuMemAlloc_v2");
        get(&api.MemFree, "cuMemFree_v2");
        get(&api.MemcpyHtoD, "cuMemcpyHtoD_v2");
        get(&api.LaunchKernel, "cuLaunchKernel");
        get(&api.CtxPushCurrent, "cuCtxPushCurrent_v2");
        get(&api.CtxPopCurrent, "cuCtxPopCurrent_v2");
        get(&api.StreamSynchronize, "cuStreamSynchronize");
        get(&api.Init, "cuInit");
        get(&api.DeviceGet, "cuDeviceGet");
        get(&api.CtxCreate, "cuCtxCreate_v2");
        get(&api.CtxDestroy, "cuCtxDestroy_v2");
        get(&api.MemcpyDtoH, "cuMemcpyDtoH_v2");
        get(&api.CtxSynchronize, "cuCtxSynchronize");
        api.ok = api.ModuleLoadData && api.ModuleGetFunction && api.MemAlloc && api.MemFree && api.MemcpyHtoD &&
                 api.LaunchKernel && api.CtxPushCurrent && api.CtxPopCurrent && api.StreamSynchronize;
    });
    return api;
}

// ------------------------------------------------------------ OpenCL

typedef int cl_int;
typedef unsigned int cl_uint;
typedef unsigned long long cl_mem_flags;
typedef unsigned long long cl_device_type;
typedef struct _cl_platform_id* cl_platform_id;
typedef struct _cl_context* cl_context;
typedef struct _cl_device_id* cl_device_id;
typedef struct _cl_command_queue* cl_command_queue;
typedef struct _cl_program* cl_program;
typedef struct _cl_kernel* cl_kernel;
typedef struct _cl_mem* cl_mem;
typedef struct _cl_event* cl_event;
const cl_int CL_SUCCESS = 0;
const cl_mem_flags CL_MEM_READ_WRITE = 1 << 0;
const cl_mem_flags CL_MEM_READ_ONLY = 1 << 2;
const cl_mem_flags CL_MEM_COPY_HOST_PTR = 1 << 5;
const cl_uint CL_PROGRAM_BUILD_LOG = 0x1183;
const cl_device_type CL_DEVICE_TYPE_GPU = 1 << 2;

struct OpenClApi {
    bool ok = false;  // everything the filter needs
    cl_program(__stdcall* CreateProgramWithSource)(cl_context, cl_uint, const char**, const size_t*, cl_int*) = nullptr;
    cl_int(__stdcall* BuildProgram)(cl_program, cl_uint, const cl_device_id*, const char*, void*, void*) = nullptr;
    cl_int(__stdcall* GetProgramBuildInfo)(cl_program, cl_device_id, cl_uint, size_t, void*, size_t*) = nullptr;
    cl_kernel(__stdcall* CreateKernel)(cl_program, const char*, cl_int*) = nullptr;
    cl_int(__stdcall* SetKernelArg)(cl_kernel, cl_uint, size_t, const void*) = nullptr;
    cl_int(__stdcall* EnqueueNDRangeKernel)(cl_command_queue, cl_kernel, cl_uint, const size_t*, const size_t*,
                                            const size_t*, cl_uint, const cl_event*, cl_event*) = nullptr;
    cl_mem(__stdcall* CreateBuffer)(cl_context, cl_mem_flags, size_t, void*, cl_int*) = nullptr;
    cl_int(__stdcall* ReleaseMemObject)(cl_mem) = nullptr;
    cl_int(__stdcall* Finish)(cl_command_queue) = nullptr;
    // Test only: own context and queue, read back.
    cl_int(__stdcall* GetPlatformIDs)(cl_uint, cl_platform_id*, cl_uint*) = nullptr;
    cl_int(__stdcall* GetDeviceIDs)(cl_platform_id, cl_device_type, cl_uint, cl_device_id*, cl_uint*) = nullptr;
    cl_context(__stdcall* CreateContext)(const void*, cl_uint, const cl_device_id*, void*, void*, cl_int*) = nullptr;
    cl_command_queue(__stdcall* CreateCommandQueue)(cl_context, cl_device_id, unsigned long long, cl_int*) = nullptr;
    cl_int(__stdcall* EnqueueReadBuffer)(cl_command_queue, cl_mem, cl_uint, size_t, size_t, void*, cl_uint,
                                         const cl_event*, cl_event*) = nullptr;
};

inline const OpenClApi& OpenCl() {
    static OpenClApi api;
    static std::once_flag once;
    std::call_once(once, [] {
        HMODULE m = LoadLibraryW(L"OpenCL.dll");
        if (!m) return;
        auto get = [&](void* fn, const char* name) { *(void**)fn = reinterpret_cast<void*>(GetProcAddress(m, name)); };
        get(&api.CreateProgramWithSource, "clCreateProgramWithSource");
        get(&api.BuildProgram, "clBuildProgram");
        get(&api.GetProgramBuildInfo, "clGetProgramBuildInfo");
        get(&api.CreateKernel, "clCreateKernel");
        get(&api.SetKernelArg, "clSetKernelArg");
        get(&api.EnqueueNDRangeKernel, "clEnqueueNDRangeKernel");
        get(&api.CreateBuffer, "clCreateBuffer");
        get(&api.ReleaseMemObject, "clReleaseMemObject");
        get(&api.Finish, "clFinish");
        get(&api.GetPlatformIDs, "clGetPlatformIDs");
        get(&api.GetDeviceIDs, "clGetDeviceIDs");
        get(&api.CreateContext, "clCreateContext");
        get(&api.CreateCommandQueue, "clCreateCommandQueue");
        get(&api.EnqueueReadBuffer, "clEnqueueReadBuffer");
        api.ok = api.CreateProgramWithSource && api.BuildProgram && api.GetProgramBuildInfo && api.CreateKernel &&
                 api.SetKernelArg && api.EnqueueNDRangeKernel && api.CreateBuffer && api.ReleaseMemObject &&
                 api.Finish;
    });
    return api;
}

// The kernel's arguments, in order (see kernels/ProMatchLut.cu / .cl).
struct LutKernelArgs {
    int srcPitch, dstPitch, is16f, width, height, size;
    float dmin[3], dmax[3], amount;
    // Calibration pattern: grid size n (0 = apply the LUT) and its layout.
    int probe = 0, probeCols = 1, probeRows = 1;
};

// Set the OpenCL kernel's arguments.
inline void SetClArgs(const OpenClApi& cl, cl_kernel k, cl_mem src, cl_mem dst, cl_mem lut, const LutKernelArgs& a) {
    cl_uint i = 0;
    cl.SetKernelArg(k, i++, sizeof(cl_mem), &src);
    cl.SetKernelArg(k, i++, sizeof(int), &a.srcPitch);
    cl.SetKernelArg(k, i++, sizeof(cl_mem), &dst);
    cl.SetKernelArg(k, i++, sizeof(int), &a.dstPitch);
    cl.SetKernelArg(k, i++, sizeof(int), &a.is16f);
    cl.SetKernelArg(k, i++, sizeof(int), &a.width);
    cl.SetKernelArg(k, i++, sizeof(int), &a.height);
    cl.SetKernelArg(k, i++, sizeof(cl_mem), &lut);
    cl.SetKernelArg(k, i++, sizeof(int), &a.size);
    for (int c = 0; c < 3; c++) cl.SetKernelArg(k, i++, sizeof(float), &a.dmin[c]);
    for (int c = 0; c < 3; c++) cl.SetKernelArg(k, i++, sizeof(float), &a.dmax[c]);
    cl.SetKernelArg(k, i++, sizeof(float), &a.amount);
    cl.SetKernelArg(k, i++, sizeof(int), &a.probe);
    cl.SetKernelArg(k, i++, sizeof(int), &a.probeCols);
    cl.SetKernelArg(k, i++, sizeof(int), &a.probeRows);
}

// Launch the CUDA kernel (caller has the context current).
inline CUresult LaunchCuda(const CudaApi& cu, CUfunction f, CUstream stream, CUdeviceptr src, CUdeviceptr dst,
                           CUdeviceptr lut, LutKernelArgs a) {
    void* args[] = {&src, &a.srcPitch, &dst, &a.dstPitch, &a.is16f, &a.width, &a.height, &lut, &a.size,
                    &a.dmin[0], &a.dmin[1], &a.dmin[2], &a.dmax[0], &a.dmax[1], &a.dmax[2], &a.amount,
                    &a.probe,   &a.probeCols, &a.probeRows};
    return cu.LaunchKernel(f, (a.width + 15) / 16, (a.height + 15) / 16, 1, 16, 16, 1, 0, stream, args, nullptr);
}

}  // namespace pmgpu
