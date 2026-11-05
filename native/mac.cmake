# macOS half of native/CMakeLists.txt: the ProMatch effect as a universal
# ProMatch.plugin bundle. Included after the AE SDK is found, with
# PM_SDK_HEADERS, PM_SDK_ROOT, PM_PR_SDK, PM_R and PM_OUT set.
#
#   ProMatch.plugin/Contents/Info.plist        package type eFKT, creator FXTC
#   ProMatch.plugin/Contents/MacOS/ProMatch    the code (arm64 + x86_64)
#   ProMatch.plugin/Contents/Resources/ProMatch.rsrc   the PiPL, from Rez
#
# GPU: Metal. ProMatch_GPU.cpp (Premiere's GPU filter API) with metal_lut.mm,
# which compiles kernels/ProMatchLut.metal from embedded source at runtime, so
# no Metal toolchain is needed to build. Premiere on Intel Macs may also offer
# OpenCL; the filter declines it there and the effect renders on the CPU.

# PiPL: Rez compiles the .r straight into a data-fork resource file. It needs
# the SDK's Resources folder for AE_General.r and both architectures named,
# so CodeMacIntel64 and CodeMacARM64 both land in it.
find_program(PM_REZ Rez HINTS /Library/Developer/CommandLineTools/usr/bin REQUIRED)
set(PM_RSRC ${CMAKE_CURRENT_BINARY_DIR}/ProMatch.rsrc)
set(PM_REZ_ARCHS)
foreach(arch ${CMAKE_OSX_ARCHITECTURES})
  list(APPEND PM_REZ_ARCHS -arch ${arch})
endforeach()
execute_process(COMMAND xcrun --show-sdk-path OUTPUT_VARIABLE PM_MAC_SDK OUTPUT_STRIP_TRAILING_WHITESPACE)
add_custom_command(
  OUTPUT ${PM_RSRC}
  COMMAND "${PM_REZ}" ${PM_REZ_ARCHS} -useDF -d AE_OS_MAC -d __MACH__ -isysroot "${PM_MAC_SDK}"
          -i "${PM_SDK_HEADERS}" -i "${PM_SDK_ROOT}/Resources" -i "${CMAKE_CURRENT_SOURCE_DIR}/src"
          -o "${PM_RSRC}" "${PM_R}"
  DEPENDS ${PM_R} ${CMAKE_CURRENT_SOURCE_DIR}/src/ProMatch.h
  COMMENT "Rez: PiPL resource"
  VERBATIM)

# Bundle version: package.json's (npm run version:set keeps it current).
file(READ ${CMAKE_CURRENT_SOURCE_DIR}/../package.json PM_PACKAGE_JSON)
string(JSON PM_VERSION GET "${PM_PACKAGE_JSON}" version)
# Re-run configure when it changes, so a plain cmake --build picks up the new version.
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/../package.json)

# The SDK's Util folder isn't needed by the effect itself (no Util sources are
# compiled in), only its headers, as on Windows.
set(PM_GEN ${CMAKE_CURRENT_BINARY_DIR}/gen)
set(PM_KERNELS ${CMAKE_CURRENT_SOURCE_DIR}/src/kernels)
add_custom_command(
  OUTPUT ${PM_GEN}/ProMatchLut_metal.h
  COMMAND ${CMAKE_COMMAND} -DIN=${PM_KERNELS}/ProMatchLut.metal -DOUT=${PM_GEN}/ProMatchLut_metal.h -DNAME=kProMatchLutMetal
          -P ${CMAKE_CURRENT_SOURCE_DIR}/embed.cmake
  DEPENDS ${PM_KERNELS}/ProMatchLut.metal ${CMAKE_CURRENT_SOURCE_DIR}/embed.cmake
  VERBATIM)
add_library(pm_metal STATIC src/metal_lut.mm ${PM_GEN}/ProMatchLut_metal.h)
target_include_directories(pm_metal PUBLIC src PRIVATE ${PM_GEN})
target_compile_options(pm_metal PRIVATE -fobjc-arc)
target_link_libraries(pm_metal PUBLIC pm_lut "-framework Metal" "-framework Foundation")

# Kernel check on this Mac's GPU against the CPU engine (no Premiere needed).
add_executable(gputest test/gputest_metal.cpp)
# CoreGraphics: without it a command-line tool gets no MTLCreateSystemDefaultDevice.
target_link_libraries(gputest pm_metal "-framework CoreGraphics")
set_target_properties(gputest PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/build/bin)

