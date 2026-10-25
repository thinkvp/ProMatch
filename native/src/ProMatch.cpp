// ProMatch effect (AE effect API, hosted by Premiere Pro).
//
// Applies the colour match made in the ProMatch panel, blended by Amount.
// The LUT lives in the effect itself, in the hidden "LUT" arbitrary-data
// parameter, so it is saved with the project. The panel sets it as text
// (PMLUT text, see lut_engine.h), match ID included; any change re-renders.
// "PMLUTP <n>" there draws the calibration pattern instead (lut_engine.h).
// Two rows show the LUT's name with Change LUT (pick a .cube from the
// project's ProMatch LUTs folder and store it in the effect), and Edit LUT
// (ask the panel to reopen the match that made it).
//
// In Premiere it asks for BGRA 8u and BGRA 32f frames (the pixel format
// suite); elsewhere (After Effects) it takes the standard 8-bit ARGB world.

#include "AEConfig.h"
#include "entry.h"
#include "SPBasic.h"
#include "AE_Effect.h"
#include "AE_EffectCB.h"
#include "AE_EffectSuites.h"
#include "AE_Macros.h"
#include "Param_Utils.h"
#include "PrSDKAESupport.h"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <commdlg.h>
#endif

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <set>
#include <string>

#include "ProMatch.h"
#include "lut_engine.h"

enum {
    PM_INPUT = 0,
    PM_AMOUNT = PM_PARAM_AMOUNT,
    PM_LUT = PM_PARAM_LUT,
    PM_PICK = PM_PARAM_PICK,
    PM_EDIT = PM_PARAM_EDIT,
    PM_NUM_PARAMS
};

// Disk IDs: stable across versions so saved projects keep their values.
// 1 was Match ID (to build 6) and 3 the Revision slider of build 1; not reused.
enum {
    DISK_AMOUNT = 2,
    DISK_LUT = 4,
    DISK_PICK = 5,
    DISK_EDIT = 7,  // 6 and 8 were build 9's group; not reused
};

static const A_long kPremiere = 'PrMr';
static int kArbRefcon;  // its address tags our arbitrary-data callbacks

static PF_PixelFormatSuite1* AcquirePixelFormatSuite(PF_InData* in_data) {
    const void* suite = nullptr;
    if (in_data->pica_basicP &&
        in_data->pica_basicP->AcquireSuite(kPFPixelFormatSuite, kPFPixelFormatSuiteVersion1, &suite) == kSPNoError)
        return (PF_PixelFormatSuite1*)suite;
    return nullptr;
}

static void ReleasePixelFormatSuite(PF_InData* in_data) {
    in_data->pica_basicP->ReleaseSuite(kPFPixelFormatSuite, kPFPixelFormatSuiteVersion1);
}

static PF_Err About(PF_InData* in_data, PF_OutData* out_data) {
    std::snprintf(out_data->return_msg, sizeof(out_data->return_msg),
                  "%s %d.%d\rApplies the colour match made in the ProMatch panel.", PM_NAME, PM_MAJOR, PM_MINOR);
    return PF_Err_NONE;
}

static PF_Err GlobalSetup(PF_InData* in_data, PF_OutData* out_data) {
    const A_long h = in_data->appl_id;
    pm::logLine("GlobalSetup build %d host=%c%c%c%c api=%d.%d", PM_BUILD, char(h >> 24), char(h >> 16), char(h >> 8),
                char(h), in_data->version.major, in_data->version.minor);
    out_data->my_version = PF_VERSION(PM_MAJOR, PM_MINOR, PM_BUG, PF_Stage_DEVELOP, PM_BUILD);
    out_data->out_flags = PM_OUTFLAGS;
    out_data->out_flags2 = PM_OUTFLAGS2;

    if (in_data->appl_id == kPremiere) {
        if (PF_PixelFormatSuite1* pfs = AcquirePixelFormatSuite(in_data)) {
            pfs->ClearSupportedPixelFormats(in_data->effect_ref);
            pfs->AddSupportedPixelFormat(in_data->effect_ref, PrPixelFormat_BGRA_4444_32f);
            pfs->AddSupportedPixelFormat(in_data->effect_ref, PrPixelFormat_BGRA_4444_8u);
            ReleasePixelFormatSuite(in_data);
        } else {
            pm::logLine("GlobalSetup: no pixel format suite");
        }
    }
    return PF_Err_NONE;
}

