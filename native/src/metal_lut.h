// Metal side of the ProMatch GPU filter (macOS), behind a plain C++
// interface so ProMatch_GPU.cpp and the GPU test stay C++. Objects are
// retained Objective-C objects passed as void*: id<MTLDevice>,
// id<MTLCommandQueue>, id<MTLComputePipelineState>, id<MTLBuffer>.
#pragma once

#include <cstddef>
#include <string>

#include "gpu_args.h"

namespace pmmetal {

// Compile the LUT kernel (kernels/ProMatchLut.metal, embedded) for `device`.
// nullptr and `error` on failure. Release() it when done.
void* CreatePipeline(void* device, std::string* error);

// A shared-storage buffer holding a copy of `bytes` of `data`.
void* NewBuffer(void* device, const void* data, size_t bytes);

void Release(void* object);

// Encode one launch on `queue`. src and dst may be the same buffer. Premiere's
// queue runs it after earlier work and before later work, so the filter
// doesn't wait; `wait` (the test) blocks until it is done and reports the GPU
// time in `gpuMs`. Errors are logged when the command buffer completes.
bool Launch(void* queue, void* pipeline, void* src, void* dst, void* lut, const pmgpu::LutKernelArgs& args, bool wait,
            std::string* error, double* gpuMs = nullptr);

// For the test: the system's default GPU, a queue on it, and a buffer's bytes.
void* DefaultDevice();
void* NewQueue(void* device);
void* Contents(void* buffer);
std::string DeviceName(void* device);

}  // namespace pmmetal
