import { type RefObject, useEffect, useRef } from "react";
import {
  COMPOSER_FILE_BYTES,
  COMPOSER_IMAGE_BYTES,
  composerImageMime,
  readComposerImage,
} from "./composer-attachments.js";
import type { ComposerAttachment as Attachment, ComposerDraft } from "./composer-draft.js";

export function useComposerAttachments({
  current,
  saving,
  images,
  locked,
  setError,
  setAttachments,
}: {
  current: RefObject<ComposerDraft>;
  saving: boolean;
  images: boolean;
  locked: RefObject<boolean>;
  setError(error: string): void;
  setAttachments(next: Attachment[] | ((previous: Attachment[]) => Attachment[])): void;
}) {
  const previews = useRef(new Set<string>());
  const retryFiles = useRef(new Map<string, File>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const url of previews.current) URL.revokeObjectURL(url);
    };
  }, []);
  const remove = (path: string) => {
    retryFiles.current.delete(path);
    setAttachments((previous) =>
      previous.filter((file) => {
        if (file.path !== path) return true;
        if (file.preview) {
          URL.revokeObjectURL(file.preview);
          previews.current.delete(file.preview);
        }
        return false;
      }),
    );
  };
  const prepareImage = async (path: string, file: File) => {
    setAttachments((previous) =>
      previous.map((item) =>
        item.path === path ? { ...item, status: "preparing", error: undefined } : item,
      ),
    );
    try {
      const base64 = await readComposerImage(file);
      if (alive.current)
        setAttachments((previous) =>
          previous.map((item) =>
            item.path === path ? { ...item, base64, status: "ready" } : item,
          ),
        );
    } catch (error) {
      if (alive.current)
        setAttachments((previous) =>
          previous.map((item) =>
            item.path === path
              ? {
                  ...item,
                  status: "error",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Image preparation failed. Retry or attach it again.",
                }
              : item,
          ),
        );
    }
  };
  const attach = (files: FileList | null, replacePath?: string) => {
    if (!files || saving || locked.current) return;
    setError("");
    let imageBytes = current.current.attachments
      .filter((file) => file.image && file.path !== replacePath)
      .reduce((sum, file) => sum + file.bytes, 0);
    for (const file of files) {
      const mime = composerImageMime(file);
      const image = mime.startsWith("image/");
      if (image && !images) {
        setError("Images are not available for this connection.");
        continue;
      }
      if (file.size > COMPOSER_FILE_BYTES) {
        setError("Choose files smaller than 10 MB.");
        continue;
      }
      if (image && !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)) {
        setError("Choose a PNG, JPEG, GIF or WebP image.");
        continue;
      }
      let path = "";
      try {
        path = window.zoltDesktop?.filePath?.(file) ?? "";
      } catch {}
      if (!path && !image) {
        setError("Open the desktop app to attach a local file. Images can also be pasted here.");
        continue;
      }
      if (
        path &&
        current.current.attachments.some((item) => item.path === path && item.path !== replacePath)
      )
        continue;
      if (image && imageBytes + file.size > COMPOSER_IMAGE_BYTES) {
        setError("Choose images totaling 512 KB or less.");
        continue;
      }
      if (image) imageBytes += file.size;
      const needsRead = image && !path;
      path ||= `image:${crypto.randomUUID()}`;
      const preview = image ? URL.createObjectURL(file) : undefined;
      if (preview) previews.current.add(preview);
      if (replacePath) {
        remove(replacePath);
        replacePath = undefined;
      }
      setAttachments((previous) => [
        ...previous,
        {
          path,
          name: file.name || "Pasted image",
          image,
          mime,
          bytes: file.size,
          status: needsRead ? "preparing" : "ready",
          ...(preview ? { preview } : {}),
        },
      ]);
      if (needsRead) {
        retryFiles.current.set(path, file);
        void prepareImage(path, file);
      }
    }
  };
  const clear = () => {
    retryFiles.current.clear();
    for (const url of previews.current) URL.revokeObjectURL(url);
    previews.current.clear();
  };
  const canRetry = (path: string) => retryFiles.current.has(path);
  const retry = (path: string) => {
    const file = retryFiles.current.get(path);
    if (file) void prepareImage(path, file);
    return !!file;
  };
  return { attach, remove, clear, canRetry, retry };
}
