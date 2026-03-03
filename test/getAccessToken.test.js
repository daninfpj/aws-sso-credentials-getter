import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("fs", () => ({
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
}))

import { readdirSync, readFileSync } from "fs"
import { getAccessToken } from "../lib/index.js"

const futureDate = () => new Date(Date.now() + 3_600_000).toISOString()
const pastDate = () => new Date(Date.now() - 1_000).toISOString()

const tokenFile = (overrides = {}) =>
    JSON.stringify({
        accessToken: "valid-token",
        expiresAt: futureDate(),
        ...overrides,
    })

describe("getAccessToken", () => {
    beforeEach(() => vi.resetAllMocks())

    it("returns null when the SSO cache directory is unreadable", () => {
        readdirSync.mockImplementation(() => {
            throw new Error("ENOENT: no such file or directory")
        })
        expect(getAccessToken()).toBeNull()
    })

    it("returns null when every cache file holds an expired token", () => {
        readdirSync.mockReturnValue(["expired.json"])
        readFileSync.mockReturnValue(
            tokenFile({ accessToken: "old", expiresAt: pastDate() })
        )
        expect(getAccessToken()).toBeNull()
    })

    it("returns the valid access token from a non-expired cache file", () => {
        readdirSync.mockReturnValue(["sso.json"])
        readFileSync.mockReturnValue(tokenFile({ accessToken: "my-token" }))
        expect(getAccessToken()).toBe("my-token")
    })

    it("skips files that lack an accessToken field", () => {
        readdirSync.mockReturnValue(["botocore.json", "sso.json"])
        readFileSync
            .mockReturnValueOnce(
                JSON.stringify({ expiresAt: futureDate() }) // no accessToken
            )
            .mockReturnValueOnce(tokenFile({ accessToken: "real-token" }))
        expect(getAccessToken()).toBe("real-token")
    })

    it("skips files with an empty string accessToken", () => {
        readdirSync.mockReturnValue(["empty.json", "sso.json"])
        readFileSync
            .mockReturnValueOnce(tokenFile({ accessToken: "" }))
            .mockReturnValueOnce(tokenFile({ accessToken: "good-token" }))
        expect(getAccessToken()).toBe("good-token")
    })

    it("returns the first valid token and stops scanning remaining files", () => {
        readdirSync.mockReturnValue(["first.json", "second.json"])
        readFileSync
            .mockReturnValueOnce(tokenFile({ accessToken: "first-token" }))
            .mockReturnValueOnce(tokenFile({ accessToken: "second-token" }))
        expect(getAccessToken()).toBe("first-token")
        expect(readFileSync).toHaveBeenCalledTimes(1)
    })

    it("returns null when a cache file contains malformed JSON", () => {
        readdirSync.mockReturnValue(["bad.json"])
        readFileSync.mockReturnValue("{ invalid json }")
        expect(getAccessToken()).toBeNull()
    })

    it("normalises the legacy 'UTC' suffix in expiresAt before comparison", () => {
        const expiresAt = futureDate().replace("Z", "UTC")
        readdirSync.mockReturnValue(["sso.json"])
        readFileSync.mockReturnValue(
            tokenFile({ accessToken: "utc-token", expiresAt })
        )
        expect(getAccessToken()).toBe("utc-token")
    })
})
