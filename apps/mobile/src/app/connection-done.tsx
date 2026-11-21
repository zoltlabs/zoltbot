// P10: where an app sign-in returns. The sign-in session reads the link itself; on Android the
// link also opens this route, which just steps back to where the sign-in started.
import { router } from "expo-router";
import { useEffect } from "react";

export default function ConnectionDone() {
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/connections");
  }, []);
  return null;
}
