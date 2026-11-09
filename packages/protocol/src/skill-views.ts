/** Public read models: content is untrusted instructions, never execution authority. */
export interface SkillFileView {
  path: string;
  content: string;
  hash: string;
  bytes: number;
}
export interface SkillBundleView {
  name: string;
  description: string;
  body: string;
  files: SkillFileView[];
  hash: string;
  warnings: string[];
}
export interface SkillEntryView {
  id: string;
  name: string;
  current_revision: number;
  source: string | null;
  source_hash: string | null;
  removed: number;
}
export interface SkillRevisionView {
  skillId: string;
  revision: number;
  bundle: SkillBundleView;
  createdAt: string;
}
export interface DetectedSkillView {
  source: string;
  provider: string;
  name?: string;
  description?: string;
  hash?: string;
  error?: string;
}
export interface SkillSelectionView {
  skillId: string;
  revision: number;
  name: string;
  hash: string;
  installedPath?: string;
  reportedLoaded?: boolean;
}
export interface SkillSnapshotView {
  manifestId: string;
  profileId: string;
  scopeId: string;
  skills: SkillSelectionView[];
}
