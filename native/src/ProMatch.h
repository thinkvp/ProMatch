// ProMatch effect: shared between ProMatch.cpp and the PiPL (ProMatchPiPL.r),
// so keep it preprocessor-only.
#pragma once

#define PM_NAME        "ProMatch"
#define PM_MATCH_NAME  "PRMT ProMatch"
#define PM_CATEGORY    "Color Correction"

#define PM_MAJOR 1
#define PM_MINOR 0
#define PM_BUG   0
#define PM_BUILD 11
// PF_VERSION(1, 0, 0, PF_Stage_DEVELOP, PM_BUILD); must equal AE_Effect_Version in the PiPL.
#define PM_VERSION_PACKED 524299

// Parameter indices (0 is the input layer). The GPU filter reads them too.
// Build 7 dropped the visible Match ID (index 1 before): the ID now travels
// in the LUT text, so Effect Controls shows Amount only.
#define PM_PARAM_AMOUNT   1
#define PM_PARAM_LUT      2
// Build 10+: two rows after those (so build-7 instances keep their indices):
// "LUT" with a button showing the LUT's file name (click to change it), and
// Edit LUT. Builds 8 and 9 were test builds (a lone button; a group).
#define PM_PARAM_PICK      3
#define PM_PARAM_EDIT      4

// Global out flags. PiPL and GlobalSetup must agree, or After Effects
// refuses the plug-in.
//   PF_OutFlag_PIX_INDEPENDENT (1 << 10)
//   PF_OutFlag_SEND_UPDATE_PARAMS_UI (1 << 26): to label the button with the LUT's name
#define PM_OUTFLAGS  0x04000400
//   PF_OutFlag2_SUPPORTS_THREADED_RENDERING (1 << 27)
#define PM_OUTFLAGS2 0x08000000