// ------------------------------------------------------- arbitrary data

// A host handle holding `bytes` (a flat embedded LUT, see lut_engine.h).
static PF_Handle NewArb(PF_InData* in_data, const void* bytes, size_t len) {
    PF_Handle h = PF_NEW_HANDLE(len);
    if (!h) return nullptr;
    void* p = PF_LOCK_HANDLE(h);
    if (p) std::memcpy(p, bytes, len);
    PF_UNLOCK_HANDLE(h);
    return h;
}

static PF_Handle NewEmptyArb(PF_InData* in_data) {
    const std::vector<uint8_t> e = pm::toUtf16("PMLUT0");
    return NewArb(in_data, e.data(), e.size());
}

// Cheap check (prefix only) that bytes hold PMLUT text, UTF-16LE or ASCII.
static bool LooksEmbedded(const void* bytes, size_t len) {
    const uint8_t* b = static_cast<const uint8_t*>(bytes);
    if (!b || len < 10) return false;
    static const uint8_t kUtf16[] = {'P', 0, 'M', 0, 'L', 0, 'U', 0, 'T', 0};
    return std::memcmp(b, kUtf16, 10) == 0 || std::memcmp(b, "PMLUT", 5) == 0;
}

static PF_Handle CopyArb(PF_InData* in_data, PF_Handle src) {
    if (!src) return NewEmptyArb(in_data);
    const size_t len = size_t(PF_GET_HANDLE_SIZE(src));
    const void* p = PF_LOCK_HANDLE(src);
    PF_Handle h = LooksEmbedded(p, len) ? NewArb(in_data, p, len) : NewEmptyArb(in_data);
    PF_UNLOCK_HANDLE(src);
    return h;
}

static bool SameArb(PF_InData* in_data, PF_Handle a, PF_Handle b) {
    if (!a || !b) return a == b;
    const size_t la = size_t(PF_GET_HANDLE_SIZE(a)), lb = size_t(PF_GET_HANDLE_SIZE(b));
    if (la != lb) return false;
    const void* pa = PF_LOCK_HANDLE(a);
    const void* pb = PF_LOCK_HANDLE(b);
    const bool same = pa && pb && std::memcmp(pa, pb, la) == 0;
    PF_UNLOCK_HANDLE(b);
    PF_UNLOCK_HANDLE(a);
    return same;
}

// The parameter's text as ASCII ("" if it isn't ours).
static std::string ArbText(PF_InData* in_data, PF_Handle h) {
    if (!h) return std::string();
    const size_t len = size_t(PF_GET_HANDLE_SIZE(h));
    const void* p = PF_LOCK_HANDLE(h);
    std::string text = pm::embeddedText(p, len);
    PF_UNLOCK_HANDLE(h);
    return text;
}

static const char* kArbNames[] = {"NEW", "DISPOSE", "COPY", "FLAT_SIZE", "FLATTEN", "UNFLATTEN",
                                  "INTERP", "COMPARE", "PRINT_SIZE", "PRINT", "SCAN"};

