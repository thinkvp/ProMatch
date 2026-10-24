// ProMatch effect (AE effect API, hosted by Premiere Pro).
//
// Applies the colour match made in the ProMatch panel, blended by Amount.
// The LUT lives in the effect itself, in the hidden "LUT" arbitrary-data
// parameter, so it is saved with the project. The panel sets it as text
// (PMLUT text, see lut_engine.h); any change re-renders. Without an
// embedded LUT it falls back to %APPDATA%\ProMatch\luts\<Match ID>.cube.
//
// In Premiere it asks for BGRA 8u and BGRA 32f frames (the pixel format
// suite); elsewhere (After Effects) it takes the standard 8-bit ARGB world.

#include "AEConfig.h"
#include "entry.h"
#include "SPBasic.h"
#include "AE_Effect.h"
#include "AE_EffectCB.h"
#include "AE_Macros.h"
#include "Param_Utils.h"
#include "PrSDKAESupport.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>

#include "ProMatch.h"
#include "lut_engine.h"

enum {
    PM_INPUT = 0,
    PM_MATCH_ID = PM_PARAM_MATCH_ID,
    PM_AMOUNT = PM_PARAM_AMOUNT,
    PM_LUT = PM_PARAM_LUT,
    PM_NUM_PARAMS
};

// Disk IDs: stable across versions so saved projects keep their values.
// 3 was the Revision slider of build 1; not reused.
enum {
    DISK_MATCH_ID = 1,
    DISK_AMOUNT = 2,
    DISK_LUT = 4,
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
    PF_ADD_FLOAT_SLIDERX("Match ID", 0, 9999999, 0, 9999999, 0, PF_Precision_INTEGER, 0, 0, DISK_MATCH_ID);

    AEFX_CLR_STRUCT(def);
    PF_ADD_FLOAT_SLIDERX("Amount", 0, 100, 0, 100, 100, PF_Precision_TENTHS, PF_ValueDisplayFlag_PERCENT, 0, DISK_AMOUNT);

    // The LUT itself; set by the panel, no UI.
    AEFX_CLR_STRUCT(def);
    PF_ADD_ARBITRARY2("LUT", 1, 1, PF_ParamFlag_CANNOT_TIME_VARY, PF_PUI_NO_ECW_UI, NewEmptyArb(in_data), DISK_LUT,
                      &kArbRefcon);

    out_data->num_params = PM_NUM_PARAMS;
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
    const long id = std::lround(params[PM_MATCH_ID]->u.fs_d.value);
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

    // The embedded LUT, else the file for Match ID.
    std::shared_ptr<const pm::Lut3D> lut;
    const char* source = "none";
    if (amount > 0.f) {
        PF_Handle arb = params[PM_LUT]->u.arb_d.value;
        if (arb) {
            const size_t len = size_t(PF_GET_HANDLE_SIZE(arb));
            const void* p = PF_LOCK_HANDLE(arb);
            std::string err;
            lut = pm::embeddedLut(p, len, &err);
            if (!lut && !err.empty()) pm::logLine("Embedded LUT: %s", err.c_str());
            PF_UNLOCK_HANDLE(arb);
            if (lut) source = "embedded";
        }
        if (!lut && id > 0) {
            std::string lutError;
            lut = pm::cachedLut(id, 0, &lutError);
            source = lut ? "file" : "missing";
        }
    }

    // Log each new render setup once, not every frame.
    {
        static std::mutex mu;
        static std::string last;
        char key[200];
        std::snprintf(key, sizeof(key), "Render fmt=%s %dx%d rowbytes=%ld id=%ld amount=%.3f lut=%s %d",
                      isFloat ? "BGRA32f" : (layout == pm::Layout::BGRA ? "BGRA8u" : "ARGB8"), (int)output->width,
                      (int)output->height, (long)output->rowbytes, id, amount, source, lut ? lut->size : 0);
        std::lock_guard<std::mutex> lock(mu);
        if (last != key) {
            last = key;
            pm::logLine("%s", key);
        }
    }

    if (!lut) {
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
            default:                        return PF_Err_NONE;
        }
    } catch (...) {
        return PF_Err_INTERNAL_STRUCT_DAMAGED;
    }
}
