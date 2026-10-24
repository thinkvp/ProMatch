# Pre-link step: Premiere (and Media Encoder) keep the loaded .aex open, so the
# linker cannot overwrite it. Windows does allow renaming a loaded DLL, so move
# it to build/stale/ under a unique name; the running apps keep using it.
if(EXISTS "${AEX}")
  string(TIMESTAMP stamp "%Y%m%d-%H%M%S")
  string(RANDOM LENGTH 6 tag)
  file(MAKE_DIRECTORY "${STALE}")
  file(RENAME "${AEX}" "${STALE}/ProMatch-${stamp}-${tag}.aex")
endif()
