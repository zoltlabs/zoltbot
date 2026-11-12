import { Redirect, router } from "expo-router";
import { Command } from "../prototype/Command";

export default function ProjectCommandPrototype() {
  if (!__DEV__) return <Redirect href="/" />;
  return <Command onClose={() => router.back()} />;
}
