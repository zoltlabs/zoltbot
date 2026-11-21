#!/usr/bin/env zsh
# Typechecks the app's native Swift without Xcode or a dev build: the app's modules, the share
# extension and the Live Activity widget. Needs Xcode's command line tools and an iOS SDK.
# Not covered: the Objective-C bridges and App Intents metadata (Siri phrase rules), which only
# an Xcode build checks.
set -euo pipefail
here=${0:A:h}/../native
work=$(mktemp -d)
trap 'rm -rf $work' EXIT

# React Native isn't built here; stand in for the two promise types the modules use.
print 'typealias RCTPromiseResolveBlock = (Any?) -> Void
typealias RCTPromiseRejectBlock = (String?, String?, Error?) -> Void' > $work/React.swift
host=()
for file in $here/{share,lock,activity,intents,icons}/*.swift; do
  [[ $file == */ShareViewController.swift || $file == */ZoltActivityWidget.swift ]] && continue
  sed '/^import React$/d' $file > $work/${file:t}
  host+=($work/${file:t})
done

check() {
  local name=$1; shift
  print -- "- $name"
  xcrun --sdk iphonesimulator swiftc -typecheck "$@"
}
check app -target arm64-apple-ios16.0-simulator $host $work/React.swift
check "share extension" -application-extension -target arm64-apple-ios16.0-simulator \
  $here/share/ShareStore.swift $here/share/ShareViewController.swift
check "Live Activity widget" -parse-as-library -application-extension -target arm64-apple-ios16.2-simulator \
  $here/activity/ZoltActivityWidget.swift $here/activity/ZoltActivityShared.swift
print "Native Swift typechecks."
