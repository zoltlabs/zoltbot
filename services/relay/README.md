# Zoltbot relay

The phone relay. A Mac running `zoltd` and its paired phones each open one WebSocket to the relay. The relay checks who is on each socket, forwards `data` frames between a Mac and the devices it allowed, and sends pushes with no content. Every payload is encrypted end to end, so the relay cannot read it. It implements layer 1 of [`packages/link/src/frames.ts`](../../packages/link/src/frames.ts).

## How it works

* `GET /health` (and `/healthz`) answers `ok`. On Cloud Run use `/health`: Google's front end answers paths ending in `z` itself. WebSockets connect on `/v1/mac` and `/v1/device`.
* The relay sends `challenge` first. The client answers with `hello`, signed with its Ed25519 key. The relay checks it with `verifyHello`, derives the id with `linkId` and answers `ready`, or `error` and closes.
* A device must name its Mac. It gets in when the Mac allowed it, or while its `offerId` names a live offer from that Mac. A pending device and its Mac can exchange `data` only until the offer ends, then the device is closed with `offer_expired`. The Mac sends `allow` once the person confirms.
* `revoke` closes the device's socket at once, marks it revoked and drops its push token.
* `presence` goes to a device when its Mac connects or drops, and to a Mac when an allowed device does.
* Every frame is checked against the TypeBox schemas. Frames over `maxFrameBytes`, malformed frames and frames over the per connection rate limit get an `error` frame. Twenty of those close the connection.
* Routing state lives in memory and is rebuilt as clients reconnect. Cloud Run closes sockets at 60 minutes, and a reconnect costs nothing else. A second connection with the same key replaces the first.
* Logs are JSON lines with ids, event names and error codes. Frame bodies and push tokens are never logged.

### Close codes

| Code | Meaning |
| --- | --- |
| 4400 | Bad frame during sign in, or too many rejected frames |
| 4401 | Bad signature |
| 4403 | Not allowed: never allowed, revoked, or the offer is not live |
| 4408 | No `hello` in time, or the pairing offer ended |
| 4409 | The same key signed in on another connection |
| 4429 | The client reads too slowly |

### Registry

Firestore, through its REST API, with this layout. There is no message storage.

* `macs/{macId}/devices/{deviceId}`: `publicKey`, `status` (`allowed` or `revoked`), `pushToken`, `platform` (`apns` or `apns-sandbox`), `updatedAt`.
* `offers/{offerId}`: `macId`, `expiresAt`. A TTL policy deletes old offers.

Tests use `MemoryRegistry`.

### Push

`push` from a Mac sends an APNs alert with fixed text: "Zoltbot needs you" (with the count when it is more than 1) or "A task finished". The badge is the count. A token APNs rejects as gone is dropped. The client uses HTTP/2 and a token based `.p8` key.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Set by Cloud Run. |
| `RELAY_REGISTRY` | `firestore` | `memory` keeps records in memory, for local runs only. |
| `FIRESTORE_PROJECT` | from `GOOGLE_CLOUD_PROJECT`, then the metadata server | Project that holds the Firestore database. |
| `FIRESTORE_DATABASE` | `(default)` | Firestore database id. |
| `FIRESTORE_EMULATOR_HOST` | unset | `host:port` of the Firestore emulator. Skips auth. |
| `APNS_KEY` | unset | The `.p8` key in PEM form. On Cloud Run this comes from Secret Manager. |
| `APNS_KEY_FILE` | unset | Path to the `.p8` key, used when `APNS_KEY` is unset. |
| `APNS_KEY_ID` | unset | The key's id from the Apple developer site. |
| `APNS_TEAM_ID` | unset | The Apple team id. |
| `APNS_TOPIC` | unset | The app's bundle id. |
| `RELAY_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

Without all four APNs values the relay runs with pushes turned off and logs `push_disabled`.

## Run locally

The build bundles everything into one file. It swaps the native `sodium-native` addon for the pure JavaScript `sodium-javascript`, so the image needs no `node_modules`.

```bash
pnpm --filter @zoltbot/relay build
RELAY_REGISTRY=memory PORT=8080 node services/relay/dist/main.mjs
```

The tests run with the rest of the repo: `pnpm test`.

## Self-hosting

The desktop app and the iPhone app work with any relay that implements this protocol. Run this one somewhere both your Mac and phone can reach over TLS, then enter its `wss://` address in Settings > Devices on the Mac. Phones learn the address from the pairing code.

