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
    // Embedded LUTs only: the panel's match ID (0 if none), and for the
    // calibration pattern (PMLUTP) its grid size n, with no LUT data.
    long id = 0;
    int probe = 0;
    // Embedded LUTs only: its name (UTF-8), shown in Effect Controls.
    std::string name;
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

// ------------------------------------------------------ calibration pattern
// In a scene-referred sequence (ACEScct, HLG, PQ) the effect sees working-space
// values, not the display picture the match was made on. The panel measures
// what Premiere does after the effect by showing this pattern and capturing
// the frame (src/core/calibrate.ts): n^3 colours spanning 0..1, one per cell
// of a grid over the whole frame. Cell idx = row * cols + col holds
// r = idx % n, g = idx / n % n, b = idx / n^2 (each over n - 1); cells past
// n^3 are black. Keep in step with probeLayout() in src/core/calibrate.ts
// and the kernels.
void probeGrid(int n, int width, int height, int* cols, int* rows);
// The pattern's colour at pixel (x, y), with probeGrid's cols and rows.
void probeColour(int n, int cols, int rows, int width, int height, int x, int y, float out[3]);
void fillProbe8(int n, const Image8& dst);
void fillProbeF(int n, const ImageF& dst);

// ---------------------------------------------------------- embedded LUTs
// A LUT stored in the effect itself (an arbitrary-data parameter), so the
// project carries it. The text, as scripts set it (toEmbeddedText() in
// src/core/lut.ts): "PMLUT3 <id> <name> <size> <lo> <hi> <base64>", the data
// being size^3 * 3 little-endian uint16 values (red fastest) mapped linearly
// onto [lo, hi], id the panel's match ID (how Apply finds every clip using a
// match; 0 for a LUT picked in Effect Controls) and name the LUT's name,
// percent-encoded UTF-8 ("-" for none). Older: "PMLUT2 <id> <size> ..."
// (build 7, no name) and "PMLUT1 <size> ..." (before 7, no ID). Also
// "PMLUTP <n>" for the calibration pattern, and "PMLUT0" for none.
// Premiere stores a script's string in the parameter as-is, UTF-16LE, without
// calling the effect's scan callback (spike P9), so the parameter's bytes are
// that text in UTF-16LE. ASCII is accepted too.

// The text as ASCII if `bytes` hold PMLUT text (UTF-16LE or ASCII), else "".
std::string embeddedText(const void* bytes, size_t len);
// UTF-16LE bytes of an ASCII string (what the parameter holds).
std::vector<uint8_t> toUtf16(const std::string& ascii);
// Parse the text. "PMLUT0" gives size 0 and true; "PMLUTP <n>" size 0 and probe n.
// The LUT as PMLUT3 text (its domain must be 0..1).
std::string toEmbeddedText(const Lut3D& lut, long id, const std::string& name);
bool parseEmbeddedText(const std::string& text, Lut3D& out, std::string* error = nullptr);
// The decoded LUT (or pattern) for a parameter's bytes, cached by content.
// nullptr for none, or malformed (then `error` says why).
std::shared_ptr<const Lut3D> embeddedLut(const void* bytes, size_t len, std::string* error = nullptr);

// %APPDATA%\ProMatch\<rel>
std::wstring dataPath(const std::wstring& rel);

// Where the panel saves this project's LUTs: the folder named in
// %APPDATA%\ProMatch\lut-folder.txt (the panel writes it on Apply), else
// Documents\ProMatch LUTs. Empty if neither is known.
std::wstring lutFolder();

// Append one line to %APPDATA%\ProMatch\effect.log (diagnostics; thread-safe).
void logLine(const char* fmt, ...);

}  // namespace pm