// The "LUT" parameter's data is the PMLUT text exactly as Premiere hands it
// over (UTF-16LE from a script's setValue); it is decoded when rendering.
static PF_Err Arbitrary(PF_InData* in_data, PF_ArbParamsExtra* extra) {
    // Diagnostics: how the host drives these (first calls, and every print/scan).
    static std::atomic<int> logged{0};
    const int fn = int(extra->which_function);
    const bool textual = fn >= PF_Arbitrary_PRINT_SIZE_FUNC;
    if (textual || logged++ < 20) pm::logLine("Arb %s", fn >= 0 && fn <= 10 ? kArbNames[fn] : "?");

    switch (extra->which_function) {
        case PF_Arbitrary_NEW_FUNC:
            *extra->u.new_func_params.arbPH = NewEmptyArb(in_data);
            return PF_Err_NONE;

        case PF_Arbitrary_DISPOSE_FUNC:
            if (extra->u.dispose_func_params.arbH) PF_DISPOSE_HANDLE(extra->u.dispose_func_params.arbH);
            return PF_Err_NONE;

        case PF_Arbitrary_COPY_FUNC:
            *extra->u.copy_func_params.dst_arbPH = CopyArb(in_data, extra->u.copy_func_params.src_arbH);
            return PF_Err_NONE;

        case PF_Arbitrary_FLAT_SIZE_FUNC: {
            PF_Handle h = extra->u.flat_size_func_params.arbH;
            *extra->u.flat_size_func_params.flat_data_sizePLu = h ? A_u_long(PF_GET_HANDLE_SIZE(h)) : 0;
            return PF_Err_NONE;
        }

        case PF_Arbitrary_FLATTEN_FUNC: {
            auto& f = extra->u.flatten_func_params;
            if (!f.arbH) return PF_Err_NONE;
            const size_t len = size_t(PF_GET_HANDLE_SIZE(f.arbH));
            const void* p = PF_LOCK_HANDLE(f.arbH);
            if (p && f.flat_dataPV && f.buf_sizeLu >= len) std::memcpy(f.flat_dataPV, p, len);
            PF_UNLOCK_HANDLE(f.arbH);
            return PF_Err_NONE;
        }

        case PF_Arbitrary_UNFLATTEN_FUNC: {
            auto& f = extra->u.unflatten_func_params;
            const bool ours = LooksEmbedded(f.flat_dataPV, f.buf_sizeLu);
            *f.arbPH = ours ? NewArb(in_data, f.flat_dataPV, f.buf_sizeLu) : NewEmptyArb(in_data);
            if (!ours) pm::logLine("Arb UNFLATTEN: %u bytes are not PMLUT text, using none", (unsigned)f.buf_sizeLu);
            return PF_Err_NONE;
        }

        case PF_Arbitrary_INTERP_FUNC:
            // Not animatable (CANNOT_TIME_VARY); hold the left value regardless.
            *extra->u.interp_func_params.interpPH = CopyArb(in_data, extra->u.interp_func_params.left_arbH);
            return PF_Err_NONE;

        case PF_Arbitrary_COMPARE_FUNC: {
            auto& c = extra->u.compare_func_params;
            *c.compareP = SameArb(in_data, c.a_arbH, c.b_arbH) ? PF_ArbCompare_EQUAL : PF_ArbCompare_NOT_EQUAL;
            return PF_Err_NONE;
        }

        case PF_Arbitrary_PRINT_SIZE_FUNC: {
            auto& f = extra->u.print_size_func_params;
            *f.print_sizePLu = A_u_long(ArbText(in_data, f.arbH).size() + 1);
            return PF_Err_NONE;
        }

        case PF_Arbitrary_PRINT_FUNC: {
            auto& f = extra->u.print_func_params;
            const std::string text = ArbText(in_data, f.arbH);
            if (f.print_bufferPC && f.print_sizeLu) {
                const size_t k = std::min<size_t>(f.print_sizeLu - 1, text.size());
                std::memcpy(f.print_bufferPC, text.data(), k);
                f.print_bufferPC[k] = 0;
            }
            return PF_Err_NONE;
        }

        case PF_Arbitrary_SCAN_FUNC: {
            auto& f = extra->u.scan_func_params;
            const std::string text(f.bufPC, f.bytes_to_scanLu);
            pm::Lut3D check;
            std::string err;
            if (!pm::parseEmbeddedText(text, check, &err)) {
                pm::logLine("  scan %u bytes failed: %s", (unsigned)f.bytes_to_scanLu, err.c_str());
                return PF_Err_CANNOT_PARSE_KEYFRAME_TEXT;
            }
            const std::vector<uint8_t> utf16 = pm::toUtf16(text);
            *f.arbPH = NewArb(in_data, utf16.data(), utf16.size());
            return PF_Err_NONE;
        }
    }
    return PF_Err_NONE;
}

// ------------------------------------------------------------- params

