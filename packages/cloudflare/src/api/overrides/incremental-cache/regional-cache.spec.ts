import type { CacheValue, IncrementalCache, WithLastModified } from "@opennextjs/aws/types/overrides.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { getCloudflareContext } from "../../cloudflare-context.js";
import { withRegionalCache } from "./regional-cache.js";

vi.mock("@opennextjs/aws/adapters/logger.js", () => ({
	error: vi.fn(),
}));

vi.mock("../../cloudflare-context.js", () => ({
	getCloudflareContext: vi.fn(),
}));

vi.mock("../internal.js", () => ({
	debugCache: vi.fn(),
	FALLBACK_BUILD_ID: "fallback-build-id",
	isPurgeCacheEnabled: () => false,
}));

// A stale-but-valid (SWR) cache entry: it was generated at `STALE_LAST_MODIFIED`
// and carries a 30 minute `revalidate`.
const STALE_LAST_MODIFIED = 1_000;
const REVALIDATE_SECONDS = 1800;

function makeStoreEntry(): { value: CacheValue<"cache">; lastModified: number } {
	return {
		value: {
			type: "page",
			html: "<p>stale</p>",
			json: {},
			revalidate: REVALIDATE_SECONDS,
			tags: ["tag-1"],
		} as unknown as CacheValue<"cache">,
		lastModified: STALE_LAST_MODIFIED,
	};
}

describe("RegionalCache - shouldLazilyUpdateOnCacheHit & SWR", () => {
	let store: {
		name: string;
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
		delete: ReturnType<typeof vi.fn>;
	};
	let cachePut: ReturnType<typeof vi.fn>;
	let cacheMatch: ReturnType<typeof vi.fn>;
	let waitUntilPromises: Promise<unknown>[];

	beforeEach(() => {
		// Pretend we are running on Next 16 (SWR-by-default branch in the constructor).
		(globalThis as Record<string, unknown>).nextVersion = "16.2.6";

		store = {
			name: "mock-store",
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
		};

		cachePut = vi.fn().mockResolvedValue(undefined);
		cacheMatch = vi.fn();

		// @ts-expect-error - partial Cache mock
		globalThis.caches = {
			open: vi.fn().mockResolvedValue({
				put: cachePut,
				match: cacheMatch,
				delete: vi.fn(),
			}),
		};

		// Collect the background work scheduled via `waitUntil` so the test can await it.
		waitUntilPromises = [];
		vi.mocked(getCloudflareContext).mockReturnValue({
			ctx: {
				waitUntil: (p: Promise<unknown>) => {
					waitUntilPromises.push(p);
				},
			},
		} as unknown as ReturnType<typeof getCloudflareContext>);
	});

	afterEach(() => {
		vi.resetAllMocks();
		delete (globalThis as Record<string, unknown>).nextVersion;
	});

	/**
	 * Helper: simulate a regional cache HIT by having `cache.match` resolve to a
	 * Response holding `cachedEntry`, then run `get` and flush background work.
	 * The lazy update (if enabled) re-reads the store and gets `storeEntry`
	 * (defaults to the same stale entry that is already cached).
	 */
	async function getOnRegionalHit(
		cache: IncrementalCache,
		storeEntry: { value: CacheValue<"cache">; lastModified: number } = makeStoreEntry()
	) {
		const cached = makeStoreEntry();
		cacheMatch.mockResolvedValueOnce(
			new Response(JSON.stringify({ value: cached.value, lastModified: cached.lastModified }))
		);
		store.get.mockResolvedValueOnce(storeEntry);

		const result = (await cache.get("/page", "cache")) as WithLastModified<CacheValue<"cache">>;
		await Promise.all(waitUntilPromises);
		return result;
	}

	// ---------------------------------------------------------------------------
	// FIX (#1281): a HIT whose store entry is NOT newer must not re-arm the cache.
	// Re-arming kept the old `lastModified` with a fresh TTL, pinning the entry as
	// stale and triggering an endless stream of background revalidations.
	// ---------------------------------------------------------------------------
	test("with shouldLazilyUpdateOnCacheHit=true, a HIT with a non-newer store entry does NOT re-arm", async () => {
		const cache = withRegionalCache(store as unknown as IncrementalCache, {
			mode: "long-lived",
			shouldLazilyUpdateOnCacheHit: true,
		});

		const result = await getOnRegionalHit(cache);

		// The cached value is still served...
		expect(result.lastModified).toBe(STALE_LAST_MODIFIED);

		// ...the store is re-read in the background to check for a newer entry...
		expect(store.get).toHaveBeenCalledTimes(1);
		expect(store.get).toHaveBeenCalledWith("/page", "cache");

		// ...but because the store entry is not newer, the regional cache is NOT
		// re-armed. The entry ages out naturally via its existing Cache API max-age.
		expect(cachePut).not.toHaveBeenCalled();
	});

	// ---------------------------------------------------------------------------
	// SWR preserved: a HIT whose store entry IS newer refreshes the regional cache
	// so a revalidation done in another region propagates here.
	// ---------------------------------------------------------------------------
	test("with shouldLazilyUpdateOnCacheHit=true, a HIT with a newer store entry refreshes the regional cache", async () => {
		const cache = withRegionalCache(store as unknown as IncrementalCache, {
			mode: "long-lived",
			shouldLazilyUpdateOnCacheHit: true,
		});

		const fresh = makeStoreEntry();
		fresh.lastModified = STALE_LAST_MODIFIED + 5_000;

		await getOnRegionalHit(cache, fresh);

		expect(store.get).toHaveBeenCalledTimes(1);
		expect(cachePut).toHaveBeenCalledTimes(1);

		const [, putResponse] = cachePut.mock.calls[0] as [unknown, Response];

		// The re-armed entry carries the NEW lastModified, so it is no longer stale.
		const body = (await putResponse.json()) as { lastModified: number };
		expect(body.lastModified).toBe(fresh.lastModified);
	});

	// ---------------------------------------------------------------------------
	// With lazy update disabled, a HIT performs no background re-pull/re-arm.
	// NOTE: this is NOT a fix for #1281 — it breaks cross-region SWR propagation
	// because a region never refreshes its Cache API from the store.
	// ---------------------------------------------------------------------------
	test("with shouldLazilyUpdateOnCacheHit=false, a HIT does not re-pull or re-arm", async () => {
		const cache = withRegionalCache(store as unknown as IncrementalCache, {
			mode: "long-lived",
			shouldLazilyUpdateOnCacheHit: false,
		});

		const result = await getOnRegionalHit(cache);

		// The cached value is still served...
		expect(result.lastModified).toBe(STALE_LAST_MODIFIED);

		// ...but there is no background store re-read and no regional re-arm.
		expect(store.get).not.toHaveBeenCalled();
		expect(cachePut).not.toHaveBeenCalled();
	});

	// ---------------------------------------------------------------------------
	// GUARD: on Next 16 the option defaults to `true`, so the lazy re-read still
	// happens when omitted, but a non-newer store entry does not re-arm.
	// ---------------------------------------------------------------------------
	test("GUARD: omitting the option on Next 16 still re-reads the store but does not re-arm a non-newer entry", async () => {
		const cache = withRegionalCache(store as unknown as IncrementalCache, {
			mode: "long-lived",
		});

		await getOnRegionalHit(cache);

		expect(store.get).toHaveBeenCalledTimes(1);
		expect(cachePut).not.toHaveBeenCalled();
	});
});
