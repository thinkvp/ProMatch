# Put a freshly built ProMatch.plugin into native/out without touching the one
# Premiere may have loaded: the old bundle is moved aside (its mapped binary
# stays valid), then the new one moved in. Overwriting a loaded binary in place
# can crash Premiere.
#   cmake -DNEW=<built bundle> -DOUT=<native/out> -DSTALE=<dir> -P mac-install.cmake
set(dest "${OUT}/ProMatch.plugin")
set(tmp "${OUT}/ProMatch.plugin.new")
file(REMOVE_RECURSE "${tmp}")
file(MAKE_DIRECTORY "${OUT}" "${STALE}")
file(COPY "${NEW}/" DESTINATION "${tmp}")
if(EXISTS "${dest}")
  string(TIMESTAMP stamp "%Y%m%d-%H%M%S")
  string(RANDOM LENGTH 4 suffix)
  file(RENAME "${dest}" "${STALE}/ProMatch.plugin.${stamp}-${suffix}")
endif()
file(RENAME "${tmp}" "${dest}")
# Old copies Premiere no longer has open (anything but the newest few).
file(GLOB old LIST_DIRECTORIES true "${STALE}/ProMatch.plugin.*")
list(LENGTH old n)
if(n GREATER 3)
  list(SORT old)
  math(EXPR drop "${n} - 3")
  list(SUBLIST old 0 ${drop} gone)
  file(REMOVE_RECURSE ${gone})
endif()
