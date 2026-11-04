// The effect's two dialogs on macOS (AppKit, mac_ui.mm), behind a plain C++
// interface so ProMatch.cpp stays C++. Strings are UTF-8.
#pragma once

#include <string>

namespace pm_mac {

// Ask for a .cube, starting in `folder` (may be empty). Empty if cancelled.
std::string PickCube(const std::string& folder);

// A modal message box over Premiere.
void Alert(const std::string& message, bool warning);

}  // namespace pm_mac
