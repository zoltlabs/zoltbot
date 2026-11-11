const messages: Record<string, string> = {
  view_symlink_denied: "Remove symlinks from this view folder.",
  view_directory_denied: "Use a view folder owned by you, without symlinks in its path.",
  view_reserved_path: "The _host folder is reserved for Zoltbot. Remove it from this view.",
  artifact_type_denied: "The file contents do not match a supported image, font or text format.",
  artifact_svg_invalid: "Save a complete SVG document in this file.",
  artifact_binary_text_denied: "Use UTF-8 text without binary data.",
  view_type_denied: "This file type is not supported in views.",
  view_path_collision: "Rename these paths so they differ by more than letter case.",
  view_path_invalid: "Use a relative file path without reserved URL characters.",
  view_file_limit: "A view can contain at most 500 files.",
  view_walk_limit: "This view contains too many folders or files.",
  view_total_limit: "Reduce this view to 100 MB or less.",
  view_entry_missing: "The entry page declared in view.json is missing.",
  view_icon_missing: "The icon declared in view.json is missing.",
  view_file_changed: "A file changed while it was being checked. Reload the view.",
  artifact_file_changed: "A file changed while it was being checked. Reload the view.",
  artifact_file_denied: "Use a regular file owned by you, without hardlinks, no larger than 25 MB.",
  artifact_directory_denied: "Remove symlinks from this folder's path.",
  artifact_file_too_large: "Reduce this file to 25 MB or less.",
};
export function viewLoadMessage(reason: string) {
  const version = /^view_api_unsupported:(\d+)$/.exec(reason);
  if (version) return `This view needs View API ${version[1]}. Update Zoltbot to use it.`;
  if (messages[reason]) return messages[reason];
  if (reason.includes("manifest") || reason.includes("payload"))
    return "Check the fields in view.json against the view manifest schema.";
  if (/utf|encoding|binary/i.test(reason)) return "Save this text file as UTF-8.";
  if (/json|unexpected|position/i.test(reason)) return "Save valid JSON in this file.";
  return "This file did not pass the view file checks. Check its type and contents.";
}
export function importFailure(error: unknown) {
  const path =
    error && typeof error === "object" && "path" in error && typeof error.path === "string"
      ? error.path
      : "view.json";
  return `Could not import ${path}: ${viewLoadMessage(error instanceof Error ? error.message : "view_invalid")}`;
}
