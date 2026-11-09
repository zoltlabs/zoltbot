# Hosted services

Developer builds default to local operation. Account and sharing require an explicit
`ZOLTBOT_CLOUD_ORIGIN`. Broker integrations require an explicit HTTPS
`ZOLTBOT_BROKER_ORIGIN`; absence prevents catalog discovery and authorization requests.
Official signed builds are packaged with `ZOLTBOT_HOSTED_ORIGIN=https://zoltbot.ai`, which sets
both origins; the environment variables above still override it.
An outage or missing configuration does not disable local projects, custom MCP servers,
or user-controlled sandbox connections. Broker-dependent Google, GitHub and Slack
connections require a compatible configured broker and provider registration.
Phone connectivity requires a compatible relay. A relay address set in Settings > Devices
is always used. Otherwise a build may name a default with `ZOLTBOT_RELAY_URL` (official
builds: `wss://relay.zoltbot.ai`); the Mac connects to it only while a phone is paired,
waiting for approval, or about to scan a pairing code. To run your own relay, see
[services/relay](../services/relay/README.md). Explicitly selected third-party agent
and API traffic is independent of Zoltbot hosted account and broker configuration.

The native account controller supplies the account management URL; renderer input
cannot choose the account service origin. Existing external-navigation checks apply.
