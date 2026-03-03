import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ── Hoisted mock handles so factories can reference them ──────────────────────
const { mockGetRoleCredentials, mockSpawnChild } = vi.hoisted(() => {
    const mockGetRoleCredentials = vi.fn()

    // A minimal EventEmitter-like child-process stub
    const makeChild = (exitCode = 0) => {
        const listeners = {}
        const child = {
            stdout: { on: vi.fn() },
            stderr: { on: vi.fn() },
            stdin: { write: vi.fn(), end: vi.fn() },
            on: (event, cb) => {
                listeners[event] = cb
            },
            emit: (event, ...args) => listeners[event]?.(...args),
        }
        // Resolve the promise automatically on the next tick
        setTimeout(() => child.emit("close", exitCode), 0)
        return child
    }

    const mockSpawnChild = vi.fn(() => makeChild(0))

    return { mockGetRoleCredentials, mockSpawnChild }
})

vi.mock("fs", () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    writeFileSync: vi.fn(),
}))

vi.mock("ini", () => ({
    default: {
        parse: vi.fn(),
        stringify: vi.fn(() => "[myprofile]\n"),
    },
}))

vi.mock("@aws-sdk/client-sso", () => ({
    SSO: vi.fn().mockImplementation(() => ({
        getRoleCredentials: mockGetRoleCredentials,
    })),
}))

vi.mock("child_process", () => ({
    spawn: mockSpawnChild,
}))

import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs"
import ini from "ini"
import { SSO } from "@aws-sdk/client-sso"
import main from "../lib/index.js"

// ── Shared fixtures ───────────────────────────────────────────────────────────

const PROFILE = "myprofile"
const PROFILE_CONFIG = {
    sso_region: "us-east-1",
    sso_account_id: "123456789012",
    sso_role_name: "MyRole",
}
const ROLE_CREDENTIALS = {
    accessKeyId: "ASIA_KEY",
    secretAccessKey: "SECRET",
    sessionToken: "SESSION",
    expiration: Date.now() + 3_600_000,
}

// Returns an ISO timestamp that is `ms` milliseconds in the future
const future = (ms = 3_600_000) => new Date(Date.now() + ms).toISOString()

/**
 * Wire up the standard happy-path mocks:
 *   – config file exists and parses to a valid SSO profile
 *   – credentials file exists but is initially empty
 *   – SSO cache has a valid access token
 *   – AWS SSO API returns role credentials
 */