static PF_Err ParamsSetup(PF_InData* in_data, PF_OutData* out_data) {
    PF_ParamDef def;

    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX("Amount", 0, 100, 0, 100, 100, PF_Precision_TENTHS, PF_ValueDisplayFlag_PERCENT, 0, DISK_AMOUNT);

    // The LUT itself; set by the panel, no UI.
    AEFX_CLR_STRUCT(def);
    PF_ADD_ARBITRARY2("LUT", 1, 1, PF_ParamFlag_CANNOT_TIME_VARY, PF_PUI_NO_ECW_UI, NewEmptyArb(in_data), DISK_LUT,
                      &kArbRefcon);

    // The button shows the LUT's file name (ShowLutName) and picks another.
    // "LUT " with a space: apart from "LUT" (the data), which host.jsx finds by name.
    PF_ADD_BUTTON("LUT ", "Change LUT", 0, PF_ParamFlag_SUPERVISE | PF_ParamFlag_CANNOT_TIME_VARY, DISK_PICK);
    PF_ADD_BUTTON("Match", "Edit LUT", 0, PF_ParamFlag_SUPERVISE | PF_ParamFlag_CANNOT_TIME_VARY, DISK_EDIT);

    out_data->num_params = PM_NUM_PARAMS;
    return PF_Err_NONE;
}

// ------------------------------------------------------ the LUT button

// The effect's LUT (cached by content), or nullptr.
static std::shared_ptr<const pm::Lut3D> CurrentLut(PF_InData* in_data, PF_ParamDef* params[]) {
    PF_Handle arb = params[PM_LUT]->u.arb_d.value;
    if (!arb) return nullptr;
    const size_t len = size_t(PF_GET_HANDLE_SIZE(arb));
    const void* p = PF_LOCK_HANDLE(arb);
    std::shared_ptr<const pm::Lut3D> lut = pm::embeddedLut(p, len);
    PF_UNLOCK_HANDLE(arb);
    return lut;
}

// The button's text: the LUT's file name, whole (a button's text isn't held
// to a parameter name's 31 characters).
static std::string LutLabel(PF_InData* in_data, PF_ParamDef* params[]) {
    std::shared_ptr<const pm::Lut3D> lut = CurrentLut(in_data, params);
    if (!lut) return "Choose a LUT";
    if (lut->probe) return "Calibrating";
    if (lut->name.empty()) return "From ProMatch (Apply again to name it)";
    return lut->name + ".cube";
}

// Show the LUT's file name on the button. The SDK documents renaming a
// parameter from USER_CHANGED_PARAM and UPDATE_PARAMS_UI, not changing a
// button's text; build 8 suggested Premiere redraws the text too, and build
// 11 relies on it (spike P11). The text must outlive the call: kept for good.
static void ShowLutName(PF_InData* in_data, PF_ParamDef* params[], const char* why) {
    static std::mutex textMu;
    static std::set<std::string> texts;
    const char* text;
    const std::string label = LutLabel(in_data, params);
    {
        std::lock_guard<std::mutex> lock(textMu);
        text = texts.insert(label).first->c_str();
    }
    const void* suite = nullptr;
    if (!in_data->pica_basicP ||
        in_data->pica_basicP->AcquireSuite(kPFParamUtilsSuite, kPFParamUtilsSuiteVersion3, &suite) != kSPNoError || !suite) {
        pm::logLine("LUT button: no param utils suite (%s)", why);
        return;
    }
    PF_ParamDef def = *params[PM_PICK];
    std::snprintf(def.PF_DEF_NAME, sizeof(def.PF_DEF_NAME), "%s", "LUT ");  // the space: see ParamsSetup
    def.u.button_d.u.namesptr = text;
    const PF_Err err = ((PF_ParamUtilsSuite3*)suite)->PF_UpdateParamUI(in_data->effect_ref, PM_PICK, &def);
    in_data->pica_basicP->ReleaseSuite(kPFParamUtilsSuite, kPFParamUtilsSuiteVersion3);
    static std::mutex mu;
    static std::string last;
    std::lock_guard<std::mutex> lock(mu);
    const std::string key = std::string(why) + "|" + label + "|" + std::to_string(err);
    if (key != last) {
        last = key;
        pm::logLine("LUT button: label \"%s\" (%s) -> err %d", label.c_str(), why, (int)err);
    }
}

