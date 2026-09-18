// socket_compat.h — the BSD-sockets spelling differences between POSIX and
// Winsock, and nothing else.
//
// artnet_host.cpp is otherwise portable C++: it co-binds Resolume's UDP port
// 6454 and waits in poll(). Only the handful of names below differ on Windows,
// so they live here rather than as #ifdefs sprinkled through the RX loop. This
// header does NOT make Art-Net work on Windows by itself — the host still needs
// WSAStartup at process init and SO_REUSEPORT has no Winsock equivalent (see
// the note on kHasReusePort) — but it keeps the divergence to one file.

#pragma once

#ifdef _WIN32

#include <winsock2.h>
#include <ws2tcpip.h>

namespace artnet {
namespace net {

using socket_t = SOCKET;
using pollfd_t = WSAPOLLFD;
using ssize_t_ = int;
inline constexpr socket_t kInvalidSocket = INVALID_SOCKET;

inline bool valid(socket_t s) { return s != INVALID_SOCKET; }
inline int closeSocket(socket_t s) { return ::closesocket(s); }
inline int poll(pollfd_t* fds, unsigned n, int timeout_ms) {
  return ::WSAPoll(fds, n, timeout_ms);
}
inline int setNonBlocking(socket_t s) {
  u_long on = 1;
  return ::ioctlsocket(s, FIONBIO, &on);
}

/// Winsock has no SO_REUSEPORT. SO_REUSEADDR alone already allows two sockets
/// to share a UDP port on Windows, which is the behaviour we actually want —
/// but it is NOT the same guarantee, so callers must not assume co-binding
/// with Resolume works until it has been tested on a real Windows host.
inline constexpr bool kHasReusePort = false;

}  // namespace net
}  // namespace artnet

#else

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

namespace artnet {
namespace net {

using socket_t = int;
using pollfd_t = struct pollfd;
using ssize_t_ = ssize_t;
inline constexpr socket_t kInvalidSocket = -1;

inline bool valid(socket_t s) { return s >= 0; }
inline int closeSocket(socket_t s) { return ::close(s); }
inline int poll(pollfd_t* fds, unsigned n, int timeout_ms) {
  return ::poll(fds, (nfds_t)n, timeout_ms);
}
inline int setNonBlocking(socket_t s) {
  return ::fcntl(s, F_SETFL, ::fcntl(s, F_GETFL, 0) | O_NONBLOCK);
}

inline constexpr bool kHasReusePort = true;

}  // namespace net
}  // namespace artnet

#endif
