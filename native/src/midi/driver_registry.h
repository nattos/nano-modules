// driver_registry.h — the template id → native driver factory.
//
// Every device model the barrel can read HEADLESSLY must be listed here. A
// template with no entry is silently skipped by MidiHost::refreshMatching
// (`if (!driver) continue;`), so the barrel never connects to that port: its
// controls still work in the editor (which has its own TS driver) while
// feeding the sketch nothing in live mode. Keep this in step with the
// templates the web self-registers in web/src/midi/device-registry.ts.

#pragma once

#include <memory>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "midi/midi_driver.h"
#include "midi/mft_driver.h"
#include "midi/nanokontrol2_driver.h"

namespace nano_midi {

inline std::unique_ptr<DeviceDriver> createDriverForTemplate(
    const std::string& templateId, nlohmann::json config) {
  if (templateId == kMftTemplateId) {
    return std::make_unique<MftDriver>(std::move(config));
  }
  if (templateId == kNk2TemplateId) {
    return std::make_unique<Nk2Driver>(std::move(config));
  }
  return nullptr;
}

}  // namespace nano_midi
