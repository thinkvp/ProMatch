# Build step: embed a file as a NUL-terminated char array in a header.
#   cmake -DIN=<file> -DOUT=<header> -DNAME=<symbol> -P embed.cmake
# Bytes, not a string literal: PTX can exceed MSVC's literal size limit.
file(READ "${IN}" hex HEX)
string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," bytes "${hex}")
string(REGEX REPLACE "(0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,0x..,)" "\\1\n" bytes "${bytes}")
file(WRITE "${OUT}" "// Generated from ${IN} by embed.cmake. Do not edit.\n#pragma once\nstatic const char ${NAME}[] = {\n${bytes}0x00};\n")
