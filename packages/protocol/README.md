# Protocol

`methodCatalog` includes routing (`where`) and paired-phone access (`pairedPhone`).
They answer different questions: a phone paired with a Mac still needs Local methods
such as device listing. `macOnlyMethods` is derived from the catalog's phone metadata.
New methods default to Local until their cell implementation is added to the shared
or cloud-only list in `method-locations.ts`.

Cloud projects keep repository, branch and setup inputs in `project.cloud`; tasks
carry `location` as `mac` or `sandbox`. Existing Local requests may omit location.
The local daemon refuses sandbox task requests rather than running them locally.

`parseRequest` assigns command actor metadata from its trusted second argument. The
local default is the single local owner. The daemon supplies the paired device id;
a cell must supply the authenticated token's user, device and surface. Caller-supplied
actor claims never override that identity. The older domain actor (`kind`, `id`) is
retained for existing domain commands and event history.

## Signed Mac approval wire shape

`MacApprovalPayloadSchema` and `SignedMacApprovalSchema` define the shared device
approval envelope. The signing helpers live in `@zoltbot/link`; the protocol adds
no cryptography or runtime authority. Mac execution must verify the signature,
current registered key, request binding, expiry and durable replay claim before
spawning. Wire parsing alone does not grant permission.
