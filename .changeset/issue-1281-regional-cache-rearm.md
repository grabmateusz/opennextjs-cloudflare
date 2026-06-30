---
"@opennextjs/cloudflare": patch
---

Fix unstable ISR cache caused by the regional cache re-arming stale entries.

With `shouldLazilyUpdateOnCacheHit` enabled (the default for the `long-lived`
mode), every regional cache hit re-read the store and unconditionally wrote the
result back to the Cache API. This reset the entry TTL while keeping its old
`lastModified`, pinning it as stale. With SWR `revalidateTag` (Next 16+) the
entry was then reported stale on every request, triggering an endless stream of
background revalidations (issue #1281). It could also overwrite a freshly
revalidated entry with a stale store read because of background write ordering.

The lazy update now only refreshes the regional cache when the store holds a
strictly newer entry, which stops the revalidation storm while preserving
cross-region stale-while-revalidate propagation.
