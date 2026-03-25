# clanker.show

## Deployment note

`apps/station` currently supports **single-instance deployments only**.

Running multiple station API/runtime instances at the same time is not supported yet because station orchestration (`StationManager` workers, caller flow, and runtime control paths) is process-local/in-memory.

If you need horizontal scaling, it requires a dedicated distributed ownership/control layer before enabling multi-instance runtime safely.
