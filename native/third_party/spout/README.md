# Spout core (vendored subset)

The sender-side protocol core of [Spout2](https://github.com/leadedge/Spout2) (BSD-2, see
`License.txt`), at upstream commit `c2bcc12147711d12ace7d5f08e869d774d840f8a` (2026-07-19).
**Unmodified** — copied file for file from `SPOUTSDK/SpoutGL/`.

Only what a sender that shares its own D3D11 texture needs: the sender-name registry
(`SpoutSenderNames` over `SpoutSharedMemory`), the frame counter and access mutex
(`SpoutFrameCount`), and the logging/registry helpers they use (`SpoutUtils`, `SpoutCommon.h`).
None of SpoutDX / SpoutDirectX / SpoutGL: the compositor makes the shared texture itself (a
BGRA8 `MISC_SHARED` texture and its legacy handle, as SpoutDX does) and scales each frame
into it with its own backend (`tools/compositor/spout_outputs_win.cpp`).

Built as the static library `spout_core` (Windows only). Linked only into the
`nano_compositor` process and its tests — never into `libbridge_server`, which runs inside
hosts that carry their own Spout.

Frame counting is Spout's opt-in (SpoutSettings writes `Framecount` to the registry); without
it `SetNewFrame` is a no-op and receivers poll the texture, as they do for any sender.

To update: copy the same files from a newer upstream checkout and bump the commit above.
