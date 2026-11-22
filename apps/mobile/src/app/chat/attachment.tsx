import { DELIMITED_PREVIEW_ROWS, type DelimitedPreview, type ZipListing } from "@zoltbot/protocol";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Image, ScrollView, View } from "react-native";
import { SvgXml } from "react-native-svg";
import {
  type AttachmentPreview,
  loadAttachmentPreview,
  previewProblem,
  type SavedPreview,
} from "../../data/attachment-preview";
import { openSaved, saveToCache } from "../../data/preview-file";
import { sanitizeSvg, svgRatio } from "../../data/svg-preview";
import { useClient, useLink } from "../../state/link";
import { mono, useTheme } from "../../theme";
import { DetailScreen } from "../../ui/DetailScreen";
import { Button, Txt } from "../../ui/kit";
import { Markdown } from "../../ui/Markdown";

/** Text past this stays unrendered; a phone can't lay out megabytes of text. */
const SHOWN_TEXT = 100_000;

function Table({ table }: { table: DelimitedPreview }) {
  const { c } = useTheme();
  const columns = Math.max(table.header.length, ...table.rows.map((row) => row.length));
  const cells = (row: string[]) => Array.from({ length: columns }, (_, i) => row[i] ?? "");
  const cell = { width: 140, paddingVertical: 8, paddingHorizontal: 10 };
  return (
    <View style={{ gap: 8 }}>
      <ScrollView horizontal style={{ borderWidth: 1, borderColor: c.border, borderRadius: 10 }}>
        <View>
          <View style={{ flexDirection: "row", backgroundColor: c["bg-popover"] }}>
            {cells(table.header).map((value, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are positions; they never move.
              <Txt key={`h${i}`} v="bodyMedium" style={cell} accessibilityRole="header">
                {value}
              </Txt>
            ))}
          </View>
          {table.rows.map((row, r) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id; the list never reorders.
              key={r}
              style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: c.border }}
              accessible
              accessibilityLabel={cells(row)
                .map((value, i) => `${table.header[i] ?? ""}: ${value}`)
                .join(", ")}
            >
              {cells(row).map((value, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positions; they never move.
                <Txt key={`c${i}`} style={cell} lines={4}>
                  {value}
                </Txt>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      {table.total > table.rows.length ? (
        <Txt tone="secondary">
          First {DELIMITED_PREVIEW_ROWS.toLocaleString()} of {table.total.toLocaleString()} rows
        </Txt>
      ) : null}
    </View>
  );
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** C18: what a ZIP holds, listed on the Mac from its index; nothing is unpacked. */
function ZipList({ listing }: { listing: ZipListing }) {
  const { c } = useTheme();
  const files = listing.files === 1 ? "1 file" : `${listing.files.toLocaleString()} files`;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 10 }}>
        {listing.entries.map((entry, i) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat in a ZIP; order never changes.
            key={i}
            accessible
            accessibilityLabel={`${entry.name}, ${size(entry.size)}`}
            style={{
              flexDirection: "row",
              gap: 12,
              paddingVertical: 8,
              paddingHorizontal: 10,
              borderTopWidth: i ? 1 : 0,
              borderTopColor: c.border,
            }}
          >
            <Txt style={{ flex: 1 }} lines={2}>
              {entry.name}
            </Txt>
            <Txt tone="secondary" style={{ fontVariant: ["tabular-nums"] }}>
              {size(entry.size)}
            </Txt>
          </View>
        ))}
      </View>
      <Txt tone="secondary">
        {listing.files > listing.entries.length
          ? `First ${listing.entries.length.toLocaleString()} of ${files}, ${size(listing.unpacked)} unpacked`
          : `${files}, ${size(listing.unpacked)} unpacked`}
      </Txt>
    </View>
  );
}

function Picture({ uri, name }: { uri: string; name: string }) {
  const [ratio, setRatio] = useState(1);
  return (
    <Image
      source={{ uri }}
      accessible
      accessibilityLabel={name}
      resizeMode="contain"
      style={{ width: "100%", aspectRatio: ratio }}
      onLoad={({ nativeEvent: { source } }) => {
        if (source.width && source.height) setRatio(source.width / source.height);
      }}
    />
  );
}