* `RELAY_REGISTRY=memory` needs no database, but forgets which phones are allowed when it restarts, so you would pair again. Use Firestore for anything long-lived.
* Push notifications need an APNs key for the app's bundle id. The official iPhone app's key is not public, so a self-hosted relay carries messages to it but cannot notify it. Build the app under your own bundle id and key if you want pushes.

## Deploy to Cloud Run

Run these from the repository root. Choose your own project, region and APNs values:

```bash
PROJECT=your-project
REGION=us-east1
FIRESTORE_DATABASE=zoltbot-relay
APNS_KEY_ID=ABC123DEFG
APNS_TEAM_ID=TEAM123456
APNS_TOPIC=com.example.zoltbot
SA=zoltbot-relay@$PROJECT.iam.gserviceaccount.com
```

Enable the services:

```bash
gcloud services enable run.googleapis.com firestore.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project=$PROJECT
```

Create the Firestore database and the TTL policy that deletes old offers:

```bash
gcloud firestore databases create --project=$PROJECT --database=$FIRESTORE_DATABASE --location=$REGION --type=firestore-native
gcloud firestore fields ttls update expiresAt --project=$PROJECT --collection-group=offers --enable-ttl --database=$FIRESTORE_DATABASE
```

Create the service account and give it access to the relay's database only, which matters when the project holds other apps' data:

```bash
gcloud iam service-accounts create zoltbot-relay --project=$PROJECT --display-name="Zoltbot relay"
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=roles/datastore.user --condition="expression=resource.name == \"projects/$PROJECT/databases/$FIRESTORE_DATABASE\",title=zoltbot-relay-database-only,description=Only the relay Firestore database"
```

Store the APNs key in Secret Manager and let the relay read it:

```bash
gcloud secrets create apns-key --project=$PROJECT --replication-policy=automatic --data-file=AuthKey_$APNS_KEY_ID.p8
gcloud secrets add-iam-policy-binding apns-key --project=$PROJECT --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
```

Build the bundle and deploy:

```bash
pnpm install
pnpm --filter @zoltbot/relay build
gcloud run deploy zoltbot-relay --project=$PROJECT --source services/relay --region=$REGION --service-account=$SA --allow-unauthenticated --timeout=3600 --max-instances=1 --min-instances=0 --concurrency=1000 --cpu=1 --memory=512Mi --set-env-vars=FIRESTORE_PROJECT=$PROJECT,FIRESTORE_DATABASE=$FIRESTORE_DATABASE,APNS_KEY_ID=$APNS_KEY_ID,APNS_TEAM_ID=$APNS_TEAM_ID,APNS_TOPIC=$APNS_TOPIC --set-secrets=APNS_KEY=apns-key:latest
```

The service URL from the deploy, with `wss://` in place of `https://`, is the relay address. Map your own domain to it if you want a stable name.

Notes on the flags:

* `--timeout=3600` is the longest Cloud Run allows. Clients reconnect when it closes the socket.
* `--max-instances=1` matters. Routing state is in memory, so a Mac and its phones must reach the same instance. One instance handles many sockets. Running more than one needs a shared routing layer, which this version does not have.
* `--allow-unauthenticated` is needed because phones and Macs sign in with their own keys, not with Google identities.
* `FIRESTORE_DATABASE` must be set: without it the relay uses `(default)`, which the IAM condition does not allow.
* Set `--min-instances=1` if cold starts hurt.
