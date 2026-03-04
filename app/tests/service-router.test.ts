import { describe, it, expect } from "vitest";
import { ServiceRouter } from "../src/service-router.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SINGLE = ["http://eval1:8001"];
const MULTI  = ["http://eval1:8001", "http://eval2:8001", "http://eval3:8001"];

function sessionIds(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `session-${i.toString().padStart(4, "0")}`);
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("ServiceRouter", () => {

    describe("construction", () => {
        it("throws when constructed with an empty instance list", () => {
            expect(() => new ServiceRouter([])).toThrow();
        });

        it("strips trailing slashes from instance URLs", () => {
            const router = new ServiceRouter(["http://eval1:8001/"]);
            expect(router.getUrl("s1")).toBe("http://eval1:8001");
        });

        it("reports the correct instance count", () => {
            expect(new ServiceRouter(MULTI).instanceCount).toBe(3);
        });
    });

    describe("session pinning", () => {
        it("returns the same URL for the same session ID on repeated calls", () => {
            const router = new ServiceRouter(MULTI);
            expect(router.getUrl("session-abc")).toBe(router.getUrl("session-abc"));
        });

        it("getWsUrl returns the same instance as getUrl for a session", () => {
            const router  = new ServiceRouter(MULTI);
            const httpUrl = router.getUrl("session-abc");
            const wsUrl   = router.getWsUrl("session-abc");
            expect(wsUrl.replace(/^wss?:\/\//, "")).toBe(httpUrl.replace(/^https?:\/\//, ""));
        });

        it("getWsUrl uses ws:// for http:// instances", () => {
            const router = new ServiceRouter(["http://eval1:8001"]);
            expect(router.getWsUrl("s1")).toMatch(/^ws:\/\//);
        });

        it("getWsUrl uses wss:// for https:// instances", () => {
            const router = new ServiceRouter(["https://eval1.example.com"]);
            expect(router.getWsUrl("s1")).toMatch(/^wss:\/\//);
        });

        it("a released session can be resolved again without error", () => {
            const router = new ServiceRouter(MULTI);
            router.getUrl("session-abc");
            router.releaseSession("session-abc");
            expect(() => router.getUrl("session-abc")).not.toThrow();
        });

        it("releasing a session that was never pinned does not throw", () => {
            const router = new ServiceRouter(MULTI);
            expect(() => router.releaseSession("never-seen")).not.toThrow();
        });
    });

    describe("single instance", () => {
        it("always returns the only configured URL regardless of session ID", () => {
            const router = new ServiceRouter(SINGLE);
            const urls   = sessionIds(20).map(id => router.getUrl(id));
            expect(new Set(urls).size).toBe(1);
            expect(urls[0]).toBe(SINGLE[0]);
        });
    });

    describe("distribution across instances", () => {
        it("uses every configured instance at least once across many sessions", () => {
            const router = new ServiceRouter(MULTI);
            const used   = new Set(sessionIds(100).map(id => router.getUrl(id)));
            for (const instance of MULTI) {
                expect(used).toContain(instance);
            }
        });

        it("distributes sessions roughly evenly across instances", () => {
            const router = new ServiceRouter(MULTI);
            const counts = new Map<string, number>(MULTI.map(u => [u, 0]));

            for (const id of sessionIds(300)) {
                const url = router.getUrl(id);
                counts.set(url, (counts.get(url) ?? 0) + 1);
            }

            // 300 sessions across 3 instances — expect ~100 each, ±40% tolerance.
            for (const count of Array.from(counts.values())) {
                expect(count).toBeGreaterThan(60);
                expect(count).toBeLessThan(140);
            }
        });

        it("different session IDs map to different instances", () => {
            const router = new ServiceRouter(MULTI);
            const urls   = new Set(sessionIds(50).map(id => router.getUrl(id)));
            expect(urls.size).toBeGreaterThan(1);
        });
    });
});
