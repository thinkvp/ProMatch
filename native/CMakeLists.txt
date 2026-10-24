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
# The SDK's folder layout varies by release; find the Headers dir that holds
# AE_Effect.h, anywhere under native/sdk.
file(GLOB_RECURSE PM_AE_EFFECT_H ${CMAKE_CURRENT_SOURCE_DIR}/sdk/*/AE_Effect.h)
list(FILTER PM_AE_EFFECT_H EXCLUDE REGEX "/(Effect|AEGP|GP)/")
if(NOT PM_AE_EFFECT_H)
  message(WARNING "Adobe After Effects SDK not found under native/sdk: building the engine test only.")
  return()
endif()
list(GET PM_AE_EFFECT_H 0 PM_FIRST)
get_filename_component(PM_SDK_HEADERS ${PM_FIRST} DIRECTORY)
get_filename_component(PM_SDK_ROOT ${PM_SDK_HEADERS} DIRECTORY)
find_program(PM_PIPLTOOL PiPLtool PATHS ${PM_SDK_ROOT}/Resources ${PM_SDK_ROOT}/Examples/Resources NO_DEFAULT_PATH REQUIRED)
message(STATUS "AE SDK headers: ${PM_SDK_HEADERS}")

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

add_library(ProMatch MODULE src/ProMatch.cpp ${PM_RC})
target_include_directories(ProMatch PRIVATE
  ${PM_SDK_HEADERS} ${PM_SDK_HEADERS}/SP ${PM_SDK_HEADERS}/Win ${PM_SDK_HEADERS}/adobesdk
  ${PM_SDK_ROOT}/Util ${PM_SDK_ROOT}/Examples/Util)
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