#ifdef _WIN32
static std::string Utf8(const std::wstring& w) {
    if (w.empty()) return std::string();
    const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), int(w.size()), nullptr, 0, nullptr, nullptr);
    std::string s(size_t(n), ' ');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), int(w.size()), &s[0], n, nullptr, nullptr);
    return s;
}

// Ask for a .cube in the project's ProMatch LUTs folder. Empty if cancelled.
static std::wstring PickCube(PF_InData* in_data) {
    HWND owner = nullptr;
    if (in_data->utils && in_data->utils->get_platform_data && PF_GET_PLATFORM_DATA(PF_PlatData_MAIN_WND, &owner) != PF_Err_NONE)
        owner = nullptr;
    if (!owner) owner = GetForegroundWindow();
    const std::wstring folder = pm::lutFolder();
    wchar_t file[MAX_PATH * 4] = {};
    OPENFILENAMEW ofn = {};
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = owner;
    ofn.lpstrFilter = L"Cube LUTs (*.cube)\0*.cube\0All files\0*.*\0";
    ofn.lpstrFile = file;
    ofn.nMaxFile = sizeof(file) / sizeof(file[0]);
    ofn.lpstrInitialDir = folder.empty() ? nullptr : folder.c_str();
    ofn.lpstrTitle = L"ProMatch: choose a LUT";
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    pm::logLine("LUT button: dialog in \"%s\" (owner %p)", Utf8(folder).c_str(), (void*)owner);
    if (!GetOpenFileNameW(&ofn)) return std::wstring();
    return file;
}
#endif

#ifdef _WIN32
// Edit LUT: ask the panel to reopen the match that made this LUT. The panel
// (or, when it is closed, its helper, which opens it) watches this file.
static void RequestEdit(PF_InData* in_data, PF_ParamDef* params[]) {
    std::shared_ptr<const pm::Lut3D> lut = CurrentLut(in_data, params);
    if (!lut || lut->id <= 0) {
        pm::logLine("Edit LUT: no match ID");
        MessageBoxW(GetForegroundWindow(),
                    L"This LUT wasn't made in the ProMatch panel (or was made before ProMatch kept its matches), so there "
                    L"is no match to open. Make one in the panel and press Apply.",
                    L"ProMatch", MB_ICONINFORMATION);
        return;
    }
    std::string name;
    for (char c : lut->name) {
        if (c == '"' || c == '\\') name.push_back('\\');
        name.push_back(c);
    }
    char json[600];
    std::snprintf(json, sizeof(json), "{\"id\":%ld,\"name\":\"%s\",\"at\":%lld}\n", lut->id, name.c_str(),
                  (long long)GetTickCount64());
    FILE* f = _wfopen(pm::dataPath(L"edit-request.json").c_str(), L"wb");
    if (f) {
        std::fputs(json, f);
        std::fclose(f);
    }
    pm::logLine("Edit LUT: requested match %ld (%s)", lut->id, lut->name.c_str());
}
#endif

