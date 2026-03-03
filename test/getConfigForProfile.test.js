import { describe, it, expect, vi } from "vitest"
import { getConfigForProfile } from "../lib/index.js"

// Pure logic — no fs or AWS calls, no mocking needed.

const validProfile = {
    sso_region: "us-east-1",
    sso_account_id: "123456789012",
    sso_role_name: "MyRole",
}

describe("getConfigForProfile", () => {
    it("returns undefined when config is undefined (no config file)", () => {
        expect(getConfigForProfile(undefined, "myprofile")).toBeUndefined()
    })

    it("returns undefined when the named profile is absent from config", () => {
        const config = { "profile other": validProfile }
        expect(getConfigForProfile(config, "missing")).toBeUndefined()
    })

    it("returns profile data for a standard 'profile <name>' key", () => {
        const config = { "profile dev": validProfile }
        expect(getConfigForProfile(config, "dev")).toEqual(validProfile)
    })

    it("falls back to bare 'default' key when profile arg is 'default'", () => {
        const config = { default: validProfile }
        expect(getConfigForProfile(config, "default")).toEqual(validProfile)
    })

    it("returns undefined when 'default' profile does not exist under either key", () => {
        const config = { "profile something": validProfile }
        expect(getConfigForProfile(config, "default")).toBeUndefined()
    })

    it("returns undefined when sso_account_id is missing", () => {
        const { sso_account_id: _, ...rest } = validProfile
        const config = { "profile dev": rest }
        expect(getConfigForProfile(config, "dev")).toBeUndefined()
    })

    it("returns undefined when sso_role_name is missing", () => {
        const { sso_role_name: _, ...rest } = validProfile
        const config = { "profile dev": rest }
        expect(getConfigForProfile(config, "dev")).toBeUndefined()
    })

    it("returns undefined when sso_region is absent and no sso_session to resolve it", () => {
        const config = {
            "profile dev": {
                sso_account_id: "123456789012",
                sso_role_name: "MyRole",
            },
        }
        expect(getConfigForProfile(config, "dev")).toBeUndefined()
    })

    it("resolves sso_region from linked sso-session block", () => {
        const config = {
            "profile dev": {
                sso_account_id: "123456789012",
                sso_role_name: "MyRole",
                sso_session: "corp",
            },
            "sso-session corp": { sso_region: "ap-southeast-1" },
        }
        const result = getConfigForProfile(config, "dev")
        expect(result).not.toBeUndefined()
        expect(result.sso_region).toBe("ap-southeast-1")
    })

    it("prefers explicit sso_region over sso-session when both present", () => {
        const config = {
            "profile dev": {
                sso_region: "us-west-2",
                sso_account_id: "123456789012",
                sso_role_name: "MyRole",
                sso_session: "corp",
            },
            "sso-session corp": { sso_region: "ap-southeast-1" },
        }
        const result = getConfigForProfile(config, "dev")
        expect(result.sso_region).toBe("us-west-2")
    })
})