function Drawing({ xml, name }: { xml: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const clean = sanitizeSvg(xml);
  if (failed) return <Txt>Can't show this drawing. Open it on your Mac.</Txt>;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={name}
      style={{ width: "100%", aspectRatio: svgRatio(clean) }}
    >
      <SvgXml xml={clean} width="100%" height="100%" onError={() => setFailed(true)} />
    </View>
  );
}

/** A PDF or video saved on the phone, opened in Quick Look or the app Android picks. */
function Saved({ preview }: { preview: SavedPreview }) {
  const [cannot, setCannot] = useState(false);
  const open = () =>
    openSaved(preview.uri, preview.name, preview.mime).then(
      (opened) => setCannot(!opened),
      () => setCannot(true),
    );
  // The owner tapped this file to see it, so open it once it's here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: opens once per file.
  useEffect(() => {
    void open();
  }, [preview.uri]);
  return (
    <View style={{ gap: 12, alignItems: "flex-start" }}>
      <Txt tone="secondary">{size(preview.size)}</Txt>
      {cannot ? <Txt>Nothing on this phone can open this file.</Txt> : null}
      <Button label={preview.kind === "video" ? "Play" : "Open"} onPress={() => void open()} />
    </View>
  );
}

/** C16: a file or picture the owner sent, read from the Mac. */
export default function AttachmentScreen() {
  const params = useLocalSearchParams<{ id: string; item: string; part: string; name?: string }>();
  const online = useClient((s) => s.status === "online");
  const [preview, setPreview] = useState<AttachmentPreview>();
  const [problem, setProblem] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [share, setShare] = useState<number>();
  useEffect(() => {
    void attempt;
    let live = true;
    setPreview(undefined);
    setProblem("");
    setShare(undefined);
    const client = useLink.getState().client;
    if (!online || !client) return;
    loadAttachmentPreview(
      (method, p) => client.getState().call(method, p),
      {
        threadId: params.id,
        itemId: params.item,
        part: Number(params.part),
      },
      saveToCache,
      (value) => {
        if (live) setShare(value);
      },
    )
      .then((value) => {
        if (live) setPreview(value);
      })
      .catch((error) => {
        if (live) setProblem(previewProblem(error));
      });
    return () => {
      live = false;
    };
  }, [params.id, params.item, params.part, online, attempt]);
  return (
    <DetailScreen title={preview?.name ?? params.name ?? "File"}>
      <View accessibilityLiveRegion="polite" style={{ gap: 12 }}>
        {!online ? (
          <Txt>Reconnect to your Mac to load this file.</Txt>
        ) : problem ? (
          <>
            <Txt>{problem}</Txt>
            {problem.includes("Try again") ? (
              <Button label="Try again" onPress={() => setAttempt((n) => n + 1)} />
            ) : null}
          </>
        ) : !preview ? (
          <Txt tone="secondary">
            {share === undefined ? "Loading…" : `Loading… ${Math.floor(share * 100)}%`}
          </Txt>
        ) : preview.kind === "image" ? (
          <Picture uri={preview.uri} name={preview.name} />
        ) : preview.kind === "svg" ? (
          <Drawing xml={preview.xml} name={preview.name} />
        ) : preview.kind === "pdf" || preview.kind === "video" ? (
          <Saved preview={preview} />
        ) : preview.kind === "table" ? (
          <Table table={preview.table} />
        ) : preview.kind === "zip" ? (
          <ZipList listing={preview.listing} />
        ) : (
          <>
            {preview.kind === "markdown" ? (
              <Markdown value={preview.text.slice(0, SHOWN_TEXT)} />
            ) : (
              <Txt selectable style={{ fontFamily: mono }}>
                {preview.text.slice(0, SHOWN_TEXT)}
              </Txt>
            )}
            {preview.text.length > SHOWN_TEXT ? (
              <Txt tone="secondary">Only the start of this file is shown.</Txt>
            ) : null}
          </>
        )}
      </View>
    </DetailScreen>
  );
}
