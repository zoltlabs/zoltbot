// Load the source runtime before measuring daemon initialization, without starting any service.
await import("@zoltbot/daemon");
process.stderr.write("ZOLTBOT_FAKE_READY\n");
await import("../../../packages/daemon/src/main.js");