// Change LUT: load the chosen .cube into the LUT parameter. Edit LUT: ask the
// panel for the match.
static PF_Err UserChangedParam(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[],
                               const PF_UserChangedParamExtra* extra) {
    pm::logLine("USER_CHANGED_PARAM index %d", extra ? (int)extra->param_index : -1);
#ifdef _WIN32
    if (extra && extra->param_index == PM_EDIT) {
        RequestEdit(in_data, params);
        return PF_Err_NONE;
    }
#endif
    if (!extra || extra->param_index != PM_PICK) return PF_Err_NONE;
#ifdef _WIN32
    const std::wstring path = PickCube(in_data);
    if (path.empty()) {
        pm::logLine("LUT button: cancelled");
        return PF_Err_NONE;
    }
    std::string text, error;
    {
        FILE* f = _wfopen(path.c_str(), L"rb");
        if (f) {
            char buf[1 << 16];
            size_t n;
            while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) text.append(buf, n);
            std::fclose(f);
        }
    }
    pm::Lut3D cube;
    if (text.empty() || !pm::parseCube(text, cube, &error)) {
        pm::logLine("LUT button: could not read %s: %s", Utf8(path).c_str(), error.c_str());
        MessageBoxW(GetForegroundWindow(), (L"ProMatch could not read this LUT:\n" + path).c_str(), L"ProMatch", MB_ICONWARNING);
        return PF_Err_NONE;
    }
    for (int c = 0; c < 3; c++) {
        if (cube.domainMin[c] != 0.f || cube.domainMax[c] != 1.f) {
            pm::logLine("LUT button: %s has a domain other than 0..1", Utf8(path).c_str());
            MessageBoxW(GetForegroundWindow(), L"ProMatch only takes LUTs with a 0..1 domain.", L"ProMatch", MB_ICONWARNING);
            return PF_Err_NONE;
        }
    }
    std::wstring stem = path.substr(path.find_last_of(L"\\/") + 1);
    const size_t dot = stem.find_last_of(L'.');
    if (dot != std::wstring::npos) stem.resize(dot);
    // A .cube the panel saved names its match ("# ProMatch match <id>"), so
    // Edit LUT still finds it; any other LUT is on its own (ID 0).
    long id = 0;
    const size_t tag = text.find("# ProMatch match ");
    if (tag != std::string::npos) id = std::atol(text.c_str() + tag + 17);
    const std::vector<uint8_t> bytes = pm::toUtf16(pm::toEmbeddedText(cube, id, Utf8(stem)));

    // Write the new text into the parameter's handle and say it changed.
    PF_Handle h = params[PM_LUT]->u.arb_d.value;
    if (h) {
        if (PF_RESIZE_HANDLE(A_u_long(bytes.size()), &h) != PF_Err_NONE) return PF_Err_OUT_OF_MEMORY;
    } else {
        h = PF_NEW_HANDLE(bytes.size());
        if (!h) return PF_Err_OUT_OF_MEMORY;
    }
    void* p = PF_LOCK_HANDLE(h);
    if (p) std::memcpy(p, bytes.data(), bytes.size());
    PF_UNLOCK_HANDLE(h);
    params[PM_LUT]->u.arb_d.value = h;
    params[PM_LUT]->uu.change_flags = PF_ChangeFlag_CHANGED_VALUE;
    out_data->out_flags |= PF_OutFlag_FORCE_RERENDER | PF_OutFlag_REFRESH_UI;
    pm::logLine("LUT button: loaded %s (%d^3, %zu bytes)", Utf8(path).c_str(), cube.size, bytes.size());
    ShowLutName(in_data, params, "picked");
#endif
    return PF_Err_NONE;
}

// ------------------------------------------------------------- render

static void CopyRows(const PF_EffectWorld* src, PF_EffectWorld* dst, int bytesPerPixel) {
    const int w = dst->width < src->width ? dst->width : src->width;
    const int h = dst->height < src->height ? dst->height : src->height;
    for (int y = 0; y < h; y++) {
        std::memcpy((char*)dst->data + (long)y * dst->rowbytes, (const char*)src->data + (long)y * src->rowbytes,
                    (size_t)w * bytesPerPixel);
    }
}

