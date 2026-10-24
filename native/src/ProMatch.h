// ProMatch effect: shared between ProMatch.cpp and the PiPL (ProMatchPiPL.r),
// so keep it preprocessor-only.
#pragma once

#define PM_NAME        "ProMatch"
#define PM_MATCH_NAME  "PRMT ProMatch"
#define PM_CATEGORY    "Color Correction"

#define PM_MAJOR 1
#define PM_MINOR 0
#define PM_BUG   0
#define PM_BUILD 3
// PF_VERSION(1, 0, 0, PF_Stage_DEVELOP, PM_BUILD); must equal AE_Effect_Version in the PiPL.
#define PM_VERSION_PACKED 524291

// Global out flags. PiPL and GlobalSetup must agree, or After Effects
// refuses the plug-in.
//   PF_OutFlag_PIX_INDEPENDENT (1 << 10)
#define PM_OUTFLAGS  0x00000400
//   PF_OutFlag2_SUPPORTS_THREADED_RENDERING (1 << 27)
#define PM_OUTFLAGS2 0x08000000
