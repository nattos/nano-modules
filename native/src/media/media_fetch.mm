#include "media_fetch.h"

#import <Foundation/Foundation.h>

#include <sys/stat.h>
#include <unistd.h>

#include <cstdlib>
#include <map>
#include <mutex>

namespace nano_media {
namespace {

bool isFile(const std::string& p) {
  struct stat st;
  return !p.empty() && ::stat(p.c_str(), &st) == 0 && S_ISREG(st.st_mode);
}

std::mutex gMutex;
std::map<std::string, std::string> gFetched;  // absolute url → cached file
std::string gDir;

/// This process's cache directory, removed at exit — a url's bytes can change
/// between runs (a rebuilt fixture), so nothing is reused across processes.
const std::string& cacheDir() {
  if (gDir.empty()) {
    NSString* tmpl = [NSTemporaryDirectory() stringByAppendingPathComponent:@"nano-media-XXXXXX"];
    std::string t = tmpl.UTF8String;
    if (::mkdtemp(t.data())) {
      gDir = t;
      std::atexit([] {
        [[NSFileManager defaultManager] removeItemAtPath:[NSString stringWithUTF8String:gDir.c_str()]
                                                   error:nil];
      });
    }
  }
  return gDir;
}

}  // namespace

std::string localMediaPath(const std::string& url, const std::string& base, std::string* error) {
  if (url.empty()) { if (error) *error = "empty url"; return ""; }
  if (isFile(url)) return url;
  @autoreleasepool {
    NSURL* baseUrl = base.empty() ? nil : [NSURL URLWithString:[NSString stringWithUTF8String:base.c_str()]];
    NSURL* u = [NSURL URLWithString:[NSString stringWithUTF8String:url.c_str()] relativeToURL:baseUrl];
    if (!u || !u.scheme) {
      if (error) *error = "not a file, and no media base to resolve it against";
      return "";
    }
    u = u.absoluteURL;
    if (u.isFileURL) {
      const std::string p = u.path.UTF8String;
      if (isFile(p)) return p;
      if (error) *error = "no such file " + p;
      return "";
    }
    const std::string scheme = u.scheme.lowercaseString.UTF8String;
    if (scheme != "http" && scheme != "https") {
      if (error) *error = "can't fetch a " + scheme + ": url outside the page that made it";
      return "";
    }

    const std::string abs = u.absoluteString.UTF8String;
    std::lock_guard<std::mutex> lock(gMutex);
    if (auto it = gFetched.find(abs); it != gFetched.end()) return it->second;
    if (cacheDir().empty()) { if (error) *error = "no cache directory"; return ""; }

    __block NSData* data = nil;
    __block NSString* failure = nil;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    NSURLSessionDataTask* task = [NSURLSession.sharedSession
        dataTaskWithURL:u
      completionHandler:^(NSData* d, NSURLResponse* resp, NSError* e) {
        NSHTTPURLResponse* http = (NSHTTPURLResponse*)resp;
        if (e) {
          failure = e.localizedDescription;
        } else if (http.statusCode != 200) {
          failure = [NSString stringWithFormat:@"HTTP %ld", (long)http.statusCode];
        } else if ([http.MIMEType isEqualToString:@"text/html"]) {
          // A dev server answers an unknown path with its index page.
          failure = @"served an HTML page, not media";
        } else {
          data = d;
        }
        dispatch_semaphore_signal(done);
      }];
    [task resume];
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC)) != 0) {
      [task cancel];
      failure = @"timed out";
    }
    if (!data) {
      if (error) *error = "fetch " + abs + ": " + (failure ? failure.UTF8String : "no data");
      return "";
    }
    // Keep the extension: ImageIO and AVFoundation both take it as a hint.
    NSString* ext = u.pathExtension.length ? [@"." stringByAppendingString:u.pathExtension] : @"";
    const std::string path = cacheDir() + "/" + std::to_string(gFetched.size()) + ext.UTF8String;
    if (![data writeToFile:[NSString stringWithUTF8String:path.c_str()] atomically:YES]) {
      if (error) *error = "can't write " + path;
      return "";
    }
    gFetched[abs] = path;
    return path;
  }
}

}  // namespace nano_media
