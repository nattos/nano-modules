// display_windows_none.cpp — no display windows on this platform yet
// (display_windows.h). The compositor runs headless: display devices report
// no screens, and nothing opens.

#include "compositor/display_windows.h"

namespace compositor {

std::unique_ptr<DisplayWindows> DisplayWindows::create(double) { return nullptr; }

}  // namespace compositor
