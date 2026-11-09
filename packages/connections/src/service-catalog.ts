export * from "@zoltbot/cloud-contracts/catalog";
export function brokerOrigin() {
  const value = process.env.ZOLTBOT_BROKER_ORIGIN;
  if (!value) throw new Error("connection_broker_unavailable");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("connection_destination_denied");
  return url.origin;
}