set(PM_GPU_OBJECTS)
if(EXISTS ${PM_PR_SDK}/Examples/Headers/PrSDKGPUFilter.h)
  add_library(pm_gpu OBJECT src/ProMatch_GPU.cpp)
  # Premiere's headers first: its PrSDKAESupport.h differs from the AE SDK's.
  target_include_directories(pm_gpu PRIVATE
    ${PM_PR_SDK}/Examples/Headers ${PM_PR_SDK}/Examples/Projects/GPUVideoFilter/Utils
    ${PM_SDK_HEADERS} ${PM_SDK_HEADERS}/SP ${PM_SDK_HEADERS}/adobesdk src)
  target_compile_options(pm_gpu PRIVATE -Wno-unused-function)  # PrSDKPlayModule.h
  set(PM_GPU_OBJECTS $<TARGET_OBJECTS:pm_gpu>)
  message(STATUS "GPU filter: Metal")
else()
  message(STATUS "GPU filter: none (no Premiere Pro SDK in ${PM_PR_SDK}); CPU render")
endif()

add_library(ProMatch MODULE src/ProMatch.cpp src/mac_ui.mm ${PM_GPU_OBJECTS})
target_link_libraries(ProMatch PRIVATE pm_metal)
add_custom_target(pm_rsrc DEPENDS ${PM_RSRC})
add_dependencies(ProMatch pm_rsrc)
# A new PiPL alone must relink too, so the POST_BUILD copy and signing rerun.
set_property(TARGET ProMatch APPEND PROPERTY LINK_DEPENDS ${PM_RSRC})
target_include_directories(ProMatch PRIVATE
  ${PM_SDK_HEADERS} ${PM_SDK_HEADERS}/SP ${PM_SDK_HEADERS}/adobesdk ${PM_SDK_ROOT}/Util src)
target_compile_options(ProMatch PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_link_libraries(ProMatch PRIVATE pm_lut "-framework CoreFoundation" "-framework AppKit"
  "-framework UniformTypeIdentifiers")
set_target_properties(ProMatch PROPERTIES
  BUNDLE TRUE
  BUNDLE_EXTENSION plugin
  MACOSX_BUNDLE_INFO_PLIST ${CMAKE_CURRENT_SOURCE_DIR}/mac/Info.plist.in
  MACOSX_BUNDLE_GUI_IDENTIFIER com.promatch.effect
  MACOSX_BUNDLE_BUNDLE_NAME ProMatch
  MACOSX_BUNDLE_SHORT_VERSION_STRING ${PM_VERSION}
  MACOSX_BUNDLE_BUNDLE_VERSION ${PM_VERSION}
  # Built here, then moved into native/out (mac-install.cmake).
  LIBRARY_OUTPUT_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/plugin
  # EffectMain must stay visible; everything else can be hidden.
  CXX_VISIBILITY_PRESET hidden
  OBJCXX_VISIBILITY_PRESET hidden)

# The PiPL into Resources and PkgInfo (hosts use it to tell an effect bundle
# from any other), then sign. Copied here rather than with
# MACOSX_PACKAGE_LOCATION, which CMake does after POST_BUILD and so breaks
# the signature.
add_custom_command(TARGET ProMatch POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_BUNDLE_CONTENT_DIR:ProMatch>/Resources"
  COMMAND ${CMAKE_COMMAND} -E copy "${PM_RSRC}" "$<TARGET_BUNDLE_CONTENT_DIR:ProMatch>/Resources/ProMatch.rsrc"
  COMMAND /bin/sh -c "printf 'eFKTFXTC' > '$<TARGET_BUNDLE_CONTENT_DIR:ProMatch>/PkgInfo'"
  # Ad-hoc signature: Apple Silicon refuses unsigned code. Releases re-sign
  # with a Developer ID (docs/MAC.md).
  COMMAND codesign --force --sign - --timestamp=none "$<TARGET_BUNDLE_DIR:ProMatch>"
  COMMAND ${CMAKE_COMMAND} -DNEW=$<TARGET_BUNDLE_DIR:ProMatch> -DOUT=${PM_OUT} -DSTALE=${CMAKE_CURRENT_BINARY_DIR}/stale
          -P ${CMAKE_CURRENT_SOURCE_DIR}/mac-install.cmake
  VERBATIM)
