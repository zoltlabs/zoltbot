// A7: free models as backup entries. Read from the model catalog, so only providers that have
// run on this Mac (and so are installed) are offered.

export interface CatalogModel {
  id: string;
  name: string;
  /** The provider marks the model free. */
  free?: boolean;
}
export interface CatalogEntry {
  definitionId: string;
  models: CatalogModel[];
}
export interface FreeModel {
  accountId: string;
  model: string;
  name: string;
}

/** Free when the provider says so, or when the id ends in `:free` or the name in `(free)`. */
export function isFreeModel(model: CatalogModel): boolean {
  if (model.free !== undefined) return model.free;
  return /[:/_-]free$/i.test(model.id) || /\(free\)$/i.test(model.name.trim());
}

/**
 * Every free model in the catalog, on its tool's own sign-in. Tools with no sign-in listed
 * (removed or experimental) are skipped.
 */
export function freeModels(
  catalog: CatalogEntry[],
  accounts: { id: string; definitionId: string; isDefault: boolean }[],
): FreeModel[] {
  const seen = new Set<string>();
  return catalog.flatMap((entry) => {
    const account = accounts.find(
      (row) => row.isDefault && row.definitionId === entry.definitionId,
    );
    if (!account) return [];
    // Tools sharing an adapter list the same models; offer each free model once.
    return entry.models
      .filter((model) => isFreeModel(model) && !seen.has(model.id) && Boolean(seen.add(model.id)))
      .map((model) => ({ accountId: account.id, model: model.id, name: model.name }));
  });
}
