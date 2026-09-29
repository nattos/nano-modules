# Syphon core (vendored subset)

The protocol core of the [Syphon framework](https://github.com/Syphon/Syphon-Framework)
(BSD-2, see `License.txt`), at upstream commit `f4761677a45b8034a3c2069ec0f3d2553da81fba`
(2026-09-21). **Unmodified** — copied file for file. `include/Syphon/` is ours: two
forwarding headers for the sources' framework-style `<Syphon/…>` imports.

Only what a server that publishes IOSurfaces needs, plus the client base for tests:
`SyphonServerBase` (+ connection manager, messaging, dispatch, private keys) and
`SyphonClientBase` / `SyphonServerDirectory`. None of the OpenGL / Metal renderers:
the compositor scales each frame into the server's IOSurface with its own backend
(`tools/compositor/syphon_outputs_mac.mm`).

Built as the static library `syphon_core` (ARC, with `Syphon_Prefix.pch` as a prefix
header). Linked only into the `nano_compositor` process and its tests — never into
`libbridge_server`, which Resolume loads next to its own Syphon.framework.

To update: copy the same files from a newer upstream checkout and bump the commit above.
