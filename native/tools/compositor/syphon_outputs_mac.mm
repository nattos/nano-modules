// syphon_outputs_mac.mm — see syphon_outputs.h. Compiled under ARC.

#include "compositor/syphon_outputs.h"

#import <Foundation/Foundation.h>

#include <map>

#import "SyphonServerBase.h"
#import "SyphonSubclassing.h"

namespace compositor {

struct SyphonOutputs::Impl {
  std::map<std::string, SyphonServerBase*> servers;
  bool privateServers = false;
};

SyphonOutputs::SyphonOutputs(bool privateServers) : impl_(std::make_unique<Impl>()) {
  impl_->privateServers = privateServers;
}

SyphonOutputs::~SyphonOutputs() {
  for (auto& [key, server] : impl_->servers) [server stop];
}

IOSurfaceRef SyphonOutputs::ensure(const std::string& key, const std::string& name, int width,
                                   int height) {
  if (width <= 0 || height <= 0) return nullptr;
  @autoreleasepool {
    NSString* nm = [NSString stringWithUTF8String:name.c_str()];
    SyphonServerBase* server = nil;
    if (auto it = impl_->servers.find(key); it != impl_->servers.end()) {
      server = it->second;
      if (![server.name isEqualToString:nm]) server.name = nm;
    } else {
      NSDictionary* opts = impl_->privateServers ? @{SyphonServerOptionIsPrivate: @YES} : nil;
      server = [[SyphonServerBase alloc] initWithName:nm options:opts];
      if (!server) return nullptr;
      impl_->servers[key] = server;
    }
    return [server newSurfaceForWidth:(size_t)width height:(size_t)height options:nil];
  }
}

void SyphonOutputs::publish(const std::string& key) {
  if (auto it = impl_->servers.find(key); it != impl_->servers.end()) [it->second publish];
}

void SyphonOutputs::close(const std::string& key) {
  auto it = impl_->servers.find(key);
  if (it == impl_->servers.end()) return;
  [it->second stop];
  impl_->servers.erase(it);
}

bool SyphonOutputs::has(const std::string& key) const {
  return impl_->servers.count(key) > 0;
}

void* SyphonOutputs::description(const std::string& key) const {
  auto it = impl_->servers.find(key);
  return it == impl_->servers.end() ? nullptr : (__bridge void*)it->second.serverDescription;
}

}  // namespace compositor