static PF_Err Render(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[], PF_LayerDef* output) {
    PF_EffectWorld* input = &params[PM_INPUT]->u.ld;
    const float amount = float(params[PM_AMOUNT]->u.fs_d.value / 100.0);

    // Pixel layout of this render.
    bool isFloat = false;
    pm::Layout layout = pm::Layout::ARGB;
    if (in_data->appl_id == kPremiere) {
        PrPixelFormat fmt = PrPixelFormat_BGRA_4444_8u;
        if (PF_PixelFormatSuite1* pfs = AcquirePixelFormatSuite(in_data)) {
            pfs->GetPixelFormat(output, &fmt);
            ReleasePixelFormatSuite(in_data);
        }
        if (fmt == PrPixelFormat_BGRA_4444_32f) {
            isFloat = true;
            layout = pm::Layout::BGRA;
        } else if (fmt == PrPixelFormat_BGRA_4444_8u) {
            layout = pm::Layout::BGRA;
        } else {
            return PF_Err_UNRECOGNIZED_PARAM_TYPE;  // not a format we asked for
        }
    }

    // The embedded LUT (or the calibration pattern, whatever Amount says).
    std::shared_ptr<const pm::Lut3D> lut;
    PF_Handle arb = params[PM_LUT]->u.arb_d.value;
    if (arb) {
        const size_t len = size_t(PF_GET_HANDLE_SIZE(arb));
        const void* p = PF_LOCK_HANDLE(arb);
        std::string err;
        lut = pm::embeddedLut(p, len, &err);
        if (!lut && !err.empty()) pm::logLine("Embedded LUT: %s", err.c_str());
        PF_UNLOCK_HANDLE(arb);
    }
    const long id = lut ? lut->id : 0;
    const char* source = !lut ? "none" : (lut->probe ? "pattern" : "embedded");

    // Log each new render setup once, not every frame.
    {
        static std::mutex mu;
        static std::string last;
        char key[200];
        std::snprintf(key, sizeof(key), "Render fmt=%s %dx%d rowbytes=%ld id=%ld amount=%.3f lut=%s %d",
                      isFloat ? "BGRA32f" : (layout == pm::Layout::BGRA ? "BGRA8u" : "ARGB8"), (int)output->width,
                      (int)output->height, (long)output->rowbytes, id, amount, source,
                      lut ? (lut->probe ? lut->probe : lut->size) : 0);
        std::lock_guard<std::mutex> lock(mu);
        if (last != key) {
            last = key;
            pm::logLine("%s", key);
        }
    }

    if (lut && lut->probe) {
        if (isFloat)
            pm::fillProbeF(lut->probe, pm::ImageF{(float*)output->data, output->width, output->height, (long)output->rowbytes, layout});
        else
            pm::fillProbe8(lut->probe, pm::Image8{(uint8_t*)output->data, output->width, output->height, (long)output->rowbytes, layout});
        return PF_Err_NONE;
    }
    if (!lut || amount <= 0.f) {
        CopyRows(input, output, isFloat ? 16 : 4);
        return PF_Err_NONE;
    }
    if (isFloat) {
        pm::ImageF src{(float*)input->data, input->width, input->height, (long)input->rowbytes, layout};
        pm::ImageF dst{(float*)output->data, output->width, output->height, (long)output->rowbytes, layout};
        pm::applyF(*lut, src, dst, amount);
    } else {
        pm::Image8 src{(uint8_t*)input->data, input->width, input->height, (long)input->rowbytes, layout};
        pm::Image8 dst{(uint8_t*)output->data, output->width, output->height, (long)output->rowbytes, layout};
        pm::apply8(*lut, src, dst, amount);
    }
    return PF_Err_NONE;
}

extern "C" DllExport PF_Err PluginDataEntryFunction2(PF_PluginDataPtr inPtr, PF_PluginDataCB2 inPluginDataCallBackPtr,
                                                     SPBasicSuite* inSPBasicSuitePtr, const char* inHostName,
                                                     const char* inHostVersion) {
    PF_Err result = PF_Err_INVALID_CALLBACK;
    PF_REGISTER_EFFECT_EXT2(inPtr, inPluginDataCallBackPtr, PM_NAME, PM_MATCH_NAME, PM_CATEGORY,
                            AE_RESERVED_INFO, "EffectMain", "https://github.com/");
    return result;
}

extern "C" DllExport PF_Err EffectMain(PF_Cmd cmd, PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* params[],
                                       PF_LayerDef* output, void* extra) {
    try {
        switch (cmd) {
            case PF_Cmd_ABOUT:              return About(in_data, out_data);
            case PF_Cmd_GLOBAL_SETUP:       return GlobalSetup(in_data, out_data);
            case PF_Cmd_PARAMS_SETUP:       return ParamsSetup(in_data, out_data);
            case PF_Cmd_RENDER:             return Render(in_data, out_data, params, output);
            case PF_Cmd_ARBITRARY_CALLBACK: return Arbitrary(in_data, reinterpret_cast<PF_ArbParamsExtra*>(extra));
            case PF_Cmd_USER_CHANGED_PARAM:
                return UserChangedParam(in_data, out_data, params, reinterpret_cast<const PF_UserChangedParamExtra*>(extra));
            case PF_Cmd_UPDATE_PARAMS_UI:
                ShowLutName(in_data, params, "update");
                return PF_Err_NONE;
            default:                        return PF_Err_NONE;
        }
    } catch (...) {
        return PF_Err_INTERNAL_STRUCT_DAMAGED;
    }
}
