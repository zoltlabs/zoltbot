#!/usr/bin/env -S node --import tsx
import { runFake } from "./scenario.js";

await runFake("acp");
