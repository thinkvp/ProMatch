# ProMatch native effect (AE-API, hosted by Premiere Pro) + engine test tool.
#   cmake -S native -B native/build -G "Visual Studio 17 2022" -A x64
#   cmake --build native/build --config Release
# The .aex lands in native/out/, which is junctioned into Premiere's
# MediaCore plug-in folder (see native/PLAN.md).
cmake_minimum_required(VERSION 3.20)
project(ProMatchNative CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
if(MSVC)
  add_compile_options(/W3 /O2 /fp:fast /utf-8)
  add_compile_definitions(_CRT_SECURE_NO_WARNINGS NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

set(PM_OUT ${CMAKE_CURRENT_SOURCE_DIR}/out)

add_library(pm_lut STATIC src/lut_engine.cpp)
target_include_directories(pm_lut PUBLIC src)

add_executable(lutapply test/lutapply.cpp)
target_link_libraries(lutapply pm_lut)
set_target_properties(lutapply PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/build/bin)

# ---------------------------------------------------------------- the effect
# The Adobe SDKs (gitignored), each unzipped as downloaded:
#   native/sdk/aesdk  After Effects SDK: the effect API, PiPLtool
#   native/sdk/prsdk  Premiere Pro SDK: its GPU filter API (not used yet)
set(PM_AE_SDK ${CMAKE_CURRENT_SOURCE_DIR}/sdk/aesdk CACHE PATH "After Effects SDK folder")
set(PM_PR_SDK ${CMAKE_CURRENT_SOURCE_DIR}/sdk/prsdk CACHE PATH "Premiere Pro SDK folder")

# The SDK's inner layout varies by release (currently Examples/Headers): find
# the Headers dir that holds AE_Effect.h, skipping the sample projects.
file(GLOB_RECURSE PM_AE_EFFECT_H ${PM_AE_SDK}/*/AE_Effect.h)
list(FILTER PM_AE_EFFECT_H EXCLUDE REGEX "/(Effect|AEGP|GP)/")
if(NOT PM_AE_EFFECT_H)
  message(WARNING "After Effects SDK not found in ${PM_AE_SDK}: building the engine test only.")
  return()
endif()
list(GET PM_AE_EFFECT_H 0 PM_FIRST)
get_filename_component(PM_SDK_HEADERS ${PM_FIRST} DIRECTORY)
get_filename_component(PM_SDK_ROOT ${PM_SDK_HEADERS} DIRECTORY)
find_program(PM_PIPLTOOL PiPLtool PATHS ${PM_SDK_ROOT}/Resources NO_DEFAULT_PATH NO_CACHE REQUIRED)
message(STATUS "AE SDK headers: ${PM_SDK_HEADERS}")
if(EXISTS ${PM_PR_SDK}/Examples/Headers/PrSDKGPUFilter.h)
  message(STATUS "Premiere Pro SDK: ${PM_PR_SDK}")
endif()

# PiPL: preprocess the .r, convert with PiPLtool, preprocess again, then rc.
set(PM_R ${CMAKE_CURRENT_SOURCE_DIR}/src/ProMatchPiPL.r)
set(PM_RC ${CMAKE_CURRENT_BINARY_DIR}/ProMatchPiPL.rc)
add_custom_command(
  OUTPUT ${PM_RC}
  COMMAND cl /nologo /I "${PM_SDK_HEADERS}" /I "${CMAKE_CURRENT_SOURCE_DIR}/src" /D MSWindows /D _WINDOWS
          /EP /P "/Fi${CMAKE_CURRENT_BINARY_DIR}/ProMatchPiPL.rr" "/Tc${PM_R}"
  COMMAND "${PM_PIPLTOOL}" "${CMAKE_CURRENT_BINARY_DIR}/ProMatchPiPL.rr" "${CMAKE_CURRENT_BINARY_DIR}/ProMatchPiPL.rrc"
  COMMAND cl /nologo /D MSWindows /EP /P "/Fi${PM_RC}" "/Tc${CMAKE_CURRENT_BINARY_DIR}/ProMatchPiPL.rrc"
  DEPENDS ${PM_R} ${CMAKE_CURRENT_SOURCE_DIR}/src/ProMatch.h
  COMMENT "Building PiPL resource"
  VERBATIM)

# ------------------------------------------------------------ GPU filter
# Premiere's GPU effect API (Premiere Pro SDK): ProMatch_GPU.cpp, with the
# CUDA kernel compiled to PTX by nvcc (CUDA Toolkit, build machine only) and
# the OpenCL kernel embedded as source. Without the Premiere SDK the effect
# is CPU-only; without nvcc the GPU filter declines CUDA devices.
set(PM_GPU_OBJECTS)
if(EXISTS ${PM_PR_SDK}/Examples/Headers/PrSDKGPUFilter.h)
  set(PM_GEN ${CMAKE_CURRENT_BINARY_DIR}/gen)
  set(PM_KERNELS ${CMAKE_CURRENT_SOURCE_DIR}/src/kernels)
  add_custom_command(
    OUTPUT ${PM_GEN}/ProMatchLut_cl.h
    COMMAND ${CMAKE_COMMAND} -DIN=${PM_KERNELS}/ProMatchLut.cl -DOUT=${PM_GEN}/ProMatchLut_cl.h -DNAME=kProMatchLutCl
            -P ${CMAKE_CURRENT_SOURCE_DIR}/embed.cmake
    DEPENDS ${PM_KERNELS}/ProMatchLut.cl ${CMAKE_CURRENT_SOURCE_DIR}/embed.cmake
    VERBATIM)
  set(PM_GEN_HEADERS ${PM_GEN}/ProMatchLut_cl.h)

  # CUDA_PATH, else the toolkit's default folder (newest version first), for
  # shells started before the toolkit was installed.
  file(GLOB PM_CUDA_BINS "C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v*/bin")
  list(SORT PM_CUDA_BINS COMPARE NATURAL ORDER DESCENDING)
  find_program(PM_NVCC nvcc HINTS $ENV{CUDA_PATH}/bin ${PM_CUDA_BINS} NO_CACHE)
  set(PM_HAS_CUDA 0)
  if(PM_NVCC)
    set(PM_HAS_CUDA 1)
    # compute_75 PTX: the driver JIT-compiles it for any newer GPU (Turing+).
    add_custom_command(
      OUTPUT ${PM_GEN}/ProMatchLut_ptx.h
      COMMAND "${PM_NVCC}" -ptx -arch=compute_75 -O3 -o ${PM_GEN}/ProMatchLut.ptx ${PM_KERNELS}/ProMatchLut.cu
      COMMAND ${CMAKE_COMMAND} -DIN=${PM_GEN}/ProMatchLut.ptx -DOUT=${PM_GEN}/ProMatchLut_ptx.h -DNAME=kProMatchLutPtx
              -P ${CMAKE_CURRENT_SOURCE_DIR}/embed.cmake
      DEPENDS ${PM_KERNELS}/ProMatchLut.cu ${CMAKE_CURRENT_SOURCE_DIR}/embed.cmake
      COMMENT "nvcc: ProMatchLut.cu -> PTX"
      VERBATIM)
    list(APPEND PM_GEN_HEADERS ${PM_GEN}/ProMatchLut_ptx.h)
    message(STATUS "GPU filter: CUDA (${PM_NVCC}) + OpenCL")
  else()
    message(STATUS "GPU filter: OpenCL only (no nvcc; install the CUDA Toolkit for CUDA)")
  endif()

  add_library(pm_gpu OBJECT src/ProMatch_GPU.cpp ${PM_GEN_HEADERS})
  # Premiere's headers first: its PrSDKAESupport.h differs from the AE SDK's.
  target_include_directories(pm_gpu PRIVATE
    ${PM_GEN} ${PM_PR_SDK}/Examples/Headers ${PM_PR_SDK}/Examples/Projects/GPUVideoFilter/Utils
    ${PM_SDK_HEADERS} ${PM_SDK_HEADERS}/SP ${PM_SDK_HEADERS}/adobesdk src)
  target_compile_definitions(pm_gpu PRIVATE PM_HAS_CUDA=${PM_HAS_CUDA})
  target_compile_options(pm_gpu PRIVATE /wd4005)  # PrSDKTypes.h redefines NOMINMAX
  set(PM_GPU_OBJECTS $<TARGET_OBJECTS:pm_gpu>)

  # Kernel check on this PC's GPU against the CPU engine (no Premiere needed).
  add_executable(gputest test/gputest.cpp ${PM_GEN_HEADERS})
  target_include_directories(gputest PRIVATE ${PM_GEN} src)
  target_compile_definitions(gputest PRIVATE PM_HAS_CUDA=${PM_HAS_CUDA})
  target_link_libraries(gputest pm_lut)
  set_target_properties(gputest PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/build/bin)
endif()

add_library(ProMatch MODULE src/ProMatch.cpp ${PM_RC} ${PM_GPU_OBJECTS})
target_include_directories(ProMatch PRIVATE
  ${PM_SDK_HEADERS} ${PM_SDK_HEADERS}/SP ${PM_SDK_HEADERS}/Win ${PM_SDK_HEADERS}/adobesdk
  ${PM_SDK_ROOT}/Util)
target_compile_definitions(ProMatch PRIVATE MSWindows WIN32 _WINDOWS)
target_link_libraries(ProMatch PRIVATE pm_lut shell32 ole32)
set_target_properties(ProMatch PROPERTIES
  SUFFIX ".aex"
  LIBRARY_OUTPUT_DIRECTORY ${PM_OUT}
  LIBRARY_OUTPUT_DIRECTORY_RELEASE ${PM_OUT}
  LIBRARY_OUTPUT_DIRECTORY_DEBUG ${PM_OUT})
add_custom_command(TARGET ProMatch PRE_LINK
  COMMAND ${CMAKE_COMMAND} -DAEX=${PM_OUT}/ProMatch.aex -DSTALE=${CMAKE_CURRENT_BINARY_DIR}/stale
          -P ${CMAKE_CURRENT_SOURCE_DIR}/move-aside.cmake
  VERBATIM)
