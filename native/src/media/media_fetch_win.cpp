// media_fetch_win.cpp — localMediaPath (media_fetch.h) on Windows, over WinHTTP.
//
// The twin of media_fetch.mm: an existing path or file:// url as is; http(s),
// or a url relative to the page's `base`, downloaded once per process into a
// temporary cache that goes away at exit.

#include "media_fetch.h"

#include <windows.h>
#include <winhttp.h>

#include <cctype>
#include <cstdlib>
#include <map>
#include <mutex>
#include <vector>

#include "platform/paths.h"

namespace nano_media {
namespace {

std::mutex gMutex;
std::map<std::string, std::string> gFetched;  // absolute url → cached file
std::string gDir;

std::string narrow(const std::wstring& w) {
  if (w.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s((size_t)n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}

/// This process's cache directory, removed at exit — a url's bytes can change
/// between runs (a rebuilt fixture), so nothing is reused across processes.
const std::string& cacheDir() {
  if (gDir.empty()) {
    wchar_t tmp[MAX_PATH + 1];
    const DWORD n = GetTempPathW(MAX_PATH + 1, tmp);
    if (n == 0 || n > MAX_PATH) return gDir;
    const std::string dir = narrow(tmp) + "nano-media-" + std::to_string(GetCurrentProcessId()) + "-" +
                            std::to_string(GetTickCount64());
    if (!CreateDirectoryW(nano_paths::widen(dir).c_str(), nullptr)) return gDir;
    gDir = dir;
    std::atexit([] {
      for (const auto& kv : gFetched) DeleteFileW(nano_paths::widen(kv.second).c_str());
      RemoveDirectoryW(nano_paths::widen(gDir).c_str());
    });
  }
  return gDir;
}

/// "http", "file", ... — or "" for a relative url. One letter before the colon
/// is a drive ("C:\clips"), not a scheme.
std::string schemeOf(const std::string& u) {
  size_t i = 0;
  while (i < u.size() && (std::isalnum((unsigned char)u[i]) || u[i] == '+' || u[i] == '-' || u[i] == '.')) i++;
  if (i < 2 || i >= u.size() || u[i] != ':' || !std::isalpha((unsigned char)u[0])) return "";
  std::string s = u.substr(0, i);
  for (char& c : s) c = (char)std::tolower((unsigned char)c);
  return s;
}

std::string stripQuery(const std::string& u) {
  return u.substr(0, u.find_first_of("?#"));
}

/// `url` resolved against `base` (RFC 3986's common cases: scheme-relative,
/// origin-relative, directory-relative). "" when there's nothing to resolve by.
std::string resolve(const std::string& url, const std::string& base) {
  if (!schemeOf(url).empty()) return url;
  if (base.empty() || schemeOf(base).empty()) return "";
  const std::string b = stripQuery(base);
  const size_t auth = b.find("//");
  if (url.rfind("//", 0) == 0) return b.substr(0, b.find(':') + 1) + url;
  const size_t pathStart = auth == std::string::npos ? b.find(':') + 1 : b.find('/', auth + 2);
  const std::string origin = pathStart == std::string::npos ? b : b.substr(0, pathStart);
  if (!url.empty() && url[0] == '/') return origin + url;
  const size_t slash = b.rfind('/');
  const std::string dir = slash == std::string::npos || slash < pathStart ? origin + "/" : b.substr(0, slash + 1);
  return dir + url;
}

std::string percentDecode(const std::string& s) {
  std::string out;
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == '%' && i + 2 < s.size() && std::isxdigit((unsigned char)s[i + 1]) &&
        std::isxdigit((unsigned char)s[i + 2])) {
      out += (char)std::strtol(s.substr(i + 1, 2).c_str(), nullptr, 16);
      i += 2;
    } else {
      out += s[i];
    }
  }
  return out;
}

/// file:///C:/clips/a%20b.mov → C:\clips\a b.mov (and file://server/share/…
/// → \\server\share\…).
std::string filePathOf(const std::string& url) {
  std::string rest = percentDecode(stripQuery(url.substr(url.find(':') + 1)));
  if (rest.rfind("//", 0) == 0) {
    rest = rest.substr(2);
    const size_t slash = rest.find('/');
    const std::string host = slash == std::string::npos ? rest : rest.substr(0, slash);
    rest = slash == std::string::npos ? "" : rest.substr(slash);
    if (!host.empty() && host != "localhost") rest = "//" + host + rest;
  }
  if (rest.size() >= 3 && rest[0] == '/' && std::isalpha((unsigned char)rest[1]) && rest[2] == ':') {
    rest = rest.substr(1);
  }
  for (char& c : rest) if (c == '/') c = '\\';
  return rest;
}

struct Handle {
  HINTERNET h = nullptr;
  ~Handle() { if (h) WinHttpCloseHandle(h); }
};

/// GET `abs` into `out`. "" on success, else why.
std::string httpGet(const std::string& abs, std::vector<char>& out) {
  const std::wstring wurl = nano_paths::widen(abs);
  URL_COMPONENTS c{};
  c.dwStructSize = sizeof c;
  c.dwHostNameLength = c.dwUrlPathLength = c.dwExtraInfoLength = (DWORD)-1;
  if (!WinHttpCrackUrl(wurl.c_str(), 0, 0, &c)) return "not a url";
  const std::wstring host(c.lpszHostName, c.dwHostNameLength);
  const std::wstring path = std::wstring(c.lpszUrlPath, c.dwUrlPathLength) +
                            std::wstring(c.lpszExtraInfo, c.dwExtraInfoLength);

  Handle session{WinHttpOpen(L"NanoCompositor/1", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                             WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0)};
  if (!session.h) return "WinHttpOpen failed";
  WinHttpSetTimeouts(session.h, 10000, 10000, 60000, 60000);
  Handle conn{WinHttpConnect(session.h, host.c_str(), c.nPort, 0)};
  if (!conn.h) return "can't reach " + narrow(host);
  Handle req{WinHttpOpenRequest(conn.h, L"GET", path.c_str(), nullptr, WINHTTP_NO_REFERER,
                                WINHTTP_DEFAULT_ACCEPT_TYPES,
                                c.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0)};
  if (!req.h) return "WinHttpOpenRequest failed";
  if (!WinHttpSendRequest(req.h, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
      !WinHttpReceiveResponse(req.h, nullptr)) {
    return "request failed (error " + std::to_string(GetLastError()) + ")";
  }
  DWORD status = 0, sz = sizeof status;
  WinHttpQueryHeaders(req.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                      WINHTTP_HEADER_NAME_BY_INDEX, &status, &sz, WINHTTP_NO_HEADER_INDEX);
  if (status != 200) return "HTTP " + std::to_string(status);
  wchar_t type[256] = {0};
  sz = sizeof type;
  if (WinHttpQueryHeaders(req.h, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_HEADER_NAME_BY_INDEX, type, &sz,
                          WINHTTP_NO_HEADER_INDEX) &&
      narrow(type).rfind("text/html", 0) == 0) {
    // A dev server answers an unknown path with its index page.
    return "served an HTML page, not media";
  }
  // The body's promised length, when the server says: a connection that drops
  // early otherwise reads as a complete (truncated) file.
  wchar_t lenBuf[32] = {0};
  DWORD lenSz = sizeof lenBuf;
  long long expected = -1;
  if (WinHttpQueryHeaders(req.h, WINHTTP_QUERY_CONTENT_LENGTH, WINHTTP_HEADER_NAME_BY_INDEX, lenBuf,
                          &lenSz, WINHTTP_NO_HEADER_INDEX)) {
    expected = _wtoi64(lenBuf);
  }
  out.clear();
  for (;;) {
    DWORD avail = 0;
    if (!WinHttpQueryDataAvailable(req.h, &avail)) return "read failed";
    if (avail == 0) break;
    const size_t at = out.size();
    out.resize(at + avail);
    DWORD got = 0;
    if (!WinHttpReadData(req.h, out.data() + at, avail, &got)) return "read failed";
    out.resize(at + got);
  }
  if (expected >= 0 && (long long)out.size() != expected) {
    return "truncated: got " + std::to_string(out.size()) + " of " + std::to_string(expected) + " bytes";
  }
  return "";
}

}  // namespace

std::string localMediaPath(const std::string& url, const std::string& base, std::string* error) {
  if (url.empty()) { if (error) *error = "empty url"; return ""; }
  if (nano_paths::fileExists(url)) return url;
  const std::string abs = resolve(url, base);
  if (abs.empty()) {
    if (error) *error = "not a file, and no media base to resolve it against";
    return "";
  }
  const std::string scheme = schemeOf(abs);
  if (scheme == "file") {
    const std::string p = filePathOf(abs);
    if (nano_paths::fileExists(p)) return p;
    if (error) *error = "no such file " + p;
    return "";
  }
  if (scheme != "http" && scheme != "https") {
    if (error) *error = "can't fetch a " + scheme + ": url outside the page that made it";
    return "";
  }

  std::lock_guard<std::mutex> lock(gMutex);
  if (auto it = gFetched.find(abs); it != gFetched.end()) return it->second;
  if (cacheDir().empty()) { if (error) *error = "no cache directory"; return ""; }
  // A dropped connection (now detected: the body's Content-Length) is worth a
  // retry or two before the clip is named undecodable for the whole session.
  std::vector<char> data;
  std::string why;
  for (int attempt = 0; attempt < 3; attempt++) {
    why = httpGet(abs, data);
    if (why.empty() || why.rfind("HTTP ", 0) == 0 || why.rfind("served an HTML", 0) == 0) break;
  }
  if (!why.empty()) {
    if (error) *error = "fetch " + abs + ": " + why;
    return "";
  }
  // Keep the extension: WIC and Media Foundation both take it as a hint.
  const std::string urlPath = stripQuery(abs);
  const size_t slash = urlPath.rfind('/'), dot = urlPath.rfind('.');
  const std::string ext = dot != std::string::npos && (slash == std::string::npos || dot > slash)
                              ? urlPath.substr(dot) : "";
  const std::string path = cacheDir() + "\\" + std::to_string(gFetched.size()) + ext;
  if (!nano_paths::writeFileAtomic(path, std::string(data.begin(), data.end()))) {
    if (error) *error = "can't write " + path;
    return "";
  }
  gFetched[abs] = path;
  return path;
}

}  // namespace nano_media
