import { describe, expect, it } from "vitest";
import { parseTotpSetup, totpIssuer, vaultHost, vaultSiteMatches } from "./vault.js";

describe("vault sites", () => {
  it("reads the host from what the owner typed", () => {
    expect(vaultHost("https://GitHub.com/login?next=1")).toBe("github.com");
    expect(vaultHost("github.com")).toBe("github.com");
    expect(vaultHost("  accounts.example.com.  ")).toBe("accounts.example.com");
    expect(vaultHost("localhost:3000")).toBe("localhost");
    for (const bad of ["", "github", "not a site", "ftp://example.com", "https://a:b@example.com"])
      expect(vaultHost(bad)).toBeUndefined();
  });

  it("matches the listed host and its subdomains only", () => {
    expect(vaultSiteMatches("github.com", "github.com")).toBe(true);
    expect(vaultSiteMatches("github.com", "gist.github.com")).toBe(false);
    expect(vaultSiteMatches("github.com", "www.github.com")).toBe(true);
    expect(vaultSiteMatches("www.github.com", "github.com")).toBe(true);
    expect(vaultSiteMatches("github.com", "evilgithub.com")).toBe(false);
    expect(vaultSiteMatches("github.com", "github.com.example.net")).toBe(false);
  });
});

describe("two-step setup keys", () => {
  it("reads a spaced setup key and an otpauth link", () => {
    expect(parseTotpSetup("jbsw y3dp ehpk 3pxp")).toEqual({
      secret: "JBSWY3DPEHPK3PXP",
      digits: 6,
      period: 30,
      algorithm: "SHA1",
    });
    const link =
      "otpauth://totp/Example:octo-sample?secret=JBSWY3DPEHPK3PXP&issuer=Example&digits=8&period=60&algorithm=SHA256";
    expect(parseTotpSetup(link)).toEqual({
      secret: "JBSWY3DPEHPK3PXP",
      digits: 8,
      period: 60,
      algorithm: "SHA256",
    });
    expect(totpIssuer(link)).toBe("Example");
  });

  it("refuses what isn't a setup key", () => {
    for (const bad of [
      "123456",
      "JBSW",
      "otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP",
      "hello world!",
    ])
      expect(parseTotpSetup(bad)).toBeUndefined();
  });
});
