// See metal_lut.h.
#import <Metal/Metal.h>

#include "metal_lut.h"

#include "ProMatchLut_metal.h"  // generated: kProMatchLutMetal
#include "lut_engine.h"

namespace pmmetal {

static void* Retain(id object) { return object ? (void*)CFBridgingRetain(object) : nullptr; }

void* CreatePipeline(void* device, std::string* error) {
    @autoreleasepool {
        id<MTLDevice> dev = (__bridge id<MTLDevice>)device;
        MTLCompileOptions* options = [[MTLCompileOptions alloc] init];
        // Exact IEEE maths: fast math may drop the NaN and range guards, and
        // the result has to match the CPU engine.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        options.fastMathEnabled = NO;
#pragma clang diagnostic pop
        NSError* err = nil;
        id<MTLLibrary> library = [dev newLibraryWithSource:[NSString stringWithUTF8String:kProMatchLutMetal]
                                                   options:options
                                                     error:&err];
        if (!library) {
            if (error) *error = std::string("compile: ") + (err ? err.localizedDescription.UTF8String : "?");
            return nullptr;
        }
        id<MTLFunction> function = [library newFunctionWithName:@"ProMatchLut"];
        if (!function) {
            if (error) *error = "no ProMatchLut function";
            return nullptr;
        }
        id<MTLComputePipelineState> pipeline = [dev newComputePipelineStateWithFunction:function error:&err];
        if (!pipeline) {
            if (error) *error = std::string("pipeline: ") + (err ? err.localizedDescription.UTF8String : "?");
            return nullptr;
        }
        return Retain(pipeline);
    }
}

void* NewBuffer(void* device, const void* data, size_t bytes) {
    id<MTLDevice> dev = (__bridge id<MTLDevice>)device;
    return Retain([dev newBufferWithBytes:data length:bytes options:MTLResourceStorageModeShared]);
}

void Release(void* object) {
    if (object) CFBridgingRelease(object);
}

bool Launch(void* queue, void* pipeline, void* src, void* dst, void* lut, const pmgpu::LutKernelArgs& args, bool wait,
            std::string* error, double* gpuMs) {
    @autoreleasepool {
        id<MTLCommandQueue> q = (__bridge id<MTLCommandQueue>)queue;
        id<MTLComputePipelineState> ps = (__bridge id<MTLComputePipelineState>)pipeline;
        id<MTLCommandBuffer> cb = [q commandBuffer];
        id<MTLComputeCommandEncoder> enc = cb ? [cb computeCommandEncoder] : nil;
        if (!enc) {
            if (error) *error = "no command buffer";
            return false;
        }
        [enc setComputePipelineState:ps];
        [enc setBuffer:(__bridge id<MTLBuffer>)src offset:0 atIndex:0];
        [enc setBuffer:(__bridge id<MTLBuffer>)dst offset:0 atIndex:1];
        [enc setBuffer:(__bridge id<MTLBuffer>)lut offset:0 atIndex:2];
        [enc setBytes:&args length:sizeof(args) atIndex:3];
        // Whole threadgroups with a bounds check in the kernel, which every
        // Metal GPU supports (dispatchThreads needs non-uniform groups).
        const MTLSize group = MTLSizeMake(16, 16, 1);
        const MTLSize groups = MTLSizeMake((NSUInteger(args.width) + 15) / 16, (NSUInteger(args.height) + 15) / 16, 1);
        [enc dispatchThreadgroups:groups threadsPerThreadgroup:group];
        [enc endEncoding];
        if (!wait) {
            // Log the first few failures; Render has returned by then.
            [cb addCompletedHandler:^(id<MTLCommandBuffer> done) {
                static int logged = 0;
                if (done.status == MTLCommandBufferStatusError && logged++ < 5)
                    pm::logLine("GPU: Metal launch failed: %s", done.error.localizedDescription.UTF8String);
            }];
        }
        [cb commit];
        if (wait) {
            [cb waitUntilCompleted];
            if (cb.status == MTLCommandBufferStatusError) {
                if (error) *error = cb.error.localizedDescription.UTF8String;
                return false;
            }
            if (gpuMs) *gpuMs = (cb.GPUEndTime - cb.GPUStartTime) * 1000.0;
        }
        return true;
    }
}

void* DefaultDevice() { return Retain(MTLCreateSystemDefaultDevice()); }

void* NewQueue(void* device) { return Retain([(__bridge id<MTLDevice>)device newCommandQueue]); }

void* Contents(void* buffer) { return [(__bridge id<MTLBuffer>)buffer contents]; }

std::string DeviceName(void* device) { return [(__bridge id<MTLDevice>)device name].UTF8String; }

}  // namespace pmmetal
