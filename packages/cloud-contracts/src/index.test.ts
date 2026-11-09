import { expect, it } from "vitest";
import { parseCredentials, syntheticCredentials } from "./index.js";

it("accepts synthetic v1 credentials and rejects malformed tokens", () => {
  expect(parseCredentials(syntheticCredentials)).toEqual(syntheticCredentials);
  for (const value of [null, {}, { ...syntheticCredentials, accessToken: "bad" }])
    expect(() => parseCredentials(value)).toThrow("invalid_account_credentials");
});

it("retains additive v1 response compatibility without accepting invalid artifact identity", async () => {
  const { parse } = await import("@zoltbot/protocol");
  const { ArtifactReservationSchema, ArtifactViewSchema } = await import("./index.js");
  const reservation = {
    id: "11111111-1111-4111-8111-111111111111",
    state: "pending",
    uploaded: [],
    future: true,
  };
  expect(parse(ArtifactReservationSchema, reservation)).toEqual(reservation);
  expect(() => parse(ArtifactReservationSchema, { ...reservation, id: "../outside" })).toThrow();
  expect(() =>
    parse(ArtifactViewSchema, { title: "Example", visibility: "public", manifestHash: "bad" }),
  ).toThrow();
});
