// ProMatch LUT engine: .cube parsing, tetrahedral lookup, threaded apply.
// No dependency on the Adobe SDK, so it builds and is tested on its own
// (native/test/lutapply.cpp).
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace pm {

struct Lut3D {
    int size = 0;
    float domainMin[3] = {0, 0, 0};
    float domainMax[3] = {1, 1, 1};
    // size^3 * 3 floats, red fastest (the .cube order, same as src/core/lut.ts).
    std::vector<float> data;
};

// Parse .cube text. Returns false and sets `error` on malformed input.
bool parseCube(const std::string& text, Lut3D& out, std::string* error = nullptr);

// Tetrahedral lookup of one RGB triple. Input is clamped to the LUT domain.
void sampleTetra(const Lut3D& lut, const float in[3], float out[3]);

// Channel order of a 4-channel pixel buffer.
enum class Layout { BGRA, ARGB, RGBA };

struct Image8 {
    uint8_t* data;
    int width, height;
    long rowBytes;
    Layout layout;
};

struct ImageF {
    float* data;
    int width, height;
    long rowBytes;  // in bytes
    Layout layout;
};

// Apply in place (src may equal dst) with Amount 0..1. Alpha is copied.
// Rows are split across threads.
void apply8(const Lut3D& lut, const Image8& src, const Image8& dst, float amount);
void applyF(const Lut3D& lut, const ImageF& src, const ImageF& dst, float amount);

// ---------------------------------------------------------- embedded LUTs
// A LUT stored in the effect itself (an arbitrary-data parameter), so the
// project carries it. The text, as scripts set it (toEmbeddedText() in
// src/core/lut.ts): "PMLUT1 <size> <lo> <hi> <base64>", the data being
// size^3 * 3 little-endian uint16 values (red fastest) mapped linearly onto
// [lo, hi]; or "PMLUT0" for none.
// Premiere stores a script's string in the parameter as-is, UTF-16LE, without
// calling the effect's scan callback (spike P9), so the parameter's bytes are
// that text in UTF-16LE. ASCII is accepted too.

// The text as ASCII if `bytes` hold PMLUT text (UTF-16LE or ASCII), else "".
std::string embeddedText(const void* bytes, size_t len);
// UTF-16LE bytes of an ASCII string (what the parameter holds).
std::vector<uint8_t> toUtf16(const std::string& ascii);
// Parse the text. "PMLUT0" gives size 0 and true.
bool parseEmbeddedText(const std::string& text, Lut3D& out, std::string* error = nullptr);
// The decoded LUT for a parameter's bytes, cached by content. nullptr for
// none, or malformed (then `error` says why).
std::shared_ptr<const Lut3D> embeddedLut(const void* bytes, size_t len, std::string* error = nullptr);

// %APPDATA%\ProMatch\<rel>
std::wstring dataPath(const std::wstring& rel);

// %APPDATA%\ProMatch\luts\<id>.cube
std::wstring lutPath(long id);

// Append one line to %APPDATA%\ProMatch\effect.log (diagnostics; thread-safe).
void logLine(const char* fmt, ...);

// The LUT for `id`, parsed once per (id, revision, file mtime/size) and then
// shared by every render thread. nullptr if the file is missing or malformed.
std::shared_ptr<const Lut3D> cachedLut(long id, long revision, std::string* error = nullptr);

}  // namespace pm
