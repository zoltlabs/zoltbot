import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
export function workerEnvironmentFixture() {
  const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://accounts.example.invalid",
    aud: "cell",
    sub: "member",
    org: "org",
    device: randomUUID(),
    surface: "runner",
    kind: "sandbox_runner",
    task: "task",
    iat: now,
    exp: now + 600,
    jti: randomUUID(),
  };
  const token = (patch: Record<string, unknown> = {}) => {
    const data = [
      Buffer.from(JSON.stringify({ alg: "ES256", kid: "fixture" })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...claims, ...patch })).toString("base64url"),
    ].join(".");
    return `${data}.${sign("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  const key = () => randomBytes(32).toString("base64url");
  const env = {
    ZOLTBOT_ORG_ID: "org",
    ZOLTBOT_TASK_ID: "task",
    ZOLTBOT_MEMBER_ID: "member",
    ZOLTBOT_RUNNER_ID: claims.device,
    ZOLTBOT_PROVIDER: "claude",
    ZOLTBOT_CELL_URL: "https://cell.example.invalid",
    ZOLTBOT_CLOUD_ORIGIN: "https://accounts.example.invalid",
    ZOLTBOT_SLEEP_KEEPS_PROCESSES: "false",
    ZOLTBOT_RUNNER_TOKEN: token(),
    ZOLTBOT_WORKER_REFRESH: key(),
    ZOLTBOT_PRIVATE_CONTEXT_KEY: key(),
    GITHUB_TOKEN: key(),
    ANTHROPIC_API_KEY: key(),
  };
  return { env, token, claims };
}
