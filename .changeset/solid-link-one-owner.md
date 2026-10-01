---
'@tanstack/solid-router': patch
---

perf(solid-router): a `Link` creates one owner (a memo on the client, a bare owner in the same position on the server) where it created about fifteen, and a server `Link` defines no per-prop getters