function setupHappyPath({ configOverride, credsOverride } = {}) {
    existsSync.mockReturnValue(true)

    readFileSync.mockImplementation((filePath) => {
        const p = filePath.toString()
        if (p.endsWith("/config")) return "__config__"
        if (p.endsWith("/credentials")) return "__creds__"
        // SSO cache file
        return JSON.stringify({ accessToken: "sso-token", expiresAt: future() })
    })

    ini.parse.mockImplementation((content) => {
        if (content === "__config__")
            return {
                [`profile ${PROFILE}`]: configOverride ?? { ...PROFILE_CONFIG },
            }
        if (content === "__creds__") return credsOverride ?? {}
        return {}
    })

    readdirSync.mockReturnValue(["sso.json"])
    mockGetRoleCredentials.mockResolvedValue({
        roleCredentials: ROLE_CREDENTIALS,
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("main()", () => {
    let exitSpy

    beforeEach(() => {
        vi.clearAllMocks()
        exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
            throw new Error("process.exit called")
        })
    })

    afterEach(() => {
        exitSpy.mockRestore()
    })

    // ── Error paths ───────────────────────────────────────────────────────────

    it("exits with code 1 when the AWS config file does not exist", async () => {
        existsSync.mockReturnValue(false)
        await expect(main(PROFILE, {})).rejects.toThrow("process.exit called")
        expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it("exits with code 1 when the requested profile is absent from config", async () => {
        existsSync.mockReturnValue(true)
        readFileSync.mockReturnValue("__config__")
        ini.parse.mockReturnValue({ "profile other": PROFILE_CONFIG })
        await expect(main(PROFILE, {})).rejects.toThrow("process.exit called")
        expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it("exits with code 1 when the profile lacks required SSO fields", async () => {
        existsSync.mockReturnValue(true)
        readFileSync.mockReturnValue("__config__")
        // Missing sso_role_name
        ini.parse.mockReturnValue({
            [`profile ${PROFILE}`]: {
                sso_region: "us-east-1",
                sso_account_id: "123",
            },
        })
        await expect(main(PROFILE, {})).rejects.toThrow("process.exit called")
        expect(exitSpy).toHaveBeenCalledWith(1)
    })

    // ── Happy path ────────────────────────────────────────────────────────────

    it("fetches role credentials from SSO and writes them to the credentials file", async () => {
        setupHappyPath()

        await main(PROFILE, {})

        expect(mockGetRoleCredentials).toHaveBeenCalledWith({
            accessToken: "sso-token",
            accountId: PROFILE_CONFIG.sso_account_id,
            roleName: PROFILE_CONFIG.sso_role_name,
        })

        expect(writeFileSync).toHaveBeenCalledOnce()
        expect(ini.stringify).toHaveBeenCalledWith(
            expect.objectContaining({
                [PROFILE]: expect.objectContaining({
                    aws_access_key_id: ROLE_CREDENTIALS.accessKeyId,
                    aws_secret_access_key: ROLE_CREDENTIALS.secretAccessKey,
                    aws_session_token: ROLE_CREDENTIALS.sessionToken,
                }),
            })
        )
    })

    it("instantiates the SSO client with the profile's sso_region", async () => {
        setupHappyPath()

        await main(PROFILE, {})

        expect(SSO).toHaveBeenCalledWith({ region: PROFILE_CONFIG.sso_region })
    })

    it("also writes credentials under customProfile when provided", async () => {
        setupHappyPath()

        await main(PROFILE, { customProfile: "ci" })

        expect(ini.stringify).toHaveBeenCalledWith(
            expect.objectContaining({
                ci: expect.objectContaining({
                    aws_access_key_id: ROLE_CREDENTIALS.accessKeyId,
                }),
            })
        )
    })

    // ── Cached credentials path ───────────────────────────────────────────────

    it("copies existing non-expired creds to customProfile without calling SSO API", async () => {
        const cachedExpiry = Date.now() + 3_600_000
        setupHappyPath({
            credsOverride: {
                [PROFILE]: {
                    aws_access_key_id: "CACHED_KEY",
                    expiration: cachedExpiry,
                },
            },
        })

        await main(PROFILE, { customProfile: "ci" })

        expect(mockGetRoleCredentials).not.toHaveBeenCalled()
        // Cached creds should be copied to customProfile
        expect(writeFileSync).toHaveBeenCalledOnce()
    })

    it("re-fetches credentials from SSO when cached creds are expired", async () => {
        const expiredExpiry = Date.now() - 1_000
        setupHappyPath({
            credsOverride: {
                [PROFILE]: {
                    aws_access_key_id: "OLD_KEY",
                    expiration: expiredExpiry,
                },
            },
        })

        await main(PROFILE, {})

        expect(mockGetRoleCredentials).toHaveBeenCalledOnce()
    })

    // ── SSO login trigger ─────────────────────────────────────────────────────

    it("triggers 'aws sso login' when no valid access token exists in cache", async () => {
        setupHappyPath()
        // First getAccessToken call returns null (no valid cache)
        // After login, second call should find the token
        readdirSync
            .mockReturnValueOnce([]) // empty cache before login
            .mockReturnValue(["sso.json"]) // populated after login

        await main(PROFILE, {})

        expect(mockSpawnChild).toHaveBeenCalledWith("aws", [
            "sso",
            "login",
            "--profile",
            PROFILE,
        ])
    })
})
