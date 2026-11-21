const fs = require("node:fs");
const path = require("node:path");
const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
} = require("expo/config-plugins");

// P9: Android's share target. Text and photos shared to Zoltbot open the app, which saves them
// as a draft through the same ZoltShare bridge the iPhone uses (native/android/share).

const files = ["ZoltShareModule.kt", "ZoltSharePackage.kt"];
const packageLine = "add(ai.zoltbot.share.ZoltSharePackage())";
const filters = [
  { action: "android.intent.action.SEND", types: ["text/plain", "image/*"] },
  { action: "android.intent.action.SEND_MULTIPLE", types: ["image/*"] },
];

/** Adds the share intent filters to the main activity, once. */
function configureManifest(manifest) {
  const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
  activity["intent-filter"] = (activity["intent-filter"] ?? []).filter(
    (filter) =>
      !(filter.action ?? []).some((a) => filters.some((f) => f.action === a.$["android:name"])),
  );
  for (const { action, types } of filters)
    activity["intent-filter"].push({
      action: [{ $: { "android:name": action } }],
      category: [{ $: { "android:name": "android.intent.category.DEFAULT" } }],
      data: types.map((type) => ({ $: { "android:mimeType": type } })),
    });
  return manifest;
}

/** Registers the package beside the autolinked ones, once. */
function configureMainApplication(contents) {
  if (contents.includes(packageLine)) return contents;
  const anchor = /PackageList\(this\)\.packages\.apply \{\n/;
  if (!anchor.test(contents))
    throw new Error("with-android-share: MainApplication has no package list");
  return contents.replace(anchor, (found) => `${found}          ${packageLine}\n`);
}

/** Copies the Kotlin sources into the app module. */
function copySources(androidRoot) {
  const folder = path.join(androidRoot, "app/src/main/java/ai/zoltbot/share");
  fs.mkdirSync(folder, { recursive: true });
  for (const name of files)
    fs.copyFileSync(path.join(__dirname, "../native/android/share", name), path.join(folder, name));
}

function withAndroidShare(config) {
  config = withAndroidManifest(config, (mod) => {
    configureManifest(mod.modResults);
    return mod;
  });
  config = withMainApplication(config, (mod) => {
    mod.modResults.contents = configureMainApplication(mod.modResults.contents);
    return mod;
  });
  return withDangerousMod(config, [
    "android",
    (mod) => {
      copySources(mod.modRequest.platformProjectRoot);
      return mod;
    },
  ]);
}
module.exports = withAndroidShare;
module.exports.configureManifest = configureManifest;
module.exports.configureMainApplication = configureMainApplication;
module.exports.copySources = copySources;
